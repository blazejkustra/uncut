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
  setupCheck: "setup.check",
  setupState: "setup.state",
  setupComplete: "setup.complete",
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

const SetupCheckRpc = Rpc.make(RPC_METHODS.setupCheck, { payload: Empty, success: Schema.Array(SetupCheck) });
const SetupStateRpc = Rpc.make(RPC_METHODS.setupState, { payload: Empty, success: Schema.Struct({ onboarded: Schema.Boolean }) });
// Onboarding was finished or skipped: don't show it on launch again.
const SetupCompleteRpc = Rpc.make(RPC_METHODS.setupComplete, { payload: Empty });

export const WsRpcGroup = RpcGroup.make(
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
