// The colour readout (the measure tool's colour): brightness, black and white points, mean colour,
// saturation and the white balance cast of a frame's pixels, and the effect.color values that would
// neutralise the cast or match another clip. Pure: the exporter renders and decodes the frames.
import { colourFn, type ColourSpec } from "@uncut/core";

import type { RgbImage } from "../export/exporter/framePixels.ts";

/** How each grading control moves the picture, from core's effect.color maths (fx/colour.ts). */
export const GRADING_DIRECTIONS =
  "effect.color directions: exposure in stops (+1 doubles the light); temperature + is warmer (more red, less blue), − cooler; tint + is magenta (less green), − green; contrast + spreads blacks and whites apart; saturation and vibrance + more colour; highlights and shadows + brighten that third of the range. A cast is fixed by moving against it (a warm magenta cast: temperature − and tint −).";

/** A frame's channels differing by less than this (0-255) on its neutral pixels counts as neutral. */
export const NEUTRAL_TOLERANCE = 3;

export interface ColourStats {
  /** Mean luma (Rec. 709 weights on the sRGB values), 0-255. */
  readonly luma: number;
  /** Luma at the 1st and 99th percentiles, 0-255. */
  readonly black: number;
  readonly white: number;
  /** Share of pixels crushed (luma ≤ 2) and clipped (≥ 253), %. */
  readonly crushed: number;
  readonly clipped: number;
  /** Mean R, G, B, 0-255. */
  readonly rgb: readonly [number, number, number];
  /** Mean saturation (max − min over max), %. */
  readonly saturation: number;
  /** The cast of the near-neutral pixels (R − G and B − G, 0-255 scale), and their mean in linear light; undefined with too few of them. */
  readonly neutral?: { readonly rMinusG: number; readonly bMinusG: number; readonly share: number; readonly linear: readonly [number, number, number] };
}

const LUMA = [0.2126, 0.7152, 0.0722] as const;
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const LINEAR = Array.from({ length: 256 }, (_, v) => toLinear(v / 255));
const round1 = (v: number) => Math.round(v * 10) / 10;

/** The value at a percentile of a 256-bin histogram. */
function percentile(hist: Uint32Array, total: number, p: number) {
  const want = total * p;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v]!;
    if (seen >= want) return v;
  }
  return 255;
}

/**
 * The readout of one image. Near-neutral pixels: mid-tone (luma 40 to 235, no channel clipped) and
 * among the least saturated fifth of those, so a cast still shows in them; the cast needs at least
 * 1 % of the frame.
 */
export function colourStats(image: RgbImage): ColourStats {
  const { rgb } = image;
  const n = Math.floor(rgb.length / 3);
  const lumaHist = new Uint32Array(256);
  const chromaHist = new Uint32Array(256);
  const sums = [0, 0, 0];
  let lumaSum = 0;
  let satSum = 0;
  let mid = 0;
  for (let p = 0; p < n; p++) {
    const r = rgb[3 * p]!;
    const g = rgb[3 * p + 1]!;
    const b = rgb[3 * p + 2]!;
    const y = Math.round(LUMA[0] * r + LUMA[1] * g + LUMA[2] * b);
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    lumaHist[y]!++;
    lumaSum += y;
    sums[0]! += r;
    sums[1]! += g;
    sums[2]! += b;
    satSum += hi ? (hi - lo) / hi : 0;
    if (y >= 40 && y <= 235 && hi < 250) {
      chromaHist[hi - lo]!++;
      mid++;
    }
  }
  const limit = percentile(chromaHist, mid, 0.2);
  const neutral = [0, 0, 0];
  const linear = [0, 0, 0];
  let count = 0;
  for (let p = 0; p < n; p++) {
    const r = rgb[3 * p]!;
    const g = rgb[3 * p + 1]!;
    const b = rgb[3 * p + 2]!;
    const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
    const hi = Math.max(r, g, b);
    if (y < 40 || y > 235 || hi >= 250 || hi - Math.min(r, g, b) > limit) continue;
    neutral[0]! += r;
    neutral[1]! += g;
    neutral[2]! += b;
    linear[0]! += LINEAR[r]!;
    linear[1]! += LINEAR[g]!;
    linear[2]! += LINEAR[b]!;
    count++;
  }
  const share = n ? count / n : 0;
  return {
    luma: round1(lumaSum / Math.max(1, n)),
    black: percentile(lumaHist, n, 0.01),
    white: percentile(lumaHist, n, 0.99),
    crushed: round1((100 * (lumaHist[0]! + lumaHist[1]! + lumaHist[2]!)) / Math.max(1, n)),
    clipped: round1((100 * (lumaHist[253]! + lumaHist[254]! + lumaHist[255]!)) / Math.max(1, n)),
    rgb: [round1(sums[0]! / Math.max(1, n)), round1(sums[1]! / Math.max(1, n)), round1(sums[2]! / Math.max(1, n))],
    saturation: round1((100 * satSum) / Math.max(1, n)),
    ...(share >= 0.01
      ? {
          neutral: {
            rMinusG: round1((neutral[0]! - neutral[1]!) / count),
            bMinusG: round1((neutral[2]! - neutral[1]!) / count),
            share: round1(100 * share),
            linear: [linear[0]! / count, linear[1]! / count, linear[2]! / count] as const,
          },
        }
      : {}),
  };
}

/** An image through a clip's colour (its look and effect.color, core's maths, as the export's colour table draws it). */
export function graded(image: RgbImage, spec: ColourSpec | undefined): RgbImage {
  if (!spec) return image;
  const fn = colourFn(spec);
  const rgb = new Uint8Array(image.rgb.length);
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const [r, g, b] = fn(image.rgb[i]! / 255, image.rgb[i + 1]! / 255, image.rgb[i + 2]! / 255);
    rgb[i] = Math.round(r * 255);
    rgb[i + 1] = Math.round(g * 255);
    rgb[i + 2] = Math.round(b * 255);
  }
  return { width: image.width, height: image.height, rgb };
}

/** The cast in words: warm or cool, green or magenta, from the neutral pixels' R − G and B − G. */
export function castWords(neutral: ColourStats["neutral"]): string {
  if (!neutral) return "no near-neutral area to judge the white balance on";
  const { rMinusG, bMinusG } = neutral;
  const warm = (rMinusG - bMinusG) / 2;
  const magenta = (rMinusG + bMinusG) / 2;
  const parts = [
    ...(Math.abs(warm) >= NEUTRAL_TOLERANCE ? [warm > 0 ? "warm (orange)" : "cool (blue)"] : []),
    ...(Math.abs(magenta) >= NEUTRAL_TOLERANCE ? [magenta > 0 ? "magenta" : "green"] : []),
  ];
  return parts.length ? `${parts.join(" and ")} cast` : "neutral";
}

/**
 * The temperature and tint change that turns linear neutral `from` into the balance of `to` (grey
 * when omitted), solving core's white balance gains: R × (1 + 0.3 T + 0.06 t), G × (1 − 0.2 t), B × (1 − 0.3 T + 0.06 t).
 */
export function balanceShift(from: readonly [number, number, number], to: readonly [number, number, number] = [1, 1, 1]) {
  const a = (to[0] / to[1]) * (from[1] / from[0]);
  const c = (to[2] / to[1]) * (from[1] / from[2]);
  const tint = (a + c - 2) / (0.12 + 0.2 * (a + c));
  const temperature = ((a - c) * (1 - 0.2 * tint)) / 0.6;
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(-1, v)) * 100) / 100;
  return { temperature: clamp(temperature), tint: clamp(tint), ...(Math.abs(temperature) > 1 || Math.abs(tint) > 1 ? { limited: true } : {}) };
}

/** How much the white balance gains of a shift change the luma of a near-grey picture (a factor in linear light). */
const balanceLuma = (s: { readonly temperature: number; readonly tint: number }) =>
  LUMA[0] * (1 + 0.3 * s.temperature + 0.06 * s.tint) + LUMA[1] * (1 - 0.2 * s.tint) + LUMA[2] * (1 - 0.3 * s.temperature + 0.06 * s.tint);
const LIMITED = " (at the control's limit: the cast is stronger than effect.color can take out fully)";
const signed = (v: number) => `${v >= 0 ? "+" : ""}${v}`;

/** The exposure change (stops) that brings mean luma `from` to `to` (both 0-255, in linear light). */
export const exposureShift = (from: number, to: number) =>
  Math.round(Math.log2(Math.max(1e-4, toLinear(to / 255)) / Math.max(1e-4, toLinear(from / 255))) * 100) / 100;

/** Several frames' readouts as one (a clip's samples): means, the widest black and white points. */
export function mergeStats(list: ReadonlyArray<ColourStats>): ColourStats {
  if (list.length === 1) return list[0]!;
  const mean = (f: (s: ColourStats) => number, among = list) => round1(among.reduce((sum, s) => sum + f(s), 0) / among.length);
  const withNeutral = list.filter((s) => s.neutral);
  const lin = (k: 0 | 1 | 2) => withNeutral.reduce((sum, s) => sum + s.neutral!.linear[k], 0) / withNeutral.length;
  return {
    luma: mean((s) => s.luma),
    black: Math.min(...list.map((s) => s.black)),
    white: Math.max(...list.map((s) => s.white)),
    crushed: mean((s) => s.crushed),
    clipped: mean((s) => s.clipped),
    rgb: [mean((s) => s.rgb[0]), mean((s) => s.rgb[1]), mean((s) => s.rgb[2])],
    saturation: mean((s) => s.saturation),
    ...(withNeutral.length
      ? {
          neutral: {
            rMinusG: mean((s) => s.neutral!.rMinusG, withNeutral),
            bMinusG: mean((s) => s.neutral!.bMinusG, withNeutral),
            share: mean((s) => s.neutral!.share, withNeutral),
            linear: [lin(0), lin(1), lin(2)] as const,
          },
        }
      : {}),
  };
}

/** One readout for the agent: the numbers, the cast in words and what would neutralise it. */
export function colourReadout(stats: ColourStats) {
  const { neutral } = stats;
  const fix = neutral && castWords(neutral) !== "neutral" ? balanceShift(neutral.linear) : undefined;
  return {
    luma: stats.luma,
    blackPoint: stats.black,
    whitePoint: stats.white,
    ...(stats.crushed >= 1 ? { crushedPercent: stats.crushed } : {}),
    ...(stats.clipped >= 1 ? { clippedPercent: stats.clipped } : {}),
    meanRgb: stats.rgb,
    saturationPercent: stats.saturation,
    whiteBalance: neutral
      ? `${castWords(neutral)} (near-neutral pixels, ${neutral.share} % of the frame: R − G ${neutral.rMinusG}, B − G ${neutral.bMinusG})`
      : castWords(undefined),
    ...(fix ? { neutralise: `add temperature ${fix.temperature} and tint ${fix.tint} to the clip's effect.color${fix.limited ? LIMITED : ""}` } : {}),
  };
}

/** The exposure (stops, after the balance's own effect on brightness) and white balance changes that bring `b` to `a`. */
export function matchShift(a: ColourStats, b: ColourStats) {
  const balance = a.neutral && b.neutral ? balanceShift(b.neutral.linear, a.neutral.linear) : undefined;
  const exposure = Math.round((exposureShift(b.luma, a.luma) - (balance ? Math.log2(balanceLuma(balance)) : 0)) * 100) / 100;
  return { exposure, balance };
}

/** What would make clip `b` look like clip `a`: exposure, temperature and tint changes for b's effect.color. */
export function matchReadout(a: { readonly name: string; readonly stats: ColourStats }, b: { readonly name: string; readonly stats: ColourStats }): string {
  const { exposure: stops, balance } = matchShift(a.stats, b.stats);
  const parts = [`exposure ${signed(stops)}`, ...(balance ? [`temperature ${signed(balance.temperature)}`, `tint ${signed(balance.tint)}`] : [])];
  return `To match ${b.name} to ${a.name}: add ${parts.join(", ")} to ${b.name}'s effect.color${balance?.limited ? LIMITED : ""} (luma ${b.stats.luma} vs ${a.stats.luma}${balance ? `, ${castWords(b.stats.neutral)} vs ${castWords(a.stats.neutral)}` : ", white balance not comparable: too few near-neutral pixels"}).`;
}
