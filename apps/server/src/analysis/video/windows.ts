// Per-frame measurements into per-second windows (the video analyzer, D67).
import type { VideoWindow } from "./result.ts";

// ---- per-frame measurements into per-second windows ----

export interface FrameSample {
  readonly time: number;
  /** Motion against the previous frame (pixels of the motion patch), undefined: not matched (first frame, cut, low confidence). */
  readonly dx?: number | undefined;
  readonly dy?: number | undefined;
  readonly blur?: number | undefined;
  readonly brightness: number;
  readonly dark: number;
  readonly bright: number;
}

export const round = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/**
 * Gaussian-weighted local quadratic fit of a series (sigma in samples): each value is the fitted
 * curve's value there. A steady pan and a steady acceleration (a yaw that speeds up or slows down)
 * stay exact, up to the ends of a run, so only the wobble on top reads as shake; a plain Gaussian
 * average or a local line bent smooth moves into "shake" (a DJI yaw read as 2 % of the width).
 */
export function smooth(values: ArrayLike<number>, sigma: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (sigma <= 0 || n < 4) {
    for (let i = 0; i < n; i++) out[i] = values[i]!;
    return out;
  }
  const radius = Math.ceil(sigma * 3);
  const kernel = new Float64Array(radius * 2 + 1);
  for (let k = -radius; k <= radius; k++) kernel[k + radius] = Math.exp(-(k * k) / (2 * sigma * sigma));
  for (let i = 0; i < n; i++) {
    // Normal equations of a + b·k + c·k² over the window (weights w), solved for a (the value at k = 0).
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    let s4 = 0;
    let t0 = 0;
    let t1 = 0;
    let t2 = 0;
    for (let k = Math.max(-radius, -i); k <= Math.min(radius, n - 1 - i); k++) {
      const w = kernel[k + radius]!;
      const y = values[i + k]!;
      const k2 = k * k;
      s0 += w;
      s1 += w * k;
      s2 += w * k2;
      s3 += w * k2 * k;
      s4 += w * k2 * k2;
      t0 += w * y;
      t1 += w * k * y;
      t2 += w * k2 * y;
    }
    // Cramer's rule for the first unknown of [[s0 s1 s2] [s1 s2 s3] [s2 s3 s4]] · [a b c] = [t0 t1 t2].
    const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
    const detA = t0 * (s2 * s4 - s3 * s3) - s1 * (t1 * s4 - s3 * t2) + s2 * (t1 * s3 - s2 * t2);
    out[i] = Math.abs(det) > 1e-9 * Math.max(1, s0 * s2 * s4) ? detA / det : t0 / s0;
  }
  return out;
}

/** Smoothing of the camera's path: what's left after it is shake (above ~1 Hz). */
export const SMOOTH_SIGMA_S = 0.15;

/**
 * Per second of the file: shake (the camera's path minus its smoothed path, RMS, in frame widths),
 * pan speed, blur, brightness, clipping and frozen share. The path is built from the frame-to-frame
 * motion within each run of matched frames; a cut or an unmatched pair starts a new run.
 */
export function windowsOf(
  samples: ReadonlyArray<FrameSample>,
  frozen: ReadonlyArray<{ start: number; end: number }>,
  patchWidth: number,
  end: number,
): Array<VideoWindow> {
  const n = samples.length;
  const fps = n > 1 && end > 0 ? n / end : 30;
  const sigma = SMOOTH_SIGMA_S * fps;
  // Residual (shake) and smoothed velocity per frame, NaN where unknown.
  const residual = new Float64Array(n).fill(Number.NaN);
  const speed = new Float64Array(n).fill(Number.NaN);
  let i = 0;
  while (i < n) {
    // A run: frames i..j-1 whose motion against the previous frame is known (frame i is its start).
    if (samples[i + 1]?.dx === undefined) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && samples[j]!.dx !== undefined) j++;
    const len = j - i;
    const px = new Float64Array(len);
    const py = new Float64Array(len);
    for (let k = 1; k < len; k++) {
      px[k] = px[k - 1]! + samples[i + k]!.dx!;
      py[k] = py[k - 1]! + samples[i + k]!.dy!;
    }
    const sx = smooth(px, sigma);
    const sy = smooth(py, sigma);
    for (let k = 0; k < len; k++) {
      residual[i + k] = Math.hypot(px[k]! - sx[k]!, py[k]! - sy[k]!) / patchWidth;
      if (k > 0) {
        const dt = Math.max(1e-6, samples[i + k]!.time - samples[i + k - 1]!.time);
        speed[i + k] = Math.hypot(sx[k]! - sx[k - 1]!, sy[k]! - sy[k - 1]!) / patchWidth / dt;
      }
    }
    i = j;
  }
  const inFrozen = (t: number) => frozen.some((f) => t >= f.start && t < f.end);
  const seconds = Math.max(1, Math.ceil(end - 1e-6));
  const out: Array<VideoWindow> = [];
  let f = 0;
  for (let s = 0; s < seconds; s++) {
    const wEnd = Math.min(end, s + 1);
    let frames = 0;
    let tracked = 0;
    let jit = 0;
    let jitN = 0;
    let mot = 0;
    let motN = 0;
    let blur = 0;
    let blurN = 0;
    let bri = 0;
    let dark = 0;
    let bright = 0;
    let froz = 0;
    while (f < n && samples[f]!.time < wEnd) {
      const x = samples[f]!;
      frames++;
      if (x.dx !== undefined) tracked++;
      if (!Number.isNaN(residual[f]!)) {
        jit += residual[f]! ** 2;
        jitN++;
      }
      if (!Number.isNaN(speed[f]!)) {
        mot += speed[f]!;
        motN++;
      }
      if (x.blur !== undefined && Number.isFinite(x.blur)) {
        blur += x.blur;
        blurN++;
      }
      bri += x.brightness;
      dark += x.dark;
      bright += x.bright;
      if (inFrozen(x.time)) froz++;
      f++;
    }
    if (!frames) continue;
    out.push({
      start: s,
      end: round(wEnd, 3),
      frames,
      jitter: jitN ? round(Math.sqrt(jit / jitN), 5) : null,
      motion: motN ? round(mot / motN, 4) : null,
      tracked: round(tracked / Math.max(1, frames - (s === 0 ? 1 : 0)), 3),
      blur: blurN ? round(blur / blurN, 3) : null,
      brightness: round(bri / frames, 3),
      dark: round(dark / frames, 4),
      bright: round(bright / frames, 4),
      frozen: round(froz / frames, 3),
    });
  }
  return out;
}
