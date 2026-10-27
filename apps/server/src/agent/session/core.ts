// The agent's core: its published state, saving turns, closing sessions, stopping a turn, loading the open project's agents, bridge tokens.
import type { ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { AgentError, type AgentInfo, type AgentPlan, type AgentState } from "@uncut/contracts";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { readPlan } from "../../brand/store.ts";
import { withHistory } from "../../project/history.ts";
import { defaultAgent, type StoredAgent, storedAgents } from "../../project/history/agents.ts";
import type { ProjectView } from "../../project/projects.ts";
import type { Loaded, Running, ClaudeSession, StoredTurn } from "./types.ts";
import { undoState, joinNotes, noteFor, noteShowsAll, type Reader } from "../turns/notes.ts";
import { turnRecord, loadAgentHistory } from "../turns/history.ts";
import { PROVIDER, GRACEFUL_MS, KILL_AFTER_MS, interruptMs } from "./config.ts";
import type { McpResult } from "../agent.ts";
import type { AgentServices } from "./context.ts";
import { codexInterrupt } from "./codex.ts";

const byStart = (a: StoredTurn, b: StoredTurn) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0);

/** The project's agents as saved, archived ones left out (the default agent when the list can't be read). */
export function savedAgents(dir: string): Array<StoredAgent> {
  try {
    return withHistory(dir, (db) => storedAgents(db.agentList())).filter((a) => !a.archivedAt);
  } catch (error) {
    console.error(`[uncut] can't read the agents of ${dir}: ${(error as Error).message}`);
    return [defaultAgent()];
  }
}

export const makeCore = (ctx: AgentServices) => {
  const { st, view, format, screenWaits, stateRef, loadLock, projects, sessions } = ctx;

  const infoOf = (a: Loaded): AgentInfo => {
    const running = a.running && a.running.owner === a ? a.running.turn.id : null;
    const approval = running && a.approval?.card.turnId === running ? a.approval.card : undefined;
    const screenTake = running ? [...screenWaits].find(([, w]) => w.turnId === running)?.[0] : undefined;
    const warning = [a.initWarning, a.limitWarning].filter(Boolean).join(" ");
    return {
      id: a.agentId,
      name: a.name,
      focus: a.focus,
      colour: a.colour,
      status: approval ? "waiting" : running ? "working" : "idle",
      running,
      ...(approval ? { approval } : {}),
      ...(screenTake ? { screenTake } : {}),
      ...(warning ? { warning } : {}),
      ...(a.context ? { context: a.context } : {}),
      ...(a.threadStart ? { threadStart: a.threadStart } : {}),
    };
  };

  const stateNow = (): AgentState | null => {
    const first = st.agents[0];
    if (!first) return null;
    const v = view();
    const agents = st.agents.map(infoOf);
    const { id: _id, name: _name, focus: _focus, colour: _colour, status: _status, ...main } = agents[0]!;
    const turns = st.agents
      .flatMap((a) => a.turns.map((t) => ({ ...t, items: [...t.items], edits: [...t.edits], undo: undoState(t, v, a.openId, format.validate) })))
      .sort(byStart);
    const ui = st.agents.flatMap((a) => (a.ui ? [a.ui] : [])).at(-1);
    return { dir: first.dir, provider: PROVIDER, agents, ...main, turns, ...(ui ? { ui } : {}), plan: first.plan };
  };
  const publish = () => Effect.runSync(SubscriptionRef.set(stateRef, stateNow()));

  /** The project's agents loaded now (a closed project's still stopping included), for saving the turns' order. */
  const agentsOf = (dir: string) => [...st.agents, ...st.closing].filter((a) => a.dir === dir);

  /** C12: a note for this agent: the user's edits and the other agents', named. */
  const readerOf = (owner: Loaded): Reader => ({
    agentId: owner.agentId,
    nameOf: (id) => agentsOf(owner.dir).find((a) => a.agentId === id)?.name ?? "another agent",
  });

  // Saved to history.db right away (node:sqlite is synchronous): only the turns that changed.
  const persist = (owner: Loaded) => {
    // A turns.json we couldn't read stays as it is and nothing replaces it.
    if (owner.readError) return;
    const pendingNote = joinNotes(owner.carried, owner.pending) || undefined;
    const changed: Array<[string, string]> = [];
    const turns = owner.turns.flatMap((t) => {
      const json = JSON.stringify(t);
      if (owner.saved.get(t.id) === json) return [];
      changed.push([t.id, json]);
      return [turnRecord(t, owner.bounds.get(t.id))];
    });
    const order = agentsOf(owner.dir)
      .flatMap((a) => a.turns)
      .sort(byStart)
      .map((t) => t.id);
    try {
      withHistory(owner.dir, (db) =>
        db.saveAgent({ agentId: owner.agentId, sessionId: owner.sessionId, pendingNote, threadStart: owner.threadStart, turns, order }),
      );
      for (const [id, json] of changed) owner.saved.set(id, json);
    } catch (error) {
      console.error(`[uncut] can't save the agent history of ${owner.dir}: ${(error as Error).message}`);
    }
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

  /**
   * Close a session: "graceful" ends claude's input (it exits when it has nothing left), "kill"
   * sends the group SIGINT, then SIGKILL. Either way SIGKILL follows if it lingers. A turn still
   * in it ends when the process does (the close handler).
   */
  const closeSession = (s: ClaudeSession, how: "graceful" | "kill") => {
    if (s.owner.session === s) s.owner.session = undefined;
    clearTimeout(s.idleTimer);
    if (s.closed && how === "graceful") return;
    s.closed = true;
    const child = s.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (how === "graceful") {
      try {
        child.stdin?.end();
      } catch {}
    } else killGroup(child, "SIGINT");
    clearTimeout(s.killTimer);
    s.killTimer = setTimeout(() => killGroup(child, "SIGKILL"), how === "graceful" ? GRACEFUL_MS : KILL_AFTER_MS);
  };

  /**
   * Stop the running turn: its tool calls stop being taken now. Claude gets an interrupt control
   * request and the turn ends at the result that answers it; if none comes in time (or `hard`:
   * the project closed) the session is killed and the turn ends with it.
   */
  const stop = (r: Running, reason?: string, hard = false) => {
    if (r.cancelled) {
      if (hard) closeSession(r.session, "kill");
      return;
    }
    r.cancelled = true;
    r.stopReason = reason;
    r.abort.abort();
    const s = r.session;
    if (hard || !s.child || !s.child.stdin?.writable) return closeSession(s, "kill");
    // Issue #106: Codex's turn/interrupt (before its turn started there's nothing to interrupt: the session goes).
    if (s.provider === "codex" && !codexInterrupt(s)) return closeSession(s, "kill");
    if (s.provider === "codex") {
      r.interruptTimer = setTimeout(() => {
        if (r.turn.status === "running") closeSession(s, "kill");
      }, interruptMs());
      return;
    }
    try {
      s.child.stdin.write(
        `${JSON.stringify({ type: "control_request", request_id: `stop-${randomBytes(4).toString("hex")}`, request: { subtype: "interrupt" } })}\n`,
      );
    } catch {
      return closeSession(s, "kill");
    }
    r.interruptTimer = setTimeout(() => {
      if (r.turn.status === "running") closeSession(s, "kill");
    }, interruptMs());
  };

  /** An agent's turn and session can't reach another opening: the turn stops (it saves as stopped), the next message starts another claude (with --resume). */
  const leaveOpening = (a: Loaded, openId: number | undefined, reason: string) => {
    if (a.running && a.running.openId !== openId) stop(a.running, reason, true);
    if (a.session && a.session.openId !== openId) closeSession(a.session, "kill");
  };

  /**
   * The same folder again (reopened, or back to it mid-turn): the agent keeps its Loaded, so the
   * turns array and its history keep one owner. What it was due to hear is carried over.
   */
  const reopen = (same: Loaded, v: ProjectView) => {
    same.carried = joinNotes(same.carried, same.pending) || undefined;
    same.pending = "";
    same.openId = v.openId;
    same.agentSeen = Math.min(same.agentSeen, v.session.revision - 1);
    same.ui = undefined;
    // The history this opening writes to may not hold what was saved before (an in-memory
    // history from a locked history.db, now a healthy file): save every turn again.
    same.saved.clear();
    // D194: "Always for this session" ends with the opening.
    same.grants.clear();
    same.dirs.length = 0;
    same.mentioned.length = 0;
    same.webUsed = false;
    same.tainted.clear();
    return same;
  };

  // D188: the open project's brief, storyboard and reviews, one for all its agents (each Loaded's plan reads and writes it).
  let shared = { plan: { reviews: [] } as AgentPlan };
  const sharePlan = (a: Loaded) => {
    const holder = shared;
    return Object.defineProperty(a, "plan", {
      get: () => holder.plan,
      set: (plan: AgentPlan) => void (holder.plan = plan),
      enumerable: true,
      configurable: true,
    });
  };

  /** A Loaded agent with what history.db keeps of it. */
  const newLoaded = (v: ProjectView, info: StoredAgent, history: Awaited<ReturnType<typeof loadAgentHistory>>): Loaded =>
    sharePlan({
      dir: v.dir,
      agentId: info.id,
      name: info.name,
      focus: info.focus,
      colour: info.colour,
      running: undefined,
      session: undefined,
      approval: undefined,
      initWarning: undefined,
      limitWarning: undefined,
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
      ui: undefined,
      saved: new Map(history.turns.map((t) => [t.id, JSON.stringify(t)])),
      bounds: new Map(),
      plan: shared.plan,
      grants: new Set(),
      dirs: [],
      mentioned: [],
      webUsed: false,
      tainted: new Set(),
      ...(history.threadStart ? { threadStart: history.threadStart } : {}),
    });

  /** The agents of the project open now, loading them when another one opened. */
  const ensureLoaded = loadLock.withPermits(1)(
    Effect.gen(function* () {
      const v = yield* projects.view;
      const all = [...st.agents, ...st.closing.filter((a) => a.running)];
      if (!v) {
        for (const a of all) leaveOpening(a, undefined, "Stopped: the project was closed.");
        st.closing = all.filter((a) => a.running);
        st.agents = [];
        return undefined;
      }
      if (st.agents[0]?.openId === v.openId) return st.agents;
      for (const a of all) leaveOpening(a, v.openId, "Stopped: the project was closed or opened again.");
      const loaded: Array<{ info: StoredAgent; same?: Loaded; history?: Awaited<ReturnType<typeof loadAgentHistory>> }> = [];
      for (const info of savedAgents(v.dir)) {
        const same = all.find((a) => a.dir === v.dir && a.agentId === info.id);
        loaded.push(same ? { info, same } : { info, history: yield* Effect.promise(() => loadAgentHistory(v.dir, info.id)) });
      }
      shared = { plan: yield* Effect.promise(() => readPlan(v.dir)) };
      const agents = loaded.map(({ info, same, history }) => (same ? sharePlan(reopen(same, v)) : newLoaded(v, info, history!)));
      st.closing = all.filter((a) => a.running && !agents.includes(a));
      st.agents = agents;
      return agents;
    }),
  );

  /** C12: an agent of the open project by id (absent: the first one, for clients from before several agents). */
  const agentOf = (agentId: string | undefined) =>
    Effect.flatMap(ensureLoaded, (agents) => {
      if (!agents) return Effect.fail(new AgentError({ reason: "no-project", message: "Open a project first." }));
      const owner = agentId === undefined ? agents[0] : agents.find((a) => a.agentId === agentId);
      return owner ? Effect.succeed(owner) : Effect.fail(new AgentError({ reason: "failed", message: "That agent isn't in this project any more." }));
    });

  /** C12: a new agent of the open project (no turns yet), after the saved list has it. */
  const addLoaded = (v: ProjectView, info: StoredAgent) => {
    const added = newLoaded(v, info, { sessionId: undefined, turns: [], pendingNote: undefined });
    st.agents.push(added);
    return added;
  };

  // The pending note is kept saved as the user edits, so a close (or a crash) doesn't lose it.
  const trackPending = () => {
    const v = view();
    for (const owner of st.agents) {
      if (!v || v.openId !== owner.openId) continue;
      const pending = noteFor(v, owner.agentSeen, readerOf(owner));
      if (pending === owner.pending) continue;
      owner.pending = pending;
      persist(owner);
    }
  };

  /**
   * C12 (D6): what the user and the other agents changed since this agent last looked, for a tool
   * result that returns it; the project now counts as read only when that note leaves nothing out
   * (nothing changed, or noteShowsAll).
   */
  const othersSince = (r: Running): string => {
    const now = view();
    if (!now || now.openId !== r.openId) return "";
    const note = noteFor(now, r.owner.agentSeen, readerOf(r.owner));
    if (!note || noteShowsAll(now, r.owner.agentSeen)) r.owner.seen.add(now.session.revision);
    return note;
  };

  /** C12 (D6): the revision of the agent's own change counts as read only when nobody else changed the project since it last looked (it isn't told here). */
  const seeOwn = (r: Running, revision: number) => {
    const now = view();
    if (now && now.openId === r.openId && !noteFor(now, r.owner.agentSeen, readerOf(r.owner))) r.owner.seen.add(revision);
  };

  // A server that stops takes its agents with it: on a normal shutdown (the finalizer) and on
  // any exit that skips it (bin.ts's 1 s exit timer, a crash), synchronously.
  const killRunning = () => {
    const all = [...st.agents, ...st.closing];
    for (const a of all) if (a.running) a.running.cancelled = true;
    for (const s of new Set([...all.flatMap((a) => [a.session, a.running?.session]), ...sessions])) {
      if (!s) continue;
      s.closed = true;
      if (s.child) killGroup(s.child, "SIGKILL");
      rmSync(s.dir, { recursive: true, force: true });
    }
  };

  const textResult = (value: unknown, isError = false): McpResult => ({
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  });

  /** The live session `given` is the token of (tools/list works between turns: claude lists tools when it starts). */
  const sessionFor = (given: string | null): ClaudeSession | undefined => {
    if (!given) return undefined;
    const a = Buffer.from(given);
    return st.agents.find((x) => {
      const s = x.session;
      if (!s || s.closed || !s.token) return false;
      const b = Buffer.from(s.token);
      return a.length === b.length && timingSafeEqual(a, b);
    })?.session;
  };
  /** A tool call is taken only for the turn running in that session now. */
  const runningFor = (given: string | null): Running | undefined => {
    const s = sessionFor(given);
    const r = s?.owner.running;
    return r && !r.cancelled && r.session === s && s.turn === r ? r : undefined;
  };

  return {
    ensureLoaded,
    agentOf,
    addLoaded,
    infoOf,
    othersSince,
    seeOwn,
    trackPending,
    publish,
    killRunning,
    textResult,
    persist,
    closeSession,
    stop,
    sessionFor,
    runningFor,
    readerOf,
  };
};

export type CoreCtx = AgentServices & ReturnType<typeof makeCore>;
