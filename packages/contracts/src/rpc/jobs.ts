import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { RPC_METHODS, HistoryState, ProjectError, ProjectSnapshot, EditRefused, FileListing, FilesError } from "../server.ts";
import { ExportQuality, ExportLoudness, ExportSubtitles, ExportRange, ExportVideo, ExportError, ExportJob } from "../export.ts";
import { Empty } from "./rpcs.ts";
import { Analyzer, AnalysisError, AnalysisJob, TranscriptionState, TranscriptionError } from "../analysis.ts";
import { PluginInfo, PluginError, PluginContributions, CatalogEntry } from "../plugins.ts";
import { CaptureState, CaptureError, CaptureOptions, CaptureOrientation, TakeKind, MultiPart, MultiLayout } from "../capture.ts";
import { GeneratorChoice, GeneratorInfo, GenerateRequest, GenerateError, GenerateJob, KeyInfo, KeyProvider } from "../generate.ts";

// D144: the renderer's answer to an allowed screen_record: the uploaded take (media/uploads, named
// like takeUploadName("screen", ...)) with the source's name, or what went wrong.
export const AgentScreenTakeRpc = Rpc.make(RPC_METHODS.agentScreenTake, { payload: Schema.Struct({ id: Schema.String, path: Schema.optional(Schema.String), source: Schema.optional(Schema.String), problem: Schema.optional(Schema.String) }) });

// Starts an export of the open project (as it is now) to `output`, an absolute .mp4 path; returns
// the job id at once. An existing file is replaced only with `overwrite`.
export const ExportStartRpc = Rpc.make(RPC_METHODS.exportStart, {
  payload: Schema.Struct({ output: Schema.String, quality: ExportQuality, loudness: ExportLoudness, targetLufs: Schema.optional(Schema.Number), overwrite: Schema.optional(Schema.Boolean), subtitles: Schema.optional(ExportSubtitles), burnCaptions: Schema.optional(Schema.Boolean), range: Schema.optional(ExportRange), video: Schema.optional(ExportVideo), motionBlur: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ jobId: Schema.String }),
  error: ExportError,
});
// Recent export jobs, now and on every change.
export const ExportJobsRpc = Rpc.make(RPC_METHODS.exportJobs, { payload: Empty, success: Schema.Array(ExportJob), stream: true });
// Stops a queued or running export; its temp files and partial output are removed.
export const ExportCancelRpc = Rpc.make(RPC_METHODS.exportCancel, { payload: Schema.Struct({ jobId: Schema.String }) });
/** D105: just the subtitles, as a .srt or .vtt file (the format by its extension); no video. */
export const ExportSubtitlesRpc = Rpc.make(RPC_METHODS.exportSubtitles, {
  payload: Schema.Struct({ output: Schema.String, overwrite: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ path: Schema.String, format: Schema.Literals(["srt", "vtt"]), cues: Schema.Number }),
  error: ExportError,
});

/**
 * D246: the loudness gain the export would use for `targetLufs` on the open project as it is now
 * (its own measuring passes: one gain before the limiter, checked through it), so the preview can
 * play at the target. gainDb is absent for silence. A newer call cancels a running one.
 */
export const ExportLoudnessRpc = Rpc.make(RPC_METHODS.exportLoudness, {
  payload: Schema.Struct({ targetLufs: Schema.Number }),
  success: Schema.Struct({ gainDb: Schema.optional(Schema.Number), lufs: Schema.optional(Schema.Number), cancelled: Schema.optional(Schema.Boolean) }),
  error: ExportError,
});

// Analyses a media item of the open project (all analyzers when none are named). A cached result
// or a file without sound is "done" at once; otherwise a job is queued (or an equal one joined).
export const AnalysisStartRpc = Rpc.make(RPC_METHODS.analysisStart, {
  payload: Schema.Struct({ mediaId: Schema.String, analyzers: Schema.optional(Schema.Array(Schema.String)) }),
  success: Schema.Array(Schema.Struct({ analyzer: Analyzer, state: Schema.Literals(["done", "queued", "running"]), jobId: Schema.optional(Schema.String) })),
  error: AnalysisError,
});
// Recent analysis jobs, now and on every change.
export const AnalysisJobsRpc = Rpc.make(RPC_METHODS.analysisJobs, { payload: Empty, success: Schema.Array(AnalysisJob), stream: true });
// Stops a queued or running analysis; nothing of it is left in .cache.
export const AnalysisCancelRpc = Rpc.make(RPC_METHODS.analysisCancel, { payload: Schema.Struct({ jobId: Schema.String }) });

// A cached analysis result for a media item of the open project, without starting a job (null:
// not analysed yet). The Transcript panel reads the transcript (and the silences) this way (D69); the
// timeline reads beats without their onsets (`omit: ["onsets"]`, D70): top-level result fields left out.
export const AnalysisCachedRpc = Rpc.make(RPC_METHODS.analysisCached, {
  payload: Schema.Struct({ mediaId: Schema.String, analyzer: Analyzer, omit: Schema.optional(Schema.Array(Schema.String)) }),
  success: Schema.Struct({ result: Schema.NullOr(Schema.Unknown) }),
  error: AnalysisError,
});

// The open project's history (D71) now and on every change (null: nothing open).
export const HistorySubscribeRpc = Rpc.make(RPC_METHODS.historySubscribe, { payload: Empty, success: Schema.NullOr(HistoryState), stream: true });
// The project as it was at a revision (the History tab's preview); changes nothing.
export const HistoryPreviewRpc = Rpc.make(RPC_METHODS.historyPreview, {
  payload: Schema.Struct({ revision: Schema.Int }),
  success: Schema.Struct({ revision: Schema.Number, project: Schema.Unknown }),
  error: ProjectError,
});
// Restores a revision's state as a new revision (one ⌘Z takes it back).
export const HistoryJumpRpc = Rpc.make(RPC_METHODS.historyJump, {
  payload: Schema.Struct({ revision: Schema.Int }),
  success: ProjectSnapshot,
  error: Schema.Union([EditRefused, ProjectError]),
});

// The speech models and their downloads, now and on every change.
export const TranscriptionStateRpc = Rpc.make(RPC_METHODS.transcriptionState, { payload: Empty, success: TranscriptionState, stream: true });
// Downloads a model (the chosen one when none is named); returns at once, progress on transcription.state.
export const TranscriptionDownloadRpc = Rpc.make(RPC_METHODS.transcriptionDownload, { payload: Schema.Struct({ model: Schema.optional(Schema.String) }), error: TranscriptionError });
// Stops a model download (all of them when none is named); nothing of it is left.
export const TranscriptionCancelDownloadRpc = Rpc.make(RPC_METHODS.transcriptionCancelDownload, { payload: Schema.Struct({ model: Schema.optional(Schema.String) }) });
// Chooses the model transcripts use (saved in settings).
export const TranscriptionSelectModelRpc = Rpc.make(RPC_METHODS.transcriptionSelectModel, { payload: Schema.Struct({ model: Schema.String }), error: TranscriptionError });

// The plugins found (scans the folders again), and the user allowing one / taking that back (D97).
export const PluginsListRpc = Rpc.make(RPC_METHODS.pluginsList, { payload: Empty, success: Schema.Array(PluginInfo) });
// The approval names what the user saw (folder and capabilities): a plugin that changed since is refused.
// D248: and the skills it showed (PluginInfo.skillsHash): a plugin whose skills changed since is refused too.
export const PluginsApproveRpc = Rpc.make(RPC_METHODS.pluginsApprove, { payload: Schema.Struct({ id: Schema.String, dir: Schema.String, capabilities: Schema.Array(Schema.String), skills: Schema.optional(Schema.String) }), success: Schema.Array(PluginInfo), error: PluginError });
export const PluginsRevokeRpc = Rpc.make(RPC_METHODS.pluginsRevoke, { payload: Schema.Struct({ id: Schema.String }), success: Schema.Array(PluginInfo), error: PluginError });
// Installs a plugin from a folder or a git URL (D102) into <dataDir>/plugins/<id>; it still needs allowing.
export const PluginsInstallRpc = Rpc.make(RPC_METHODS.pluginsInstall, {
  payload: Schema.Struct({ source: Schema.String, ref: Schema.optional(Schema.String), replaceBundled: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ id: Schema.String, note: Schema.optional(Schema.String), plugins: Schema.Array(PluginInfo) }),
  error: PluginError,
});
export const PluginsUninstallRpc = Rpc.make(RPC_METHODS.pluginsUninstall, { payload: Schema.Struct({ id: Schema.String }), success: Schema.Array(PluginInfo), error: PluginError });
// D103: the allowed plugins' looks, components and check rules; the open project's findings from
// process plugins' own checks (Checks are core Check objects); a plugin component copied into the
// open project's graphics/ (the renderer then inserts a graphic item with the props); the catalog.
export const PluginsContributionsRpc = Rpc.make(RPC_METHODS.pluginsContributions, { payload: Empty, success: PluginContributions });
export const PluginsCheckRpc = Rpc.make(RPC_METHODS.pluginsCheck, { payload: Empty, success: Schema.Struct({ checks: Schema.Array(Schema.Unknown), notes: Schema.Array(Schema.String) }) });
export const PluginsAddComponentRpc = Rpc.make(RPC_METHODS.pluginsAddComponent, { payload: Schema.Struct({ id: Schema.String }), success: Schema.Struct({ src: Schema.String, name: Schema.String, props: Schema.Unknown }), error: PluginError });
export const PluginsCatalogRpc = Rpc.make(RPC_METHODS.pluginsCatalog, { payload: Empty, success: Schema.Struct({ plugins: Schema.Array(CatalogEntry), problems: Schema.Array(Schema.String) }) });
// Enabling a catalog plugin copies it into <dataDir>/plugins (D102's folder install); it still needs allowing. Disable removes only such a copy.
export const PluginsDisableRpc = Rpc.make(RPC_METHODS.pluginsDisable, { payload: Schema.Struct({ id: Schema.String }), success: Schema.Array(PluginInfo), error: PluginError });
export const PluginsEnableRpc = Rpc.make(RPC_METHODS.pluginsEnable, {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ id: Schema.String, note: Schema.optional(Schema.String), plugins: Schema.Array(PluginInfo) }),
  error: PluginError,
});

// The Capture tab (D98): Argent's devices (asks the plugin each time), start and stop a recording.
// Stop imports the take into the open project as one user edit and returns its media id.
export const CaptureDevicesRpc = Rpc.make(RPC_METHODS.captureDevices, { payload: Empty, success: CaptureState, error: CaptureError });
export const CaptureStartRpc = Rpc.make(RPC_METHODS.captureStart, {
  payload: Schema.Struct({ device: Schema.String, ...CaptureOptions.fields }),
  success: Schema.Struct({ device: Schema.String, startedAt: Schema.String }),
  error: CaptureError,
});
export const CaptureStopRpc = Rpc.make(RPC_METHODS.captureStop, {
  payload: Schema.Struct({ device: Schema.String }),
  success: Schema.Struct({ mediaId: Schema.String, name: Schema.String, seconds: Schema.Number }),
  error: CaptureError,
});

// D143: boot a shut-down simulator or an AVD (only on the user's click; never the agent). Returns the
// id to record (an AVD's emulator gets a serial of its own).
export const CaptureBootRpc = Rpc.make(RPC_METHODS.captureBoot, {
  payload: Schema.Struct({ device: Schema.String }),
  success: Schema.Struct({ device: Schema.String, name: Schema.String }),
  error: CaptureError,
});
// D143: a take that replays a saved flow while recording; it ends with the flow and is imported as
// one user edit, like Stop's.
export const CaptureRecordRpc = Rpc.make(RPC_METHODS.captureRecord, {
  payload: Schema.Struct({ device: Schema.String, flow: Schema.String, showTouches: Schema.optional(Schema.Boolean), orientation: Schema.optional(CaptureOrientation), bundleId: Schema.optional(Schema.String) }),
  success: Schema.Struct({ mediaId: Schema.String, name: Schema.String, seconds: Schema.Number }),
  error: CaptureError,
});

// A take recorded on this Mac (D114): the renderer uploads the recorder's file to /api/upload (the
// project's media/uploads/, local or remote alike), then this moves it into media/captures/,
// converts it (m4a for a voiceover, mp4 for camera and screen) and imports it as one user edit,
// placed on the timeline at `placeAt` (a project frame) when given. `device` is the input's name.
export const CaptureSaveRpc = Rpc.make(RPC_METHODS.captureSave, {
  payload: Schema.Struct({ path: Schema.String, kind: TakeKind, name: Schema.optional(Schema.String), device: Schema.optional(Schema.String), placeAt: Schema.optional(Schema.Number) }),
  success: Schema.Struct({ mediaId: Schema.String, name: Schema.String, seconds: Schema.Number, itemId: Schema.optional(Schema.String), trackId: Schema.optional(Schema.String) }),
  error: CaptureError,
});

// D211: a multi-source take (screen, camera, microphone, this Mac's sound recorded together): each
// part uploaded on its own, converted into media/captures/<take>/ (screen.mp4, camera.mp4, mic.m4a,
// system.m4a) and imported as one user edit; with placeAt every part goes on the timeline there,
// start-aligned by the parts' offsets and grouped, the camera over the screen in `layout`.
export const CaptureSaveMultiRpc = Rpc.make(RPC_METHODS.captureSaveMulti, {
  payload: Schema.Struct({ parts: Schema.Array(MultiPart), name: Schema.optional(Schema.String), placeAt: Schema.optional(Schema.Number), layout: Schema.optional(MultiLayout) }),
  success: Schema.Struct({
    name: Schema.String,
    seconds: Schema.Number,
    folder: Schema.String,
    media: Schema.Array(Schema.Struct({ mediaId: Schema.String, kind: TakeKind, name: Schema.String, file: Schema.String })),
    items: Schema.Array(Schema.Struct({ itemId: Schema.String, trackId: Schema.String, kind: TakeKind, start: Schema.Number, in: Schema.Number, duration: Schema.Number })),
    group: Schema.optional(Schema.String),
  }),
  error: CaptureError,
});

// Generators (D99): which there are and whether each has its key; a generation into the open
// project (returns at once; progress on generate.jobs); cancel one.
export const GenerateListRpc = Rpc.make(RPC_METHODS.generateList, { payload: Empty, success: Schema.Array(GeneratorInfo) });
export const GenerateStartRpc = Rpc.make(RPC_METHODS.generateStart, { payload: GenerateRequest, success: Schema.Struct({ jobId: Schema.String }), error: GenerateError });
export const GenerateJobsRpc = Rpc.make(RPC_METHODS.generateJobs, { payload: Empty, success: Schema.Array(GenerateJob), stream: true });
export const GenerateCancelRpc = Rpc.make(RPC_METHODS.generateCancel, { payload: Schema.Struct({ jobId: Schema.String }) });
// A plugin generator's choices for one option, from the plugin (#108: the voices of the user's account).
export const GenerateChoicesRpc = Rpc.make(RPC_METHODS.generateChoices, { payload: Schema.Struct({ generator: Schema.String, option: Schema.String }), success: Schema.Array(GeneratorChoice), error: GenerateError });
// Settings › Keys (D99): which providers have a key; store or remove one. A key goes in, never out.
export const KeysListRpc = Rpc.make(RPC_METHODS.keysList, { payload: Empty, success: Schema.Array(KeyInfo) });
export const KeysSetRpc = Rpc.make(RPC_METHODS.keysSet, { payload: Schema.Struct({ provider: KeyProvider, key: Schema.String }), success: Schema.Array(KeyInfo), error: GenerateError });
export const KeysRemoveRpc = Rpc.make(RPC_METHODS.keysRemove, { payload: Schema.Struct({ provider: KeyProvider }), success: Schema.Array(KeyInfo), error: GenerateError });

// The server's own disk, for a remote environment's pickers (D107): one folder's entries (hidden ones left out).
export const FilesListRpc = Rpc.make(RPC_METHODS.filesList, { payload: Schema.Struct({ dir: Schema.optional(Schema.String) }), success: FileListing, error: FilesError });
