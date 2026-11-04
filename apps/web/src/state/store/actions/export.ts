import { type ExportQuality, type ExportLoudness, type ExportSubtitles, type ExportVideo } from "@uncut/contracts";
import { bridge } from "../../bridge.ts";
import { set, state, isRemote } from "../core.ts";
import { pickRemote } from "./remote.ts";
import { call, plainError } from "../server.ts";
import { revealWhenDone } from "../sync.ts";
import { actions } from "../actions.ts";

/** Past the plugin host's own cap on one call (1800 s, D325), so it's the module that answers. */
const VISION_EDIT_TIMEOUT_MS = 35 * 60_000;

const setTrackNote = (itemId: string, note: string | undefined) => {
  const { [itemId]: _old, ...others } = state.trackNotes ?? {};
  set({ trackNotes: note ? { ...others, [itemId]: note } : others });
};

export const exportActions = {
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
  async startExport(input: {
    output: string;
    quality: ExportQuality;
    loudness: ExportLoudness;
    targetLufs?: number;
    overwrite?: boolean;
    subtitles?: ExportSubtitles;
    burnCaptions?: boolean;
    range?: { from: number; to: number };
    video?: ExportVideo;
    motionBlur?: boolean;
    review?: boolean;
  }): Promise<{ readonly reason?: string; readonly message: string } | undefined> {
    const result = await call((c) => c["export.start"](input));
    if (!result.ok) return { reason: (result.error as { reason?: string }).reason, message: plainError(result.error) };
    revealWhenDone.add(result.value.jobId);
    set({ exportJobId: result.value.jobId, exportFolder: input.output.slice(0, input.output.lastIndexOf("/")) || "/" });
    return undefined;
  },
  cancelExport: (jobId: string) => call((c) => c["export.cancel"]({ jobId })),
  /** The timeline as a .fcpxml or .edl file; the saved file and what it lost, or the server's refusal. */
  async exportTimeline(input: {
    output: string;
    overwrite?: boolean;
  }): Promise<{ readonly path: string; readonly warnings: ReadonlyArray<string> } | { readonly reason?: string; readonly message: string }> {
    const result = await call((c) => c["export.timeline"](input));
    if (!result.ok) return { reason: (result.error as { reason?: string }).reason, message: plainError(result.error) };
    set({ exportFolder: input.output.slice(0, input.output.lastIndexOf("/")) || "/" });
    return result.value;
  },
  /** D105: just the subtitles as a .srt / .vtt file; the saved file, or the server's refusal. */
  async exportSubtitles(input: {
    output: string;
    overwrite?: boolean;
  }): Promise<{ readonly path: string; readonly cues: number } | { readonly reason?: string; readonly message: string }> {
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
  /** D328: auto reframe a clip to the canvas's shape (the server finds its faces first): undefined when done, else why not. */
  async reframe(itemId: string): Promise<string | undefined> {
    const result = await call((c) => c["vision.reframe"]({ itemId }), VISION_EDIT_TIMEOUT_MS);
    return result.ok ? undefined : plainError(result.error);
  },

  async track(ask: {
    readonly itemId: string;
    readonly targetId: string;
    readonly frame: number;
    readonly box: { x: number; y: number; w: number; h: number };
    readonly scale?: boolean;
  }) {
    setTrackNote(ask.itemId, undefined);
    const result = await call((c) => c["vision.track"](ask), VISION_EDIT_TIMEOUT_MS);
    setTrackNote(ask.itemId, result.ok ? result.value.note : plainError(result.error));
  },
  cancelTrack: (itemId: string) => call((c) => c["vision.trackCancel"]({ itemId })),

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
};
