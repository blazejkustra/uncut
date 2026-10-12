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
  setupCheck: "setup.check",
  setupState: "setup.state",
  setupComplete: "setup.complete",
  agentSubscribe: "agent.subscribe",
  agentSend: "agent.send",
  agentCancel: "agent.cancel",
  agentUndoTurn: "agent.undoTurn",
  exportStart: "export.start",
  exportJobs: "export.jobs",
  exportCancel: "export.cancel",
} as const;

// ---- server ----

export const ServerHello = Schema.Struct({
  version: Schema.String,
  node: Schema.String,
  pid: Schema.Number,
  mediaCore: Schema.Struct({ version: Schema.String }),
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
});
export type ProjectSnapshot = typeof ProjectSnapshot.Type;

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
  id: Schema.String, // "claude" | "codex" | "argent" | "ffmpeg" | "api-key"
  name: Schema.String,
  status: SetupStatus,
  optional: Schema.Boolean,
  version: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  detail: Schema.String,
  fix: Schema.optional(Schema.Struct({ text: Schema.String, command: Schema.optional(Schema.String) })),
});
export type SetupCheck = typeof SetupCheck.Type;

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
});
export type AgentTurn = typeof AgentTurn.Type;

/** The editor panels the agent's ui_show can open (D65): the library rail's tabs and the side tabs. */
export const AGENT_UI_PANELS = ["media", "text", "elements", "audio", "inspector", "agent"] as const;
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

/** The open project's agent: its turns (oldest first) and the one running, if any. */
export const AgentState = Schema.Struct({
  dir: Schema.String,
  provider: Schema.String,
  running: Schema.NullOr(Schema.String),
  turns: Schema.Array(AgentTurn),
  ui: Schema.optional(AgentUi),
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
/** off = the mix as it is; normal = −14 LUFS (YouTube, Instagram, TikTok); quiet = −16 LUFS (podcasts, Apple). */
export const ExportLoudness = Schema.Literals(["off", "normal", "quiet"]);
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
});
export type ExportJob = typeof ExportJob.Type;

export class ExportError extends Schema.TaggedError<ExportError>()("ExportError", {
  reason: Schema.Literals(["no-project", "no-ffmpeg", "exists", "invalid-path", "empty", "missing-media", "source-media", "busy", "unknown-job"]),
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

// Starts an export of the open project (as it is now) to `output`, an absolute .mp4 path; returns
// the job id at once. An existing file is replaced only with `overwrite`.
const ExportStartRpc = Rpc.make(RPC_METHODS.exportStart, {
  payload: Schema.Struct({ output: Schema.String, quality: ExportQuality, loudness: ExportLoudness, overwrite: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ jobId: Schema.String }),
  error: ExportError,
});
// Recent export jobs, now and on every change.
const ExportJobsRpc = Rpc.make(RPC_METHODS.exportJobs, { payload: Empty, success: Schema.Array(ExportJob), stream: true });
// Stops a queued or running export; its temp files and partial output are removed.
const ExportCancelRpc = Rpc.make(RPC_METHODS.exportCancel, { payload: Schema.Struct({ jobId: Schema.String }) });

export const WsRpcGroup = RpcGroup.make(
  ExportStartRpc,
  ExportJobsRpc,
  ExportCancelRpc,
  AgentSubscribeRpc,
  AgentSendRpc,
  AgentCancelRpc,
  AgentUndoTurnRpc,
  MediaImportRpc,
  MediaJobsRpc,
  MediaThumbnailsRpc,
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
