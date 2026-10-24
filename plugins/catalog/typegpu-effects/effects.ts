// TypeGPU effects (D213): four GPU video effects written with TypeGPU, typed WebGPU shaders in
// TypeScript. Each export is a TypeGPU function Uncut calls at every pixel of the clip:
//
//   tgpu.fn([d.vec2f, d.f32, d.vec2f, Params], d.vec4f)`(uv, t, size, p) { ... }`
//     uv    where the pixel is, 0–1 from the top-left
//     t     seconds from the clip's start (the only clock: the same frame always looks the same)
//     size  the picture's size in px (one pixel is 1.0 / size)
//     p     the params, a d.struct whose fields match the manifest's params in order
//           (numbers and switches d.f32, colours d.vec3f)
//   frame(uv) reads the clip's picture; the colour returned is the pixel's (its alpha is ignored).
//
// TypeGPU writes the WGSL types from the TypeScript ones (the struct, the arguments); the bodies
// are WGSL. `pnpm plugin:check --write plugins/catalog/typegpu-effects` resolves them with TypeGPU
// and stores the WGSL in uncut.module.json, which is what Uncut draws (no code from here runs in
// the app). Rules: no loop or while; for loops count up by one between whole-number literals, at
// most 64 steps; no storage, atomics or attributes.
import tgpu from "typegpu";
import * as d from "typegpu/data";

/** Water ripples from the centre, rolling outwards over time. */
export const ripple = tgpu.fn(
  [d.vec2f, d.f32, d.vec2f, d.struct({ amplitude: d.f32, wavelength: d.f32, speed: d.f32, centerX: d.f32, centerY: d.f32 })],
  d.vec4f,
)`(uv, t, size, p) {
  let aspect = vec2f(size.x / size.y, 1.0);
  let away = (uv - vec2f(p.centerX, p.centerY)) * aspect;
  let dist = length(away);
  let phase = dist / max(p.wavelength, 0.001) * 6.2831853 - t * p.speed;
  let fade = 1.0 / (1.0 + dist * 4.0);
  let push = normalize(away + vec2f(0.00001)) * sin(phase) * p.amplitude * fade / aspect;
  let c = frame(uv + push);
  let glint = max(cos(phase), 0.0) * p.amplitude * fade * 6.0;
  return vec4f(c.rgb + vec3f(glint), 1.0);
}`;

/** Red and blue pulled apart along an angle that turns slowly, the split breathing with time. */
export const rgbShift = tgpu.fn([d.vec2f, d.f32, d.vec2f, d.struct({ amount: d.f32, breathe: d.f32, spin: d.f32 })], d.vec4f)`(uv, t, size, p) {
  let angle = t * p.spin;
  let px = p.amount * (1.0 + p.breathe * sin(t * 2.3));
  let dir = vec2f(cos(angle), sin(angle)) * px / size;
  let r = frame(uv + dir).r;
  let g = frame(uv).g;
  let b = frame(uv - dir).b;
  return vec4f(r, g, b, 1.0);
}`;

/** Print-style halftone: ink dots on paper, sized by how dark each cell is, on a turned grid. */
export const halftone = tgpu.fn(
  [d.vec2f, d.f32, d.vec2f, d.struct({ cell: d.f32, angle: d.f32, ink: d.vec3f, paper: d.vec3f, color: d.f32 })],
  d.vec4f,
)`(uv, t, size, p) {
  let a = radians(p.angle);
  let rot = mat2x2f(cos(a), -sin(a), sin(a), cos(a));
  let px = rot * (uv * size);
  let cellPx = max(p.cell, 2.0);
  let center = (floor(px / cellPx) + 0.5) * cellPx;
  let back = transpose(rot) * center / size;
  let c = frame(back).rgb;
  let dark = 1.0 - dot(c, vec3f(0.2126, 0.7152, 0.0722));
  let radius = sqrt(dark) * cellPx * 0.62;
  let edge = clamp(radius - length(px - center) + 0.5, 0.0, 1.0);
  let ink = select(p.ink, c * 0.85, p.color > 0.5);
  return vec4f(mix(p.paper, ink, edge), 1.0);
}`;

/** An old CRT: rolling scanlines, a slight barrel curve, RGB mask and a soft flicker. */
export const crt = tgpu.fn(
  [d.vec2f, d.f32, d.vec2f, d.struct({ lines: d.f32, strength: d.f32, curve: d.f32, flicker: d.f32, glow: d.vec3f })],
  d.vec4f,
)`(uv, t, size, p) {
  let q = uv * 2.0 - 1.0;
  let bent = q * (1.0 + p.curve * dot(q, q) * 0.25);
  let at = bent * 0.5 + 0.5;
  let inside = step(0.0, at.x) * step(at.x, 1.0) * step(0.0, at.y) * step(at.y, 1.0);
  var c = frame(clamp(at, vec2f(0.0), vec2f(1.0))).rgb;
  let line = 0.5 + 0.5 * sin((at.y * p.lines + t * 2.0) * 6.2831853);
  c = c * (1.0 - p.strength * line);
  let mask = fract(uv.x * size.x / 3.0);
  let rgb = vec3f(step(mask, 0.333), step(0.333, mask) * step(mask, 0.666), step(0.666, mask));
  c = c * mix(vec3f(1.0), 0.75 + rgb * 0.5, p.strength * 0.6);
  c = c * (1.0 - p.flicker * (0.5 + 0.5 * sin(t * 47.0)));
  let vignette = 1.0 - dot(q, q) * 0.18;
  return vec4f((c + p.glow * 0.04) * vignette * inside, 1.0);
}`;
