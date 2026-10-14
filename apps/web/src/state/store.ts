// App state and the actions that change it. This module owns the server connection; the
// components only read state (useApp) and call actions.
//
// The open project comes from the server's project.subscribe stream, which is ordered and
// re-sent in full on every reconnect, so the screen always ends up showing what the server
// has. Call results are applied too (for snappiness) but never over a newer revision.
import { transitionSeconds } from "../timeline/transitionLength.ts";
import { AGENT_IMAGE_PATH, GRAPHIC_PATH, UPLOAD_PATH, type AgentImage, type FileListing, LIBRARY_PREVIEW_PATH, MEDIA_FILE_PATH, MUSIC_FILE_PATH, SFX_FILE_PATH, THUMB_PATH, type LibrarySearchResult, type LibraryState, TOKEN_QUERY_PARAM, WAVEFORM_PATH, type AgentMention, type AgentState, type AnalysisJob, type AgentUi, type AgentUiPanel, type ExportJob, type HistoryState, type ExportLoudness, type ExportQuality, type ExportSubtitles, type ImportJob, type MediaImportResult, type ProjectSnapshot, type RecentProject, type ServerConnection, type PluginInfo, type CaptureState, type CaptureOptions, type TakeKind, type GenerateJob, type GenerateKind, type GeneratorInfo, type KeyInfo, type KeyProvider, type ServerHello, type SetupCheck, type TranscriptionState, type PluginContributions, type CatalogEntry, type AgentAccess, type AgentAnswer, type Brief, type Storyboard, type StoryboardBeat, type BrandActive, type BrandKit, type BrandScope, type BrandSkill, type BrandState } from "@uncut/contracts";
import { useSyncExternalStore } from "react";

import { takeUploadName } from "@uncut/contracts";
import { bridge, type AppInfo, type EnvironmentInfo, type EnvironmentTest, type MenuCommand } from "./bridge.ts";
import { connect, isTransportError, type CallError, type Connection, type Result } from "./connection.ts";
import type { Canvas } from "./format.ts";
import { getPlayback, playback } from "../preview/playback.ts";
import { draftOf, findItem, nearestCut, planDelete, planGrouping, planLayer, withOverlayRipple, planRippleDelete, planSetTransition, planSplit, planTrackFlag, type Plan, type TrackFlag } from "../timeline/edit.ts";
import { planResetPosition } from "../timeline/clip.ts";
import { planDetachAudio, planSetSpeed, takenIds } from "@uncut/core/arrange";
import { musicInProject, musicTrack } from "@uncut/core/music";
import { effectInfo, lookInfo, planEffect, planSetLook, type LookDef } from "@uncut/core/fx";
import { planForAll } from "../timeline/multi.ts";
import { libraryMediaOf, type LibraryQuery } from "@uncut/core/library";
import { itemName, momentLabel } from "@uncut/core/mentions";
import { agentPrefs, DEFAULT_AGENT_PREFS, skipStoryboardSetting } from "./agentPrefs.ts";
import { type Check, type CheckRule } from "@uncut/core/checks";
import { pluginCheckRules, pluginRuleEntries, type PluginLook, type PluginRule } from "@uncut/core/contributions";
import { layoutOf, uniqueId, planAddAtPlayhead, planAddLibrarySound, planAddMedia, planAddMusic, planAddText, planDropMedia, TEXT_PRESETS, type Planned, type ProjectModel, type TextPreset } from "./project.ts";
import { planAddBackground, type BackgroundProps } from "../preview/text.ts";
import { planAddComponent, planAddGraphic } from "../preview/components.ts";
import { planRemoveGainKey } from "../audio/sound.ts";
import { planFitToVideo, planRemoveMedia } from "@uncut/core/mediaPlan";
import { rememberSideTab } from "../editor/layout.ts";

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
  // Settings (G8): the project's and the app's settings, and the keyboard shortcuts sheet (G3).
  readonly settingsOpen: boolean;
  readonly settingsSection: SettingsSection;
  readonly shortcutsOpen: boolean;
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
  /** The allowed plugins' looks, components and check rules (D103), for the grids and Checks. */
  readonly contributions?: PluginContributions;
  /** Process plugins' own findings on the open project (D103), the last answer. */
  readonly pluginFindings?: { readonly checks: ReadonlyArray<Check>; readonly notes: ReadonlyArray<string> };
  /** Settings › Plugins › Browse (D103): Uncut's plugin catalog, each with whether it's enabled. */
  readonly pluginCatalog?: { readonly plugins: ReadonlyArray<CatalogEntry>; readonly problems: ReadonlyArray<string> };
  /** The Capture tab's Argent section (D98): what the plugin last said, and while it's asked. */
  readonly capture?: CaptureState;
  readonly captureChecking?: boolean;
  readonly captureError?: string;
  /** Devices whose Record or Stop is on its way to the server. */
  readonly captureBusy?: ReadonlyArray<string>;
  /** D143: devices booting for "Boot and record" (their id before the boot). */
  readonly captureBooting?: ReadonlyArray<string>;
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
  /** The library sound being added (D134), for its row's spinner. */
  readonly libraryAdding?: string | undefined;
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
  // The composer (D140): what's typed and what its @labels point at. In the store, so Add to chat
  // (D141) from the timeline, the canvas or the Inspector lands in it with the Agent tab closed.
  readonly agentDraft: string;
  readonly agentMentions: ReadonlyArray<AgentMention>;
  // A message written while a turn runs: sent when that turn ends.
  readonly agentQueued?: { readonly prompt: string; readonly mentions: ReadonlyArray<AgentMention>; readonly images?: ReadonlyArray<AgentImage> };
  // Images attached in the composer (D184), sent with the next message.
  readonly agentImages: ReadonlyArray<AgentImage>;
  // Bumped to put the caret in the composer (after Add to chat).
  readonly agentFocus: number;
  // A panel the agent's ui_show asked for (D65); the rail and the side tabs follow it once per seq.
  readonly panelRequest?: { readonly panel: AgentUiPanel; readonly seq: number };
  /** "Show in Media" (T7): the tile to scroll to and flash. */
  readonly mediaFocus?: { readonly id: string; readonly seq: number };
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
  // ---- environments (Phase 9, D106) ----
  /** Where this window's server runs: Local, or a remote uncut-server (through the desktop's relay). */
  readonly environment: EnvironmentInfo;
  /** Every environment, for the Environments dialog (loaded when it opens). */
  readonly environments?: ReadonlyArray<EnvironmentInfo>;
  readonly environmentsOpen: boolean;
  /** Why the relay can't reach the remote right now (a refused token, nothing listening). */
  readonly environmentProblem?: string;
  /** The remote file browser (D107), open in place of a native dialog. */
  readonly remotePicker?: RemotePickerRequest;
  /** Files going up to a remote project's media/uploads/ (D108). */
  readonly uploading?: { readonly total: number; readonly done: number; readonly name: string };
  /** Remote exports being downloaded, or where they went (D109), by job id. */
  readonly downloads: Readonly<Record<string, { readonly state: "running" } | { readonly path: string } | { readonly error: string }>>;
  /** D186: the brand kits and skills the open project sees, and its choice (the Brand tab). */
  readonly brand?: BrandState;
  /** Why the last brand action failed, shown in the Brand tab. */
  readonly brandError?: string;
}

/** What a remote environment's file browser is for (D107): each native dialog it stands in for. */
export type PickerPurpose = "project" | "parent" | "plugin" | "media" | "save";
export interface RemotePickerRequest {
  readonly purpose: PickerPurpose;
  /** The folder to start in. */
  readonly start?: string | undefined;
  /** "save": the file name to suggest. */
  readonly fileName?: string | undefined;
  readonly seq: number;
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
  settingsOpen: false,
  settingsSection: "project",
  shortcutsOpen: false,
  setupChecking: false,
  jobs: [],
  thumbIds: new Set(),
  agent: null,
  agentDraft: "",
  agentMentions: [],
  agentImages: [],
  agentFocus: 0,
  history: null,
  exportOpen: false,
  exportJobs: [],
  analysisJobs: [],
  generateJobs: [],
  environment: { id: "local", name: "This Mac", kind: "local" },
  environmentsOpen: false,
  downloads: {},
};
const listeners = new Set<() => void>();

const set = (patch: Partial<AppStateShape>) => {
  const before = state;
  state = { ...state, ...patch };
  // An Analyze refusal belongs to the project it was about.
  if (state.analysisError && before.snapshot?.dir !== state.snapshot?.dir) state = { ...state, analysisError: undefined };
  for (const listener of listeners) listener();
  if (before.snapshot !== state.snapshot || before.recents !== state.recents) syncShell();
  // Plugins allowed, removed or installed: their looks, components and rules follow (D103).
  if (before.plugins !== state.plugins && state.connection === "connected") void actions.loadContributions();
};

// ---- plugin contributions (D103) ----

const rulesMemo = new WeakMap<object, { readonly rules: ReadonlyArray<CheckRule>; readonly entries: ReadonlyArray<CheckRule> }>();
const rulesOf = (c: PluginContributions | undefined) => {
  if (!c) return { rules: [], entries: [] };
  let m = rulesMemo.get(c);
  if (!m) {
    const list = c.rules as ReadonlyArray<PluginRule>;
    m = { rules: pluginCheckRules(list), entries: pluginRuleEntries(list) };
    rulesMemo.set(c, m);
  }
  return m;
};
/** The allowed plugins' data rules, compiled once per contributions answer (core runs them with the built-ins). */
export const pluginRules = () => rulesOf(state.contributions).rules;
/** Every plugin rule as a registry entry (titles, process ones too). */
export const pluginRuleList = () => rulesOf(state.contributions).entries;
/** The allowed plugins' looks (D103). */
export const pluginLooks = () => (state.contributions?.looks ?? []) as ReadonlyArray<PluginLook>;
const presetsMemo = new WeakMap<object, ReadonlyArray<TextPreset>>();
/** The Text tab's tiles: the built-in looks, then the allowed plugins' (D103), each with its plugin's name. */
export function textPresets(): ReadonlyArray<TextPreset> {
  const c = state.contributions;
  if (!c?.looks.length) return TEXT_PRESETS;
  let list = presetsMemo.get(c);
  if (!list) {
    list = [...TEXT_PRESETS, ...pluginLooks().map((l): TextPreset => ({ id: l.id, module: l.id, label: l.name, text: l.text, look: l, source: l.pluginName }))];
    presetsMemo.set(c, list);
  }
  return list;
}

/** Outside React: called after every state change (D144: the recorder watches an agent take). */
export const subscribeApp = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener));

export const useApp = () =>
  useSyncExternalStore(
    (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    () => state,
  );

export const getState = () => state;
export const projectOf = (snapshot: ProjectSnapshot) => snapshot.project as Project;
export const online = () => state.connection === "connected";
/** The window shows a remote environment (D106): paths are the server's, not this Mac's. */
export const isRemote = (s: AppStateShape = state) => s.environment.kind === "remote";

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
    ...(switched ? { changedOnDisk: false, reloadProblem: undefined, notice: undefined, importReport: undefined, exportOpen: false, panelRequest: undefined, agentDraft: "", agentMentions: [], agentImages: [], agentQueued: undefined } : {}),
  });
  // Then the playhead follows the project: back to the start for another project, clamped when it
  // got shorter. After the snapshot, so nothing draws the old project at the reset playhead (the
  // preview of the old project ignores changes once the open folder isn't its own).
  if (switched) playback.reset();
  // D186: the brand state follows the project (its kits, skills and choice).
  if (switched) void actions.brandGet();
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

/** A brand call's answer into the state (or its reason into brandError). */
function brandResult(result: Result<BrandState>): boolean {
  if (result.ok) set({ brand: result.value, brandError: undefined });
  else set({ brandError: plainError(result.error) });
  return result.ok;
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
/** An image attached to an agent message (D184), kept in the project's .cache/agent-images/. */
export const agentImageUrl = (name: string) => serverUrl(AGENT_IMAGE_PATH, name);
/** The poster for a media item, from the server's token-protected route (never file://). */
export const thumbUrl = (id: string, path?: string) => serverUrl(THUMB_PATH, id, path);
/** The original file of a media item, streamed by the server with byte ranges (never file://). */
export const mediaUrl = (id: string, path?: string) => serverUrl(MEDIA_FILE_PATH, id, path);
/** A track of the bundled music library (D91), for the Audio tab's preview. */
export const musicUrl = (file: string) => serverUrl(MUSIC_FILE_PATH, file);
/** A sound of the bundled sound-effects pack (D134), for the Sound effects tab's preview. */
export const sfxUrl = (file: string) => serverUrl(SFX_FILE_PATH, file);
/** An online library hit's preview (D134), streamed through the server (only hits of a recent search). */
export const libraryPreviewUrl = (source: string, id: string) => serverUrl(LIBRARY_PREVIEW_PATH, `${source}/${id}`);
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
    // A remote export stays on its server (D109): Download brings it here.
    if (job.phase === "done" && !isRemote()) void bridge.showInFolder(job.output);
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
const call: Connection["call"] = (f, timeoutMs) =>
  connection ? connection.call(f, timeoutMs) : Promise.resolve({ ok: false, error: { _tag: "NotConnected", message: "Not connected to the server" } });

const refreshRecents = async () => {
  const recents = await call((c) => c["recents.list"]({}));
  if (recents.ok) set({ recents: recents.value });
};

/** server.hello: versions, the graphic secret, and for a remote its own home and default folder (D107). */
async function refreshHello() {
  const hello = await call((c) => c["server.hello"]({}));
  if (hello.ok) {
    set({ hello: hello.value, ...(isRemote() && hello.value.home ? { appInfo: { homeDir: hello.value.home, defaultParentDir: hello.value.defaultParentDir ?? hello.value.home } } : {}) });
  } else if (!isTransportError(hello.error)) set({ connectionMessage: plainError(hello.error) });
  return hello;
}

// While a remote isn't connected, ask the relay why (a refused token reads differently from a
// server that's down), so the banner can say so.
let statusTimer: ReturnType<typeof setInterval> | undefined;
function watchRemoteStatus() {
  if (statusTimer) return;
  statusTimer = setInterval(() => {
    if (state.connection === "connected") return void (state.environmentProblem && set({ environmentProblem: undefined }));
    void bridge.environmentStatus().then(({ problem }) => problem !== state.environmentProblem && set({ environmentProblem: problem }));
  }, 1500);
}

export async function start() {
  // Only Local's own server can exit under the window (the desktop doesn't report it for a remote).
  bridge.onServerExit((message) => !isRemote() && set({ connection: "server-exited", connectionMessage: message }));
  bridge.onMenuCommand(runCommand);
  window.addEventListener("keydown", onKeyDown);
  const [appInfo, server] = await Promise.all([bridge.appInfo(), bridge.getServerConnection().then((c) => ({ ok: true as const, c }), (e: Error) => ({ ok: false as const, e }))]);
  set({ appInfo });
  if (!server.ok) {
    // The active remote couldn't even be set up (its token unreadable): say so, with the way back to Local.
    void bridge.environments().then(({ active, environments }) => {
      const env = environments.find((e) => e.id === active);
      if (env) set({ environment: env });
    });
    set({ connection: "failed", connectionMessage: server.e.message, ready: true });
    return;
  }
  if (server.c.environment) set({ environment: server.c.environment });
  if (isRemote()) {
    watchRemoteStatus();
    // A remote that doesn't answer mustn't keep the splash up: show the screen (it says it's reconnecting).
    setTimeout(() => !state.ready && set({ ready: true }), 4000);
  }
  let firstSnapshot: () => void = () => {};
  const gotFirstSnapshot = new Promise<void>((resolve) => (firstSnapshot = resolve));
  serverConnection = server.c;
  const conn = connect(server.c, {
    // Every (re)connect resubscribes: the server re-sends the current project first.
    onConnect: () => {
      if (state.connection === "server-exited") return;
      set({ connection: "connected", environmentProblem: undefined, notice: state.notice?.transport ? undefined : state.notice });
      void actions.loadContributions();
      // A remote that restarted may be another version; a late first connect has no hello yet.
      if (isRemote() || !state.hello) void refreshHello();
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
          const was = state.agent?.running ?? null;
          set({ agent });
          applyAgentUi(agent);
          // A turn ended: it may have written a kit's style guide (D186).
          if (was !== null && agent?.running == null) void actions.brandGet();
          // The turn ended: the queued message goes now (D140).
          const queued = state.agentQueued;
          if (queued && was !== null && agent?.running === null) {
            set({ agentQueued: undefined });
            void actions.agentSend(queued.prompt, queued.mentions, queued.images).then((ok) => {
              if (!ok && !state.agentDraft) set({ agentDraft: queued.prompt, agentMentions: queued.mentions, agentImages: queued.images ?? [] });
            });
          }
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
      void actions.brandGet();
    },
    onDisconnect: () => {
      if (state.connection !== "server-exited") set({ connection: "reconnecting" });
    },
  });
  connection = conn;
  await refreshHello();
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
// U12 (D178): asked before leaving the project or the environment; state/leave.tsx sets it (it
// imports this module, so it registers itself instead of being imported here).
type LeaveGate = (reason: "close-project" | "open-project" | "new-project" | "environment") => Promise<boolean>;
let confirmLeave: LeaveGate = () => Promise.resolve(true);
export const setLeaveGate = (gate: LeaveGate) => void (confirmLeave = gate);

// Project changes sent and not answered yet, and item edits queued behind them (U12: leaving waits for them).
let inflight = 0;
let queuedEdits = 0;
export const pendingSaves = () => inflight + queuedEdits;

async function change(run: Parameters<Connection["call"]>[0], { inline = false } = {}): Promise<CallError | undefined> {
  inflight++;
  let result: Result<ProjectSnapshot>;
  try {
    result = (await call(run)) as Result<ProjectSnapshot>;
  } finally {
    inflight--;
  }
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
  playback.seek(planned.show ?? planned.start);
  // F20 (D158): the timeline scrolls to show what was added.
  revealItem(planned.itemId);
}

/** Scroll the timeline so an item is in view (after it was added somewhere off screen). */
export function revealItem(itemId: string) {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-testid=timeline-item][data-item="${CSS.escape(itemId)}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
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
  queuedEdits++;
  let started = false;
  const run = async () => {
    if (!started) (started = true, queuedEdits--);
    while (adding) await settled();
    const snapshot = state.snapshot;
    if (!snapshot || (origin.dir !== undefined && origin.dir !== snapshot.dir)) return false;
    return timelineEdit(makePlan(projectOf(snapshot)), origin);
  };
  const next = itemChain.then(run, run);
  itemChain = next.catch(() => undefined);
  return next;
}

// ---- the remote file browser (D107) and uploads (D108) ----

let pickerSeq = 0;
let pickerAnswer: ((value: string | ReadonlyArray<string> | null) => void) | undefined;
/** Opens the remote file browser; resolves with what was picked (a path, paths for "media"), or null. */
function pickRemote(purpose: PickerPurpose, opts: { start?: string | undefined; fileName?: string | undefined } = {}): Promise<string | ReadonlyArray<string> | null> {
  pickerAnswer?.(null);
  return new Promise((resolve) => {
    pickerAnswer = resolve;
    set({ remotePicker: { purpose, start: opts.start, fileName: opts.fileName, seq: ++pickerSeq } });
  });
}
/** A folder: the native dialog on Local, the server's disk on a remote. */
async function chooseFolder(purpose: "parent" | "project" | "plugin"): Promise<string | null> {
  if (!isRemote()) return bridge.chooseFolder(purpose);
  const picked = await pickRemote(purpose);
  return typeof picked === "string" ? picked : null;
}

/** A URL on the active server (through the relay when remote) with the window's token. */
const apiUrl = (route: string, params: Record<string, string> = {}) => {
  if (!serverConnection) return undefined;
  const url = new URL(serverConnection.url.replace(/^ws/, "http"));
  url.pathname = route;
  url.search = "";
  url.searchParams.set(TOKEN_QUERY_PARAM, serverConnection.token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.href;
};

/** One file up to the open remote project's media/uploads/ (D108): its path there, or why not. */
async function uploadOne(file: File): Promise<{ readonly path: string } | { readonly message: string }> {
  const url = apiUrl(UPLOAD_PATH, { name: file.name });
  if (!url) return { message: "Not connected to the server." };
  try {
    const res = await fetch(url, { method: "POST", body: file, headers: { "content-type": "application/octet-stream" } });
    const text = await res.text();
    if (!res.ok) return { message: text.trim() || `The server answered ${res.status}.` };
    const path = (JSON.parse(text) as { path?: unknown }).path;
    return typeof path === "string" ? { path } : { message: "The server's answer had no path." };
  } catch (error) {
    // A folder (or a file that went away) can't be read as a body.
    return { message: file.size === 0 && file.type === "" ? "Folders can't be uploaded; drop the files inside." : `The upload stopped: ${(error as Error).message}` };
  }
}

/** A speed change (G9, D125); with linked overlays on (F11, D156), what's over a main clip follows its footage. */
export function speedPlan(project: ProjectModel, itemId: string, speed: number, keepPitch?: boolean): Plan | { readonly problem: string } {
  const plan = planSetSpeed(project, itemId, speed, keepPitch);
  if ("problem" in plan || !getPlayback().linkOverlays || findItem(project, itemId)?.track.role !== "main") return plan;
  return withOverlayRipple(project, plan);
}

export const actions = {
  showNewProject: () => set({ newProjectOpen: true }),
  hideNewProject: () => set({ newProjectOpen: false }),

  chooseParentFolder: () => chooseFolder("parent"),

  // ---- environments (D106) ----
  async openEnvironments() {
    set({ environmentsOpen: true });
    await actions.loadEnvironments();
  },
  closeEnvironments: () => set({ environmentsOpen: false }),
  async loadEnvironments() {
    const { environments } = await bridge.environments();
    set({ environments });
  },
  /** Adds a remote (after a passing test); undefined, or why not. */
  async addEnvironment(input: { name: string; url: string; token: string }): Promise<string | undefined> {
    const result = await bridge.addEnvironment(input);
    if ("problem" in result) return result.problem;
    await actions.loadEnvironments();
    return undefined;
  },
  testEnvironment: (input: { url: string; token: string } | { id: string }): Promise<EnvironmentTest> => bridge.testEnvironment(input),
  async renameEnvironment(id: string, name: string) {
    await bridge.renameEnvironment(id, name);
    await actions.loadEnvironments();
    if (id === state.environment.id && name.trim()) set({ environment: { ...state.environment, name: name.trim() } });
  },
  async removeEnvironment(id: string) {
    // Removing the one on screen goes back to Local (the window reloads): ask first (U12).
    if (id === state.environment.id && !(await confirmLeave("environment"))) return;
    await bridge.removeEnvironment(id);
    await actions.loadEnvironments();
  },
  /** The window reloads into the other environment: nothing carries over (D106). */
  async switchEnvironment(id: string): Promise<boolean> {
    if (id === state.environment.id || !(await confirmLeave("environment"))) return false;
    return bridge.switchEnvironment(id);
  },

  // ---- the remote file browser (D107) ----
  listFolder: async (dir?: string): Promise<{ readonly listing: FileListing } | { readonly problem: string }> => {
    const result = await call((c) => c["files.list"](dir ? { dir } : {}));
    return result.ok ? { listing: result.value } : { problem: plainError(result.error) };
  },
  /** The browser's answer: a path, paths ("media"), or null when cancelled. */
  answerPicker(value: string | ReadonlyArray<string> | null) {
    const answer = pickerAnswer;
    pickerAnswer = undefined;
    set({ remotePicker: undefined });
    answer?.(value);
  },
  /**
   * Local files into a remote project (D108): each goes up into media/uploads/, then they're
   * imported from there as one job, as a drop on Local imports in place.
   */
  async uploadAndImport(files: ReadonlyArray<File>, drop?: { frame: number; track?: string | undefined }) {
    if (!files.length || !state.snapshot || !online() || state.uploading) return;
    if (!activeJobs(state).length) set({ importReport: undefined });
    const dir = state.snapshot.dir;
    const paths: Array<string> = [];
    const failed: Array<{ path: string; message: string }> = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      set({ uploading: { total: files.length, done: i, name: file.name } });
      const result = await uploadOne(file);
      if ("path" in result) paths.push(result.path);
      else failed.push({ path: file.name, message: result.message });
    }
    set({ uploading: undefined });
    // The project changed meanwhile: the files are in the old one's media/uploads/, not imported here.
    if (paths.length && state.snapshot?.dir === dir) {
      const where = drop ? { drop: { frame: Math.max(0, Math.round(drop.frame)), ...(drop.track ? { track: drop.track } : {}) } } : {};
      const result = await call((c) => c["media.import"]({ paths, ...where }));
      if (!result.ok) failed.push(...paths.map((path) => ({ path, message: plainError(result.error) })));
    }
    if (failed.length) set({ importReport: { failed: [...(state.importReport?.failed ?? []), ...failed], skipped: state.importReport?.skipped ?? [] } });
  },
  /** D109: a finished remote export, downloaded to a path picked on this Mac. */
  async downloadExport(job: ExportJob) {
    if (state.downloads[job.id] && "state" in state.downloads[job.id]!) return;
    set({ downloads: { ...state.downloads, [job.id]: { state: "running" } } });
    const name = job.output.slice(job.output.lastIndexOf("/") + 1) || "Export.mp4";
    let result: { readonly path: string } | { readonly error: string } | null;
    try {
      result = await bridge.downloadExport(job.id, name);
    } catch (error) {
      result = { error: (error as Error).message };
    }
    const { [job.id]: _running, ...rest } = state.downloads;
    set({ downloads: result ? { ...rest, [job.id]: result } : rest });
  },
  /** Finder, for a path on this Mac (a downloaded export). */
  revealLocal: (path: string) => bridge.showInFolder(path),

  /** Creates and opens the project (replacing any open one); returns the error for the form. */
  async createProject(input: { parentDir: string; name: string; canvas: Canvas }): Promise<string | undefined> {
    // It replaces the open project: ask first when that one has work in progress (U12).
    if (state.snapshot && !(await confirmLeave("new-project"))) return undefined;
    const result = await call((c) => c["project.create"](input));
    if (result.ok) {
      // U14 (D180): a new project opens on the Agent tab.
      rememberSideTab(result.value.dir, "agent");
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
    if (state.snapshot && state.snapshot.dir !== dir && !(await confirmLeave("open-project"))) return;
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
    const dir = await chooseFolder("project");
    if (dir) await actions.openProject(dir);
  },

  async closeProject() {
    if (!state.snapshot) return;
    if (!(await confirmLeave("close-project"))) return;
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
  /** The sound library's sources and limit (D134). */
  async libraryState(): Promise<LibraryState | undefined> {
    const result = await call((c) => c["library.state"]({}));
    return result.ok ? result.value : undefined;
  },
  /** An online search (D134): the result, or the error in words. */
  async searchLibrary(query: LibraryQuery): Promise<LibrarySearchResult | { readonly error: string }> {
    const result = await call((c) => c["library.search"]({ kind: query.kind, query: query.query, ...(query.source ? { source: query.source } : {}), ...(query.license ? { license: query.license } : {}), ...(query.length ? { length: query.length } : {}), ...(query.songs ? { songs: true } : {}), ...(query.page ? { page: query.page } : {}) }));
    return result.ok ? result.value : { error: plainError(result.error) };
  },
  /**
   * Library sound → the timeline (D134): the server downloads it into the project's media/ (or
   * copies a bundled sound effect, id sfx:<id>) unless it's there already, then the media (with its
   * credits) and the item go in as one edit, at the playhead on a free audio track.
   */
  async addLibrarySound(id: string, music: boolean, name: string) {
    if (!state.snapshot || !online() || adding || musicAdding) return;
    musicAdding = true;
    set({ libraryAdding: id });
    try {
      const existing = libraryMediaOf(projectOf(state.snapshot), id);
      let sound = { libraryId: id, name: existing?.name ?? name, seconds: (existing?.probe?.frames ?? 0) / projectOf(state.snapshot).canvas.fps, music } as Parameters<typeof planAddLibrarySound>[1];
      if (!existing) {
        const result = await call((c) => c["library.add"]({ id }));
        if (!result.ok) return set({ notice: { text: plainError(result.error), transport: isTransportError(result.error) } });
        sound = { ...sound, name: result.value.name, path: result.value.path, seconds: result.value.seconds, source: result.value.source };
      }
      await addPlanned((project) => planAddLibrarySound(project, sound, getPlayback().frame));
    } finally {
      musicAdding = false;
      set({ libraryAdding: undefined });
    }
  },
  /** Open a panel as the agent's ui_show does. */
  openPanel: (panel: AgentUiPanel) => set({ panelRequest: { panel, seq: ++panelSeq } }),
  /** Text tab preset → a text item at the playhead (see planAddText). */
  /** Text tab → a preset at the playhead (or the dropped frame), placed where it was dropped on the canvas (D80). */
  addText: (preset: TextPreset, opts: { at?: { x: number; y: number }; frame?: number } = {}) => addPlanned((project) => planAddText(project, preset, opts.frame ?? getPlayback().frame, opts.at)),
  /** A planned move or trim from the timeline (see edit.ts). */
  timelineEdit,
  /** A text or background change from the Inspector or the preview (see text.ts). */
  itemEdit,
  /** Elements tab → a component at the playhead, or where it was dropped (see planAddComponent, D76). */
  addComponent: (id: string, opts: { at?: { x: number; y: number }; frame?: number; props?: Record<string, unknown> } = {}) =>
    addPlanned((project) => planAddComponent(project, id, opts.frame ?? getPlayback().frame, { ...(opts.at ? { at: opts.at } : {}), ...(opts.props ? { props: opts.props } : {}) })),
  /** Elements tab → a plugin's component (D103): the server copies it into graphics/, then a graphic item at the playhead. */
  async addPluginComponent(id: string) {
    if (adding || !state.snapshot || !online()) return;
    const result = await call((c) => c["plugins.addComponent"]({ id }));
    if (!result.ok) return set({ notice: { text: plainError(result.error) } });
    const { src, name, props } = result.value;
    await addPlanned((project) => planAddGraphic(project, { src, name, props: (props ?? {}) as Record<string, unknown>, idBase: id.split(".").at(-1) ?? "graphic" }, getPlayback().frame));
  },
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
    // D133: the panel's length for all, when one is chosen (else the transition's default).
    const seconds = transitionSeconds();
    const ok = await timelineEdit(planSetTransition(project, target, { module, ...(seconds ? { duration: Math.round(seconds * project.canvas.fps) } : {}) }));
    if (ok || findItem(project, target)?.item.transitionIn?.module === module) playback.selectCut(target);
    return ok;
  },
  /** Change (or with null remove) the transition at the cut before main item `itemId`. */
  setTransition: (itemId: string, next: { module: string; duration?: number } | null, origin?: { baseRevision?: number; dir?: string }) =>
    state.snapshot ? timelineEdit(planSetTransition(projectOf(state.snapshot), itemId, next), origin) : Promise.resolve(false),
  toggleTrack: (trackId: string, flag: TrackFlag) => (state.snapshot ? timelineEdit(planTrackFlag(projectOf(state.snapshot), trackId, flag)) : undefined),
  /** Media dropped on a lane (T1, D122): at the drop frame on that lane when it takes it (see planDropMedia). */
  dropMedia: (mediaId: string, at: { frame: number; track?: string | undefined }) => addPlanned((project) => planDropMedia(project, mediaId, at)),
  /** Detach audio (T3, D123): the clip's sound to its own audio item, the clip muted; the new item is selected. */
  async detachAudio(itemId: string) {
    if (!state.snapshot) return;
    const project = projectOf(state.snapshot);
    const plan = planDetachAudio(project, itemId, takenIds(project));
    if (await timelineEdit(plan)) playback.select("itemId" in plan ? plan.itemId : undefined);
  },
  /**
   * Effects tab (D136): "look:<id>" puts a look on the clip ("look:" takes it off), "effect:<module>"
   * adds an effect; on `itemId` (a drop) or else the selected clip. With several items selected
   * (and the drop on one of them), on every selected clip, as one edit (F2, D147).
   */
  applyFx: (what: string, itemId?: string) =>
    itemEdit((project) => {
      const { selected, also } = getPlayback();
      const selection = selected === undefined ? [] : [selected, ...also];
      const targets = itemId === undefined ? selection : selection.length > 1 && selection.includes(itemId) ? selection : [itemId];
      const [kind, id = ""] = what.split(/:(.*)/s);
      const custom = kind === "look" ? state.contributions?.filters?.find((f) => f.id === id) : undefined;
      const one = (p: ProjectModel, target: string) => (kind === "look" ? planSetLook(p, target, id || undefined, custom ? { custom: custom.look as LookDef, label: custom.name } : {}) : planEffect(p, target, id));
      if (targets.length <= 1) return one(project, targets[0] ?? "");
      const look = lookInfo(id)?.name ?? custom?.name ?? id;
      const effect = effectInfo(id)?.name.toLowerCase() ?? id;
      return planForAll(project, targets, one, (n) => (kind !== "look" ? `Add ${effect} to ${n} clips` : id ? `Filter ${look} on ${n} clips` : `Remove the filter from ${n} clips`));
    }),
  /** Speed (G9, D125): presets and custom, keep pitch or not; the item's length follows. */
  setSpeed: (itemId: string, speed: number, keepPitch?: boolean) => itemEdit((project) => speedPlan(project, itemId, speed, keepPitch)),
  /** Rename a timeline item (T7): its own name, shown on the timeline and in the Inspector; "" goes back to the media's. */
  renameItem: (itemId: string, name: string) => itemEdit(() => ({ ops: [{ op: "update_item", item: itemId, set: { name: name.trim() ? name.trim() : null } }], summary: name.trim() ? `Rename ${itemId} to ${name.trim()}` : `Reset the name of ${itemId}` })),
  renameTrack: (trackId: string, name: string) => (name.trim() ? itemEdit(() => ({ ops: [{ op: "update_track", track: trackId, set: { name: name.trim() } }], summary: `Rename track to ${name.trim()}` })) : Promise.resolve(false)),
  /** G4: a media item's display name (its file stays where it is), shown everywhere it appears. */
  renameMedia: (mediaId: string, name: string) => (name.trim() ? itemEdit(() => ({ ops: [{ op: "update_media", media: mediaId, set: { name: name.trim() } }], summary: `Rename media to ${name.trim()}` })) : Promise.resolve(false)),
  /** F8 (D167): a media out of the project with every item using it, in one edit (core planRemoveMedia); its file stays on disk. */
  removeMedia: (mediaId: string) => itemEdit((project) => planRemoveMedia(project, mediaId)),
  /** F27 (D169): a sound trimmed or looped to the end of the picture, with a fade out (core planFitToVideo). */
  fitToVideo: (itemId: string) =>
    itemEdit((project) => {
      const plan = planFitToVideo(project, itemId);
      return "ops" in plan && !plan.ops.length ? { problem: "The sound already fits the video." } : plan;
    }),
  /** Group or ungroup items (F19, D157): see planGrouping. */
  grouping: (ids: ReadonlyArray<string>, group: boolean) => itemEdit((project) => planGrouping(project, ids, group)),
  /** Bring forward / Send backward (F15, D151): one layer up or down (see planLayer). */
  layer: (itemId: string, dir: -1 | 1) => itemEdit((project) => planLayer(project, itemId, dir)),
  /** Reset position (F15, D151): see planResetPosition. */
  resetPosition: (itemId: string) => itemEdit((project) => planResetPosition(project, itemId)),
  /** Ripple delete (T7): delete and close the gaps on their tracks. */
  async rippleDelete(ids: ReadonlyArray<string>) {
    if (!state.snapshot) return;
    if (await timelineEdit(planRippleDelete(projectOf(state.snapshot), ids))) playback.select(undefined);
  },
  /** Mute or lock one item (T7): mute silences a clip or audio item (D123), lock keeps hands and the agent off it. */
  toggleItem: (itemId: string, flag: "mute" | "locked") =>
    itemEdit((project) => {
      const item = findItem(project, itemId)?.item;
      if (!item) return { problem: "That item isn't in the project any more." };
      const on = !item[flag];
      return { ops: [{ op: "update_item", item: itemId, set: { [flag]: on ? true : null } }], summary: `${flag === "mute" ? (on ? "Mute" : "Unmute") : on ? "Lock" : "Unlock"} ${item.name ?? itemId}` };
    }),
  /** Replace media (T7): the clip plays another media file of the project from its start, as long as it was (or as the file is). */
  replaceMedia: (itemId: string, mediaId: string) =>
    itemEdit((project) => {
      const placed = findItem(project, itemId);
      const media = project.media.find((m) => m.id === mediaId);
      if (!placed || !media) return { problem: "That media isn't in the project any more." };
      const frames = media.kind === "image" ? undefined : media.probe?.frames;
      const duration = frames && !placed.item.loop ? Math.max(1, Math.min(placed.item.duration, Math.floor(frames / (placed.item.speed ?? 1)))) : placed.item.duration;
      return { ops: [{ op: "update_item", item: itemId, set: { media: mediaId, in: media.kind === "image" ? null : 0, duration, ...(media.kind === "image" ? { speed: null } : {}) } }], summary: `Replace the media of ${itemId} with ${media.name}` };
    }),
  /** Add an empty track (T7): video and text tracks go on top (or just above `near`), audio at the bottom (or just below `near`). */
  addTrack: (kind: "video" | "text" | "audio", near?: string) =>
    itemEdit((project) => {
      const base = kind === "audio" ? "Audio" : kind === "text" ? "Text" : "Video";
      const used = new Set(project.tracks.map((t) => t.name));
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base} ${n}`;
      const at = near !== undefined ? project.tracks.findIndex((t) => t.id === near) : -1;
      const nearTrack = at >= 0 ? project.tracks[at] : undefined;
      const sameSide = nearTrack && (nearTrack.kind === "audio") === (kind === "audio");
      const index = sameSide ? (kind === "audio" ? at + 1 : at) : kind === "audio" ? project.tracks.length : 0;
      const id = uniqueId(project, `${kind}-track`);
      return { ops: [{ op: "add_track", track: { id, kind, name }, index }], summary: `Add ${name} track` };
    }),
  /** Delete a track and what's on it (T7), as one edit. */
  deleteTrack: (trackId: string) =>
    itemEdit((project) => {
      const track = project.tracks.find((t) => t.id === trackId);
      if (!track) return { problem: "That track isn't in the project any more." };
      if (track.role === "main") return { problem: "The main track can't be deleted." };
      return { ops: [{ op: "delete_track", track: trackId }], summary: `Delete track ${track.name}` };
    }),
  /** Show in Media (T7): the Media tab with the tile scrolled into view and flashed. */
  showInMedia(mediaId: string) {
    set({ panelRequest: { panel: "media" as AgentUiPanel, seq: ++panelSeq }, mediaFocus: { id: mediaId, seq: ++panelSeq } });
  },
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

  // A remote's paths aren't on this Mac: there is no Finder to show them in (D109).
  showInFolder: (path: string) => (isRemote() ? Promise.resolve() : bridge.showInFolder(path)),

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
  async importMedia(paths?: ReadonlyArray<string>, drop?: { frame: number; track?: string | undefined }) {
    const picked = paths ?? (isRemote() ? await pickRemote("media") : await bridge.chooseMedia());
    const chosen = Array.isArray(picked) ? picked : [];
    const absolute = chosen.filter((p) => typeof p === "string" && p.startsWith("/"));
    if (absolute.length === 0) return;
    if (!activeJobs(state).length) set({ importReport: undefined });
    // T9 (D128): dropped on the timeline, the import puts them there in the same edit.
    const where = drop ? { drop: { frame: Math.max(0, Math.round(drop.frame)), ...(drop.track ? { track: drop.track } : {}) } } : {};
    const result = await call((c) => c["media.import"]({ paths: absolute, ...where }));
    if (!result.ok) set({ importReport: { failed: absolute.map((path) => ({ path, message: plainError(result.error) })), skipped: [] } });
  },
  dismissImportReport: () => set({ importReport: undefined }),

  dismissNotice: () => set({ notice: undefined }),

  /** Start an agent turn; returns false (and says why in the Agent tab) when it didn't start. */
  async agentSend(prompt: string, mentions: ReadonlyArray<AgentMention> = [], images: ReadonlyArray<AgentImage> = [], opts: { readonly access?: AgentAccess } = {}): Promise<boolean> {
    if (!online()) return false;
    set({ agentError: undefined });
    // The agent works on what's on screen: stop playback so the frame it's told about stays put.
    playback.pause();
    const { frame, selected } = getPlayback();
    // Only the chips whose @label is still in the prompt.
    const kept = mentions.filter((m, i) => prompt.includes(`@${m.label}`) && mentions.findIndex((x) => x.kind === m.kind && x.id === m.id && x.label === m.label) === i);
    // The composer's choices for this project (D184): model, effort, access.
    const prefs = state.snapshot ? agentPrefs(state.snapshot.dir) : DEFAULT_AGENT_PREFS;
    const result = await call((c) =>
      c["agent.send"]({
        prompt,
        frame: Math.floor(frame),
        ...(selected ? { selected } : {}),
        ...(kept.length ? { mentions: kept } : {}),
        ...(prefs.model ? { model: prefs.model } : {}),
        ...(prefs.effort ? { effort: prefs.effort } : {}),
        access: opts.access ?? prefs.access,
        ...(images.length ? { images: [...images] } : {}),
        // D188: Settings › App › Agent, remembered on this Mac.
        ...(skipStoryboardSetting() ? { skipStoryboard: true } : {}),
      }),
    );
    if (result.ok) return true;
    set({ agentError: plainError(result.error) });
    // "Not installed" may be news to the setup rows too.
    if (result.error.reason === "not-installed") void actions.checkSetup();
    return false;
  },
  agentCancel: () => call((c) => c["agent.cancel"]({})),
  /** The composer's text and chips (D140). */
  setAgentDraft: (agentDraft: string, agentMentions?: ReadonlyArray<AgentMention>) => set({ agentDraft, ...(agentMentions ? { agentMentions } : {}) }),
  /** Hold a message until the running turn ends (D140); undefined takes it back. */
  agentQueue: (queued: { prompt: string; mentions: ReadonlyArray<AgentMention>; images?: ReadonlyArray<AgentImage> } | undefined) => set({ agentQueued: queued }),
  /** The composer's attached images (D184). */
  setAgentImages: (agentImages: ReadonlyArray<AgentImage>) => set({ agentImages }),
  /** Add a moment (D183) or the In/Out range of the timeline to the chat, as a chip with its timecode. */
  addMomentToChat(frame: number) {
    const snap = state.snapshot;
    if (!snap) return;
    const label = momentLabel(Math.max(0, Math.floor(frame)), projectOf(snap).canvas.fps);
    actions.addToChat({ kind: "moment", id: `frame:${Math.floor(frame)}`, label, frame: Math.max(0, Math.floor(frame)) });
  },
  addRangeToChat(start: number, end: number) {
    const snap = state.snapshot;
    if (!snap || end <= start) return;
    const fps = projectOf(snap).canvas.fps;
    const label = `${momentLabel(start, fps)}–${momentLabel(end, fps)}`;
    actions.addToChat({ kind: "range", id: `range:${start}-${end}`, label, range: { start: Math.floor(start), end: Math.floor(end) } });
  },
  /** Add to chat (D141) for a timeline item: its name, with the stretch of the timeline it covers. */
  addItemToChat(itemId: string, frame?: number) {
    const snap = state.snapshot;
    const placed = snap ? findItem(projectOf(snap), itemId) : undefined;
    if (!snap || !placed) return;
    actions.addToChat({ kind: "item", id: itemId, label: itemName(projectOf(snap) as never, placed.item as never), range: { start: Math.round(placed.start), end: Math.round(placed.start + placed.item.duration) }, ...(frame !== undefined ? { frame: Math.floor(frame) } : {}) });
  },
  /** Add to chat (D141): a chip at the end of the composer, the Agent tab open, the caret there. */
  addToChat(mention: AgentMention) {
    const draft = state.agentDraft;
    const sep = draft && !/\s$/.test(draft) ? " " : "";
    set({
      agentDraft: `${draft}${sep}@${mention.label} `,
      // The same thing twice is one chip: what each add knew (a frame, a range) is kept.
      agentMentions: [
        ...state.agentMentions.filter((m) => !(m.kind === mention.kind && m.id === mention.id && m.label === mention.label)),
        { ...state.agentMentions.find((m) => m.kind === mention.kind && m.id === mention.id && m.label === mention.label), ...mention },
      ],
      agentFocus: state.agentFocus + 1,
      panelRequest: { panel: "agent", seq: ++panelSeq },
    });
  },
  /** Allow or Don't on the running turn's approval card (D99). */
  /** Whether the server took the answer (false: the card was no longer open). */
  async agentApprove(id: string, allow: boolean, source?: string, extra: { readonly answer?: AgentAnswer; readonly beats?: ReadonlyArray<StoryboardBeat>; readonly note?: string } = {}): Promise<boolean> {
    const result = await call((c) => c["agent.approve"]({ id, allow, ...(source ? { source } : {}), ...(extra.answer ? { answer: extra.answer } : {}), ...(extra.beats ? { beats: [...extra.beats] } : {}), ...(extra.note ? { note: extra.note } : {}) }));
    return result.ok && result.value.accepted;
  },
  /** D188: the user's own brief or storyboard (approved on the Plan card); false with the reason in the Agent tab when it didn't save. */
  async agentPlanSave(input: { readonly brief?: Brief; readonly storyboard?: Storyboard }): Promise<boolean> {
    const result = await call((c) => c["agent.planSave"]({ ...(input.brief ? { brief: input.brief } : {}), ...(input.storyboard ? { storyboard: input.storyboard } : {}) }));
    if (!result.ok) set({ agentError: plainError(result.error) });
    return result.ok;
  },
  /** D144: the take an allowed screen_record recorded (uploaded), or why there's none. */
  agentScreenTake: (id: string, answer: { readonly path?: string; readonly source?: string; readonly problem?: string }) => call((c) => c["agent.screenTake"]({ id, ...answer })),
  /** D144: a take's file up to the active server's media/uploads/ (the agent's screen_record imports it). */
  async uploadTake(blob: Blob, kind: TakeKind): Promise<{ readonly path: string } | { readonly message: string }> {
    const ext = blob.type.startsWith("audio/") ? "webm" : blob.type.includes("mp4") ? "mp4" : "webm";
    return uploadOne(new File([blob], takeUploadName(kind, ext), { type: blob.type }));
  },
  async agentUndoTurn(turnId: string) {
    set({ agentError: undefined });
    const result = (await call((c) => c["agent.undoTurn"]({ turnId }))) as Result<ProjectSnapshot>;
    if (result.ok) applyFromCall(result.value);
    else if (result.error.reason === "changed-on-disk") set({ changedOnDisk: true, reloadProblem: undefined });
    else set({ agentError: plainError(result.error) });
  },
  dismissAgentError: () => set({ agentError: undefined }),

  // ---- brand kits and skills (D186) ----
  /** Reads the brand state again (the project's kits and skills, the user's, and its choice). */
  async brandGet() {
    const result = await call((c) => c["brand.get"]({}));
    if (result.ok) set({ brand: result.value });
    else if (!isTransportError(result.error)) set({ brandError: plainError(result.error) });
  },
  /** Each brand change answers with the whole state; true when it was taken. */
  async brandSaveKit(kit: BrandKit) {
    return brandResult(await call((c) => c["brand.saveKit"]({ kit })));
  },
  async brandDeleteKit(id: string, scope: BrandScope) {
    return brandResult(await call((c) => c["brand.deleteKit"]({ id, scope })));
  },
  async brandSaveSkill(skill: BrandSkill) {
    return brandResult(await call((c) => c["brand.saveSkill"]({ skill })));
  },
  async brandDeleteSkill(id: string, scope: BrandScope) {
    return brandResult(await call((c) => c["brand.deleteSkill"]({ id, scope })));
  },
  async brandSetActive(active: BrandActive) {
    // Shown at once, so a second change made before the answer builds on this one, not the old state.
    if (state.brand) set({ brand: { ...state.brand, active } });
    return brandResult(await call((c) => c["brand.setActive"]({ kit: active.kit, skills: [...active.skills] })));
  },
  /** Copies a file into a kit's folder; its name there, or undefined (the reason in brandError). */
  async brandAddFile(kit: string, scope: BrandScope, path: string): Promise<string | undefined> {
    const result = await call((c) => c["brand.addFile"]({ kit, scope, path }));
    if (!result.ok) return void set({ brandError: plainError(result.error) });
    set({ brand: result.value.state, brandError: undefined });
    return result.value.name;
  },
  /** Files for a kit (logos, examples, a reference): the native dialog here, the server's disk on a remote. */
  async pickBrandFiles(): Promise<ReadonlyArray<string>> {
    const picked = isRemote() ? await pickRemote("media") : await bridge.chooseMedia();
    return picked === null ? [] : typeof picked === "string" ? [picked] : picked;
  },
  dismissBrandError: () => set({ brandError: undefined }),

  /** ⌘E / the Export button: the export dialog, with ffmpeg checked (it shows the fix when missing). */
  openExport() {
    if (!state.snapshot) return;
    set({ exportOpen: true });
    if (state.setupChecks?.find((c) => c.id === "ffmpeg")?.status !== "ready") void actions.checkSetup();
  },
  closeExport: () => set({ exportOpen: false }),
  async chooseExportPath(defaultPath: string): Promise<string | null> {
    if (!isRemote()) return bridge.chooseSavePath(defaultPath);
    const cut = defaultPath.lastIndexOf("/");
    const picked = await pickRemote("save", { start: cut > 0 ? defaultPath.slice(0, cut) : undefined, fileName: defaultPath.slice(cut + 1) });
    return typeof picked === "string" ? picked : null;
  },
  /** Starts an export of the open project; returns the server's refusal (exists, no ffmpeg…) if any. */
  async startExport(input: { output: string; quality: ExportQuality; loudness: ExportLoudness; targetLufs?: number; overwrite?: boolean; subtitles?: ExportSubtitles; burnCaptions?: boolean; range?: { from: number; to: number }; video?: { codec?: "h264" | "hevc"; bitrateMbps?: number; shortSide?: number; fps?: number } }): Promise<{ readonly reason?: string; readonly message: string } | undefined> {
    const result = await call((c) => c["export.start"](input));
    if (!result.ok) return { reason: (result.error as { reason?: string }).reason, message: plainError(result.error) };
    revealWhenDone.add(result.value.jobId);
    set({ exportJobId: result.value.jobId, exportFolder: input.output.slice(0, input.output.lastIndexOf("/")) || "/" });
    return undefined;
  },
  cancelExport: (jobId: string) => call((c) => c["export.cancel"]({ jobId })),
  /** D105: just the subtitles as a .srt / .vtt file; the saved file, or the server's refusal. */
  async exportSubtitles(input: { output: string; overwrite?: boolean }): Promise<{ readonly path: string; readonly cues: number } | { readonly reason?: string; readonly message: string }> {
    const result = await call((c) => c["export.subtitles"](input));
    if (!result.ok) return { reason: (result.error as { reason?: string }).reason, message: plainError(result.error) };
    set({ exportFolder: input.output.slice(0, input.output.lastIndexOf("/")) || "/" });
    return result.value;
  },

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

  /** Settings (G8): Project when a project is open, else App. */
  openSettings(section?: SettingsSection) {
    set({ settingsOpen: true, shortcutsOpen: false, settingsSection: section ?? (state.snapshot ? state.settingsSection : state.settingsSection === "project" ? "app" : state.settingsSection) });
  },
  closeSettings: () => set({ settingsOpen: false }),
  openShortcuts: () => set({ shortcutsOpen: true }),
  closeShortcuts: () => set({ shortcutsOpen: false }),
  openSetup() {
    set({ setupOpen: true, setupFocus: undefined, settingsOpen: false });
    void actions.checkSetup();
    void actions.listKeys();
  },
  async checkSetup() {
    set({ setupChecking: true, setupError: undefined });
    void actions.listPlugins();
    const result = await call((c) => c["setup.check"]({}));
    if (result.ok) set({ setupChecking: false, setupChecks: result.value });
    else set({ setupChecking: false, setupError: `Couldn't check ${isRemote() ? state.environment.name : "this Mac"}. ${plainError(result.error)}` });
  },
  async loadContributions() {
    const result = await call((c) => c["plugins.contributions"]({}));
    if (result.ok) set({ contributions: result.value });
  },
  /** Settings › Plugins › Browse (D103): the catalog of plugins that ship with Uncut, off until enabled. */
  async loadCatalog() {
    const result = await call((c) => c["plugins.catalog"]({}));
    if (result.ok) set({ pluginCatalog: result.value });
  },
  /** Enables a catalog plugin (a copy into Uncut's plugins folder), then opens its approval dialog. */
  async enablePlugin(id: string) {
    set({ pluginInstalling: true, pluginInstallError: undefined, pluginInstallNote: undefined, pluginError: undefined });
    const result = await call((c) => c["plugins.enable"]({ id }));
    if (result.ok) {
      set({ pluginInstalling: false, plugins: result.value.plugins, pluginInstallNote: result.value.note, pluginDialog: result.value.plugins.some((p) => p.id === result.value.id && p.status === "needs-approval") ? result.value.id : undefined });
    } else set({ pluginInstalling: false, pluginError: plainError(result.error) });
    void actions.loadCatalog();
  },
  /** Disables a catalog plugin: its copy and approval go (plugins.uninstall). */
  async disablePlugin(id: string) {
    set({ pluginError: undefined });
    const result = await call((c) => c["plugins.disable"]({ id }));
    if (result.ok) set({ plugins: result.value, pluginDialog: undefined });
    else set({ pluginError: plainError(result.error) });
    void actions.loadCatalog();
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
    const dir = await chooseFolder("plugin");
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
  async startCapture(device: string, options: CaptureOptions = {}) {
    set({ captureError: undefined, captureSaved: undefined, captureBusy: [...(state.captureBusy ?? []), device] });
    const result = await call((c) => c["capture.start"]({ device, ...options }));
    set({ captureBusy: (state.captureBusy ?? []).filter((d) => d !== device) });
    if (!result.ok) set({ captureError: plainError(result.error) });
    await actions.checkCapture();
  },
  /**
   * D143: a take that replays a saved flow; it ends with the flow and lands in Media as one edit.
   * The row shows its timer while the flow runs (the server lists it as recording).
   */
  async recordFlow(device: string, flow: string, options: CaptureOptions = {}) {
    set({ captureError: undefined, captureSaved: undefined, captureBusy: [...(state.captureBusy ?? []), device] });
    const pending = call((c) => c["capture.record"]({ device, flow, ...(options.showTouches !== undefined ? { showTouches: options.showTouches } : {}), ...(options.orientation ? { orientation: options.orientation } : {}), ...(options.bundleId ? { bundleId: options.bundleId } : {}) }), 12 * 60 * 1000);
    await new Promise((r) => setTimeout(r, 400));
    await actions.checkCapture();
    const result = await pending;
    set({ captureBusy: (state.captureBusy ?? []).filter((d) => d !== device) });
    if (result.ok) set({ captureSaved: result.value });
    else set({ captureError: plainError(result.error) });
    await actions.checkCapture();
  },
  /** D143: "Boot and record": Argent boots the simulator or AVD (only on this click), then the take starts. */
  async bootAndRecord(device: string, options: CaptureOptions = {}, flow?: string) {
    set({ captureError: undefined, captureSaved: undefined, captureBooting: [...(state.captureBooting ?? []), device] });
    const booted = await call((c) => c["capture.boot"]({ device }), 10 * 60 * 1000);
    set({ captureBooting: (state.captureBooting ?? []).filter((d) => d !== device) });
    if (!booted.ok) {
      set({ captureError: plainError(booted.error) });
      return void (await actions.checkCapture());
    }
    await actions.checkCapture();
    if (flow) await actions.recordFlow(booted.value.device, flow, options);
    else await actions.startCapture(booted.value.device, options);
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
  /**
   * D114: a take recorded on this Mac goes up to the active server's media/uploads/ (Local or a
   * remote alike, D108), then capture.save converts it into media/captures/ and imports it as one
   * edit, placed at `placeAt` when given. The project must still be the one it was recorded for.
   */
  async saveTake(blob: Blob, take: { readonly kind: TakeKind; readonly name?: string; readonly device?: string; readonly placeAt?: number; readonly dir: string }): Promise<{ readonly saved: { readonly mediaId: string; readonly name: string; readonly seconds: number; readonly itemId?: string | undefined; readonly trackId?: string | undefined } } | { readonly problem: string }> {
    if (state.snapshot?.dir !== take.dir) return { problem: "The project changed while recording, so the take wasn't added." };
    const ext = blob.type.startsWith("audio/") ? "webm" : blob.type.includes("mp4") ? "mp4" : "webm";
    const uploaded = await uploadOne(new File([blob], takeUploadName(take.kind, ext), { type: blob.type }));
    if ("message" in uploaded) return { problem: `The take couldn't be sent to the server: ${uploaded.message}` };
    if (state.snapshot?.dir !== take.dir) return { problem: "The project changed while recording, so the take wasn't added." };
    // Converting a long camera or screen take can take a while: wait up to 10 minutes.
    const result = await call((c) => c["capture.save"]({ path: uploaded.path, kind: take.kind, ...(take.name ? { name: take.name } : {}), ...(take.device ? { device: take.device } : {}), ...(take.placeAt !== undefined ? { placeAt: take.placeAt } : {}) }), 10 * 60 * 1000);
    if (!result.ok) return { problem: plainError(result.error) };
    if (result.value.itemId) playback.select(result.value.itemId);
    return { saved: result.value };
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
  // The way to another environment works while this one is away.
  if (command.type === "open-environments") return void actions.openEnvironments();
  // Settings and the shortcuts sheet are local UI: they open while the server is away too.
  if (command.type === "open-settings") return actions.openSettings();
  if (command.type === "shortcuts") return actions.openShortcuts();
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
export type SettingsSection = "project" | "app" | "shortcuts";

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
          ? { type: "open-settings" }
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
