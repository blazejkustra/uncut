// The loudness analyzer (D66, D74): one ffmpeg pass for EBU R128 loudness, silences and the speech envelope.
import { type Runner, spawnRunner, NO_AUDIO_STREAM, ffmpegError } from "../analysisRunner.ts";
import { type StoredEnvelope, ENVELOPE_RATE, encodeEnvelope, decodeEnvelope } from "@uncut/core/transcript";

/** Silence: quieter than this (dBFS) ... */
export const SILENCE_DB = -40;
/** ... for at least this long (seconds). */
export const SILENCE_MIN_S = 0.3;
/** The speech envelope's decode (D74): mono 16-bit PCM at this rate, RMS per 1/ENVELOPE_RATE s. */
const ENVELOPE_PCM_RATE = 16000;
const JOB_TIMEOUT_MS = 30 * 60_000;

// ---- results ----

export interface SilenceRange {
  readonly start: number;
  readonly end: number;
}

/** What the loudness analyzer found, in seconds of the file. */
export interface LoudnessResult {
  readonly hasAudio: boolean;
  /** Seconds of sound decoded. */
  readonly seconds?: number;
  /** EBU R128 integrated loudness (LUFS); null when too short or silent to measure. */
  readonly integratedLufs?: number | null;
  /** Loudness range (LU). */
  readonly loudnessRangeLu?: number | null;
  /** True peak (dBTP). */
  readonly truePeakDbtp?: number | null;
  readonly silence?: { readonly thresholdDb: number; readonly minSeconds: number; readonly ranges: ReadonlyArray<SilenceRange> };
  /** The speech envelope (D74, version 2): RMS dBFS every 10 ms, quantised (core decodeEnvelope). */
  readonly envelope?: StoredEnvelope;
}

export const NO_AUDIO: LoudnessResult = { hasAudio: false };

// ---- the loudness analyzer ----

/**
 * ffmpeg's arguments, one pass over the first audio stream: the silences, the loudness summary and
 * progress on stderr; the sound as mono 16-bit PCM at ENVELOPE_PCM_RATE on stdout, for the speech
 * envelope (D74).
 */
export const loudnessArgs = (path: string) => [
  "-hide_banner",
  "-nostdin",
  "-nostats",
  "-progress",
  "pipe:2",
  "-i",
  path,
  "-filter_complex",
  `[0:a:0]asplit=2[m][e];[m]silencedetect=noise=${SILENCE_DB}dB:d=${SILENCE_MIN_S},ebur128=peak=true:framelog=quiet[mo];[e]aresample=${ENVELOPE_PCM_RATE},aformat=sample_fmts=s16:channel_layouts=mono[eo]`,
  "-map",
  "[mo]",
  "-f",
  "null",
  "-",
  "-map",
  "[eo]",
  "-f",
  "s16le",
  "-acodec",
  "pcm_s16le",
  "pipe:1",
];

/** RMS level (dBFS) of every 1/ENVELOPE_RATE s of mono s16le PCM at ENVELOPE_PCM_RATE. */
export class RmsEnvelope {
  private readonly per = ENVELOPE_PCM_RATE / ENVELOPE_RATE;
  private readonly db: Array<number> = [];
  private sum = 0;
  private count = 0;
  private carry: number | undefined;
  push(chunk: Buffer) {
    let i = 0;
    if (this.carry !== undefined && chunk.length) {
      this.add(Buffer.from([this.carry, chunk[0]!]).readInt16LE(0));
      this.carry = undefined;
      i = 1;
    }
    for (; i + 1 < chunk.length; i += 2) this.add(chunk.readInt16LE(i));
    if (i < chunk.length) this.carry = chunk[i];
  }
  private add(sample: number) {
    const x = sample / 32768;
    this.sum += x * x;
    if (++this.count === this.per) this.flush();
  }
  private flush() {
    if (this.count) this.db.push(10 * Math.log10(this.sum / this.count + 1e-12));
    this.sum = 0;
    this.count = 0;
  }
  finish(): StoredEnvelope {
    this.flush();
    return encodeEnvelope(this.db, ENVELOPE_RATE);
  }
}


const num = (s: string | undefined) => {
  const n = Number(s);
  return s === undefined || !Number.isFinite(n) ? null : n;
};
const ms = (s: number) => Math.round(s * 1000) / 1000;

/** Reads ffmpeg's stderr line by line: silencedetect's events and ebur128's summary. */
export class LoudnessLog {
  private open: number | undefined;
  private readonly ranges: Array<SilenceRange> = [];
  private summary = false;
  private section: "" | "i" | "lra" | "tp" | "other" = "";
  private integrated: number | null = null;
  private range: number | null = null;
  private peak: number | null = null;
  /** The input's duration from ffmpeg's header (seconds), if it said. */
  duration: number | undefined;

  line(text: string) {
    let m = /silence_start:\s*(-?[\d.]+(?:e[-+]?\d+)?)/i.exec(text);
    if (m) {
      this.open = Math.max(0, Number(m[1]));
      return;
    }
    m = /silence_end:\s*(-?[\d.]+(?:e[-+]?\d+)?)/i.exec(text);
    if (m) {
      this.ranges.push({ start: this.open ?? 0, end: Number(m[1]) });
      this.open = undefined;
      return;
    }
    if (/\bSummary:/.test(text)) {
      this.summary = true;
      return;
    }
    if (!this.summary) {
      m = /^\s*Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text);
      if (m && this.duration === undefined) this.duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      return;
    }
    if (/Integrated loudness:/.test(text)) this.section = "i";
    else if (/Loudness range:/.test(text)) this.section = "lra";
    else if (/True peak:/.test(text)) this.section = "tp";
    // ebur128 can also print a "Sample peak:" section, with its own "Peak:" line.
    else if (/^\s*\S[^:]*:\s*$/.test(text)) this.section = "other";
    else if (this.section === "i" && (m = /^\s*I:\s*(\S+)\s*LUFS/.exec(text))) this.integrated = num(m[1]);
    else if (this.section === "lra" && (m = /^\s*LRA:\s*(\S+)\s*LU\b/.exec(text))) this.range = num(m[1]);
    else if (this.section === "tp" && (m = /^\s*Peak:\s*(\S+)\s*dBFS/.exec(text))) this.peak = num(m[1]);
  }

  /** The result once ffmpeg is done; a silence still open runs to `end` (older ffmpeg doesn't close it at EOF). */
  finish(end: number | undefined, envelope?: StoredEnvelope): LoudnessResult {
    const ranges = [...this.ranges];
    if (this.open !== undefined && end !== undefined && end > this.open) ranges.push({ start: this.open, end });
    return {
      hasAudio: true,
      ...(end !== undefined ? { seconds: ms(end) } : {}),
      integratedLufs: this.integrated,
      loudnessRangeLu: this.range,
      truePeakDbtp: this.peak,
      silence: { thresholdDb: SILENCE_DB, minSeconds: SILENCE_MIN_S, ranges: ranges.map((r) => ({ start: ms(r.start), end: ms(r.end) })) },
      ...(envelope ? { envelope } : {}),
    };
  }
}


/** Loudness and silences of the first audio stream of `path`. */
export async function analyzeLoudness(
  ffmpeg: string,
  path: string,
  options: { readonly signal: AbortSignal; readonly runner?: Runner; readonly seconds?: number | undefined; readonly onProgress?: (fraction: number) => void },
): Promise<LoudnessResult> {
  const log = new LoudnessLog();
  const envelope = new RmsEnvelope();
  let decoded = 0;
  const runner = options.runner ?? spawnRunner;
  const r = await runner(ffmpeg, loudnessArgs(path), {
    signal: options.signal,
    timeoutMs: JOB_TIMEOUT_MS,
    onStderr: (line) => {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (!m) return log.line(line);
      decoded = Number(m[1]) / 1e6;
      const total = options.seconds ?? log.duration;
      if (total) options.onProgress?.(Math.min(0.99, decoded / total));
    },
    onStdoutData: (chunk) => envelope.push(chunk),
  });
  if (r.code !== 0) {
    if (NO_AUDIO_STREAM.test(r.stderrTail)) return NO_AUDIO;
    throw new Error(`ffmpeg couldn't read the sound: ${ffmpegError(r.stderrTail) || `it exited with ${r.code}`}`);
  }
  return log.finish(decoded > 0 ? decoded : (options.seconds ?? log.duration), envelope.finish());
}

const numOrNull = (v: unknown) => v === null || v === undefined || (typeof v === "number" && Number.isFinite(v));
/** Whether a cached value has the loudness result's shape (anything else is a miss, redone and rewritten). */
export function isResult(value: unknown): value is LoudnessResult {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (typeof r.hasAudio !== "boolean") return false;
  if (!r.hasAudio) return true;
  if (!numOrNull(r.seconds) || !numOrNull(r.integratedLufs) || !numOrNull(r.loudnessRangeLu) || !numOrNull(r.truePeakDbtp)) return false;
  const silence = r.silence as { thresholdDb?: unknown; minSeconds?: unknown; ranges?: unknown } | undefined;
  if (!silence || typeof silence !== "object" || typeof silence.thresholdDb !== "number" || typeof silence.minSeconds !== "number" || !Array.isArray(silence.ranges)) return false;
  if (r.envelope !== undefined && !decodeEnvelope(r.envelope)) return false;
  return silence.ranges.every((x) => x && typeof x === "object" && typeof (x as SilenceRange).start === "number" && typeof (x as SilenceRange).end === "number");
}
