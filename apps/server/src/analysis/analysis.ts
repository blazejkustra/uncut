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
// The third, "transcript" (transcription.ts, D68), transcribes the speech with whisper.cpp (through the bundled Whisper plugin, D100); at most
// one runs at a time (it keeps the GPU busy), after its speech model is there (downloaded first).
// The fourth, "beats" (beats.ts, D70), finds the tempo, beats and onsets of the first audio stream
// in TypeScript on PCM decoded like the waveform's.

import { AnalysisError, type AnalysisJob, type Analyzer } from "@uncut/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerConfig } from "../app/config.ts";
import { Exporter } from "../export/exporter.ts";
import { Projects } from "../project/projects.ts";
import { which } from "../app/setup.ts";
import { pluginTranscribe, WHISPER_PLUGIN, WHISPER_TOOL } from "./transcription.ts";
import { Plugins } from "../plugins/plugins.ts";
import { Whisper } from "./whisper.ts";
import { type AnalysisTarget, type AnalysisResult, targetOf, cachedFor } from "./queue/cache.ts";
import { type RequestOptions, type Requested, AnalysisQueue } from "./queue/queue.ts";
export { SILENCE_DB, SILENCE_MIN_S, NO_AUDIO, loudnessArgs, RmsEnvelope, LoudnessLog, analyzeLoudness, isResult } from "./loudness/loudness.ts";
export type { SilenceRange, LoudnessResult } from "./loudness/loudness.ts";
export {
  ANALYSIS_FORMAT,
  LOUDNESS_VERSION,
  SAMPLE_BYTES,
  analysisDir,
  cacheFile,
  fingerprint,
  readCached,
  cachedFor,
  removeCached,
  writeCached,
  targetOf,
} from "./queue/cache.ts";
export type { AnalysisResult, AnalysisTarget } from "./queue/cache.ts";
export { AnalysisQueue } from "./queue/queue.ts";
export type { RequestOptions, Outcome, Requested, QueueOptions } from "./queue/queue.ts";

/** Analyzers the agent's spec names (spec/agent/tools.json) that come with later chunks. */
export const LATER_ANALYZERS: Readonly<Record<string, string>> = {
  description: "descriptions",
};

/** Names that mean the same job: one pass finds both silences and loudness, or all of the picture's signals. */
export const ANALYZER_ALIASES: Readonly<Record<string, Analyzer>> = {
  loudness: "loudness",
  silence: "loudness",
  video: "video",
  shots: "video",
  motion: "video",
  stability: "video",
  transcript: "transcript",
  transcription: "transcript",
  beats: "beats",
  rhythm: "beats",
  onsets: "beats",
  tempo: "beats",
};
const AVAILABLE = `Available now: loudness (also gives the silences; "silence" means the same), video (cuts, shake, blur, exposure and frozen stretches; "shots", "motion" and "stability" mean the same) transcript (the speech, transcribed on this Mac) and beats (tempo, beats and onsets; "rhythm", "onsets" and "tempo" mean the same).`;

/**
 * Which analyzers a request means: none named = loudness (cheap, ~400× realtime; video is opt-in,
 * named or through media_rank, since it takes about a minute on a long 4K clip and would hold the
 * queue); "silence" is the loudness job (one pass finds both), "shots", "motion" and "stability"
 * the video job. Later ones and unknown names are refused with a sentence.
 */
export function parseAnalyzers(value: unknown): { readonly analyzers: ReadonlyArray<Analyzer> } | { readonly refused: string } {
  if (value === undefined) return { analyzers: ["loudness"] };
  if (!Array.isArray(value) || !value.length || !value.every((v) => typeof v === "string"))
    return { refused: `analyzers must be a non-empty list, e.g. ["loudness"].` };
  const out = new Set<Analyzer>();
  for (const name of value as Array<string>) {
    const alias = Object.hasOwn(ANALYZER_ALIASES, name) ? ANALYZER_ALIASES[name] : undefined;
    if (alias) out.add(alias);
    else if (Object.hasOwn(LATER_ANALYZERS, name)) return { refused: `${name} (${LATER_ANALYZERS[name]}) isn't available yet. ${AVAILABLE}` };
    else return { refused: `There's no analyzer "${name}". ${AVAILABLE}` };
  }
  return { analyzers: [...out] };
}

// ---- running ffmpeg ----

export { Cancelled, spawnRunner, type RunOptions, type Runner } from "./analysisRunner.ts";

// ---- the service ----

export interface AnalysisShape {
  readonly jobs: Stream.Stream<ReadonlyArray<AnalysisJob>>;
  /** analysis.start: analyse a media item of the open project (the Library's Analyze: the sound, unless analyzers say otherwise). */
  readonly start: (
    mediaId: string,
    analyzers?: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<{ analyzer: Analyzer; state: "done" | "queued" | "running"; jobId?: string }>, AnalysisError>;
  readonly cancel: (jobId: string) => Effect.Effect<void>;
  /** For the agent's media_analyze: start or join, then follow `done`. */
  readonly request: (target: AnalysisTarget, analyzer: Analyzer, options?: RequestOptions) => Promise<Requested>;
  /** A job as it is now. */
  readonly job: (jobId: string) => AnalysisJob | undefined;
  /** analysis.cached: a media item's cached result, without a job (null: none yet). */
  readonly cached: (
    mediaId: string,
    analyzer: Analyzer,
    omit?: ReadonlyArray<string>,
  ) => Effect.Effect<{ readonly result: AnalysisResult | null }, AnalysisError>;
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
    const plugins = yield* Plugins;
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
      // Speech to words through the bundled Whisper plugin (D26, D100), with the job's own signal:
      // a transcript outlives the agent turn that asked for it.
      transcribe: pluginTranscribe((args, { signal, timeoutMs, onProgress }) =>
        Effect.runPromise(plugins.callPlugin(WHISPER_PLUGIN, WHISPER_TOOL, args, { signal, timeoutMs, onProgress })),
      ),
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
        const project = open.project as {
          canvas: { fps: number };
          media: ReadonlyArray<{ id: string; kind: string; path: string; probe?: { frames?: number; hasAudio?: boolean } }>;
        };
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
              return outcome.state === "done"
                ? { analyzer, state: "done" as const }
                : { analyzer, failed: outcome.state === "failed" ? outcome.error : "The project closed before the analysis could start." };
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
        const project = open.project as {
          canvas: { fps: number };
          media: ReadonlyArray<{ id: string; kind: string; path: string; probe?: { frames?: number; hasAudio?: boolean } }>;
        };
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
