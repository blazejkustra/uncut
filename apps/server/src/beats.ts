// The beats analyzer (D70): tempo, beats and onsets of the first audio stream, in TypeScript on the
// decoded PCM. ffmpeg decodes 0:a:0 the way the waveform does (mono 16-bit on stdout, analysisRunner.ts
// pcmArgs) at SAMPLE_RATE; the samples are streamed through a short-time Fourier transform as they
// arrive and only one number per hop is kept (the onset envelope, ~86 a second), so an hour of
// sound costs a few MB, not a gigabyte of float32.
//
// 1. Onsets: spectral flux. Each hop, a Hann-windowed WINDOW-sample frame's band magnitudes (40
//    mel bands), as logs above a floor RANGE_DB under the running peak, are compared with the
//    previous frame's; the rises (half-wave rectified) are summed over all bands and, separately,
//    over the low bands (kick, bass); the two envelopes, each in units of its own deviation, are
//    added. Peaks of that envelope above an adaptive threshold (the
//    local mean plus DELTA of its typical peak) and at least MIN_GAP apart are the onsets.
// 2. Tempo: the autocorrelation of the (mean-removed) envelope, summed over the first COMB
//    multiples of each beat period (a period whose multiples line up scores; double tempo, whose
//    every other multiple falls between beats, doesn't), weighted by a log-normal prior around
//    PRIOR_BPM (one octave wide) against half-tempo picks; MIN_BPM–MAX_BPM; the peak interpolated.
// 3. Beats: dynamic programming (Ellis 2007, as librosa does it): each frame's score is its onset
//    strength plus the best earlier beat's score, penalised by how far the gap is from the period
//    (TIGHTNESS · log²(gap/period)); traced back from the last strong frame; weak beats at either
//    end trimmed. Beat times are interpolated between frames.
// 4. bpm: a least-squares line through the beats (numbered by the period, so a skipped beat
//    doesn't bend it), which is much finer than one hop. confidence: the envelope's normalised
//    autocorrelation at the beat period (pulse clarity): ~1 for a click track, ~0 for speech/noise.
import { Cancelled, ffmpegError, NO_AUDIO_STREAM, pcmArgs, spawnRunner, type Runner } from "./analysisRunner.ts";
import { fft, fftTables } from "./fft.ts";

/** Bumped when the beats analyzer's output changes, so older cache files are redone. */
export const BEATS_VERSION = 1;
export const SAMPLE_RATE = 11025;
/** Samples per spectrogram frame (46 ms) and between frames (11.6 ms). */
export const WINDOW = 512;
export const HOP = 128;
/** Envelope frames per second. */
export const FRAME_RATE = SAMPLE_RATE / HOP;
export const MIN_BPM = 60;
export const MAX_BPM = 200;
const PRIOR_BPM = 120;
const PRIOR_OCTAVES = 1;
const COMB = 4;
const HALF_PULSE = 0.6;
const TIGHTNESS = 100;
/**
 * Log magnitudes are floored RANGE_DB below the loudest band magnitude lately (a running peak that
 * decays by PEAK_DECAY a frame, ~8 s half-life), and never below ABS_FLOOR (about −72 dB under a
 * full-scale sine's band): a hit after digital silence would otherwise rise from log(0), so a
 * quiet hat measured nearly as big as a kick (and the first hit came ~20 ms early).
 */
const RANGE_DB = 35;
const PEAK_DECAY = 0.999;
const ABS_FLOOR = 0.03;
/** The low bands' flux (below LOW_HZ: kicks, bass) is a second envelope, added with the same weight as the full one. */
const LOW_HZ = 200;
/** Spectral flux is summed over this many mel bands between BAND_LOW and BAND_HIGH Hz. */
const BANDS = 40;
const BAND_LOW = 30;
const BAND_HIGH = 5000;
/** Onset picking: a peak must be the maximum within ±MAX_S, above the mean over [−PRE_AVG_S, +POST_AVG_S] plus DELTA × the typical peak, and MIN_GAP_S after the last onset. */
const MAX_S = 0.03;
const PRE_AVG_S = 0.1;
const POST_AVG_S = 0.07;
const DELTA = 0.07;
const MIN_GAP_S = 0.03;
/** Below this pulse clarity (or with fewer onsets than MIN_ONSETS) there's no beat to speak of: bpm null, no beats. */
export const MIN_CONFIDENCE = 0.15;
const MIN_ONSETS = 4;
const JOB_TIMEOUT_MS = 30 * 60_000;
export const timeoutFor = (seconds: number | undefined) => Math.max(JOB_TIMEOUT_MS, Math.round((seconds ?? 0) * 4 * 1000));

export interface Onset {
  /** Seconds of the file. */
  readonly t: number;
  /** 0–1, relative to the file's strong onsets. */
  readonly strength: number;
}

/** What the beats analyzer found, in seconds of the file. */
export interface BeatsResult {
  readonly hasAudio: boolean;
  readonly seconds?: number;
  /** Beats per minute, or null when there's no steady beat (speech, silence). */
  readonly bpm?: number | null;
  /** How clear the pulse is, 0–1. */
  readonly confidence?: number;
  /** Beat times (seconds), in order. */
  readonly beats?: ReadonlyArray<number>;
  readonly onsets?: ReadonlyArray<Onset>;
}

export const NO_BEATS_AUDIO: BeatsResult = { hasAudio: false };

const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
/** Whether a cached value has the beats result's shape (anything else is a miss, redone and rewritten). */
export function isBeatsResult(value: unknown): value is BeatsResult {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (typeof r.hasAudio !== "boolean") return false;
  if (!r.hasAudio) return true;
  if (!finite(r.seconds) || !(r.bpm === null || finite(r.bpm)) || !finite(r.confidence)) return false;
  if (!Array.isArray(r.beats) || !r.beats.every(finite)) return false;
  return Array.isArray(r.onsets) && r.onsets.every((o) => o && typeof o === "object" && finite((o as Onset).t) && finite((o as Onset).strength));
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * The onset envelope of a stream of mono samples: push 16-bit PCM (any chunking, odd bytes
 * carried) or floats, then `finish`. Holds one window of samples and the envelope only.
 */
/** The standard deviation of the values. */
function deviation(a: Float32Array) {
  let mean = 0;
  for (let i = 0; i < a.length; i++) mean += a[i]!;
  mean /= a.length || 1;
  let v = 0;
  for (let i = 0; i < a.length; i++) v += (a[i]! - mean) ** 2;
  return Math.sqrt(v / (a.length || 1));
}

export class OnsetEnvelope {
  private readonly ring = new Float64Array(WINDOW);
  /** Samples written to the ring so far (the first WINDOW/2 are zeros: frame k is centred on sample k·HOP). */
  private written = WINDOW / 2;
  private sinceFrame = HOP - WINDOW / 2;
  private readonly hann = new Float64Array(WINDOW);
  private readonly re = new Float64Array(WINDOW);
  private readonly im = new Float64Array(WINDOW);
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  /** Each FFT bin's band (−1: outside BAND_LOW–BAND_HIGH). */
  private readonly bandOf = new Int16Array(WINDOW / 2 + 1);
  private readonly bands: number;
  private prev: Float64Array;
  private cur: Float64Array;
  private env = new Float32Array(4096);
  private low = new Float32Array(4096);
  private lowBands = 0;
  private peak = 0;
  private frames = 0;
  private carry: number | undefined;
  /** Samples pushed (not counting the leading zeros). */
  samples = 0;

  constructor() {
    for (let i = 0; i < WINDOW; i++) this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW);
    [this.cos, this.sin] = fftTables(WINDOW);
    // Mel-spaced bands, so a kick's few low bins count as much as a snare's many high ones.
    const mel = (f: number) => 2595 * Math.log10(1 + f / 700);
    const lo = mel(BAND_LOW);
    const hi = mel(BAND_HIGH);
    let last = -1;
    let count = 0;
    for (let k = 0; k <= WINDOW / 2; k++) {
      const f = (k * SAMPLE_RATE) / WINDOW;
      if (f < BAND_LOW || f > BAND_HIGH) {
        this.bandOf[k] = -1;
        continue;
      }
      const band = Math.min(BANDS - 1, Math.floor(((mel(f) - lo) / (hi - lo)) * BANDS));
      // Bands too narrow to hold a bin are skipped: band numbers stay dense.
      if (band !== last) {
        last = band;
        count++;
      }
      this.bandOf[k] = count - 1;
    }
    this.bands = count;
    for (let k = 0; k <= WINDOW / 2; k++) if (this.bandOf[k]! >= 0 && (k * SAMPLE_RATE) / WINDOW < LOW_HZ) this.lowBands = this.bandOf[k]! + 1;
    this.prev = new Float64Array(count);
    this.cur = new Float64Array(count);
  }

  pushPcm(chunk: Uint8Array) {
    let i = 0;
    if (this.carry !== undefined && chunk.length > 0) {
      this.sample((((this.carry | (chunk[0]! << 8)) << 16) >> 16) / 32768);
      this.carry = undefined;
      i = 1;
    }
    for (; i + 1 < chunk.length; i += 2) this.sample((((chunk[i]! | (chunk[i + 1]! << 8)) << 16) >> 16) / 32768);
    if (i < chunk.length) this.carry = chunk[i]!;
  }

  pushFloats(samples: ArrayLike<number>) {
    for (let i = 0; i < samples.length; i++) this.sample(samples[i]!);
  }

  private sample(v: number) {
    this.ring[this.written % WINDOW] = v;
    this.written++;
    this.samples++;
    if (++this.sinceFrame >= HOP && this.written >= WINDOW) {
      this.sinceFrame = 0;
      this.frame();
    }
  }

  private frame() {
    const { re, im, ring, hann } = this;
    // The last WINDOW samples, oldest first.
    const start = this.written % WINDOW;
    for (let i = 0; i < WINDOW; i++) {
      re[i] = ring[(start + i) % WINDOW]! * hann[i]!;
      im[i] = 0;
    }
    fft(re, im, 0, 1, WINDOW, false, this.cos, this.sin);
    const cur = this.cur;
    const prev = this.prev;
    const { bandOf, bands } = this;
    cur.fill(0, 0, bands);
    for (let k = 1; k <= WINDOW / 2; k++) {
      const b = bandOf[k]!;
      if (b >= 0) cur[b] = cur[b]! + Math.hypot(re[k]!, im[k]!);
    }
    let flux = 0;
    let lowFlux = 0;
    let top = 0;
    for (let b = 0; b < bands; b++) if (cur[b]! > top) top = cur[b]!;
    this.peak = Math.max(top, this.peak * PEAK_DECAY);
    const floor = Math.max(ABS_FLOOR, this.peak * Math.pow(10, -RANGE_DB / 20));
    for (let b = 0; b < bands; b++) {
      const m = Math.log(Math.max(cur[b]!, floor) / floor);
      cur[b] = m;
      const d = m - prev[b]!;
      if (d > 0) {
        flux += d;
        if (b < this.lowBands) lowFlux += d;
      }
    }
    // The first frame has nothing before it: sound that's already there isn't an onset.
    if (this.frames === 0) flux = lowFlux = 0;
    this.cur = prev;
    this.prev = cur;
    if (this.frames === this.env.length) {
      const grown = new Float32Array(this.env.length * 2);
      grown.set(this.env);
      this.env = grown;
      const g2 = new Float32Array(this.low.length * 2);
      g2.set(this.low);
      this.low = g2;
    }
    this.low[this.frames] = lowFlux;
    this.env[this.frames++] = flux;
  }

  /** The envelope: one value per HOP samples, frame k centred at k·HOP/SAMPLE_RATE s. */
  finish(): Float32Array {
    // Flush the tail with silence so the last sounds get their frames.
    for (let i = 0; i < WINDOW / 2; i++) {
      this.ring[this.written % WINDOW] = 0;
      this.written++;
      if (++this.sinceFrame >= HOP && this.written >= WINDOW) {
        this.sinceFrame = 0;
        this.frame();
      }
    }
    // The full and the low envelope, each in units of its own standard deviation, summed (in place).
    const env = this.env.subarray(0, this.frames);
    const low = this.low.subarray(0, this.frames);
    const se = deviation(env);
    const sl = deviation(low);
    for (let i = 0; i < env.length; i++) env[i] = (se ? env[i]! / se : 0) + (sl ? low[i]! / sl : 0);
    return env;
  }
}

/**
 * A small shift for where the flux of a Hann frame peaks against the attack: clicks measured
 * 0 ms, drums and soft tones −4 ms on average (review fixes, D70), so +3 ms splits them.
 */
export const ONSET_LAG_S = 0.003;
/** Time (s) of envelope frame `f` (fractional frames allowed). */
const timeOf = (f: number) => (f * HOP) / SAMPLE_RATE + ONSET_LAG_S;

/** A parabola through three values: the offset (−0.5…0.5) of its vertex from the middle one. */
const vertex = (a: number, b: number, c: number) => {
  const d = a - 2 * b + c;
  return d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
};

function quantile(values: ArrayLike<number>, q: number) {
  const sorted = Float64Array.from(values).sort();
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]! : 0;
}

/** Onsets: local maxima above an adaptive threshold, at least MIN_GAP_S apart. */
export function pickOnsets(env: Float32Array): Array<Onset> {
  const n = env.length;
  const w = Math.max(1, Math.round(MAX_S * FRAME_RATE));
  const pre = Math.round(PRE_AVG_S * FRAME_RATE);
  const post = Math.round(POST_AVG_S * FRAME_RATE);
  const gap = Math.round(MIN_GAP_S * FRAME_RATE);
  // Local maxima first: their typical height sets the threshold's scale and the strengths.
  const peaks: Array<number> = [];
  for (let i = 0; i < n; i++) {
    const v = env[i]!;
    if (v <= 0) continue;
    let max = true;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w) && max; j++) if (env[j]! > v || (env[j] === v && j < i)) max = false;
    if (max) peaks.push(i);
  }
  if (!peaks.length) return [];
  const heights = peaks.map((i) => env[i]!);
  const scale = quantile(heights, 0.95) || Math.max(...heights);
  // Prefix sums for the moving mean.
  const sums = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sums[i + 1] = sums[i]! + env[i]!;
  const out: Array<Onset> = [];
  let last = -Infinity;
  for (const i of peaks) {
    const a = Math.max(0, i - pre);
    const b = Math.min(n, i + post + 1);
    const mean = (sums[b]! - sums[a]!) / (b - a);
    if (env[i]! < mean + DELTA * scale || i - last < gap) continue;
    last = i;
    const at = i > 0 && i < n - 1 ? i + vertex(env[i - 1]!, env[i]!, env[i + 1]!) : i;
    out.push({ t: r3(Math.max(0, timeOf(at))), strength: Math.round(Math.min(1, env[i]! / scale) * 1000) / 1000 });
  }
  return out;
}

/** The autocorrelation of `x` at lags 0…maxLag. */
function autocorrelation(x: Float64Array, maxLag: number) {
  const n = x.length;
  const ac = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= Math.min(maxLag, n - 1); lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += x[i]! * x[i - lag]!;
    ac[lag] = s;
  }
  return ac;
}

/** Linear interpolation into `a` at a fractional index. */
const at = (a: Float64Array, x: number) => {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= a.length) return i >= 0 && i < a.length ? a[i]! : 0;
  return a[i]! + (a[i + 1]! - a[i]!) * (x - i);
};

/** The beat period (envelope frames) and the pulse clarity there, from the mean-removed envelope. */
export function estimateTempo(env: Float32Array): { period: number; clarity: number } | undefined {
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i]!;
  mean /= n || 1;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = env[i]! - mean;
  const minLag = Math.floor((60 / MAX_BPM) * FRAME_RATE);
  const maxLag = Math.ceil((60 / MIN_BPM) * FRAME_RATE);
  const ac = autocorrelation(x, maxLag * COMB + 1);
  if (!(ac[0]! > 0)) return undefined;
  const score = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    // Multiples weigh less the further out they are (1/k): a slower period's multiples are all
    // the faster one's even multiples, so equal weights would favour half tempo whenever every
    // other beat is louder (kick, snare, kick, snare).
    let s = 0;
    for (let k = 1; k <= COMB; k++) s += Math.max(0, at(ac, lag * k)) / k;
    const bpm = (60 * FRAME_RATE) / lag;
    const octaves = Math.log2(bpm / PRIOR_BPM) / PRIOR_OCTAVES;
    score[lag] = s * Math.exp(-0.5 * octaves * octaves);
  }
  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (score[lag]! > score[best]!) best = lag;
  if (!(score[best]! > 0)) return undefined;
  let period = best > minLag && best < maxLag ? best + vertex(score[best - 1]!, score[best]!, score[best + 1]!) : best;
  // The autocorrelation's own peak within ±2 lags of a (fractional) lag.
  const peakNear = (lag: number) => {
    let top = 0;
    let where = lag;
    for (let l = Math.max(1, Math.floor(lag) - 2); l <= Math.min(ac.length - 2, Math.ceil(lag) + 2); l++) {
      if (ac[l]! > top && ac[l]! >= ac[l - 1]! && ac[l]! >= ac[l + 1]!) {
        top = ac[l]!;
        where = l + vertex(ac[l - 1]!, ac[l]!, ac[l + 1]!);
      }
    }
    return { top, where };
  };
  // Metrical level: when every other beat is much louder (kick, snare), half tempo can win. Take
  // double the tempo instead when it's still in range, nearer PRIOR_BPM, and its own pulse is at
  // least HALF_PULSE of this one's (a click track has nothing between its beats: it stays; eighth hats
  // after the floored log stay under it).
  const distance = (lag: number) => Math.abs(Math.log2((60 * FRAME_RATE) / lag / PRIOR_BPM));
  const half = peakNear(period / 2);
  if ((60 * FRAME_RATE) / half.where <= MAX_BPM && distance(half.where) < distance(period) && half.top >= HALF_PULSE * peakNear(period).top) period = half.where;
  // Pulse clarity at the period itself.
  const peak = Math.max(peakNear(period).top, at(ac, period));
  return { period, clarity: Math.max(0, Math.min(1, peak / ac[0]!)) };
}

/** Beat frames (fractional) by dynamic programming over the envelope for a beat period (frames). */
export function trackBeats(env: Float32Array, period: number): Array<number> {
  const n = env.length;
  if (!n) return [];
  // Normalise the onsets by their standard deviation, then smooth them with a narrow Gaussian.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i]!;
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (env[i]! - mean) ** 2;
  const std = Math.sqrt(variance / n) || 1;
  const sigma = Math.max(0.5, period / 32);
  const half = Math.ceil(sigma * 3);
  const kernel = new Float64Array(2 * half + 1);
  let ksum = 0;
  for (let i = -half; i <= half; i++) ksum += kernel[i + half] = Math.exp(-0.5 * (i / sigma) ** 2);
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -half; j <= half; j++) {
      const k = i + j;
      if (k >= 0 && k < n) s += env[k]! * kernel[j + half]!;
    }
    local[i] = s / ksum / std;
  }
  // The DP: the best predecessor 2·period … period/2 back.
  const lo = Math.round(period / 2);
  const hi = Math.round(2 * period);
  const penalty = new Float64Array(hi + 1);
  for (let gap = lo; gap <= hi; gap++) penalty[gap] = -TIGHTNESS * Math.log(gap / period) ** 2;
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  let first = true;
  const threshold = 0.01 * Math.max(...local.subarray(0, Math.min(n, Math.ceil(hi * 4))));
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let from = -1;
    for (let gap = lo; gap <= hi && i - gap >= 0; gap++) {
      const v = cum[i - gap]! + penalty[gap]!;
      if (v > best) {
        best = v;
        from = i - gap;
      }
    }
    // Before the first real onset there's nothing to chain to: a beat starts the chain.
    // No predecessor worth chaining to (it would cost more than it adds): a chain starts here.
    if (from < 0 || best <= 0 || (first && local[i]! < threshold)) {
      cum[i] = local[i]!;
      back[i] = -1;
    } else {
      cum[i] = local[i]! + best;
      back[i] = from;
    }
    if (local[i]! >= threshold) first = false;
  }
  // The last beat: the last local maximum of the cumulative score above half their median.
  const maxima: Array<number> = [];
  for (let i = 1; i < n - 1; i++) if (cum[i]! > cum[i - 1]! && cum[i]! >= cum[i + 1]!) maxima.push(i);
  if (!maxima.length) return [];
  const med = quantile(maxima.map((i) => cum[i]!), 0.5);
  let last = maxima[maxima.length - 1]!;
  for (let k = maxima.length - 1; k >= 0; k--) {
    if (cum[maxima[k]!]! >= 0.5 * med) {
      last = maxima[k]!;
      break;
    }
  }
  const beats: Array<number> = [];
  for (let i = last; i >= 0; i = back[i]!) beats.push(i);
  beats.reverse();
  // Trim weak beats at both ends (silence before and after the music).
  let rms = 0;
  for (const b of beats) rms += local[b]! ** 2;
  rms = Math.sqrt(rms / beats.length);
  let a = 0;
  let b = beats.length;
  while (a < b && local[beats[a]!]! < 0.5 * rms) a++;
  while (b > a && local[beats[b - 1]!]! < 0.5 * rms) b--;
  return beats.slice(a, b).map((f) => (f > 0 && f < n - 1 ? f + vertex(local[f - 1]!, local[f]!, local[f + 1]!) : f));
}

/** bpm from beat times: a least-squares line through them, numbered by the median gap. */
export function bpmOf(beats: ReadonlyArray<number>, fallback: number): number {
  if (beats.length < 4) return fallback;
  const gaps = beats.slice(1).map((t, i) => t - beats[i]!);
  const med = quantile(gaps, 0.5);
  if (!(med > 0)) return fallback;
  const idx = [0];
  for (let i = 1; i < beats.length; i++) idx.push(idx[i - 1]! + Math.max(1, Math.round(gaps[i - 1]! / med)));
  const m = beats.length;
  const mx = idx.reduce((s, v) => s + v, 0) / m;
  const my = beats.reduce((s, v) => s + v, 0) / m;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < m; i++) {
    sxy += (idx[i]! - mx) * (beats[i]! - my);
    sxx += (idx[i]! - mx) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : med;
  return slope > 0 ? 60 / slope : fallback;
}

/** Tempo, beats and onsets from an onset envelope (pure: the tests feed it synthetic sound). */
export function beatsFromEnvelope(env: Float32Array, seconds: number): BeatsResult {
  const onsets = pickOnsets(env);
  const tempo = onsets.length >= MIN_ONSETS ? estimateTempo(env) : undefined;
  if (!tempo || tempo.clarity < MIN_CONFIDENCE) return { hasAudio: true, seconds: r3(seconds), bpm: null, confidence: Math.round((tempo?.clarity ?? 0) * 100) / 100, beats: [], onsets };
  const beats = trackBeats(env, tempo.period).map((f) => Math.max(0, timeOf(f)));
  const bpm = bpmOf(beats, (60 * FRAME_RATE) / tempo.period);
  return { hasAudio: true, seconds: r3(seconds), bpm: Math.round(bpm * 100) / 100, confidence: Math.round(tempo.clarity * 100) / 100, beats: beats.map(r3), onsets };
}

/** The same from mono float samples at SAMPLE_RATE. */
export function beatsFromSamples(samples: ArrayLike<number>): BeatsResult {
  const envelope = new OnsetEnvelope();
  envelope.pushFloats(samples);
  return beatsFromEnvelope(envelope.finish(), samples.length / SAMPLE_RATE);
}

/** ffmpeg's arguments: progress on stderr, the first audio stream as mono PCM on stdout (the waveform's decode, at SAMPLE_RATE). */
export const beatsArgs = (path: string) => ["-hide_banner", "-nostdin", "-nostats", "-progress", "pipe:2", ...pcmArgs(path, SAMPLE_RATE)];

/** Tempo, beats and onsets of the first audio stream of `path`. */
export async function analyzeBeats(
  ffmpeg: string,
  path: string,
  options: { readonly signal: AbortSignal; readonly runner?: Runner; readonly seconds?: number | undefined; readonly onProgress?: (fraction: number) => void },
): Promise<BeatsResult> {
  const envelope = new OnsetEnvelope();
  let duration: number | undefined;
  const runner = options.runner ?? spawnRunner;
  if (options.signal.aborted) throw new Cancelled();
  const r = await runner(ffmpeg, beatsArgs(path), {
    signal: options.signal,
    timeoutMs: timeoutFor(options.seconds),
    onStderr: (line) => {
      const d = /^\s*Duration:\s*(\d+):(\d+):([\d.]+)/.exec(line);
      if (d && duration === undefined) duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
      const m = /^out_time_us=(\d+)/.exec(line);
      const total = options.seconds ?? duration;
      if (m && total) options.onProgress?.(Math.min(0.99, Number(m[1]) / 1e6 / total));
    },
    onStdoutData: (chunk) => envelope.pushPcm(chunk),
  });
  if (r.code !== 0) {
    if (NO_AUDIO_STREAM.test(r.stderrTail)) return NO_BEATS_AUDIO;
    throw new Error(`ffmpeg couldn't read the sound: ${ffmpegError(r.stderrTail) || `it exited with ${r.code}`}`);
  }
  if (options.signal.aborted) throw new Cancelled();
  const seconds = envelope.samples / SAMPLE_RATE;
  return beatsFromEnvelope(envelope.finish(), seconds);
}
