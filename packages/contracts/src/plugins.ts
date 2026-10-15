import * as Schema from "effect/Schema";

// ---- plugins (D97) ----

/**
 * A plugin folder Uncut found (uncut.module.json). status: "ready" (allowed, or shipped with the
 * app), "needs-approval" (its tools are listed to the agent but refused until the user allows
 * it), "broken" (skipped: problem says why; id/name may be missing).
 */
export const PluginInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  source: Schema.Literals(["user", "bundled"]),
  dir: Schema.String,
  status: Schema.Literals(["ready", "needs-approval", "broken"]),
  capabilities: Schema.Array(Schema.String),
  // The capabilities in words, and what running it means (one sentence each).
  asks: Schema.Array(Schema.String),
  tools: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
  problem: Schema.optional(Schema.String),
  // Installed by Uncut (D102): where from ("folder" path, or git URL with the ref asked for and the commit cloned).
  origin: Schema.optional(Schema.Struct({ kind: Schema.Literals(["folder", "git", "catalog"]), source: Schema.String, ref: Schema.optional(Schema.String), commit: Schema.optional(Schema.String) })),
  // In Uncut's own plugins folder, so Remove can delete it.
  removable: Schema.optional(Schema.Boolean),
  // What it adds as data (D103), by name: text looks, components, checks.
  contributes: Schema.optional(Schema.Struct({ looks: Schema.Array(Schema.String), components: Schema.Array(Schema.String), rules: Schema.Array(Schema.String), filters: Schema.optional(Schema.Array(Schema.String)), shaders: Schema.optional(Schema.Array(Schema.String)), skills: Schema.optional(Schema.Array(Schema.String)) })),
  // D248: a hash of its skills (when it has any): the approval is for these skills; plugins.approve sends it back.
  skillsHash: Schema.optional(Schema.String),
});
export type PluginInfo = typeof PluginInfo.Type;

/**
 * The allowed plugins' contributions (D103) for the renderer: looks are core TextLooks (+ plugin,
 * pluginName), rules core PluginRules; components without their template (it only ever runs in
 * the graphics sandbox, after plugins.addComponent copies it into the project).
 */
export const PluginContributions = Schema.Struct({
  looks: Schema.Array(Schema.Unknown),
  components: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, description: Schema.String, plugin: Schema.String, pluginName: Schema.String, params: Schema.Unknown, defaults: Schema.Unknown })),
  rules: Schema.Array(Schema.Unknown),
  // D136: colour looks for the Effects tab (core LookDef numbers).
  filters: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, description: Schema.String, plugin: Schema.String, pluginName: Schema.String, look: Schema.Unknown }))),
  // D213: shader effects (core ShaderDef: typed params and the TypeGPU function's WGSL).
  shaders: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, description: Schema.String, plugin: Schema.String, pluginName: Schema.String, params: Schema.Array(Schema.Unknown), wgsl: Schema.String }))),
});
export type PluginContributions = typeof PluginContributions.Type;

/**
 * One plugin in Uncut's catalog (D103): plugins/catalog in the repo, shipped with the app, off
 * until the user enables one (copied like a folder install, then the approval dialog).
 */
export const CatalogEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  version: Schema.String,
  kind: Schema.String,
  capabilities: Schema.Array(Schema.String),
  tools: Schema.Array(Schema.String),
  // Whether it runs a program (a "process" plugin) or only adds data.
  runs: Schema.Boolean,
  contributes: Schema.optional(Schema.Struct({ looks: Schema.Array(Schema.String), components: Schema.Array(Schema.String), rules: Schema.Array(Schema.String), filters: Schema.optional(Schema.Array(Schema.String)), shaders: Schema.optional(Schema.Array(Schema.String)), skills: Schema.optional(Schema.Array(Schema.String)) })),
  // Enabled: a copy is in Uncut's plugins folder (it may still need allowing).
  enabled: Schema.Boolean,
});
export type CatalogEntry = typeof CatalogEntry.Type;

export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  // D102: "invalid" (an install refused, in one sentence), "replaces-bundled" (its id is a bundled
  // plugin's: install again with replaceBundled to do it on purpose), "not-removable".
  reason: Schema.Literals(["unknown-plugin", "broken", "bundled", "changed", "io", "invalid", "replaces-bundled", "not-removable"]),
  message: Schema.String,
}) {}
