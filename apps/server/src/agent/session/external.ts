// An outside agent (Claude Code in a terminal, Cursor, ...) driving Uncut over MCP. It has no process
// here, so its calls run in a turn of a stand-in session: a turn of a project agent of its own,
// opened by the first call and ended after IDLE_MS without one. Edits, undo and cards work as in
// any other turn. Its access is always "ask": big changes wait for the user's Allow on a card.
import { randomBytes } from "node:crypto";
import type { AgentError, AgentFocus, AgentInfo } from "@uncut/contracts";
import * as Effect from "effect/Effect";
import type * as Semaphore from "effect/Semaphore";
import { isTestRun } from "../../generate/providers.ts";
import { mcpTools } from "../agentTools.ts";
import type { McpResult } from "../agent.ts";
import { freshTurnState, type ClaudeSession, type Loaded, type Running, type StoredTurn } from "./types.ts";
import type { SpawnCtx } from "./spawn.ts";

export const EXTERNAL_AGENT_NAME = "Outside agent";
export const NO_PROJECT_MESSAGE =
  "No project is open in Uncut. Call project_open with a footage folder or a .uncut project, or ask the user to open one, then try again.";

const EXTERNAL_PROMPT = "An outside agent is working over MCP";
const STOPPED_MESSAGE = "The user pressed Stop in Uncut. Stop working and ask them what to do next.";
const IDLE_MS = 30_000;

const idleMs = (config: { readonly keysFd?: number | undefined }) =>
  isTestRun(process.env, config.keysFd) && Number(process.env.UNCUT_EXTERNAL_IDLE_MS) > 0 ? Number(process.env.UNCUT_EXTERNAL_IDLE_MS) : IDLE_MS;

const standIn = (owner: Loaded, endExternal: () => void): ClaudeSession => ({
  provider: "claude",
  endExternal,
  owner,
  openId: owner.openId,
  dir: "",
  token: "",
  toolsKey: "",
  claudeSkills: [],
  skillDirs: [],
  model: undefined,
  effort: undefined,
  thinking: undefined,
  snapshotOff: false,
  resumed: undefined,
  dirsKey: "",
  prompts: new Map(),
  access: "ask",
  initId: "",
  initialized: true,
  initFailed: false,
  initTimer: undefined,
  waiting: undefined,
  child: undefined,
  turn: undefined,
  gotInit: true,
  closed: true,
  stderr: "",
  idleTimer: undefined,
  killTimer: undefined,
  gens: 0,
  initModel: undefined,
  systemChars: 0,
  toolsChars: undefined,
});

/** What outside turns spent per opening of a project: idling ends a turn, so a cap per turn would reset every 30 s. */
export const makeSpendLedger = () => {
  const spent = new Map<number, number>();
  const of = (openId: number) => spent.get(openId) ?? 0;
  const add = (openId: number, amount = 0) => void spent.set(openId, of(openId) + amount);
  return { of, add };
};

interface Link {
  readonly r: Running;
  calls: number;
  timer: NodeJS.Timeout | undefined;
}

export const makeExternal = (
  ctx: SpawnCtx & {
    readonly createAgent: (input: { readonly focus: AgentFocus; readonly name?: string | undefined }) => Effect.Effect<AgentInfo, AgentError>;
    readonly externalLock: Semaphore.Semaphore;
  },
) => {
  const {
    allowed,
    runTool,
    finish,
    turnCleanup,
    ensureLoaded,
    createAgent,
    externalLock,
    label,
    doing,
    persist,
    publishNow,
    plugins,
    textResult,
    view,
    config,
    st,
  } = ctx;

  let link: Link | undefined;
  let stoppedByUser = false;
  const spend = makeSpendLedger();

  const endTurn = (ended: Link) => {
    if (link === ended) link = undefined;
    spend.add(ended.r.openId, ended.r.turn.spend);
    return Effect.runPromise(turnCleanup(ended.r))
      .catch((error) => console.error(`[uncut] turn clean-up failed: ${(error as Error).message}`))
      .finally(() => finish(ended.r, { status: "done" }));
  };

  const armIdle = (held: Link) => {
    clearTimeout(held.timer);
    held.timer = setTimeout(() => void endTurn(held), idleMs(config));
    held.timer.unref?.();
  };

  const ownerFor = Effect.gen(function* () {
    const agents = yield* ensureLoaded;
    if (!agents?.length) return undefined;
    const known = agents.find((a) => a.name === EXTERNAL_AGENT_NAME);
    if (known) return known;
    const info = yield* createAgent({ name: EXTERNAL_AGENT_NAME, focus: "general" });
    return st.agents.find((a) => a.agentId === info.id);
  });

  const onStop = (r: Running) => {
    stoppedByUser = r.stopReason === undefined;
    spend.add(r.openId, r.turn.spend);
    if (link?.r === r) {
      clearTimeout(link.timer);
      link = undefined;
    }
    finish(r, { status: "cancelled", ...(r.stopReason ? { error: r.stopReason } : {}) });
  };

  const openTurn = (owner: Loaded) => {
    const v = view();
    if (!v || v.openId !== owner.openId) return undefined;
    const turn: StoredTurn = {
      id: `turn-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      prompt: EXTERNAL_PROMPT,
      agentId: owner.agentId,
      startedAt: new Date().toISOString(),
      status: "running",
      items: [],
      edits: [],
    };
    owner.turns.push(turn);
    owner.bounds.set(turn.id, { start: v.session.revision });
    const r: Running = {
      ...freshTurnState(),
      turn,
      owner,
      openId: owner.openId,
      session: standIn(owner, () => onStop(r)),
      message: EXTERNAL_PROMPT,
      gen: 1,
      noteRevision: v.session.revision,
      access: "ask",
      images: [],
      priorSpend: spend.of(owner.openId),
    };
    r.session.turn = r;
    owner.running = r;
    persist(owner);
    publishNow();
    link = { r, calls: 0, timer: undefined };
    return link;
  };

  /** The open turn or a new one, or why there can't be one, in words for the agent. */
  const turnNow = externalLock.withPermits(1)(
    Effect.gen(function* () {
      const v = view();
      if (!v) return NO_PROJECT_MESSAGE;
      if (link && link.r.openId === v.openId && !link.r.cancelled) {
        clearTimeout(link.timer);
        link.calls++;
        return link;
      }
      if (stoppedByUser) {
        stoppedByUser = false;
        return STOPPED_MESSAGE;
      }
      const owner = yield* ownerFor;
      if (!owner) return NO_PROJECT_MESSAGE;
      if (owner.running) return `${owner.name} is working on a message the user sent it in Uncut. Try again when it has finished.`;
      const opened = openTurn(owner);
      if (!opened) return NO_PROJECT_MESSAGE;
      opened.calls++;
      return opened;
    }).pipe(Effect.catchTag("AgentError", (error) => Effect.succeed(error.message))),
  );

  const startStep = (r: Running, name: string, input: Record<string, unknown>) => {
    const item: StoredTurn["items"][number] = { kind: "step", tool: name, text: label(name, input), status: "running", doing: doing(name, input) };
    r.turn.items.push(item);
    publishNow();
    return item;
  };

  const endStep = (held: Link, item: StoredTurn["items"][number], result: McpResult) => {
    item.status = result.isError ? "error" : "done";
    delete item.doing;
    held.calls--;
    if (held.calls === 0 && link === held) armIdle(held);
    persist(held.r.owner);
    publishNow();
  };

  const externalCall = (name: string, args: unknown): Effect.Effect<McpResult> =>
    Effect.gen(function* () {
      const held = yield* turnNow;
      if (typeof held === "string") return textResult(held, true);
      const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      const item = startStep(held.r, name, input);
      const refusal = yield* allowed(held.r, name, input);
      const result = refusal ?? (yield* runTool(held.r, name, input));
      endStep(held, item, result);
      return result;
    });

  const externalTools = Effect.andThen(
    plugins.refresh,
    Effect.map(plugins.tools, (extra) => [...mcpTools(), ...extra]),
  );

  return { externalCall, externalTools };
};
