// The shader effect template (D213): copy it with `pnpm plugin:new <id> --shader`, never edit it in place.
//
// HOW A SHADER EFFECT WORKS
// A shader effect is a TypeGPU function (typegpu.com: typed WebGPU shaders in TypeScript) that
// Uncut calls at every pixel of a clip, in the preview and in the export, with WebGPU:
//
//   export const <name> = tgpu.fn([d.vec2f, d.f32, d.vec2f, Params], d.vec4f)`(uv, t, size, p) { ... }`
//     uv    the pixel's place in the picture, 0–1 from the top-left
//     t     seconds from the clip's start: the only clock, so a frame always looks the same
//     size  the picture's size in px (one pixel is 1.0 / size)
//     p     the params: a d.struct whose fields are the manifest's params, in the same order
//           (numbers and switches d.f32, switches are 0.0 or 1.0; colours d.vec3f, 0–1)
//   frame(uv) reads the clip's picture (edges clamped). Return the pixel's colour; its alpha is
//   ignored (the clip keeps its own). An effect without params leaves Params out: (uv, t, size).
// TypeGPU writes the WGSL types from the TypeScript ones; the body is WGSL (TypeGPU's
// JavaScript-bodied functions need its build plugin, which Uncut doesn't run).
//
// THE MANIFEST (uncut.module.json, contributes.shaders): for each effect its id
// (<plugin id>.<name>), name, description, source (this file), export (the const's name), params
// (key, label, type number | color | bool, min and max for numbers, step, default) and wgsl.
// Don't write wgsl by hand: `pnpm plugin:check --write <folder>` resolves this file with TypeGPU
// and puts the result there; plugin:check then fails if the two ever differ. Uncut draws the
// manifest's WGSL: nothing here runs in the app, so a shader plugin runs no program.
//
// LIMITS (checked): no loop or while; a for loop counts a var up by one between two whole-number
// literals, at most 64 steps, at most 4 loops, two deep; no storage, atomics, pointers or
// attributes; nothing named uncut*. Imports: typegpu, typegpu/data, typegpu/std, ./files.ts.
//
// TRY IT
//   pnpm plugin:check --write plugins/catalog/<folder>
//   In Uncut: Settings, Plugins, Add plugin, Choose folder, Allow; then the Effects tab, Shaders.
import tgpu from "typegpu";
import * as d from "typegpu/data";

/** Duotone: the picture's light mapped between two colours, with a slow shimmer. */
export const duotone = tgpu.fn([d.vec2f, d.f32, d.vec2f, d.struct({ amount: d.f32, dark: d.vec3f, light: d.vec3f, shimmer: d.f32 })], d.vec4f)`(uv, t, size, p) {
  let c = frame(uv).rgb;
  let lum = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  let wave = 0.04 * p.shimmer * sin(uv.y * 12.0 + t * 3.0);
  let tone = mix(p.dark, p.light, clamp(lum + wave, 0.0, 1.0));
  return vec4f(mix(c, tone, p.amount), 1.0);
}`;
