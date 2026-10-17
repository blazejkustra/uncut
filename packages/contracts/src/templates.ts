import * as Schema from "effect/Schema";

// ---- templates (issue #111) ----

/** A creative brief the composer's / menu offers: Uncut's built-ins (read-only) and the user's own (.md files in the app's data folder). */
export const TemplateInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  body: Schema.String,
  builtin: Schema.optional(Schema.Boolean),
});
export type TemplateInfo = typeof TemplateInfo.Type;

/** A template filled from the open project: the brief for the composer, and the placeholders the project had no value for. */
export const TemplateFilled = Schema.Struct({ text: Schema.String, missing: Schema.Array(Schema.String) });
export type TemplateFilled = typeof TemplateFilled.Type;

export class TemplateError extends Schema.TaggedError<TemplateError>()("TemplateError", {
  reason: Schema.Literals(["invalid", "not-found", "builtin", "failed"]),
  message: Schema.String,
}) {}
