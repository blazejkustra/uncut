// Tempo and beat tracking on the onset envelope (the beats analyzer, D70).
import { MAX_BPM, FRAME_RATE, MIN_BPM, COMB, PRIOR_BPM, PRIOR_OCTAVES, HALF_PULSE, TIGHTNESS } from "./params.ts";

/** A parabola through three values: the offset (−0.5…0.5) of its vertex from the middle one. */
export const vertex = (a: number, b: number, c: number) => {
  const d = a - 2 * b + c;
  return d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
};

export function quantile(values: ArrayLike<number>, q: number) {
  const sorted = Float64Array.from(values).sort();
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]! : 0;
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
  if ((60 * FRAME_RATE) / half.where <= MAX_BPM && distance(half.where) < distance(period) && half.top >= HALF_PULSE * peakNear(period).top)
    period = half.where;
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
  const med = quantile(
    maxima.map((i) => cum[i]!),
    0.5,
  );
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
