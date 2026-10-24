import * as Schema from "effect/Schema";

// ---- generators (D99) ----

export const GenerateKind = Schema.Literals(["image", "video", "audio"]);
export type GenerateKind = typeof GenerateKind.Type;

/** A provider whose API key the user can store (Settings › Keys). */
export const KeyProvider = Schema.Literals(["openai", "google", "elevenlabs", "freesound"]);
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

/** One choice of a generator option: the value sent, and how it's shown. */
export const GeneratorChoice = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
});
export type GeneratorChoice = typeof GeneratorChoice.Type;

/**
 * An option a plugin's generator takes (#107, #108), from its manifest: a choice (a select) or a
 * toggle (a switch). A choice with `dynamic` gets its values from the plugin (generate.choices, e.g.
 * the voices of the user's ElevenLabs account); its `choices` are then only a fallback.
 */
export const GeneratorOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  type: Schema.Literals(["choice", "toggle"]),
  choices: Schema.optional(Schema.Array(GeneratorChoice)),
  dynamic: Schema.optional(Schema.Boolean),
  default: Schema.optional(Schema.Union([Schema.String, Schema.Boolean])),
  // A line for the agent and the tooltip: "Speech speed, 1 is normal".
  description: Schema.optional(Schema.String),
});
export type GeneratorOption = typeof GeneratorOption.Type;

/**
 * How a plugin's generator is priced, in US dollars per unit: per character of the prompt or per
 * second (its `seconds`); `by` gives another price per value of one option (the model).
 */
export const GeneratorPrice = Schema.Struct({
  unit: Schema.Literals(["character", "second"]),
  usd: Schema.Number,
  by: Schema.optional(Schema.Struct({ option: Schema.String, usd: Schema.Record(Schema.String, Schema.Number) })),
});
export type GeneratorPrice = typeof GeneratorPrice.Type;

/** A generator's option values, by option id. */
export const GenerateOptions = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean]));
export type GenerateOptions = typeof GenerateOptions.Type;

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
  // A plugin's generator (#107, #108): the plugin's id and name, its options, price and prompt box.
  plugin: Schema.optional(Schema.Struct({ id: Schema.String, name: Schema.String })),
  options: Schema.optional(Schema.Array(GeneratorOption)),
  price: Schema.optional(GeneratorPrice),
  // What the prompt box is ("Script") and its example text.
  promptLabel: Schema.optional(Schema.String),
  placeholder: Schema.optional(Schema.String),
  // The longest prompt it takes, in characters (default 4000).
  maxPrompt: Schema.optional(Schema.Number),
});
export type GeneratorInfo = typeof GeneratorInfo.Type;

export const GenerateRequest = Schema.Struct({
  generator: Schema.String,
  prompt: Schema.String,
  kind: Schema.optional(GenerateKind),
  size: Schema.optional(Schema.String),
  seconds: Schema.optional(Schema.Number),
  name: Schema.optional(Schema.String),
  options: Schema.optional(GenerateOptions),
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
  options: Schema.optional(GenerateOptions),
  phase: Schema.Literals(["running", "importing", "done", "failed", "cancelled"]),
  // What it's doing, in words ("Waiting for Veo…").
  status: Schema.optional(Schema.String),
  startedAt: Schema.String,
  // Estimated cost in US dollars (0: runs on the user's Claude Code, no key).
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
