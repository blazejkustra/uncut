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
import { WINDOW, HOP, BAND_LOW, BAND_HIGH, SAMPLE_RATE, BANDS, LOW_HZ, PEAK_DECAY, ABS_FLOOR, RANGE_DB, MAX_S, FRAME_RATE, PRE_AVG_S, POST_AVG_S, MIN_GAP_S, DELTA, MIN_ONSETS, MIN_CONFIDENCE, timeoutFor } from "./beats/params.ts";
import { quantile, vertex, estimateTempo, trackBeats, bpmOf } from "./beats/tempo.ts";
export { SAMPLE_RATE, WINDOW, HOP, FRAME_RATE, MIN_BPM, MAX_BPM, MIN_CONFIDENCE, timeoutFor } from "./beats/params.ts";
export { estimateTempo, trackBeats, bpmOf } from "./beats/tempo.ts";

/** Bumped when the beats analyzer's output changes, so older cache files are redone. */
export const BEATS_VERSION = 1;

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
