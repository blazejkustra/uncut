// Camera motion between consecutive frames by phase correlation (the video analyzer, D67).
import { fftTables, fft as fft1 } from "../fft.ts";

export const MOTION_W = 128;
export const MOTION_H = 64;

// ---- phase correlation ----

/**
 * The translation between consecutive frames, by phase correlation on a Hann-windowed W × H
 * patch: dx, dy in pixels (positive: the picture moved right / down, so the camera turned left /
 * up) and the peak's height (0–1), how sure it is.
 */
export class PhaseCorrelator {
  private readonly w: number;
  private readonly h: number;
  private readonly window: Float64Array;
  private readonly cosW: Float64Array;
  private readonly sinW: Float64Array;
  private readonly cosH: Float64Array;
  private readonly sinH: Float64Array;
  private prevRe: Float64Array | undefined;
  private prevIm: Float64Array | undefined;
  private re: Float64Array;
  private im: Float64Array;

  constructor(w = MOTION_W, h = MOTION_H) {
    this.w = w;
    this.h = h;
    this.window = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.window[y * w + x] = (0.5 - 0.5 * Math.cos((2 * Math.PI * (x + 0.5)) / w)) * (0.5 - 0.5 * Math.cos((2 * Math.PI * (y + 0.5)) / h));
    [this.cosW, this.sinW] = fftTables(w);
    [this.cosH, this.sinH] = fftTables(h);
    this.re = new Float64Array(w * h);
    this.im = new Float64Array(w * h);
  }

  private fft2(re: Float64Array, im: Float64Array, inverse: boolean) {
    for (let y = 0; y < this.h; y++) fft1(re, im, y * this.w, 1, this.w, inverse, this.cosW, this.sinW);
    for (let x = 0; x < this.w; x++) fft1(re, im, x, this.w, this.h, inverse, this.cosH, this.sinH);
  }

  /** Forgets the previous frame (after a cut). */
  reset() {
    this.prevRe = undefined;
    this.prevIm = undefined;
  }

  /**
   * Adds a frame (grey bytes, `stride` per row; the patch is its centre) and returns its motion
   * against the previous one, or undefined for the first.
   */
  push(pixels: Uint8Array, frameW: number, frameH: number): { dx: number; dy: number; peak: number } | undefined {
    const { w, h } = this;
    const ox = Math.max(0, (frameW - w) >> 1);
    const oy = Math.max(0, (frameH - h) >> 1);
    const re = this.re;
    const im = this.im;
    let sum = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sum += pixels[(y + oy) * frameW + x + ox]!;
    const mean = sum / (w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        re[i] = (pixels[(y + oy) * frameW + x + ox]! - mean) * this.window[i]!;
        im[i] = 0;
      }
    }
    this.fft2(re, im, false);
    const prevRe = this.prevRe;
    const prevIm = this.prevIm;
    // This frame's spectrum becomes the previous one; the old buffers are reused for the product.
    this.prevRe = re;
    this.prevIm = im;
    if (!prevRe || !prevIm) {
      this.re = new Float64Array(w * h);
      this.im = new Float64Array(w * h);
      return undefined;
    }
    // Cross-power spectrum (current × conj(previous)), normalised, into the old buffers.
    for (let i = 0; i < w * h; i++) {
      const ar = re[i]!;
      const ai = im[i]!;
      const br = prevRe[i]!;
      const bi = -prevIm[i]!;
      const pr = ar * br - ai * bi;
      const pi = ar * bi + ai * br;
      const mag = Math.hypot(pr, pi);
      prevRe[i] = mag > 1e-9 ? pr / mag : 0;
      prevIm[i] = mag > 1e-9 ? pi / mag : 0;
    }
    this.fft2(prevRe, prevIm, true);
    const n = w * h;
    let best = 0;
    let bestV = -Infinity;
    for (let i = 0; i < n; i++) {
      if (prevRe[i]! > bestV) {
        bestV = prevRe[i]!;
        best = i;
      }
    }
    const px = best % w;
    const py = (best - px) / w;
    const at = (x: number, y: number) => prevRe[((y + h) % h) * w + ((x + w) % w)]! / n;
    const c = at(px, py);
    // Sub-pixel (Foroosh, Zerubia & Berthod 2002): a shift's correlation is a sinc, so the larger
    // neighbour's share of it and the peak gives the fraction (a parabola is biased to whole pixels).
    const sub = (l: number, r: number) => {
      const s = r >= l ? r : l;
      const dir = r >= l ? 1 : -1;
      if (s <= 0 || c <= 0) return 0;
      return dir * Math.min(0.5, s / (s + c));
    };
    let dx = px + sub(at(px - 1, py), at(px + 1, py));
    let dy = py + sub(at(px, py - 1), at(px, py + 1));
    if (dx > w / 2) dx -= w;
    if (dy > h / 2) dy -= h;
    // Reuse: the product buffers become the next frame's input.
    this.re = prevRe;
    this.im = prevIm;
    return { dx, dy, peak: c };
  }
}
