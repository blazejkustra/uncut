import * as Schema from "effect/Schema";

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
