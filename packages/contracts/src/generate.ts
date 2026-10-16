import * as Schema from "effect/Schema";

// ---- generators (D99) ----

export const GenerateKind = Schema.Literals(["image", "video", "audio"]);
export type GenerateKind = typeof GenerateKind.Type;

/** A provider whose API key the user can store (Settings › Keys). */
export const KeyProvider = Schema.Literals(["openai", "google", "elevenlabs", "freesound", "jamendo"]);
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
