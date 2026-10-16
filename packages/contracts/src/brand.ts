import * as Schema from "effect/Schema";

// ---- brand kits, skills and the production plan (U7, U15, U16, U17; D186–D191) ----

/** A colour of a kit with what it's for ("background", "text", "primary", "accent", "muted"...). */
export const BrandColor = Schema.Struct({ hex: Schema.String, role: Schema.String, name: Schema.optional(Schema.String) });
export type BrandColor = typeof BrandColor.Type;
/**
 * A typeface of a kit: its family and what it's for ("headline", "body", "mono"). `file` (D198): a
 * font file in the kit's folder (.woff2, .woff, .ttf, .otf) that graphics, texts and components
 * load (preview, export, render_frames); without one the family must be bundled or installed.
 */
export const BrandFont = Schema.Struct({ family: Schema.String, role: Schema.String, weight: Schema.optional(Schema.Number), file: Schema.optional(Schema.String) });
export type BrandFont = typeof BrandFont.Type;
/**
 * A style guide (U17): the grammar of a look, not its content. Usually written by the agent from
 * a reference video or frame ("Make a style from a reference").
 */
export const BrandStyle = Schema.Struct({
  source: Schema.optional(Schema.String),
  palette: Schema.Array(Schema.Struct({ hex: Schema.String, role: Schema.optional(Schema.String) })),
  type: Schema.String,
  shotLengths: Schema.String,
  transitions: Schema.String,
  camera: Schema.String,
  grain: Schema.String,
  notes: Schema.optional(Schema.String),
});
export type BrandStyle = typeof BrandStyle.Type;
/** Where a kit or a skill lives: the user's (every project; D198: where kits are made) or this project's (`<project>/brand/`, a copy pinned to it, wins on the same id). */
export const BrandScope = Schema.Literals(["global", "project"]);
export type BrandScope = typeof BrandScope.Type;
/**
 * A brand kit (U7). Files (logos, example frames) are names inside the kit's folder
 * (`<dataDir>/brand/kits/<id>/` or `<project>/brand/kits/<id>/`); `files` resolves them.
 */
export const BrandKit = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  scope: BrandScope,
  logos: Schema.Struct({ light: Schema.optional(Schema.String), dark: Schema.optional(Schema.String), mark: Schema.optional(Schema.String) }),
  colors: Schema.Array(BrandColor),
  fonts: Schema.Array(BrandFont),
  /** D296: what the product is, in a paragraph (the agent reads it instead of searching the disk or the web). */
  about: Schema.optional(Schema.String),
  tone: Schema.String,
  taglines: Schema.Array(Schema.String),
  urls: Schema.Array(Schema.String),
  dos: Schema.Array(Schema.String),
  donts: Schema.Array(Schema.String),
  examples: Schema.Array(Schema.String),
  style: Schema.optional(BrandStyle),
  updatedAt: Schema.optional(Schema.String),
});
export type BrandKit = typeof BrandKit.Type;
/** A skill (U7): a reusable style or recipe document ("Launch promo 20 s"), plain text the agent follows. */
export const BrandSkill = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  scope: BrandScope,
  description: Schema.String,
  body: Schema.String,
  updatedAt: Schema.optional(Schema.String),
  // D207: one of Uncut's own skills (D232: the bundled plugin uncut.skills; read-only).
  builtin: Schema.optional(Schema.Boolean),
  // D232 (issue #60): the plugin that ships it (read-only; id is the name the user types after /).
  plugin: Schema.optional(Schema.String),
  pluginName: Schema.optional(Schema.String),
});
export type BrandSkill = typeof BrandSkill.Type;
/**
 * What the open project uses (`<project>/brand/active.json`): one kit (or none) and its skills. D232:
 * nobody picks skills any more; `skills` are the ones this project has used (a /name in a message or
 * the agent's skill_read), which the critic's rubric and checklists follow.
 */
export const BrandActive = Schema.Struct({ kit: Schema.NullOr(Schema.String), skills: Schema.Array(Schema.String) });
export type BrandActive = typeof BrandActive.Type;
/** Every kit and skill the open project can see (project ones win on the same id), and its choice. */
export const BrandState = Schema.Struct({
  kits: Schema.Array(BrandKit),
  skills: Schema.Array(BrandSkill),
  active: BrandActive,
  // Absolute paths of each kit's files by kit id then file name, for thumbnails and the agent.
  files: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
});
export type BrandState = typeof BrandState.Type;

export class BrandError extends Schema.TaggedError<BrandError>()("BrandError", {
  reason: Schema.Literals(["no-project", "invalid", "not-found", "failed"]),
  message: Schema.String,
}) {}
// Copies a file (a logo, an example frame) into a kit's folder; returns the state with the file's name in the kit's files.
/** D198: logos and fonts from a file, a folder or an https address into a kit's folder (kit.json unchanged: the editor's draft takes them). */
export const BrandImported = Schema.Struct({ name: Schema.String, kind: Schema.Literals(["logo", "font"]), slot: Schema.optional(Schema.Literals(["light", "dark", "mark"])), family: Schema.optional(Schema.String) });
export type BrandImported = typeof BrandImported.Type;
