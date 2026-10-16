import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { RPC_METHODS, ServerHello, MediaCoreError, Canvas, ProjectSnapshot, ProjectError, EditRefused, RecentProject } from "../server.ts";
import { LibrarySearchResult, LibraryError, LibraryState, SoundFolderSchema } from "../library.ts";
import { ImportJob, ProxyState, SetupCheck, MediaRecentEntry } from "../media.ts";
import { AgentState, AgentMention, AgentEffort, AgentAccess, AgentImage, AgentError, AgentAnswer, StoryboardBeat, Brief, Storyboard, IntendedFinding, AgentPlan } from "../agent.ts";
import { BrandState, BrandError, BrandKit, BrandScope, BrandSkill, BrandActive, BrandImported } from "../brand.ts";

export const Empty = Schema.Struct({});

export const ServerHelloRpc = Rpc.make(RPC_METHODS.serverHello, {
  payload: Empty,
  success: ServerHello,
  error: MediaCoreError,
});

export const ProjectCreateRpc = Rpc.make(RPC_METHODS.projectCreate, {
  payload: Schema.Struct({ parentDir: Schema.String, name: Schema.String, canvas: Schema.optional(Canvas), matchFirstClip: Schema.optional(Schema.Boolean) }),
  success: ProjectSnapshot,
  error: ProjectError,
});

export const ProjectOpenRpc = Rpc.make(RPC_METHODS.projectOpen, {
  payload: Schema.Struct({ dir: Schema.String }),
  success: ProjectSnapshot,
  error: ProjectError,
});

export const ProjectGetRpc = Rpc.make(RPC_METHODS.projectGet, { payload: Empty, success: ProjectSnapshot, error: ProjectError });

// Re-read project.json (after a hand edit). If it doesn't validate, the current session stays.
export const ProjectReloadRpc = Rpc.make(RPC_METHODS.projectReload, { payload: Empty, success: ProjectSnapshot, error: ProjectError });

// The open project as it changes: the current snapshot (or null: nothing open) right away,
// then every change, in the order the server made them. Clients mirror this rather than
// trusting call results, which a dropped connection can lose.
export const ProjectSubscribeRpc = Rpc.make(RPC_METHODS.projectSubscribe, {
  payload: Empty,
  success: Schema.NullOr(ProjectSnapshot),
  stream: true,
});

// Back to no open project (the welcome screen). A no-op when nothing is open.
export const ProjectCloseRpc = Rpc.make(RPC_METHODS.projectClose, { payload: Empty });

export const ProjectEditRpc = Rpc.make(RPC_METHODS.projectEdit, {
  payload: Schema.Struct({
    // Edit ops (spec/schema/edit-ops.schema.json); the engine checks them.
    ops: Schema.Array(Schema.Unknown),
    baseRevision: Schema.optional(Schema.Int),
    summary: Schema.optional(Schema.String),
  }),
  success: ProjectSnapshot,
  error: Schema.Union([EditRefused, ProjectError]),
});

export const ProjectUndoRpc = Rpc.make(RPC_METHODS.projectUndo, { payload: Empty, success: ProjectSnapshot, error: ProjectError });
export const ProjectRedoRpc = Rpc.make(RPC_METHODS.projectRedo, { payload: Empty, success: ProjectSnapshot, error: ProjectError });

export const RecentsListRpc = Rpc.make(RPC_METHODS.recentsList, { payload: Empty, success: Schema.Array(RecentProject) });

// Starts an import job into the open project and returns its id right away; follow it with
// media.jobs. Footage is referenced by its absolute path, never copied (D12); one undoable edit.
export const MediaImportRpc = Rpc.make(RPC_METHODS.mediaImport, {
  // T9 (D128): files dropped on the timeline also go there (frame, the lane's track), in the same edit.
  payload: Schema.Struct({ paths: Schema.Array(Schema.String), drop: Schema.optional(Schema.Struct({ frame: Schema.Number, track: Schema.optional(Schema.String) })) }),
  success: Schema.Struct({ jobId: Schema.String }),
  error: ProjectError,
});

// Searches the online library (Openverse, or Freesound with the user's key): CC0 and CC BY only.
export const LibrarySearchRpc = Rpc.make(RPC_METHODS.librarySearch, {
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
export const LibraryAddRpc = Rpc.make(RPC_METHODS.libraryAdd, {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ path: Schema.String, seconds: Schema.Number, name: Schema.String, source: Schema.Record(Schema.String, Schema.Unknown) }),
  error: LibraryError,
});

export const LibraryStateRpc = Rpc.make(RPC_METHODS.libraryState, { payload: Empty, success: LibraryState });

// The user's sound folders with their audio files (indexed again when asked with rescan).
export const LibraryFoldersRpc = Rpc.make(RPC_METHODS.libraryFolders, {
  payload: Schema.Struct({ rescan: Schema.optional(Schema.Boolean) }),
  success: Schema.Array(SoundFolderSchema),
  error: LibraryError,
});
// Adds a folder (an absolute path; ~ is the home folder): its audio files become a library, referenced until one is added.
export const LibraryFolderAddRpc = Rpc.make(RPC_METHODS.libraryFolderAdd, {
  payload: Schema.Struct({ path: Schema.String }),
  success: Schema.Array(SoundFolderSchema),
  error: LibraryError,
});
// Forgets a folder (its files stay where they are).
export const LibraryFolderRemoveRpc = Rpc.make(RPC_METHODS.libraryFolderRemove, {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Array(SoundFolderSchema),
  error: LibraryError,
});

// Recent import jobs, now and on every change.
export const MediaJobsRpc = Rpc.make(RPC_METHODS.mediaJobs, { payload: Empty, success: Schema.Array(ImportJob), stream: true });

// Which media ids have a poster at THUMB_PATH (the rest show an icon).
// D212: the open project's preview proxies, now and on every change.
export const MediaProxiesRpc = Rpc.make(RPC_METHODS.mediaProxies, { payload: Empty, success: Schema.Array(ProxyState), stream: true });

export const MediaThumbnailsRpc = Rpc.make(RPC_METHODS.mediaThumbnails, { payload: Empty, success: Schema.Array(Schema.String) });

export const SetupCheckRpc = Rpc.make(RPC_METHODS.setupCheck, { payload: Empty, success: Schema.Array(SetupCheck) });
export const SetupStateRpc = Rpc.make(RPC_METHODS.setupState, { payload: Empty, success: Schema.Struct({ onboarded: Schema.Boolean }) });
// Onboarding was finished or skipped: don't show it on launch again.
export const SetupCompleteRpc = Rpc.make(RPC_METHODS.setupComplete, { payload: Empty });

// The open project's agent now and on every change (null: nothing open). Like project.subscribe,
// whole states, so a reconnect needs nothing else.
export const AgentSubscribeRpc = Rpc.make(RPC_METHODS.agentSubscribe, { payload: Empty, success: Schema.NullOr(AgentState), stream: true });

// Starts a turn and returns its id; what happens arrives on agent.subscribe. One at a time.
export const AgentSendRpc = Rpc.make(RPC_METHODS.agentSend, {
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
    // D188: Settings › App › Agent "Auto skips the storyboard approval".
    skipStoryboard: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({ turnId: Schema.String }),
  error: AgentError,
});

// Stops the running turn (a no-op when none is running). Edits it already made stay.
export const AgentCancelRpc = Rpc.make(RPC_METHODS.agentCancel, { payload: Empty });

// Reverts one turn's edits as one undoable step, keeping later edits (D7).
export const AgentUndoTurnRpc = Rpc.make(RPC_METHODS.agentUndoTurn, {
  payload: Schema.Struct({ turnId: Schema.String }),
  success: ProjectSnapshot,
  error: Schema.Union([AgentError, EditRefused, ProjectError]),
});

// D205: recent captures, imports and generations from other projects (the user's media index), newest first.
export const MediaRecentRpc = Rpc.make(RPC_METHODS.mediaRecent, {
  payload: Schema.Struct({ query: Schema.optional(Schema.String), kind: Schema.optional(Schema.String), limit: Schema.optional(Schema.Number) }),
  success: Schema.Struct({ entries: Schema.Array(MediaRecentEntry) }),
});
// D205: one of them into the open project: copied into media/imports/ when it lives in another project's folder, else referenced (D12). One undoable edit.
export const MediaRecentImportRpc = Rpc.make(RPC_METHODS.mediaRecentImport, {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ mediaId: Schema.optional(Schema.String), name: Schema.String, copied: Schema.Boolean }),
  error: ProjectError,
});

// D295: a new chat: the next message starts a fresh Claude conversation; earlier turns stay in the
// history (undo still works) and the panel folds them away. Refused while a turn runs.
export const AgentNewThreadRpc = Rpc.make(RPC_METHODS.agentNewThread, { payload: Empty, success: Schema.Struct({ threadStart: Schema.String }), error: AgentError });

// D206: puts back the graphics a turn's clean-up moved to the trash (those still there).
export const AgentRestoreCleanupRpc = Rpc.make(RPC_METHODS.agentRestoreCleanup, {
  payload: Schema.Struct({ turnId: Schema.String }),
  success: Schema.Struct({ restored: Schema.Array(Schema.String) }),
  error: AgentError,
});

// The user's answer to the running turn's approval (D99); an unknown or expired id is ignored.
// accepted: false when the card was no longer open (answered, timed out, the turn stopped or another card replaced it).
// D187/D188: a question card's answer, a storyboard card's edited beats or change note.
export const AgentApproveRpc = Rpc.make(RPC_METHODS.agentApprove, {
  payload: Schema.Struct({ id: Schema.String, allow: Schema.Boolean, source: Schema.optional(Schema.String), answer: Schema.optional(AgentAnswer), beats: Schema.optional(Schema.Array(StoryboardBeat)), note: Schema.optional(Schema.String), always: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ accepted: Schema.Boolean }),
});
// D188: the user edits the brief (or the storyboard) by hand; saved to the project and seen by the agent's next message.
export const AgentPlanSaveRpc = Rpc.make(RPC_METHODS.agentPlanSave, { payload: Schema.Struct({ brief: Schema.optional(Brief), storyboard: Schema.optional(Storyboard), intended: Schema.optional(Schema.Array(IntendedFinding)) }), success: AgentPlan, error: AgentError });
// D186: brand kits and skills (global and the open project's), and the project's choice.
export const BrandGetRpc = Rpc.make(RPC_METHODS.brandGet, { payload: Empty, success: BrandState, error: BrandError });
// Saves a kit (new or changed) in its scope; returns the new state.
export const BrandSaveKitRpc = Rpc.make(RPC_METHODS.brandSaveKit, { payload: Schema.Struct({ kit: BrandKit }), success: BrandState, error: BrandError });
export const BrandDeleteKitRpc = Rpc.make(RPC_METHODS.brandDeleteKit, { payload: Schema.Struct({ id: Schema.String, scope: BrandScope }), success: BrandState, error: BrandError });
export const BrandSaveSkillRpc = Rpc.make(RPC_METHODS.brandSaveSkill, { payload: Schema.Struct({ skill: BrandSkill }), success: BrandState, error: BrandError });
export const BrandDeleteSkillRpc = Rpc.make(RPC_METHODS.brandDeleteSkill, { payload: Schema.Struct({ id: Schema.String, scope: BrandScope }), success: BrandState, error: BrandError });
export const BrandSetActiveRpc = Rpc.make(RPC_METHODS.brandSetActive, { payload: BrandActive, success: BrandState, error: BrandError });
export const BrandImportRpc = Rpc.make(RPC_METHODS.brandImport, { payload: Schema.Struct({ kit: Schema.String, scope: BrandScope, source: Schema.String }), success: Schema.Struct({ files: Schema.Array(BrandImported), state: BrandState }), error: BrandError });
export const BrandAddFileRpc = Rpc.make(RPC_METHODS.brandAddFile, { payload: Schema.Struct({ kit: Schema.String, scope: BrandScope, path: Schema.String }), success: Schema.Struct({ name: Schema.String, state: BrandState }), error: BrandError });
