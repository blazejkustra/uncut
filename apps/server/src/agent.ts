// The agent (D40, D41, D48): one turn at a time for the open project. A turn runs `claude -p`
// with no built-in tools and one MCP server (mcp.ts) that forwards tool calls to this server's
// /agent routes (agentBridge.ts) under a token that lives as long as the turn. Agent edits go
// through Projects like the user's (same validation, saving and undo stack, live in the editor),
// attributed to the agent and tagged with the turn, so a turn can be undone (D7). Before each
// turn the agent is told what the user changed by hand since it last looked (D6).
//
// Turns are kept in <project>/agent/turns.json, with Claude Code's session id so the next turn
// (also after reopening) continues the same conversation. Not in .cache/: wiping the cache must
// not lose the history. history.db (D12) replaces this file when it lands.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentError, type AgentEdit, type AgentItem, type AgentState, type AgentTurn, type EditRefused, type ProjectError, type ProjectSnapshot } from "@uncut/contracts";
import { describeOp, manualEditsNote, TurnDependency, undoTurn, type Op, type Project, type Session } from "@uncut/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpServer } from "effect/http";

import { FRAME_WIDTH, MAX_FRAMES, mcpTools, modulesList, projectSummary, stepLabel, SYSTEM_PROMPT, type McpTool } from "./agentTools.ts";
import { writeFileAtomic } from "./atomicWrite.ts";
import { ServerConfig } from "./config.ts";
import { Exporter } from "./exporter.ts";
import { ProjectFormat } from "./format.ts";
import { Projects, type ProjectView } from "./projects.ts";
import { which } from "./setup.ts";

export const PROVIDER = "Claude Code";
const HISTORY_FORMAT = "uncut.agent-history/0";
const KILL_AFTER_MS = 1500;

/** An MCP tools/call result. */
export interface McpResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string }>;
  readonly isError?: boolean;
}

export interface AgentShape {
  /** The open project's agent now (null: nothing open), then every change. */
  readonly changes: Stream.Stream<AgentState | null>;
  readonly send: (input: { prompt: string; frame?: number | undefined; selected?: string | undefined }) => Effect.Effect<{ turnId: string }, AgentError>;
  readonly cancel: Effect.Effect<void>;
  readonly undoTurn: (turnId: string) => Effect.Effect<ProjectSnapshot, AgentError | EditRefused | ProjectError>;
  /** For the bridge: the tool list, or undefined when `token` isn't the running turn's. */
  readonly tools: (token: string | null) => Effect.Effect<ReadonlyArray<McpTool> | undefined>;
  /** For the bridge: run a tool call of the running turn, or undefined when `token` isn't its. */
  readonly call: (token: string | null, name: unknown, args: unknown) => Effect.Effect<McpResult | undefined>;
}

export class Agent extends Context.Service<Agent, AgentShape>()("uncut/Agent") {}

// ---- environment (D41) ----

/**
 * The agent's environment: the server's, minus anything that would bill an API account instead
 * of the user's Claude subscription (a stray ANTHROPIC_API_KEY did, once: "Credit balance is too
 * low") or make claude think it runs inside another Claude Code session.
 */
export const agentEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN" || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    out[k] = v;
  }
  return out;
};

/** The claude binary: UNCUT_CLAUDE (tests, or a custom install), else the first on PATH. */
export const findClaude = async (env: NodeJS.ProcessEnv = process.env) => env.UNCUT_CLAUDE || (await which("claude", env.PATH ?? ""));

// ---- history ----

type StoredTurn = { -readonly [K in keyof Omit<AgentTurn, "undo">]: Omit<AgentTurn, "undo">[K] } & {
  items: Array<{ kind: "text" | "step"; text: string; tool?: string; status?: "running" | "done" | "error" }>;
  edits: Array<AgentEdit>;
};

interface Loaded {
  readonly dir: string;
  // The opening of the project this belongs to. The same folder opened again keeps its Loaded
  // (one turns array, one owner of turns.json) with the new opening's id.
  openId: number;
  sessionId: string | undefined;
  readonly turns: Array<StoredTurn>;
  // The newest revision the agent has seen (its last project_read, or the note it got).
  agentSeen: number;
  // Revisions the agent read in this opening: the only ones it may base an edit on. Revisions
  // restart when the server does, so a number remembered from an earlier opening could name
  // another state; this refuses it whatever it is.
  seen: Set<number>;
  // D6 note from an earlier opening (persisted as pendingNote), for the next turn.
  carried: string | undefined;
  // The note the next turn would get right now (kept saved, so a close doesn't lose it).
  pending: string;
  // turns.json exists but can't be read (permissions, I/O): never overwrite it.
  readError: string | undefined;
}

interface Running {
  readonly turn: StoredTurn;
  readonly owner: Loaded;
  readonly openId: number;
  token: string;
  child: ChildProcess | undefined;
  readonly mcpDir: string;
  cancelled: boolean;
  killTimer: NodeJS.Timeout | undefined;
  // tool_use id → index into turn.items
  readonly steps: Map<string, number>;
  // The revision the turn's note covers: the agent has seen it once claude actually started.
  readonly noteRevision: number;
  // Why the turn was stopped when it wasn't the user's Stop (shown on the card).
  stopReason: string | undefined;
}

const historyFile = (dir: string) => join(dir, "agent", "turns.json");

const isString = (v: unknown): v is string => typeof v === "string";
const STATUSES = new Set(["running", "done", "error", "cancelled"]);

/** A turn read back from disk, or undefined when it isn't one. Turns cut off by a quit say so. */
function storedTurn(raw: unknown): StoredTurn | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  if (!isString(t.id) || !isString(t.prompt) || !isString(t.startedAt) || !isString(t.status) || !STATUSES.has(t.status)) return undefined;
  const items = Array.isArray(t.items)
    ? t.items.filter((i): i is StoredTurn["items"][number] => !!i && typeof i === "object" && (i.kind === "text" || i.kind === "step") && isString(i.text))
    : [];
  const edits = Array.isArray(t.edits)
    ? t.edits.filter((e): e is AgentEdit => !!e && typeof e === "object" && typeof e.revision === "number" && isString(e.summary) && Array.isArray(e.lines))
    : [];
  const interrupted = t.status === "running";
  return {
    id: t.id,
    prompt: t.prompt,
    startedAt: t.startedAt,
    status: interrupted ? "error" : (t.status as StoredTurn["status"]),
    items: items.map((i) => (i.status === "running" ? { ...i, status: "error" as const } : i)),
    edits,
    ...(isString(t.note) ? { note: t.note } : {}),
    ...(isString(t.finishedAt) ? { finishedAt: t.finishedAt } : {}),
    ...(interrupted ? { error: "Interrupted: Uncut stopped while the agent was working." } : isString(t.error) ? { error: t.error } : {}),
    ...(typeof t.seconds === "number" ? { seconds: t.seconds } : {}),
    ...(isString(t.undoneAt) ? { undoneAt: t.undoneAt } : {}),
  };
}

interface History {
  readonly sessionId: string | undefined;
  readonly turns: Array<StoredTurn>;
  readonly pendingNote: string | undefined;
  readonly readError?: string;
}

/** turns.json: none yet is an empty history; one that can't be read is an error, never "empty". */
export async function readHistory(dir: string): Promise<History> {
  let text: string;
  try {
    text = await readFile(historyFile(dir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessionId: undefined, turns: [], pendingNote: undefined };
    return { sessionId: undefined, turns: [], pendingNote: undefined, readError: (error as Error).message };
  }
  try {
    const parsed = JSON.parse(text) as { sessionId?: unknown; turns?: unknown; pendingNote?: unknown };
    if (!Array.isArray(parsed.turns)) throw new Error("no turns");
    return {
      sessionId: isString(parsed.sessionId) ? parsed.sessionId : undefined,
      turns: parsed.turns.map(storedTurn).filter((t): t is StoredTurn => t !== undefined),
      pendingNote: isString(parsed.pendingNote) && parsed.pendingNote ? parsed.pendingNote : undefined,
    };
  } catch {
    // Not JSON (or not ours): set it aside rather than overwrite it with the next turn.
    await rename(historyFile(dir), join(dir, "agent", `turns.unreadable-${Date.now()}.json`)).catch(() => {});
    return { sessionId: undefined, turns: [], pendingNote: undefined };
  }
}

// ---- notes and undo states ----

/**
 * D6: what the user changed since the agent last looked. Item edits come from the log (core
 * manualEditsNote); undo, redo, reload and undone turns aren't log entries, so they're listed too.
 */
export function noteFor(view: ProjectView, since: number): string {
  const base = manualEditsNote(view.session, since);
  const extra = view.unlogged.filter((u) => u.revision > since).map((u) => `- ${u.what}`);
  if (!extra.length) return base;
  if (!base) {
    return [
      `Since your last turn the user changed the project (now at revision ${view.session.revision}). Read it again before editing; keep what they did.`,
      ...extra,
    ].join("\n");
  }
  return [base, ...extra].join("\n");
}

/** A note carried over from an earlier opening, then the current one. */
export const joinNotes = (carried: string | undefined, current: string) =>
  [carried ? `Earlier, before the project was closed and reopened:\n${carried}` : "", current].filter(Boolean).join("\n\n");

type UndoState = AgentTurn["undo"];
// Sessions are immutable, so a dry run per (session, turn) is computed once.
const dryRuns = new WeakMap<Session, Map<string, UndoState>>();

function undoState(turn: StoredTurn, view: ProjectView | undefined, openId: number, validate: (project: Project) => ReadonlyArray<{ readonly message: string }>): UndoState {
  if (turn.status === "running" || turn.edits.length === 0) return { state: "none" };
  if (!view || view.openId !== openId || !view.session.log.some((e) => e.turnId === turn.id)) {
    if (turn.undoneAt) return { state: "undone" };
    return { state: "unavailable", reason: "Its edits aren't in this session's history any more: the project was reopened or reloaded, or they were undone with ⌘Z." };
  }
  let cache = dryRuns.get(view.session);
  if (!cache) dryRuns.set(view.session, (cache = new Map()));
  const known = cache.get(turn.id);
  if (known) return known;
  let state: UndoState;
  try {
    // With validation, as the real undo does, so "available" means it will work.
    undoTurn(view.initial, view.session, turn.id, validate as Parameters<typeof undoTurn>[3]);
    state = { state: "available" };
  } catch (error) {
    const entry = error instanceof TurnDependency ? error.entry : undefined;
    const what = entry ? (entry.summary ?? (entry.ops[0] ? describeOp(entry.ops[0], view.session.project) : "a later edit")) : undefined;
    state = { state: "blocked", reason: what ? `A later edit builds on it: ${what}. Undo that first.` : String((error as Error).message) };
  }
  cache.set(turn.id, state);
  return state;
}

const timecode = (frame: number, fps: number) => `${(frame / fps).toFixed(2)} s`;

// Each turn's --mcp-config lives in tmpdir/uncut-agent-<server pid>-XXXXXX (0600, removed when
// the turn ends).
export const TURN_DIR_PREFIX = "uncut-agent-";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Turn folders whose server is gone (it was SIGKILLed or crashed): stop a claude still running
 * from one (found by its --mcp-config path on the command line, so no unrelated process with a
 * reused pid is touched), then remove the folder.
 */
export function cleanStaleTurns(dir = tmpdir()) {
  let names: Array<string>;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = new RegExp(`^${TURN_DIR_PREFIX}(\\d+)-`).exec(name);
    if (!m || alive(Number(m[1]))) continue;
    const folder = join(dir, name);
    try {
      const ps = execFileSync("ps", ["-axo", "pid=,pgid=,args="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      for (const line of ps.split("\n")) {
        const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (row && row[3]!.includes(join(folder, "mcp.json"))) {
          try {
            process.kill(-Number(row[2]), "SIGKILL");
          } catch {}
        }
      }
    } catch {}
    rmSync(folder, { recursive: true, force: true });
  }
}

// ---- the service ----

export const layer = Layer.effect(
  Agent,
  Effect.gen(function* () {
    const projects = yield* Projects;
    const format = yield* ProjectFormat;
    const exporter = yield* Exporter;
    const config = yield* ServerConfig;
    const { address } = yield* HttpServer.HttpServer;
    const port = "port" in address ? address.port : config.port;
    const bridgeUrl = `http://127.0.0.1:${port}`;

    const stateRef = yield* SubscriptionRef.make<AgentState | null>(null);
    const loadLock = yield* Semaphore.make(1);
    let loaded: Loaded | undefined;
    let running: Running | undefined;

    const view = () => Effect.runSync(projects.view);

    const stateNow = (): AgentState | null => {
      if (!loaded) return null;
      const v = view();
      const owner = loaded;
      return {
        dir: owner.dir,
        provider: PROVIDER,
        running: running && running.owner === owner ? running.turn.id : null,
        turns: owner.turns.map((t) => ({ ...t, items: [...t.items], edits: [...t.edits], undo: undoState(t, v, owner.openId, format.validate) })),
      };
    };
    const publish = () => Effect.runSync(SubscriptionRef.set(stateRef, stateNow()));

    // Writes go out one at a time, each with the state as it was when it was asked for.
    let writing: Promise<void> = Promise.resolve();
    const persist = (owner: Loaded) => {
      // A history we couldn't read stays as it is: saving now would replace it with less.
      if (owner.readError) return;
      const pendingNote = joinNotes(owner.carried, owner.pending) || undefined;
      const text = `${JSON.stringify({ format: HISTORY_FORMAT, provider: "claude", sessionId: owner.sessionId, pendingNote, turns: owner.turns }, null, 2)}\n`;
      const file = historyFile(owner.dir);
      writing = writing
        .then(() => mkdir(join(owner.dir, "agent"), { recursive: true }))
        .then(() => Effect.runPromise(writeFileAtomic(file, text)))
        .catch((error) => console.error(`[uncut] can't save the agent history to ${file}: ${(error as Error).message}`));
    };

    const killGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {}
      }
    };

    /** Stop the running turn: its token stops working now, the process gets SIGINT, then SIGKILL. */
    const stop = (r: Running, reason?: string) => {
      if (r.cancelled) return;
      r.cancelled = true;
      r.stopReason = reason;
      r.token = "";
      if (!r.child) return;
      killGroup(r.child, "SIGINT");
      r.killTimer = setTimeout(() => r.child && killGroup(r.child, "SIGKILL"), KILL_AFTER_MS);
    };

    /** The agent for the project open now, loading its history when another one opened. */
    const ensureLoaded = loadLock.withPermits(1)(
      Effect.gen(function* () {
        const v = yield* projects.view;
        if (!v) {
          if (running) stop(running, "Stopped: the project was closed.");
          loaded = undefined;
          return undefined;
        }
        if (loaded && loaded.openId === v.openId) return loaded;
        // The running turn's edits can't reach another opening: stop it (it saves as stopped).
        if (running && running.openId !== v.openId) stop(running, "Stopped: the project was closed or opened again.");
        // The same folder again (reopened, or back to it mid-turn): keep its Loaded, so the turns
        // array and turns.json keep one owner. What the agent was due to hear is carried over.
        const same = [loaded, running?.owner].find((o) => o !== undefined && o.dir === v.dir);
        if (same) {
          same.carried = joinNotes(same.carried, same.pending) || undefined;
          same.pending = "";
          same.openId = v.openId;
          same.seen = new Set();
          same.agentSeen = Math.min(same.agentSeen, v.session.revision - 1);
          loaded = same;
          return same;
        }
        // Saves still on their way (another project's, or this one's from before) land first.
        yield* Effect.promise(() => writing);
        const history = yield* Effect.promise(() => readHistory(v.dir));
        loaded = {
          dir: v.dir,
          openId: v.openId,
          sessionId: history.sessionId,
          turns: history.turns,
          // With earlier turns, the opening itself is news (the project may have changed while it
          // was closed); a project the agent never worked on has nothing to report.
          agentSeen: history.turns.length ? v.session.revision - 1 : v.session.revision,
          seen: new Set(),
          carried: history.pendingNote,
          pending: "",
          readError: history.readError,
        };
        return loaded;
      }),
    );

    // Follow the open project: another opening loads its history, every change refreshes the
    // undo states, a close stops the running turn.
    // The pending note is kept saved as the user edits, so a close (or a crash) doesn't lose it.
    const trackPending = () => {
      const owner = loaded;
      const v = view();
      if (!owner || !v || v.openId !== owner.openId) return;
      const pending = noteFor(v, owner.agentSeen);
      if (pending === owner.pending) return;
      owner.pending = pending;
      persist(owner);
    };
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

    // A server that stops takes its agent with it: on a normal shutdown (the finalizer) and on
    // any exit that skips it (bin.ts's 1 s exit timer, a crash), synchronously.
    const killRunning = () => {
      if (!running) return;
      running.cancelled = true;
      if (running.child) killGroup(running.child, "SIGKILL");
      rmSync(running.mcpDir, { recursive: true, force: true });
    };
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

    const textResult = (value: unknown, isError = false): McpResult => ({
      content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }],
      ...(isError ? { isError: true } : {}),
    });

    const tokenOk = (given: string | null, r: Running | undefined): r is Running => {
      if (!r || r.cancelled || !given || !r.token) return false;
      const a = Buffer.from(given);
      const b = Buffer.from(r.token);
      return a.length === b.length && timingSafeEqual(a, b);
    };

    // ---- tools ----

    const runTool = (r: Running, name: string, args: Record<string, unknown>): Effect.Effect<McpResult> =>
      Effect.gen(function* () {
        const v = view();
        if (!v || v.openId !== r.openId) return textResult("The project was closed.", true);
        switch (name) {
          case "project_read": {
            r.owner.agentSeen = Math.max(r.owner.agentSeen, v.session.revision);
            r.owner.seen.add(v.session.revision);
            const range = args.range as { start: number; end: number } | undefined;
            return textResult(args.detail === "full" ? { revision: v.session.revision, project: v.session.project } : projectSummary(v.session.project, v.session.revision, range));
          }
          case "modules_list":
            return textResult(modulesList(format.modules, typeof args.kind === "string" ? args.kind : undefined));
          case "render_frames": {
            const frames = Array.isArray(args.frames) ? args.frames : [];
            if (!frames.length || frames.length > MAX_FRAMES || !frames.every((f) => Number.isInteger(f) && f >= 0)) return textResult(`frames must be 1 to ${MAX_FRAMES} frame numbers (integers from 0).`, true);
            const canvas = v.session.project.canvas;
            const scale = typeof args.scale === "number" && args.scale > 0 && args.scale <= 1 ? args.scale : Math.min(1, FRAME_WIDTH / canvas.width);
            const width = Math.max(64, Math.round(canvas.width * scale));
            const rendered = yield* exporter.renderFrames(frames as Array<number>, width).pipe(
              Effect.map((list) => ({ ok: true as const, list })),
              Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
            );
            if (!rendered.ok) return textResult(`Couldn't render the frames: ${rendered.message}`, true);
            const height = Math.round((width * canvas.height) / canvas.width / 2) * 2;
            return {
              content: [
                { type: "text", text: `Frame${rendered.list.length === 1 ? "" : "s"} ${rendered.list.map((r) => r.frame).join(", ")} of the edit (revision ${v.session.revision}) at ${Math.round(width / 2) * 2}×${height}, drawn as the export draws them, in that order.` },
                ...rendered.list.map((r) => ({ type: "image" as const, data: r.jpeg.toString("base64"), mimeType: "image/jpeg" })),
              ],
            };
          }
          case "timeline_edit": {
            const { baseRevision, ops, summary } = args;
            if (typeof baseRevision !== "number" || !Number.isInteger(baseRevision)) return textResult("Pass baseRevision: the revision from your last project_read.", true);
            if (!Array.isArray(ops)) return textResult("ops must be a list of edit ops.", true);
            if (!r.owner.seen.has(baseRevision)) {
              return textResult(
                { refused: `baseRevision ${baseRevision} isn't a revision you read in this session. Call project_read and edit from what it returns.`, revision: v.session.revision },
                true,
              );
            }
            const line = typeof summary === "string" && summary.trim() ? summary.trim() : "Edited the timeline";
            const outcome = yield* projects.agentEdit(r.openId, { turnId: r.turn.id, ops, baseRevision, summary: line }).pipe(
              Effect.map((snapshot) => ({ ok: true as const, snapshot })),
              Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
            );
            if (!outcome.ok) {
              const now = view();
              const userChanges = now ? noteFor(now, baseRevision) : "";
              return textResult(
                {
                  refused: outcome.error.message,
                  details: outcome.error.details,
                  revision: now?.session.revision,
                  ...(userChanges ? { userChanges } : {}),
                },
                true,
              );
            }
            const { snapshot } = outcome;
            const project = snapshot.project as Project;
            const lines = (ops as ReadonlyArray<Op>).map((op) => {
              try {
                return describeOp(op, project);
              } catch {
                return String((op as { op?: unknown }).op ?? "edit");
              }
            });
            r.turn.edits.push({ revision: snapshot.revision, summary: line, lines });
            persist(r.owner);
            // agentSeen doesn't move: user edits made since the agent's last read (they didn't
            // touch what this edit touched, or it would have been refused) are still news. They
            // come back with the result; with none, the new revision is as good as read.
            const now = view();
            const userChanges = now ? noteFor(now, baseRevision) : "";
            if (!userChanges) r.owner.seen.add(snapshot.revision);
            const end = projectSummary(project, snapshot.revision).duration;
            return textResult({
              ok: true,
              revision: snapshot.revision,
              duration: end,
              seconds: Number((end / project.canvas.fps).toFixed(2)),
              ...(userChanges ? { userChanges, note: "The user changed the project since your read. project_read before your next edit." } : {}),
            });
          }
          default:
            return textResult(`Unknown tool ${name}`, true);
        }
      });

    // ---- running claude ----

    const finish = (r: Running, patch: Partial<StoredTurn>) => {
      if (r.turn.status !== "running") return;
      clearTimeout(r.killTimer);
      Object.assign(r.turn, patch, { finishedAt: new Date().toISOString() });
      if (r.turn.seconds === undefined) r.turn.seconds = Math.round((Date.now() - Date.parse(r.turn.startedAt)) / 100) / 10;
      const ok = patch.status === "done";
      for (const item of r.turn.items) if (item.status === "running") item.status = ok ? "done" : "error";
      r.token = "";
      rmSync(r.mcpDir, { recursive: true, force: true });
      if (running === r) running = undefined;
      persist(r.owner);
      publish();
    };

    const spawnClaude = (r: Running, bin: string, prompt: string, resume: boolean) => {
      const cfg = join(r.mcpDir, "mcp.json");
      // The MCP server runs on the same runtime as this server: Node in development, the
      // Electron binary in Node mode in the packaged app (bin.ts took ELECTRON_RUN_AS_NODE out of
      // our environment, so it is set again for this one child).
      const mcpEntry = process.env.UNCUT_MCP_ENTRY || fileURLToPath(new URL("./mcp.mjs", import.meta.url));
      const args = ["-p", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--mcp-config", cfg, "--allowedTools", "mcp__uncut", "--permission-mode", "dontAsk", "--append-system-prompt", SYSTEM_PROMPT];
      if (process.env.UNCUT_AGENT_MODEL) args.push("--model", process.env.UNCUT_AGENT_MODEL);
      if (resume && r.owner.sessionId) args.push("--resume", r.owner.sessionId);

      let child: ChildProcess;
      try {
        writeFileSync(
          cfg,
          JSON.stringify({
            mcpServers: {
              uncut: {
                command: process.execPath,
                args: [mcpEntry],
                env: { UNCUT_BRIDGE: bridgeUrl, UNCUT_AGENT_TOKEN: r.token, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
              },
            },
          }),
          { mode: 0o600 },
        );
        // Its own process group, so a cancel also stops the MCP server claude started.
        child = spawn(bin, args, { cwd: r.owner.dir, env: agentEnv(process.env), stdio: ["pipe", "pipe", "pipe"], detached: true });
      } catch (error) {
        return finish(r, { status: "error", error: `Couldn't start Claude Code: ${(error as Error).message}` });
      }
      r.child = child;
      // The prompt goes over stdin: no length limit, and a prompt starting with "-" stays a prompt.
      child.stdin!.on("error", () => {});
      child.stdin!.end(prompt);

      let buffer = "";
      let stderr = "";
      let gotInit = false;
      let final: { is_error?: boolean; result?: unknown; duration_ms?: unknown } | undefined;
      const onLine = (line: string) => {
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === "system" && msg.subtype === "init") {
          gotInit = true;
          // claude has the prompt, so the note in it has been delivered. (Before this, a failed
          // start or an early Stop leaves the note for the next turn.)
          r.owner.agentSeen = Math.max(r.owner.agentSeen, r.noteRevision);
          r.owner.carried = undefined;
          r.owner.pending = "";
          trackPending();
          persist(r.owner);
          if (isString(msg.session_id) && msg.session_id !== r.owner.sessionId) {
            r.owner.sessionId = msg.session_id;
            persist(r.owner);
          }
          const status = (msg.mcp_servers as Array<{ name?: string; status?: string }> | undefined)?.find((s) => s.name === "uncut")?.status;
          if (status === "failed") {
            stop(r);
            r.cancelled = false; // not the user's doing: report it as an error
            r.turn.error = "Uncut's tools didn't start for Claude Code, so it couldn't see or edit the project.";
          }
        } else if (msg.type === "assistant") {
          for (const c of (msg.message?.content ?? []) as Array<Record<string, any>>) {
            if (c.type === "text" && isString(c.text) && c.text.trim()) r.turn.items.push({ kind: "text", text: c.text.trim() });
            if (c.type === "tool_use" && isString(c.name)) {
              const tool = c.name.replace(/^mcp__uncut__/, "");
              r.steps.set(String(c.id), r.turn.items.length);
              r.turn.items.push({ kind: "step", tool, text: stepLabel(tool, c.input), status: "running" });
            }
          }
          publish();
        } else if (msg.type === "user") {
          const content = msg.message?.content;
          for (const c of (Array.isArray(content) ? content : []) as Array<Record<string, any>>) {
            if (c.type !== "tool_result") continue;
            const at = r.steps.get(String(c.tool_use_id));
            const item = at === undefined ? undefined : r.turn.items[at];
            if (item) item.status = c.is_error ? "error" : "done";
          }
          publish();
        } else if (msg.type === "result") {
          final = msg;
        }
      };
      // Decoded as a stream, so a character split across two chunks ("ó" in "Kraków") stays whole.
      child.stdout!.setEncoding("utf8");
      child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        buffer += chunk;
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (line) onLine(line);
        }
      });
      child.stderr!.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
      let settled = false;
      const settle = (code: number | null, startError?: Error) => {
        if (settled) return;
        settled = true;
        if (buffer.trim()) onLine(buffer.trim());
        if (startError) return finish(r, { status: "error", error: `Couldn't start Claude Code (${bin}): ${startError.message}` });
        if (r.cancelled) return finish(r, { status: "cancelled", ...(r.stopReason ? { error: r.stopReason } : {}) });
        // A stored session can be gone (another Mac, a cleaned ~/.claude): start a fresh one, once.
        const output = `${stderr}\n${isString(final?.result) ? final.result : ""}`;
        if (resume && !gotInit && /no conversation found/i.test(output)) {
          r.owner.sessionId = undefined;
          return spawnClaude(r, bin, prompt, false);
        }
        if (r.turn.error) return finish(r, { status: "error" });
        if (final && !final.is_error) {
          return finish(r, { status: "done", ...(typeof final.duration_ms === "number" ? { seconds: Math.round(final.duration_ms / 100) / 10 } : {}) });
        }
        const why = (isString(final?.result) && final.result.trim()) || stderr.trim().split("\n").slice(-3).join(" ") || `exit code ${code}`;
        return finish(r, { status: "error", error: `Claude Code stopped: ${why}` });
      };
      child.once("error", (error) => settle(null, error));
      child.once("close", (code) => settle(code));
    };

    const send: AgentShape["send"] = ({ prompt, frame, selected }) =>
      Effect.gen(function* () {
        const owner = yield* ensureLoaded;
        if (!owner) return yield* new AgentError({ reason: "no-project", message: "Open a project first." });
        if (running) return yield* new AgentError({ reason: "busy", message: "The agent is still working on the last message." });
        if (owner.readError) {
          return yield* new AgentError({
            reason: "failed",
            message: `Can't read this project's agent history (agent/turns.json): ${owner.readError}. Fix the file's permissions, then open the project again.`,
          });
        }
        const text = prompt.trim();
        if (!text) return yield* new AgentError({ reason: "failed", message: "Write what you'd like the agent to do." });
        // Wait for the login shell's PATH, or a Finder launch would miss ~/.local/bin.
        yield* Effect.promise(() => config.shellReady);
        const bin = yield* Effect.promise(() => findClaude());
        if (!bin) {
          return yield* new AgentError({ reason: "not-installed", message: "Claude Code isn't installed. Install it, sign in once with `claude`, then try again." });
        }
        if (running) return yield* new AgentError({ reason: "busy", message: "The agent is still working on the last message." });
        const v = view();
        if (!v || v.openId !== owner.openId) return yield* new AgentError({ reason: "no-project", message: "The project was closed." });

        const note = joinNotes(owner.carried, noteFor(v, owner.agentSeen));
        const project = v.session.project;
        const context = [
          frame !== undefined ? `Playhead: frame ${frame} (${timecode(frame, project.canvas.fps)}).` : "",
          selected ? `Selected item: ${selected}.` : "",
          note,
        ].filter(Boolean);
        const fullPrompt = context.length ? `${text}\n\n<editor-context>\n${context.join("\n")}\n</editor-context>` : text;

        const turn: StoredTurn = {
          id: `turn-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
          prompt: text,
          ...(note ? { note } : {}),
          startedAt: new Date().toISOString(),
          status: "running",
          items: [],
          edits: [],
        };
        const mcpDir = yield* Effect.try({
          try: () => mkdtempSync(join(tmpdir(), `${TURN_DIR_PREFIX}${process.pid}-`)),
          catch: (error) => new AgentError({ reason: "failed", message: `Can't prepare the agent's tools: ${(error as Error).message}` }),
        });
        owner.turns.push(turn);
        const r: Running = {
          turn,
          owner,
          openId: owner.openId,
          token: randomBytes(24).toString("base64url"),
          child: undefined,
          mcpDir,
          cancelled: false,
          killTimer: undefined,
          steps: new Map(),
          noteRevision: v.session.revision,
          stopReason: undefined,
        };
        running = r;
        persist(owner);
        publish();
        spawnClaude(r, bin, fullPrompt, true);
        return { turnId: turn.id };
      });

    return Agent.of({
      changes: SubscriptionRef.changes(stateRef),
      send,
      cancel: Effect.sync(() => {
        if (running) stop(running);
      }),
      undoTurn: (turnId) =>
        Effect.gen(function* () {
          const owner = yield* ensureLoaded;
          if (!owner) return yield* new AgentError({ reason: "no-project", message: "Open a project first." });
          if (running) return yield* new AgentError({ reason: "busy", message: "Wait for the agent to finish, or stop it, before undoing a turn." });
          const turn = owner.turns.find((t) => t.id === turnId);
          if (!turn) return yield* new AgentError({ reason: "unknown-turn", message: "That turn isn't in this project's history." });
          const label = `Undid your turn "${turn.prompt.length > 80 ? `${turn.prompt.slice(0, 77)}...` : turn.prompt}"`;
          const snapshot = yield* projects.undoTurn(owner.openId, turnId, label);
          turn.undoneAt = new Date().toISOString();
          persist(owner);
          publish();
          return snapshot;
        }),
      tools: (token) => Effect.sync(() => (tokenOk(token, running) ? mcpTools() : undefined)),
      call: (token, name, args) =>
        Effect.suspend(() => {
          const r = running;
          if (!tokenOk(token, r)) return Effect.succeed(undefined);
          const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
          return runTool(r, String(name), input).pipe(Effect.tap(() => Effect.sync(publish)));
        }),
    });
  }),
);
