import * as Schema from "effect/Schema";

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
  mediaProxies: "media.proxies",
  librarySearch: "library.search",
  libraryAdd: "library.add",
  libraryState: "library.state",
  libraryFolders: "library.folders",
  libraryFolderAdd: "library.folderAdd",
  libraryFolderRemove: "library.folderRemove",
  setupCheck: "setup.check",
  setupState: "setup.state",
  setupComplete: "setup.complete",
  agentSubscribe: "agent.subscribe",
  agentSend: "agent.send",
  agentCancel: "agent.cancel",
  agentUndoTurn: "agent.undoTurn",
  agentRedoTurn: "agent.redoTurn",
  agentApprove: "agent.approve",
  exportStart: "export.start",
  exportJobs: "export.jobs",
  exportCancel: "export.cancel",
  exportSubtitles: "export.subtitles",
  exportLoudness: "export.loudness",
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
  captureSaveMulti: "capture.saveMulti",
  captureBoot: "capture.boot",
  captureRecord: "capture.record",
  agentScreenTake: "agent.screenTake",
  agentRestoreCleanup: "agent.restoreCleanup",
  agentNewThread: "agent.newThread",
  mediaRecent: "media.recent",
  mediaRecentImport: "media.recentImport",
  generateList: "generate.list",
  generateStart: "generate.start",
  generateJobs: "generate.jobs",
  generateCancel: "generate.cancel",
  generateChoices: "generate.choices",
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
  templatesList: "templates.list",
  templatesSave: "templates.save",
  templatesDelete: "templates.delete",
  templatesFill: "templates.fill",
  telemetryState: "telemetry.state",
  telemetrySet: "telemetry.set",
  telemetryCrash: "telemetry.crash",
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
  // D209: the NTSC rates are stored as 23.976, 29.97 and 59.94.
  fps: Schema.Literals([23.976, 24, 25, 29.97, 30, 50, 59.94, 60]),
  background: Schema.optional(Schema.String),
});

export const RecentProject = Schema.Struct({
  dir: Schema.String,
  name: Schema.String,
  openedAt: Schema.String,
});
export type RecentProject = typeof RecentProject.Type;
