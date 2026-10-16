// Example kit (uncut.example-kit): the worked example of Settings, Plugins, Make a plugin (D258).
// Start your own plugin from it with `pnpm plugin:new <your.id> --from uncut.example-kit`.
//
// WHAT'S IN THIS FOLDER
//   uncut.module.json  the manifest: who the plugin is and everything it adds. JSON has no
//                      comments, so this header walks through it.
//   effect.ts          this file: the TypeGPU source of the plugin's shader effect.
// That's all: it's a data plugin ("runtime": {"type": "data"}), so Uncut reads it and runs no
// program. A data plugin may carry only its manifest and its shader effects' .ts sources.
//
// THE MANIFEST, FIELD BY FIELD
//   "manifest", "apiVersion"  always "uncut.module/0" and "uncut.module/1" (the frozen plugin API).
//   "id"            who you are, a dot, what it is: uncut.example-kit. The folder is the id with
//                   dots as dashes (uncut-example-kit), and every contribution id starts with it.
//   "kind": "pack"  a plugin that adds data. Process plugins use their own kind (capture-source,
//                   analyzer, generator...).
//   "name", "version", "description", "author", "license"  what the marketplace card shows.
//   "runtime"       {"type": "data"} here. A plugin that runs a program has
//                   {"type": "process", "command": "node", "args": ["server.ts"]} and agentTools
//                   (see plugins/catalog/_template).
//   "capabilities"  none: a data plugin asks for nothing. The user sees them before allowing.
//   "contributes"   what it adds, each entry with an id "<plugin id>.<name>":
//     looks       Lower third: a text look in the Text tab (and for the agent's insert_text). The
//                 numbers are fractions of the frame (size 0.045 = 4.5% of the shorter side; x, y,
//                 w from the top-left). A text added with it carries the whole look, so a project
//                 keeps drawing after the plugin is removed.
//     components  Callout badge: HTML + CSS with {{label}} and {{color}} filled from its params
//                 (a JSON Schema with defaults). No script: Uncut sets --t (seconds) for CSS to
//                 animate with, and draws it in the graphics sandbox, in the preview and the export.
//     skills      Lower thirds (/example-kit-lower-thirds): instructions the agent reads with
//                 skill_read when the description fits, or when the user types /name. Skill names
//                 aren't namespaced, so pick one nobody else has (the first plugin with it wins).
//     shaders     Spotlight: the effect below. The manifest lists its params (number, color, bool)
//                 and its wgsl, which pnpm plugin:check --write fills in from this file.
//   Not shown here: rules (checks, see plugins/catalog/taste-extra), filters (colour looks, the
//   effect.look numbers), and agentTools (a process plugin's tools, see _template).
//
// ALLOWING IT
//   Installing copies the folder into Uncut's plugins folder; nothing shows until the user allows
//   it. Because it has a skill, the dialog says the agent follows skills without asking: the
//   approval is tied to the skills' text (D248), so changing a skill asks again.
//
// THE SHADER EFFECT
// Uncut calls the function at every pixel of a clip, in the preview and the export, with WebGPU:
//     uv    the pixel's place, 0-1 from the top-left
//     t     seconds from the clip's start (the only clock: a frame always looks the same)
//     size  the picture's size in px
//     p     the params, a d.struct whose fields are the manifest's params in the same order
//           (numbers and switches d.f32, a switch is 0.0 or 1.0; colours d.vec3f, 0-1)
//   frame(uv) reads the clip's picture. The returned alpha is ignored (the clip keeps its own).
// The body is WGSL: no loops here; for loops are limited (pnpm plugin:check --help).
//
// TRY IT
//   pnpm plugin:check --write plugins/catalog/uncut-example-kit   (resolves the wgsl)
//   pnpm plugin:check plugins/catalog/uncut-example-kit
//   In Uncut: Settings, Plugins, find Example kit, Install, Allow. Then the Text tab (Lower third),
//   Elements (Callout badge), Effects, Shaders (Spotlight), and / in the composer for the skill.
import tgpu from "typegpu";
import * as d from "typegpu/data";

/** Spotlight: darkens and tints the picture away from the middle; with breathe on, the radius swells slowly. */
export const spotlight = tgpu.fn([d.vec2f, d.f32, d.vec2f, d.struct({ strength: d.f32, radius: d.f32, tint: d.vec3f, breathe: d.f32 })], d.vec4f)`(uv, t, size, p) {
  let c = frame(uv).rgb;
  let aspect = vec2f(size.x / size.y, 1.0);
  let dist = length((uv - vec2f(0.5)) * aspect);
  let r = p.radius * (1.0 + 0.08 * p.breathe * sin(t * 1.6));
  let edge = smoothstep(r * 0.6, r * 1.4, dist);
  return vec4f(mix(c, p.tint, edge * p.strength), 1.0);
}`;
