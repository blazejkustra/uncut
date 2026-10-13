// App state and the actions that change it. This module owns the server connection; the
// components only read state (useApp) and call actions.
//
// The open project comes from the server's project.subscribe stream, which is ordered and
// re-sent in full on every reconnect, so the screen always ends up showing what the server
// has. Call results are applied too (for snappiness) but never over a newer revision.
import { GRAPHIC_PATH, MEDIA_FILE_PATH, MUSIC_FILE_PATH, THUMB_PATH, TOKEN_QUERY_PARAM, WAVEFORM_PATH, type AgentState, type AnalysisJob, type AgentUi, type AgentUiPanel, type ExportJob, type HistoryState, type ExportLoudness, type ExportQuality, type ImportJob, type MediaImportResult, type ProjectSnapshot, type RecentProject, type ServerConnection, type PluginInfo, type CaptureState, type GenerateJob, type GenerateKind, type GeneratorInfo, type KeyInfo, type KeyProvider, type ServerHello, type SetupCheck, type TranscriptionState } from "@uncut/contracts";
import { useSyncExternalStore } from "react";

import { bridge, type AppInfo, type MenuCommand } from "./bridge.ts";
import { connect, isTransportError, type CallError, type Connection, type Result } from "./connection.ts";
import type { Canvas } from "./format.ts";
import { getPlayback, playback } from "../preview/playback.ts";
import { draftOf, findItem, nearestCut, planDelete, planSetTransition, planSplit, planTrackFlag, type Plan, type TrackFlag } from "../timeline/edit.ts";
import { musicInProject, musicTrack } from "@uncut/core/music";
import { planDisableCheck, projectChecks, type Check } from "@uncut/core/checks";
import { layoutOf, planAddAtPlayhead, planAddMedia, planAddMusic, planAddText, type Planned, type ProjectModel, type TextPreset } from "./project.ts";
import { planAddBackground, type BackgroundProps } from "../preview/text.ts";
import { planAddComponent } from "../preview/components.ts";
import { planRemoveGainKey } from "../audio/sound.ts";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "server-exited" | "failed";

export type { MediaItem } from "./project.ts";
export type Project = ProjectModel;

/** A message in the editor's banner. `transport` ones go away when the connection comes back. */
export interface Notice {
  readonly text: string;
  readonly transport?: boolean;
}

export interface AppStateShape {
  readonly ready: boolean;
  readonly connection: ConnectionState;
  readonly connectionMessage?: string;
  readonly hello?: ServerHello;
  readonly appInfo: AppInfo;
  readonly snapshot: ProjectSnapshot | null;
  readonly recents: ReadonlyArray<RecentProject>;
  readonly newProjectOpen: boolean;
  // A readable error for the welcome screen (a failed open there).
  readonly welcomeError?: string;
  // project.json changed on disk: changes are refused until a reload succeeds.
  readonly changedOnDisk: boolean;
  // Why the last reload failed (folder gone, file unreadable), shown in the same banner.
  readonly reloadProblem?: string;
  readonly notice?: Notice;
  // Onboarding: open on first launch, or from Settings… / the welcome card.
  readonly setupOpen: boolean;
  readonly setupChecks?: ReadonlyArray<SetupCheck>;
  readonly setupChecking: boolean;
  // The last setup.check failed as a whole (server unreachable): shown with Check again.
  readonly setupError?: string;
  // Plugin folders found (D97), with whether each is allowed; read with the setup check.
  readonly plugins?: ReadonlyArray<PluginInfo>;
  // Why allowing (or revoking) a plugin failed.
  readonly pluginError?: string;
  // Settings › Plugins, Add plugin… (D102): installing, why it failed (reason "replaces-bundled"
  // can be retried on purpose), and the plugin whose approval dialog is open.
  readonly pluginInstalling?: boolean;
  readonly pluginInstallError?: { readonly message: string; readonly reason: string; readonly source: string; readonly ref?: string | undefined };
  readonly pluginInstallNote?: string;
  readonly pluginDialog?: string;
  /** The Capture tab's Argent section (D98): what the plugin last said, and while it's asked. */
  readonly capture?: CaptureState;
  readonly captureChecking?: boolean;
  readonly captureError?: string;
  /** Devices whose Record or Stop is on its way to the server. */
  readonly captureBusy?: ReadonlyArray<string>;
  /** The last take the Capture tab added (its media id and name). */
  readonly captureSaved?: { readonly mediaId: string; readonly name: string; readonly seconds: number };
  /** The Generate tab (D99): the generators and whether each has its key, the server's generation jobs, a prompt to edit. */
  readonly generators?: ReadonlyArray<GeneratorInfo>;
  readonly generateJobs: ReadonlyArray<GenerateJob>;
  readonly generateError?: string;
  readonly generateDraft?: GenerateDraft & { readonly seq: number };
  /** Settings › Keys: which providers have a key (never the key). */
  readonly keys?: ReadonlyArray<KeyInfo>;
  readonly keysError?: string;
  /** Settings opened at a section (the Generate tab's "Settings › Keys" link). */
  readonly setupFocus?: "keys";
  // Import jobs on the server (running and recent); the library shows the open project's.
  readonly jobs: ReadonlyArray<ImportJob>;
  readonly importReport?: { readonly failed: MediaImportResult["failed"]; readonly skipped: MediaImportResult["skipped"] };
  // Media ids that have a poster on the server; others show an icon (no request, no 404).
  readonly thumbIds: ReadonlySet<string>;
  // The open project's agent (turns, the running one) from agent.subscribe.
  readonly agent: AgentState | null;
  // The open project's history (D71) from history.subscribe, for the History tab.
  readonly history: HistoryState | null;
  // Why the last agent action failed (not installed, busy…), shown in the Agent tab.
  readonly agentError?: string;
  // A panel the agent's ui_show asked for (D65); the rail and the side tabs follow it once per seq.
  readonly panelRequest?: { readonly panel: AgentUiPanel; readonly seq: number };
  // The export dialog (D34) and the server's export jobs; the one this window started last.
  readonly exportOpen: boolean;
  readonly exportJobs: ReadonlyArray<ExportJob>;
  readonly exportJobId?: string;
  // The folder the last export went to (this session), offered for the next one.
  readonly exportFolder?: string;
  // Analysis jobs on the server (D66); the Library shows the open project's running ones per tile.
  readonly analysisJobs: ReadonlyArray<AnalysisJob>;
  // Why the last Analyze click was refused, shown in the Library.
  readonly analysisError?: string;
  // The speech models for transcripts and their downloads (D68), for the Setup row.
  readonly transcription?: TranscriptionState;
  // Why the last model action was refused.
  readonly transcriptionError?: string;
}

export const MAX_NAME_LENGTH = 100;

/** What the Generate tab's form holds. */
export interface GenerateDraft {
  readonly generator: string;
  readonly prompt: string;
  readonly kind?: GenerateKind | undefined;
  readonly size?: string | undefined;
  readonly seconds?: number | undefined;
}
let draftSeq = 0;

let state: AppStateShape = {
  ready: false,
  connection: "connecting",
  appInfo: { homeDir: "", defaultParentDir: "" },
  snapshot: null,
  recents: [],
  newProjectOpen: false,
  changedOnDisk: false,
  setupOpen: false,
  setupChecking: false,
  jobs: [],
  thumbIds: new Set(),
  agent: null,
  history: null,
  exportOpen: false,
  exportJobs: [],
  analysisJobs: [],
  generateJobs: [],
};
const listeners = new Set<() => void>();

const set = (patch: Partial<AppStateShape>) => {
  const before = state;
  state = { ...state, ...patch };
  // An Analyze refusal belongs to the project it was about.
  if (state.analysisError && before.snapshot?.dir !== state.snapshot?.dir) state = { ...state, analysisError: undefined };
  for (const listener of listeners) listener();
  if (before.snapshot !== state.snapshot || before.recents !== state.recents) syncShell();
};

export const useApp = () =>
  useSyncExternalStore(
    (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    () => state,
  );

export const getState = () => state;
export const projectOf = (snapshot: ProjectSnapshot) => snapshot.project as Project;
export const online = () => state.connection === "connected";

/** Keep the native menu (Open Recent, ⌘W) and the window title in step with the screen. */
function syncShell() {
  bridge.setAppState({ projectOpen: state.snapshot !== null, recents: state.recents.map(({ name, dir }) => ({ name, dir })) });
  document.title = state.snapshot ? projectOf(state.snapshot).name : "Uncut";
}

// The newest revision this window has shown, per project. A project's revisions only go up on the
// server (they're its own since D71, kept in history.db), so a call result at or below it is old
// news (e.g. it arrived after a reconnect's refetch). The subscription is always applied; the mark only rises.
const newestRevision = new Map<string, number>();

/** From the subscription: authoritative, always applied. */
function applyFromServer(snapshot: ProjectSnapshot | null) {
  if (snapshot) newestRevision.set(snapshot.dir, Math.max(newestRevision.get(snapshot.dir) ?? -1, snapshot.revision));
  const switched = snapshot?.dir !== state.snapshot?.dir;
  const mediaChanged = mediaKey(snapshot) !== mediaKey(state.snapshot);
  if (mediaChanged) void refreshThumbs();
  set({
    snapshot,
    ...(switched ? { changedOnDisk: false, reloadProblem: undefined, notice: undefined, importReport: undefined, exportOpen: false, panelRequest: undefined } : {}),
  });
  // Then the playhead follows the project: back to the start for another project, clamped when it
  // got shorter. After the snapshot, so nothing draws the old project at the reset playhead (the
  // preview of the old project ignores changes once the open folder isn't its own).
  if (switched) playback.reset();
  if (snapshot) {
    const { frames, end } = layoutOf(projectOf(snapshot));
    playback.setProject(frames, projectOf(snapshot).canvas.fps, end);
  }
  applyWaitingUi();
}

// Paths too: a relinked file (same id, new path) has another poster.
const mediaKey = (s: ProjectSnapshot | null) => (s ? `${s.dir}|${projectOf(s).media.map((m) => `${m.id}=${m.path}`).join(",")}` : "");
async function refreshThumbs() {
  const ids = await call((c) => c["media.thumbnails"]({}));
  if (ids.ok) set({ thumbIds: new Set(ids.value) });
}

/** From a call result: applied only if it is newer than anything shown. */
function applyFromCall(snapshot: ProjectSnapshot) {
  if (snapshot.revision <= (newestRevision.get(snapshot.dir) ?? -1)) return;
  applyFromServer(snapshot);
}

/** A sentence for a failed call, without validator jargon. */
export function plainError(error: CallError): string {
  if (isTransportError(error)) return "Not connected to the server. Try again when it's back.";
  if (error._tag === "PluginError") return error.message;
  const first = error.details?.[0];
  if (error._tag === "EditRefused" && first && /invalid|malformed/.test(error.message)) return `That change isn't allowed: ${first.message}.`;
  if (error._tag === "EditRefused" && first?.code === "depends") return error.message;
  if (error._tag === "EditRefused" && first?.code === "conflict") return "The agent changed that while you were editing it, so your change wasn't applied. Try again on what's there now.";
  if (error.reason === "missing") return "The project folder is gone, or has no project.json.";
  if (error.reason === "invalid" && first?.code === "json") return "project.json can't be read: it isn't valid JSON.";
  if (error.reason === "invalid") return `project.json can't be read: ${first ? `${first.path === "/" ? "" : `${first.path} `}${first.message}` : error.message}.`;
  return error.message;
}

let connection: Connection | undefined;
let serverConnection: ServerConnection | undefined;

/** A short, stable tag for a file path (FNV-1a), so a relinked file gets a different URL. */
const pathTag = (path: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};
const serverUrl = (route: string, id: string, path?: string) => {
  if (!serverConnection) return undefined;
  const url = new URL(serverConnection.url.replace(/^ws/, "http"));
  url.pathname = `${route}/${encodeURIComponent(id)}`;
  url.search = "";
  url.searchParams.set(TOKEN_QUERY_PARAM, serverConnection.token);
  // The server only looks at the id; the tag makes the URL (and so every <img>/<video> keyed on
  // it) change when the media item points at another file.
  if (path !== undefined) url.searchParams.set("v", pathTag(path));
  return url.href;
};
/** The poster for a media item, from the server's token-protected route (never file://). */
export const thumbUrl = (id: string, path?: string) => serverUrl(THUMB_PATH, id, path);
/** The original file of a media item, streamed by the server with byte ranges (never file://). */
export const mediaUrl = (id: string, path?: string) => serverUrl(MEDIA_FILE_PATH, id, path);
/** A track of the bundled music library (D91), for the Audio tab's preview. */
export const musicUrl = (file: string) => serverUrl(MUSIC_FILE_PATH, file);
/** The peaks of a media item's sound, made and cached by the server (D54). */
export const waveformUrl = (id: string, path?: string) => serverUrl(WAVEFORM_PATH, id, path);
/** A graphic item's document (D78), by its src ("graphics/x.html"), for the preview's sandboxed iframe. */
// Its URL carries the graphic-only secret from server.hello, never the server token: the graphic's
// script can read its own URL. No secret yet (hello not answered): no URL.
export const graphicUrl = (src: string) => {
  const secret = state.hello?.graphicToken;
  if (!src.startsWith("graphics/") || !secret) return undefined;
  const url = serverUrl(GRAPHIC_PATH, src.slice("graphics/".length), src);
  if (!url) return undefined;
  const u = new URL(url);
  u.searchParams.set(TOKEN_QUERY_PARAM, secret);
  return u.href;
};
let unsubscribe: (() => void) | undefined;
let unsubscribeJobs: (() => void) | undefined;
let unsubscribeAgent: (() => void) | undefined;
let unsubscribeHistory: (() => void) | undefined;
let unsubscribeExports: (() => void) | undefined;
let unsubscribeAnalysis: (() => void) | undefined;
let unsubscribeTranscription: (() => void) | undefined;
let unsubscribeGenerate: (() => void) | undefined;
// Finished jobs whose result has been shown (or that finished before this window saw them).
const reported = new Set<string>();
let jobsSeen = false;

/** Jobs as the server reports them: progress, finished results and newly made posters. */
function onJobs(jobs: ReadonlyArray<ImportJob>) {
  const before = new Map(state.jobs.map((j) => [j.id, j]));
  let report = state.importReport;
  let posters = false;
  for (const job of jobs) {
    const prev = before.get(job.id);
    if (prev?.postersDone !== job.postersDone && job.postersDone > 0) posters = true;
    const finished = job.phase === "done" || job.phase === "failed";
    // On (re)connect, jobs that finished earlier are history, not news.
    if (finished && !jobsSeen) reported.add(job.id);
    if (finished && !reported.has(job.id)) {
      reported.add(job.id);
      posters = true;
      // The agent's imports (D65) are reported in its turn, not as the Library's import report.
      if (job.projectDir === state.snapshot?.dir && !job.agent) {
        const failed = job.phase === "failed" ? job.result?.failed ?? [{ path: `${job.total} file${job.total === 1 ? "" : "s"}`, message: job.error ?? "The import stopped." }] : job.result?.failed ?? [];
        const skipped = job.result?.skipped ?? [];
        report = failed.length || skipped.length ? { failed: [...(report?.failed ?? []), ...failed], skipped: [...(report?.skipped ?? []), ...skipped] } : report;
      }
    }
  }
  jobsSeen = true;
  set({ jobs, importReport: report });
  if (posters) void refreshThumbs();
}

// Exports this window started: each is shown in Finder once it's done ("Opens in Finder when it's done").
const revealWhenDone = new Set<string>();
function onExportJobs(jobs: ReadonlyArray<ExportJob>) {
  for (const job of jobs) {
    if (!revealWhenDone.has(job.id) || (job.phase !== "done" && job.phase !== "failed" && job.phase !== "cancelled")) continue;
    revealWhenDone.delete(job.id);
    if (job.phase === "done") void bridge.showInFolder(job.output);
  }
  set({ exportJobs: jobs });
}

// The agent's ui_show (D65): each request is applied once, when its id is new. The first state
// for a project this window shows only records the request it carries: that one is old news,
// from before this window was looking.
// A request waits until the project snapshot it was made against (or a newer one) is here, so the
// playhead isn't clamped to an older, shorter project (the two streams can arrive in either order).
let uiDir: string | undefined;
let uiSeen: string | undefined;
let uiWaiting: AgentUi | undefined;
let panelSeq = 0;
function applyAgentUi(agent: AgentState | null) {
  if (!agent) return void ((uiDir = undefined), (uiWaiting = undefined));
  const ui = agent.ui;
  if (agent.dir !== uiDir) {
    uiDir = agent.dir;
    uiSeen = ui?.id;
    uiWaiting = undefined;
    return;
  }
  if (!ui || ui.id === uiSeen) return;
  uiSeen = ui.id;
  uiWaiting = ui;
  applyWaitingUi();
}
function applyWaitingUi() {
  const ui = uiWaiting;
  const snap = state.snapshot;
  if (!ui || !snap || snap.dir !== uiDir || snap.revision < ui.revision) return;
  uiWaiting = undefined;
  if (ui.frame !== undefined) {
    playback.pause();
    playback.seek(ui.frame);
  }
  if (ui.select !== undefined) playback.select(ui.select);
  if (ui.panel) set({ panelRequest: { panel: ui.panel, seq: ++panelSeq } });
}

/** The open project's analysis jobs for a media item (also joined ones, same content) that are waiting or running. */
export const activeAnalyses = (s: AppStateShape, mediaId: string) =>
  s.analysisJobs.filter((j) => j.projectDir === s.snapshot?.dir && (j.mediaId === mediaId || j.mediaIds.includes(mediaId)) && (j.phase === "queued" || j.phase === "running"));

// Analysis jobs this window saw waiting or running: if one of them fails, the Library says why
// (a cancel, by the user or a project closing, says nothing).
const analysesWatched = new Set<string>();
function onAnalysisJobs(analysisJobs: ReadonlyArray<AnalysisJob>) {
  let analysisError = state.analysisError;
  for (const job of analysisJobs) {
    if (job.phase === "queued" || job.phase === "running") analysesWatched.add(job.id);
    else if (analysesWatched.delete(job.id) && job.phase === "failed" && job.projectDir === state.snapshot?.dir) {
      const name = state.snapshot ? (projectOf(state.snapshot).media.find((m) => m.id === job.mediaId)?.name ?? job.mediaId) : job.mediaId;
      analysisError = `Couldn't analyse ${name}: ${job.error ?? "the analysis stopped."}`;
    }
  }
  set({ analysisJobs, analysisError });
}

/** The open project's import jobs that are still running or waiting. */
export const activeJobs = (s: AppStateShape) => s.jobs.filter((j) => j.projectDir === s.snapshot?.dir && j.phase !== "done" && j.phase !== "failed");
const call: Connection["call"] = (f) =>
  connection ? connection.call(f) : Promise.resolve({ ok: false, error: { _tag: "NotConnected", message: "Not connected to the server" } });

const refreshRecents = async () => {
  const recents = await call((c) => c["recents.list"]({}));
  if (recents.ok) set({ recents: recents.value });
};

export async function start() {
  bridge.onServerExit((message) => set({ connection: "server-exited", connectionMessage: message }));
  bridge.onMenuCommand(runCommand);
  window.addEventListener("keydown", onKeyDown);
  const [appInfo, server] = await Promise.all([bridge.appInfo(), bridge.getServerConnection().then((c) => ({ ok: true as const, c }), (e: Error) => ({ ok: false as const, e }))]);
  set({ appInfo });
  if (!server.ok) {
    set({ connection: "failed", connectionMessage: server.e.message, ready: true });
    return;
  }
  let firstSnapshot: () => void = () => {};
  const gotFirstSnapshot = new Promise<void>((resolve) => (firstSnapshot = resolve));
  serverConnection = server.c;
  const conn = connect(server.c, {
    // Every (re)connect resubscribes: the server re-sends the current project first.
    onConnect: () => {
      if (state.connection === "server-exited") return;
      set({ connection: "connected", notice: state.notice?.transport ? undefined : state.notice });
      unsubscribeJobs?.();
      unsubscribeJobs = conn.subscribe((c) => c["media.jobs"]({}), onJobs);
      unsubscribeExports?.();
      unsubscribeExports = conn.subscribe((c) => c["export.jobs"]({}), onExportJobs);
      unsubscribeAnalysis?.();
      unsubscribeAnalysis = conn.subscribe((c) => c["analysis.jobs"]({}), onAnalysisJobs);
      unsubscribeTranscription?.();
      unsubscribeTranscription = conn.subscribe((c) => c["transcription.state"]({}), (transcription) => set({ transcription }));
      unsubscribeGenerate?.();
      unsubscribeGenerate = conn.subscribe((c) => c["generate.jobs"]({}), (generateJobs) => set({ generateJobs }));
      unsubscribeAgent?.();
      unsubscribeAgent = conn.subscribe(
        (c) => c["agent.subscribe"]({}),
        (agent) => {
          set({ agent });
          applyAgentUi(agent);
        },
      );
      unsubscribeHistory?.();
      unsubscribeHistory = conn.subscribe((c) => c["history.subscribe"]({}), (history) => set({ history }));
      unsubscribe?.();
      unsubscribe = conn.subscribe(
        (c) => c["project.subscribe"]({}),
        (snapshot) => {
          applyFromServer(snapshot);
          firstSnapshot();
        },
      );
      void refreshRecents();
    },
    onDisconnect: () => {
      if (state.connection !== "server-exited") set({ connection: "reconnecting" });
    },
  });
  connection = conn;
  const hello = await call((c) => c["server.hello"]({}));
  if (hello.ok) set({ hello: hello.value });
  else if (!isTransportError(hello.error)) set({ connectionMessage: plainError(hello.error) });
  await Promise.race([gotFirstSnapshot, new Promise((r) => setTimeout(r, 5000))]);
  // First launch (onboarding never finished or skipped): show it.
  const setup = await call((c) => c["setup.state"]({}));
  if (setup.ok && !setup.value.onboarded) actions.openSetup();
  set({ ready: true });
}

/**
 * Runs a call that changes the project. Success clears the banner. A transport failure is
 * "unknown", not "didn't happen": nothing is rolled back here, the subscription will show
 * what the server did. Returns the error (if any) for callers that show it inline.
 */
async function change(run: Parameters<Connection["call"]>[0], { inline = false } = {}): Promise<CallError | undefined> {
  const result = (await call(run)) as Result<ProjectSnapshot>;
  if (result.ok) {
    const renamed = state.snapshot && projectOf(state.snapshot).name !== projectOf(result.value).name;
    applyFromCall(result.value);
    set({ notice: undefined });
    if (renamed) void refreshRecents(); // the Open Recent menu shows the new name
    return undefined;
  }
  const error = result.error;
  if (error.reason === "changed-on-disk") set({ changedOnDisk: true, reloadProblem: undefined, notice: undefined });
  else if (!inline) set({ notice: { text: plainError(error), transport: isTransportError(error) } });
  return error;
}

/** Plan an edit against the project on screen, send it, then select (and go to) the new item. */
// One add at a time: a double click must not plan two edits against the same project (they'd
// pick the same new id, and the second would be refused). Clicks while one is in flight are dropped.
let adding = false;
// A library track being copied and added (D91).
let musicAdding = false;

async function addPlanned(plan: (project: ProjectModel) => Planned | { readonly problem: string }) {
  if (adding || !state.snapshot || !online()) return;
  const planned = plan(projectOf(state.snapshot));
  if ("problem" in planned) return set({ notice: { text: planned.problem } });
  adding = true;
  let error: CallError | undefined;
  try {
    error = await change((c) => c["project.edit"]({ ops: planned.ops, summary: planned.summary }));
  } finally {
    adding = false;
  }
  if (error) return;
  playback.pause();
  playback.select(planned.itemId);
  playback.seek(planned.start);
}

/**
 * A manual timeline edit (D52): ops planned against the project at `baseRevision`, sent as one
 * project.edit, so it is validated, undoes in one step and is listed in the agent's next note.
 * If the agent changed the same item after that revision the server refuses it (D6) and the
 * banner says so. Shares the one-at-a-time guard with adds. Returns whether it was applied.
 */
async function timelineEdit(plan: Plan | { readonly problem: string }, origin: { readonly baseRevision?: number | undefined; readonly dir?: string | undefined } = {}): Promise<boolean> {
  const snapshot = state.snapshot;
  if (!snapshot || !online()) return false;
  // Planned in another project (it was switched mid-gesture): never send it to this one.
  if (origin.dir !== undefined && origin.dir !== snapshot.dir) return false;
  if ("problem" in plan) {
    set({ notice: { text: plan.problem } });
    return false;
  }
  if (!plan.ops.length) return false;
  if (adding) {
    set({ notice: { text: "The last change is still being saved. Try that again in a moment." } });
    return false;
  }
  // Checked with the server's timeline rules first, so a refusal reads as a sentence, not jargon.
  const draft = draftOf(projectOf(snapshot), plan.ops);
  if ("problem" in draft && origin.baseRevision === undefined) {
    set({ notice: { text: draft.problem } });
    return false;
  }
  const baseRevision = origin.baseRevision ?? snapshot.revision;
  adding = true;
  try {
    return !(await change((c) => c["project.edit"]({ ops: plan.ops, summary: plan.summary, baseRevision })));
  } finally {
    adding = false;
  }
}

// Inspector and canvas edits run one after another: a colour click right after a size change
// waits for it instead of being refused as "still being saved", and each is planned against the
// project as it is when its turn comes (update_item replaces nested objects whole).
let itemChain: Promise<unknown> = Promise.resolve();
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

/**
 * An item edit from the Inspector or the preview (D53): `makePlan` runs against the newest
 * project when it's this edit's turn. `baseRevision` is what the user saw when the gesture began
 * (a typing burst, a drag), so the server refuses it if the agent changed the item since (D6).
 */
function itemEdit(makePlan: (project: ProjectModel) => Plan | { readonly problem: string }, origin: { readonly baseRevision?: number | undefined; readonly dir?: string | undefined } = {}): Promise<boolean> {
  const run = async () => {
    while (adding) await settled();
    const snapshot = state.snapshot;
    if (!snapshot || (origin.dir !== undefined && origin.dir !== snapshot.dir)) return false;
    return timelineEdit(makePlan(projectOf(snapshot)), origin);
  };
  const next = itemChain.then(run, run);
  itemChain = next.catch(() => undefined);
  return next;
}

export const actions = {
  showNewProject: () => set({ newProjectOpen: true }),
  hideNewProject: () => set({ newProjectOpen: false }),

  chooseParentFolder: () => bridge.chooseFolder("parent"),

  /** Creates and opens the project (replacing any open one); returns the error for the form. */
  async createProject(input: { parentDir: string; name: string; canvas: Canvas }): Promise<string | undefined> {
    const result = await call((c) => c["project.create"](input));
    if (result.ok) {
      applyFromCall(result.value);
      set({ newProjectOpen: false, welcomeError: undefined, notice: undefined });
      void refreshRecents();
      return undefined;
    }
    if (result.error.reason === "exists") return `"${input.name}.uncut" already exists in that folder. Pick another name or folder.`;
    return plainError(result.error);
  },

  /** Opens a project. The error shows where the user is: the welcome card or the editor banner. */
  async openProject(dir: string) {
    const result = await call((c) => c["project.open"]({ dir }));
    if (result.ok) {
      applyFromCall(result.value);
      set({ welcomeError: undefined, notice: undefined });
      void refreshRecents();
      return;
    }
    const text = `Couldn't open ${dir.split("/").pop()}. ${plainError(result.error)}`;
    if (state.snapshot) set({ notice: { text, transport: isTransportError(result.error) } });
    else set({ welcomeError: text });
  },

  async openWithDialog() {
    const dir = await bridge.chooseFolder("project");
    if (dir) await actions.openProject(dir);
  },

  async closeProject() {
    if (!state.snapshot) return;
    const result = await call((c) => c["project.close"]({}));
    if (!result.ok) return set({ notice: { text: plainError(result.error), transport: isTransportError(result.error) } });
    set({ snapshot: null, changedOnDisk: false, reloadProblem: undefined, notice: undefined, welcomeError: undefined });
    playback.reset();
    await refreshRecents();
  },

  // ⌘Z with nothing left says why when that's news (D71: it stops at a change made outside Uncut).
  undo: () => (state.snapshot?.canUndo ? change((c) => c["project.undo"]({})) : state.snapshot?.undoStop ? set({ notice: { text: state.snapshot.undoStop } }) : undefined),
  redo: () => (state.snapshot?.canRedo ? change((c) => c["project.redo"]({})) : undefined),
  /** A generated result → the timeline at the playhead (see planAddAtPlayhead, D99). */
  addAtPlayhead: (mediaId: string) => addPlanned((project) => planAddAtPlayhead(project, mediaId, getPlayback().frame)),
  /** Media tile → timeline (see planAddMedia); the playhead moves to the new item. */
  addMedia: (mediaId: string) => addPlanned((project) => planAddMedia(project, mediaId, getPlayback().frame)),
  /**
   * Audio tab library → the track on the timeline (D91): the server copies it into the project's
   * media/ (unless it's there already), then the media and the item go in as one edit.
   */
  async addMusic(trackId: string) {
    const track = musicTrack(trackId);
    // One add at a time, from the copy until the edit is in: a double click adds once.
    if (!track || !state.snapshot || !online() || adding || musicAdding) return;
    musicAdding = true;
    try {
      let path: string | undefined;
      if (!musicInProject(projectOf(state.snapshot), track)) {
        const result = await call((c) => c["music.add"]({ track: track.id }));
        if (!result.ok) return set({ notice: { text: plainError(result.error), transport: isTransportError(result.error) } });
        path = result.value.path;
      }
      await addPlanned((project) => planAddMusic(project, track, path, getPlayback().frame));
    } finally {
      musicAdding = false;
    }
  },
  /** Open a panel as the agent's ui_show does (the Checks tab from the export dialog, D90). */
  openPanel: (panel: AgentUiPanel) => set({ panelRequest: { panel, seq: ++panelSeq } }),
  /** A check's fix (D90), planned again on the project as it is now: one undoable edit with the fix's History label. */
  applyCheckFix: (check: Pick<Check, "key">) =>
    itemEdit((project) => {
      const now = projectChecks(project).find((c) => c.key === check.key);
      return now?.fix ? { ops: now.fix.ops, summary: now.fix.summary } : { problem: "That check doesn't apply any more." };
    }),
  /** Turn a check rule off (or back on) for this project (checks.disabled, D90). */
  setCheckDisabled: (id: string, off: boolean) => itemEdit((project) => planDisableCheck(project, id, off)),
  /** Text tab preset → a text item at the playhead (see planAddText). */
  /** Text tab → a preset at the playhead (or the dropped frame), placed where it was dropped on the canvas (D80). */
  addText: (preset: TextPreset, opts: { at?: { x: number; y: number }; frame?: number } = {}) => addPlanned((project) => planAddText(project, preset, opts.frame ?? getPlayback().frame, opts.at)),
  /** A planned move or trim from the timeline (see edit.ts). */
  timelineEdit,
  /** A text or background change from the Inspector or the preview (see text.ts). */
  itemEdit,
  /** Elements tab → a component at the playhead, or where it was dropped (see planAddComponent, D76). */
  addComponent: (id: string, opts: { at?: { x: number; y: number }; frame?: number } = {}) =>
    addPlanned((project) => planAddComponent(project, id, opts.frame ?? getPlayback().frame, opts.at ? { at: opts.at } : {})),
  /** Elements tab → a full-frame background (see planAddBackground). */
  addBackground: (props: BackgroundProps) => addPlanned((project) => planAddBackground(project, props, getPlayback().frame, getPlayback().selected)),
  /** S: split at the playhead (see planSplit); the part after the playhead is selected. */
  async split() {
    if (!state.snapshot) return;
    const { selected, frame } = getPlayback();
    const plan = planSplit(projectOf(state.snapshot), selected, frame);
    if (await timelineEdit(plan)) playback.select("newId" in plan ? plan.newId : undefined);
  },
  /** ⌫: delete the selected item; on main the rest closes up. A selected cut: remove its transition (D73). */
  async deleteSelected() {
    if (!state.snapshot) return;
    const cut = getPlayback().cut;
    if (cut !== undefined) {
      const placed = findItem(projectOf(state.snapshot), cut);
      if (placed?.item.transitionIn) await timelineEdit(planSetTransition(projectOf(state.snapshot), cut, null));
      return;
    }
    // A selected volume key (D83): ⌫ removes the key, not its item.
    const { selected, gainKey } = getPlayback();
    if (selected !== undefined && gainKey !== undefined) {
      if (await timelineEdit(planRemoveGainKey(projectOf(state.snapshot), selected, gainKey))) playback.selectGainKey(selected, undefined);
      return;
    }
    if (await timelineEdit(planDelete(projectOf(state.snapshot), selected))) playback.select(undefined);
  },
  /**
   * Put a transition on a cut (D73): `cut` (the id of the clip after it), else the selected cut;
   * with `nearest`, the cut nearest the playhead. The cut is selected afterwards, so the Inspector
   * shows it. Replaces a transition already there (keeping its length, clamped).
   */
  async applyTransition(module: string, { cut, nearest = false }: { cut?: string; nearest?: boolean } = {}) {
    if (!state.snapshot) return false;
    const project = projectOf(state.snapshot);
    const target = cut ?? (nearest ? nearestCut(project, getPlayback().frame)?.item.id : getPlayback().cut);
    if (target === undefined) {
      set({ notice: { text: nearest ? "There's no cut yet: put two clips on the main track first." : "Pick a cut first: click between two clips on the main track, drag the transition onto a cut, or use + for the cut nearest the playhead." } });
      return false;
    }
    const ok = await timelineEdit(planSetTransition(project, target, { module }));
    if (ok || findItem(project, target)?.item.transitionIn?.module === module) playback.selectCut(target);
    return ok;
  },
  /** Change (or with null remove) the transition at the cut before main item `itemId`. */
  setTransition: (itemId: string, next: { module: string; duration?: number } | null, origin?: { baseRevision?: number; dir?: string }) =>
    state.snapshot ? timelineEdit(planSetTransition(projectOf(state.snapshot), itemId, next), origin) : Promise.resolve(false),
  toggleTrack: (trackId: string, flag: TrackFlag) => (state.snapshot ? timelineEdit(planTrackFlag(projectOf(state.snapshot), trackId, flag)) : undefined),
  rename: (name: string) =>
    change((c) => c["project.edit"]({ ops: [{ op: "update_project", set: { name } }], summary: "Rename project" }), { inline: true }),

  async reload() {
    const result = await call((c) => c["project.reload"]({}));
    if (result.ok) {
      applyFromCall(result.value);
      set({ changedOnDisk: false, reloadProblem: undefined, notice: undefined });
      void refreshRecents();
    } else if (isTransportError(result.error)) set({ notice: { text: plainError(result.error), transport: true } });
    else set({ reloadProblem: plainError(result.error) });
  },

  showInFolder: (path: string) => bridge.showInFolder(path),

  /** The project as it was at a revision (History's preview), or a sentence saying why not. */
  async historyPreview(revision: number): Promise<{ readonly project: Project } | { readonly problem: string }> {
    const result = await call((c) => c["history.preview"]({ revision }));
    return result.ok ? { project: result.value.project as Project } : { problem: plainError(result.error) };
  },
  /** Bring back a revision's state as a new revision (History's Restore; one ⌘Z takes it back). */
  historyJump: (revision: number) => change((c) => c["history.jump"]({ revision })),

  /**
   * Import files (from a drop) or, with no paths, ask with the native dialog. The server runs
   * it as a job (queued behind any running one); progress and results arrive on media.jobs.
   */
  async importMedia(paths?: ReadonlyArray<string>) {
    const chosen = paths ?? (await bridge.chooseMedia());
    const absolute = chosen.filter((p) => typeof p === "string" && p.startsWith("/"));
    if (absolute.length === 0) return;
    if (!activeJobs(state).length) set({ importReport: undefined });
    const result = await call((c) => c["media.import"]({ paths: absolute }));
    if (!result.ok) set({ importReport: { failed: absolute.map((path) => ({ path, message: plainError(result.error) })), skipped: [] } });
  },
  dismissImportReport: () => set({ importReport: undefined }),

  dismissNotice: () => set({ notice: undefined }),

  /** Start an agent turn; returns false (and says why in the Agent tab) when it didn't start. */
  async agentSend(prompt: string): Promise<boolean> {
    if (!online()) return false;
    set({ agentError: undefined });
    // The agent works on what's on screen: stop playback so the frame it's told about stays put.
    playback.pause();
    const { frame, selected } = getPlayback();
    const result = await call((c) => c["agent.send"]({ prompt, frame: Math.floor(frame), ...(selected ? { selected } : {}) }));
    if (result.ok) return true;
    set({ agentError: plainError(result.error) });
    // "Not installed" may be news to the setup rows too.
    if (result.error.reason === "not-installed") void actions.checkSetup();
    return false;
  },
  agentCancel: () => call((c) => c["agent.cancel"]({})),
  /** Allow or Don't on the running turn's approval card (D99). */
  agentApprove: (id: string, allow: boolean) => call((c) => c["agent.approve"]({ id, allow })),
  async agentUndoTurn(turnId: string) {
    set({ agentError: undefined });
    const result = (await call((c) => c["agent.undoTurn"]({ turnId }))) as Result<ProjectSnapshot>;
    if (result.ok) applyFromCall(result.value);
    else if (result.error.reason === "changed-on-disk") set({ changedOnDisk: true, reloadProblem: undefined });
    else set({ agentError: plainError(result.error) });
  },
  dismissAgentError: () => set({ agentError: undefined }),

  /** ⌘E / the Export button: the export dialog, with ffmpeg checked (it shows the fix when missing). */
  openExport() {
    if (!state.snapshot) return;
    set({ exportOpen: true });
    if (state.setupChecks?.find((c) => c.id === "ffmpeg")?.status !== "ready") void actions.checkSetup();
  },
  closeExport: () => set({ exportOpen: false }),
  chooseExportPath: (defaultPath: string) => bridge.chooseSavePath(defaultPath),
  /** Starts an export of the open project; returns the server's refusal (exists, no ffmpeg…) if any. */
  async startExport(input: { output: string; quality: ExportQuality; loudness: ExportLoudness; targetLufs?: number; overwrite?: boolean }): Promise<{ readonly reason?: string; readonly message: string } | undefined> {
    const result = await call((c) => c["export.start"](input));
    if (!result.ok) return { reason: (result.error as { reason?: string }).reason, message: plainError(result.error) };
    revealWhenDone.add(result.value.jobId);
    set({ exportJobId: result.value.jobId, exportFolder: input.output.slice(0, input.output.lastIndexOf("/")) || "/" });
    return undefined;
  },
  cancelExport: (jobId: string) => call((c) => c["export.cancel"]({ jobId })),

  /** The Library's Analyze button (D66): loudness and silences of a media item, on demand. */
  async analyzeMedia(mediaId: string) {
    set({ analysisError: undefined });
    const result = await call((c) => c["analysis.start"]({ mediaId }));
    if (!result.ok) set({ analysisError: plainError(result.error) });
  },
  cancelAnalysis: (jobId: string) => call((c) => c["analysis.cancel"]({ jobId })),
  /** Transcribe a media item (the Transcript panel, D69): the analysis job, as the Library starts one. */
  async transcribe(mediaId: string) {
    set({ analysisError: undefined });
    const result = await call((c) => c["analysis.start"]({ mediaId, analyzers: ["transcript"] }));
    if (!result.ok) set({ analysisError: plainError(result.error) });
  },
  /** Find the beats of a media item (D70: the inspector's Find beats): the analysis job. */
  async analyzeBeats(mediaId: string) {
    set({ analysisError: undefined });
    const result = await call((c) => c["analysis.start"]({ mediaId, analyzers: ["beats"] }));
    if (!result.ok) set({ analysisError: plainError(result.error) });
  },
  /** A cached analysis result (no job): undefined when the call failed, null when there's none yet. */
  async analysisCached(mediaId: string, analyzer: "loudness" | "transcript" | "beats", omit?: ReadonlyArray<string>): Promise<unknown> {
    const result = await call((c) => c["analysis.cached"]({ mediaId, analyzer, ...(omit ? { omit } : {}) }));
    return result.ok ? result.value.result : undefined;
  },
  dismissAnalysisError: () => set({ analysisError: undefined }),

  /** The Setup row's speech model (D68): download, cancel, choose. */
  async downloadModel(model?: string) {
    set({ transcriptionError: undefined });
    const result = await call((c) => c["transcription.download"](model ? { model } : {}));
    if (!result.ok) set({ transcriptionError: plainError(result.error) });
  },
  cancelModelDownload: (model?: string) => call((c) => c["transcription.cancelDownload"](model ? { model } : {})),
  async selectModel(model: string) {
    set({ transcriptionError: undefined });
    const result = await call((c) => c["transcription.selectModel"]({ model }));
    if (!result.ok) set({ transcriptionError: plainError(result.error) });
  },

  openSetup() {
    set({ setupOpen: true, setupFocus: undefined });
    void actions.checkSetup();
    void actions.listKeys();
  },
  async checkSetup() {
    set({ setupChecking: true, setupError: undefined });
    void actions.listPlugins();
    const result = await call((c) => c["setup.check"]({}));
    if (result.ok) set({ setupChecking: false, setupChecks: result.value });
    else set({ setupChecking: false, setupError: `Couldn't check this Mac. ${plainError(result.error)}` });
  },
  async listPlugins() {
    const result = await call((c) => c["plugins.list"]({}));
    if (result.ok) set({ plugins: result.value });
  },
  /** Allows a plugin to run (D97); its capabilities were shown next to the button. */
  async approvePlugin(plugin: Pick<PluginInfo, "id" | "dir" | "capabilities">) {
    set({ pluginError: undefined });
    const result = await call((c) => c["plugins.approve"]({ id: plugin.id, dir: plugin.dir, capabilities: [...plugin.capabilities] }));
    if (result.ok) set({ plugins: result.value, pluginDialog: undefined });
    else set({ pluginError: plainError(result.error) });
  },
  /** Installs a plugin from a folder or git URL (D102), then opens its approval dialog. */
  async installPlugin(input: { source: string; ref?: string | undefined; replaceBundled?: boolean }) {
    set({ pluginInstalling: true, pluginInstallError: undefined, pluginInstallNote: undefined, pluginError: undefined });
    const result = await call((c) => c["plugins.install"]({ source: input.source, ...(input.ref ? { ref: input.ref } : {}), ...(input.replaceBundled ? { replaceBundled: true } : {}) }));
    if (result.ok) {
      set({ pluginInstalling: false, plugins: result.value.plugins, pluginInstallNote: result.value.note, pluginDialog: result.value.plugins.some((p) => p.id === result.value.id && p.status === "needs-approval") ? result.value.id : undefined });
      return true;
    }
    const error = result.error as { reason?: unknown };
    set({ pluginInstalling: false, pluginInstallError: { message: plainError(result.error), reason: typeof error.reason === "string" ? error.reason : "", source: input.source, ref: input.ref } });
    return false;
  },
  /** Add plugin… › Choose folder: the folder dialog, then install. */
  async installPluginFolder() {
    const dir = await bridge.chooseFolder("plugin");
    return dir ? actions.installPlugin({ source: dir }) : false;
  },
  async uninstallPlugin(id: string) {
    set({ pluginError: undefined });
    const result = await call((c) => c["plugins.uninstall"]({ id }));
    if (result.ok) set({ plugins: result.value, pluginDialog: undefined });
    else set({ pluginError: plainError(result.error) });
  },
  openPluginDialog(id: string | undefined) {
    set({ pluginDialog: id, pluginError: undefined });
  },
  async revokePlugin(id: string) {
    set({ pluginError: undefined });
    const result = await call((c) => c["plugins.revoke"]({ id }));
    if (result.ok) set({ plugins: result.value });
    else set({ pluginError: plainError(result.error) });
  },
  /** The Capture tab: Argent's devices (and whether Argent is there at all). */
  async checkCapture() {
    set({ captureChecking: true });
    const result = await call((c) => c["capture.devices"]({}));
    if (result.ok) set({ captureChecking: false, capture: result.value, captureError: undefined });
    else set({ captureChecking: false, captureError: plainError(result.error) });
  },
  async startCapture(device: string) {
    set({ captureError: undefined, captureSaved: undefined, captureBusy: [...(state.captureBusy ?? []), device] });
    const result = await call((c) => c["capture.start"]({ device }));
    set({ captureBusy: (state.captureBusy ?? []).filter((d) => d !== device) });
    if (!result.ok) set({ captureError: plainError(result.error) });
    await actions.checkCapture();
  },
  /** Stops a recording; the server adds the take to the project as one edit (⌘Z removes it). */
  async stopCapture(device: string) {
    set({ captureError: undefined, captureBusy: [...(state.captureBusy ?? []), device] });
    const result = await call((c) => c["capture.stop"]({ device }));
    set({ captureBusy: (state.captureBusy ?? []).filter((d) => d !== device) });
    if (result.ok) set({ captureSaved: result.value });
    else set({ captureError: plainError(result.error) });
    await actions.checkCapture();
  },
  // ---- generators and keys (D99) ----
  async listGenerators() {
    const result = await call((c) => c["generate.list"]({}));
    if (result.ok) set({ generators: result.value });
  },
  async startGenerate(draft: GenerateDraft) {
    set({ generateError: undefined });
    const result = await call((c) => c["generate.start"]({ generator: draft.generator, prompt: draft.prompt, ...(draft.kind ? { kind: draft.kind } : {}), ...(draft.size ? { size: draft.size } : {}), ...(draft.seconds !== undefined ? { seconds: draft.seconds } : {}) }));
    if (!result.ok) {
      set({ generateError: plainError(result.error) });
      void actions.listGenerators();
    }
  },
  cancelGenerate: (jobId: string) => call((c) => c["generate.cancel"]({ jobId })),
  /** "Edit prompt" on a generated result: the Generate tab with its generator, prompt and settings. */
  editPrompt(draft: GenerateDraft) {
    set({ generateDraft: { ...draft, seq: ++draftSeq }, generateError: undefined });
  },
  async listKeys() {
    const result = await call((c) => c["keys.list"]({}));
    if (result.ok) set({ keys: result.value });
  },
  /** Stores a key (it goes to the server once and never comes back). Returns whether it was saved. */
  async setKey(provider: KeyProvider, key: string) {
    set({ keysError: undefined });
    const result = await call((c) => c["keys.set"]({ provider, key }));
    if (!result.ok) {
      set({ keysError: plainError(result.error) });
      return false;
    }
    set({ keys: result.value });
    void actions.listGenerators();
    return true;
  },
  async removeKey(provider: KeyProvider) {
    set({ keysError: undefined });
    const result = await call((c) => c["keys.remove"]({ provider }));
    if (result.ok) set({ keys: result.value });
    else set({ keysError: plainError(result.error) });
    void actions.listGenerators();
  },
  /** Settings › Keys. */
  openKeys() {
    set({ setupOpen: true, setupFocus: "keys" });
    void actions.checkSetup();
    void actions.listKeys();
  },
  copy: (text: string) => bridge.copyText(text),
  /** Finish (or skip) onboarding; it won't open on launch again. */
  async finishSetup(next: "new-project" | "stay") {
    set({ setupOpen: false, setupFocus: undefined });
    void actions.listGenerators();
    await call((c) => c["setup.complete"]({}));
    if (next === "new-project") actions.showNewProject();
  },
};

function runCommand(command: MenuCommand) {
  // Everything below talks to the server; while it's away the buttons are disabled too.
  if (!online()) return;
  if (command.type === "open-setup") return actions.openSetup();
  if (command.type === "export") return actions.openExport();
  switch (command.type) {
    case "new-project":
      // Over the editor if one is open; the current project only closes once the new one exists.
      return actions.showNewProject();
    case "open-project":
      return void actions.openWithDialog();
    case "open-recent":
      return void actions.openProject(command.dir);
    case "close-project":
      if (state.newProjectOpen) return actions.hideNewProject();
      return void actions.closeProject();
    case "undo":
    case "redo":
      return undoOrRedo(command.type);
  }
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "number", "email", "url", "tel", "password"]);
/**
 * A field where keys type text (text-like inputs, textareas, contenteditable). A focused checkbox,
 * colour picker or slider is not one: ⌘Z there undoes the project, not typing.
 */
export const isTextEntry = (el: EventTarget | null) =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type)) || (el instanceof HTMLElement && el.isContentEditable);

// In a text field ⌘Z undoes typing; elsewhere it undoes the last project change.
function undoOrRedo(kind: "undo" | "redo") {
  if (isTextEntry(document.activeElement)) document.execCommand(kind);
  else void actions[kind]();
}

// The menu shows these shortcuts but doesn't register them (registerAccelerator: false), so
// the keys arrive here and there is one code path for them.
function onKeyDown(event: KeyboardEvent) {
  if (!event.metaKey || event.altKey || event.ctrlKey) return;
  const key = event.key.toLowerCase();
  const command: MenuCommand | undefined =
    key === "z"
      ? { type: event.shiftKey ? "redo" : "undo" }
      : event.shiftKey
        ? undefined
        : key === ","
          ? { type: "open-setup" }
          : key === "n"
          ? { type: "new-project" }
          : key === "e" && state.snapshot
          ? { type: "export" }
          : key === "o"
            ? { type: "open-project" }
            : key === "w" && state.snapshot
              ? { type: "close-project" }
              : undefined;
  if (!command) return;
  event.preventDefault();
  runCommand(command);
}
