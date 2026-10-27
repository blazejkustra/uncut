// The agent (D40, D41, D48, D139): one turn at a time for the open project, in one long-lived
// `claude -p --input-format stream-json` per open project chat (a session): each message is a
// stream-json user line, each turn ends at its `result`, Stop is an interrupt control request
// (SIGINT/SIGKILL if it isn't honoured). Claude has no built-in tools and one MCP server (mcp.ts)
// that forwards tool calls to this server's /agent routes (agentBridge.ts) under a token that
// lives as long as the session; a call is only taken while a turn runs, and goes to that turn. Agent edits go
// through Projects like the user's (same validation, saving and undo stack, live in the editor),
// attributed to the agent and tagged with the turn, so a turn can be undone (D7). Before each
// turn the agent is told what the user changed by hand since it last looked (D6).
//
// Turns are kept in <project>/history.db (D71, history.ts), with Claude Code's session id so the
// next turn (also after reopening) continues the same conversation, and the pending D6 note. Not in
// .cache/: wiping the cache must not lose the history. An agent/turns.json from before (D51) is
// moved in on first open and renamed agent/turns.migrated-<time>.json; one that can't be read is
// left alone and turns are refused until it can be.
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";

import {
  AgentError,
  type AgentFocus,
  type AgentInfo,
  type AgentAccess,
  type AgentEffort,
  type AgentProvider,
  type AgentImage,
  type AgentMention,
  type AgentState,
  type AgentPlan,
  type AgentAnswer,
  type StoryboardBeat,
  type Storyboard,
  type Brief,
  type IntendedFinding,
  type EditRefused,
  type ProjectError,
  type ProjectSnapshot,
} from "@uncut/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpServer } from "effect/http";

import { Analysis } from "../analysis/analysis.ts";
import { readPlan, writeBrief, writeIntended, writeStoryboard } from "../brand/store.ts";
import { restoreGraphics } from "./agentCleanup.ts";
import { mcpTools, type McpTool } from "./agentTools.ts";
import { ServerConfig } from "../app/config.ts";
import { Exporter } from "../export/exporter.ts";
import { ProjectFormat } from "../project/format.ts";
import { MediaLibrary } from "../media/media.ts";
import { MediaCore } from "../media/mediaCore.ts";
import { MediaIndex } from "../media/mediaIndex.ts";
import { Plugins } from "../plugins/plugins.ts";
import { Capture } from "../capture/capture.ts";
import { uploadedTake } from "../capture/takes.ts";
import { Generator } from "../generate/generate.ts";
import { Keys } from "../generate/keys.ts";
import { Library } from "../library/library.ts";
import { isTestRun } from "../generate/providers.ts";
import { Projects } from "../project/projects.ts";
import { withHistory } from "../project/history.ts";
import { AGENT_COLOURS, type StoredAgent, storedAgents } from "../project/history/agents.ts";
import { FOCUS_NAMES } from "./agentTeam.ts";
import { agentEnv } from "../app/shellEnv.ts";
import { type ClaudeSession, type Running } from "./session/types.ts";
import { APPROVAL_MS, canonical } from "./session/config.ts";
import { undoState } from "./turns/notes.ts";
import { cleanStaleTurns } from "./session/stale.ts";
import type { AgentVars } from "./session/state.ts";
import type { AgentServices } from "./session/context.ts";
import { makeCore } from "./session/core.ts";
import { makeMediaTools } from "./tools/media.ts";
import { makeMeasureTools } from "./tools/measure.ts";
import { makeTranscriptTools } from "./tools/transcript.ts";
import { makeAskTools } from "./tools/ask.ts";
import { makeGenerateTools } from "./tools/generate.ts";
import { makeCardTools } from "./tools/cards.ts";
import { makeBrandTools } from "./tools/brand.ts";
import { makeLibraryTools } from "./tools/library.ts";
import { makeRunTool } from "./tools/run.ts";
import { makeStream } from "./session/stream.ts";
import { makeSpawn } from "./session/spawn.ts";
import { makeCodex } from "./session/codex.ts";
import { makeSend } from "./session/send.ts";
export { PROVIDER } from "./session/config.ts";
export { findClaude, sessionArgs, sessionEnv } from "./session/config.ts";
export { readHistory, loadAgentHistory } from "./turns/history.ts";
export { noteFor, joinNotes, mediaHeardOnMain, speechOfItem } from "./turns/notes.ts";
export { TURN_DIR_PREFIX, cleanStaleTurns } from "./session/stale.ts";

/** An MCP tools/call result. */
/**
 * A call the model made by an Uncut tool's bare name (graphic_write) failed in Claude Code with "No
 * such tool available" before reaching Uncut (T3: a new film file never written, the agent carrying
 * on as if it were). That message can't be changed, so the next Uncut result says what happened and
 * the full name to call.
 */
export function withBareNote<T extends McpResult>(r: { bareCalls?: Array<string> }, result: T): T {
  const bare = [...new Set(r.bareCalls ?? [])];
  if (!bare.length) return result;
  r.bareCalls = [];
  const text = `Note: your call${bare.length === 1 ? "" : "s"} to ${bare.join(", ")} by the short name failed ("No such tool available") and did nothing. Uncut's tools are called by their full name: ${bare.map((x) => `mcp__uncut__${x}`).join(", ")}. Make ${bare.length === 1 ? "that call" : "those calls"} again with the full name if you still need ${bare.length === 1 ? "it" : "them"}.`;
  return { ...result, content: [...result.content, { type: "text", text }] };
}

export interface McpResult {
  readonly content: ReadonlyArray<
    { readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  >;
  readonly isError?: boolean;
}

export interface AgentShape {
  /** The open project's agent now (null: nothing open), then every change. */
  readonly changes: Stream.Stream<AgentState | null>;
  readonly send: (input: {
    prompt: string;
    frame?: number | undefined;
    selected?: string | undefined;
    mentions?: ReadonlyArray<AgentMention> | undefined;
    provider?: AgentProvider | undefined;
    model?: string | undefined;
    effort?: AgentEffort | undefined;
    access?: AgentAccess | undefined;
    images?: ReadonlyArray<AgentImage> | undefined;
    ranges?: Running["ranges"] | undefined;
    agentId?: string | undefined;
  }) => Effect.Effect<{ turnId: string }, AgentError>;
  /** Stops the agent's running turn (absent: the first agent). */
  readonly cancel: (agentId?: string) => Effect.Effect<void>;
  /** The user's answer to the running turn's approval card (D99). */
  readonly approve: (id: string, allow: boolean, source?: string, extra?: CardAnswer) => Effect.Effect<{ readonly accepted: boolean }>;
  /** D188: the user's own edit of the brief or the storyboard. */
  readonly planSave: (input: {
    readonly brief?: Brief | undefined;
    readonly storyboard?: Storyboard | undefined;
    readonly intended?: ReadonlyArray<IntendedFinding> | undefined;
  }) => Effect.Effect<AgentPlan, AgentError>;
  /** D144: the renderer's answer to an allowed screen_record (the uploaded take, or what went wrong). */
  readonly screenTake: (answer: {
    readonly id: string;
    readonly path?: string | undefined;
    readonly source?: string | undefined;
    readonly problem?: string | undefined;
  }) => Effect.Effect<void>;
  readonly undoTurn: (turnId: string) => Effect.Effect<ProjectSnapshot, AgentError | EditRefused | ProjectError>;
  /** Redo turn: an undone turn's edits back, recorded as its own revision; the agent's next note says so. */
  readonly redoTurn: (turnId: string) => Effect.Effect<ProjectSnapshot, AgentError | EditRefused | ProjectError>;
  /** D206: puts back the graphics a turn's clean-up moved to the trash. */
  readonly restoreCleanup: (turnId: string) => Effect.Effect<{ readonly restored: ReadonlyArray<string> }, AgentError>;
  /** D295: a new chat: the next message starts a fresh Claude conversation (earlier turns stay in the history). */
  readonly newThread: (agentId?: string) => Effect.Effect<{ readonly threadStart: string }, AgentError>;
  /** C12: another agent in the open project, with its focus preset. */
  readonly create: (input: { readonly name?: string | undefined; readonly focus: AgentFocus }) => Effect.Effect<AgentInfo, AgentError>;
  /** C12: an agent out of the tab row (its turns stay in the history). */
  readonly archive: (agentId: string) => Effect.Effect<void, AgentError>;
  /** For the bridge: the tool list, or undefined when `token` isn't the live session's. */
  readonly tools: (token: string | null) => Effect.Effect<ReadonlyArray<McpTool> | undefined>;
  /** For the bridge: whether `token` is the running turn's (no rescan, unlike tools). */
  readonly authorized: (token: string | null) => Effect.Effect<boolean>;
  /** For the bridge: run a tool call of the running turn, or undefined when `token` isn't its. */
  readonly call: (token: string | null, name: unknown, args: unknown) => Effect.Effect<McpResult | undefined>;
}

export class Agent extends Context.Service<Agent, AgentShape>()("uncut/Agent") {}

/** What a question or storyboard card answers besides Allow / Don't (D187, D188). */
export interface CardAnswer {
  readonly answer?: AgentAnswer | undefined;
  readonly beats?: ReadonlyArray<StoryboardBeat> | undefined;
  readonly note?: string | undefined;
  // D194: a permission card's "Always for this session".
  readonly always?: boolean | undefined;
}

// ---- environment (D41) ----

// The agent's environment (D41): shellEnv.ts's agentEnv, kept importable from here.
export { agentEnv };

// ---- the service ----

/** A turn by its prompt, quoted and cut at 80 characters, for the history's labels and the agent's note. */
/** C12: a name no other agent of the project has ("Graphics", else "Graphics 2", ...). */
const freeName = (name: string, taken: ReadonlyArray<string>) => {
  let n = 1;
  let candidate = name;
  while (taken.includes(candidate)) candidate = `${name} ${++n}`;
  return candidate;
};

/** C12: the project's saved agent list changed by `change` (archived agents kept). */
const saveAgentList = (dir: string, change: (saved: Array<StoredAgent>) => Array<StoredAgent>) =>
  Effect.try({
    try: () => withHistory(dir, (db) => db.saveAgentList(JSON.stringify(change(storedAgents(db.agentList()))))),
    catch: (error) => new AgentError({ reason: "failed", message: `Couldn't save the project's agents: ${(error as Error).message}` }),
  });

const turnName = (prompt: string) => `"${prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt}"`;

export const layer = Layer.effect(
  Agent,
  Effect.gen(function* () {
    const projects = yield* Projects;
    const format = yield* ProjectFormat;
    const exporter = yield* Exporter;
    const media = yield* MediaLibrary;
    const mediaCore = yield* MediaCore;
    const analysis = yield* Analysis;
    const config = yield* ServerConfig;
    const plugins = yield* Plugins;
    const generator = yield* Generator;
    const keys = yield* Keys;
    const capture = yield* Capture;
    const sounds = yield* Library;
    const mediaIndex = yield* MediaIndex;
    const { address } = yield* HttpServer.HttpServer;
    const port = "port" in address ? address.port : config.port;
    // The MCP server dials back to this server: loopback, unless a headless server listens on one address only (D106).
    const bridgeHost = config.host === "0.0.0.0" || config.host === "::" || config.host === "" ? "127.0.0.1" : config.host;
    const bridgeUrl = `http://${bridgeHost.includes(":") ? `[${bridgeHost}]` : bridgeHost}:${port}`;

    const stateRef = yield* SubscriptionRef.make<AgentState | null>(null);
    const loadLock = yield* Semaphore.make(1);
    const st: AgentVars = { agents: [], closing: [], starting: new Set() };
    // Every claude still running, the live one and any closing (graceful or killed, not yet gone).
    const sessions = new Set<ClaudeSession>();
    // UNCUT_APPROVAL_MS shortens the approval wait in test runs only (as D99's base URLs).
    const testRun = isTestRun(process.env, config.keysFd);
    const approvalMs = () => (testRun && Number(process.env.UNCUT_APPROVAL_MS) > 0 ? Number(process.env.UNCUT_APPROVAL_MS) : APPROVAL_MS);
    // D144: allowed screen_record calls waiting for the renderer's take, by card id.
    const screenWaits = new Map<
      string,
      { readonly turnId: string; readonly done: (answer: { path?: string | undefined; source?: string | undefined; problem?: string | undefined }) => void }
    >();

    const view = () => Effect.runSync(projects.view);

    const services: AgentServices = {
      projects,
      format,
      exporter,
      media,
      mediaCore,
      analysis,
      config,
      plugins,
      generator,
      keys,
      capture,
      sounds,
      mediaIndex,
      bridgeUrl,
      stateRef,
      loadLock,
      st,
      sessions,
      testRun,
      approvalMs,
      screenWaits,
      view,
    };
    const core = { ...services, ...makeCore(services) };
    const { ensureLoaded, agentOf, addLoaded, trackPending, publish, killRunning, persist, stop, sessionFor, runningFor, closeSession, infoOf } = core;

    // Follow the open project: another opening loads its history, every change refreshes the
    // undo states, a close stops the running turn.
    yield* Effect.forkScoped(
      Stream.runForEach(projects.changes, () =>
        Effect.andThen(
          ensureLoaded,
          Effect.sync(() => {
            trackPending();
            publish();
          }),
        ),
      ),
    );
    process.on("exit", killRunning);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.off("exit", killRunning);
        killRunning();
      }),
    );
    // A server that was SIGKILLed left its turn's folder (and maybe claude) behind: clean up
    // folders whose server is gone, stopping a claude still running from one of them.
    yield* Effect.sync(cleanStaleTurns);

    // ---- tools, then running claude: each factory gets what the ones before it made ----

    const withMedia = { ...core, ...makeMediaTools(core), ...makeMeasureTools(core) };
    const withTranscript = { ...withMedia, ...makeTranscriptTools(withMedia) };
    const withAsk = { ...withTranscript, ...makeAskTools(withTranscript) };
    const withGenerate = { ...withAsk, ...makeGenerateTools(withAsk) };
    const withCards = { ...withGenerate, ...makeCardTools(withGenerate) };
    const withBrand = { ...withCards, ...makeBrandTools(withCards) };
    const withLibrary = { ...withBrand, ...makeLibraryTools(withBrand) };
    const withRun = { ...withLibrary, ...makeRunTool(withLibrary) };
    const withStream = { ...withRun, ...makeStream(withRun) };
    // Issue #106: claude (makeSpawn) or Codex (makeCodex) runs a session.
    const withSpawn = { ...withStream, ...makeSpawn(withStream), ...makeCodex(withStream) };
    const { send } = makeSend(withSpawn);
    const { allowed, runTool, publishNow } = withSpawn;

    /** The agent that ran a turn of the open project, and the turn. */
    const turnOf = (turnId: string) =>
      Effect.gen(function* () {
        const agents = yield* ensureLoaded;
        if (!agents) return yield* new AgentError({ reason: "no-project", message: "Open a project first." });
        for (const owner of agents) {
          const turn = owner.turns.find((t) => t.id === turnId);
          if (turn) return { owner, turn };
        }
        return yield* new AgentError({ reason: "unknown-turn", message: "That turn isn't in this project's history." });
      });

    return Agent.of({
      changes: SubscriptionRef.changes(stateRef),
      send,
      cancel: (agentId) =>
        Effect.sync(() => {
          const owner = agentId === undefined ? st.agents[0] : st.agents.find((a) => a.agentId === agentId);
          if (owner?.running) stop(owner.running);
        }),
      approve: (id, allow, source, extra) =>
        Effect.sync(() => {
          const approval = st.agents.find((a) => a.approval?.card.id === id)?.approval;
          if (!approval) return { accepted: false };
          approval.answer(allow ? "allow" : "deny", source, extra);
          return { accepted: true };
        }),
      planSave: ({ brief, storyboard, intended }) =>
        Effect.gen(function* () {
          const owner = yield* agentOf(undefined);
          const saved = yield* Effect.tryPromise({
            try: async () => {
              if (brief) await writeBrief(owner.dir, { ...brief, by: "user" });
              if (storyboard) await writeStoryboard(owner.dir, storyboard.status === "approved" ? { ...storyboard, approvedBy: "user" } : storyboard);
              // D217: the findings the user marked Intended on a review card (the whole list).
              if (intended) await writeIntended(owner.dir, intended);
              return readPlan(owner.dir);
            },
            catch: (error) => new AgentError({ reason: "failed", message: `Couldn't save the plan: ${(error as Error).message}` }),
          });
          owner.plan = saved;
          publish();
          return saved;
        }),
      screenTake: ({ id, path, source, problem }) =>
        Effect.sync(() => {
          const wait = screenWaits.get(id);
          if (wait) return wait.done({ ...(path ? { path } : {}), ...(source ? { source } : {}), ...(problem ? { problem: problem.slice(0, 400) } : {}) });
          // Nobody waits for it any more (the turn stopped, the project changed): the upload goes,
          // if it's really a take in the open project's media/uploads.
          const v = view();
          if (path && v) {
            const mediaPaths = v.session.project.media.map((m) => m.path);
            void uploadedTake(path, v.dir, mediaPaths)
              .then((found) => ("file" in found ? rm(found.file, { force: true }) : undefined))
              .catch(() => {});
          }
        }),
      undoTurn: (turnId) =>
        Effect.gen(function* () {
          const { owner, turn } = yield* turnOf(turnId);
          // C12: other agents may go on working (their next edit based before the undo is refused, and they read again).
          if (owner.running || st.starting.has(owner))
            return yield* new AgentError({ reason: "busy", message: `Wait for ${owner.name} to finish, or stop it, before undoing its turn.` });
          // Partly beyond what history.db keeps (or not in the history at all): say why, change nothing.
          const state = undoState(turn, view(), owner.openId, format.validate);
          if (state.state === "unavailable") return yield* new AgentError({ reason: "failed", message: `This turn can't be undone. ${state.reason}` });
          const label = `Undid your turn ${turnName(turn.prompt)}`;
          const snapshot = yield* projects.undoTurn(owner.openId, turnId, label);
          turn.undoneAt = new Date().toISOString();
          // D206: the graphics its clean-up put in the trash come back too.
          if (turn.cleanup?.graphics.length && !turn.cleanup.restored) {
            yield* Effect.promise(() => restoreGraphics(owner.dir, turnId, turn.cleanup!.graphics).catch(() => []));
            turn.cleanup = { ...turn.cleanup, restored: true };
          }
          persist(owner);
          publish();
          return snapshot;
        }),
      redoTurn: (turnId) =>
        Effect.gen(function* () {
          const { owner, turn } = yield* turnOf(turnId);
          if (owner.running || st.starting.has(owner))
            return yield* new AgentError({ reason: "busy", message: `Wait for ${owner.name} to finish, or stop it, before redoing its turn.` });
          if (!turn.undoneAt) return yield* new AgentError({ reason: "unknown-turn", message: "That turn wasn't undone." });
          const snapshot = yield* projects.redoTurn(owner.openId, turnId, `Redid your turn ${turnName(turn.prompt)} (its edits are back)`);
          delete turn.undoneAt;
          turn.redoneAt = new Date().toISOString();
          turn.edits.splice(0, turn.edits.length, ...turn.edits.map((e) => ({ ...e, revision: snapshot.revision })));
          persist(owner);
          publish();
          return snapshot;
        }),
      // D206: the turn's Restore: its trashed graphics back in graphics/.
      restoreCleanup: (turnId) =>
        Effect.gen(function* () {
          const { owner, turn } = yield* turnOf(turnId);
          if (!turn.cleanup) return yield* new AgentError({ reason: "unknown-turn", message: "That turn moved nothing to the trash." });
          const restored = yield* Effect.promise(() => restoreGraphics(owner.dir, turnId, turn.cleanup!.graphics).catch(() => [] as Array<string>));
          turn.cleanup = { ...turn.cleanup, restored: true };
          persist(owner);
          publish();
          return { restored };
        }),
      // D295: New chat. The live claude ends (gracefully: it's idle), the stored conversation is
      // forgotten, so the next message spawns one without --resume and gets the brand and plan
      // blocks whole (a new session has sent none). The note of edits by hand stays for it. What
      // D194 keeps "for this chat" (Always answers, added folders, web use) starts over too.
      newThread: (agentId) =>
        Effect.gen(function* () {
          const owner = yield* agentOf(agentId);
          if (owner.running || st.starting.has(owner))
            return yield* new AgentError({ reason: "busy", message: `Wait for ${owner.name} to finish, or stop it, before starting a new chat.` });
          if (owner.session) closeSession(owner.session, "graceful");
          owner.sessionId = undefined;
          owner.context = undefined;
          owner.threadStart = new Date().toISOString();
          owner.grants.clear();
          owner.dirs.length = 0;
          owner.mentioned.length = 0;
          owner.webUsed = false;
          owner.tainted.clear();
          persist(owner);
          publish();
          return { threadStart: owner.threadStart };
        }),
      create: ({ name, focus }) =>
        Effect.gen(function* () {
          const agents = yield* ensureLoaded;
          const v = view();
          if (!agents || !v || v.openId !== agents[0]?.openId) return yield* new AgentError({ reason: "no-project", message: "Open a project first." });
          if (agents.length >= AGENT_COLOURS.length)
            return yield* new AgentError({ reason: "failed", message: `A project has at most ${AGENT_COLOURS.length} agents. Close one first.` });
          const used = new Set(agents.map((a) => a.colour));
          const info: StoredAgent = {
            id: `ag-${randomBytes(3).toString("hex")}`,
            name: freeName(
              name?.trim().slice(0, 40) || FOCUS_NAMES[focus],
              agents.map((a) => a.name),
            ),
            focus,
            colour: AGENT_COLOURS.find((c) => !used.has(c)) ?? AGENT_COLOURS[0],
            createdAt: new Date().toISOString(),
          };
          yield* saveAgentList(v.dir, (saved) => [...saved, info]);
          const added = addLoaded(v, info);
          publish();
          return infoOf(added);
        }),
      archive: (agentId) =>
        Effect.gen(function* () {
          const owner = yield* agentOf(agentId);
          if (st.agents.length <= 1) return yield* new AgentError({ reason: "failed", message: "A project keeps at least one agent." });
          if (owner.running || st.starting.has(owner)) return yield* new AgentError({ reason: "busy", message: `Stop ${owner.name} before closing it.` });
          yield* saveAgentList(owner.dir, (saved) => saved.map((a) => (a.id === owner.agentId ? { ...a, archivedAt: new Date().toISOString() } : a)));
          if (owner.session) closeSession(owner.session, "graceful");
          st.agents = st.agents.filter((a) => a !== owner);
          publish();
        }),
      // The built-in tools, then the plugins' (D97; the folders are scanned again for each list).
      // Any time the session lives: claude lists its tools when it starts.
      tools: (token) =>
        Effect.suspend(() => {
          const s = sessionFor(token);
          if (!s) return Effect.succeed(undefined);
          return Effect.andThen(
            plugins.refresh,
            Effect.map(plugins.tools, (extra) => {
              const list = [...mcpTools(), ...extra];
              // D261: the tool list claude got, for the context meter's system + tools estimate.
              s.toolsChars = JSON.stringify(list).length;
              return list;
            }),
          );
        }),
      authorized: (token) => Effect.sync(() => runningFor(token) !== undefined),
      // A call goes to the running turn of the agent whose session the token is: none while idle,
      // none while a stopped turn's result is still pending (r.cancelled). The next turn is written
      // only after this one's result (send refuses while one runs, writeTurn checks), so a call can
      // only reach the turn running when it arrives (gen). Announcements are a soft log: a call not
      // announced still runs.
      call: (token, name, args) =>
        Effect.suspend(() => {
          const r = runningFor(token);
          if (!r) return Effect.succeed(undefined);
          const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
          const key = canonical(input);
          const slot = r.announced.find((x) => !x.used && x.name === String(name).replace(/^mcp__uncut__/, "") && x.args === key);
          if (slot) slot.used = true;
          else if (process.env.UNCUT_AGENT_DEBUG) console.error(`[uncut] agent call ${String(name)} wasn't announced in turn ${r.gen}'s stream (run anyway)`);
          return allowed(r, String(name).replace(/^mcp__uncut__/, ""), input).pipe(
            Effect.flatMap((refusal) => (refusal ? Effect.succeed(refusal) : runTool(r, String(name), input))),
            Effect.map((result) => withBareNote(r, result)),
            Effect.tap(() => Effect.sync(publishNow)),
          );
        }),
    });
  }),
);
