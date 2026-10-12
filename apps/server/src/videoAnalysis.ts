// The "video" analyzer (D67): one ffmpeg pass over the first video stream that isn't a cover
// picture (0:V:0: DJI files carry an mjpeg cover and data streams too), decoded with VideoToolbox
// where there is one, downscaled to 320 px wide grey. ffmpeg finds the scene cuts (scdet), the blur
// (blurdetect, printed per frame) and the frozen stretches (freezedetect) at 320 px, then hands
// every frame, scaled uniformly to cover 128×72 and centre-cropped, to Uncut as raw grey bytes on
// stdout. Here, per frame: the brightness and clipping (signalstats' job, done on those bytes since
// they're here anyway) and the camera's motion against the previous frame by phase correlation (a
// translation with sub-pixel peak, plus how sure it is). ffmpeg's deshake log only gives whole
// pixels at this size and its exhaustive search halves the speed, and vidstab isn't in brew's ffmpeg.
//
// The result keeps measurements, not scores, per second of the file (videoScores.ts turns them
// into stability, sharpness, exposure and a clean score, so tuning the scores needs no re-run).
import { execFile } from "node:child_process";

import { Cancelled, type Runner, spawnRunner } from "./analysisRunner.ts";
import { withoutApiKey } from "./shellEnv.ts";

/** Bumped when the video analyzer's output changes, so older cache files are redone. */
export const VIDEO_VERSION = 2;
/** ffmpeg's filters run at this width (grey). */
export const ANALYSIS_WIDTH = 320;
/**
 * Frames reach Uncut at this size, scaled uniformly (both axes by the same factor) to cover it and
 * cropped to the centre, so shake reads the same either way on any aspect (portrait included);
 * motion is measured on its centre MOTION_W × MOTION_H.
 */
export const RAW_W = 128;
export const RAW_H = 72;
export const MOTION_W = 128;
export const MOTION_H = 64;
/** scdet's threshold (0–100: how different a frame must be from the last to start a new shot). */
export const CUT_THRESHOLD = 10;
/** freezedetect: frames this close (dB of noise) for at least FREEZE_MIN_S are frozen. */
export const FREEZE_NOISE_DB = -60;
export const FREEZE_MIN_S = 0.5;
/**
 * scdet also fires on fast pans over busy ground (drone footage: scores 10–12 on a continuous
 * take). A cut is kept only if the frame can't be matched to the one before by a shift (its
 * phase-correlation peak is below CUT_MAX_MATCH; real cuts measure 0.07–0.22, those pans 0.69–0.98)
 * or scdet is sure (CUT_SURE). Known gap: a jump cut over the same background reads as no cut.
 */
export const CUT_MAX_MATCH = 0.4;
export const CUT_SURE = 40;
/** A gap longer than this many typical frame durations before a frame is dropped frames. */
export const DROP_GAP = 2.5;
/** A phase-correlation peak below this is no real match (a flat sky, a cut, noise). */
export const MIN_CONFIDENCE = 0.04;
const JOB_TIMEOUT_MS = 60 * 60_000;
/** A long file decoded in software can take a few times its length: the timeout grows with it. */
export const timeoutFor = (seconds: number | undefined) => Math.max(JOB_TIMEOUT_MS, Math.round((seconds ?? 0) * 4 * 1000));

// ---- results ----

/** One second of the file [start, end), measured. */
export interface VideoWindow {
  readonly start: number;
  readonly end: number;
  /** Frames in it. */
  readonly frames: number;
  /** Camera shake: RMS distance (fraction of the frame width) between the camera's path and its smoothed path. null: no frame pair in it could be matched. */
  readonly jitter: number | null;
  /** The smoothed path's speed (frame widths per second): how fast the camera pans or travels. */
  readonly motion: number | null;
  /** How many of its frame pairs could be matched (0–1). */
  readonly tracked: number;
  /** blurdetect's mean blur at 320 px (higher is blurrier, about the width of an edge in pixels). */
  readonly blur: number | null;
  /** Mean luma 0–1. */
  readonly brightness: number;
  /** Share of pixels near black (≤ 16/255). */
  readonly dark: number;
  /** Share of pixels near white (≥ 245/255). */
  readonly bright: number;
  /** Share of it inside frozen stretches. */
  readonly frozen: number;
}

export interface VideoResult {
  readonly hasVideo: boolean;
  /** Seconds of picture decoded. */
  readonly seconds?: number;
  readonly frames?: number;
  /** Frames per second measured (frames over seconds). */
  readonly fps?: number;
  readonly cutThreshold?: number;
  /** Gaps in the recording (dropped frames: the picture jumps): the first frame after each (seconds) and how long is missing. */
  readonly drops?: ReadonlyArray<{ readonly time: number; readonly missing: number }>;
  /** Where a new shot starts (seconds of the file, the first frame of the new shot) and scdet's score. */
  readonly cuts?: ReadonlyArray<{ readonly time: number; readonly score: number }>;
  /** Frozen stretches (seconds of the file). */
  readonly frozen?: ReadonlyArray<{ readonly start: number; readonly end: number }>;
  /** Per second of the file. */
  readonly windows?: ReadonlyArray<VideoWindow>;
}

export const NO_VIDEO: VideoResult = { hasVideo: false };

const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const finiteOrNull = (v: unknown) => v === null || finite(v);

/** Whether a cached value has the video result's shape. */
export function isVideoResult(value: unknown): value is VideoResult {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (typeof r.hasVideo !== "boolean") return false;
  if (!r.hasVideo) return true;
  if (!finite(r.seconds) || !finite(r.frames) || !Array.isArray(r.cuts) || !Array.isArray(r.drops) || !Array.isArray(r.frozen) || !Array.isArray(r.windows)) return false;
  if (!r.drops.every((d) => d && finite(d.time) && finite(d.missing))) return false;
  if (!r.cuts.every((c) => c && finite(c.time) && finite(c.score))) return false;
  if (!r.frozen.every((f) => f && finite(f.start) && finite(f.end))) return false;
  return r.windows.every(
    (w) => w && finite(w.start) && finite(w.end) && finite(w.frames) && finiteOrNull(w.jitter) && finiteOrNull(w.motion) && finite(w.tracked) && finiteOrNull(w.blur) && finite(w.brightness) && finite(w.dark) && finite(w.bright) && finite(w.frozen),
  );
}

// ---- ffmpeg ----

/** ffmpeg's arguments: raw 128×72 grey frames on stdout; progress, blur per frame, cuts and freezes on stderr. */
export const videoArgs = (path: string, hwaccel: boolean) => [
  "-hide_banner",
  "-nostdin",
  "-nostats",
  "-progress",
  "pipe:2",
  ...(hwaccel ? ["-hwaccel", "videotoolbox"] : []),
  "-i",
  path,
  // The first video stream that isn't an attached picture (a cover).
  "-map",
  "0:V:0",
  "-an",
  "-sn",
  "-dn",
  "-vf",
  [
    `scale=${ANALYSIS_WIDTH}:-2:flags=fast_bilinear`,
    "format=gray",
    `scdet=threshold=${CUT_THRESHOLD}`,
    `freezedetect=n=${FREEZE_NOISE_DB}dB:d=${FREEZE_MIN_S}`,
    "blurdetect",
    "metadata=mode=print:key=lavfi.blur",
    `scale=${RAW_W}:${RAW_H}:force_original_aspect_ratio=increase:flags=area`,
    `crop=${RAW_W}:${RAW_H}`,
  ].join(","),
  "-fps_mode",
  "passthrough",
  "-f",
  "rawvideo",
  "-pix_fmt",
  "gray",
  "pipe:1",
];

/** ffmpeg's ways of saying the file has no video stream for 0:v:0. */
const NO_VIDEO_STREAM = /matches no streams|does not contain any stream|Failed to set value '0:V:0' for option 'map'/i;

// Whether each ffmpeg can decode with VideoToolbox (asked once per binary).
const hwaccels = new Map<string, Promise<boolean>>();
const canVideotoolbox = (ffmpeg: string) => {
  let known = hwaccels.get(ffmpeg);
  if (!known) {
    known = new Promise((resolve) => execFile(ffmpeg, ["-hide_banner", "-hwaccels"], { timeout: 10_000, env: withoutApiKey(process.env) }, (error, stdout) => resolve(!error && /^videotoolbox$/m.test(String(stdout)))));
    hwaccels.set(ffmpeg, known);
  }
  return known;
};

/** Reads ffmpeg's stderr: blur per frame (with its time), scdet's cuts, freezedetect's stretches, progress. */
export class VideoLog {
  /** Frame index → its time (seconds) and blur. */
  readonly times: Array<number> = [];
  readonly blurs: Array<number> = [];
  readonly cuts: Array<{ time: number; score: number }> = [];
  readonly frozen: Array<{ start: number; end: number }> = [];
  private freezeStart: number | undefined;
  private frame = -1;
  duration: number | undefined;
  outTime = 0;
  /** The decoded picture's display size (rotation applied), from ffmpeg's dump of the input. */
  display: { width: number; height: number } | undefined;
  private input: "before" | "video" | "other" | "done" = "before";

  line(text: string) {
    // One "frame:" line per frame out of the graph. Its number restarts when the graph is rebuilt
    // (the resolution changes mid-file), so frames are counted here.
    let m = /\bframe:\s*\d+\s+pts:\s*\S+\s+pts_time:\s*(-?[\d.]+(?:e[-+]?\d+)?)/.exec(text);
    if (m) {
      this.frame++;
      this.times[this.frame] = Number(m[1]);
      return;
    }
    if (this.input !== "done") {
      if (/^(Output #|Stream mapping:)/.test(text.trim())) this.input = "done";
      else if (/^\s*Stream #0:/.test(text)) {
        const v = !this.display && /: Video: /.test(text) && !/\(attached pic\)/.test(text) ? /, (\d{2,5})x(\d{2,5})\b/.exec(text) : null;
        if (v) {
          const dar = /DAR (\d+):(\d+)/.exec(text);
          const w = Number(v[1]);
          const h = Number(v[2]);
          this.display = dar ? { width: Math.round((h * Number(dar[1])) / Number(dar[2])), height: h } : { width: w, height: h };
          this.input = "video";
        } else this.input = "other";
      } else if (this.input === "video" && (m = /rotation of (-?[\d.]+) degrees/i.exec(text))) {
        const quarter = Math.round(Number(m[1]) / 90) % 2 !== 0;
        if (quarter && this.display) this.display = { width: this.display.height, height: this.display.width };
      }
    }
    m = /\blavfi\.blur=\s*(-?[\d.]+(?:e[-+]?\d+)?|nan|-?inf)/i.exec(text);
    if (m) {
      if (this.frame >= 0) this.blurs[this.frame] = Number(m[1]);
      return;
    }
    m = /^out_time_us=(\d+)/.exec(text);
    if (m) {
      this.outTime = Number(m[1]) / 1e6;
      return;
    }
    m = /lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*(-?[\d.]+)/.exec(text);
    if (m) {
      this.cuts.push({ time: Number(m[2]), score: Number(m[1]) });
      return;
    }
    m = /lavfi\.freezedetect\.freeze_start:\s*(-?[\d.]+)/.exec(text);
    if (m) {
      this.freezeStart = Math.max(0, Number(m[1]));
      return;
    }
    m = /lavfi\.freezedetect\.freeze_end:\s*(-?[\d.]+)/.exec(text);
    if (m) {
      this.frozen.push({ start: this.freezeStart ?? 0, end: Number(m[1]) });
      this.freezeStart = undefined;
      return;
    }
    m = /^\s*Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text);
    if (m && this.duration === undefined) this.duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }

  /** A freeze still open at the end runs to `end`. */
  closeFreeze(end: number) {
    if (this.freezeStart !== undefined && end > this.freezeStart) this.frozen.push({ start: this.freezeStart, end });
    this.freezeStart = undefined;
  }
}

// ---- phase correlation ----

/** In-place radix-2 complex FFT of length n (a power of two) over re/im at offset, stride. */
function fft1(re: Float64Array, im: Float64Array, offset: number, stride: number, n: number, inverse: boolean, cos: Float64Array, sin: Float64Array) {
  // Bit reversal.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = offset + i * stride;
      const b = offset + j * stride;
      let t = re[a]!;
      re[a] = re[b]!;
      re[b] = t;
      t = im[a]!;
      im[a] = im[b]!;
      im[b] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]!;
        const wi = inverse ? sin[k * step]! : -sin[k * step]!;
        const a = offset + (i + k) * stride;
        const b = offset + (i + k + half) * stride;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
}

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
    const table = (n: number) => {
      const c = new Float64Array(n / 2);
      const s = new Float64Array(n / 2);
      for (let k = 0; k < n / 2; k++) {
        c[k] = Math.cos((2 * Math.PI * k) / n);
        s[k] = Math.sin((2 * Math.PI * k) / n);
      }
      return [c, s] as const;
    };
    [this.cosW, this.sinW] = table(w);
    [this.cosH, this.sinH] = table(h);
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

const round = (v: number, digits: number) => {
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
export function windowsOf(samples: ReadonlyArray<FrameSample>, frozen: ReadonlyArray<{ start: number; end: number }>, patchWidth: number, end: number): Array<VideoWindow> {
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

// ---- the analyzer ----

/** Brightness 0–1 and the shares of near-black and near-white pixels of a grey frame. */
function levels(frame: Uint8Array): { brightness: number; dark: number; bright: number } {
  let sum = 0;
  let dark = 0;
  let bright = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i]!;
    sum += v;
    if (v <= 16) dark++;
    else if (v >= 245) bright++;
  }
  return { brightness: sum / frame.length / 255, dark: dark / frame.length, bright: bright / frame.length };
}

const ffmpegError = (stderr: string) =>
  stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(size=|frame=|Press \[q\]|\[Parsed_metadata|[a-z_]+=)/.test(l))
    .slice(-3)
    .join(" ")
    .slice(0, 400);

/** Cuts, frozen stretches and per-second measurements of the first video stream of `path`. */
export async function analyzeVideo(
  ffmpeg: string,
  path: string,
  options: { readonly signal: AbortSignal; readonly runner?: Runner; readonly seconds?: number | undefined; readonly onProgress?: (fraction: number) => void; readonly hwaccel?: boolean },
): Promise<VideoResult> {
  const log = new VideoLog();
  const correlator = new PhaseCorrelator();
  const frameBytes = RAW_W * RAW_H;
  const pending = Buffer.alloc(frameBytes);
  let filled = 0;
  const motion: Array<{ dx: number; dy: number; peak: number } | undefined> = [];
  const lv: Array<{ brightness: number; dark: number; bright: number }> = [];
  const onFrame = (frame: Uint8Array) => {
    lv.push(levels(frame));
    motion.push(correlator.push(frame, RAW_W, RAW_H));
  };
  const runner = options.runner ?? spawnRunner;
  const hwaccel = options.hwaccel ?? (process.platform === "darwin" && (await canVideotoolbox(ffmpeg)));
  if (options.signal.aborted) throw new Cancelled();
  const r = await runner(ffmpeg, videoArgs(path, hwaccel), {
    signal: options.signal,
    timeoutMs: timeoutFor(options.seconds),
    onStderr: (line) => {
      log.line(line);
      if (line.startsWith("out_time_us=")) {
        const total = options.seconds ?? log.duration;
        if (total) options.onProgress?.(Math.min(0.99, log.outTime / total));
      }
    },
    onStdoutData: (chunk) => {
      let at = 0;
      while (at < chunk.length) {
        const take = Math.min(frameBytes - filled, chunk.length - at);
        chunk.copy(pending, filled, at, at + take);
        filled += take;
        at += take;
        if (filled === frameBytes) {
          onFrame(pending);
          filled = 0;
        }
      }
    },
  });
  if (r.code !== 0) {
    if (NO_VIDEO_STREAM.test(r.stderrTail)) return NO_VIDEO;
    throw new Error(`ffmpeg couldn't read the picture: ${ffmpegError(r.stderrTail) || `it exited with ${r.code}`}`);
  }
  const count = lv.length;
  if (!count) return NO_VIDEO;
  // Frame times from the blur lines; a frame missing one is placed after the last known.
  const times: Array<number> = [];
  const step = (options.seconds ?? log.duration ?? count / 30) / count;
  for (let i = 0; i < count; i++) {
    const t = log.times[i];
    times.push(t !== undefined && Number.isFinite(t) ? t : i ? times[i - 1]! + step : 0);
  }
  const last = times[count - 1]!;
  const frameDur = count > 1 ? (last - times[0]!) / (count - 1) : step;
  const end = Math.max(last + frameDur, log.outTime);
  log.closeFreeze(end);
  // Dropped frames (DJI files have them): a gap of more than DROP_GAP frames before a frame. The
  // picture jumps there, so it's neither a cut nor one frame's motion.
  const dts = times.slice(1).map((t, i) => t - times[i]!).filter((d) => d > 0).sort((x, y) => x - y);
  const typical = dts.length ? dts[dts.length >> 1]! : frameDur;
  const dropFrames = new Set<number>();
  const drops: Array<{ time: number; missing: number }> = [];
  for (let i = 1; i < count; i++) {
    const gap = times[i]! - times[i - 1]!;
    if (typical > 0 && gap > DROP_GAP * typical) {
      dropFrames.add(i);
      drops.push({ time: round(times[i]!, 4), missing: round(gap - typical, 4) });
    }
  }
  const cuts = log.cuts
    .filter((c) => {
      const at = nearestFrame(times, c.time);
      if (dropFrames.has(at)) return false;
      const m = motion[at];
      return c.score >= CUT_SURE || !m || m.peak < CUT_MAX_MATCH;
    })
    .map((c) => ({ time: round(c.time, 4), score: round(c.score, 2) }));
  // A pair across a cut or a gap, or with a weak peak, isn't camera motion.
  const cutFrames = new Set(cuts.map((c) => nearestFrame(times, c.time)));
  const samples: Array<FrameSample> = times.map((time, i) => {
    const m = motion[i];
    const ok = m && m.peak >= MIN_CONFIDENCE && !cutFrames.has(i) && !dropFrames.has(i);
    return { time, ...(ok ? { dx: m.dx, dy: m.dy } : {}), blur: log.blurs[i], ...lv[i]! };
  });
  const frozen = log.frozen.map((f) => ({ start: round(f.start, 4), end: round(Math.min(end, f.end), 4) })).filter((f) => f.end > f.start);
  return {
    hasVideo: true,
    seconds: round(end, 3),
    frames: count,
    fps: round(count / Math.max(1e-6, end - times[0]!), 3),
    cutThreshold: CUT_THRESHOLD,
    cuts,
    drops,
    frozen,
    // Shake in widths of the whole picture: it covers RAW_W × RAW_H, so it's RAW_W wide unless it's
    // wider than that box's aspect (then the sides were cropped).
    windows: windowsOf(samples, frozen, scaledWidth(log.display), end),
  };
}

/** The width (pixels of the raw frames) of the whole picture, scaled to cover RAW_W × RAW_H. */
export function scaledWidth(display: { width: number; height: number } | undefined): number {
  if (!display || display.width <= 0 || display.height <= 0) return RAW_W;
  return Math.max(RAW_W, (RAW_H * display.width) / display.height);
}

/** The index of the frame whose time is nearest `t` (times ascending). */
export function nearestFrame(times: ReadonlyArray<number>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1]! - t) <= Math.abs(times[lo]! - t)) return lo - 1;
  return lo;
}
