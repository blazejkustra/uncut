// Media analysis (D66): analyzers run as server jobs per (media, analyzer), on demand only (the
// agent's media_analyze or the Library's Analyze button), a few at a time, and never start while
// an export is queued or running (D55). Results are cached by the file's content, not its path:
// <project>/.cache/analysis/<fingerprint>/<analyzer>.json, where the fingerprint is the file's size
// and three 1 MB samples (start, middle, end) hashed. So a renamed or moved file reuses its results
// and a changed one doesn't. .cache is disposable (D12). A cache file is written aside and renamed
// once the analyzer has finished; a cancelled or failed job writes nothing (not even the folder).
//
// The first analyzer, "loudness", is one ffmpeg pass over the first audio stream (0:a:0: DJI files
// carry mjpeg cover and data streams too): EBU R128 loudness (integrated, range, true peak) from
// ebur128 and the silences from silencedetect (below SILENCE_DB for at least SILENCE_MIN_S), and in
// the same pass the speech envelope (RMS every 10 ms, D74) from a 16 kHz mono decode on stdout.
// The second, "video" (videoAnalysis.ts, D67), is one pass over the first video stream: cuts,
// shake, blur, brightness and frozen stretches per second of the file.
// The third, "transcript" (transcription.ts, D68), transcribes the speech with whisper.cpp; at most
// one runs at a time (it keeps the GPU busy), after its speech model is there (downloaded first).
// The fourth, "beats" (beats.ts, D70), finds the tempo, beats and onsets of the first audio stream
// in TypeScript on PCM decoded like the waveform's.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { AnalysisError, type AnalysisJob, type Analyzer } from "@uncut/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { analyzeBeats, BEATS_VERSION, isBeatsResult, NO_BEATS_AUDIO, type BeatsResult } from "./beats.ts";
import { Cancelled, ffmpegError, NO_AUDIO_STREAM, spawnRunner, type Runner } from "./analysisRunner.ts";
import { writeAtomic } from "../project/atomicWrite.ts";
import { ServerConfig } from "../app/config.ts";
import { Exporter } from "../export/exporter.ts";
import { Projects } from "../project/projects.ts";
import { which } from "../app/setup.ts";
import { decodeEnvelope, encodeEnvelope, ENVELOPE_RATE, type StoredEnvelope } from "@uncut/core/transcript";
import { analyzeTranscript, isTranscriptResult, NO_SPEECH_AUDIO, TRANSCRIPT_VERSION, type TranscriptResult } from "./transcription.ts";
import { analyzeVideo, isVideoResult, NO_VIDEO, VIDEO_VERSION, type VideoResult } from "./videoAnalysis.ts";
import { Whisper, type ResolveWhisper } from "./whisper.ts";

/** Silence: quieter than this (dBFS) ... */
export const SILENCE_DB = -40;
/** ... for at least this long (seconds). */
export const SILENCE_MIN_S = 0.3;
export const ANALYSIS_FORMAT = "uncut.analysis/0";
/** Bumped when the loudness analyzer's output changes, so older cache files are redone. */
export const LOUDNESS_VERSION = 2;
/** The speech envelope's decode (D74): mono 16-bit PCM at this rate, RMS per 1/ENVELOPE_RATE s. */
const ENVELOPE_PCM_RATE = 16000;
/** Bytes per fingerprint sample. */
export const SAMPLE_BYTES = 1 << 20;
const CONCURRENCY = 2;
const JOB_TIMEOUT_MS = 30 * 60_000;
const MAX_JOBS_KEPT = 20;

/** Analyzers the agent's spec names (spec/agent/tools.json) that come with later chunks. */
export const LATER_ANALYZERS: Readonly<Record<string, string>> = {
  description: "descriptions",
};

export const analysisDir = (projectDir: string) => join(projectDir, ".cache", "analysis");
export const cacheFile = (projectDir: string, fingerprint: string, analyzer: Analyzer) => join(analysisDir(projectDir), fingerprint, `${analyzer}.json`);

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
export type AnalysisResult = LoudnessResult | VideoResult | TranscriptResult | BeatsResult;

export const NO_AUDIO: LoudnessResult = { hasAudio: false };

/** Names that mean the same job: one pass finds both silences and loudness, or all of the picture's signals. */
export const ANALYZER_ALIASES: Readonly<Record<string, Analyzer>> = { loudness: "loudness", silence: "loudness", video: "video", shots: "video", motion: "video", stability: "video", transcript: "transcript", transcription: "transcript", beats: "beats", rhythm: "beats", onsets: "beats", tempo: "beats" };
const AVAILABLE = `Available now: loudness (also gives the silences; "silence" means the same), video (cuts, shake, blur, exposure and frozen stretches; "shots", "motion" and "stability" mean the same) transcript (the speech, transcribed on this Mac) and beats (tempo, beats and onsets; "rhythm", "onsets" and "tempo" mean the same).`;

/**
 * Which analyzers a request means: none named = loudness (cheap, ~400× realtime; video is opt-in,
 * named or through media_rank, since it takes about a minute on a long 4K clip and would hold the
 * queue); "silence" is the loudness job (one pass finds both), "shots", "motion" and "stability"
 * the video job. Later ones and unknown names are refused with a sentence.
 */
export function parseAnalyzers(value: unknown): { readonly analyzers: ReadonlyArray<Analyzer> } | { readonly refused: string } {
  if (value === undefined) return { analyzers: ["loudness"] };
  if (!Array.isArray(value) || !value.length || !value.every((v) => typeof v === "string")) return { refused: `analyzers must be a non-empty list, e.g. ["loudness"].` };
  const out = new Set<Analyzer>();
  for (const name of value as Array<string>) {
    const alias = Object.hasOwn(ANALYZER_ALIASES, name) ? ANALYZER_ALIASES[name] : undefined;
    if (alias) out.add(alias);
    else if (Object.hasOwn(LATER_ANALYZERS, name)) return { refused: `${name} (${LATER_ANALYZERS[name]}) isn't available yet. ${AVAILABLE}` };
    else return { refused: `There's no analyzer "${name}". ${AVAILABLE}` };
  }
  return { analyzers: [...out] };
}

// ---- fingerprint ----

/**
 * The file's identity for the cache: its size and three 1 MB samples (start, middle, end), hashed
 * (SHA-256, 32 hex digits). Not the path or the modification time, so a renamed, moved or copied
 * file keeps its results. A change that keeps the size and touches none of the samples goes
 * unnoticed (camera files don't get edited in place).
 */
export async function fingerprint(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`${path} isn't a file.`);
    const size = info.size;
    const hash = createHash("sha256").update(`uncut-fingerprint/1\0${size}\0`);
    const length = Math.min(SAMPLE_BYTES, size);
    const buffer = Buffer.alloc(length);
    for (const at of [0, Math.max(0, Math.floor(size / 2) - Math.floor(SAMPLE_BYTES / 2)), Math.max(0, size - SAMPLE_BYTES)]) {
      const { bytesRead } = await file.read(buffer, 0, length, at);
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex").slice(0, 32);
  } finally {
    await file.close();
  }
}

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

// ---- running ffmpeg ----

export { Cancelled, spawnRunner, type RunOptions, type Runner } from "./analysisRunner.ts";


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

// ---- the cache ----

interface CacheFile {
  readonly format: string;
  readonly analyzer: Analyzer;
  readonly version: number;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly result: AnalysisResult;
}

const VERSIONS: Readonly<Record<Analyzer, number>> = { loudness: LOUDNESS_VERSION, video: VIDEO_VERSION, transcript: TRANSCRIPT_VERSION, beats: BEATS_VERSION };
const versionOf = (analyzer: Analyzer) => VERSIONS[analyzer];
const SHAPES: Readonly<Record<Analyzer, (result: unknown) => boolean>> = { loudness: isResult, video: isVideoResult, transcript: isTranscriptResult, beats: isBeatsResult };
const shapeOk = (analyzer: Analyzer, result: unknown) => SHAPES[analyzer](result);

/** A cached result for this content and analyzer (and the analyzer's current version), if any. */
export async function readCached(projectDir: string, fp: string, analyzer: Analyzer): Promise<AnalysisResult | undefined> {
  try {
    const file = JSON.parse(await readFile(cacheFile(projectDir, fp, analyzer), "utf8")) as CacheFile;
    if (file.format !== ANALYSIS_FORMAT || file.analyzer !== analyzer || file.version !== versionOf(analyzer) || file.fingerprint !== fp) return undefined;
    return shapeOk(analyzer, file.result) ? file.result : undefined;
  } catch {
    return undefined;
  }
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

/** A cached result for a media file, without a job (undefined: none, or the file can't be read). */
export async function cachedFor(target: AnalysisTarget, analyzer: Analyzer): Promise<AnalysisResult | undefined> {
  try {
    return await readCached(target.dir, await fingerprint(target.path), analyzer);
  } catch {
    return undefined;
  }
}

/** Removes a cache file and its folder when that's empty (a cancel that came after the write). */
export async function removeCached(projectDir: string, fp: string, analyzer: Analyzer) {
  await rm(cacheFile(projectDir, fp, analyzer), { force: true }).catch(() => {});
  await rmdir(join(analysisDir(projectDir), fp)).catch(() => {});
}

/** Written aside and renamed; the folder is made only now, and removed again if the write fails. */
export async function writeCached(projectDir: string, fp: string, analyzer: Analyzer, result: AnalysisResult) {
  const path = cacheFile(projectDir, fp, analyzer);
  const folder = join(analysisDir(projectDir), fp);
  await mkdir(folder, { recursive: true });
  const file: CacheFile = { format: ANALYSIS_FORMAT, analyzer, version: versionOf(analyzer), fingerprint: fp, createdAt: new Date().toISOString(), result };
  try {
    await writeAtomic(path, `${JSON.stringify(file)}\n`);
  } catch (error) {
    await rmdir(folder).catch(() => {});
    throw error;
  }
}

// ---- the queue ----

/** A media item to analyse, resolved against its project. */
export interface AnalysisTarget {
  readonly dir: string;
  readonly mediaId: string;
  readonly path: string;
  readonly kind: "video" | "audio" | "image";
  readonly hasAudio?: boolean | undefined;
  /** The media's length in seconds (for progress), when known. */
  readonly seconds?: number | undefined;
}

/** A media entry of a project as an analysis target (relative paths resolve against the project). */
export const targetOf = (dir: string, media: { readonly id: string; readonly kind: string; readonly path: string; readonly probe?: { readonly frames?: number; readonly hasAudio?: boolean } }, fps: number): AnalysisTarget => ({
  dir,
  mediaId: media.id,
  path: isAbsolute(media.path) ? media.path : resolve(dir, media.path),
  kind: media.kind === "image" ? "image" : media.kind === "audio" ? "audio" : "video",
  hasAudio: media.probe?.hasAudio,
  seconds: media.probe?.frames ? media.probe.frames / fps : undefined,
});

/** Per-request choices: a transcript's language ("auto" or a code; none: any cached transcript will do). */
export interface RequestOptions {
  readonly language?: string | undefined;
}

/** A cached transcript answers a request that names no language, or one in the language it's in. */
const fits = (analyzer: Analyzer, result: AnalysisResult, options: RequestOptions | undefined) =>
  analyzer !== "transcript" || !options?.language || options.language === "auto" || !(result as TranscriptResult).hasAudio || (result as TranscriptResult).language === options.language;

export type Outcome = { readonly state: "done"; readonly result: AnalysisResult; readonly cached: boolean } | { readonly state: "failed"; readonly error: string } | { readonly state: "cancelled" };

/** A request's answer: the job doing it (none when the answer was there at once) and its outcome. */
export interface Requested {
  readonly job?: AnalysisJob;
  readonly done: Promise<Outcome>;
}

interface Entry {
  job: AnalysisJob;
  readonly target: AnalysisTarget;
  readonly options: RequestOptions | undefined;
  readonly fp: string;
  readonly controller: AbortController;
  readonly done: Promise<Outcome>;
  readonly resolve: (outcome: Outcome) => void;
}

export interface QueueOptions {
  /** The ffmpeg binary (undefined: not installed). */
  readonly ffmpeg: () => Promise<string | undefined>;
  readonly runner?: Runner;
  readonly concurrency?: number;
  readonly onChange?: (jobs: ReadonlyArray<AnalysisJob>) => void;
  /** Whether an export is busy right now (read when a job would start; setExportBusy wakes the queue when it ends). */
  readonly exportBusy?: () => boolean;
  /** Whether `dir` is still the open project (a request that took a while for a closed one is dropped). */
  readonly isOpen?: (dir: string) => boolean;
  /** whisper-cli and the speech model for transcripts (undefined: transcription isn't set up here). */
  readonly whisper?: ResolveWhisper;
  /** Where transcripts' temp folders go (tests). */
  readonly tmpRoot?: string;
}

const finished = (job: AnalysisJob) => job.phase === "done" || job.phase === "failed" || job.phase === "cancelled";
const settled = (outcome: Outcome) => ({ done: Promise.resolve(outcome) });

/**
 * The jobs: a request for a cached result (or a file without sound) is answered at once; one for
 * the same media and analyzer (or the same content) as a waiting or running job joins it; else a
 * job is queued. At most `concurrency` run at once, and none starts while an export is busy.
 */
export class AnalysisQueue {
  private jobs: ReadonlyArray<AnalysisJob> = [];
  private readonly active = new Map<string, Entry>();
  private readonly waiting: Array<Entry> = [];
  private running = 0;
  private exportBusy = false;
  private closed = false;

  private readonly options: QueueOptions;

  constructor(options: QueueOptions) {
    this.options = options;
  }

  list = () => this.jobs;
  job = (id: string) => this.jobs.find((j) => j.id === id);

  /** A waiting or running job for the same media (same file path) or, once fingerprinted, the same content. */
  private find(target: AnalysisTarget, analyzer: Analyzer, fp?: string, options?: RequestOptions) {
    for (const e of this.active.values()) {
      if (e.target.dir !== target.dir || e.job.analyzer !== analyzer) continue;
      // A transcript in another language is another job (no language asked: any will do).
      if (options?.language && options.language !== "auto" && (e.options?.language ?? "auto") !== options.language) continue;
      if ((e.target.mediaId === target.mediaId && e.target.path === target.path) || (fp !== undefined && e.fp === fp)) return e;
    }
    return undefined;
  }

  /** Joins a job; a second media id with the same content is added to it, so its tile shows the progress too. */
  private join(e: Entry, mediaId: string): Requested {
    if (!e.job.mediaIds.includes(mediaId)) this.patch(e, { mediaIds: [...e.job.mediaIds, mediaId] });
    return { job: e.job, done: e.done };
  }

  private busy = () => this.exportBusy || (this.options.exportBusy?.() ?? false);
  private stillOpen = (dir: string) => this.options.isOpen?.(dir) ?? true;

  async request(target: AnalysisTarget, analyzer: Analyzer, options?: RequestOptions): Promise<Requested> {
    if (this.closed) return settled({ state: "cancelled" });
    // Nothing to measure, known from the probe: no job, no cache file.
    if (analyzer === "loudness" && (target.kind === "image" || target.hasAudio === false)) return settled({ state: "done", result: NO_AUDIO, cached: false });
    if (analyzer === "video" && target.kind !== "video") return settled({ state: "done", result: NO_VIDEO, cached: false });
    if (analyzer === "transcript" && (target.kind === "image" || target.hasAudio === false)) return settled({ state: "done", result: NO_SPEECH_AUDIO, cached: false });
    if (analyzer === "beats" && (target.kind === "image" || target.hasAudio === false)) return settled({ state: "done", result: NO_BEATS_AUDIO, cached: false });
    const joined = this.find(target, analyzer, undefined, options);
    if (joined) return this.join(joined, target.mediaId);
    let fp: string;
    try {
      fp = await fingerprint(target.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return settled({ state: "failed", error: code === "ENOENT" ? `The file isn't there any more: ${target.path}` : code === "EACCES" || code === "EPERM" ? `Uncut isn't allowed to read ${target.path}.` : (error as Error).message });
    }
    const cached = await readCached(target.dir, fp, analyzer);
    if (cached && fits(analyzer, cached, options)) return settled({ state: "done", result: cached, cached: true });
    // The project may have closed while the file was read: nothing more for it.
    if (this.closed || !this.stillOpen(target.dir)) return settled({ state: "cancelled" });
    // Another request may have queued it while this one read the file.
    const again = this.find(target, analyzer, fp, options);
    if (again) return this.join(again, target.mediaId);
    let resolveOutcome: (outcome: Outcome) => void = () => {};
    const done = new Promise<Outcome>((r) => (resolveOutcome = r));
    const job: AnalysisJob = {
      id: randomUUID(),
      projectDir: target.dir,
      mediaId: target.mediaId,
      mediaIds: [target.mediaId],
      analyzer,
      phase: "queued",
      progress: 0,
      ...(this.busy() ? { waiting: "export" as const } : {}),
      startedAt: new Date().toISOString(),
    };
    const entry: Entry = { job, target, options, fp, controller: new AbortController(), done, resolve: resolveOutcome };
    this.active.set(job.id, entry);
    this.waiting.push(entry);
    const kept = this.jobs.filter(finished).slice(-MAX_JOBS_KEPT);
    this.jobs = [...this.jobs.filter((j) => !finished(j)), ...kept, job];
    this.emit();
    this.pump();
    return { job, done };
  }

  /** Stops a waiting or running job; it writes nothing. */
  cancel(jobId: string) {
    const e = this.active.get(jobId);
    if (!e) return;
    e.controller.abort();
    // Waiting: nothing to clean up, so it's cancelled now.
    const at = this.waiting.indexOf(e);
    if (at >= 0) {
      this.waiting.splice(at, 1);
      this.finish(e, { state: "cancelled" });
    }
  }

  /** Cancels the jobs whose target matches (e.g. of a project that was closed). */
  cancelWhere(match: (target: AnalysisTarget) => boolean) {
    for (const e of [...this.active.values()]) if (match(e.target)) this.cancel(e.job.id);
  }

  /** An export started or ended: waiting jobs say so, and start again once it's over. */
  setExportBusy(busy: boolean) {
    this.exportBusy = busy;
    // Also when the flag didn't change: the synchronous exportBusy() may have held jobs back.
    if (!this.waiting.length) return;
    const waiting = this.busy() ? "export" : undefined;
    const stale = this.waiting.filter((e) => e.job.waiting !== waiting);
    for (const e of stale) this.patch(e, { waiting }, false);
    if (stale.length) this.emit();
    this.pump();
  }

  /** The server is stopping: everything is cancelled (running ffmpeg is killed). */
  shutdown() {
    this.closed = true;
    for (const e of [...this.active.values()]) this.cancel(e.job.id);
  }

  private emit() {
    this.options.onChange?.(this.jobs);
  }

  private patch(e: Entry, change: Partial<AnalysisJob> & { waiting?: "export" | undefined; stage?: "model" | undefined }, emit = true) {
    const next = { ...e.job, ...change } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    const job = next as unknown as AnalysisJob;
    this.jobs = this.jobs.map((j) => (j.id === e.job.id ? job : j));
    e.job = job;
    if (emit) this.emit();
  }

  private finish(e: Entry, outcome: Outcome) {
    this.active.delete(e.job.id);
    this.patch(e, {
      phase: outcome.state,
      waiting: undefined,
      stage: undefined,
      ...(outcome.state === "done" ? { progress: 1 } : {}),
      ...(outcome.state === "failed" ? { error: outcome.error } : {}),
      finishedAt: new Date().toISOString(),
    });
    e.resolve(outcome);
  }

  private pump() {
    if (this.waiting.length && this.busy()) {
      const stale = this.waiting.filter((e) => !e.job.waiting);
      for (const e of stale) this.patch(e, { waiting: "export" }, false);
      if (stale.length) this.emit();
      return;
    }
    while (!this.closed && !this.busy() && this.running < (this.options.concurrency ?? CONCURRENCY)) {
      // One transcript at a time (whisper keeps the GPU busy); others wait their turn, the rest go by.
      const at = this.waiting.findIndex((e) => e.job.analyzer !== "transcript" || this.transcribing === 0);
      if (at < 0) break;
      void this.run(this.waiting.splice(at, 1)[0]!);
    }
  }

  private transcribing = 0;

  private async run(e: Entry) {
    this.running++;
    const transcript = e.job.analyzer === "transcript";
    if (transcript) this.transcribing++;
    this.patch(e, { phase: "running", progress: 0, waiting: undefined });
    const { signal } = e.controller;
    let outcome: Outcome;
    try {
      const bin = await this.options.ffmpeg();
      if (!bin) throw new Error(`ffmpeg isn't installed, and Uncut needs it to ${transcript ? "transcribe" : `analyse ${e.job.analyzer === "video" ? "video" : "sound"}`} (brew install ffmpeg).`);
      let last = 0;
      const options = {
        signal,
        runner: this.options.runner,
        seconds: e.target.seconds,
        onProgress: (fraction: number) => {
          const now = Date.now();
          if (now - last < 250) return;
          last = now;
          this.patch(e, { progress: Math.round(fraction * 1000) / 1000 });
        },
      };
      let result: AnalysisResult;
      if (transcript) {
        if (!this.options.whisper) throw new Error("Transcription isn't set up in this build.");
        // The model may need downloading first: the job shows that download's progress meanwhile.
        let lastDownload = 0;
        const whisper = await this.options.whisper({
          signal,
          onDownload: (fraction) => {
            const now = Date.now();
            if (now - lastDownload < 250) return;
            lastDownload = now;
            this.patch(e, { stage: "model", progress: Math.round(fraction * 1000) / 1000 });
          },
        });
        if (signal.aborted) throw new Cancelled();
        if (e.job.stage) this.patch(e, { stage: undefined, progress: 0 });
        result = await analyzeTranscript(bin, whisper, e.target.path, { ...options, language: e.options?.language, ...(this.options.tmpRoot ? { tmpRoot: this.options.tmpRoot } : {}) });
      } else if (e.job.analyzer === "video") result = await analyzeVideo(bin, e.target.path, options);
      else if (e.job.analyzer === "beats") result = await analyzeBeats(bin, e.target.path, options);
      else result = await analyzeLoudness(bin, e.target.path, options);
      if (signal.aborted) throw new Cancelled();
      // Cached only if the file is still what was fingerprinted (it may have changed meanwhile).
      // A cache that can't be written (read-only disk) costs a re-run later, not this result.
      const now = await fingerprint(e.target.path).catch(() => undefined);
      if (signal.aborted) throw new Cancelled();
      if (now === e.fp) await writeCached(e.target.dir, e.fp, e.job.analyzer, result).catch(() => {});
      // A cancel that landed during the write still leaves nothing.
      if (signal.aborted) {
        if (now === e.fp) await removeCached(e.target.dir, e.fp, e.job.analyzer);
        throw new Cancelled();
      }
      outcome = { state: "done", result, cached: false };
    } catch (error) {
      outcome = error instanceof Cancelled || signal.aborted ? { state: "cancelled" } : { state: "failed", error: (error as Error).message || "The analysis stopped unexpectedly." };
    } finally {
      this.running--;
      if (transcript) this.transcribing--;
    }
    this.finish(e, outcome);
    this.pump();
  }
}

// ---- the service ----

export interface AnalysisShape {
  readonly jobs: Stream.Stream<ReadonlyArray<AnalysisJob>>;
  /** analysis.start: analyse a media item of the open project (the Library's Analyze: the sound, unless analyzers say otherwise). */
  readonly start: (mediaId: string, analyzers?: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<{ analyzer: Analyzer; state: "done" | "queued" | "running"; jobId?: string }>, AnalysisError>;
  readonly cancel: (jobId: string) => Effect.Effect<void>;
  /** For the agent's media_analyze: start or join, then follow `done`. */
  readonly request: (target: AnalysisTarget, analyzer: Analyzer, options?: RequestOptions) => Promise<Requested>;
  /** A job as it is now. */
  readonly job: (jobId: string) => AnalysisJob | undefined;
  /** analysis.cached: a media item's cached result, without a job (null: none yet). */
  readonly cached: (mediaId: string, analyzer: Analyzer, omit?: ReadonlyArray<string>) => Effect.Effect<{ readonly result: AnalysisResult | null }, AnalysisError>;
}

export class Analysis extends Context.Service<Analysis, AnalysisShape>()("uncut/Analysis") {}

const EXPORT_BUSY = new Set(["queued", "preparing", "rendering"]);

export const layer = Layer.effect(
  Analysis,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projects = yield* Projects;
    const exporter = yield* Exporter;
    const whisper = yield* Whisper;
    const jobsRef = yield* SubscriptionRef.make<ReadonlyArray<AnalysisJob>>([]);
    const queue = new AnalysisQueue({
      ffmpeg: async () => {
        await config.shellReady;
        return which("ffmpeg", process.env.PATH ?? "");
      },
      onChange: (jobs) => Effect.runSync(SubscriptionRef.set(jobsRef, jobs)),
      // Read synchronously: an export started a moment ago counts before its stream update arrives.
      exportBusy: exporter.busy,
      isOpen: (dir) => Effect.runSync(projects.currentDir) === dir,
      whisper: whisper.resolve,
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => queue.shutdown()));
    // Exports come first (D55): no analysis starts while one is queued or running.
    yield* Effect.forkScoped(Stream.runForEach(exporter.jobs, (jobs) => Effect.sync(() => queue.setExportBusy(jobs.some((j) => EXPORT_BUSY.has(j.phase))))));
    // A project that closes (or another that opens) takes its waiting and running jobs with it.
    yield* Effect.forkScoped(Stream.runForEach(projects.changes, (snapshot) => Effect.sync(() => queue.cancelWhere((t) => t.dir !== snapshot?.dir))));

    const start = (mediaId: string, analyzers?: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const open = yield* projects.current;
        if (!open) return yield* new AnalysisError({ reason: "no-project", message: "Open a project first." });
        const project = open.project as { canvas: { fps: number }; media: ReadonlyArray<{ id: string; kind: string; path: string; probe?: { frames?: number; hasAudio?: boolean } }> };
        const media = project.media.find((m) => m.id === mediaId);
        if (!media) return yield* new AnalysisError({ reason: "unknown-media", message: `There's no media "${mediaId}" in this project.` });
        // The Library's Analyze button is about the sound (D66), which is also the default.
        const parsed = parseAnalyzers(analyzers);
        if ("refused" in parsed) return yield* new AnalysisError({ reason: "unknown-analyzer", message: parsed.refused });
        const target = targetOf(open.dir, media, project.canvas.fps);
        const answers = yield* Effect.promise(() =>
          Promise.all(
            parsed.analyzers.map(async (analyzer) => {
              const r = await queue.request(target, analyzer);
              if (r.job) return { analyzer, state: r.job.phase === "running" ? ("running" as const) : ("queued" as const), jobId: r.job.id };
              // Answered at once: a cached result, or why it can't run (a missing file, a closed project).
              const outcome = await r.done;
              return outcome.state === "done" ? { analyzer, state: "done" as const } : { analyzer, failed: outcome.state === "failed" ? outcome.error : "The project closed before the analysis could start." };
            }),
          ),
        );
        const failed = answers.find((a): a is { analyzer: Analyzer; failed: string } => "failed" in a);
        if (failed) return yield* new AnalysisError({ reason: "failed", message: `Couldn't analyse ${media.id}: ${failed.failed}` });
        return answers as ReadonlyArray<{ analyzer: Analyzer; state: "done" | "queued" | "running"; jobId?: string }>;
      });

    const cached = (mediaId: string, analyzer: Analyzer, omit?: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const open = yield* projects.current;
        if (!open) return yield* new AnalysisError({ reason: "no-project", message: "Open a project first." });
        const project = open.project as { canvas: { fps: number }; media: ReadonlyArray<{ id: string; kind: string; path: string; probe?: { frames?: number; hasAudio?: boolean } }> };
        const media = project.media.find((m) => m.id === mediaId);
        if (!media) return yield* new AnalysisError({ reason: "unknown-media", message: `There's no media "${mediaId}" in this project.` });
        const result = yield* Effect.promise(() => cachedFor(targetOf(open.dir, media, project.canvas.fps), analyzer));
        if (!result || !omit?.length) return { result: result ?? null };
        // Fields the caller doesn't need (the timeline: a beats result's onsets) stay on the server.
        const kept: Record<string, unknown> = { ...(result as unknown as Record<string, unknown>) };
        for (const key of omit) delete kept[key];
        return { result: kept as unknown as AnalysisResult };
      });

    return Analysis.of({
      cached,
      jobs: SubscriptionRef.changes(jobsRef),
      start,
      cancel: (jobId) => Effect.sync(() => queue.cancel(jobId)),
      request: (target, analyzer, options) => queue.request(target, analyzer, options),
      job: (jobId) => queue.job(jobId),
    });
  }),
);
