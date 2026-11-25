import * as Schema from "effect/Schema";

// ---- the offline voice's voices (Reverb, plugins/reverb-tts) ----

/** A voice the offline voiceover can speak in: one of Reverb's presets, or one the user cloned. */
export const VoiceInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  // Its own language (en, de, fr, es, it, pl, pt); it can speak the others too.
  language: Schema.String,
  preset: Schema.Boolean,
  // A cloned voice's: what its clip says, its length, where it came from and when.
  transcript: Schema.optional(Schema.String),
  seconds: Schema.optional(Schema.Number),
  source: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
});
export type VoiceInfo = typeof VoiceInfo.Type;

/** Making a voice from a clip: a project media's (by id) or a file's, from start for seconds. */
export const VoiceCloneRequest = Schema.Struct({
  media: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  start: Schema.optional(Schema.Number),
  seconds: Schema.optional(Schema.Number),
  name: Schema.String,
  // The clip's language; Whisper's guess (or English) when none.
  language: Schema.optional(Schema.String),
  // What the clip says, word for word; Whisper writes it when none.
  transcript: Schema.optional(Schema.String),
  // The user confirmed they have the right to use this voice.
  consent: Schema.Boolean,
});
export type VoiceCloneRequest = typeof VoiceCloneRequest.Type;

/** The clone in progress, or the last one. */
export const VoiceCloneJob = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  phase: Schema.Literals(["running", "done", "failed", "cancelled"]),
  // What it's doing, in words ("Downloading the voice model, 40%").
  status: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  voice: Schema.optional(VoiceInfo),
});
export type VoiceCloneJob = typeof VoiceCloneJob.Type;

export const VoicesState = Schema.Struct({
  voices: Schema.Array(VoiceInfo),
  clone: Schema.optional(VoiceCloneJob),
});
export type VoicesState = typeof VoicesState.Type;

export class VoiceError extends Schema.TaggedError<VoiceError>()("VoiceError", {
  reason: Schema.Literals(["bad-request", "no-project", "busy", "unknown-voice", "failed"]),
  message: Schema.String,
}) {}
