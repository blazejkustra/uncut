// The agent (D40, D41, D48): one turn at a time for the open project. A turn runs `claude -p`
// with no built-in tools and one MCP server (mcp.ts) that forwards tool calls to this server's
// /agent routes (agentBridge.ts) under a token that lives as long as the turn. Agent edits go
// through Projects like the user's (same validation, saving and undo stack, live in the editor),
// attributed to the agent and tagged with the turn, so a turn can be undone (D7). Before each
// turn the agent is told what the user changed by hand since it last looked (D6).
//
// Turns are kept in <project>/history.db (D71, history.ts), with Claude Code's session id so the
// next turn (also after reopening) continues the same conversation, and the pending D6 note. Not in
// .cache/: wiping the cache must not lose the history. An agent/turns.json from before (D51) is
// moved in on first open and renamed agent/turns.migrated-<time>.json; one that can't be read is
// left alone and turns are refused until it can be.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import { AGENT_UI_PANELS, AgentError, type AgentEdit, type Analyzer, type AgentItem, type AgentState, type AgentTurn, type AgentApproval, type AgentUi, type AgentUiPanel, type EditRefused, type ProjectError, type ProjectSnapshot } from "@uncut/contracts";
import { captionCardList, subtitleCues, subtitleFormatOf, subtitleTime, MUSIC_TEMPOS, musicInProject, musicMedia, musicTrack, projectIds, decodeEnvelope, DEFAULT_PAUSE_MIN_S, describeOp, duckMediaIds, GRAPHIC_SRC, layout, MAX_GRAPHIC_BYTES, manualEditsNote, planMakeCaptions, pluginCheckRules, planTextCut, TurnDependency, undoTurn, type CaptionLines, type CaptionMode, type MusicTempo, type Op, type Project, type Session, type SpeechEnvelope, type TextCutRequest } from "@uncut/core";
import { filterSfx, hitKey, libraryMediaOf, limitSentence } from "@uncut/core/library";
import { mediaIdFor } from "@uncut/core/music";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpServer } from "effect/http";

import { Analysis, cachedFor, parseAnalyzers, targetOf, type AnalysisTarget, type LoudnessResult, type Outcome, type RequestOptions, type SilenceRange } from "../analysis/analysis.ts";
import { transcriptOut, transcriptSummary, TRANSCRIPT_NOTE } from "./agentTranscript.ts";
import { BEATS_NOTE, beatsOut } from "./agentBeats.ts";
import type { BeatsResult } from "../analysis/beats.ts";
import { isLanguage, type TranscriptResult } from "../analysis/transcription.ts";
import { framesFor, MAX_RANKED, rankEntry, shotCells, VIDEO_NOTE, videoOut } from "./agentVideo.ts";
import { capSkipped, CELL_WIDTH, clock, DEFAULT_CELLS, MAX_CELLS, planImport, sheetFrames, sheetLayout } from "./agentFootage.ts";
import { checksOut, expandArrangeOps, expandCaptionEdits, expandDeviceFrames, expandTextLooks, FRAME_WIDTH, MAX_CAPTION_CARDS, MAX_FRAMES, mcpTools, modulesList, musicOut, playheadLine, projectSummary, stepLabel, SYSTEM_PROMPT, type McpTool } from "./agentTools.ts";
import { copyLibraryTrack } from "../media/music.ts";
import { ServerConfig } from "../app/config.ts";
import { Exporter } from "../export/exporter.ts";
import { canonicalPath } from "../export/subtitleSources.ts";
import { ProjectFormat } from "../project/format.ts";
import { withHistory, type TurnRecord } from "../project/history.ts";
import { MediaLibrary, type MediaEntry } from "../media/media.ts";
import { Plugins } from "../plugins/plugins.ts";
import { applyDeclared, appliedNote } from "../capture/capture.ts";
import { CONFIRM_OVER, Generator, needsKeyLine, TURN_CAP } from "../generate/generate.ts";

/** How long an approval card waits for the user (D99). */
const APPROVAL_MS = 120_000;
import { Keys, providerName } from "../generate/keys.ts";
import { Library } from "../library/library.ts";
import { isTestRun } from "../generate/providers.ts";
import { Projects, type ProjectView } from "../project/projects.ts";
import { which } from "../app/setup.ts";
import { agentEnv } from "../app/shellEnv.ts";
import type { VideoResult } from "../analysis/videoAnalysis.ts";
import { DEFAULT_BEST_SECONDS, RANK_BY, rankValue, type RankBy } from "../analysis/videoScores.ts";
import { besideServer } from "../paths.ts";

export const PROVIDER = "Claude Code";
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
  /** The user's answer to the running turn's approval card (D99). */
  readonly approve: (id: string, allow: boolean) => Effect.Effect<void>;
  readonly undoTurn: (turnId: string) => Effect.Effect<ProjectSnapshot, AgentError | EditRefused | ProjectError>;
  /** For the bridge: the tool list, or undefined when `token` isn't the running turn's. */
  readonly tools: (token: string | null) => Effect.Effect<ReadonlyArray<McpTool> | undefined>;
  /** For the bridge: whether `token` is the running turn's (no rescan, unlike tools). */
  readonly authorized: (token: string | null) => Effect.Effect<boolean>;
  /** For the bridge: run a tool call of the running turn, or undefined when `token` isn't its. */
  readonly call: (token: string | null, name: unknown, args: unknown) => Effect.Effect<McpResult | undefined>;
}

export class Agent extends Context.Service<Agent, AgentShape>()("uncut/Agent") {}

// ---- environment (D41) ----

// The agent's environment (D41): shellEnv.ts's agentEnv, kept importable from here.
export { agentEnv };

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
  // The agent's latest ui_show (D65), for the renderer to apply once. Not saved.
  ui: AgentUi | undefined;
  // Each turn as last saved (JSON), so a save only writes the turns that changed.
  readonly saved: Map<string, string>;
  // The revisions a turn started and ended at (history.db's columns; not part of AgentTurn).
  readonly bounds: Map<string, { start?: number; end?: number }>;
}

interface Running {
  readonly turn: StoredTurn;
  readonly owner: Loaded;
  readonly openId: number;
  token: string;
  child: ChildProcess | undefined;
  readonly mcpDir: string;
  // Aborted when the turn stops or ends: a plugin call still running is cancelled (D97).
  readonly abort: AbortController;
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
    ...(typeof t.spend === "number" && Number.isFinite(t.spend) && t.spend > 0 ? { spend: t.spend } : {}),
  };
}

interface History {
  readonly sessionId: string | undefined;
  readonly turns: Array<StoredTurn>;
  readonly pendingNote: string | undefined;
  readonly readError?: string;
}

/** agent/turns.json (D51, before history.db): none is an empty history; one that can't be read is an error, never "empty". */
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

const byStart = (a: StoredTurn, b: StoredTurn) => Date.parse(a.startedAt) - Date.parse(b.startedAt);

/**
 * The agent's history (D71): from history.db, after moving in an agent/turns.json left from before
 * (its turns history.db doesn't have yet, its session and note when history.db has none), which is
 * then renamed so it's read once. A turns.json that can't be read stops here (turns are refused, the
 * file is left alone). A history in memory (history.db unusable) reads turns.json but keeps it.
 */
export async function loadAgentHistory(dir: string): Promise<History> {
  const legacy = await readHistory(dir);
  if (legacy.readError) return legacy;
  return withHistory(dir, (db) => {
    const stored = db.agent();
    const turns = stored.turns.map(storedTurn).filter((t): t is StoredTurn => t !== undefined);
    if (!existsSync(historyFile(dir))) return { sessionId: stored.sessionId, turns, pendingNote: stored.pendingNote };
    const known = new Set(turns.map((t) => t.id));
    const merged = [...turns, ...legacy.turns.filter((t) => !known.has(t.id))].sort(byStart);
    const sessionId = stored.sessionId ?? legacy.sessionId;
    const pendingNote = stored.pendingNote ?? legacy.pendingNote;
    if (db.persistent) {
      db.saveAgent({ sessionId, pendingNote, turns: merged.map((t) => turnRecord(t)), migratedAt: new Date().toISOString() });
      // The save can have moved the history to memory (the file failed): then turns.json stays.
      if (db.persistent) {
        try {
          renameSync(historyFile(dir), join(dir, "agent", `turns.migrated-${Date.now()}.json`));
        } catch (error) {
          console.error(`[uncut] moved the agent history into history.db but couldn't rename agent/turns.json: ${(error as Error).message}`);
        }
      }
    }
    return { sessionId, turns: merged, pendingNote };
  });
}

const turnRecord = (t: StoredTurn, bounds?: { start?: number; end?: number }): TurnRecord => ({
  id: t.id,
  prompt: t.prompt,
  status: t.status,
  startedAt: t.startedAt,
  finishedAt: t.finishedAt,
  startRevision: bounds?.start,
  endRevision: bounds?.end,
  data: t,
});

// ---- notes and undo states ----

/**
 * D6: what the user changed since the agent last looked. Item edits come from the log (core
 * manualEditsNote); undo, redo, reload and undone turns aren't log entries, so they're listed too.
 */
export function noteFor(view: ProjectView, since: number): string {
  // The log goes back to earlier openings (history.db); what happened then reached the note that
  // was carried over (pendingNote), so only this opening's edits count here.
  const base = manualEditsNote(view.session, Math.max(since, view.openRevision));
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
  const logged = new Set(view && view.openId === openId ? view.session.log.filter((e) => e.turnId === turn.id).map((e) => e.revision) : []);
  if (!view || !logged.size) {
    if (turn.undoneAt) return { state: "undone" };
    return {
      state: "unavailable",
      reason: "Its edits aren't in the project's history any more: project.json was changed outside Uncut after it, an earlier version was restored from History, or they were undone with ⌘Z.",
    };
  }
  // history.db keeps the last revisions only: a turn whose first edits are gone can't be taken back whole.
  if (!turn.edits.every((e) => logged.has(e.revision))) {
    return { state: "unavailable", reason: "Part of it is older than the history keeps, so it can't be undone as a whole any more." };
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

/** media_analyze waits this long for its jobs before answering "running" (UNCUT_ANALYZE_WAIT_MS for tests). */
const analyzeWaitMs = () => {
  const n = Number(process.env.UNCUT_ANALYZE_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? n : 55_000;
};
/** transcript_edit waits this long for a loudness pass that isn't cached (D74). */
const SILENCES_WAIT_MS = 20_000;
/** At most this many silences in one answer (a range narrows it down). */
const MAX_SILENCES = 400;

/** The loudness analyzer's result as media_analyze returns it: silences in project frames of the media too. */
function loudnessOut(result: LoudnessResult, cached: boolean, frames: (seconds: number, round: (x: number) => number) => number, range: { start: number; end: number } | undefined) {
  if (!result.hasAudio) return { state: "done", cached, hasAudio: false, note: "This media has no sound, so there's nothing to measure." };
  const all = (result.silence?.ranges ?? [])
    .map((r) => ({ start: frames(r.start, Math.ceil), end: frames(r.end, Math.floor), startSeconds: r.start, endSeconds: r.end }))
    .filter((r) => r.end > r.start && (!range || (r.start < range.end && r.end > range.start)));
  return {
    state: "done",
    cached,
    hasAudio: true,
    ...(result.seconds !== undefined ? { seconds: result.seconds } : {}),
    integratedLufs: result.integratedLufs ?? null,
    loudnessRangeLu: result.loudnessRangeLu ?? null,
    truePeakDbtp: result.truePeakDbtp ?? null,
    silence: {
      thresholdDb: result.silence?.thresholdDb,
      minSeconds: result.silence?.minSeconds,
      count: all.length,
      ...(range ? { range } : {}),
      ranges: all.slice(0, MAX_SILENCES),
      ...(all.length > MAX_SILENCES ? { truncated: `Only the first ${MAX_SILENCES} of ${all.length}; pass range for the rest.` } : {}),
    },
  };
}

/** contact_sheet: when the asked-for columns didn't fit the sheet, say what was used instead. */
const columnsNote = (asked: number | undefined, used: number) => (asked !== undefined && asked !== used ? `${asked} columns didn't fit the sheet's size, so it has ${used}.` : "");
const timecode = (frame: number, fps: number) => `${(frame / fps).toFixed(2)} s`;
const realOr = (path: string, dir: string) => realpath(isAbsolute(path) ? path : resolve(dir, path)).catch(() => path);

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
    const media = yield* MediaLibrary;
    const analysis = yield* Analysis;
    const config = yield* ServerConfig;
    const plugins = yield* Plugins;
    const generator = yield* Generator;
    const keys = yield* Keys;
    const sounds = yield* Library;
    let uiCount = 0;
    const { address } = yield* HttpServer.HttpServer;
    const port = "port" in address ? address.port : config.port;
    // The MCP server dials back to this server: loopback, unless a headless server listens on one address only (D106).
    const bridgeHost = config.host === "0.0.0.0" || config.host === "::" || config.host === "" ? "127.0.0.1" : config.host;
    const bridgeUrl = `http://${bridgeHost.includes(":") ? `[${bridgeHost}]` : bridgeHost}:${port}`;

    const stateRef = yield* SubscriptionRef.make<AgentState | null>(null);
    const loadLock = yield* Semaphore.make(1);
    let loaded: Loaded | undefined;
    let running: Running | undefined;
    // UNCUT_APPROVAL_MS shortens the approval wait in test runs only (as D99's base URLs).
    const testRun = isTestRun(process.env, config.keysFd);
    const approvalMs = () => (testRun && Number(process.env.UNCUT_APPROVAL_MS) > 0 ? Number(process.env.UNCUT_APPROVAL_MS) : APPROVAL_MS);
    // The running turn's one open approval card (D99) and how to answer it.
    let approval: { readonly card: AgentApproval; readonly answer: (a: "allow" | "deny" | "timeout" | "stopped") => void } | undefined;

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
        ...(owner.ui ? { ui: owner.ui } : {}),
        ...(approval && running && running.owner === owner && running.turn.id === approval.card.turnId ? { approval: approval.card } : {}),
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
        withHistory(owner.dir, (db) => db.saveAgent({ sessionId: owner.sessionId, pendingNote, turns, order: owner.turns.map((t) => t.id) }));
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

    /** Stop the running turn: its token stops working now, the process gets SIGINT, then SIGKILL. */
    const stop = (r: Running, reason?: string) => {
      if (r.cancelled) return;
      r.cancelled = true;
      r.stopReason = reason;
      r.token = "";
      r.abort.abort();
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
          same.ui = undefined;
          // The history this opening writes to may not hold what was saved before (an in-memory
          // history from a locked history.db, now a healthy file): save every turn again.
          same.saved.clear();
          loaded = same;
          return same;
        }
        const history = yield* Effect.promise(() => loadAgentHistory(v.dir));
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
          ui: undefined,
          saved: new Map(history.turns.map((t) => [t.id, JSON.stringify(t)])),
          bounds: new Map(),
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

    /** A media entry as media_import returns it: its probe in project terms. */
    const entryInfo = (e: MediaEntry, fps: number) => ({
      id: e.id,
      kind: e.kind,
      name: e.name,
      path: e.path,
      ...(e.probe.frames ? { frames: e.probe.frames, seconds: Number((e.probe.frames / fps).toFixed(2)) } : {}),
      ...(e.probe.fps ? { fps: Number(e.probe.fps.toFixed(3)) } : {}),
      ...(e.probe.width ? { width: e.probe.width, height: e.probe.height } : {}),
      hasAudio: e.probe.hasAudio,
    });

    // media_import (D65): files or a folder's media files, through the Library's import job but
    // as the agent's edit (one entry in the turn, so Undo turn takes it back and the next
    // manual-edit note doesn't list it).
    const mediaImport = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const hasPath = args.path !== undefined;
        const hasPaths = args.paths !== undefined;
        if (hasPath === hasPaths) return textResult("Pass path (one file or folder) or paths (a list of them), not both.", true);
        if (hasPaths && !Array.isArray(args.paths)) return textResult("paths must be a list of absolute paths.", true);
        const raw: ReadonlyArray<unknown> = hasPath ? [args.path] : (args.paths as ReadonlyArray<unknown>);
        const name = typeof args.name === "string" ? args.name.trim() : undefined;
        if (args.name !== undefined && !name) return textResult("name must be a non-empty string.", true);
        const plan = yield* Effect.promise(() => planImport(raw, v.dir));
        if ("refused" in plan) return textResult(plan.refused, true);
        if (name && plan.files.length !== 1) return textResult("name is only for importing one file; leave it out for a folder or several paths.", true);
        if (!plan.files.length) return textResult({ imported: [], ...capSkipped(plan.skipped), failed: [], note: "Nothing to import: no media files there." });
        // Uninterruptible: a turn stopped mid-import still gets the edit on its card (so Undo turn
        // can take back media the job adds anyway).
        const outcome = yield* Effect.uninterruptible(
          media.importForAgent({ openId: r.openId, dir: v.dir, turnId: r.turn.id, paths: plan.files, names: name ? new Map([[plan.files[0]!, name]]) : undefined }).pipe(
            Effect.map((value) => {
              const { snapshot, entries } = value;
              const subs = value.subtitles ?? [];
              if (snapshot) {
                const lines = [
                  ...entries.map((entry) => describeOp({ op: "add_media", media: entry } as Op, snapshot.project as Project)),
                  ...subs.map((s) => `Imported ${s.cues} subtitle cue${s.cues === 1 ? "" : "s"} from ${basename(s.path)} as track ${s.track}`),
                ];
                const count = entries.length + subs.length;
                r.turn.edits.push({ revision: snapshot.revision, summary: count === 1 ? (entries.length ? `Imported ${entries[0]!.name}` : `Imported subtitles ${basename(subs[0]!.path)}`) : `Imported ${count} files`, lines });
                persist(r.owner);
                publish();
                // The agent may edit from the revision it gets back: user edits made since its last
                // read are in that state, and come back with the result (userChanges), so it knows.
                r.owner.seen.add(snapshot.revision);
              }
              const now = view();
              return { ok: true as const, value, userChanges: snapshot && now ? noteFor(now, r.owner.agentSeen) : "" };
            }),
            Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
          ),
        );
        if (!outcome.ok) return textResult(`The import didn't finish: ${outcome.message}`, true);
        const { snapshot, entries, skipped, failed } = outcome.value;
        const project = (snapshot?.project ?? v.session.project) as Project;
        // Files already in the project say which media they are.
        const byPath = new Map<string, string>();
        for (const m of project.media) byPath.set(yield* Effect.promise(() => realOr(m.path, v.dir)), m.id);
        const skippedOut: Array<{ path: string; reason: string; id?: string }> = [...plan.skipped];
        for (const s of skipped) {
          const id = byPath.get(yield* Effect.promise(() => realOr(s.path, v.dir)));
          skippedOut.push(id ? { ...s, id } : s);
        }
        return textResult({
          ...(snapshot ? { revision: snapshot.revision } : {}),
          imported: entries.map((e) => entryInfo(e, project.canvas.fps)),
          // Subtitles (D105): a Subtitles text track of plain text items, one per cue, at the edit's frames.
          ...(outcome.value.subtitles?.length ? { subtitles: outcome.value.subtitles.map((s) => ({ ...s, note: `Text items on track ${s.track}, one per cue; subtitles_export writes them (with any captions) as .srt or .vtt.` })) } : {}),
          ...capSkipped(skippedOut),
          failed,
          ...(entries.length ? { note: "Frames, in and duration are project frames; probe frames is each file's length in them." } : {}),
          ...(outcome.userChanges ? { userChanges: outcome.userChanges, userNote: "The user changed the project since your read; the revision above includes their changes. Keep them." } : {}),
        });
      });

    // Starts (or joins) analysis jobs and waits up to ANALYZE_WAIT_MS for them: each comes back
    // with its outcome, or without one (still queued or running; the job says how far).
    const requestAndWait = (requests: ReadonlyArray<{ readonly target: AnalysisTarget; readonly analyzer: Analyzer; readonly options?: RequestOptions }>) =>
      Effect.promise(async () => {
        const requested = await Promise.all(requests.map(async (q) => ({ ...q, r: await analysis.request(q.target, q.analyzer, q.options) })));
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<undefined>((r) => (timer = setTimeout(r, analyzeWaitMs(), undefined)));
        timer?.unref();
        try {
          return await Promise.all(requested.map(async ({ target, analyzer, r }) => ({ target, analyzer, jobId: r.job?.id, outcome: (await Promise.race([r.done, deadline])) as Outcome | undefined })));
        } finally {
          clearTimeout(timer);
        }
      });
    /** A job still going, as the agent sees it. */
    const pendingOut = (jobId: string | undefined) => {
      const job = jobId ? analysis.job(jobId) : undefined;
      if (job?.phase === "queued") return { state: "queued" as const, ...(job.waiting ? { waitingFor: "an export to finish" } : job.analyzer === "transcript" ? { waitingFor: "another transcript to finish" } : {}) };
      return { state: "running" as const, progress: job?.progress ?? 0, ...(job?.stage === "model" ? { stage: "downloading the speech model (first transcript only)" } : {}) };
    };
    /**
     * The loudness analyzer's silences and speech envelope: transcript pauses and cuts by text are
     * aligned to them (D74: whisper's word edges alone clip words). Cached, or (transcript_edit, which cuts) the loudness
     * pass is run (one quick ffmpeg pass, a few seconds for a long talk) and waited for up to
     * SILENCES_WAIT_MS; without them (it failed, or an export holds the queue) the transcript's own
     * edges are used. `run` false: cached only (transcript_read and media_analyze's summary only
     * report; media_analyze runs loudness when asked).
     */
    const soundOf = (loud: LoudnessResult | undefined) => (loud?.hasAudio ? { silences: loud.silence?.ranges, envelope: decodeEnvelope(loud.envelope) } : {});
    const silencesOf = async (target: AnalysisTarget, run = true): Promise<{ silences?: ReadonlyArray<SilenceRange> | undefined; envelope?: SpeechEnvelope | undefined }> => {
      const cached = (await cachedFor(target, "loudness")) as LoudnessResult | undefined;
      if (cached) return soundOf(cached);
      if (!run) return {};
      const { done } = await analysis.request(target, "loudness");
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<undefined>((r) => (timer = setTimeout(r, Math.min(SILENCES_WAIT_MS, analyzeWaitMs()), undefined)));
      timer?.unref();
      try {
        const outcome = await Promise.race([done, deadline]);
        return soundOf(outcome?.state === "done" ? (outcome.result as LoudnessResult) : undefined);
      } finally {
        clearTimeout(timer);
      }
    };
    /**
     * Ducking's key media without a loudness analysis (D85): started together and waited for up to
     * SILENCES_WAIT_MS. A sentence for timeline_edit's answer saying, per media, measured (heard now),
     * no sound (nothing to duck under), couldn't be measured, or still measuring; undefined when all
     * were measured already.
     */
    const duckAnalysis = async (dir: string, project: Project): Promise<string | undefined> => {
      const fps = project.canvas.fps;
      const pending = [];
      for (const id of duckMediaIds(project)) {
        const m = project.media.find((x) => x.id === id);
        if (!m) continue;
        const target = targetOf(dir, m, fps);
        if (await cachedFor(target, "loudness")) continue;
        pending.push({ name: m.name ?? id, target });
      }
      if (!pending.length) return undefined;
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<"waiting">((r) => (timer = setTimeout(() => r("waiting"), Math.min(SILENCES_WAIT_MS, analyzeWaitMs()))));
      timer?.unref();
      try {
        const outcomes = await Promise.all(
          pending.map(async (p) => {
            const { done } = await analysis.request(p.target, "loudness");
            const o = await Promise.race([done, deadline]);
            if (o === "waiting") return { name: p.name, kind: "waiting" as const };
            if (o.state === "done") return { name: p.name, kind: (o.result as LoudnessResult).hasAudio ? ("measured" as const) : ("silent" as const) };
            return { name: p.name, kind: "failed" as const, why: o.state === "failed" ? o.error : "it was stopped" };
          }),
        );
        const of = (kind: string) => outcomes.filter((o) => o.kind === kind);
        const list = (xs: ReadonlyArray<{ name: string }>) => xs.map((x) => x.name).join(", ");
        return [
          of("measured").length ? `Measured the loudness of ${list(of("measured"))} for ducking: it's heard now.` : "",
          of("silent").length ? `${list(of("silent"))} has no sound, so nothing ducks under it.` : "",
          ...of("failed").map((o) => `The loudness of ${o.name} couldn't be measured (${"why" in o ? o.why : ""}), so nothing ducks under it; media_analyze loudness tries again.`),
          of("waiting").length ? `Still measuring the loudness of ${list(of("waiting"))} for ducking; nothing ducks under it until that's done (media_analyze loudness follows it).` : "",
        ]
          .filter(Boolean)
          .join(" ");
      } finally {
        clearTimeout(timer);
      }
    };
    const cancelledNote = "The analysis was stopped (by the user, or the project closed) before it finished. Ask again to run it.";

    // contact_sheet (D65): frames of a media file (pulled from the original, 0:v:0) or of the edit
    // (exporter.renderFrames), in a grid with each cell's frame and time, as one JPEG.
    const contactSheet = (v: ProjectView, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        if (args.at !== undefined && args.at !== "every" && args.at !== "shots") return textResult('at must be "every" or "shots".', true);
        const atShots = args.at === "shots";
        if (atShots && typeof args.media !== "string") return textResult('at "shots" needs media: the shots of a media file (one frame per shot). For the edit, use every or max.', true);
        if (atShots && args.every !== undefined) return textResult('every goes with at "every"; at "shots" shows one frame per shot (max caps how many).', true);
        const int = (value: unknown, lo: number, hi: number) => (value === undefined ? undefined : Number.isInteger(value) && (value as number) >= lo && (value as number) <= hi ? (value as number) : null);
        const every = int(args.every, 1, Number.MAX_SAFE_INTEGER);
        const columns = int(args.columns, 1, 10);
        const max = int(args.max, 1, MAX_CELLS);
        if (every === null) return textResult("every must be a whole number of frames, at least 1.", true);
        if (columns === null) return textResult("columns must be 1 to 10.", true);
        if (max === null) return textResult(`max must be 1 to ${MAX_CELLS}.`, true);
        const range = args.range as { start?: unknown; end?: unknown } | undefined;
        if (range !== undefined && (typeof range !== "object" || !Number.isInteger(range.start) || !Number.isInteger(range.end) || (range.start as number) < 0)) {
          return textResult("range must be { start, end } in whole frames (start from 0).", true);
        }
        const project = v.session.project;
        const fps = project.canvas.fps;
        const limit = max ?? (every !== undefined ? MAX_CELLS : DEFAULT_CELLS);
        if (typeof args.media === "string") {
          const m = project.media.find((x) => x.id === args.media);
          if (!m) return textResult(`There's no media "${args.media}". project_read lists the media ids: ${project.media.map((x) => x.id).join(", ") || "(none yet)"}.`, true);
          if (m.kind !== "video") return textResult(`${m.id} is ${m.kind === "audio" ? "a sound file, with no picture" : "a still image; render_frames or the preview shows it"}. contact_sheet takes video.`, true);
          const length = m.probe?.frames ?? 0;
          if (!length) return textResult(`${m.id} has no known length, so it can't be sampled.`, true);
          const start = range ? (range.start as number) : 0;
          const end = range ? Math.min(range.end as number, length) : length;
          let frames: ReadonlyArray<number> | { readonly refused: string };
          let shotLines: Array<string> | undefined;
          let shotNote = "";
          if (atShots) {
            if (start >= end) return textResult(start >= length ? `${m.id} is ${length} frames long; the range starts after its end.` : `The range is empty (${start} to ${end}).`, true);
            // The shots come from the video analysis (cached, or run now, joining a running job).
            const [answer] = yield* requestAndWait([{ target: targetOf(v.dir, m, fps), analyzer: "video" }]);
            const outcome = answer!.outcome;
            if (!outcome) {
              const p = pendingOut(answer!.jobId);
              return textResult({ media: m.id, video: p, note: `Finding the shots needs the video analysis, which is still ${p.state === "queued" ? "waiting" : "running"} after ${Math.round(analyzeWaitMs() / 1000)} s. Call contact_sheet again with the same arguments; it joins the running job.` });
            }
            if (outcome.state === "failed") return textResult(`Couldn't find the shots of ${m.id}: ${outcome.error}`, true);
            if (outcome.state === "cancelled") return textResult(`Couldn't find the shots of ${m.id}: ${cancelledNote}`, true);
            const result = outcome.result as VideoResult;
            if (!result.hasVideo) return textResult(`ffmpeg found no picture in ${m.id}.`, true);
            const cells = shotCells(result, fps, length, range ? { start, end } : undefined, limit);
            if (!cells.shots.length) return textResult(`No shot of ${m.id} overlaps frames ${start}–${end}.`, true);
            frames = cells.shots.map((x) => x.frame);
            shotLines = cells.shots.map((x) => `shot frames ${x.start}–${x.end} (${clock(x.start / fps)}–${clock(x.end / fps)})`);
            shotNote = `${cells.total} shot${cells.total === 1 ? "" : "s"}${range ? " in the range" : ""}${cells.total > cells.shots.length ? `, ${cells.shots.length} of them shown (spread evenly; pass a range or max for others)` : ""}; each cell is the middle frame of its shot, and its line says the shot's frames [start, end).${range ? " A shot that only overlaps the range is shown whole, so its middle frame can lie outside the range." : ""}`;
          } else frames = sheetFrames(start, end, every, limit);
          if ("refused" in frames) return textResult(range && start >= length ? `${m.id} is ${length} frames long; the range starts after its end.` : frames.refused, true);
          const aspect = m.probe?.width && m.probe?.height ? m.probe.width / m.probe.height : 16 / 9;
          const grid = sheetLayout(frames.length, aspect, columns);
          const path = isAbsolute(m.path) ? m.path : resolve(v.dir, m.path);
          const sheet = yield* exporter.mediaFrames(path, frames.map((f) => f / fps), CELL_WIDTH, fps).pipe(
            Effect.flatMap((pulled) => {
              // A moment past the end of the picture shows its last frame: label the cell with the frame shown.
              const shown = pulled.map((p, i) => (p.seconds < frames[i]! / fps ? Math.floor(p.seconds * fps + 1e-6) : frames[i]!));
              return exporter.sheetImage(pulled.map((p, i) => ({ jpeg: p.jpeg, caption: `${i + 1}   f ${shown[i]}   ${clock(shown[i]! / fps)}` })), grid).pipe(Effect.map((jpeg) => ({ jpeg, shown })));
            }),
            Effect.map(({ jpeg, shown }) => ({ ok: true as const, jpeg, shown })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
          );
          if (!sheet.ok) return textResult(`Couldn't make the contact sheet: ${sheet.message}`, true);
          const cells = sheet.shown.map((f, i) => `${i + 1}: frame ${f} (${clock(f / fps)})${shotLines ? `, ${shotLines[i]}` : ""}`);
          const past = frames.flatMap((f, i) => (sheet.shown[i] !== f ? [`frame ${f} is past the end of the picture, so cell ${i + 1} shows its last frame, ${sheet.shown[i]}`] : []));
          const notes = [shotNote, columnsNote(columns, grid.columns), past.length ? `Note: ${past.join("; ")}.` : ""].filter(Boolean).join(" ");
          return {
            content: [
              { type: "text" as const, text: `Contact sheet of ${m.id} (${m.name}), ${frames.length} cells in ${grid.columns} columns, ${grid.width}×${grid.height}, read left to right, top to bottom. Frames are project frames of the media (use them as in; ${fps} per second), times are media time; each cell is the frame the preview and export show there.${notes ? ` ${notes}` : ""}\n${cells.join("\n")}` },
              { type: "image" as const, data: sheet.jpeg.toString("base64"), mimeType: "image/jpeg" },
            ],
          };
        }
        if (args.media !== undefined) return textResult("media must be a media id.", true);
        const { duration } = layout(project);
        const total = project.tracks.some((t) => t.items.length) ? duration : 0;
        if (!total) return textResult("The timeline is empty: there's nothing to sample yet. Pass media to look at a media file.", true);
        const start = range ? (range.start as number) : 0;
        const end = range ? Math.min(range.end as number, total) : total;
        if (start >= total) return textResult(`The edit is ${total} frames long; the range starts after its end.`, true);
        const frames = sheetFrames(start, end, every, limit);
        if ("refused" in frames) return textResult(frames.refused, true);
        const grid = sheetLayout(frames.length, project.canvas.width / project.canvas.height, columns);
        const sheet = yield* exporter.renderFrames(frames, CELL_WIDTH).pipe(
          Effect.flatMap((list) => exporter.sheetImage(list.map((f, i) => ({ jpeg: f.jpeg, caption: `${i + 1}   f ${f.frame}   ${clock(f.frame / fps)}` })), grid).pipe(Effect.map((jpeg) => ({ jpeg, shown: list.map((f) => f.frame) })))),
          Effect.map(({ jpeg, shown }) => ({ ok: true as const, jpeg, shown })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
        );
        if (!sheet.ok) return textResult(`Couldn't make the contact sheet: ${sheet.message}`, true);
        const cells = sheet.shown.map((f, i) => `${i + 1}: frame ${f} (${clock(f / fps)})`);
        const notes = columnsNote(columns, grid.columns);
        return {
          content: [
            { type: "text" as const, text: `Contact sheet of the edit (revision ${v.session.revision}), ${frames.length} cells in ${grid.columns} columns, ${grid.width}×${grid.height}, drawn as the export draws them, read left to right, top to bottom.${notes ? ` ${notes}` : ""}\n${cells.join("\n")}` },
            { type: "image" as const, data: sheet.jpeg.toString("base64"), mimeType: "image/jpeg" },
          ],
        };
      });

    // media_analyze (D66): starts (or joins) the analysis jobs, waits up to ANALYZE_WAIT_MS for them,
    // and returns the results, or "running" with progress so the agent asks again. A cached
    // result comes back at once without ffmpeg. Stopping the turn doesn't stop the jobs: their
    // results land in the cache for the next ask.
    const mediaAnalyze = (v: ProjectView, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const project = v.session.project;
        if (typeof args.media !== "string") return textResult("Pass media: a media id from project_read.", true);
        const m = project.media.find((x) => x.id === args.media);
        if (!m) return textResult(`There's no media "${args.media}". project_read lists the media ids: ${project.media.map((x) => x.id).join(", ") || "(none yet)"}.`, true);
        const parsed = parseAnalyzers(args.analyzers);
        if ("refused" in parsed) return textResult(parsed.refused, true);
        const range = args.range as { start?: unknown; end?: unknown } | undefined;
        if (range !== undefined && (typeof range !== "object" || !Number.isInteger(range.start) || !Number.isInteger(range.end) || (range.start as number) < 0 || (range.end as number) <= (range.start as number))) {
          return textResult("range must be { start, end } in whole project frames of the media, start from 0 and before end.", true);
        }
        const fps = project.canvas.fps;
        const length = m.probe?.frames;
        const target = targetOf(v.dir, m, fps);
        const waitMs = analyzeWaitMs();
        const results = yield* requestAndWait(parsed.analyzers.map((analyzer) => ({ target, analyzer })));
        const frames = framesFor(fps, length);
        const out: Record<string, unknown> = { media: m.id };
        let pending = false;
        for (const { analyzer, jobId, outcome } of results) {
          if (!outcome) {
            pending = true;
            out[analyzer] = pendingOut(jobId);
            continue;
          }
          if (outcome.state === "failed") out[analyzer] = { state: "failed", error: outcome.error };
          else if (outcome.state === "cancelled") out[analyzer] = { state: "cancelled", note: cancelledNote };
          else if (analyzer === "video") out[analyzer] = videoOut(outcome.result as VideoResult, outcome.cached, frames, range as { start: number; end: number } | undefined, fps);
          else if (analyzer === "beats") out[analyzer] = beatsOut(outcome.result as BeatsResult, outcome.cached, frames, range as { start: number; end: number } | undefined, fps);
          else if (analyzer === "transcript") out[analyzer] = transcriptSummary(outcome.result as TranscriptResult, outcome.cached, yield* Effect.promise(() => silencesOf(target, false)));
          else out[analyzer] = loudnessOut(outcome.result as LoudnessResult, outcome.cached, frames, range as { start: number; end: number } | undefined);
        }
        // Finished results keep their explanation even while another analyzer is still going.
        const finished = new Set(results.filter((x) => x.outcome?.state === "done").map((x) => x.analyzer));
        const notes: Array<string> = [];
        if (pending) notes.push(`Still analysing after ${Math.round(waitMs / 1000)} s. Call media_analyze again with the same arguments to get the rest; it joins the running job (finished results come from the cache).`);
        if (finished.has("loudness"))
          notes.push(
            "loudness: silences are where the sound stays below thresholdDb for at least minSeconds. start and end are project frames of the media (use them as in): start is the first silent frame, end the frame after the last, both inside the silence; startSeconds and endSeconds are media time. integratedLufs is the whole file's loudness (EBU R128; about −14 LUFS is usual for online video), loudnessRangeLu how much it varies, truePeakDbtp its loudest peak.",
          );
        if (finished.has("video")) notes.push(`video: ${VIDEO_NOTE}`);
        if (finished.has("beats")) notes.push(`beats: ${BEATS_NOTE}`);
        if (finished.has("transcript")) notes.push("transcript: transcribed on this Mac (whisper.cpp). This is a summary; transcript_read gives the words with their frames, fillers and pauses.");
        if (notes.length) out.note = notes.join(" ");
        return textResult(out);
      });

    // transcript_read (D68): starts (or joins) the transcript job like media_analyze (the first one
    // may download the speech model first), then the words in project frames of the media, paged.
    const transcriptRead = (v: ProjectView, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const project = v.session.project;
        if (typeof args.media !== "string") return textResult("Pass media: a media id from project_read.", true);
        const m = project.media.find((x) => x.id === args.media);
        if (!m) return textResult(`There's no media "${args.media}". project_read lists the media ids: ${project.media.map((x) => x.id).join(", ") || "(none yet)"}.`, true);
        const range = args.range as { start?: unknown; end?: unknown } | undefined;
        if (range !== undefined && (typeof range !== "object" || range === null || !Number.isInteger(range.start) || !Number.isInteger(range.end) || (range.start as number) < 0 || (range.end as number) <= (range.start as number))) {
          return textResult("range must be { start, end } in whole project frames of the media, start from 0 and before end.", true);
        }
        if (args.format !== undefined && args.format !== "text" && args.format !== "words") return textResult('format must be "text" (lines, the default) or "words" (each word with its frames).', true);
        if (args.from !== undefined && (!Number.isInteger(args.from) || (args.from as number) < 0)) return textResult("from must be a word index (a whole number from 0), as next.from gave it.", true);
        if (args.language !== undefined && !isLanguage(args.language)) return textResult('language must be a language code like "en" or "pl", or "auto" (detect it).', true);
        if (m.kind === "image") return textResult(`${m.id} is a still image: there's no sound to transcribe.`, true);
        const fps = project.canvas.fps;
        const target = targetOf(v.dir, m, fps);
        const language = args.language as string | undefined;
        const [answer] = yield* requestAndWait([{ target, analyzer: "transcript", options: { language } }]);
        const { outcome, jobId } = answer!;
        if (!outcome) {
          const p = pendingOut(jobId);
          const what = "stage" in p && p.stage ? "is downloading the speech model (once, then it's kept)" : p.state === "queued" ? "is waiting its turn" : "is still transcribing";
          return textResult({ media: m.id, transcript: p, note: `The transcript ${what} after ${Math.round(analyzeWaitMs() / 1000)} s. Call transcript_read again with the same arguments; it joins the running job.` });
        }
        if (outcome.state === "failed") return textResult({ media: m.id, transcript: { state: "failed", error: outcome.error } }, true);
        if (outcome.state === "cancelled") return textResult({ media: m.id, transcript: { state: "cancelled", note: cancelledNote } }, true);
        const result = outcome.result as TranscriptResult;
        const { silences, envelope } = yield* Effect.promise(() => silencesOf(target, false));
        const out = transcriptOut(result, {
          cached: outcome.cached,
          fps,
          length: m.probe?.frames,
          range: range as { start: number; end: number } | undefined,
          ...(args.from !== undefined ? { from: args.from as number } : {}),
          format: (args.format as "text" | "words" | undefined) ?? "text",
          silences,
          envelope,
        });
        return textResult({ media: m.id, ...out, note: [("note" in out && typeof out.note === "string") ? out.note : "", result.hasAudio ? TRANSCRIPT_NOTE : ""].filter(Boolean).join(" ") });
      });

    // transcript_edit (D69): cut words (w12–w20 ranges), pauses and/or hesitation fillers of a media
    // file out of the main track with core planTextCut (the Transcript panel's planner), as one
    // agent edit on the turn (Undo turn reverts it). Gets the transcript like transcript_read (it
    // may have to be made first); dryRun answers with the plan and applies nothing.
    const transcriptEdit = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const project = v.session.project;
        const fps = project.canvas.fps;
        let mediaId = args.media;
        if (mediaId === undefined) {
          const heard = [...new Set(project.tracks.filter((t) => t.role === "main").flatMap((t) => t.items.filter((i) => i.type === "clip" && i.media).map((i) => i.media!)))].filter((id) => {
            const m = project.media.find((x) => x.id === id);
            return m && m.kind !== "image" && m.probe?.hasAudio !== false;
          });
          if (heard.length !== 1) return textResult(heard.length ? `Several media with sound are on the main track (${heard.join(", ")}): pass media.` : "No clip with sound is on the main track. Pass media, or put the talk on the timeline first.", true);
          mediaId = heard[0];
        }
        if (typeof mediaId !== "string") return textResult("media must be a media id from project_read.", true);
        const m = project.media.find((x) => x.id === mediaId);
        if (!m) return textResult(`There's no media "${mediaId}". project_read lists the media ids: ${project.media.map((x) => x.id).join(", ") || "(none yet)"}.`, true);
        if (m.kind === "image") return textResult(`${m.id} is a still image: there's no speech to cut.`, true);
        const word = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : typeof value === "string" && /^w?\d+$/.test(value) ? Number(value.replace(/^w/, "")) : undefined);
        const request: { remove?: Array<{ from: number; to: number }>; pauses?: { min: number }; fillers?: boolean } = {};
        if (args.remove !== undefined) {
          if (!Array.isArray(args.remove) || !args.remove.length) return textResult('remove must be a list of word ranges like {"from":"w12","to":"w20"} (word ids from transcript_read).', true);
          const ranges: Array<{ from: number; to: number }> = [];
          for (const x of args.remove as ReadonlyArray<unknown>) {
            const range = (x && typeof x === "object" ? x : {}) as { from?: unknown; to?: unknown };
            const from = word(range.from);
            const to = range.to === undefined ? from : word(range.to);
            if (from === undefined || to === undefined) return textResult(`Each remove entry needs from (and optionally to) as word ids like "w12" from transcript_read; got ${JSON.stringify(x)}.`, true);
            ranges.push({ from, to });
          }
          request.remove = ranges;
        }
        if (args.pauses !== undefined) {
          const raw = args.pauses === true ? {} : args.pauses;
          const min = raw && typeof raw === "object" ? ((raw as { min?: unknown }).min ?? DEFAULT_PAUSE_MIN_S) : undefined;
          if (typeof min !== "number" || !Number.isFinite(min) || min < 0.1 || min > 60) return textResult(`pauses must be {"min": seconds} (0.1 to 60; ${DEFAULT_PAUSE_MIN_S} if left out).`, true);
          request.pauses = { min };
        }
        if (args.fillers !== undefined && typeof args.fillers !== "boolean") return textResult("fillers must be true or false.", true);
        if (args.fillers === true) request.fillers = true;
        if (args.dryRun !== undefined && typeof args.dryRun !== "boolean") return textResult("dryRun must be true or false.", true);
        if (!request.remove && !request.pauses && !request.fillers) return textResult("Say what to cut: remove (word ranges), pauses ({min} seconds) and/or fillers: true.", true);
        const target = targetOf(v.dir, m, fps);
        const [answer] = yield* requestAndWait([{ target, analyzer: "transcript" }]);
        const { outcome, jobId } = answer!;
        if (!outcome) {
          const p = pendingOut(jobId);
          return textResult({ media: m.id, transcript: p, note: `There's no transcript yet and it's still being made after ${Math.round(analyzeWaitMs() / 1000)} s. Call transcript_edit again with the same arguments (it joins the running job), or transcript_read to follow it.` });
        }
        if (outcome.state === "failed") return textResult({ media: m.id, transcript: { state: "failed", error: outcome.error } }, true);
        if (outcome.state === "cancelled") return textResult({ media: m.id, transcript: { state: "cancelled", note: cancelledNote } }, true);
        const result = outcome.result as TranscriptResult;
        if (!result.hasAudio || !result.words?.length) return textResult(`${m.id} has ${result.hasAudio ? "no speech in its transcript" : "no sound"}, so there's nothing to cut by text.`, true);
        const { silences, envelope } = yield* Effect.promise(() => silencesOf(target));
        // The wait can be long: plan on the project as it is now, not as it was when the call came in.
        const fresh = view();
        if (!fresh || fresh.openId !== r.openId) return textResult("The project was closed.", true);
        if (!fresh.session.project.media.some((x) => x.id === m.id)) return textResult(`${m.id} isn't in the project any more.`, true);
        const plan = planTextCut(fresh.session.project, m.id, { words: result.words, language: result.language, seconds: result.seconds, segments: result.segments }, { ...request, silences, envelope } as TextCutRequest);
        if ("problem" in plan) return textResult(plan.problem, true);
        const secs = (frames: number) => Number((frames / fps).toFixed(2));
        const removed = plan.cuts.map((c) => ({
          ...(c.words ? { words: c.words[0] === c.words[1] ? `w${c.words[0]}` : `w${c.words[0]}–w${c.words[1]}` } : {}),
          text: c.text || "(pause)",
          ...(c.pauses ? { pauses: c.pauses } : {}),
          ...(c.fillers ? { fillers: c.fillers } : {}),
          mediaFrames: { start: c.from, end: c.to },
          frames: c.frames,
          seconds: secs(c.frames),
          clips: c.clips,
        }));
        const base = { media: m.id, removed, framesRemoved: plan.framesRemoved, secondsSaved: secs(plan.framesRemoved), ...(plan.notes.length ? { notes: plan.notes } : {}) };
        if (args.dryRun === true || !plan.ops.length) {
          return textResult({
            ...base,
            applied: false,
            revision: fresh.session.revision,
            duration: plan.after,
            seconds: secs(plan.after),
            durationBefore: plan.before,
            note: args.dryRun === true ? "A dry run: nothing changed. duration is what the edit would be; call again without dryRun to cut." : "Nothing to cut, so nothing changed.",
          });
        }
        const outcome2 = yield* projects.agentEdit(r.openId, { turnId: r.turn.id, ops: plan.ops, baseRevision: fresh.session.revision, summary: plan.summary }).pipe(
          Effect.map((snapshot) => ({ ok: true as const, snapshot })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        );
        if (!outcome2.ok) {
          const now = view();
          const userChanges = now ? noteFor(now, r.owner.agentSeen) : "";
          return textResult(
            {
              refused: outcome2.error.message,
              details: outcome2.error.details,
              revision: now?.session.revision,
              ...(userChanges ? { userChanges } : {}),
              note: "Nothing was cut. transcript_edit plans on the newest project each time, so call it again with the same arguments (the user's changes stay).",
            },
            true,
          );
        }
        const { snapshot } = outcome2;
        const lines = plan.cuts.map((c) => `${c.text ? `Cut "${c.text.length > 50 ? `${c.text.slice(0, 49)}…` : c.text}"` : `Removed ${c.pauses === 1 ? "a pause" : `${c.pauses} pauses`}`}${c.text && c.pauses ? ` and ${c.pauses === 1 ? "a pause" : `${c.pauses} pauses`}` : ""} (${(c.frames / fps).toFixed(1)} s${c.text && c.pauses ? " in all" : ""}) from ${c.clips.join(", ")}`);
        r.turn.edits.push({ revision: snapshot.revision, summary: plan.summary, lines });
        persist(r.owner);
        publish();
        // As media_import: the new revision is read; user edits since the agent's read come back with it.
        r.owner.seen.add(snapshot.revision);
        const now = view();
        const userChanges = now ? noteFor(now, r.owner.agentSeen) : "";
        const end = projectSummary(snapshot.project as Project, snapshot.revision).duration;
        return textResult({
          ...base,
          applied: true,
          revision: snapshot.revision,
          duration: end,
          seconds: secs(end),
          durationBefore: plan.before,
          note: "One edit on your turn (Undo turn reverts it). Word ids don't change (they belong to the media's transcript): transcript_read still lists every word of the file, including the ones now cut; project_read shows the clips that are left.",
          ...(userChanges ? { userChanges, userNote: "The user changed the project since your read; the revision above includes their changes. Keep them." } : {}),
        });
      });

    // captions_make (D82): captions from a media's transcript (core planMakeCaptions, the Transcript
    // panel's planner), the words stored where they're heard (the loudness pass, as transcript_edit),
    // as one agent edit on the turn. Gets the transcript like transcript_read.
    // subtitles_export (D105): the project's subtitles (captions cards and Subtitles tracks, merged
    // by time) as a .srt or .vtt file; next to project.json unless a path is given. No video.
    const subtitlesExport = (v: ProjectView, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        if (args.format !== undefined && args.format !== "srt" && args.format !== "vtt") return textResult('format must be "srt" or "vtt".', true);
        if (args.path !== undefined && (typeof args.path !== "string" || !args.path.trim())) return textResult("path must be an absolute path to a .srt or .vtt file.", true);
        if (args.overwrite !== undefined && typeof args.overwrite !== "boolean") return textResult("overwrite must be true or false.", true);
        const project = v.session.project as Project;
        let path = typeof args.path === "string" ? args.path.trim().replace(/^~(?=\/|$)/, homedir()) : undefined;
        if (path !== undefined && !isAbsolute(path)) return textResult(`"${args.path}" isn't an absolute path. Pass the full path, like /Users/you/Movies/talk.srt.`, true);
        const byName = path ? subtitleFormatOf(path) : undefined;
        if (path && !byName && /\.[^./]+$/.test(basename(path))) return textResult("path must end in .srt or .vtt.", true);
        if (byName && args.format !== undefined && byName !== args.format) return textResult(`path ends in .${byName} but format is ${String(args.format)}: pass one or make them agree.`, true);
        const format = byName ?? (args.format as "srt" | "vtt" | undefined) ?? "srt";
        if (!path) path = join(v.dir, `${project.name.replace(/[/:\\]/g, "-").trim() || "Subtitles"}.${format}`);
        else if (!byName) path = `${path}.${format}`;
        // The agent writes inside the project folder only (real paths, as graphic_write); elsewhere is the user's Export dialog.
        const target = path;
        const inside = yield* Effect.promise(async () => {
          const project = await realpath(v.dir).catch(() => v.dir);
          const real = await canonicalPath(target);
          return real.startsWith(`${project}${sep}`);
        });
        if (!inside) return textResult(`subtitles_export saves inside the project folder only (${v.dir}). Pass a path in it, or leave path out; the user can save the subtitles anywhere from the Export dialog (Subtitles only).`, true);
        const saved = yield* exporter.saveSubtitles({ output: path, overwrite: args.overwrite === true }).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        );
        if (!saved.ok) return textResult({ refused: saved.error.message, ...(saved.error.reason === "exists" ? { note: "Pass overwrite: true to replace it, or another path." } : {}) }, true);
        const fps = project.canvas.fps;
        const cues = subtitleCues(project);
        return textResult({
          path: saved.value.path,
          format: saved.value.format,
          cues: saved.value.cues,
          first: cues.slice(0, 5).map((c) => ({ from: c.from, to: c.to, time: `${subtitleTime(c.from, fps, format)} --> ${subtitleTime(c.to, fps, format)}`, text: c.text })),
          note: "Cue times are the edit's (after cuts), from the captions' cards and Subtitles tracks; the video export can also write this file next to the video or add a soft subtitle track.",
        });
      });

    const captionsMake = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const project = v.session.project;
        const fps = project.canvas.fps;
        let mediaId = args.media;
        if (mediaId === undefined) {
          const heard = [...new Set(project.tracks.filter((t) => t.role === "main").flatMap((t) => t.items.filter((i) => i.type === "clip" && i.media).map((i) => i.media!)))].filter((id) => {
            const m = project.media.find((x) => x.id === id);
            return m && m.kind !== "image" && m.probe?.hasAudio !== false;
          });
          if (heard.length !== 1) return textResult(heard.length ? `Several media with sound are on the main track (${heard.join(", ")}): pass media.` : "No clip with sound is on the main track. Put the talk on the timeline first.", true);
          mediaId = heard[0];
        }
        if (typeof mediaId !== "string") return textResult("media must be a media id from project_read.", true);
        const m = project.media.find((x) => x.id === mediaId);
        if (!m) return textResult(`There's no media "${mediaId}". project_read lists the media ids: ${project.media.map((x) => x.id).join(", ") || "(none yet)"}.`, true);
        if (m.kind === "image") return textResult(`${m.id} is a still image: there's no speech to caption.`, true);
        if (args.mode !== undefined && !["line", "word", "single"].includes(args.mode as string)) return textResult('mode must be "line", "word" or "single".', true);
        if (args.look !== undefined && typeof args.look !== "string") return textResult("look must be a text-style module id, e.g. text.caption.", true);
        if (args.lines !== undefined && (typeof args.lines !== "object" || args.lines === null || Array.isArray(args.lines))) return textResult("lines must be an object (maxChars, maxLines, maxSeconds, maxWords, pause).", true);
        if (args.hideFillers !== undefined && typeof args.hideFillers !== "boolean") return textResult("hideFillers must be true or false.", true);
        const target = targetOf(v.dir, m, fps);
        const [answer] = yield* requestAndWait([{ target, analyzer: "transcript" }]);
        const { outcome, jobId } = answer!;
        if (!outcome) {
          const p = pendingOut(jobId);
          return textResult({ media: m.id, transcript: p, note: `There's no transcript yet and it's still being made after ${Math.round(analyzeWaitMs() / 1000)} s. Call captions_make again with the same arguments (it joins the running job).` });
        }
        if (outcome.state === "failed") return textResult({ media: m.id, transcript: { state: "failed", error: outcome.error } }, true);
        if (outcome.state === "cancelled") return textResult({ media: m.id, transcript: { state: "cancelled", note: cancelledNote } }, true);
        const result = outcome.result as TranscriptResult;
        if (!result.hasAudio || !result.words?.length) return textResult(`${m.id} has ${result.hasAudio ? "no speech in its transcript" : "no sound"}, so there's nothing to caption.`, true);
        const { silences, envelope } = yield* Effect.promise(() => silencesOf(target));
        const fresh = view();
        if (!fresh || fresh.openId !== r.openId) return textResult("The project was closed.", true);
        const plan = planMakeCaptions(fresh.session.project, {
          media: m.id,
          transcript: { words: result.words, language: result.language, seconds: result.seconds, segments: result.segments },
          silences,
          envelope,
          ...(args.mode !== undefined ? { mode: args.mode as CaptionMode } : {}),
          ...(args.look !== undefined ? { look: args.look as string } : {}),
          ...(args.lines !== undefined ? { lines: args.lines as CaptionLines } : {}),
          ...(args.hideFillers !== undefined ? { hideFillers: args.hideFillers as boolean } : {}),
        });
        if ("problem" in plan) return textResult(plan.problem, true);
        const outcome2 = yield* projects.agentEdit(r.openId, { turnId: r.turn.id, ops: plan.ops, baseRevision: fresh.session.revision, summary: plan.summary }).pipe(
          Effect.map((snapshot) => ({ ok: true as const, snapshot })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        );
        if (!outcome2.ok) {
          const now = view();
          const userChanges = now ? noteFor(now, r.owner.agentSeen) : "";
          return textResult({ refused: outcome2.error.message, details: outcome2.error.details, revision: now?.session.revision, ...(userChanges ? { userChanges } : {}), note: "No captions were made. Call captions_make again (it plans on the newest project)." }, true);
        }
        const { snapshot } = outcome2;
        const saved = snapshot.project as Project;
        const item = saved.tracks.flatMap((t) => t.items).find((i) => i.id === plan.itemId)!;
        const cards = captionCardList(saved, item);
        const mode = item.mode ?? "line";
        r.turn.edits.push({ revision: snapshot.revision, summary: plan.summary, lines: [`${plan.remade ? "Remade" : "Made"} ${mode === "word" ? "word-by-word " : mode === "single" ? "one-word " : ""}captions of ${m.name} (${cards.length} card${cards.length === 1 ? "" : "s"}, ${plan.words} words) as ${plan.itemId}${plan.fixesDropped ? `; ${plan.fixesDropped} fix${plan.fixesDropped === 1 ? "" : "es"} dropped (the transcript changed)` : ""}`] });
        persist(r.owner);
        publish();
        r.owner.seen.add(snapshot.revision);
        const now = view();
        const userChanges = now ? noteFor(now, r.owner.agentSeen) : "";
        return textResult({
          media: m.id,
          item: plan.itemId,
          remade: plan.remade,
          ...(plan.fixesDropped ? { fixesDropped: plan.fixesDropped, fixesNote: "The transcript changed since the captions were made, so their word fixes and forced card starts were dropped: redo them with edit_captions." } : {}),
          mode,
          words: plan.words,
          cardCount: cards.length,
          cards: cards.slice(0, MAX_CAPTION_CARDS),
          revision: snapshot.revision,
          ...(cards.length ? {} : { notes: ["No speech of this media plays on the main track yet, so no card shows."] }),
          note: `One edit on your turn (Undo turn reverts it). Frames are the edit's. Fix words with timeline_edit {"op":"edit_captions","item":"${plan.itemId}","words":[{"word":"w12","text":"…"}]}; look at a card with render_frames.`,
          ...(userChanges ? { userChanges, userNote: "The user changed the project since your read; the revision above includes their changes. Keep them." } : {}),
        });
      });

    // media_rank (D67): the video analysis of several takes (run, joined or cached), ranked by
    // clean score (or one component), each with its best stretch inside one shot.
    const mediaRank = (v: ProjectView, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const project = v.session.project;
        const fps = project.canvas.fps;
        const by = (args.by ?? "clean") as RankBy;
        if (!RANK_BY.includes(by)) return textResult(`by must be one of ${RANK_BY.join(", ")}.`, true);
        const windowSeconds = args.window ?? DEFAULT_BEST_SECONDS;
        if (typeof windowSeconds !== "number" || !Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 600) return textResult("window must be a whole number of seconds, 1 to 600.", true);
        if (args.media !== undefined && args.folder !== undefined) return textResult("Pass media or folder, not both: media ranks those ids, folder the project's media from that folder.", true);
        const skipped: Array<{ media: string; reason: string }> = [];
        let chosen: Array<(typeof project.media)[number]>;
        if (args.media !== undefined) {
          const ids = typeof args.media === "string" ? [args.media] : Array.isArray(args.media) ? args.media : null;
          if (!ids || !ids.length || !ids.every((x) => typeof x === "string")) return textResult("media must be a list of media ids from project_read.", true);
          const unknown = ids.filter((id) => !project.media.some((x) => x.id === id));
          if (unknown.length) return textResult(`There's no media ${unknown.map((u) => `"${u}"`).join(", ")}. project_read lists the media ids: ${project.media.map((x) => x.id).join(", ") || "(none yet)"}.`, true);
          chosen = [...new Set(ids as Array<string>)].map((id) => project.media.find((x) => x.id === id)!);
        } else if (args.folder !== undefined) {
          if (typeof args.folder !== "string" || !args.folder.trim()) return textResult("folder must be a folder's absolute path.", true);
          const raw = args.folder.trim().replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
          if (!isAbsolute(raw)) return textResult(`"${args.folder}" isn't an absolute path. Pass the full path of the folder the takes are in.`, true);
          const folder = yield* Effect.promise(() => realOr(raw, v.dir));
          const paths = yield* Effect.promise(() => Promise.all(project.media.map((x) => realOr(x.path, v.dir))));
          chosen = project.media.filter((_, i) => paths[i] === folder || paths[i]!.startsWith(folder + sep));
          if (!chosen.length) return textResult(`No media in this project is from ${raw}. Import the takes first (media_import with that folder), then rank them.`, true);
        } else {
          chosen = project.media.filter((x) => x.kind === "video");
          if (!chosen.length) return textResult("This project has no video yet. Import the takes first (media_import), then rank them.", true);
        }
        const video = chosen.filter((x) => {
          if (x.kind === "video") return true;
          skipped.push({ media: x.id, reason: x.kind === "audio" ? "A sound file, with no picture." : "A still image: there's no take to rank." });
          return false;
        });
        if (!video.length) return textResult({ ranked: [], skipped, note: "Nothing to rank: media_rank ranks video takes." }, true);
        if (video.length > MAX_RANKED) return textResult(`That's ${video.length} videos; media_rank ranks at most ${MAX_RANKED} per call. Pass media with fewer ids.`, true);
        const results = yield* requestAndWait(video.map((x) => ({ target: targetOf(v.dir, x, fps), analyzer: "video" as const })));
        const ranked: Array<{ value: number; out: Record<string, unknown> }> = [];
        const pending: Array<Record<string, unknown>> = [];
        const failed: Array<{ media: string; error: string }> = [];
        for (const [i, { jobId, outcome }] of results.entries()) {
          const x = video[i]!;
          if (!outcome) pending.push({ media: x.id, ...pendingOut(jobId) });
          else if (outcome.state === "failed") failed.push({ media: x.id, error: outcome.error });
          else if (outcome.state === "cancelled") failed.push({ media: x.id, error: cancelledNote });
          else {
            const result = outcome.result as VideoResult;
            if (!result.hasVideo) {
              skipped.push({ media: x.id, reason: "ffmpeg found no picture in it." });
              continue;
            }
            const e = rankEntry(x, result, outcome.cached, framesFor(fps, x.probe?.frames), windowSeconds);
            ranked.push({ value: rankValue(e.scores, e.best, by), out: e.out });
          }
        }
        ranked.sort((a, b) => b.value - a.value);
        return textResult({
          by,
          ranked: ranked.map((r, i) => ({ rank: i + 1, ...r.out })),
          ...(pending.length ? { pending } : {}),
          ...(failed.length ? { failed } : {}),
          ...(skipped.length ? { skipped } : {}),
          note: [
            pending.length ? `${pending.length} take${pending.length === 1 ? " is" : "s are"} still being analysed after ${Math.round(analyzeWaitMs() / 1000)} s and aren't ranked yet: call media_rank again with the same arguments (it joins the running jobs; finished ones come from the cache).` : "",
            `Ranked by ${by === "clean" ? "cleanScore (the whole take)" : by === "best" ? "the best stretch's cleanScore" : by}, best first. best is the cleanest ${windowSeconds} s inside one shot (shorter when no shot is that long): start and end are project frames of the media, usable as in and in + duration. ${VIDEO_NOTE}`,
          ]
            .filter(Boolean)
            .join(" "),
        });
      });

    // ui_show (D65): the renderer moves the playhead, selects and opens a panel once per request.
    /**
     * graphic_write (D78): a graphic's HTML into the project's graphics/ folder. A new file only
     * (earlier revisions keep pointing at the files they used), a plain name, at most
     * MAX_GRAPHIC_BYTES, inside the project by realpath (a symlinked graphics/ folder pointing out is refused).
     */
    const graphicWrite = (v: ProjectView, args: Record<string, unknown>) =>
      Effect.promise(async (): Promise<McpResult> => {
        const name = args.name;
        const html = args.html;
        const src = `graphics/${String(name)}`;
        if (typeof name !== "string" || !GRAPHIC_SRC.test(src)) return textResult("name must be a plain file name ending in .html, e.g. counter.html (letters, digits, dots, dashes, underscores).", true);
        if (typeof html !== "string" || !html.trim()) return textResult("html must be the graphic's HTML: markup, <style> and a <script> defining render(t, info).", true);
        if (Buffer.byteLength(html) > MAX_GRAPHIC_BYTES) return textResult(`The HTML is over ${MAX_GRAPHIC_BYTES / 1024} KB; keep a graphic small (no embedded videos or large images).`, true);
        const folder = join(v.dir, "graphics");
        try {
          await mkdir(folder, { recursive: true });
          const real = await realpath(folder);
          const project = await realpath(v.dir);
          if (!real.startsWith(`${project}${sep}`)) return textResult("The project's graphics folder points outside the project, so nothing was written.", true);
          await writeFile(join(real, name), html, { flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return textResult(`${src} already exists, and graphics are never overwritten (earlier revisions use them). Write the new version under another name, e.g. ${name.replace(/(\.html)$/, "-2$1")}, and point the item's src at it.`, true);
          return textResult(`Couldn't write ${src}: ${(error as Error).message}`, true);
        }
        const hasRender = /\brender\s*(=|\(|:)|function\s+render\b/.test(html);
        return textResult({ ok: true, src, bytes: Buffer.byteLength(html), ...(hasRender ? {} : { note: "No render function found: define window.render = (t, info) => { ... } (or function render(t, info)) so the graphic can move; without it the page is drawn as is." }), next: `Insert it with timeline_edit: {"op":"insert_item","track":"<a video track>","item":{"id":"…","type":"graphic","src":"${src}","start":0,"duration":90}}` });
      });

    /**
     * music_add (D91): a library track copied into the project's media/ (copyLibraryTrack) and
     * added as audio media, an edit on the turn (Undo turn removes the media; the copy stays, and a
     * later add reuses it). A track already in the project answers with its media id.
     */
    const musicAdd = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const track = typeof args.id === "string" ? musicTrack(args.id) : undefined;
        if (!track) return textResult(`id must be a library track id from music_list${typeof args.id === "string" ? ` ("${args.id}" isn't one)` : ""}.`, true);
        const fps = v.session.project.canvas.fps;
        const already = musicInProject(v.session.project, track);
        if (already) return textResult({ media: already.id, frames: already.probe?.frames, seconds: Number(((already.probe?.frames ?? 0) / fps).toFixed(2)), revision: v.session.revision, note: `${track.title} is already in the project as ${already.id}: put it on an audio track with timeline_edit.` });
        const copied = yield* Effect.promise(() => copyLibraryTrack(config.musicDir, v.dir, track.id));
        if ("problem" in copied) return textResult(copied.problem, true);
        const fresh = view();
        if (!fresh || fresh.openId !== r.openId) return textResult("The project was closed.", true);
        const media = musicMedia(track, copied.path, fps, projectIds(fresh.session.project));
        const summary = `Added ${track.title} from the music library`;
        const outcome = yield* projects.agentEdit(r.openId, { turnId: r.turn.id, ops: [{ op: "add_media", media }], baseRevision: fresh.session.revision, summary }).pipe(
          Effect.map((snapshot) => ({ ok: true as const, snapshot })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        );
        if (!outcome.ok) return textResult({ refused: outcome.error.message, details: outcome.error.details }, true);
        const { snapshot } = outcome;
        r.turn.edits.push({ revision: snapshot.revision, summary, lines: [describeOp({ op: "add_media", media }, snapshot.project as Project)] });
        persist(r.owner);
        publish();
        r.owner.seen.add(snapshot.revision);
        const now = view();
        const userChanges = now ? noteFor(now, r.owner.agentSeen) : "";
        const frames = media.probe!.frames!;
        return textResult({
          media: media.id,
          path: media.path,
          frames,
          seconds: track.seconds,
          revision: snapshot.revision,
          next: `Put it on an audio track that is free for that stretch with timeline_edit (when a voice is on the only audio track, add one first: {"op":"add_track","track":{"id":"music","kind":"audio","name":"Music"}}), e.g. {"op":"insert_item","track":"music","item":{"id":"music-1","type":"audio","media":"${media.id}","in":0,"start":0,"duration":<from start to the video's end, at most ${frames}>,"fadeIn":${fps},"fadeOut":${2 * fps}}}, then duck it under the voice.`,
          ...(userChanges ? { userChanges, userNote: "The user changed the project since your read; the revision above includes their changes. Keep them." } : {}),
        });
      });

    /**
     * library_search (D134): the online library (Openverse; Freesound with the user's key), CC0 and
     * CC BY only, or with source "included" the bundled sound effects. Same cache and limits as the
     * panel's searches.
     */
    const librarySearch = (args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const kind = args.kind === "sfx" ? "sfx" : args.kind === "music" ? "music" : undefined;
        if (!kind) return textResult('kind must be "music" or "sfx".', true);
        const query = typeof args.query === "string" ? args.query.trim() : "";
        const fps = view()?.session.project.canvas.fps ?? 30;
        if (args.source === "included") {
          if (kind !== "sfx") return textResult('The bundled music is music_list; source "included" is for sound effects.', true);
          const sfx = filterSfx({ query, category: typeof args.category === "string" ? args.category : undefined });
          return textResult({ sounds: sfx.map((s) => ({ id: `sfx:${s.id}`, title: s.title, category: s.category, seconds: s.seconds, frames: Math.round(s.seconds * fps), author: s.author, license: "CC0" })), note: "Bundled CC0 sounds (no credit needed). library_add copies one into the project." });
        }
        if (!query) return textResult("query must say what to search for, e.g. whoosh, bass boom, upbeat piano.", true);
        if (args.source !== undefined && args.source !== "openverse" && args.source !== "freesound") return textResult('source must be "openverse", "freesound" or "included".', true);
        const length = args.length === "short" || args.length === "medium" || args.length === "long" ? args.length : undefined;
        const outcome = yield* sounds
          .search({ kind, query, ...(args.source ? { source: args.source as "openverse" | "freesound" } : {}), ...(args.license === "cc0" ? { license: "cc0" as const } : {}), ...(length ? { length } : {}), ...(args.songs === true ? { songs: true } : {}), ...(typeof args.page === "number" ? { page: args.page } : {}) })
          .pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
          );
        if (!outcome.ok) return textResult(outcome.error.message, true);
        const { result } = outcome;
        if (result.limit) return textResult({ hits: [], limit: limitSentence(result.source, result.limit), note: "Use the bundled sounds meanwhile (music_list, or library_search with source included)." }, true);
        return textResult({
          source: result.source,
          total: result.total,
          page: result.page,
          pages: result.pages,
          hits: result.hits.map((h) => ({ id: hitKey(h), title: h.title, creator: h.creator, seconds: h.seconds, ...(h.seconds ? { frames: Math.round(h.seconds * fps) } : {}), license: h.license === "by" ? `CC BY ${h.licenseVersion}` : "CC0", tags: h.tags.slice(0, 6) })),
          note: "CC BY sounds need credit in the video's description (project_read lists credits). library_add downloads one into the project.",
        });
      });

    /** library_add (D134): a hit (or a bundled sound effect) downloaded into media/ and added as audio media with its credits, an edit on the turn. */
    const libraryAdd = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        if (!id) return textResult("id must be a library_search hit id (openverse:…, freesound:…) or a bundled sound (sfx:…).", true);
        const fps = v.session.project.canvas.fps;
        const already = libraryMediaOf(v.session.project, id);
        if (already) return textResult({ media: already.id, frames: already.probe?.frames, revision: v.session.revision, note: `It's already in the project as ${already.id}: put it on an audio track with timeline_edit.` });
        const added = yield* sounds.add(id, v.dir, r.abort.signal).pipe(
          Effect.map((a) => ({ ok: true as const, a })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        );
        if (!added.ok) return textResult(added.error.message, true);
        const fresh = view();
        if (!fresh || fresh.openId !== r.openId) return textResult("The project was closed.", true);
        const { a } = added;
        const media = { id: mediaIdFor(a.name, projectIds(fresh.session.project)), kind: "audio" as const, name: a.name, path: a.path, source: { ...a.source }, probe: { frames: Math.max(1, Math.floor(a.seconds * fps)), hasAudio: true } };
        const summary = `Added ${a.name} from the sound library`;
        const outcome = yield* projects.agentEdit(r.openId, { turnId: r.turn.id, ops: [{ op: "add_media", media }], baseRevision: fresh.session.revision, summary }).pipe(
          Effect.map((snapshot) => ({ ok: true as const, snapshot })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        );
        if (!outcome.ok) return textResult({ refused: outcome.error.message, details: outcome.error.details }, true);
        const { snapshot } = outcome;
        r.turn.edits.push({ revision: snapshot.revision, summary, lines: [describeOp({ op: "add_media", media } as Op, snapshot.project as Project)] });
        persist(r.owner);
        publish();
        r.owner.seen.add(snapshot.revision);
        return textResult({
          media: media.id,
          path: media.path,
          frames: media.probe.frames,
          seconds: a.seconds,
          license: a.source.license === "by" ? `CC BY ${a.source.licenseVersion}: credit "${a.source.title}" by ${a.source.creator} (project_read's credits has the line)` : "CC0",
          revision: snapshot.revision,
          next: `Put it on an audio track free at that moment with timeline_edit, e.g. {"op":"insert_item","track":"<audio track>","item":{"id":"sfx-1","type":"audio","media":"${media.id}","in":0,"start":<frame>,"duration":${media.probe.frames}}} (add a track first when none is free: {"op":"add_track","track":{"id":"sfx","kind":"audio","name":"Sound effects"}}).`,
        });
      });

    const uiShow = (r: Running, v: ProjectView, args: Record<string, unknown>): McpResult => {
      const project = v.session.project;
      const said: Array<string> = [];
      let frame: number | undefined;
      if (args.frame !== undefined) {
        if (!Number.isInteger(args.frame) || (args.frame as number) < 0) return textResult("frame must be a whole frame number from 0.", true);
        const { duration } = layout(project);
        const end = project.tracks.some((t) => t.items.length) ? duration : 0;
        frame = Math.min(args.frame as number, end);
        said.push(frame === args.frame ? `the playhead is at frame ${frame}` : `the project ends at frame ${end}, so the playhead went there`);
      }
      let select: string | undefined;
      if (args.select !== undefined) {
        const ids = Array.isArray(args.select) ? args.select : typeof args.select === "string" ? [args.select] : [];
        if (ids.length !== 1 || typeof ids[0] !== "string") return textResult("select takes one item id, e.g. [\"clip-1\"] (the editor selects one item at a time).", true);
        const id = ids[0];
        if (!project.tracks.some((t) => t.items.some((i) => i.id === id))) return textResult(`There's no timeline item "${id}". project_read lists the items.`, true);
        select = id;
        said.push(`${id} is selected`);
      }
      let panel: AgentUiPanel | undefined;
      if (args.panel !== undefined) {
        if (!(AGENT_UI_PANELS as ReadonlyArray<unknown>).includes(args.panel)) return textResult(`panel must be one of ${AGENT_UI_PANELS.join(", ")}.`, true);
        panel = args.panel as AgentUiPanel;
        said.push(`the ${panel} panel is open`);
      }
      if (!said.length) return textResult("Pass frame, select or panel.", true);
      r.owner.ui = { id: `${r.turn.id}-${++uiCount}`, revision: v.session.revision, ...(frame !== undefined ? { frame } : {}), ...(select ? { select } : {}), ...(panel ? { panel } : {}) };
      publish();
      return textResult(`Shown: ${said.join(", ")}.`);
    };

    /** Waits for the user's Allow / Don't on a card in the Agent tab; no answer in time or a stopped turn is no. */
    const askUser = (r: Running, text: string, estimate: number) =>
      Effect.promise(
        () =>
          new Promise<"allow" | "deny" | "timeout" | "stopped">((resolve) => {
            const ms = approvalMs();
            const card: AgentApproval = { id: randomUUID(), turnId: r.turn.id, text, estimate, until: new Date(Date.now() + ms).toISOString() };
            let settled = false;
            const answer = (a: "allow" | "deny" | "timeout" | "stopped") => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              r.abort.signal.removeEventListener("abort", onStop);
              if (approval?.card.id === card.id) approval = undefined;
              publish();
              resolve(a);
            };
            const timer = setTimeout(() => answer("timeout"), ms);
            const onStop = () => answer("stopped");
            if (r.abort.signal.aborted) return answer("stopped");
            r.abort.signal.addEventListener("abort", onStop, { once: true });
            approval?.answer("deny");
            approval = { card, answer };
            publish();
          }),
      );

    /**
     * generate_media (D99): a generator's result imported as media, an edit of this turn (Undo
     * turn removes it), its source {module, prompt, model}. Keyed generators bill the user's own
     * key: anything estimated over CONFIRM_OVER waits for the user's Allow on a card in the Agent
     * tab (the agent can't approve it itself); a turn spends at most TURN_CAP. The estimate is
     * reserved on the turn before the request (kept once a request went out, whatever happens
     * next; refunded only when nothing was sent) and shown on the turn card (D9).
     */
    const generateMedia = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const planned = yield* generator.plan(args);
        if ("_tag" in planned) return textResult(planned.message, true);
        const { spec, estimate, provider } = planned;
        if (provider && !(yield* keys.has(provider)))
          return textResult({ needsKey: provider, message: `${needsKeyLine(provider)}. Nothing was generated.`, next: `Tell the user it ${needsKeyLine(provider).toLowerCase()}: they add it in Settings › Keys (Uncut never asks for it in chat; don't ask them to paste it here). For a picture or a simple animation you can draw it yourself with generate.svg.` }, true);
        const dollars = (n: number) => `$${n.toFixed(2)}`;
        const overCap = () => estimate > 0 && (r.turn.spend ?? 0) + estimate > TURN_CAP;
        const capNote = () => `That would take this turn past ${dollars(TURN_CAP)} of estimated spend (${dollars(r.turn.spend ?? 0)} so far). Nothing was generated; the user can generate more from the Generate tab.`;
        if (overCap()) return textResult(capNote(), true);
        if (estimate > CONFIRM_OVER) {
          const what = spec.kind === "video" ? `a ${spec.seconds ?? 4} s ${spec.generator === "generate.veo" ? "Veo " : ""}video` : spec.kind === "audio" ? "a sound" : "a picture";
          const answer = yield* askUser(r, `Generate ${what}, about ${dollars(estimate)} on your ${providerName(provider!)} key`, estimate);
          if (answer !== "allow")
            return textResult({ approved: false, message: answer === "deny" ? `The user didn't allow it (about ${dollars(estimate)} on their ${providerName(provider!)} key). Nothing was generated.` : answer === "timeout" ? "Nobody answered the approval in the Agent tab within 2 minutes, so nothing was generated." : "The turn was stopped, so nothing was generated.", next: "Don't try again in this turn unless the user asks; suggest something cheaper or generate.svg if it fits." }, true);
        }
        // Check and reserve with nothing in between (no await): two calls can't both pass the cap.
        if (overCap()) return textResult(capNote(), true);
        const before = r.turn.spend ?? 0;
        if (estimate > 0) r.turn.spend = Number((before + estimate).toFixed(3));
        let sent = false;
        const outcome = yield* Effect.uninterruptible(
          generator.produce(spec, { openId: r.openId, dir: v.dir, turnId: r.turn.id, signal: r.abort.signal, sent: () => (sent = true) }).pipe(
            Effect.map((p) => ({ ok: true as const, p })),
            Effect.catch((e) => Effect.succeed({ ok: false as const, message: e.message })),
          ),
        );
        if (!outcome.ok) {
          // Nothing went to the provider: nothing billed. Once a request went out it may have been.
          if (!sent && estimate > 0) r.turn.spend = Number(Math.max(0, (r.turn.spend ?? 0) - estimate).toFixed(3)) || undefined;
          persist(r.owner);
          publish();
          return textResult(`Nothing was generated: ${outcome.message}`, true);
        }
        const { entry, result, cost, model } = outcome.p;
        // The reply's own price replaces the reservation.
        if (estimate > 0 || cost > 0) r.turn.spend = Number(Math.max(0, (r.turn.spend ?? 0) - estimate + cost).toFixed(3)) || undefined;
        const snapshot = result.snapshot;
        if (snapshot) {
          r.turn.edits.push({ revision: snapshot.revision, summary: `Generated ${entry.name}`, lines: [describeOp({ op: "add_media", media: entry } as Op, snapshot.project as Project)] });
          r.owner.seen.add(snapshot.revision);
        }
        persist(r.owner);
        publish();
        const fps = ((snapshot?.project ?? v.session.project) as Project).canvas.fps;
        return textResult({
          ...entryInfo(entry, fps),
          ...(snapshot ? { revision: snapshot.revision } : {}),
          model,
          ...(cost > 0 ? { estimatedCost: Number(cost.toFixed(3)), turnSpend: r.turn.spend } : { estimatedCost: 0 }),
          note: `In Media › Generated with its prompt (an edit of this turn: Undo turn removes it). Place it with timeline_edit${entry.kind === "audio" ? " on an audio track" : " (a clip on the main track, or with a start on a video track above it)"}.`,
        });
      });

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
          case "modules_list": {
            const kind = typeof args.kind === "string" ? args.kind : undefined;
            // The built-in modules, then the plugins (D97) with their source, approval and warnings.
            return textResult([...modulesList(format.modules, kind), ...(yield* plugins.modules(kind))]);
          }
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
            // Frames past the last one are drawn as the last one: say so, not silently.
            const clamped = rendered.list.flatMap((r, i) => (r.frame !== frames[i] ? [`frame ${frames[i]} is past the last frame, so frame ${r.frame} is shown for it`] : []));
            // What a frame leaves out (a graphic it couldn't read, D78), once each.
            clamped.push(...new Set(rendered.list.flatMap((r) => r.notes ?? [])));
            return {
              content: [
                { type: "text", text: `Frame${rendered.list.length === 1 ? "" : "s"} ${rendered.list.map((r) => r.frame).join(", ")} of the edit (revision ${v.session.revision}) at ${Math.round(width / 2) * 2}×${height}, drawn as the export draws them, in that order.${clamped.length ? ` Note: ${clamped.join("; ")}.` : ""}` },
                ...rendered.list.map((r) => ({ type: "image" as const, data: r.jpeg.toString("base64"), mimeType: "image/jpeg" })),
              ],
            };
          }
          case "media_import":
            return yield* mediaImport(r, v, args);
          case "contact_sheet":
            return yield* contactSheet(v, args);
          case "ui_show":
            return uiShow(r, v, args);
          case "project_check": {
            const rules = Array.isArray(args.rules) ? args.rules.filter((x): x is string => typeof x === "string") : undefined;
            if (args.severity !== undefined && args.severity !== "warn" && args.severity !== "info") return textResult('severity must be "warn" or "info".', true);
            // Its fixes are planned on this revision, so it may be passed back as baseRevision (the
            // user's edits stay news for the next note: agentSeen doesn't move).
            r.owner.seen.add(v.session.revision);
            // The allowed plugins' rules too (D103): data rules run here, process plugins are asked (5 s each).
            const contributed = yield* plugins.contributions;
            const asked = yield* plugins.processChecks(v.session.project, v.dir);
            return textResult(checksOut(v.session.project as Project, v.session.revision, { rules, severity: args.severity as string | undefined }, { rules: pluginCheckRules(contributed.rules), found: asked.checks, notes: asked.notes }));
          }
          case "music_list": {
            if (args.tempo !== undefined && !(MUSIC_TEMPOS as ReadonlyArray<unknown>).includes(args.tempo)) return textResult(`tempo must be one of ${MUSIC_TEMPOS.join(", ")}.`, true);
            return textResult(musicOut(v.session.project as Project, { mood: typeof args.mood === "string" ? args.mood : undefined, tempo: args.tempo as MusicTempo | undefined, query: typeof args.query === "string" ? args.query : undefined }));
          }
          case "music_add":
            return yield* musicAdd(r, v, args);
          case "library_search":
            return yield* librarySearch(args);
          case "library_add":
            return yield* libraryAdd(r, v, args);
          case "graphic_write":
            return yield* graphicWrite(v, args);
          case "generate_media":
            return yield* generateMedia(r, v, args);
          case "media_analyze":
            return yield* mediaAnalyze(v, args);
          case "media_rank":
            return yield* mediaRank(v, args);
          case "transcript_read":
            return yield* transcriptRead(v, args);
          case "transcript_edit":
            return yield* transcriptEdit(r, v, args);
          case "captions_make":
            return yield* captionsMake(r, v, args);
          case "subtitles_export":
            return yield* subtitlesExport(v, args);
          case "timeline_edit": {
            const { baseRevision, summary } = args;
            if (typeof baseRevision !== "number" || !Number.isInteger(baseRevision)) return textResult("Pass baseRevision: the revision from your last project_read.", true);
            if (!Array.isArray(args.ops)) return textResult("ops must be a list of edit ops.", true);
            // insert_device_frame (D76) becomes the edit ops that make it (tracks, the screen clip, the frame).
            const expanded = expandDeviceFrames(v.session.project as Project, args.ops);
            if ("problem" in expanded) return textResult({ refused: expanded.problem, revision: v.session.revision }, true);
            // insert_text (D80) becomes the inserts (and text tracks) of a text in a look.
            const pluginLooks = Object.fromEntries((yield* plugins.contributions).looks.map((l) => [l.id, l]));
            const texts = expandTextLooks(v.session.project as Project, expanded.ops, pluginLooks);
            if ("problem" in texts) return textResult({ refused: texts.problem, revision: v.session.revision }, true);
            // edit_captions (D82) becomes the update_item of the captions it changes.
            const captions = expandCaptionEdits(v.session.project as Project, texts.ops);
            if ("problem" in captions) return textResult({ refused: captions.problem, revision: v.session.revision }, true);
            // detach_audio (D123) and set_speed (D125) become the item ops that do them.
            const arranged = expandArrangeOps(v.session.project as Project, captions.ops);
            if ("problem" in arranged) return textResult({ refused: arranged.problem, revision: v.session.revision }, true);
            const ops = arranged.ops;
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
            // Ducking (D85) needs its key media's loudness: a mixer change starts the analysis
            // where it's missing (waits up to SILENCES_WAIT_MS, as transcript_edit) and says so.
            const ducking = (ops as ReadonlyArray<Op>).some((op) => op.op === "update_track" && "mixer" in op.set) ? yield* Effect.promise(() => duckAnalysis(v.dir, project)) : undefined;
            return textResult({
              ok: true,
              revision: snapshot.revision,
              duration: end,
              seconds: Number((end / project.canvas.fps).toFixed(2)),
              ...(ducking ? { ducking } : {}),
              ...(userChanges ? { userChanges, note: "The user changed the project since your read. project_read before your next edit." } : {}),
            });
          }
          default: {
            // A plugin's tool (D97): forwarded to its process; it returns data, never edits.
            const result = yield* plugins.call(name, args, r.abort.signal, v.dir);
            if (!result) return textResult(`Unknown tool ${name}`, true);
            const { declared, structured: _structured, plugin, ...out } = result;
            if (!declared || out.isError) return out;
            // ...except what it declares for Uncut (D98): a recording to import, a re-shot take to
            // swap in. Uncut does that as an edit of this turn (Undo turn takes it back).
            const applied = yield* Effect.uninterruptible(applyDeclared({ declared, plugin, openId: r.openId, dir: v.dir, turnId: r.turn.id, media, analysis }));
            if (!applied) return out;
            if ("problem" in applied) return { content: [...out.content, { type: "text" as const, text: applied.problem }], isError: true };
            const snapshot = applied.result.snapshot;
            if (snapshot) {
              const project = snapshot.project as Project;
              const lines =
                applied.kind === "imported"
                  ? applied.result.entries.map((entry) => describeOp({ op: "add_media", media: entry } as Op, project))
                  : [...(applied.result.ops as ReadonlyArray<Op>).map((op) => describeOp(op, project)), ...applied.result.warnings];
              const summary = applied.kind === "imported" ? `Recorded ${applied.result.entries[0]?.name ?? "a take"}` : `Re-shot ${applied.result.entry.name}`;
              r.turn.edits.push({ revision: snapshot.revision, summary, lines });
              persist(r.owner);
              publish();
              r.owner.seen.add(snapshot.revision);
            }
            const fps = ((snapshot?.project ?? v.session.project) as Project).canvas.fps;
            return { ...out, content: [...out.content, { type: "text" as const, text: JSON.stringify(appliedNote(applied, fps), null, 1) }] };
          }
        }
      });

    // ---- running claude ----

    const finish = (r: Running, patch: Partial<StoredTurn>) => {
      if (r.turn.status !== "running") return;
      r.abort.abort();
      clearTimeout(r.killTimer);
      Object.assign(r.turn, patch, { finishedAt: new Date().toISOString() });
      if (r.turn.seconds === undefined) r.turn.seconds = Math.round((Date.now() - Date.parse(r.turn.startedAt)) / 100) / 10;
      const ok = patch.status === "done";
      for (const item of r.turn.items) if (item.status === "running") item.status = ok ? "done" : "error";
      const now = view();
      if (now && now.openId === r.openId) r.owner.bounds.set(r.turn.id, { ...r.owner.bounds.get(r.turn.id), end: now.session.revision });
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
      const mcpEntry = process.env.UNCUT_MCP_ENTRY || besideServer("./mcp.mjs");
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
              r.turn.items.push({ kind: "step", tool, text: stepLabel(tool, c.input, plugins.owner(tool)?.name), status: "running" });
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
          frame !== undefined ? playheadLine(project, frame) : "",
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
        owner.bounds.set(turn.id, { start: v.session.revision });
        const r: Running = {
          turn,
          owner,
          openId: owner.openId,
          token: randomBytes(24).toString("base64url"),
          child: undefined,
          mcpDir,
          abort: new AbortController(),
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
      approve: (id, allow) =>
        Effect.sync(() => {
          if (approval?.card.id === id) approval.answer(allow ? "allow" : "deny");
        }),
      undoTurn: (turnId) =>
        Effect.gen(function* () {
          const owner = yield* ensureLoaded;
          if (!owner) return yield* new AgentError({ reason: "no-project", message: "Open a project first." });
          if (running) return yield* new AgentError({ reason: "busy", message: "Wait for the agent to finish, or stop it, before undoing a turn." });
          const turn = owner.turns.find((t) => t.id === turnId);
          if (!turn) return yield* new AgentError({ reason: "unknown-turn", message: "That turn isn't in this project's history." });
          // Partly beyond what history.db keeps (or not in the history at all): say why, change nothing.
          const state = undoState(turn, view(), owner.openId, format.validate);
          if (state.state === "unavailable") return yield* new AgentError({ reason: "failed", message: `This turn can't be undone. ${state.reason}` });
          const label = `Undid your turn "${turn.prompt.length > 80 ? `${turn.prompt.slice(0, 77)}...` : turn.prompt}"`;
          const snapshot = yield* projects.undoTurn(owner.openId, turnId, label);
          turn.undoneAt = new Date().toISOString();
          persist(owner);
          publish();
          return snapshot;
        }),
      // The built-in tools, then the plugins' (D97; the folders are scanned again for each turn's list).
      tools: (token) =>
        Effect.suspend(() => {
          if (!tokenOk(token, running)) return Effect.succeed(undefined);
          return Effect.andThen(plugins.refresh, Effect.map(plugins.tools, (extra) => [...mcpTools(), ...extra]));
        }),
      authorized: (token) => Effect.sync(() => tokenOk(token, running)),
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
