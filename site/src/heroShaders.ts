// The hero background's shaders, written with TypeGPU: the params struct and the bind group layout
// typed with typegpu/data, the passes as WGSL-bodied tgpu functions. The site build (next.config.ts)
// resolves them to WGSL here in Node (heroWgsl) and bakes the result into the page's script, so the browser runs
// plain WebGPU and never downloads TypeGPU (or needs eval). Two passes per frame:
//   1. trail: a small fixed-size texture (ping-pong) that remembers where the pointer went. Each
//      frame it is advected along a slow curl-noise flow, blurred a little and faded, and the
//      pointer's latest segment is splatted in: smoke that follows the cursor and melts away.
//   2. composite: on the canvas, a few huge, slowly drifting glows (always moving, so there is life
//      without a pointer) plus the trail, coloured from the site's blue into violet with a film
//      grain, held down around the headline so the text keeps its contrast.
import { tgpu } from "typegpu";
import * as d from "typegpu/data";

/** Trail resolution: the effect is all blur, so a small texture upscaled is free and soft. */
export const SIM_W = 320;
export const SIM_H = 200;

export const Params = d.struct({
  res: d.vec2f, // canvas size in px
  time: d.f32,
  dt: d.f32,
  a: d.vec2f, // the pointer's last segment, a to b, in 0–1 canvas uv
  b: d.vec2f,
  strength: d.f32, // how much to splat this frame (0 when the pointer is still)
  hue: d.f32, // 0 blue … 1 violet for the splat
  intensity: d.f32, // overall strength of the composite
  seed: d.f32, // grain seed
});

const hash2 = tgpu.fn([d.vec2f], d.f32)`(p) {
  let q = fract(p * vec2f(123.34, 456.21));
  let r = q + dot(q, q + 45.32);
  return fract(r.x * r.y);
}`;

const vnoise = tgpu.fn([d.vec2f], d.f32)`(p) {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}`.$uses({ hash2 });

// A full-screen triangle; the fragment passes derive their uv from the pixel position.
const fullScreen = tgpu.vertexFn({ in: { vi: d.builtin.vertexIndex }, out: { pos: d.builtin.position } })`{
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return Out(vec4f(p[vi], 0.0, 1.0));
}`;

/** Bindings of both passes (group 0): the params, the texture read, its sampler. */
export const layout = tgpu.bindGroupLayout({
  params: { uniform: Params },
  tex: { texture: d.texture2d(d.f32) },
  samp: { sampler: "filtering" },
}).$idx(0);

// The layout's typed slots, for the WGSL bodies' externals. TypeGPU 0.12 keeps them in an internal
// array in entry order (layout.$ only works inside a 'use gpu' function at draw time).
const slots = (() => {
  const own = layout as unknown as Record<symbol, unknown>;
  const key = Object.getOwnPropertySymbols(own).find((k) => Array.isArray(own[k]) && (own[k] as unknown[]).length === 3);
  if (!key) throw new Error("TypeGPU's bind group layout changed shape");
  const [params, tex, samp] = own[key] as [unknown, unknown, unknown];
  return { params, tex, samp };
})();

/** The trail pass, reading the previous trail. r = density, g = density × hue. */
const trailFn = tgpu.fragmentFn({ in: { pos: d.builtin.position }, out: d.vec4f })`{
  let uv = pos.xy / vec2f(${SIM_W}.0, ${SIM_H}.0);
  let aspect = U.res.x / U.res.y;
  let q = vec2f(uv.x * aspect, uv.y) * 1.7 + vec2f(U.time * 0.035, -U.time * 0.025);
  let e = 0.03;
  let n0 = vnoise(q);
  let curl = vec2f(vnoise(q + vec2f(0.0, e)) - n0, -(vnoise(q + vec2f(e, 0.0)) - n0)) / e;
  let back = uv - (curl * 0.02 + vec2f(0.0, -0.006)) * U.dt;
  let t = vec2f(${(1 / SIM_W).toFixed(6)}, ${(1 / SIM_H).toFixed(6)});
  var c = textureSampleLevel(prev, samp, back, 0.0) * 0.8;
  c += textureSampleLevel(prev, samp, back + vec2f(t.x, 0.0), 0.0) * 0.05;
  c += textureSampleLevel(prev, samp, back - vec2f(t.x, 0.0), 0.0) * 0.05;
  c += textureSampleLevel(prev, samp, back + vec2f(0.0, t.y), 0.0) * 0.05;
  c += textureSampleLevel(prev, samp, back - vec2f(0.0, t.y), 0.0) * 0.05;
  c = c * exp(-U.dt * 0.7);
  let pa = vec2f(U.a.x * aspect, U.a.y);
  let ab = vec2f(U.b.x * aspect, U.b.y) - pa;
  let pp = vec2f(uv.x * aspect, uv.y);
  let h = clamp(dot(pp - pa, ab) / max(dot(ab, ab), 0.000001), 0.0, 1.0);
  let r = pp - pa - ab * h;
  let s = exp(-dot(r, r) / 0.0028) * U.strength;
  let dens = min(c.r + s, 2.5);
  return vec4f(dens, min(c.g + s * U.hue, dens), 0.0, 1.0);
}`.$uses({ U: slots.params, prev: slots.tex, samp: slots.samp, vnoise });

/** The composite pass onto the canvas (premultiplied alpha over the page's own background). */
const compositeFn = tgpu.fragmentFn({ in: { pos: d.builtin.position }, out: d.vec4f })`{
  let uv = pos.xy / U.res;
  let aspect = U.res.x / U.res.y;
  let p = vec2f(uv.x * aspect, uv.y);
  let T = U.time;
  // A low-frequency warp so the glows breathe instead of sliding like discs.
  let w = vec2f(vnoise(p * 1.3 + vec2f(T * 0.04, 0.0)), vnoise(p * 1.3 + vec2f(0.0, T * 0.05) + 7.0)) - 0.5;
  let pw = p + w * 0.35;
  let c1 = vec2f(aspect * (0.72 + 0.12 * sin(T * 0.11)), 0.30 + 0.10 * cos(T * 0.09));
  let c2 = vec2f(aspect * (0.26 + 0.10 * cos(T * 0.07 + 1.3)), 0.62 + 0.10 * sin(T * 0.08 + 0.4));
  let c3 = vec2f(aspect * (0.50 + 0.22 * sin(T * 0.05 + 2.1)), 0.12 + 0.06 * sin(T * 0.13));
  // Narrow (phone) canvases get smaller, dimmer glows so they don't flood the whole column.
  let narrow = clamp(aspect * 0.9, 0.45, 1.0);
  let g1 = exp(-dot(pw - c1, pw - c1) / (0.10 * narrow));
  let g2 = exp(-dot(pw - c2, pw - c2) / (0.08 * narrow));
  let g3 = exp(-dot(pw - c3, pw - c3) / (0.05 * narrow));
  let blue = vec3f(0.36, 0.47, 1.0);
  let violet = vec3f(0.50, 0.30, 0.98);
  let deep = vec3f(0.16, 0.20, 0.62);
  var col = blue * g1 * 0.55 + violet * g2 * 0.45 + deep * g3 * 0.5;
  var a = g1 * 0.55 + g2 * 0.45 + g3 * 0.5;
  // The pointer's trail.
  let tr = textureSampleLevel(trail, samp, uv, 0.0);
  let dens = 1.0 - exp(-tr.r * 1.1);
  let hue = clamp(tr.g / max(tr.r, 0.0001), 0.0, 1.0);
  let tcol = mix(mix(blue, violet, hue), vec3f(0.62, 0.70, 1.0), dens * dens * 0.35);
  col += tcol * dens * 0.8;
  a += dens * 0.8;
  // Keep the headline band and the lede calm: less light at the middle, more at the edges.
  let m = vec2f((uv.x - 0.5) * 1.5, (uv.y - 0.36) * 2.4);
  let calm = 1.0 - 0.45 * exp(-dot(m, m) * 2.2);
  // Fade out towards the bottom (the screenshot sits there) and top.
  let fade = smoothstep(1.0, 0.62, uv.y) * smoothstep(0.0, 0.08, uv.y);
  let k = U.intensity * calm * fade * mix(0.7, 1.0, narrow);
  // Never brighter than about half-lit: the muted lede keeps at least ~4.5:1 over any of it.
  let lit = a * k;
  let capped = min(lit, 0.46);
  col = col * k * (capped / max(lit, 0.0001));
  a = capped;
  // Film grain, only where there is light, so the black stays black.
  let n = hash2(pos.xy + vec2f(U.seed * 91.0, U.seed * 37.0)) - 0.5;
  col = max(col + vec3f(n * 0.06 * a), vec3f(0.0));
  return vec4f(min(col, vec3f(a)), a);
}`.$uses({ U: slots.params, trail: slots.tex, samp: slots.samp, vnoise, hash2 });

/** Floats in Params, in field order (48 bytes); heroGpu.ts writes them with queue.writeBuffer. */
export const PARAM_FLOATS = 12;

/** The two passes' WGSL (each with the full-screen vertex stage `vs` and the fragment stage `fs`,
 * bindings @group(0): 0 params, 1 texture, 2 sampler) and the sizes heroGpu.ts needs. */
export function heroWgsl(): { readonly trail: string; readonly composite: string; readonly simW: number; readonly simH: number; readonly floats: number } {
  fullScreen.$name("vs");
  trailFn.$name("fs");
  compositeFn.$name("fs");
  Params.$name("Params");
  return { trail: tgpu.resolve([fullScreen, trailFn]), composite: tgpu.resolve([fullScreen, compositeFn]), simW: SIM_W, simH: SIM_H, floats: PARAM_FLOATS };
}
