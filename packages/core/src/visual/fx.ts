// Clip looks and effects (D136, feedback G2): one definition per filter and effect, drawn by the
// preview (a WebGL pass over the clip's picture, apps/web/src/preview/fx.ts) and by the export
// (ffmpeg filters on the same picture, apps/server/src/export/exportPlan.ts) from the same numbers.
//
// A clip's `effects` (moduleUse entries, list order kept for the panel) can hold:
// - effect.look {look, intensity, custom?, label?}: a colour look (Warm, Film, B&W...). At most one.
// - effect.color {exposure, contrast, saturation, temperature, tint, highlights, shadows, vibrance}:
//   the Inspector's Adjust. At most one.
// - picture effects, on the clip's picture at its fitted size, in this fixed order whatever the
//   list order: mirror, shake, pixelate, then colour (look, adjust, invert: one 3D LUT core
//   computes), posterize, RGB split, sharpen, glow, blur (CSS blur / gblur, D133's maths).
// - overlay effects, drawn by Chromium on both sides over the picture inside the box: vignette,
//   film grain, letterbox bars (fxOverlayInner / fxOverlayHtml).
// - zoom pulse: the box's zoom, frame by frame (fxBox, through D75's keyed-scale path).
// effect.stabilize stays valid but isn't drawn.
//
// Colour: every pointwise change (look at its intensity, Adjust, invert) is a function on
// sRGB-encoded 0–1 RGB, sampled into a LUT_SIZE³ table: the preview reads it with trilinear
// interpolation in its shader, the export with lut3d interp=trilinear from a .cube of the same
// numbers, so both draw the same colours. Browser-safe and pure.
import type { Item, ModuleUse } from "../timeline/types.ts";
import { fitRect, moveBox, type ClipBox, type Rect } from "./box.ts";
import { SHADER } from "./shaders.ts";

export const LOOK = "effect.look";
export const ADJUST = "effect.color";
export const STABILIZE = "effect.stabilize";

/** Grid points per side of the colour table (33³ is the usual .cube size). */
export const LUT_SIZE = 33;

// ---- Adjust ----

export type AdjustKey = "exposure" | "contrast" | "saturation" | "temperature" | "tint" | "highlights" | "shadows" | "vibrance";
export type Adjust = Readonly<Record<AdjustKey, number>>;

export interface AdjustInfo {
  readonly key: AdjustKey;
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

/** The Inspector's Adjust rows, in order. Exposure is in stops; the rest −1 to 1 (shown as −100 to 100). */
export const ADJUST_INFO: ReadonlyArray<AdjustInfo> = [
  { key: "exposure", name: "Exposure", min: -2, max: 2 },
  { key: "contrast", name: "Contrast", min: -1, max: 1 },
  { key: "saturation", name: "Saturation", min: -1, max: 1 },
  { key: "temperature", name: "Temperature", min: -1, max: 1 },
  { key: "tint", name: "Tint", min: -1, max: 1 },
  { key: "highlights", name: "Highlights", min: -1, max: 1 },
  { key: "shadows", name: "Shadows", min: -1, max: 1 },
  { key: "vibrance", name: "Vibrance", min: -1, max: 1 },
];
export const ADJUST_KEYS: ReadonlyArray<AdjustKey> = ADJUST_INFO.map((a) => a.key);
export const NO_ADJUST: Adjust = { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, vibrance: 0 };

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);
const num = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);

/** An Adjust from params (missing or bad values are 0, out of range clamped). */
export function adjustOf(params: unknown): Adjust {
  const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  const out = { ...NO_ADJUST } as Record<AdjustKey, number>;
  for (const a of ADJUST_INFO) out[a.key] = num(p[a.key], a.min, a.max, 0);
  return out;
}
export const isNeutral = (a: Adjust) => ADJUST_KEYS.every((k) => a[k] === 0);

// ---- looks ----

export type Rgb3 = readonly [number, number, number];
/** A tone curve: points (x, y) in 0–1, x rising; a smooth monotone curve through them. */
export type Curve = ReadonlyArray<readonly [number, number]>;

/**
 * A look as data (so a plugin can contribute one, D136): applied in this order — channel mixer
 * (rows give r, g, b from r, g, b), mono (mix to luma), Adjust, the master curve then the per-channel
 * curves, split toning (a colour added in the shadows and in the highlights), fade (blacks lifted).
 */
export interface LookDef {
  readonly mixer?: ReadonlyArray<number>;
  readonly mono?: number;
  readonly adjust?: Partial<Record<AdjustKey, number>>;
  readonly curve?: Curve;
  readonly red?: Curve;
  readonly green?: Curve;
  readonly blue?: Curve;
  readonly shadowTint?: { readonly color: Rgb3; readonly amount: number };
  readonly highlightTint?: { readonly color: Rgb3; readonly amount: number };
  readonly fade?: number;
}

export interface LookInfo {
  /** The value of effect.look's `look` param. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly def: LookDef;
}

const S_CURVE: Curve = [
  [0, 0],
  [0.25, 0.2],
  [0.5, 0.5],
  [0.75, 0.8],
  [1, 1],
];

/** The built-in looks, in the panel's order. */
export const LOOKS: ReadonlyArray<LookInfo> = [
  { id: "natural", name: "Natural", description: "A touch more contrast and colour, nothing that shows", def: { adjust: { contrast: 0.06, vibrance: 0.3, saturation: 0.04 }, curve: [[0, 0], [0.25, 0.235], [0.75, 0.775], [1, 1]] } },
  { id: "warm", name: "Warm", description: "Golden, sunlit tones", def: { adjust: { temperature: 0.45, tint: -0.04, saturation: 0.06 } } },
  { id: "cool", name: "Cool", description: "Blue, crisp tones", def: { adjust: { temperature: -0.45, tint: 0.03 } } },
  { id: "vintage", name: "Vintage", description: "Faded warm print with soft blacks", def: { mono: 0.25, adjust: { temperature: 0.3, contrast: -0.1 }, blue: [[0, 0.12], [1, 0.88]], red: [[0, 0.04], [0.5, 0.54], [1, 1]], fade: 0.06 } },
  { id: "film", name: "Film", description: "Gentle S-curve, teal shadows, warm highlights", def: { curve: [[0, 0.04], [0.25, 0.22], [0.5, 0.5], [0.75, 0.8], [1, 0.97]], shadowTint: { color: [0.1, 0.45, 0.5], amount: 0.12 }, highlightTint: { color: [1, 0.75, 0.5], amount: 0.1 }, adjust: { saturation: -0.08 } } },
  { id: "teal-orange", name: "Teal & Orange", description: "Teal shadows and orange highlights, the blockbuster look", def: { shadowTint: { color: [0, 0.55, 0.65], amount: 0.28 }, highlightTint: { color: [1, 0.6, 0.25], amount: 0.24 }, adjust: { contrast: 0.12, saturation: 0.1 } } },
  { id: "bw", name: "B&W", description: "Black and white", def: { mono: 1, adjust: { contrast: 0.1 } } },
  { id: "noir", name: "Noir", description: "Hard black and white with deep shadows", def: { mono: 1, curve: [[0, 0], [0.3, 0.14], [0.7, 0.88], [1, 1]], adjust: { exposure: -0.2 } } },
  { id: "fade", name: "Fade", description: "Lifted blacks and quiet colour", def: { fade: 0.14, adjust: { saturation: -0.25, contrast: -0.15 } } },
  { id: "vivid", name: "Vivid", description: "Bold, saturated colour", def: { adjust: { saturation: 0.35, vibrance: 0.3, contrast: 0.15 } } },
  { id: "moody", name: "Moody", description: "Darker, cooler, less colour", def: { adjust: { exposure: -0.25, saturation: -0.2, contrast: 0.1, temperature: -0.15 }, shadowTint: { color: [0.1, 0.2, 0.45], amount: 0.15 } } },
  { id: "sepia", name: "Sepia", description: "Old photograph brown", def: { mixer: [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131], adjust: { contrast: 0.05 } } },
  { id: "cinematic", name: "Cinematic", description: "Crushed contrast with a teal and amber split", def: { curve: S_CURVE, shadowTint: { color: [0, 0.4, 0.5], amount: 0.16 }, highlightTint: { color: [1, 0.7, 0.35], amount: 0.14 }, fade: 0.03, adjust: { saturation: -0.05 } } },
  { id: "pastel", name: "Pastel", description: "Soft, bright and light", def: { adjust: { contrast: -0.25, saturation: -0.15, exposure: 0.2 }, fade: 0.1 } },
  { id: "golden", name: "Golden hour", description: "Late sun, warm highlights", def: { adjust: { temperature: 0.65, saturation: 0.1 }, highlightTint: { color: [1, 0.7, 0.3], amount: 0.18 } } },
  { id: "arctic", name: "Arctic", description: "Icy blue and bright", def: { adjust: { temperature: -0.6, exposure: 0.1, saturation: -0.1, highlights: 0.15 } } },
];

export const lookInfo = (id: string | undefined) => LOOKS.find((l) => l.id === id);

// ---- effects ----

export interface EffectParam {
  readonly key: string;
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
  readonly unit?: string;
}

export type EffectGroup = "picture" | "overlay" | "motion";

export interface EffectInfo {
  /** Its module id (spec/modules/builtin/<id>.json). */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly group: EffectGroup;
  readonly params: ReadonlyArray<EffectParam>;
}

/** The built-in effects, in the panel's order. Lengths are canvas pixels. */
export const EFFECTS: ReadonlyArray<EffectInfo> = [
  { id: "effect.blur", name: "Blur", description: "Soft focus over the whole picture", group: "picture", params: [{ key: "amount", name: "Amount", min: 1, max: 60, step: 1, default: 8, unit: "px" }] },
  { id: "effect.sharpen", name: "Sharpen", description: "Crisper edges", group: "picture", params: [{ key: "amount", name: "Amount", min: 0.1, max: 2, step: 0.05, default: 0.6 }] },
  { id: "effect.vignette", name: "Vignette", description: "Darker corners", group: "overlay", params: [{ key: "amount", name: "Amount", min: 0, max: 1, step: 0.01, default: 0.5 }, { key: "size", name: "Size", min: 0, max: 1, step: 0.01, default: 0.5 }] },
  { id: "effect.grain", name: "Film grain", description: "Moving film grain", group: "overlay", params: [{ key: "amount", name: "Amount", min: 0, max: 1, step: 0.01, default: 0.35 }] },
  { id: "effect.glow", name: "Glow", description: "Bright parts bloom", group: "picture", params: [{ key: "amount", name: "Amount", min: 0, max: 1, step: 0.01, default: 0.5 }, { key: "threshold", name: "Threshold", min: 0, max: 0.95, step: 0.01, default: 0.65 }, { key: "radius", name: "Radius", min: 2, max: 60, step: 1, default: 16, unit: "px" }] },
  { id: "effect.rgb-split", name: "RGB split", description: "Red and blue pulled apart", group: "picture", params: [{ key: "amount", name: "Amount", min: 1, max: 40, step: 1, default: 6, unit: "px" }] },
  { id: "effect.pixelate", name: "Pixelate", description: "Big square pixels", group: "picture", params: [{ key: "size", name: "Size", min: 2, max: 80, step: 1, default: 16, unit: "px" }] },
  { id: "effect.mirror", name: "Mirror", description: "Flipped left to right", group: "picture", params: [] },
  { id: "effect.posterize", name: "Posterize", description: "Few flat colour bands", group: "picture", params: [{ key: "levels", name: "Levels", min: 2, max: 16, step: 1, default: 5 }] },
  { id: "effect.invert", name: "Invert", description: "Negative colours", group: "picture", params: [] },
  { id: "effect.shake", name: "Shake", description: "Handheld camera shake", group: "picture", params: [{ key: "amount", name: "Amount", min: 1, max: 80, step: 1, default: 12, unit: "px" }, { key: "speed", name: "Speed", min: 0.5, max: 8, step: 0.1, default: 3, unit: "Hz" }] },
  { id: "effect.zoom-pulse", name: "Zoom pulse", description: "Zooms in and out on a beat", group: "motion", params: [{ key: "amount", name: "Amount", min: 0.02, max: 0.4, step: 0.01, default: 0.08 }, { key: "period", name: "Period", min: 0.25, max: 4, step: 0.05, default: 1, unit: "s" }] },
  { id: "effect.letterbox", name: "Letterbox", description: "Black cinema bars", group: "overlay", params: [{ key: "ratio", name: "Ratio", min: 1.6, max: 3, step: 0.01, default: 2.39 }] },
];

export const effectInfo = (id: string | undefined) => EFFECTS.find((e) => e.id === id);
/** Every module id a clip's effects can draw (LOOK, ADJUST and EFFECTS). */
export const DRAWN_FX: ReadonlySet<string> = new Set([LOOK, ADJUST, ...EFFECTS.map((e) => e.id)]);

/** An effect's params with its defaults filled in and every value clamped. */
export function effectParams(id: string, params: unknown): Record<string, number> {
  const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const d of effectInfo(id)?.params ?? []) out[d.key] = num(p[d.key], d.min, d.max, d.default);
  return out;
}

// ---- colour maths ----

const LUMA: Rgb3 = [0.2126, 0.7152, 0.0722];
const luma = (c: Rgb3) => LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
type Px = [number, number, number];

/** A monotone cubic (Fritsch–Carlson) through a curve's points, as a function on 0–1. */
function curveFn(curve: Curve | undefined): ((x: number) => number) | undefined {
  if (!curve || curve.length < 2) return undefined;
  const pts = [...curve].filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return undefined;
  const n = pts.length;
  const xs = pts.map((p) => clamp01(p[0]));
  const ys = pts.map((p) => clamp01(p[1]));
  const d: Array<number> = [];
  for (let i = 0; i < n - 1; i++) d.push(xs[i + 1]! > xs[i]! ? (ys[i + 1]! - ys[i]!) / (xs[i + 1]! - xs[i]!) : 0);
  const m: Array<number> = [d[0]!];
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2);
  m.push(d[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  return (x: number) => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]!) i++;
    const h = xs[i + 1]! - xs[i]!;
    if (h <= 0) return ys[i]!;
    const t = (x - xs[i]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return clamp01((2 * t3 - 3 * t2 + 1) * ys[i]! + (t3 - 2 * t2 + t) * h * m[i]! + (-2 * t3 + 3 * t2) * ys[i + 1]! + (t3 - t2) * h * m[i + 1]!);
  };
}

/** Adjust on one pixel (in place). */
function applyAdjust(c: Px, a: Adjust) {
  if (a.exposure || a.temperature || a.tint) {
    // Exposure and white balance in linear light: stops, then red/blue and green/magenta gains.
    const k = 2 ** a.exposure;
    const gains: Rgb3 = [1 + 0.3 * a.temperature + 0.06 * a.tint, 1 - 0.2 * a.tint, 1 - 0.3 * a.temperature + 0.06 * a.tint];
    for (let i = 0; i < 3; i++) c[i] = clamp01(toSrgb(Math.min(1, toLinear(c[i]!) * k * gains[i]!)));
  }
  if (a.highlights || a.shadows) {
    // Tone by luma: shadows lift or sink the dark third, highlights the bright third.
    const L = luma(c);
    const dL = 0.25 * (a.shadows * 6.75 * L * (1 - L) * (1 - L) + a.highlights * 6.75 * L * L * (1 - L));
    for (let i = 0; i < 3; i++) c[i] = clamp01(c[i]! + dL);
  }
  if (a.contrast) for (let i = 0; i < 3; i++) c[i] = clamp01(0.5 + (c[i]! - 0.5) * (1 + a.contrast));
  if (a.saturation || a.vibrance) {
    // Vibrance boosts the quiet colours more than the loud ones.
    const L = luma(c);
    const s = Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
    const f = Math.max(0, 1 + a.saturation + a.vibrance * (1 - s) * (1 - s));
    for (let i = 0; i < 3; i++) c[i] = clamp01(L + (c[i]! - L) * f);
  }
}

/** A look's function on one pixel (in place). */
function lookFn(def: LookDef): (c: Px) => void {
  const adjust = def.adjust ? adjustOf(def.adjust) : undefined;
  const master = curveFn(def.curve);
  const per = [curveFn(def.red), curveFn(def.green), curveFn(def.blue)];
  const mixer = def.mixer && def.mixer.length === 9 && def.mixer.every(Number.isFinite) ? def.mixer : undefined;
  const mono = num(def.mono, 0, 1, 0);
  const fade = num(def.fade, 0, 0.5, 0);
  const tint = (t: LookDef["shadowTint"]) => (t && Array.isArray(t.color) && t.color.length === 3 ? { color: t.color.map((v) => num(v, 0, 1, 0)) as unknown as Rgb3, amount: num(t.amount, 0, 1, 0) } : undefined);
  const lo = tint(def.shadowTint);
  const hi = tint(def.highlightTint);
  return (c) => {
    if (mixer) {
      const [r, g, b] = c;
      for (let i = 0; i < 3; i++) c[i] = clamp01(mixer[i * 3]! * r + mixer[i * 3 + 1]! * g + mixer[i * 3 + 2]! * b);
    }
    if (mono) {
      const L = luma(c);
      for (let i = 0; i < 3; i++) c[i] = c[i]! + (L - c[i]!) * mono;
    }
    if (adjust) applyAdjust(c, adjust);
    if (master) for (let i = 0; i < 3; i++) c[i] = master(c[i]!);
    for (let i = 0; i < 3; i++) if (per[i]) c[i] = per[i]!(c[i]!);
    if (lo || hi) {
      // Split toning: towards the shadow colour where it's dark, the highlight colour where it's bright (soft-light-like, luma kept roughly).
      const L = luma(c);
      const ws = lo ? lo.amount * (1 - L) * (1 - L) : 0;
      const wh = hi ? hi.amount * L * L : 0;
      for (let i = 0; i < 3; i++) {
        let v = c[i]!;
        if (lo) v += ws * (lo.color[i]! - 0.5);
        if (hi) v += wh * (hi.color[i]! - 0.5);
        c[i] = clamp01(v);
      }
    }
    if (fade) for (let i = 0; i < 3; i++) c[i] = fade + c[i]! * (1 - fade);
  };
}

/** What a clip's colour is made of: a look at an intensity, an Adjust, invert. Undefined parts are off. */
export interface ColourSpec {
  readonly look?: { readonly def: LookDef; readonly intensity: number };
  readonly adjust?: Adjust;
  readonly invert?: boolean;
}

/** The colour function (sRGB-encoded 0–1 in and out): the look mixed in at its intensity, then Adjust, then invert. */
export function colourFn(spec: ColourSpec): (r: number, g: number, b: number) => Rgb3 {
  const look = spec.look && spec.look.intensity > 0 ? { fn: lookFn(spec.look.def), t: Math.min(1, spec.look.intensity) } : undefined;
  const adjust = spec.adjust && !isNeutral(spec.adjust) ? spec.adjust : undefined;
  return (r, g, b) => {
    const c: Px = [clamp01(r), clamp01(g), clamp01(b)];
    if (look) {
      const src: Rgb3 = [c[0], c[1], c[2]];
      look.fn(c);
      for (let i = 0; i < 3; i++) c[i] = src[i]! + (c[i]! - src[i]!) * look.t;
    }
    if (adjust) applyAdjust(c, adjust);
    if (spec.invert) for (let i = 0; i < 3; i++) c[i] = 1 - c[i]!;
    return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
  };
}

/** The colour table: LUT_SIZE³ RGB triples, red changing fastest (the .cube order). */
export interface ColourLut {
  readonly key: string;
  readonly size: number;
  readonly data: Float32Array;
}

const LUTS = new Map<string, ColourLut>();

/** A colour spec's table, cached by its key (several clips with one look share it). */
export function colourLut(spec: ColourSpec, size = LUT_SIZE): ColourLut {
  const key = `${size}:${JSON.stringify(spec)}`;
  const known = LUTS.get(key);
  if (known) return known;
  const fn = colourFn(spec);
  const data = new Float32Array(size * size * size * 3);
  let k = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const c = fn(r / (size - 1), g / (size - 1), b / (size - 1));
        data[k++] = c[0];
        data[k++] = c[1];
        data[k++] = c[2];
      }
  const lut = { key: lutHash(key), size, data };
  if (LUTS.size > 64) LUTS.clear();
  LUTS.set(key, lut);
  return lut;
}

/** A short stable name for a table (its file name in the export). */
function lutHash(s: string) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** A table as a .cube file (what ffmpeg's lut3d reads). */
export function cubeText(lut: ColourLut): string {
  const lines = [`TITLE "uncut ${lut.key}"`, `LUT_3D_SIZE ${lut.size}`, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
  for (let i = 0; i < lut.data.length; i += 3) lines.push(`${lut.data[i]!.toFixed(6)} ${lut.data[i + 1]!.toFixed(6)} ${lut.data[i + 2]!.toFixed(6)}`);
  return `${lines.join("\n")}\n`;
}

/** A table read the way lut3d interp=trilinear and the preview's shader read it. */
export function lutAt(lut: ColourLut, r: number, g: number, b: number): Rgb3 {
  const n = lut.size - 1;
  const at = (v: number) => {
    const x = clamp01(v) * n;
    const i = Math.min(n - 1, Math.floor(x));
    return [i, x - i] as const;
  };
  const [ri, rf] = at(r);
  const [gi, gf] = at(g);
  const [bi, bf] = at(b);
  const idx = (x: number, y: number, z: number) => ((z * lut.size + y) * lut.size + x) * 3;
  const out: Px = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const v = (x: number, y: number, z: number) => lut.data[idx(x, y, z) + ch]!;
    const c00 = v(ri, gi, bi) * (1 - rf) + v(ri + 1, gi, bi) * rf;
    const c10 = v(ri, gi + 1, bi) * (1 - rf) + v(ri + 1, gi + 1, bi) * rf;
    const c01 = v(ri, gi, bi + 1) * (1 - rf) + v(ri + 1, gi, bi + 1) * rf;
    const c11 = v(ri, gi + 1, bi + 1) * (1 - rf) + v(ri + 1, gi + 1, bi + 1) * rf;
    out[ch] = (c00 * (1 - gf) + c10 * gf) * (1 - bf) + (c01 * (1 - gf) + c11 * gf) * bf;
  }
  return out;
}

/** Posterize on one channel value (0–1): `levels` flat bands, as the shader's floor and the export's lutrgb compute it. */
export const posterize = (v: number, levels: number) => Math.min(levels - 1, Math.floor(clamp01(v) * levels)) / (levels - 1);

// ---- a clip's effects, compiled ----

/** What a clip's effects draw, in the fixed order (see the header). Lengths in canvas px. */
export interface ClipFx {
  readonly colour?: ColourSpec;
  readonly posterize?: number;
  readonly mirror?: boolean;
  readonly shake?: { readonly amount: number; readonly speed: number };
  readonly pixelate?: number;
  readonly rgbSplit?: number;
  /** The sharpen kernel's side weight (in 1/16 steps: the export's convolution takes whole numbers over 16). */
  readonly sharpen?: number;
  readonly glow?: { readonly amount: number; readonly threshold: number; readonly radius: number };
  readonly blur?: number;
  readonly pulse?: { readonly amount: number; readonly period: number };
  readonly vignette?: { readonly amount: number; readonly size: number };
  readonly grain?: { readonly amount: number };
  readonly letterbox?: { readonly ratio: number };
}

const live = (item: Pick<Item, "effects">): ReadonlyArray<ModuleUse> => (Array.isArray(item.effects) ? item.effects.filter((e) => e && typeof e.module === "string" && !e.bypass) : []);

/** A look entry's definition: a built-in one, or the custom look it carries (a plugin's, D136). */
export function lookDefOf(params: unknown): LookDef | undefined {
  const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  if (p.custom && typeof p.custom === "object") return p.custom as LookDef;
  return lookInfo(typeof p.look === "string" ? p.look : undefined)?.def;
}

/** Media looks and effects aren't drawn on (D138): SVG stills, which Chromium draws at their box's size in the export. */
export const fxSkips = (media: { readonly kind: string; readonly path?: string } | undefined) => !!media && media.kind === "image" && /\.svg$/i.test(media.path ?? "");

/** A clip's effects compiled to what the preview and export draw; undefined when nothing is drawn. */
export function clipFx(item: Pick<Item, "type" | "effects">): ClipFx | undefined {
  if (item.type !== "clip") return undefined;
  const entries = live(item);
  if (!entries.length) return undefined;
  const fx: { -readonly [K in keyof ClipFx]: ClipFx[K] } = {};
  const colour: { look?: ColourSpec["look"]; adjust?: Adjust; invert?: boolean } = {};
  for (const e of entries) {
    if (e.module === LOOK) {
      const def = lookDefOf(e.params);
      const p = (e.params ?? {}) as Record<string, unknown>;
      const intensity = num(p.intensity, 0, 1, 1);
      if (def && intensity > 0) colour.look = { def, intensity };
      continue;
    }
    if (e.module === ADJUST) {
      const a = adjustOf(e.params);
      if (!isNeutral(a)) colour.adjust = a;
      continue;
    }
    if (!effectInfo(e.module)) continue;
    const p = effectParams(e.module, e.params);
    switch (e.module) {
      case "effect.blur":
        fx.blur = p.amount!;
        break;
      case "effect.sharpen":
        fx.sharpen = Math.max(1, Math.round(p.amount! * 16)) / 16;
        break;
      case "effect.vignette":
        if (p.amount! > 0) fx.vignette = { amount: p.amount!, size: p.size! };
        break;
      case "effect.grain":
        if (p.amount! > 0) fx.grain = { amount: p.amount! };
        break;
      case "effect.glow":
        if (p.amount! > 0) fx.glow = { amount: p.amount!, threshold: p.threshold!, radius: p.radius! };
        break;
      case "effect.rgb-split":
        fx.rgbSplit = Math.round(p.amount!);
        break;
      case "effect.pixelate":
        fx.pixelate = Math.round(p.size!);
        break;
      case "effect.mirror":
        fx.mirror = true;
        break;
      case "effect.posterize":
        fx.posterize = Math.round(p.levels!);
        break;
      case "effect.invert":
        colour.invert = true;
        break;
      case "effect.shake":
        fx.shake = { amount: p.amount!, speed: p.speed! };
        break;
      case "effect.zoom-pulse":
        fx.pulse = { amount: p.amount!, period: p.period! };
        break;
      case "effect.letterbox":
        fx.letterbox = { ratio: p.ratio! };
        break;
    }
  }
  if (colour.look || colour.adjust || colour.invert) fx.colour = colour;
  return Object.keys(fx).length ? fx : undefined;
}

/** Whether the effects change the picture itself (the WebGL pass / the export's filters), not only overlays or the box. */
export const needsPicturePass = (fx: ClipFx | undefined) => !!fx && !!(fx.colour || fx.posterize || fx.mirror || fx.shake || fx.pixelate || fx.rgbSplit || fx.sharpen || fx.glow);
/** Whether anything is drawn over the picture (vignette, grain, letterbox). */
export const hasOverlay = (fx: ClipFx | undefined) => !!fx && !!(fx.vignette || fx.grain || fx.letterbox);

/**
 * The size (canvas px, whole) the effects work at: the picture at its fit in the box, before any
 * zoom (scale, keys, a pulse or a transition zoom it afterwards, effects and all).
 */
export function fxPictureSize(box: Pick<ClipBox, "x" | "y" | "w" | "h" | "fit">, media?: { width?: number | undefined; height?: number | undefined }): { w: number; h: number } {
  const r = fitRect(box, box.fit, media?.width && media?.height ? { width: media.width, height: media.height } : undefined);
  return { w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)) };
}

// ---- motion ----

/** How much a shake zooms the picture in so its edges never show: the offset at most `amount` px each way. */
export const shakeZoom = (amount: number, w: number, h: number) => 1 + (2.1 * amount) / Math.max(1, Math.min(w, h));

/** A shake's offset at a moment (s from the clip's start), px each way; |offset| ≤ amount. */
export function shakeAt(shake: NonNullable<ClipFx["shake"]>, t: number): { dx: number; dy: number } {
  const w = 2 * Math.PI * shake.speed * t;
  return {
    dx: shake.amount * (0.6 * Math.sin(w + 0.3) + 0.4 * Math.sin(2.37 * w + 1.7)),
    dy: shake.amount * (0.6 * Math.sin(1.13 * w + 2.1) + 0.4 * Math.sin(2.91 * w + 0.4)),
  };
}

/**
 * The same offset as an ffmpeg expression of `t` (a frame's moment from the clip's start, an
 * expression), px times `k` (output px per canvas px): what the export's crop moves by.
 */
export function shakeExpr(shake: NonNullable<ClipFx["shake"]>, axis: "x" | "y", t: string, k: number): string {
  const a = (shake.amount * k).toFixed(6);
  const w = `(${(2 * Math.PI * shake.speed).toFixed(9)}*(${t}))`;
  return axis === "x" ? `${a}*(0.6*sin(${w}+0.3)+0.4*sin(2.37*${w}+1.7))` : `${a}*(0.6*sin(1.13*${w}+2.1)+0.4*sin(2.91*${w}+0.4))`;
}

/**
 * Where the shaken picture's window sits in the zoomed picture (zw × zh, whole px) at a moment:
 * centred plus the offset, rounded (floor(x + 0.5), as the export's crop) and kept inside.
 */
export function shakeWindow(shake: NonNullable<ClipFx["shake"]>, t: number, w: number, h: number, zw: number, zh: number, k = 1): { x: number; y: number } {
  const o = shakeAt(shake, t);
  const at = (base: number, d: number, max: number) => Math.min(max, Math.max(0, Math.floor(base + d * k + 0.5)));
  return { x: at((zw - w) / 2, o.dx, zw - w), y: at((zh - h) / 2, o.dy, zh - h) };
}

/** The zoom a pulse adds at a moment (s from the clip's start): 1 at the start, 1 + amount half a period later. */
export const pulseZoom = (pulse: NonNullable<ClipFx["pulse"]>, t: number) => 1 + pulse.amount * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / pulse.period));

/** A clip's box with its zoom pulse (D136) at `local` frames from its start (the same box without one). */
export function fxBox(item: Pick<Item, "type" | "effects">, box: ClipBox, local: number, fps: number): ClipBox {
  if (item.type !== "clip" || !item.effects?.length) return box;
  const fx = clipFx(item);
  if (!fx?.pulse) return box;
  return moveBox(box, 0, pulseZoom(fx.pulse, local / fps));
}

// ---- overlays ----

const css = (n: number) => `${Math.round(n * 1000) / 1000}`;

/** The part of the box the picture covers (box-relative px): where vignette, grain and bars go. */
export function visibleRect(box: ClipBox): Rect {
  const x0 = Math.max(box.x, box.content.x);
  const y0 = Math.max(box.y, box.content.y);
  const x1 = Math.min(box.x + box.w, box.content.x + box.content.w);
  const y1 = Math.min(box.y + box.h, box.content.y + box.content.h);
  return { x: x0 - box.x, y: y0 - box.y, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * Film grain: grey fractal noise, inline SVG (not a data: image, which the editor's content policy
 * doesn't load), one filter id per pattern so several clips share them.
 */
const grainSvg = (seed: number, opacity: number) =>
  `<svg width="100%" height="100%" style="position:absolute;inset:0;opacity:${css(opacity)}" aria-hidden="true"><filter id="uncut-grain-${seed}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="2" seed="${seed}"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#uncut-grain-${seed})"/></svg>`;
/** Grain moves through this many patterns, a new one every GRAIN_HOLD frames. */
export const GRAIN_STATES = 6;
export const GRAIN_HOLD = 2;

/**
 * The overlays (vignette, grain, letterbox bars) as HTML positioned in the box (box-relative px,
 * over `rect`, the picture's visible part), at `local` frames from the clip's start (grain moves).
 * The preview puts it in the clip's box wrapper; the export draws it inside fxOverlayHtml's box.
 */
export function fxOverlayInner(fx: ClipFx, rect: Rect, local: number): string {
  if (!hasOverlay(fx) || rect.w <= 0 || rect.h <= 0) return "";
  const layers: Array<string> = [];
  if (fx.grain) {
    const phase = Math.floor(Math.max(0, local) / GRAIN_HOLD) % GRAIN_STATES;
    layers.push(grainSvg(phase + 1, 0.4 * fx.grain.amount));
  }
  if (fx.vignette) {
    // Dark at the corners: black rising from the inner radius out (a smoothstep in 8 stops).
    const inner = 0.15 + 0.6 * fx.vignette.size;
    const top = 0.9 * fx.vignette.amount;
    const stops = [`rgba(0,0,0,0) ${css(inner * 100)}%`];
    for (let i = 1; i <= 8; i++) {
      const r = inner + ((1 - inner) * i) / 8;
      const s = i / 8;
      stops.push(`rgba(0,0,0,${css(top * s * s * (3 - 2 * s))}) ${css(r * 100)}%`);
    }
    layers.push(`<div style="position:absolute;inset:0;background:radial-gradient(ellipse farthest-corner at 50% 50%, ${stops.join(", ")})"></div>`);
  }
  if (fx.letterbox) {
    const bar = Math.max(0, (rect.h - rect.w / fx.letterbox.ratio) / 2);
    if (bar > 0) layers.push(`<div style="position:absolute;left:0;right:0;top:0;height:${css(bar)}px;background:#000"></div><div style="position:absolute;left:0;right:0;bottom:0;height:${css(bar)}px;background:#000"></div>`);
  }
  if (!layers.length) return "";
  return `<div class="pv-fx" style="position:absolute;left:${css(rect.x)}px;top:${css(rect.y)}px;width:${css(rect.w)}px;height:${css(rect.h)}px;overflow:hidden;pointer-events:none">${layers.join("")}</div>`;
}

/** The overlays drawn on a canvas-size page for the export: the box (its corners rounded) holding fxOverlayInner. */
export function fxOverlayHtml(fx: ClipFx, box: ClipBox, local: number): string {
  const inner = fxOverlayInner(fx, visibleRect(box), local);
  if (!inner) return "<div></div>";
  return `<div style="position:absolute;left:${css(box.x)}px;top:${css(box.y)}px;width:${css(box.w)}px;height:${css(box.h)}px;overflow:hidden${box.radius > 0 ? `;border-radius:${css(box.radius)}px` : ""}">${inner}</div>`;
}

// ---- edits ----

type Plan = { readonly ops: ReadonlyArray<{ op: "update_item"; item: string; set: Record<string, unknown> }>; readonly summary: string } | { readonly problem: string };

interface Target {
  readonly tracks: ReadonlyArray<{ readonly kind: string; readonly locked?: boolean; readonly items: ReadonlyArray<Pick<Item, "id" | "type" | "effects" | "media" | "locked" | "name">> }>;
  readonly media?: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly name?: string; readonly path?: string }>;
}

function clipOf(project: Target, id: string): { item: Pick<Item, "id" | "type" | "effects" | "name">; name: string } | { problem: string } {
  for (const t of project.tracks)
    for (const it of t.items) {
      if (it.id !== id) continue;
      const media = it.media ? project.media?.find((m) => m.id === it.media) : undefined;
      if (it.type !== "clip" || !media || media.kind === "audio") return { problem: "Effects go on video clips and stills." };
      // SVG stills are drawn by Chromium in the export, not decoded: looks and effects don't apply to them (D138).
      if (fxSkips(media)) return { problem: "Looks and effects don't apply to SVG images." };
      if (t.locked || it.locked) return { problem: "That clip is locked: unlock it to change its effects." };
      return { item: it, name: it.name ?? media.name ?? it.id };
    }
  return { problem: "Pick a clip first." };
}

const setEffects = (id: string, list: ReadonlyArray<ModuleUse>, summary: string): Plan => ({ ops: [{ op: "update_item", item: id, set: { effects: list.length ? list : null } }], summary });
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Give a clip a look (one look per clip: it replaces the one it had), or with undefined take it off. */
export function planSetLook(project: Target, itemId: string, look: string | undefined, opts: { intensity?: number; custom?: LookDef; label?: string } = {}): Plan {
  const c = clipOf(project, itemId);
  if ("problem" in c) return c;
  const list = [...(c.item.effects ?? [])];
  const at = list.findIndex((e) => e.module === LOOK);
  if (look === undefined) {
    if (at < 0) return { problem: "That clip has no filter." };
    list.splice(at, 1);
    return setEffects(itemId, list, `Remove the filter from ${c.name}`);
  }
  const info = lookInfo(look);
  if (!info && !opts.custom) return { problem: `There's no filter called ${look}.` };
  const before = at >= 0 ? ((list[at]!.params ?? {}) as Record<string, unknown>) : undefined;
  const intensity = num(opts.intensity ?? (before?.look === look ? before?.intensity : undefined), 0, 1, 1);
  const params: Record<string, unknown> = { look, intensity: Math.round(intensity * 100) / 100, ...(opts.custom ? { custom: opts.custom, label: opts.label ?? look } : {}) };
  // An off filter (bypass, F18) stays off while its intensity changes; a new filter is on.
  const entry = { module: LOOK, params, ...(at >= 0 && list[at]!.bypass && before?.look === look ? { bypass: true } : {}) };
  if (at >= 0) list[at] = entry;
  else list.unshift(entry);
  const name = info?.name ?? opts.label ?? look;
  return setEffects(itemId, list, opts.intensity !== undefined && before?.look === look ? `Set ${name} on ${c.name} to ${pct(intensity)}` : `Filter ${name} on ${c.name}`);
}

/** Change a clip's Adjust (a patch of its values; 0 is neutral); an all-neutral Adjust is removed. */
export function planAdjust(project: Target, itemId: string, patch: Partial<Record<AdjustKey, number>> | "reset"): Plan {
  const c = clipOf(project, itemId);
  if ("problem" in c) return c;
  const list = [...(c.item.effects ?? [])];
  const at = list.findIndex((e) => e.module === ADJUST);
  const before = at >= 0 ? adjustOf(list[at]!.params) : NO_ADJUST;
  const next = patch === "reset" ? NO_ADJUST : adjustOf({ ...before, ...patch });
  const params: Record<string, number> = {};
  for (const k of ADJUST_KEYS) if (next[k] !== 0) params[k] = Math.round(next[k] * 1000) / 1000;
  // Other params the entry had (an older project's) are kept on a reset only if they're not Adjust's.
  if (Object.keys(params).length) {
    const entry = { module: ADJUST, params, ...(at >= 0 && list[at]!.bypass ? { bypass: true } : {}) };
    if (at >= 0) list[at] = entry;
    else list.push(entry);
  } else if (at >= 0) list.splice(at, 1);
  else return { problem: "Nothing to reset." };
  const keys = patch === "reset" ? [] : (Object.keys(patch) as Array<AdjustKey>);
  const info = keys.length === 1 ? ADJUST_INFO.find((a) => a.key === keys[0]) : undefined;
  const summary = patch === "reset" ? `Reset the adjustments of ${c.name}` : info ? `Set ${info.name.toLowerCase()} of ${c.name} to ${adjustWord(info.key, next[info.key])}` : `Adjust ${c.name}`;
  return setEffects(itemId, list, summary);
}

/** An Adjust value as the Inspector shows it: stops for exposure, −100 to 100 for the rest. */
export const adjustWord = (key: AdjustKey, v: number) => (key === "exposure" ? `${v > 0 ? "+" : ""}${Math.round(v * 100) / 100} EV` : `${v > 0 ? "+" : ""}${Math.round(v * 100)}`);

/** Add an effect to a clip (with its defaults), or with `params` change the one it has. */
export function planEffect(project: Target, itemId: string, module: string, params?: Record<string, number>): Plan {
  const c = clipOf(project, itemId);
  const info = effectInfo(module);
  if (!info) return { problem: `There's no effect called ${module}.` };
  if ("problem" in c) return c;
  const list = [...(c.item.effects ?? [])];
  const at = list.findIndex((e) => e.module === module);
  const base = at >= 0 ? effectParams(module, list[at]!.params) : effectParams(module, {});
  const next = effectParams(module, { ...base, ...(params ?? {}) });
  const entry = { module, ...(info.params.length ? { params: next } : {}), ...(at >= 0 && list[at]!.bypass ? { bypass: true } : {}) };
  if (at >= 0) {
    if (!params) return { problem: `${c.name} already has ${info.name.toLowerCase()}.` };
    list[at] = entry;
    const keys = Object.keys(params);
    const p = keys.length === 1 ? info.params.find((d) => d.key === keys[0]) : undefined;
    return setEffects(itemId, list, p ? `Set ${info.name.toLowerCase()} ${p.name.toLowerCase()} on ${c.name} to ${Math.round(next[p.key]! * 100) / 100}${p.unit ? ` ${p.unit}` : ""}` : `Change ${info.name.toLowerCase()} on ${c.name}`);
  }
  list.push(entry);
  return setEffects(itemId, list, `Add ${info.name.toLowerCase()} to ${c.name}`);
}

/** Take an effect (or the look, or Adjust) off a clip. */
export function planRemoveEffect(project: Target, itemId: string, module: string): Plan {
  const c = clipOf(project, itemId);
  if ("problem" in c) return c;
  const list = (c.item.effects ?? []).filter((e) => e.module !== module);
  if (list.length === (c.item.effects ?? []).length) return { problem: "That clip doesn't have it." };
  const name = module === LOOK ? "the filter" : module === ADJUST ? "the adjustments" : module === SHADER ? "the shader effect" : (effectInfo(module)?.name.toLowerCase() ?? module);
  return setEffects(itemId, list, `Remove ${name} from ${c.name}`);
}

/**
 * Turn one of a clip's effects (or its filter, or Adjust) off or on (F18): an off entry keeps its
 * place and settings (`bypass`, as the mixer's audio effects) and isn't drawn by the preview or the
 * export (clipFx skips it).
 */
export function planEffectBypass(project: Target, itemId: string, module: string, on: boolean): Plan {
  const c = clipOf(project, itemId);
  if ("problem" in c) return c;
  const list = [...(c.item.effects ?? [])];
  const at = list.findIndex((e) => e.module === module);
  if (at < 0) return { problem: "That clip doesn't have it." };
  if (!list[at]!.bypass === on) return { problem: on ? "It's already on." : "It's already off." };
  const { bypass: _, ...rest } = list[at]!;
  list[at] = on ? rest : { ...rest, bypass: true };
  const name = module === LOOK ? "the filter" : module === ADJUST ? "the adjustments" : module === SHADER ? "the shader effect" : (effectInfo(module)?.name.toLowerCase() ?? module);
  return setEffects(itemId, list, `Turn ${name} on ${c.name} ${on ? "on" : "off"}`);
}

/** A clip's effects in words (History, D136): "filter Warm 80%, exposure +0.3 EV, blur 8 px". */
export function fxWords(effects: unknown): string {
  const list = Array.isArray(effects) ? (effects as ReadonlyArray<ModuleUse>) : [];
  if (!list.length) return "no effects";
  return list
    .map((e) => {
      if (e.module === LOOK) {
        const p = (e.params ?? {}) as Record<string, unknown>;
        const name = typeof p.label === "string" ? p.label : (lookInfo(String(p.look))?.name ?? String(p.look));
        return `filter ${name} ${pct(num(p.intensity, 0, 1, 1))}${e.bypass ? " (off)" : ""}`;
      }
      if (e.module === ADJUST) {
        const a = adjustOf(e.params);
        const parts = ADJUST_INFO.filter((i) => a[i.key] !== 0).map((i) => `${i.name.toLowerCase()} ${adjustWord(i.key, a[i.key])}`);
        return (parts.length ? parts.join(", ") : "no adjustments") + (e.bypass ? " (off)" : "");
      }
      if (e.module === SHADER) {
        const p = (e.params ?? {}) as Record<string, unknown>;
        return `shader ${typeof p.name === "string" ? p.name : String(p.shader)}${e.bypass ? " (off)" : ""}`;
      }
      const info = effectInfo(e.module);
      if (!info) return e.module;
      const p = effectParams(e.module, e.params);
      const first = info.params[0];
      return `${info.name.toLowerCase()}${first ? ` ${Math.round(p[first.key]! * 100) / 100}${first.unit ? ` ${first.unit}` : ""}` : ""}${e.bypass ? " (off)" : ""}`;
    })
    .join(", ");
}
