// The wire contract between the server and its clients: one RPC group over WebSocket.
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

export const WS_PATH = "/ws";
// Browsers can't set headers on a WebSocket, so the token travels as a query parameter.
export const TOKEN_QUERY_PARAM = "token";

export const RPC_METHODS = {
  serverHello: "server.hello",
  projectCreate: "project.create",
  projectOpen: "project.open",
  projectGet: "project.get",
  projectReload: "project.reload",
  projectClose: "project.close",
  projectSubscribe: "project.subscribe",
  projectEdit: "project.edit",
  projectUndo: "project.undo",
  projectRedo: "project.redo",
  recentsList: "recents.list",
  mediaImport: "media.import",
  mediaThumbnails: "media.thumbnails",
  mediaJobs: "media.jobs",
  musicAdd: "music.add",
  setupCheck: "setup.check",
  setupState: "setup.state",
  setupComplete: "setup.complete",
  agentSubscribe: "agent.subscribe",
  agentSend: "agent.send",
  agentCancel: "agent.cancel",
  agentUndoTurn: "agent.undoTurn",
  agentApprove: "agent.approve",
  exportStart: "export.start",
  exportJobs: "export.jobs",
  exportCancel: "export.cancel",
  analysisStart: "analysis.start",
  analysisJobs: "analysis.jobs",
  analysisCancel: "analysis.cancel",
  analysisCached: "analysis.cached",
  historySubscribe: "history.subscribe",
  historyPreview: "history.preview",
  historyJump: "history.jump",
  transcriptionState: "transcription.state",
  transcriptionDownload: "transcription.download",
  transcriptionCancelDownload: "transcription.cancelDownload",
  transcriptionSelectModel: "transcription.selectModel",
  pluginsList: "plugins.list",
  pluginsApprove: "plugins.approve",
  pluginsRevoke: "plugins.revoke",
  pluginsInstall: "plugins.install",
  pluginsUninstall: "plugins.uninstall",
  pluginsContributions: "plugins.contributions",
  pluginsCheck: "plugins.check",
  pluginsAddComponent: "plugins.addComponent",
  pluginsCatalog: "plugins.catalog",
  pluginsEnable: "plugins.enable",
  pluginsDisable: "plugins.disable",
  captureDevices: "capture.devices",
  captureStart: "capture.start",
  captureStop: "capture.stop",
  generateList: "generate.list",
  generateStart: "generate.start",
  generateJobs: "generate.jobs",
  generateCancel: "generate.cancel",
  keysList: "keys.list",
  keysSet: "keys.set",
  keysRemove: "keys.remove",
} as const;

// ---- server ----

export const ServerHello = Schema.Struct({
  version: Schema.String,
  node: Schema.String,
  pid: Schema.Number,
  mediaCore: Schema.Struct({ version: Schema.String }),
  /** The secret GRAPHIC_PATH takes instead of the server token (D78): a graphic's iframe URL must not carry the token every other route and the WebSocket accept. */
  graphicToken: Schema.optional(Schema.String),
});
export type ServerHello = typeof ServerHello.Type;

export class MediaCoreError extends Schema.TaggedError<MediaCoreError>()("MediaCoreError", {
  message: Schema.String,
}) {}

// ---- projects ----

// project.json is validated by @uncut/core (JSON Schema + rules), not here, so the wire
// carries it as plain JSON.
export const ProjectSnapshot = Schema.Struct({
  dir: Schema.String,
  project: Schema.Unknown,
  // Goes up with every change, undo and redo included; it never goes back.
  revision: Schema.Number,
  canUndo: Schema.Boolean,
  canRedo: Schema.Boolean,
  // Why ⌘Z can't go further back when that's worth saying (D71: it stops at a change made to
  // project.json outside Uncut; older steps than history.db keeps).
  undoStop: Schema.optional(Schema.String),
  // history.db can't be used (damaged, locked, read-only): the history is in memory only (D71).
  historyProblem: Schema.optional(Schema.String),
});
export type ProjectSnapshot = typeof ProjectSnapshot.Type;

// ---- history (D71) ----

/**
 * One revision in the History tab. Undo and redo steps aren't listed (they're the cursor moving).
 * `current`: its change is in the project as it is now (false: undone, or left by a jump back).
 */
export const HistoryEntry = Schema.Struct({
  revision: Schema.Number,
  at: Schema.String,
  kind: Schema.Literals(["initial", "edit", "undo-turn", "external", "jump"]),
  author: Schema.Literals(["user", "agent", "external", "import"]),
  turnId: Schema.optional(Schema.String),
  label: Schema.String,
  lines: Schema.Array(Schema.String),
  current: Schema.Boolean,
});
export type HistoryEntry = typeof HistoryEntry.Type;

/** The open project's history: the newest entries first (at most 200 of `total`). */
export const HistoryState = Schema.Struct({
  dir: Schema.String,
  revision: Schema.Number,
  // Saved in history.db (false: in memory only; `problem` says why).
  persistent: Schema.Boolean,
  problem: Schema.optional(Schema.String),
  total: Schema.Number,
  entries: Schema.Array(HistoryEntry),
});
export type HistoryState = typeof HistoryState.Type;

/** One problem found by the validator (or the edit engine), e.g. { code: "overlap", path: "/tracks/t1/items/a", message }. */
export const Problem = Schema.Struct({ code: Schema.String, path: Schema.String, message: Schema.String });
export type Problem = typeof Problem.Type;

export const ProjectErrorReason = Schema.Literals([
  "exists", // create: the folder is already there
  "invalid-name", // create: the name can't be a folder name
  "invalid-path", // create/open: the folder isn't given as an absolute path
  "missing", // open: no folder or no project.json
  "invalid", // open: project.json isn't JSON or doesn't validate
  "no-project", // get/edit/undo/redo before a project is open
  "changed-on-disk", // edit/undo/redo: project.json was changed by hand; reload first
  "io", // reading or writing the folder failed
]);

export class ProjectError extends Schema.TaggedError<ProjectError>()("ProjectError", {
  reason: ProjectErrorReason,
  message: Schema.String,
  dir: Schema.optional(Schema.String),
  details: Schema.Array(Problem),
}) {}

/** The edit was not applied (malformed ops, invalid result, unknown item, bad baseRevision); the project is unchanged. */
export class EditRefused extends Schema.TaggedError<EditRefused>()("EditRefused", {
  message: Schema.String,
  details: Schema.Array(Problem),
}) {}

export const Canvas = Schema.Struct({
  width: Schema.Int,
  height: Schema.Int,
  fps: Schema.Literals([24, 25, 30, 50, 60]),
});

export const RecentProject = Schema.Struct({
  dir: Schema.String,
  name: Schema.String,
  openedAt: Schema.String,
});
export type RecentProject = typeof RecentProject.Type;

// ---- media ----

export const THUMB_PATH = "/media/thumb"; // GET /media/thumb/<media id>?token=…
// GET /media/file/<media id>?token=…: the original file of a media item of the open project, with
// HTTP Range support (the preview's <video> seeks with it). Footage is streamed, never copied.
export const MEDIA_FILE_PATH = "/media/file";
// GET /media/waveform/<media id>?token=…: the sound's peaks for the timeline, as JSON
// { version, rate, seconds, peaks } where peaks is base64 of one byte per 1/rate s (the loudest
// sample in it, 0–255 for 0–full scale). Made once per file and cached in the project's .cache/.
export const WAVEFORM_PATH = "/media/waveform";
// GET /media/graphic/<file name>?token=…: a graphic item's document (D78) for the preview's
// sandboxed iframe: the open project's graphics/<file name>, only if one of its graphic items uses
// it, wrapped by core graphicDocument and served with its strict CSP (inline script, no network).
export const GRAPHIC_PATH = "/media/graphic";
// GET /media/library/<file>?token=…: a track of the bundled music library (D91), for the Audio
// tab's preview; only the files core MUSIC_TRACKS lists.
export const MUSIC_FILE_PATH = "/media/library";
export interface Waveform {
  readonly version: 1;
  /** Peaks per second. */
  readonly rate: number;
  readonly seconds: number;
  readonly peaks: string;
}

/** What an import did, file by file. The project change itself arrives as a snapshot. */
export const MediaImportResult = Schema.Struct({
  imported: Schema.Array(Schema.Struct({ path: Schema.String, id: Schema.String, name: Schema.String, via: Schema.String })),
  skipped: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
  failed: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
});
export type MediaImportResult = typeof MediaImportResult.Type;

/**
 * An import runs as a job on the server: it isn't tied to the request that started it, so a
 * slow batch or a dropped connection can't cancel it halfway. Jobs run one at a time.
 */
export const ImportJob = Schema.Struct({
  id: Schema.String,
  projectDir: Schema.String,
  total: Schema.Number,
  phase: Schema.Literals(["queued", "probing", "adding", "posters", "done", "failed"]),
  probed: Schema.Number,
  postersDone: Schema.Number,
  postersTotal: Schema.Number,
  result: Schema.optional(MediaImportResult),
  error: Schema.optional(Schema.String),
  // Started by the agent's media_import (D65): the agent reports skips and failures itself.
  agent: Schema.optional(Schema.Boolean),
});
export type ImportJob = typeof ImportJob.Type;

// ---- setup (onboarding) ----

export const SetupStatus = Schema.Literals(["ready", "missing", "needs-login", "warning", "error"]);
export type SetupStatus = typeof SetupStatus.Type;

/** One thing Uncut looked for on this Mac. `fix` says what to do, with a command to copy when there is one. */
export const SetupCheck = Schema.Struct({
  id: Schema.String, // "claude" | "codex" | "argent" | "ffmpeg" | "whisper" | "api-key"
  name: Schema.String,
  status: SetupStatus,
  optional: Schema.Boolean,
  version: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  detail: Schema.String,
  fix: Schema.optional(Schema.Struct({ text: Schema.String, command: Schema.optional(Schema.String) })),
});
export type SetupCheck = typeof SetupCheck.Type;

// ---- plugins (D97) ----

/**
 * A plugin folder Uncut found (uncut.module.json). status: "ready" (allowed, or shipped with the
 * app), "needs-approval" (its tools are listed to the agent but refused until the user allows
 * it), "broken" (skipped: problem says why; id/name may be missing).
 */
export const PluginInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  source: Schema.Literals(["user", "bundled"]),
  dir: Schema.String,
  status: Schema.Literals(["ready", "needs-approval", "broken"]),
  capabilities: Schema.Array(Schema.String),
  // The capabilities in words, and what running it means (one sentence each).
  asks: Schema.Array(Schema.String),
  tools: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
  problem: Schema.optional(Schema.String),
  // Installed by Uncut (D102): where from ("folder" path, or git URL with the ref asked for and the commit cloned).
  origin: Schema.optional(Schema.Struct({ kind: Schema.Literals(["folder", "git", "catalog"]), source: Schema.String, ref: Schema.optional(Schema.String), commit: Schema.optional(Schema.String) })),
  // In Uncut's own plugins folder, so Remove can delete it.
  removable: Schema.optional(Schema.Boolean),
  // What it adds as data (D103), by name: text looks, components, checks.
  contributes: Schema.optional(Schema.Struct({ looks: Schema.Array(Schema.String), components: Schema.Array(Schema.String), rules: Schema.Array(Schema.String) })),
});
export type PluginInfo = typeof PluginInfo.Type;

/**
 * The allowed plugins' contributions (D103) for the renderer: looks are core TextLooks (+ plugin,
 * pluginName), rules core PluginRules; components without their template (it only ever runs in
 * the graphics sandbox, after plugins.addComponent copies it into the project).
 */
export const PluginContributions = Schema.Struct({
  looks: Schema.Array(Schema.Unknown),
  components: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, description: Schema.String, plugin: Schema.String, pluginName: Schema.String, params: Schema.Unknown, defaults: Schema.Unknown })),
  rules: Schema.Array(Schema.Unknown),
});
export type PluginContributions = typeof PluginContributions.Type;

/**
 * One plugin in Uncut's catalog (D103): plugins/catalog in the repo, shipped with the app, off
 * until the user enables one (copied like a folder install, then the approval dialog).
 */
export const CatalogEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  version: Schema.String,
  kind: Schema.String,
  capabilities: Schema.Array(Schema.String),
  tools: Schema.Array(Schema.String),
  // Whether it runs a program (a "process" plugin) or only adds data.
  runs: Schema.Boolean,
  contributes: Schema.optional(Schema.Struct({ looks: Schema.Array(Schema.String), components: Schema.Array(Schema.String), rules: Schema.Array(Schema.String) })),
  // Enabled: a copy is in Uncut's plugins folder (it may still need allowing).
  enabled: Schema.Boolean,
});
export type CatalogEntry = typeof CatalogEntry.Type;

export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  // D102: "invalid" (an install refused, in one sentence), "replaces-bundled" (its id is a bundled
  // plugin's: install again with replaceBundled to do it on purpose), "not-removable".
  reason: Schema.Literals(["unknown-plugin", "broken", "bundled", "changed", "io", "invalid", "replaces-bundled", "not-removable"]),
  message: Schema.String,
}) {}

// ---- capture (D98) ----

/** A device a capture source can see (Argent: simulators, emulators, Chromium apps). */
export const CaptureDevice = Schema.Struct({
  id: Schema.String,
  platform: Schema.String,
  name: Schema.String,
  state: Schema.String,
  recordable: Schema.Boolean,
  // Why it can't be recorded (yet), in a few words.
  reason: Schema.optional(Schema.String),
});
export type CaptureDevice = typeof CaptureDevice.Type;

/**
 * The Capture tab's Argent section: whether Argent is there (else the command that installs it),
 * its devices, and the recordings running now (device id, ISO start).
 */
export const CaptureState = Schema.Struct({
  installed: Schema.Boolean,
  version: Schema.optional(Schema.String),
  install: Schema.String,
  problem: Schema.optional(Schema.String),
  devices: Schema.Array(CaptureDevice),
  recording: Schema.Array(Schema.Struct({ device: Schema.String, startedAt: Schema.String })),
});
export type CaptureState = typeof CaptureState.Type;

export class CaptureError extends Schema.TaggedError<CaptureError>()("CaptureError", {
  reason: Schema.Literals(["no-project", "unavailable", "failed"]),
  message: Schema.String,
}) {}

// ---- generators (D99) ----

export const GenerateKind = Schema.Literals(["image", "video", "audio"]);
export type GenerateKind = typeof GenerateKind.Type;

/** A provider whose API key the user can store (Settings › Keys). */
export const KeyProvider = Schema.Literals(["openai", "google", "elevenlabs"]);
export type KeyProvider = typeof KeyProvider.Type;

/** One provider's key: whether one is stored, never the key itself. */
export const KeyInfo = Schema.Struct({
  provider: KeyProvider,
  // "OpenAI", "Google", "ElevenLabs"
  name: Schema.String,
  set: Schema.Boolean,
  // Where it lives: the macOS Keychain (Electron safeStorage), or only in memory (the server run without the desktop).
  storage: Schema.Literals(["keychain", "memory"]),
  // What it's used for ("GPT Image").
  usedBy: Schema.Array(Schema.String),
});
export type KeyInfo = typeof KeyInfo.Type;

/** A generator the Generate tab and generate_media offer, and whether it can run now. */
export const GeneratorInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kinds: Schema.Array(GenerateKind),
  provider: Schema.optional(KeyProvider),
  model: Schema.optional(Schema.String),
  ready: Schema.Boolean,
  // Why it can't run: "Needs your OpenAI key".
  needs: Schema.optional(Schema.String),
  // Sizes to pick from (first = default): "1536x1024", "16:9".
  sizes: Schema.Array(Schema.String),
  // Lengths to pick from in seconds (video, sound); none for stills.
  seconds: Schema.optional(Schema.Array(Schema.Number)),
  // How it's paid for, in a few words.
  billing: Schema.String,
});
export type GeneratorInfo = typeof GeneratorInfo.Type;

export const GenerateRequest = Schema.Struct({
  generator: Schema.String,
  prompt: Schema.String,
  kind: Schema.optional(GenerateKind),
  size: Schema.optional(Schema.String),
  seconds: Schema.optional(Schema.Number),
  name: Schema.optional(Schema.String),
});
export type GenerateRequest = typeof GenerateRequest.Type;

/** A generation started from the Generate tab (the agent's run inside its turn). */
export const GenerateJob = Schema.Struct({
  id: Schema.String,
  projectDir: Schema.String,
  generator: Schema.String,
  kind: GenerateKind,
  prompt: Schema.String,
  size: Schema.optional(Schema.String),
  seconds: Schema.optional(Schema.Number),
  phase: Schema.Literals(["running", "importing", "done", "failed", "cancelled"]),
  // What it's doing, in words ("Waiting for Veo…").
  status: Schema.optional(Schema.String),
  startedAt: Schema.String,
  // Estimated cost in US dollars (0: on the subscription).
  estimate: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  mediaId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});
export type GenerateJob = typeof GenerateJob.Type;

export class GenerateError extends Schema.TaggedError<GenerateError>()("GenerateError", {
  reason: Schema.Literals(["no-project", "unknown-generator", "needs-key", "bad-request", "keys-unavailable", "failed"]),
  message: Schema.String,
}) {}

// ---- agent (D40, D48) ----

// The MCP server the agent CLI runs forwards tool calls to these routes (same port as the
// WebSocket), authenticated by a token that lives only as long as one turn: GET <path>/tools,
// POST <path>/call with { name, args }.
export const AGENT_BRIDGE_PATH = "/agent";
export const AGENT_TOKEN_HEADER = "x-uncut-agent-token";

/** One thing in a turn, in order: a piece of the agent's reply, or a tool it used. */
export const AgentItem = Schema.Struct({
  kind: Schema.Literals(["text", "step"]),
  // The reply text, or the step in words ("Read the timeline", the edit's summary).
  text: Schema.String,
  tool: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["running", "done", "error"])),
});
export type AgentItem = typeof AgentItem.Type;

/** An edit the agent made in a turn: its summary and every op in words (core describeOp). */
export const AgentEdit = Schema.Struct({ revision: Schema.Number, summary: Schema.String, lines: Schema.Array(Schema.String) });
export type AgentEdit = typeof AgentEdit.Type;

export const AgentTurnStatus = Schema.Literals(["running", "done", "error", "cancelled"]);

/** Whether "Undo turn" can run now, and why not when it can't. */
export const AgentUndo = Schema.Struct({
  state: Schema.Literals(["none", "available", "blocked", "unavailable", "undone"]),
  reason: Schema.optional(Schema.String),
});

export const AgentTurn = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  // The manual-edit note the agent got with this prompt (D6), shown on the card.
  note: Schema.optional(Schema.String),
  startedAt: Schema.String,
  finishedAt: Schema.optional(Schema.String),
  status: AgentTurnStatus,
  items: Schema.Array(AgentItem),
  edits: Schema.Array(AgentEdit),
  error: Schema.optional(Schema.String),
  seconds: Schema.optional(Schema.Number),
  undoneAt: Schema.optional(Schema.String),
  undo: AgentUndo,
  // Estimated spend on API keys in this turn, US dollars (D9, D99): generators billed to the user's keys.
  spend: Schema.optional(Schema.Number),
});
export type AgentTurn = typeof AgentTurn.Type;

/** The editor panels the agent's ui_show can open (D65): the library rail's tabs and the side tabs. */
export const AGENT_UI_PANELS = ["media", "text", "elements", "audio", "inspector", "agent", "checks"] as const;
export const AgentUiPanel = Schema.Literals(AGENT_UI_PANELS);
export type AgentUiPanel = typeof AgentUiPanel.Type;

/**
 * The agent's latest ui_show (D65): move the playhead, select an item, open a panel. Each request
 * has a new id; the renderer applies a request once, when its id is new to it.
 */
export const AgentUi = Schema.Struct({
  id: Schema.String,
  // The project revision it was made against: applied once the renderer has that snapshot, so a
  // frame isn't clamped to an older, shorter project.
  revision: Schema.Number,
  frame: Schema.optional(Schema.Number),
  select: Schema.optional(Schema.String),
  panel: Schema.optional(AgentUiPanel),
});
export type AgentUi = typeof AgentUi.Type;

/**
 * Something the running turn waits on the user for (D99): a generation billed to their key over
 * $1. Allow or Don't (agent.approve); unanswered in about 2 minutes, or the turn stopped, is no.
 */
export const AgentApproval = Schema.Struct({
  id: Schema.String,
  turnId: Schema.String,
  // "Generate a 4 s Veo video, about $1.60 on your Google key"
  text: Schema.String,
  estimate: Schema.Number,
  // ISO time it stops waiting.
  until: Schema.String,
});
export type AgentApproval = typeof AgentApproval.Type;

/** The open project's agent: its turns (oldest first) and the one running, if any. */
export const AgentState = Schema.Struct({
  dir: Schema.String,
  provider: Schema.String,
  running: Schema.NullOr(Schema.String),
  turns: Schema.Array(AgentTurn),
  ui: Schema.optional(AgentUi),
  approval: Schema.optional(AgentApproval),
});
export type AgentState = typeof AgentState.Type;

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  reason: Schema.Literals(["no-project", "busy", "not-installed", "unknown-turn", "failed"]),
  message: Schema.String,
}) {}

// ---- export (D34, D55) ----

/** Draft = 720p, fast; Standard = 1080p; High = the canvas size at a high bitrate. */
export const ExportQuality = Schema.Literals(["draft", "standard", "high"]);
export type ExportQuality = typeof ExportQuality.Type;
/**
 * off = the mix as it is (As mixed; the master limiter still holds the ceiling, D86); normal = −14
 * LUFS (YouTube, Instagram, TikTok); quiet = −16 LUFS (podcasts, Apple); broadcast = −23 LUFS (EBU
 * R128); target = targetLufs (the project's own target, D87).
 */
export const ExportLoudness = Schema.Literals(["off", "normal", "quiet", "broadcast", "target"]);
export type ExportLoudness = typeof ExportLoudness.Type;

/**
 * An export runs as a job on the server, like an import: queued → preparing (text drawn, loudness
 * measured) → rendering (progress 0–1 with an ETA) → done, failed or cancelled. It isn't tied to the
 * request that started it; exports run one at a time.
 */
export const ExportJob = Schema.Struct({
  id: Schema.String,
  projectDir: Schema.String,
  name: Schema.String,
  output: Schema.String,
  quality: ExportQuality,
  loudness: ExportLoudness,
  /** The integrated loudness it normalises to (D87); absent with As mixed. */
  targetLufs: Schema.optional(Schema.Number),
  phase: Schema.Literals(["queued", "preparing", "rendering", "done", "failed", "cancelled"]),
  progress: Schema.Number,
  etaSeconds: Schema.optional(Schema.Number),
  width: Schema.Number,
  height: Schema.Number,
  fps: Schema.Number,
  seconds: Schema.Number,
  startedAt: Schema.String,
  finishedAt: Schema.optional(Schema.String),
  elapsedSeconds: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  /** What the export draws differently from the preview (an animation past the frame cap, a graphic it couldn't read), as sentences (D76). */
  warnings: Schema.optional(Schema.Array(Schema.String)),
});
export type ExportJob = typeof ExportJob.Type;

export class ExportError extends Schema.TaggedError<ExportError>()("ExportError", {
  reason: Schema.Literals(["no-project", "no-ffmpeg", "exists", "invalid-path", "empty", "missing-media", "source-media", "busy", "unknown-job"]),
  message: Schema.String,
}) {}

// ---- analysis (D66) ----

/**
 * The analyzers that run today. One ffmpeg pass measures loudness and finds silences, so "silence"
 * is the same job as "loudness" (one cache file, one run). Another measures the picture (D67):
 * cuts, shake, blur, exposure and frozen stretches, so "shots", "motion" and "stability" are "video".
 * A third transcribes the speech on this Mac with whisper.cpp (D68). A fourth finds the tempo, the
 * beats and the onsets of the sound (D70).
 */
export const ANALYZERS = ["loudness", "video", "transcript", "beats"] as const;
export const Analyzer = Schema.Literals(ANALYZERS);
export type Analyzer = typeof Analyzer.Type;

/**
 * Analysing one media file with one analyzer, as a server job: queued (waiting for a slot, or for
 * an export to finish: `waiting: "export"`) → running (progress 0–1) → done, failed or cancelled.
 * Results go to <project>/.cache/analysis/<fingerprint>/<analyzer>.json; a cached result needs no job.
 */
export const AnalysisJob = Schema.Struct({
  id: Schema.String,
  projectDir: Schema.String,
  mediaId: Schema.String,
  // Every media id this job answers: one with the same content joins it (its tile shows the progress too).
  mediaIds: Schema.Array(Schema.String),
  analyzer: Analyzer,
  phase: Schema.Literals(["queued", "running", "done", "failed", "cancelled"]),
  progress: Schema.Number,
  waiting: Schema.optional(Schema.Literals(["export"])),
  // A transcript job downloading its speech model first (D68): progress is the download's.
  stage: Schema.optional(Schema.Literals(["model"])),
  error: Schema.optional(Schema.String),
  startedAt: Schema.String,
  finishedAt: Schema.optional(Schema.String),
});
export type AnalysisJob = typeof AnalysisJob.Type;

export class AnalysisError extends Schema.TaggedError<AnalysisError>()("AnalysisError", {
  reason: Schema.Literals(["no-project", "unknown-media", "unknown-analyzer", "failed"]),
  message: Schema.String,
}) {}

// ---- transcription (D68) ----

/** A whisper.cpp speech model: downloaded on demand into <data dir>/models. */
export const WhisperModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  bytes: Schema.Number,
  multilingual: Schema.Boolean,
  // Shown in the Setup row's picker (English-only ones are for tests).
  offered: Schema.Boolean,
  installed: Schema.Boolean,
});
export type WhisperModel = typeof WhisperModel.Type;

export const ModelDownload = Schema.Struct({
  model: Schema.String,
  phase: Schema.Literals(["downloading", "done", "failed", "cancelled"]),
  received: Schema.Number,
  total: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
});
export type ModelDownload = typeof ModelDownload.Type;

export const TranscriptionState = Schema.Struct({
  // The model transcripts use (a setting).
  selected: Schema.String,
  dir: Schema.String,
  models: Schema.Array(WhisperModel),
  downloads: Schema.Array(ModelDownload),
});
export type TranscriptionState = typeof TranscriptionState.Type;

export class TranscriptionError extends Schema.TaggedError<TranscriptionError>()("TranscriptionError", {
  reason: Schema.Literals(["unknown-model", "failed"]),
  message: Schema.String,
}) {}

const Empty = Schema.Struct({});

const ServerHelloRpc = Rpc.make(RPC_METHODS.serverHello, {
  payload: Empty,
  success: ServerHello,
  error: MediaCoreError,
});

const ProjectCreateRpc = Rpc.make(RPC_METHODS.projectCreate, {
  payload: Schema.Struct({ parentDir: Schema.String, name: Schema.String, canvas: Schema.optional(Canvas) }),
  success: ProjectSnapshot,
  error: ProjectError,
});

const ProjectOpenRpc = Rpc.make(RPC_METHODS.projectOpen, {
  payload: Schema.Struct({ dir: Schema.String }),
  success: ProjectSnapshot,
  error: ProjectError,
});

const ProjectGetRpc = Rpc.make(RPC_METHODS.projectGet, { payload: Empty, success: ProjectSnapshot, error: ProjectError });

// Re-read project.json (after a hand edit). If it doesn't validate, the current session stays.
const ProjectReloadRpc = Rpc.make(RPC_METHODS.projectReload, { payload: Empty, success: ProjectSnapshot, error: ProjectError });

// The open project as it changes: the current snapshot (or null: nothing open) right away,
// then every change, in the order the server made them. Clients mirror this rather than
// trusting call results, which a dropped connection can lose.
const ProjectSubscribeRpc = Rpc.make(RPC_METHODS.projectSubscribe, {
  payload: Empty,
  success: Schema.NullOr(ProjectSnapshot),
  stream: true,
});

// Back to no open project (the welcome screen). A no-op when nothing is open.
const ProjectCloseRpc = Rpc.make(RPC_METHODS.projectClose, { payload: Empty });

const ProjectEditRpc = Rpc.make(RPC_METHODS.projectEdit, {
  payload: Schema.Struct({
    // Edit ops (spec/schema/edit-ops.schema.json); the engine checks them.
    ops: Schema.Array(Schema.Unknown),
    baseRevision: Schema.optional(Schema.Int),
    summary: Schema.optional(Schema.String),
  }),
  success: ProjectSnapshot,
  error: Schema.Union([EditRefused, ProjectError]),
});

const ProjectUndoRpc = Rpc.make(RPC_METHODS.projectUndo, { payload: Empty, success: ProjectSnapshot, error: ProjectError });
const ProjectRedoRpc = Rpc.make(RPC_METHODS.projectRedo, { payload: Empty, success: ProjectSnapshot, error: ProjectError });

const RecentsListRpc = Rpc.make(RPC_METHODS.recentsList, { payload: Empty, success: Schema.Array(RecentProject) });

// Starts an import job into the open project and returns its id right away; follow it with
// media.jobs. Footage is referenced by its absolute path, never copied (D12); one undoable edit.
const MediaImportRpc = Rpc.make(RPC_METHODS.mediaImport, {
  payload: Schema.Struct({ paths: Schema.Array(Schema.String) }),
  success: Schema.Struct({ jobId: Schema.String }),
  error: ProjectError,
});

// A track of the bundled music library (D91) copied into the open project's media/ folder (an
// identical copy already there is reused); returns its path relative to the project. The renderer
// adds the media and the timeline item in one edit.
const MusicAddRpc = Rpc.make(RPC_METHODS.musicAdd, {
  payload: Schema.Struct({ track: Schema.String }),
  success: Schema.Struct({ path: Schema.String }),
  error: ProjectError,
});

// Recent import jobs, now and on every change.
const MediaJobsRpc = Rpc.make(RPC_METHODS.mediaJobs, { payload: Empty, success: Schema.Array(ImportJob), stream: true });

// Which media ids have a poster at THUMB_PATH (the rest show an icon).
const MediaThumbnailsRpc = Rpc.make(RPC_METHODS.mediaThumbnails, { payload: Empty, success: Schema.Array(Schema.String) });

const SetupCheckRpc = Rpc.make(RPC_METHODS.setupCheck, { payload: Empty, success: Schema.Array(SetupCheck) });
const SetupStateRpc = Rpc.make(RPC_METHODS.setupState, { payload: Empty, success: Schema.Struct({ onboarded: Schema.Boolean }) });
// Onboarding was finished or skipped: don't show it on launch again.
const SetupCompleteRpc = Rpc.make(RPC_METHODS.setupComplete, { payload: Empty });

// The open project's agent now and on every change (null: nothing open). Like project.subscribe,
// whole states, so a reconnect needs nothing else.
const AgentSubscribeRpc = Rpc.make(RPC_METHODS.agentSubscribe, { payload: Empty, success: Schema.NullOr(AgentState), stream: true });

// Starts a turn and returns its id; what happens arrives on agent.subscribe. One at a time.
const AgentSendRpc = Rpc.make(RPC_METHODS.agentSend, {
  payload: Schema.Struct({
    prompt: Schema.String,
    // Where the user is, for the prompt's editor context.
    frame: Schema.optional(Schema.Int),
    selected: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ turnId: Schema.String }),
  error: AgentError,
});

// Stops the running turn (a no-op when none is running). Edits it already made stay.
const AgentCancelRpc = Rpc.make(RPC_METHODS.agentCancel, { payload: Empty });

// Reverts one turn's edits as one undoable step, keeping later edits (D7).
const AgentUndoTurnRpc = Rpc.make(RPC_METHODS.agentUndoTurn, {
  payload: Schema.Struct({ turnId: Schema.String }),
  success: ProjectSnapshot,
  error: Schema.Union([AgentError, EditRefused, ProjectError]),
});

// The user's answer to the running turn's approval (D99); an unknown or expired id is ignored.
const AgentApproveRpc = Rpc.make(RPC_METHODS.agentApprove, { payload: Schema.Struct({ id: Schema.String, allow: Schema.Boolean }) });

// Starts an export of the open project (as it is now) to `output`, an absolute .mp4 path; returns
// the job id at once. An existing file is replaced only with `overwrite`.
const ExportStartRpc = Rpc.make(RPC_METHODS.exportStart, {
  payload: Schema.Struct({ output: Schema.String, quality: ExportQuality, loudness: ExportLoudness, targetLufs: Schema.optional(Schema.Number), overwrite: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ jobId: Schema.String }),
  error: ExportError,
});
// Recent export jobs, now and on every change.
const ExportJobsRpc = Rpc.make(RPC_METHODS.exportJobs, { payload: Empty, success: Schema.Array(ExportJob), stream: true });
// Stops a queued or running export; its temp files and partial output are removed.
const ExportCancelRpc = Rpc.make(RPC_METHODS.exportCancel, { payload: Schema.Struct({ jobId: Schema.String }) });

// Analyses a media item of the open project (all analyzers when none are named). A cached result
// or a file without sound is "done" at once; otherwise a job is queued (or an equal one joined).
const AnalysisStartRpc = Rpc.make(RPC_METHODS.analysisStart, {
  payload: Schema.Struct({ mediaId: Schema.String, analyzers: Schema.optional(Schema.Array(Schema.String)) }),
  success: Schema.Array(Schema.Struct({ analyzer: Analyzer, state: Schema.Literals(["done", "queued", "running"]), jobId: Schema.optional(Schema.String) })),
  error: AnalysisError,
});
// Recent analysis jobs, now and on every change.
const AnalysisJobsRpc = Rpc.make(RPC_METHODS.analysisJobs, { payload: Empty, success: Schema.Array(AnalysisJob), stream: true });
// Stops a queued or running analysis; nothing of it is left in .cache.
const AnalysisCancelRpc = Rpc.make(RPC_METHODS.analysisCancel, { payload: Schema.Struct({ jobId: Schema.String }) });

// A cached analysis result for a media item of the open project, without starting a job (null:
// not analysed yet). The Transcript panel reads the transcript (and the silences) this way (D69); the
// timeline reads beats without their onsets (`omit: ["onsets"]`, D70): top-level result fields left out.
const AnalysisCachedRpc = Rpc.make(RPC_METHODS.analysisCached, {
  payload: Schema.Struct({ mediaId: Schema.String, analyzer: Analyzer, omit: Schema.optional(Schema.Array(Schema.String)) }),
  success: Schema.Struct({ result: Schema.NullOr(Schema.Unknown) }),
  error: AnalysisError,
});

// The open project's history (D71) now and on every change (null: nothing open).
const HistorySubscribeRpc = Rpc.make(RPC_METHODS.historySubscribe, { payload: Empty, success: Schema.NullOr(HistoryState), stream: true });
// The project as it was at a revision (the History tab's preview); changes nothing.
const HistoryPreviewRpc = Rpc.make(RPC_METHODS.historyPreview, {
  payload: Schema.Struct({ revision: Schema.Int }),
  success: Schema.Struct({ revision: Schema.Number, project: Schema.Unknown }),
  error: ProjectError,
});
// Restores a revision's state as a new revision (one ⌘Z takes it back).
const HistoryJumpRpc = Rpc.make(RPC_METHODS.historyJump, {
  payload: Schema.Struct({ revision: Schema.Int }),
  success: ProjectSnapshot,
  error: Schema.Union([EditRefused, ProjectError]),
});

// The speech models and their downloads, now and on every change.
const TranscriptionStateRpc = Rpc.make(RPC_METHODS.transcriptionState, { payload: Empty, success: TranscriptionState, stream: true });
// Downloads a model (the chosen one when none is named); returns at once, progress on transcription.state.
const TranscriptionDownloadRpc = Rpc.make(RPC_METHODS.transcriptionDownload, { payload: Schema.Struct({ model: Schema.optional(Schema.String) }), error: TranscriptionError });
// Stops a model download (all of them when none is named); nothing of it is left.
const TranscriptionCancelDownloadRpc = Rpc.make(RPC_METHODS.transcriptionCancelDownload, { payload: Schema.Struct({ model: Schema.optional(Schema.String) }) });
// Chooses the model transcripts use (saved in settings).
const TranscriptionSelectModelRpc = Rpc.make(RPC_METHODS.transcriptionSelectModel, { payload: Schema.Struct({ model: Schema.String }), error: TranscriptionError });

// The plugins found (scans the folders again), and the user allowing one / taking that back (D97).
const PluginsListRpc = Rpc.make(RPC_METHODS.pluginsList, { payload: Empty, success: Schema.Array(PluginInfo) });
// The approval names what the user saw (folder and capabilities): a plugin that changed since is refused.
const PluginsApproveRpc = Rpc.make(RPC_METHODS.pluginsApprove, { payload: Schema.Struct({ id: Schema.String, dir: Schema.String, capabilities: Schema.Array(Schema.String) }), success: Schema.Array(PluginInfo), error: PluginError });
const PluginsRevokeRpc = Rpc.make(RPC_METHODS.pluginsRevoke, { payload: Schema.Struct({ id: Schema.String }), success: Schema.Array(PluginInfo), error: PluginError });
// Installs a plugin from a folder or a git URL (D102) into <dataDir>/plugins/<id>; it still needs allowing.
const PluginsInstallRpc = Rpc.make(RPC_METHODS.pluginsInstall, {
  payload: Schema.Struct({ source: Schema.String, ref: Schema.optional(Schema.String), replaceBundled: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ id: Schema.String, note: Schema.optional(Schema.String), plugins: Schema.Array(PluginInfo) }),
  error: PluginError,
});
const PluginsUninstallRpc = Rpc.make(RPC_METHODS.pluginsUninstall, { payload: Schema.Struct({ id: Schema.String }), success: Schema.Array(PluginInfo), error: PluginError });
// D103: the allowed plugins' looks, components and check rules; the open project's findings from
// process plugins' own checks (Checks are core Check objects); a plugin component copied into the
// open project's graphics/ (the renderer then inserts a graphic item with the props); the catalog.
const PluginsContributionsRpc = Rpc.make(RPC_METHODS.pluginsContributions, { payload: Empty, success: PluginContributions });
const PluginsCheckRpc = Rpc.make(RPC_METHODS.pluginsCheck, { payload: Empty, success: Schema.Struct({ checks: Schema.Array(Schema.Unknown), notes: Schema.Array(Schema.String) }) });
const PluginsAddComponentRpc = Rpc.make(RPC_METHODS.pluginsAddComponent, { payload: Schema.Struct({ id: Schema.String }), success: Schema.Struct({ src: Schema.String, name: Schema.String, props: Schema.Unknown }), error: PluginError });
const PluginsCatalogRpc = Rpc.make(RPC_METHODS.pluginsCatalog, { payload: Empty, success: Schema.Struct({ plugins: Schema.Array(CatalogEntry), problems: Schema.Array(Schema.String) }) });
// Enabling a catalog plugin copies it into <dataDir>/plugins (D102's folder install); it still needs allowing. Disable removes only such a copy.
const PluginsDisableRpc = Rpc.make(RPC_METHODS.pluginsDisable, { payload: Schema.Struct({ id: Schema.String }), success: Schema.Array(PluginInfo), error: PluginError });
const PluginsEnableRpc = Rpc.make(RPC_METHODS.pluginsEnable, {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ id: Schema.String, note: Schema.optional(Schema.String), plugins: Schema.Array(PluginInfo) }),
  error: PluginError,
});

// The Capture tab (D98): Argent's devices (asks the plugin each time), start and stop a recording.
// Stop imports the take into the open project as one user edit and returns its media id.
const CaptureDevicesRpc = Rpc.make(RPC_METHODS.captureDevices, { payload: Empty, success: CaptureState, error: CaptureError });
const CaptureStartRpc = Rpc.make(RPC_METHODS.captureStart, {
  payload: Schema.Struct({ device: Schema.String, showTouches: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ device: Schema.String, startedAt: Schema.String }),
  error: CaptureError,
});
const CaptureStopRpc = Rpc.make(RPC_METHODS.captureStop, {
  payload: Schema.Struct({ device: Schema.String }),
  success: Schema.Struct({ mediaId: Schema.String, name: Schema.String, seconds: Schema.Number }),
  error: CaptureError,
});

// Generators (D99): which there are and whether each has its key; a generation into the open
// project (returns at once; progress on generate.jobs); cancel one.
const GenerateListRpc = Rpc.make(RPC_METHODS.generateList, { payload: Empty, success: Schema.Array(GeneratorInfo) });
const GenerateStartRpc = Rpc.make(RPC_METHODS.generateStart, { payload: GenerateRequest, success: Schema.Struct({ jobId: Schema.String }), error: GenerateError });
const GenerateJobsRpc = Rpc.make(RPC_METHODS.generateJobs, { payload: Empty, success: Schema.Array(GenerateJob), stream: true });
const GenerateCancelRpc = Rpc.make(RPC_METHODS.generateCancel, { payload: Schema.Struct({ jobId: Schema.String }) });
// Settings › Keys (D99): which providers have a key; store or remove one. A key goes in, never out.
const KeysListRpc = Rpc.make(RPC_METHODS.keysList, { payload: Empty, success: Schema.Array(KeyInfo) });
const KeysSetRpc = Rpc.make(RPC_METHODS.keysSet, { payload: Schema.Struct({ provider: KeyProvider, key: Schema.String }), success: Schema.Array(KeyInfo), error: GenerateError });
const KeysRemoveRpc = Rpc.make(RPC_METHODS.keysRemove, { payload: Schema.Struct({ provider: KeyProvider }), success: Schema.Array(KeyInfo), error: GenerateError });

export const WsRpcGroup = RpcGroup.make(
  GenerateListRpc,
  GenerateStartRpc,
  GenerateJobsRpc,
  GenerateCancelRpc,
  KeysListRpc,
  KeysSetRpc,
  KeysRemoveRpc,
  CaptureDevicesRpc,
  CaptureStartRpc,
  CaptureStopRpc,
  PluginsListRpc,
  PluginsApproveRpc,
  PluginsRevokeRpc,
  PluginsInstallRpc,
  PluginsUninstallRpc,
  PluginsContributionsRpc,
  PluginsCheckRpc,
  PluginsAddComponentRpc,
  PluginsCatalogRpc,
  PluginsEnableRpc,
  PluginsDisableRpc,
  HistorySubscribeRpc,
  HistoryPreviewRpc,
  HistoryJumpRpc,
  TranscriptionStateRpc,
  TranscriptionDownloadRpc,
  TranscriptionCancelDownloadRpc,
  TranscriptionSelectModelRpc,
  AnalysisStartRpc,
  AnalysisJobsRpc,
  AnalysisCancelRpc,
  AnalysisCachedRpc,
  ExportStartRpc,
  ExportJobsRpc,
  ExportCancelRpc,
  AgentSubscribeRpc,
  AgentSendRpc,
  AgentCancelRpc,
  AgentUndoTurnRpc,
  AgentApproveRpc,
  MediaImportRpc,
  MediaJobsRpc,
  MediaThumbnailsRpc,
  MusicAddRpc,
  SetupCheckRpc,
  SetupStateRpc,
  SetupCompleteRpc,
  ServerHelloRpc,
  ProjectCreateRpc,
  ProjectOpenRpc,
  ProjectGetRpc,
  ProjectReloadRpc,
  ProjectCloseRpc,
  ProjectSubscribeRpc,
  ProjectEditRpc,
  ProjectUndoRpc,
  ProjectRedoRpc,
  RecentsListRpc,
);

// What the desktop shell hands the renderer (via the preload bridge).
export interface ServerConnection {
  readonly url: string; // ws://127.0.0.1:<port>/ws
  readonly token: string;
}
