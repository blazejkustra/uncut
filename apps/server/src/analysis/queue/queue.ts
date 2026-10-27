// The analysis job queue (D66, D55): a few jobs at a time, paused while an export runs.
import { randomUUID } from "node:crypto";
import type { Analyzer, AnalysisJob } from "@uncut/contracts";
import { NO_BEATS_AUDIO, analyzeBeats } from "../beats.ts";
import { type Runner, Cancelled } from "../analysisRunner.ts";
import { type TranscriptResult, type Transcribe, NO_SPEECH_AUDIO, analyzeTranscript } from "../transcription.ts";
import { briefNames } from "../names.ts";
import { NO_VIDEO, analyzeVideo } from "../videoAnalysis.ts";
import type { ResolveWhisper } from "../whisper.ts";
import { type AnalysisResult, type AnalysisTarget, fingerprint, readCached, writeCached, removeCached } from "./cache.ts";
import { NO_AUDIO, analyzeLoudness } from "../loudness/loudness.ts";

const CONCURRENCY = 2;
const MAX_JOBS_KEPT = 20;

/** Per-request choices: a transcript's language ("auto" or a code; none: any cached transcript will do). */
export interface RequestOptions {
  readonly language?: string | undefined;
}

/** A cached transcript answers a request that names no language, or one in the language it's in. */
const fits = (analyzer: Analyzer, result: AnalysisResult, options: RequestOptions | undefined) =>
  analyzer !== "transcript" ||
  !options?.language ||
  options.language === "auto" ||
  !(result as TranscriptResult).hasAudio ||
  (result as TranscriptResult).language === options.language;

export type Outcome =
  | { readonly state: "done"; readonly result: AnalysisResult; readonly cached: boolean }
  | { readonly state: "failed"; readonly error: string }
  | { readonly state: "cancelled" };

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
  /** The speech model that turns the WAV into words: the Whisper plugin in the app (D100), transcribeDirect in tests. */
  readonly transcribe?: Transcribe;
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
    if (analyzer === "transcript" && (target.kind === "image" || target.hasAudio === false))
      return settled({ state: "done", result: NO_SPEECH_AUDIO, cached: false });
    if (analyzer === "beats" && (target.kind === "image" || target.hasAudio === false))
      return settled({ state: "done", result: NO_BEATS_AUDIO, cached: false });
    const joined = this.find(target, analyzer, undefined, options);
    if (joined) return this.join(joined, target.mediaId);
    let fp: string;
    try {
      fp = await fingerprint(target.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return settled({
        state: "failed",
        error:
          code === "ENOENT"
            ? `The file isn't there any more: ${target.path}`
            : code === "EACCES" || code === "EPERM"
              ? `Uncut isn't allowed to read ${target.path}.`
              : (error as Error).message,
      });
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
      if (!bin)
        throw new Error(
          `ffmpeg isn't installed, and Uncut needs it to ${transcript ? "transcribe" : `analyse ${e.job.analyzer === "video" ? "video" : "sound"}`} (brew install ffmpeg).`,
        );
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
        if (!this.options.whisper || !this.options.transcribe) throw new Error("Transcription isn't set up in this build.");
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
        const names = await briefNames(e.target.dir);
        result = await analyzeTranscript(bin, whisper, e.target.path, {
          ...options,
          transcribe: this.options.transcribe,
          language: e.options?.language,
          names,
          ...(this.options.tmpRoot ? { tmpRoot: this.options.tmpRoot } : {}),
        });
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
      outcome =
        error instanceof Cancelled || signal.aborted
          ? { state: "cancelled" }
          : { state: "failed", error: (error as Error).message || "The analysis stopped unexpectedly." };
    } finally {
      this.running--;
      if (transcript) this.transcribing--;
    }
    this.finish(e, outcome);
    this.pump();
  }
}
