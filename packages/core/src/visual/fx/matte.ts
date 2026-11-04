// A clip's alpha path and blend mode (D326), one definition for the preview and the export.
// Alpha: the chroma key (on the picture, first, before the other picture effects), then the shape
// mask (in the clip's box, after its corners). A later per-clip matte joins the same path.
// Key: the distance of a pixel's BT.709 chroma (Cb, Cr, each −0.5 to 0.5) from the key colour's;
// alpha rises from 0 at `tolerance` to 1 at tolerance + softness. Spill removal is ffmpeg despill's
// sum for a green or blue key (mix 0.5, expand 0): spill = max(G − (R + B)/2, 0), G −= amount · spill.
// Mask: a rectangle (rounded corners) or ellipse in canvas px from the box's top-left, its edge
// `feather` px wide (centred on the edge, at least a pixel), optionally inverted. Its x, y, w and h
// can be keyed with the box's keys (maskX, maskY, maskW, maskH).
// Blend: how the clip's colour meets what's under it (sRGB-encoded, as CSS mix-blend-mode does).
import type { Item } from "../../timeline/types.ts";
import { DEFAULT_KEY_FPS, keyAt } from "../box.ts";

// ---- blend ----

export type BlendMode = "normal" | "screen" | "multiply" | "overlay" | "add" | "lighten" | "darken";

export interface BlendInfo {
  readonly id: BlendMode;
  readonly name: string;
  /** CSS mix-blend-mode. */
  readonly css: string;
  /** ffmpeg blend's mode, with the backdrop as its first input. */
  readonly ffmpeg: string;
}

export const BLEND_MODES: ReadonlyArray<BlendInfo> = [
  { id: "normal", name: "Normal", css: "normal", ffmpeg: "normal" },
  { id: "screen", name: "Screen", css: "screen", ffmpeg: "screen" },
  { id: "multiply", name: "Multiply", css: "multiply", ffmpeg: "multiply" },
  { id: "overlay", name: "Overlay", css: "overlay", ffmpeg: "overlay" },
  { id: "add", name: "Add", css: "plus-lighter", ffmpeg: "addition" },
  { id: "lighten", name: "Lighten", css: "lighten", ffmpeg: "lighten" },
  { id: "darken", name: "Darken", css: "darken", ffmpeg: "darken" },
];

export const blendInfo = (id: string | undefined) => BLEND_MODES.find((b) => b.id === id);

/** A blend mode on one channel (0–1): `b` the backdrop, `s` the clip. */
export function blendChannel(mode: BlendMode, b: number, s: number): number {
  switch (mode) {
    case "screen":
      return 1 - (1 - b) * (1 - s);
    case "multiply":
      return b * s;
    case "overlay":
      return b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case "add":
      return Math.min(1, b + s);
    case "lighten":
      return Math.max(b, s);
    case "darken":
      return Math.min(b, s);
    default:
      return s;
  }
}

// ---- chroma key ----

export interface ChromaKey {
  /** The key colour, #rrggbb. */
  readonly color: string;
  readonly tolerance: number;
  readonly softness: number;
  readonly spill: number;
}

const KR = 0.2126;
const KB = 0.0722;

/** BT.709 chroma (Cb, Cr) of sRGB-encoded 0–1 RGB. */
export function chromaOf(r: number, g: number, b: number): { cb: number; cr: number } {
  const y = KR * r + (1 - KR - KB) * g + KB * b;
  return { cb: (b - y) / (2 * (1 - KB)), cr: (r - y) / (2 * (1 - KR)) };
}

export const hexRgb = (hex: string): [number, number, number] => {
  const v = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? "00ff00";
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number];
};

/** The key colour's chroma. */
export const keyChroma = (key: Pick<ChromaKey, "color">) => chromaOf(...hexRgb(key.color));

/** A pixel's alpha after the key (0 keyed out, 1 kept). */
export function keyAlpha(key: ChromaKey, r: number, g: number, b: number): number {
  const k = keyChroma(key);
  const c = chromaOf(r, g, b);
  const d = Math.hypot(c.cb - k.cb, c.cr - k.cr);
  return Math.min(1, Math.max(0, (d - key.tolerance) / key.softness));
}

/** The channel spill removal pulls down: green or blue, whichever the key colour is (none for other keys). */
export function spillChannel(key: Pick<ChromaKey, "color">): "green" | "blue" | undefined {
  const [r, g, b] = hexRgb(key.color);
  if (g > r && g >= b) return "green";
  if (b > r && b > g) return "blue";
  return undefined;
}

/** A pixel's colour after spill removal. */
export function despill(key: ChromaKey, r: number, g: number, b: number): [number, number, number] {
  const ch = spillChannel(key);
  if (!ch || key.spill <= 0) return [r, g, b];
  if (ch === "green") return [r, Math.max(0, g - key.spill * Math.max(0, g - (r + b) / 2)), b];
  return [r, g, Math.max(0, b - key.spill * Math.max(0, b - (r + g) / 2))];
}

const num = (v: number) => `${Math.round(v * 1e6) / 1e6}`;

/** keyAlpha as an ffmpeg lut2 expression of x (U) and y (V), 8-bit limited range, giving 0–255. */
export function keyAlphaExpr(key: ChromaKey): string {
  const k = keyChroma(key);
  const d = `hypot((x-128)/224-(${num(k.cb)}),(y-128)/224-(${num(k.cr)}))`;
  return `255*clip((${d}-${num(key.tolerance)})/${num(key.softness)},0,1)`;
}

// ---- shape mask ----

export type ClipMaskShape = "rectangle" | "ellipse";

/** A clip's mask as its params give it: canvas px from the box's top-left; w or h 0 is the box's. */
export interface ClipMask {
  readonly shape: ClipMaskShape;
  readonly invert: boolean;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly radius: number;
  readonly feather: number;
}

/** The keys that move a clip's mask, and the mask value each one sets. */
export const MASK_KEYS = { maskX: "x", maskY: "y", maskW: "w", maskH: "h" } as const;
export type MaskKeyProp = keyof typeof MASK_KEYS;

/** The mask at `local` frames from the clip's start: its keys applied, a size of 0 the box's, at least 1 px. */
export function maskAt(mask: ClipMask, keys: Item["keys"], local: number, box: { readonly w: number; readonly h: number }, fps = DEFAULT_KEY_FPS): ClipMask {
  const at = (prop: MaskKeyProp, own: number) => keyAt(keys, prop, local, fps) ?? own;
  const w = at("maskW", mask.w);
  const h = at("maskH", mask.h);
  return {
    ...mask,
    x: at("maskX", mask.x),
    y: at("maskY", mask.y),
    w: Math.max(1, w > 0 ? w : box.w),
    h: Math.max(1, h > 0 ? h : box.h),
  };
}

/** The mask scaled: `kx`, `ky` px per canvas px (radius and feather by the smaller). */
export function scaleMask(mask: ClipMask, kx: number, ky: number): ClipMask {
  const k = Math.min(kx, ky);
  return { ...mask, x: mask.x * kx, y: mask.y * ky, w: mask.w * kx, h: mask.h * ky, radius: mask.radius * k, feather: mask.feather * k };
}

/**
 * How much of the pixel centred at (x, y) the mask keeps (0–1): a signed distance to its edge (an
 * ellipse's approximated), softened over `feather` px (at least `pixel`), inverted when asked.
 */
export function maskCoverage(m: ClipMask, x: number, y: number, pixel = 1): number {
  const hw = m.w / 2;
  const hh = m.h / 2;
  const px = x - (m.x + hw);
  const py = y - (m.y + hh);
  let d: number;
  if (m.shape === "ellipse") {
    const k0 = Math.hypot(px / hw, py / hh);
    const k1 = Math.hypot(px / (hw * hw), py / (hh * hh));
    d = k1 > 0 ? (k0 * (k0 - 1)) / k1 : -Math.min(hw, hh);
  } else {
    const r = Math.min(m.radius, hw, hh);
    const qx = Math.abs(px) - (hw - r);
    const qy = Math.abs(py) - (hh - r);
    d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  }
  const c = Math.min(1, Math.max(0, 0.5 - d / Math.max(m.feather, pixel)));
  return m.invert ? 1 - c : c;
}

/**
 * maskCoverage as an ffmpeg expression of `X` and `Y` (the pixel centre's expressions), giving 0–1.
 * `at` replaces the mask's x, y, w or h with expressions (a keyed mask's value at the frame).
 */
export function maskCoverageExpr(m: ClipMask, X: string, Y: string, pixel = 1, at: Partial<Record<"x" | "y" | "w" | "h", string>> = {}): string {
  const hw = `(${at.w ?? num(m.w)})/2`;
  const hh = `(${at.h ?? num(m.h)})/2`;
  const px = `(${X}-(${at.x ?? num(m.x)})-${hw})`;
  const py = `(${Y}-(${at.y ?? num(m.y)})-${hh})`;
  let d: string;
  if (m.shape === "ellipse") {
    const k0 = `hypot(${px}/(${hw}),${py}/(${hh}))`;
    const k1 = `hypot(${px}/(${hw})/(${hw}),${py}/(${hh})/(${hh}))`;
    d = `if(gt(${k1},0),${k0}*(${k0}-1)/${k1},-min(${hw},${hh}))`;
  } else {
    const r = `min(${num(m.radius)},min(${hw},${hh}))`;
    const qx = `(abs(${px})-(${hw})+${r})`;
    const qy = `(abs(${py})-(${hh})+${r})`;
    d = `(hypot(max(${qx},0),max(${qy},0))+min(max(${qx},${qy}),0)-${r})`;
  }
  const c = `clip(0.5-${d}/${num(Math.max(m.feather, pixel))},0,1)`;
  return m.invert ? `(1-${c})` : c;
}
