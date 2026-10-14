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
  librarySearch: "library.search",
  libraryAdd: "library.add",
  libraryState: "library.state",
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
  exportSubtitles: "export.subtitles",
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
  captureSave: "capture.save",
  captureBoot: "capture.boot",
  captureRecord: "capture.record",
  agentScreenTake: "agent.screenTake",
  agentRestoreCleanup: "agent.restoreCleanup",
  mediaRecent: "media.recent",
  mediaRecentImport: "media.recentImport",
  generateList: "generate.list",
  generateStart: "generate.start",
  generateJobs: "generate.jobs",
  generateCancel: "generate.cancel",
  keysList: "keys.list",
  keysSet: "keys.set",
  keysRemove: "keys.remove",
  filesList: "files.list",
  agentPlanSave: "agent.planSave",
  brandGet: "brand.get",
  brandSaveKit: "brand.saveKit",
  brandDeleteKit: "brand.deleteKit",
  brandSaveSkill: "brand.saveSkill",
  brandDeleteSkill: "brand.deleteSkill",
  brandSetActive: "brand.setActive",
  brandAddFile: "brand.addFile",
  brandImport: "brand.import",
} as const;

// ---- server ----

export const ServerHello = Schema.Struct({
  version: Schema.String,
  node: Schema.String,
  pid: Schema.Number,
  mediaCore: Schema.Struct({ version: Schema.String }),
  /** The secret GRAPHIC_PATH takes instead of the server token (D78): a graphic's iframe URL must not carry the token every other route and the WebSocket accept. */
  graphicToken: Schema.optional(Schema.String),
  /** The server machine's home folder and where New project suggests saving there (D107): a remote environment's paths are its own, not this Mac's. */
  home: Schema.optional(Schema.String),
  defaultParentDir: Schema.optional(Schema.String),
  /** The server machine's name, for the environment's connection line. */
  hostname: Schema.optional(Schema.String),
});
export type ServerHello = typeof ServerHello.Type;

// ---- remote environments (Phase 9) ----

/** HTTP routes a remote environment adds (D106-D109). Each takes the server token (query or Authorization: Bearer). */
// GET: { ok, version, hostname }, so Settings can test a connection before saving it.
export const PING_PATH = "/api/ping";
// POST ?name=<file name>: the body is a file, saved into the open project's media/uploads/ (D108); answers { path }.
export const UPLOAD_PATH = "/api/upload";
// GET /api/export/<job id>: a finished export's video, with byte ranges (D109).
export const EXPORT_FILE_PATH = "/api/export";

/** One entry of a folder listing on the server (files.list, D107). */
export const FileEntry = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["dir", "file"]),
  /** A folder with a project.json in it (a .uncut project). */
  project: Schema.optional(Schema.Boolean),
  size: Schema.optional(Schema.Number),
});
export type FileEntry = typeof FileEntry.Type;
export const FileListing = Schema.Struct({
  dir: Schema.String,
  /** The folder above, absent at /. */
  parent: Schema.optional(Schema.String),
  home: Schema.String,
  entries: Schema.Array(FileEntry),
});
export type FileListing = typeof FileListing.Type;
export class FilesError extends Schema.TaggedError<FilesError>()("FilesError", {
  reason: Schema.Literals(["invalid-path", "missing", "not-a-folder", "forbidden", "io"]),
  message: Schema.String,
}) {}

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
/** D205: a poster from the user's media index (another project's take), by index entry id. */
export const RECENT_THUMB_PATH = "/media/recent-thumb"; // GET /media/recent-thumb/<entry id>?token=…

/**
 * D205: a capture, import or generation from any project on this Mac, from the user-level media
 * index (<data dir>/media-index.json): where it is, what it is, which project it came from.
 */
export const MediaRecentEntry = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["video", "image", "audio"]),
  origin: Schema.Literals(["capture", "import", "generated"]),
  seconds: Schema.optional(Schema.Number),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  project: Schema.Struct({ dir: Schema.String, name: Schema.String }),
  device: Schema.optional(Schema.String),
  app: Schema.optional(Schema.String),
  created: Schema.String,
  thumb: Schema.optional(Schema.Boolean),
  // Importing it copies the file into this project's media/ (it lives inside another project's folder), else references it (D12).
  copies: Schema.optional(Schema.Boolean),
});
export type MediaRecentEntry = typeof MediaRecentEntry.Type;
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
// GET /media/agent-image/<file name>?token=…: an image the user attached to an agent message (U4,
// D184), kept in the open project's .cache/agent-images/ for the turn card's thumbnails.
export const AGENT_IMAGE_PATH = "/media/agent-image";
// GET /media/brand/<kit id>/<file name>?token=…: a file of a brand kit the open project sees
// (D198): logo thumbnails in the Brand tab and the kit's font files for the preview.
export const BRAND_FILE_PATH = "/media/brand";
/** An attached image's file name in .cache/agent-images/: <turn id>-<n>.<ext>. */
export const AGENT_IMAGE_NAME = /^turn-[a-z0-9]+-[a-f0-9]{6}-\d\.(png|jpg|gif|webp)$/;
// GET /media/library/<file>?token=…: a track of the bundled music library (D91), for the Audio
// tab's preview; only the files core MUSIC_TRACKS lists.
export const MUSIC_FILE_PATH = "/media/library";
// GET /media/sfx/<file>?token=…: a sound of the bundled sound-effects pack (D134), for the Sound
// effects tab's preview; only the files core SFX_SOUNDS lists.
export const SFX_FILE_PATH = "/media/sfx";
// GET /library/preview/<source>/<id>?token=…: an online library hit's preview (D134), streamed
// through the server from the URL its search gave (only hits of a recent search), never saved.
export const LIBRARY_PREVIEW_PATH = "/library/preview";
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
  /** D105: .srt / .vtt files read into a Subtitles text track (no media is added for them). */
  subtitles: Schema.optional(Schema.Array(Schema.Struct({ path: Schema.String, track: Schema.String, cues: Schema.Number }))),
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
  // D136: colour looks for the Effects tab (core LookDef numbers).
  filters: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, description: Schema.String, plugin: Schema.String, pluginName: Schema.String, look: Schema.Unknown }))),
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
  // D143: off now, but Argent can boot it on the user's click (a shut-down simulator, an AVD).
  bootable: Schema.optional(Schema.Boolean),
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
  recording: Schema.Array(Schema.Struct({ device: Schema.String, startedAt: Schema.String, flow: Schema.optional(Schema.String) })),
  // D143: the open project's saved flows (flows/<name>.yaml), by name.
  flows: Schema.optional(Schema.Array(Schema.String)),
});
export type CaptureState = typeof CaptureState.Type;

/** D114: what a take recorded on this Mac is (the microphone's voiceover, a camera, a screen or window). */
export const TakeKind = Schema.Literals(["voiceover", "camera", "screen"]);
export type TakeKind = typeof TakeKind.Type;

/**
 * D114: the name a take's recording is uploaded under (media/uploads/uncut-take-voiceover-1a2b3c4d5e6f.webm;
 * the server may add " 2"). capture.save only takes files named like this, so a file the user
 * uploaded (D108) is never converted or removed by it.
 */
export const takeUploadName = (kind: TakeKind, ext: "webm" | "mp4") => `uncut-take-${kind}-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("")}.${ext}`;
export const TAKE_UPLOAD_NAME = /^uncut-take-(voiceover|camera|screen)-[0-9a-f]{12}(?: \d+)?\.(?:webm|mp4)$/;

/** D143: how the Capture tab records a device: what to do first, and Argent's own options. */
export const CaptureOrientation = Schema.Literals(["Portrait", "LandscapeLeft", "LandscapeRight", "PortraitUpsideDown"]);
export type CaptureOrientation = typeof CaptureOrientation.Type;
export const CaptureOptions = Schema.Struct({
  showTouches: Schema.optional(Schema.Boolean),
  // Cut the parts where the screen doesn't change (Argent's trimStatic).
  trimStatic: Schema.optional(Schema.Boolean),
  // Argent stops the take by itself after this long (1 to 600 s).
  maxSeconds: Schema.optional(Schema.Number),
  orientation: Schema.optional(CaptureOrientation),
  // Opened on the device before the take.
  bundleId: Schema.optional(Schema.String),
});
export type CaptureOptions = typeof CaptureOptions.Type;

export class CaptureError extends Schema.TaggedError<CaptureError>()("CaptureError", {
  reason: Schema.Literals(["no-project", "unavailable", "failed"]),
  message: Schema.String,
}) {}

// ---- generators (D99) ----

export const GenerateKind = Schema.Literals(["image", "video", "audio"]);
export type GenerateKind = typeof GenerateKind.Type;

/** A provider whose API key the user can store (Settings › Keys). */
export const KeyProvider = Schema.Literals(["openai", "google", "elevenlabs", "freesound"]);
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
  // A line about the provider's terms, when they matter (Freesound: non-commercial API, D134).
  note: Schema.optional(Schema.String),
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

// ---- brand kits, skills and the production plan (U7, U15, U16, U17; D186–D191) ----

/** A colour of a kit with what it's for ("background", "text", "primary", "accent", "muted"...). */
export const BrandColor = Schema.Struct({ hex: Schema.String, role: Schema.String, name: Schema.optional(Schema.String) });
export type BrandColor = typeof BrandColor.Type;
/**
 * A typeface of a kit: its family and what it's for ("headline", "body", "mono"). `file` (D198): a
 * font file in the kit's folder (.woff2, .woff, .ttf, .otf) that graphics, texts and components
 * load (preview, export, render_frames); without one the family must be bundled or installed.
 */
export const BrandFont = Schema.Struct({ family: Schema.String, role: Schema.String, weight: Schema.optional(Schema.Number), file: Schema.optional(Schema.String) });
export type BrandFont = typeof BrandFont.Type;
/**
 * A style guide (U17): the grammar of a look, not its content. Usually written by the agent from
 * a reference video or frame ("Make a style from a reference").
 */
export const BrandStyle = Schema.Struct({
  source: Schema.optional(Schema.String),
  palette: Schema.Array(Schema.Struct({ hex: Schema.String, role: Schema.optional(Schema.String) })),
  type: Schema.String,
  shotLengths: Schema.String,
  transitions: Schema.String,
  camera: Schema.String,
  grain: Schema.String,
  notes: Schema.optional(Schema.String),
});
export type BrandStyle = typeof BrandStyle.Type;
/** Where a kit or a skill lives: the user's (every project; D198: where kits are made) or this project's (`<project>/brand/`, a copy pinned to it, wins on the same id). */
export const BrandScope = Schema.Literals(["global", "project"]);
export type BrandScope = typeof BrandScope.Type;
/**
 * A brand kit (U7). Files (logos, example frames) are names inside the kit's folder
 * (`<dataDir>/brand/kits/<id>/` or `<project>/brand/kits/<id>/`); `files` resolves them.
 */
export const BrandKit = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  scope: BrandScope,
  logos: Schema.Struct({ light: Schema.optional(Schema.String), dark: Schema.optional(Schema.String), mark: Schema.optional(Schema.String) }),
  colors: Schema.Array(BrandColor),
  fonts: Schema.Array(BrandFont),
  tone: Schema.String,
  taglines: Schema.Array(Schema.String),
  urls: Schema.Array(Schema.String),
  dos: Schema.Array(Schema.String),
  donts: Schema.Array(Schema.String),
  examples: Schema.Array(Schema.String),
  style: Schema.optional(BrandStyle),
  updatedAt: Schema.optional(Schema.String),
});
export type BrandKit = typeof BrandKit.Type;
/** A skill (U7): a reusable style or recipe document ("Launch promo 20 s"), plain text the agent follows. */
export const BrandSkill = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  scope: BrandScope,
  description: Schema.String,
  body: Schema.String,
  updatedAt: Schema.optional(Schema.String),
  // D207: one of Uncut's built-in skills (read-only; scope "global", id "builtin-…").
  builtin: Schema.optional(Schema.Boolean),
});
export type BrandSkill = typeof BrandSkill.Type;
/** What the open project uses (`<project>/brand/active.json`): one kit (or none) and its skills. */
export const BrandActive = Schema.Struct({ kit: Schema.NullOr(Schema.String), skills: Schema.Array(Schema.String) });
export type BrandActive = typeof BrandActive.Type;
/** Every kit and skill the open project can see (project ones win on the same id), and its choice. */
export const BrandState = Schema.Struct({
  kits: Schema.Array(BrandKit),
  skills: Schema.Array(BrandSkill),
  active: BrandActive,
  // Absolute paths of each kit's files by kit id then file name, for thumbnails and the agent.
  files: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
});
export type BrandState = typeof BrandState.Type;

export class BrandError extends Schema.TaggedError<BrandError>()("BrandError", {
  reason: Schema.Literals(["no-project", "invalid", "not-found", "failed"]),
  message: Schema.String,
}) {}

/**
 * The production brief (U15, `<project>/brief.json`): co-written with the agent before a new video
 * is built, editable by the user. Every field is plain text the agent reads each turn.
 */
export const Brief = Schema.Struct({
  film: Schema.String, // the film in one sentence
  audience: Schema.String,
  duration: Schema.String, // "20 s"
  formats: Schema.Array(Schema.String), // "9:16 1080x1920", "16:9"
  assets: Schema.Array(Schema.String), // the real assets it uses (logo, recordings, screenshots)
  visual: Schema.String, // visual direction
  hardLines: Schema.Array(Schema.String), // never invent product UI, metrics or logos...
  deliverables: Schema.Array(Schema.String),
  notes: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  by: Schema.optional(Schema.Literals(["agent", "user"])),
});
export type Brief = typeof Brief.Type;
/** One beat of the storyboard / shot list (U9, U15): times in seconds. */
export const StoryboardBeat = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
  title: Schema.String,
  entry: Schema.String, // what's on screen as it starts
  exit: Schema.String, // what's on screen as it ends
  purpose: Schema.String,
  assets: Schema.Array(Schema.String),
  sound: Schema.optional(Schema.String), // the beat or hit it lands on
});
export type StoryboardBeat = typeof StoryboardBeat.Type;
/** The storyboard (`<project>/storyboard.json`): proposed by the agent, approved (maybe edited) by the user before the build. */
export const Storyboard = Schema.Struct({
  summary: Schema.String,
  beats: Schema.Array(StoryboardBeat),
  status: Schema.Literals(["proposed", "approved", "declined"]),
  // "user": approved on the card; "setting": Edit freely with the gate skipped.
  approvedBy: Schema.optional(Schema.Literals(["user", "setting"])),
  note: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
});
export type Storyboard = typeof Storyboard.Type;
/** The critic's scores (U16), 0–10 each. */
export const REVIEW_SCORES = ["hook", "readability", "motion", "variety", "sound", "brand"] as const;
export const ReviewScores = Schema.Struct({ hook: Schema.Number, readability: Schema.Number, motion: Schema.Number, variety: Schema.Number, sound: Schema.Number, brand: Schema.Number });
export type ReviewScores = typeof ReviewScores.Type;
/** One review round (`<project>/reviews/review-<n>.json`). */
export const Review = Schema.Struct({
  round: Schema.Number,
  scores: ReviewScores,
  // id: the critic's defect id (d1, d2, …: what a fix claim names in the next round, D195).
  defects: Schema.Array(Schema.Struct({ at: Schema.Number, what: Schema.String, fix: Schema.optional(Schema.String), id: Schema.optional(Schema.String) })),
  notes: Schema.optional(Schema.String),
  // D195: who scored it: "critic" (a separate claude process Uncut ran) or "agent" (rounds before D195).
  by: Schema.optional(Schema.Literals(["critic", "agent"])),
  // D195: hard blockers (any one fails the round whatever the scores); source "critic" or "check" (Uncut's layout checks).
  blockers: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.optional(Schema.String), kind: Schema.String, what: Schema.String, at: Schema.optional(Schema.Number), source: Schema.String }))),
  // D195: per score, the frames the critic cites ("f 0, f 45: …").
  evidence: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  // D196: the builder's fix claims and whether the critic saw each fixed on fresh frames.
  fixes: Schema.optional(Schema.Array(Schema.Struct({ defect: Schema.String, what: Schema.String, at: Schema.optional(Schema.Number), verified: Schema.Boolean, note: Schema.optional(Schema.String) }))),
  // D195: why the round has no scores (the critic couldn't run or answered something unreadable).
  error: Schema.optional(Schema.String),
  // The determinism check (U16): graphics drawn twice at the same frame, by name; those that differed.
  determinism: Schema.optional(Schema.Struct({ checked: Schema.Array(Schema.String), differed: Schema.Array(Schema.String) })),
  // Whether this round's looks were taken (a contact sheet and phone-size frames in this turn).
  looked: Schema.optional(Schema.Struct({ sheet: Schema.Boolean, phone: Schema.Boolean })),
  passed: Schema.Boolean,
  revision: Schema.optional(Schema.Number),
  at: Schema.String,
  turnId: Schema.optional(Schema.String),
});
export type Review = typeof Review.Type;
/** The open project's plan as the Agent tab shows it. */
export const AgentPlan = Schema.Struct({
  brief: Schema.optional(Brief),
  storyboard: Schema.optional(Storyboard),
  reviews: Schema.Array(Review),
});
export type AgentPlan = typeof AgentPlan.Type;

/** A question the agent asks (ask_user, U8): pick one or several options and/or write an answer. */
export const AgentQuestion = Schema.Struct({
  question: Schema.String,
  options: Schema.Array(Schema.Struct({ label: Schema.String, detail: Schema.optional(Schema.String) })),
  multi: Schema.Boolean,
  freeText: Schema.Boolean,
});
export type AgentQuestion = typeof AgentQuestion.Type;
/** The user's answer to a question card. */
export const AgentAnswer = Schema.Struct({ choices: Schema.Array(Schema.String), text: Schema.optional(Schema.String) });
export type AgentAnswer = typeof AgentAnswer.Type;
/** A card in a turn's history (kept with the turn): a question and its answer, the brief, the storyboard, a review. */
export const AgentCard = Schema.Struct({
  type: Schema.Literals(["question", "brief", "storyboard", "review", "brand"]),
  question: Schema.optional(AgentQuestion),
  answer: Schema.optional(AgentAnswer),
  // "answered", "skipped" (no answer in time, or stopped), "approved", "declined", "auto" (approved by the setting)
  outcome: Schema.optional(Schema.String),
  brief: Schema.optional(Brief),
  storyboard: Schema.optional(Storyboard),
  review: Schema.optional(Review),
  // brand: what was written into which kit ("Style guide written into Argent")
  text: Schema.optional(Schema.String),
});
export type AgentCard = typeof AgentCard.Type;

// ---- agent (D40, D48) ----

// The MCP server the agent CLI runs forwards tool calls to these routes (same port as the
// WebSocket), authenticated by a token that lives only as long as one turn: GET <path>/tools,
// POST <path>/call with { name, args }.
export const AGENT_BRIDGE_PATH = "/agent";
export const AGENT_TOKEN_HEADER = "x-uncut-agent-token";

/** One thing in a turn, in order: a piece of the agent's reply, its thinking (a summary), or a tool it used. */
export const AgentItem = Schema.Struct({
  kind: Schema.Literals(["text", "step", "thinking", "card"]),
  // The reply text, the thinking summary, or the step in words ("Read the timeline", the edit's summary).
  text: Schema.String,
  tool: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["running", "done", "error"])),
  // Still streaming in (D139): text and thinking grow as Claude writes them.
  live: Schema.optional(Schema.Boolean),
  // A step that failed (D182): what the tool answered, for the work log's ✕ row.
  error: Schema.optional(Schema.String),
  // A step while it runs (D182), in the present tense with its target ("Writing graphic s3-enter.html").
  doing: Schema.optional(Schema.String),
  // D194: what a built-in tool (WebSearch, WebFetch, Bash, Read, …) answered, at most 4,000 characters: the work log's row opens to it.
  result: Schema.optional(Schema.String),
  // kind "card" (D186–D190): a question with its answer, the brief, the storyboard or a review.
  card: Schema.optional(AgentCard),
});
export type AgentItem = typeof AgentItem.Type;

// ---- the composer's choices (U4, D184) ----

/** The models the composer offers (Claude Code's model ids); none chosen = Claude Code's default. */
export const AGENT_MODELS = [
  { id: "claude-opus-5-5", name: "Opus 5.5", detail: "Most capable" },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", detail: "Fast and capable" },
  { id: "claude-fable-5-1", name: "Fable 5.1", detail: "Creative" },
  { id: "claude-haiku-5-5", name: "Haiku 5.5", detail: "Fastest" },
] as const;
/** --effort levels (claude 2.1.299 also has xhigh; the composer offers these four). */
export const AGENT_EFFORTS = ["low", "medium", "high", "max"] as const;
export const AgentEffort = Schema.Literals(AGENT_EFFORTS);
export type AgentEffort = typeof AgentEffort.Type;
/**
 * What the agent may do (D184): look (reads and looks, never changes the project), ask (big
 * changes wait for Allow on a card: removing things, cutting by transcript, many items at once)
 * and edit (everything, as before; spending over $1 still asks, D99).
 */
export const AGENT_ACCESS = ["look", "ask", "edit"] as const;
export const AgentAccess = Schema.Literals(AGENT_ACCESS);
export type AgentAccess = typeof AgentAccess.Type;
/** An image attached to a message: base64 data, at most AGENT_IMAGE_MAX bytes, AGENT_IMAGES_MAX per message. */
export const AGENT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const AGENT_IMAGE_MAX = 5 * 1024 * 1024;
export const AGENT_IMAGES_MAX = 4;
export const AgentImage = Schema.Struct({ name: Schema.String, mimeType: Schema.Literals(AGENT_IMAGE_TYPES), data: Schema.String });
export type AgentImage = typeof AgentImage.Type;

/**
 * An edit the agent made in a turn: its summary and every op in words (core describeOp). D203: `at`
 * is the index in the turn's items of the step (tool call) that made it, so the thread shows the
 * edit where it happened; `media` the ids of the media it added (an import's thumbnails).
 */
export const AgentEdit = Schema.Struct({ revision: Schema.Number, summary: Schema.String, lines: Schema.Array(Schema.String), at: Schema.optional(Schema.Number), media: Schema.optional(Schema.Array(Schema.String)) });
export type AgentEdit = typeof AgentEdit.Type;

export const AgentTurnStatus = Schema.Literals(["running", "done", "error", "cancelled"]);

/**
 * Something the user pointed at in the composer (D140): an @mention or an "Add to chat" chip. The
 * prompt holds "@label"; the agent gets the label with the real id in a <context> block.
 */
export const AgentMentionKind = Schema.Literals(["media", "item", "track", "marker", "moment", "range"]);
export const AgentMention = Schema.Struct({
  kind: AgentMentionKind,
  id: Schema.String,
  label: Schema.String,
  // Add to chat (D141): the stretch of the timeline it covers, in project frames, or the frame it was picked at.
  range: Schema.optional(Schema.Struct({ start: Schema.Int, end: Schema.Int })),
  frame: Schema.optional(Schema.Int),
});
export type AgentMention = typeof AgentMention.Type;

/** Whether "Undo turn" can run now, and why not when it can't. */
export const AgentUndo = Schema.Struct({
  state: Schema.Literals(["none", "available", "blocked", "unavailable", "undone"]),
  reason: Schema.optional(Schema.String),
});

/** D198: a folder the prompt named, as Uncut listed it for the agent ("Found 12 files in ~/x"), or why it didn't. */
export const AgentFolder = Schema.Struct({ path: Schema.String, files: Schema.Number, folders: Schema.Number, problem: Schema.optional(Schema.String) });
export type AgentFolder = typeof AgentFolder.Type;

export const AgentTurn = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  // What the prompt's @labels point at (D140), for the card's chips.
  mentions: Schema.optional(Schema.Array(Schema.Struct({ kind: AgentMentionKind, label: Schema.String }))),
  // The manual-edit note the agent got with this prompt (D6), shown on the card.
  note: Schema.optional(Schema.String),
  // Images attached to the prompt (D184): file names in the project's .cache/agent-images/.
  images: Schema.optional(Schema.Array(Schema.String)),
  // The model it was asked of (a composer choice, D184); absent = Claude Code's default.
  model: Schema.optional(Schema.String),
  // D198: the folders the prompt named, listed for the agent.
  folders: Schema.optional(Schema.Array(AgentFolder)),
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
  // D206: graphics files the agent wrote in this turn (graphics/<name>), so only its own are ever cleaned up.
  graphics: Schema.optional(Schema.Array(Schema.String)),
  // D206: the turn-end clean-up: unused graphics moved to .cache/trash/<turn>/ and empty tracks the
  // agent made removed (an edit of the turn). restored: the user put the graphics back.
  cleanup: Schema.optional(Schema.Struct({ graphics: Schema.Array(Schema.String), tracks: Schema.Array(Schema.String), restored: Schema.optional(Schema.Boolean) })),
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
  // D144: a screen recording the agent asks for (screen_record): the card picks the screen or
  // window (the agent's `source` preselected by name), Record or Don't. The renderer records and
  // answers with agent.screenTake. Absent: a spend card (D99).
  screen: Schema.optional(Schema.Struct({ source: Schema.optional(Schema.String), seconds: Schema.Number, withMic: Schema.Boolean })),
  // D184: a big change asked for in "Ask before big changes": what it would do, in words.
  edit: Schema.optional(Schema.Struct({ lines: Schema.Array(Schema.String) })),
  // D187: a question (ask_user): answered with agent.approve's answer; Skip is allow false.
  question: Schema.optional(AgentQuestion),
  // D188: a storyboard to approve before the build: Approve (maybe with edited beats) or Change (a note).
  storyboard: Schema.optional(Storyboard),
  // D198: the agent wants to change a kit's colours or fonts (brand_write): each field before and
  // after. Apply (allow) or Keep the kit (deny); no answer in 2 minutes keeps it.
  brand: Schema.optional(Schema.Struct({ kit: Schema.String, changes: Schema.Array(Schema.Struct({ field: Schema.String, before: Schema.Array(Schema.String), after: Schema.Array(Schema.String) })) })),
  // D194: a Claude Code tool asks (Bash, a file write, ...): the tool, what it would run or touch, why
  // it asks, and whether "Always for this session" is offered. Allow once, Always (agent.approve
  // always: true) or Deny.
  permission: Schema.optional(Schema.Struct({ tool: Schema.String, target: Schema.String, why: Schema.optional(Schema.String), always: Schema.Boolean })),
  // D204: the agent asks to boot a simulator or emulator (argent_boot): its name, platform and kind
  // ("iOS simulator", "Android emulator"), the app it would open next. Boot (allow) or Don't.
  boot: Schema.optional(Schema.Struct({ device: Schema.String, name: Schema.String, platform: Schema.String, kind: Schema.String, bundleId: Schema.optional(Schema.String) })),
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
  // D144: the screen_record card id whose take the server waits for; gone (turn stopped, project
  // closed, timed out) means the renderer cancels that take.
  screenTake: Schema.optional(Schema.String),
  // D188: the project's brief, storyboard and reviews (U15, U16).
  plan: Schema.optional(AgentPlan),
  // D194: something wrong with the agent's setup the user should know (claude didn't answer initialize).
  warning: Schema.optional(Schema.String),
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
/** G7 (D127): a part of the timeline to export, frames [from, to) of the edit. */
export const ExportRange = Schema.Struct({ from: Schema.Number, to: Schema.Number });
export type ExportRange = typeof ExportRange.Type;
/** F4 (D171): the video codec; every preset is H.264 unless HEVC is chosen in Advanced. */
export const ExportCodec = Schema.Literals(["h264", "hevc"]);
export type ExportCodec = typeof ExportCodec.Type;
/** F4 (D171): the dialog's Advanced row: codec, bitrate (Mb/s), size by the shorter side (never upscaled), frame rate. Absent = the preset's. */
export const ExportVideo = Schema.Struct({ codec: Schema.optional(ExportCodec), bitrateMbps: Schema.optional(Schema.Number), shortSide: Schema.optional(Schema.Number), fps: Schema.optional(Schema.Number) });
export type ExportVideo = typeof ExportVideo.Type;

export const ExportJob = Schema.Struct({
  id: Schema.String,
  projectDir: Schema.String,
  name: Schema.String,
  output: Schema.String,
  quality: ExportQuality,
  /** F4 (D171): the codec it was encoded with (absent on jobs from before: H.264 then, HEVC for High). */
  codec: Schema.optional(ExportCodec),
  /** F4 (D171): a bitrate chosen in Advanced (Mb/s); absent = the preset's. */
  bitrateMbps: Schema.optional(Schema.Number),
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
  /** D105: the subtitles file written next to the video (.srt or .vtt). */
  subtitlesFile: Schema.optional(Schema.String),
  /** D105: the video carries a soft subtitle track (mov_text) with this ISO 639-2 language tag. */
  subtitleTrack: Schema.optional(Schema.String),
  /** D105: false when captions and Subtitles tracks aren't drawn into the picture. */
  burnCaptions: Schema.optional(Schema.Boolean),
  /** G7 (D127): only this part of the timeline, frames [from, to). */
  range: Schema.optional(Schema.Struct({ from: Schema.Number, to: Schema.Number })),
});
export type ExportJob = typeof ExportJob.Type;

/** D105: subtitles with an export: a file next to the video, a soft track in it (with its language: en, pl, eng...). */
export const ExportSubtitles = Schema.Struct({ file: Schema.optional(Schema.Literals(["srt", "vtt"])), track: Schema.optional(Schema.Boolean), language: Schema.optional(Schema.String) });
export type ExportSubtitles = typeof ExportSubtitles.Type;

export class ExportError extends Schema.TaggedError<ExportError>()("ExportError", {
  reason: Schema.Literals(["no-project", "no-ffmpeg", "exists", "invalid-path", "empty", "missing-media", "source-media", "busy", "unknown-job", "invalid-settings", "no-codec"]),
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
  // T9 (D128): files dropped on the timeline also go there (frame, the lane's track), in the same edit.
  payload: Schema.Struct({ paths: Schema.Array(Schema.String), drop: Schema.optional(Schema.Struct({ frame: Schema.Number, track: Schema.optional(Schema.String) })) }),
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

// ---- sound library (D134) ----

export const LibraryHitSchema = Schema.Struct({
  source: Schema.Literals(["openverse", "freesound"]),
  id: Schema.String,
  title: Schema.String,
  creator: Schema.String,
  creatorUrl: Schema.optional(Schema.String),
  landingUrl: Schema.String,
  provider: Schema.optional(Schema.String),
  license: Schema.Literals(["cc0", "by"]),
  licenseVersion: Schema.String,
  licenseUrl: Schema.String,
  attribution: Schema.String,
  seconds: Schema.optional(Schema.Number),
  tags: Schema.Array(Schema.String),
  filetype: Schema.optional(Schema.String),
});

/** Why a search has no fresh results: the source's request limit (Openverse without an account: 20 a minute, 200 a day). */
export const LibraryLimit = Schema.Struct({
  scope: Schema.Literals(["minute", "day"]),
  // When searching works again (ISO 8601), as far as Uncut knows.
  until: Schema.String,
});
export type LibraryLimit = typeof LibraryLimit.Type;

export const LibrarySearchResult = Schema.Struct({
  hits: Schema.Array(LibraryHitSchema),
  total: Schema.Number,
  page: Schema.Number,
  pages: Schema.Number,
  source: Schema.Literals(["openverse", "freesound"]),
  // Answered from Uncut's cache of recent searches (no request went out).
  cached: Schema.Boolean,
  limit: Schema.optional(LibraryLimit),
  // Searches left before the source's limit, when it says (Openverse's headers).
  left: Schema.optional(Schema.Struct({ minute: Schema.optional(Schema.Number), day: Schema.optional(Schema.Number) })),
});
export type LibrarySearchResult = typeof LibrarySearchResult.Type;

export const LibraryState = Schema.Struct({
  // The sources that can search now: Openverse always, Freesound with the user's key.
  sources: Schema.Array(Schema.Literals(["openverse", "freesound"])),
  limit: Schema.optional(LibraryLimit),
});
export type LibraryState = typeof LibraryState.Type;

export class LibraryError extends Schema.TaggedError<LibraryError>()("LibraryError", {
  reason: Schema.Literals(["bad-request", "no-key", "network", "refused", "limit", "no-project", "io"]),
  message: Schema.String,
}) {}

// Searches the online library (Openverse, or Freesound with the user's key): CC0 and CC BY only.
const LibrarySearchRpc = Rpc.make(RPC_METHODS.librarySearch, {
  payload: Schema.Struct({
    kind: Schema.Literals(["music", "sfx"]),
    query: Schema.String,
    source: Schema.optional(Schema.Literals(["openverse", "freesound"])),
    license: Schema.optional(Schema.Literals(["cc0", "by"])),
    length: Schema.optional(Schema.Literals(["short", "medium", "long"])),
    songs: Schema.optional(Schema.Boolean),
    page: Schema.optional(Schema.Number),
  }),
  success: LibrarySearchResult,
  error: LibraryError,
});

// Downloads a hit of a recent search into the open project's media/ folder (or copies a bundled
// sound effect, id "sfx:<id>"); returns its relative path, length and the media's source (its
// credits). The renderer adds the media and the timeline item in one edit.
const LibraryAddRpc = Rpc.make(RPC_METHODS.libraryAdd, {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ path: Schema.String, seconds: Schema.Number, name: Schema.String, source: Schema.Record(Schema.String, Schema.Unknown) }),
  error: LibraryError,
});

const LibraryStateRpc = Rpc.make(RPC_METHODS.libraryState, { payload: Empty, success: LibraryState });

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
    // @mentions and Add to chat chips (D140, D141).
    mentions: Schema.optional(Schema.Array(AgentMention)),
    // The composer's choices (D184): a model id (absent: Claude Code's default), effort, access, images.
    model: Schema.optional(Schema.String),
    effort: Schema.optional(AgentEffort),
    access: Schema.optional(AgentAccess),
    images: Schema.optional(Schema.Array(AgentImage)),
    // D188: Settings › App › Agent "Edit freely skips the storyboard approval".
    skipStoryboard: Schema.optional(Schema.Boolean),
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

// D205: recent captures, imports and generations from other projects (the user's media index), newest first.
const MediaRecentRpc = Rpc.make(RPC_METHODS.mediaRecent, {
  payload: Schema.Struct({ query: Schema.optional(Schema.String), kind: Schema.optional(Schema.String), limit: Schema.optional(Schema.Number) }),
  success: Schema.Struct({ entries: Schema.Array(MediaRecentEntry) }),
});
// D205: one of them into the open project: copied into media/imports/ when it lives in another project's folder, else referenced (D12). One undoable edit.
const MediaRecentImportRpc = Rpc.make(RPC_METHODS.mediaRecentImport, {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ mediaId: Schema.optional(Schema.String), name: Schema.String, copied: Schema.Boolean }),
  error: ProjectError,
});

// D206: puts back the graphics a turn's clean-up moved to the trash (those still there).
const AgentRestoreCleanupRpc = Rpc.make(RPC_METHODS.agentRestoreCleanup, {
  payload: Schema.Struct({ turnId: Schema.String }),
  success: Schema.Struct({ restored: Schema.Array(Schema.String) }),
  error: AgentError,
});

// The user's answer to the running turn's approval (D99); an unknown or expired id is ignored.
// accepted: false when the card was no longer open (answered, timed out, the turn stopped or another card replaced it).
// D187/D188: a question card's answer, a storyboard card's edited beats or change note.
const AgentApproveRpc = Rpc.make(RPC_METHODS.agentApprove, {
  payload: Schema.Struct({ id: Schema.String, allow: Schema.Boolean, source: Schema.optional(Schema.String), answer: Schema.optional(AgentAnswer), beats: Schema.optional(Schema.Array(StoryboardBeat)), note: Schema.optional(Schema.String), always: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ accepted: Schema.Boolean }),
});
// D188: the user edits the brief (or the storyboard) by hand; saved to the project and seen by the agent's next message.
const AgentPlanSaveRpc = Rpc.make(RPC_METHODS.agentPlanSave, { payload: Schema.Struct({ brief: Schema.optional(Brief), storyboard: Schema.optional(Storyboard) }), success: AgentPlan, error: AgentError });
// D186: brand kits and skills (global and the open project's), and the project's choice.
const BrandGetRpc = Rpc.make(RPC_METHODS.brandGet, { payload: Empty, success: BrandState, error: BrandError });
// Saves a kit (new or changed) in its scope; returns the new state.
const BrandSaveKitRpc = Rpc.make(RPC_METHODS.brandSaveKit, { payload: Schema.Struct({ kit: BrandKit }), success: BrandState, error: BrandError });
const BrandDeleteKitRpc = Rpc.make(RPC_METHODS.brandDeleteKit, { payload: Schema.Struct({ id: Schema.String, scope: BrandScope }), success: BrandState, error: BrandError });
const BrandSaveSkillRpc = Rpc.make(RPC_METHODS.brandSaveSkill, { payload: Schema.Struct({ skill: BrandSkill }), success: BrandState, error: BrandError });
const BrandDeleteSkillRpc = Rpc.make(RPC_METHODS.brandDeleteSkill, { payload: Schema.Struct({ id: Schema.String, scope: BrandScope }), success: BrandState, error: BrandError });
const BrandSetActiveRpc = Rpc.make(RPC_METHODS.brandSetActive, { payload: BrandActive, success: BrandState, error: BrandError });
// Copies a file (a logo, an example frame) into a kit's folder; returns the state with the file's name in the kit's files.
/** D198: logos and fonts from a file, a folder or an https address into a kit's folder (kit.json unchanged: the editor's draft takes them). */
export const BrandImported = Schema.Struct({ name: Schema.String, kind: Schema.Literals(["logo", "font"]), slot: Schema.optional(Schema.Literals(["light", "dark", "mark"])), family: Schema.optional(Schema.String) });
export type BrandImported = typeof BrandImported.Type;
const BrandImportRpc = Rpc.make(RPC_METHODS.brandImport, { payload: Schema.Struct({ kit: Schema.String, scope: BrandScope, source: Schema.String }), success: Schema.Struct({ files: Schema.Array(BrandImported), state: BrandState }), error: BrandError });
const BrandAddFileRpc = Rpc.make(RPC_METHODS.brandAddFile, { payload: Schema.Struct({ kit: Schema.String, scope: BrandScope, path: Schema.String }), success: Schema.Struct({ name: Schema.String, state: BrandState }), error: BrandError });
// D144: the renderer's answer to an allowed screen_record: the uploaded take (media/uploads, named
// like takeUploadName("screen", ...)) with the source's name, or what went wrong.
const AgentScreenTakeRpc = Rpc.make(RPC_METHODS.agentScreenTake, { payload: Schema.Struct({ id: Schema.String, path: Schema.optional(Schema.String), source: Schema.optional(Schema.String), problem: Schema.optional(Schema.String) }) });

// Starts an export of the open project (as it is now) to `output`, an absolute .mp4 path; returns
// the job id at once. An existing file is replaced only with `overwrite`.
const ExportStartRpc = Rpc.make(RPC_METHODS.exportStart, {
  payload: Schema.Struct({ output: Schema.String, quality: ExportQuality, loudness: ExportLoudness, targetLufs: Schema.optional(Schema.Number), overwrite: Schema.optional(Schema.Boolean), subtitles: Schema.optional(ExportSubtitles), burnCaptions: Schema.optional(Schema.Boolean), range: Schema.optional(ExportRange), video: Schema.optional(ExportVideo) }),
  success: Schema.Struct({ jobId: Schema.String }),
  error: ExportError,
});
// Recent export jobs, now and on every change.
const ExportJobsRpc = Rpc.make(RPC_METHODS.exportJobs, { payload: Empty, success: Schema.Array(ExportJob), stream: true });
// Stops a queued or running export; its temp files and partial output are removed.
const ExportCancelRpc = Rpc.make(RPC_METHODS.exportCancel, { payload: Schema.Struct({ jobId: Schema.String }) });
/** D105: just the subtitles, as a .srt or .vtt file (the format by its extension); no video. */
const ExportSubtitlesRpc = Rpc.make(RPC_METHODS.exportSubtitles, {
  payload: Schema.Struct({ output: Schema.String, overwrite: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ path: Schema.String, format: Schema.Literals(["srt", "vtt"]), cues: Schema.Number }),
  error: ExportError,
});

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
  payload: Schema.Struct({ device: Schema.String, ...CaptureOptions.fields }),
  success: Schema.Struct({ device: Schema.String, startedAt: Schema.String }),
  error: CaptureError,
});
const CaptureStopRpc = Rpc.make(RPC_METHODS.captureStop, {
  payload: Schema.Struct({ device: Schema.String }),
  success: Schema.Struct({ mediaId: Schema.String, name: Schema.String, seconds: Schema.Number }),
  error: CaptureError,
});

// D143: boot a shut-down simulator or an AVD (only on the user's click; never the agent). Returns the
// id to record (an AVD's emulator gets a serial of its own).
const CaptureBootRpc = Rpc.make(RPC_METHODS.captureBoot, {
  payload: Schema.Struct({ device: Schema.String }),
  success: Schema.Struct({ device: Schema.String, name: Schema.String }),
  error: CaptureError,
});
// D143: a take that replays a saved flow while recording; it ends with the flow and is imported as
// one user edit, like Stop's.
const CaptureRecordRpc = Rpc.make(RPC_METHODS.captureRecord, {
  payload: Schema.Struct({ device: Schema.String, flow: Schema.String, showTouches: Schema.optional(Schema.Boolean), orientation: Schema.optional(CaptureOrientation), bundleId: Schema.optional(Schema.String) }),
  success: Schema.Struct({ mediaId: Schema.String, name: Schema.String, seconds: Schema.Number }),
  error: CaptureError,
});

// A take recorded on this Mac (D114): the renderer uploads the recorder's file to /api/upload (the
// project's media/uploads/, local or remote alike), then this moves it into media/captures/,
// converts it (m4a for a voiceover, mp4 for camera and screen) and imports it as one user edit,
// placed on the timeline at `placeAt` (a project frame) when given. `device` is the input's name.
const CaptureSaveRpc = Rpc.make(RPC_METHODS.captureSave, {
  payload: Schema.Struct({ path: Schema.String, kind: TakeKind, name: Schema.optional(Schema.String), device: Schema.optional(Schema.String), placeAt: Schema.optional(Schema.Number) }),
  success: Schema.Struct({ mediaId: Schema.String, name: Schema.String, seconds: Schema.Number, itemId: Schema.optional(Schema.String), trackId: Schema.optional(Schema.String) }),
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

// The server's own disk, for a remote environment's pickers (D107): one folder's entries (hidden ones left out).
const FilesListRpc = Rpc.make(RPC_METHODS.filesList, { payload: Schema.Struct({ dir: Schema.optional(Schema.String) }), success: FileListing, error: FilesError });

export const WsRpcGroup = RpcGroup.make(
  FilesListRpc,
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
  CaptureSaveRpc,
  CaptureBootRpc,
  CaptureRecordRpc,
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
  ExportSubtitlesRpc,
  AgentSubscribeRpc,
  AgentSendRpc,
  AgentCancelRpc,
  AgentUndoTurnRpc,
  AgentApproveRpc,
  AgentScreenTakeRpc,
  AgentRestoreCleanupRpc,
  MediaRecentRpc,
  MediaRecentImportRpc,
  AgentPlanSaveRpc,
  BrandGetRpc,
  BrandSaveKitRpc,
  BrandDeleteKitRpc,
  BrandSaveSkillRpc,
  BrandDeleteSkillRpc,
  BrandSetActiveRpc,
  BrandAddFileRpc,
  BrandImportRpc,
  MediaImportRpc,
  MediaJobsRpc,
  MediaThumbnailsRpc,
  MusicAddRpc,
  LibrarySearchRpc,
  LibraryAddRpc,
  LibraryStateRpc,
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
  /** Which environment this is (Phase 9); absent means Local. A remote one is reached through the desktop's loopback relay (D106). */
  readonly environment?: { readonly id: string; readonly name: string; readonly kind: "local" | "remote"; readonly url?: string };
}
