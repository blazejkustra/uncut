// The agent's core: its published state, saving turns, closing sessions, stopping a turn, loading the open project's agent, bridge tokens.
import type { ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import type { AgentState } from "@uncut/contracts";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { readPlan } from "../../brand/store.ts";
import { withHistory } from "../../project/history.ts";
import type { Loaded, Running, ClaudeSession } from "./types.ts";
import { undoState, joinNotes, noteFor } from "../turns/notes.ts";
import { turnRecord, loadAgentHistory } from "../turns/history.ts";
import { PROVIDER, GRACEFUL_MS, KILL_AFTER_MS, interruptMs } from "./config.ts";
import type { McpResult } from "../agent.ts";
import type { AgentServices } from "./context.ts";
import { codexInterrupt } from "./codex.ts";

export const makeCore = (ctx: AgentServices) => {
  const { st, view, format, screenWaits, stateRef, loadLock, projects, sessions } = ctx;

  const stateNow = (): AgentState | null => {
    if (!st.loaded) return null;
    const v = view();
    const owner = st.loaded;
    return {
      dir: owner.dir,
      provider: PROVIDER,
      running: st.running && st.running.owner === owner ? st.running.turn.id : null,
      turns: owner.turns.map((t) => ({ ...t, items: [...t.items], edits: [...t.edits], undo: undoState(t, v, owner.openId, format.validate) })),
      ...(owner.ui ? { ui: owner.ui } : {}),
      plan: owner.plan,
      ...(owner.context ? { context: owner.context } : {}),
      ...(owner.threadStart ? { threadStart: owner.threadStart } : {}),
      ...(st.initWarning || st.limitWarning ? { warning: [st.initWarning, st.limitWarning].filter(Boolean).join(" ") } : {}),
      ...(st.approval && st.running && st.running.owner === owner && st.running.turn.id === st.approval.card.turnId ? { approval: st.approval.card } : {}),
      ...(() => {
        const live = st.running && st.running.owner === owner ? [...screenWaits].find(([, w]) => w.turnId === st.running!.turn.id)?.[0] : undefined;
        return live ? { screenTake: live } : {};
      })(),
    };
  };
  const publish = () => Effect.runSync(SubscriptionRef.set(stateRef, stateNow()));

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
    try {
      withHistory(owner.dir, (db) =>
        db.saveAgent({ sessionId: owner.sessionId, pendingNote, threadStart: owner.threadStart, turns, order: owner.turns.map((t) => t.id) }),
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
    if (st.session === s) st.session = undefined;
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

  /** The agent for the project open now, loading its history when another one opened. */
  const ensureLoaded = loadLock.withPermits(1)(
    Effect.gen(function* () {
      const v = yield* projects.view;
      if (!v) {
        if (st.running) stop(st.running, "Stopped: the project was closed.", true);
        if (st.session) closeSession(st.session, "kill");
        st.loaded = undefined;
        return undefined;
      }
      if (st.loaded && st.loaded.openId === v.openId) return st.loaded;
      // The running turn's edits can't reach another opening: stop it (it saves as stopped).
      if (st.running && st.running.openId !== v.openId) stop(st.running, "Stopped: the project was closed or opened again.", true);
      // Nor can the session's tools: the next message starts another (with --resume).
      if (st.session && st.session.openId !== v.openId) closeSession(st.session, "kill");
      // The same folder again (reopened, or back to it mid-turn): keep its Loaded, so the turns
      // array and turns.json keep one owner. What the agent was due to hear is carried over.
      const same = [st.loaded, st.running?.owner].find((o) => o !== undefined && o.dir === v.dir);
      if (same) {
        same.carried = joinNotes(same.carried, same.pending) || undefined;
        same.pending = "";
        same.openId = v.openId;
        same.seen = new Set();
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
        same.plan = yield* Effect.promise(() => readPlan(v.dir));
        st.loaded = same;
        return same;
      }
      const history = yield* Effect.promise(() => loadAgentHistory(v.dir));
      const plan = yield* Effect.promise(() => readPlan(v.dir));
      st.loaded = {
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
        ui: undefined,
        saved: new Map(history.turns.map((t) => [t.id, JSON.stringify(t)])),
        bounds: new Map(),
        plan,
        grants: new Set(),
        dirs: [],
        mentioned: [],
        webUsed: false,
        tainted: new Set(),
        ...(history.threadStart ? { threadStart: history.threadStart } : {}),
      };
      return st.loaded;
    }),
  );

  // The pending note is kept saved as the user edits, so a close (or a crash) doesn't lose it.
  const trackPending = () => {
    const owner = st.loaded;
    const v = view();
    if (!owner || !v || v.openId !== owner.openId) return;
    const pending = noteFor(v, owner.agentSeen);
    if (pending === owner.pending) return;
    owner.pending = pending;
    persist(owner);
  };

  // A server that stops takes its agent with it: on a normal shutdown (the finalizer) and on
  // any exit that skips it (bin.ts's 1 s exit timer, a crash), synchronously.
  const killRunning = () => {
    if (st.running) st.running.cancelled = true;
    for (const s of new Set([st.session, st.running?.session, ...sessions])) {
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

  /** The live session's token (tools/list works between turns: claude lists tools when it starts). */
  const sessionTokenOk = (given: string | null) => {
    const s = st.session;
    if (!s || s.closed || !given || !s.token) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(s.token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  /** A tool call is taken only for the turn running in that session now. */
  const tokenOk = (given: string | null, r: Running | undefined): r is Running =>
    !!r && !r.cancelled && sessionTokenOk(given) && r.session === st.session && st.session?.turn === r;

  return { ensureLoaded, trackPending, publish, killRunning, textResult, persist, closeSession, stop, sessionTokenOk, tokenOk };
};

export type CoreCtx = AgentServices & ReturnType<typeof makeCore>;
