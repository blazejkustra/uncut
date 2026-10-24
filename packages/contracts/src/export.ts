import * as Schema from "effect/Schema";

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
/** D212: VideoToolbox (hardware) or libx264 / libx265 (software); absent = the preset's (High software, else hardware). */
export const ExportEncoder = Schema.Literals(["hardware", "software"]);
export type ExportEncoder = typeof ExportEncoder.Type;
export const ExportVideo = Schema.Struct({
  codec: Schema.optional(ExportCodec),
  encoder: Schema.optional(ExportEncoder),
  bitrateMbps: Schema.optional(Schema.Number),
  shortSide: Schema.optional(Schema.Number),
  fps: Schema.optional(Schema.Number),
});
export type ExportVideo = typeof ExportVideo.Type;

export const ExportJob = Schema.Struct({
  id: Schema.String,
  projectDir: Schema.String,
  name: Schema.String,
  output: Schema.String,
  quality: ExportQuality,
  /** F4 (D171): the codec it was encoded with (absent on jobs from before: H.264 then, HEVC for High). */
  codec: Schema.optional(ExportCodec),
  /** D212: the encoder that made the file (software when the hardware one failed and it fell back). */
  encoder: Schema.optional(ExportEncoder),
  /** F4 (D171): a bitrate chosen in Advanced (Mb/s); absent = the preset's. */
  bitrateMbps: Schema.optional(Schema.Number),
  loudness: ExportLoudness,
  /** The integrated loudness it normalises to (D87); absent with As mixed. */
  targetLufs: Schema.optional(Schema.Number),
  phase: Schema.Literals(["queued", "preparing", "rendering", "done", "failed", "cancelled"]),
  progress: Schema.Number,
  /**
   * What a preparing job is doing now, for the dialog: measuring the sound, drawing the graphics
   * (frame `done` of `total`, which can take minutes: a heavy graphic with motion blur), drawing the
   * shader effects (the same), or measuring the loudness. Absent before the first step.
   */
  step: Schema.optional(
    Schema.Struct({
      kind: Schema.Literals(["sound", "graphics", "shaders", "loudness"]),
      done: Schema.optional(Schema.Number),
      total: Schema.optional(Schema.Number),
    }),
  ),
  etaSeconds: Schema.optional(Schema.Number),
  width: Schema.Number,
  height: Schema.Number,
  fps: Schema.Number,
  seconds: Schema.Number,
  startedAt: Schema.String,
  finishedAt: Schema.optional(Schema.String),
  elapsedSeconds: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  /** What the export draws differently from the preview (a graphic it couldn't read, a hardware encoder that fell back), as sentences (D76). */
  warnings: Schema.optional(Schema.Array(Schema.String)),
  /** D105: the subtitles file written next to the video (.srt or .vtt). */
  subtitlesFile: Schema.optional(Schema.String),
  /** D105: the video carries a soft subtitle track (mov_text) with this ISO 639-2 language tag. */
  subtitleTrack: Schema.optional(Schema.String),
  /** D105: false when captions and Subtitles tracks aren't drawn into the picture. */
  burnCaptions: Schema.optional(Schema.Boolean),
  /** G7 (D127): only this part of the timeline, frames [from, to). */
  range: Schema.optional(Schema.Struct({ from: Schema.Number, to: Schema.Number })),
  /** D291: graphics drawn with motion blur (sub-frames averaged); absent on jobs from before (none). */
  motionBlur: Schema.optional(Schema.Boolean),
  /** Started by the agent's export_video: the editor shows it as its own export (progress, Cancel, Open in Finder). */
  agent: Schema.optional(Schema.Boolean),
});
export type ExportJob = typeof ExportJob.Type;

/** D105: subtitles with an export: a file next to the video, a soft track in it (with its language: en, pl, eng...). */
export const ExportSubtitles = Schema.Struct({
  file: Schema.optional(Schema.Literals(["srt", "vtt"])),
  track: Schema.optional(Schema.Boolean),
  language: Schema.optional(Schema.String),
});
export type ExportSubtitles = typeof ExportSubtitles.Type;

export class ExportError extends Schema.TaggedError<ExportError>()("ExportError", {
  reason: Schema.Literals([
    "no-project",
    "no-ffmpeg",
    "exists",
    "invalid-path",
    "empty",
    "missing-media",
    "source-media",
    "busy",
    "unknown-job",
    "invalid-settings",
    "no-codec",
  ]),
  message: Schema.String,
}) {}
