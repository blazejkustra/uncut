// Export as a server job (D34, D55): the open project as it is when the export starts, rendered by
// ffmpeg from the original media with the text and backgrounds Chromium drew (exportPlan.ts has
// the maths). Jobs run one at a time in the server, not in the request that started them, so a
// dropped connection doesn't stop one; export.cancel (or the server shutting down) kills ffmpeg and
// the rasteriser and removes the temp folder and the partial output. Temp files (PNGs, the graph,
// the file being written) live in one folder in the OS temp dir; the finished file is moved to
// where the user chose, replacing nothing unless asked to.
//
// Also the agent's frame renders (D51): a few frames of the edit as JPEGs, composited the way the
// export composites them; and its contact sheets (D65): frames pulled from a media file, and a
// grid of frames with captions drawn by the rasteriser.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { ExportError, type ExportJob, type ExportLoudness, type ExportQuality, type ExportSubtitles, type ExportVideo } from "@uncut/contracts";
import { motionBlurDefault, subtitleCues, subtitleLanguageTag, targetOfChoice, type SpeechEnvelope } from "@uncut/core";
import { type Media, type Project } from "@uncut/core";
import { clampRange, sliceProject } from "@uncut/core/slice";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { type SheetLayout } from "../agent/agentFootage.ts";
import { ServerConfig } from "../app/config.ts";
import { outputSize, planExport, RASTER_CSS, canHevc, type ExportPlan } from "./exportPlan.ts";
import { Projects } from "../project/projects.ts";
import { which } from "../app/setup.ts";
import { overwritesImported } from "./subtitleSources.ts";
import { type RenderedFrame, type FrameSessionOptions, openFrameSession, renderFramesWith } from "./exporter/frames.ts";
import type { Rehearsal } from "./exporter/rehearse.ts";
import { type MediaFrame, mediaFramesWith, drawSheet } from "./exporter/sheets.ts";
import { type SavedSubtitles, NO_SUBTITLES, saveSubtitlesFile } from "./exporter/subtitles.ts";
import { sweepStaleTemp, exists, plainFsError, canonical } from "./exporter/files.ts";
import { capsOf, withPictureSizes } from "./exporter/ffmpeg.ts";
import { projectGraphics } from "./exporter/graphics.ts";
import { makeDuckEnvelopes } from "./exporter/duckEnvelopes.ts";
import { makeRunJob } from "./exporter/runJob.ts";
import { makePreviewLoudness } from "./exporter/previewLoudness.ts";
export type { RenderedFrame, FrameSessionOptions } from "./exporter/frames.ts";
export { NO_SUBTITLES, saveSubtitlesFile } from "./exporter/subtitles.ts";
export type { SavedSubtitles } from "./exporter/subtitles.ts";
export { sweepStaleTemp, plainFsError, EXPORT_TEMP_PREFIX } from "./exporter/files.ts";
export { readGraphics, projectGraphics } from "./exporter/graphics.ts";
export type { MediaFrame } from "./exporter/sheets.ts";

export interface ExportInput {
  readonly output: string;
  readonly quality: ExportQuality;
  readonly loudness: ExportLoudness;
  /** With loudness "target": the LUFS (D87). */
  readonly targetLufs?: number | undefined;
  readonly overwrite?: boolean | undefined;
  /** D105: a subtitles file next to the video and / or a soft track in it. */
  readonly subtitles?: ExportSubtitles | undefined;
  /** D105: draw captions and Subtitles tracks into the picture (default true). */
  readonly burnCaptions?: boolean | undefined;
  /** G7 (D127): only frames [from, to) of the edit (core sliceProject). */
  readonly range?: { readonly from: number; readonly to: number } | undefined;
  /** F4 (D171): the Advanced row: codec, bitrate, size by the shorter side, frame rate. */
  readonly video?: ExportVideo | undefined;
  /** D291: motion blur on graphics; absent = the project's default (core motionBlurDefault: on unless Draft). */
  readonly motionBlur?: boolean | undefined;
  /** The agent's export_video started it (ExportJob.agent): the editor shows it like its own. */
  readonly agent?: boolean | undefined;
}

/** D292: a frame session's renders (exporter/frames.ts openFrameSession), as effects. */
export interface FrameSessionShape {
  /** As renderFrames; `until` is asked before each frame and, once true, the rest are left out. */
  readonly render: (frames: ReadonlyArray<number>, width: number, o?: { readonly until?: () => boolean; readonly motionBlur?: boolean; readonly census?: boolean }) => Effect.Effect<ReadonlyArray<RenderedFrame>, ExportError>;
  /** As sheetImage, drawn by the session's rasteriser. */
  readonly sheet: (cells: ReadonlyArray<{ readonly jpeg: Buffer; readonly caption: string }>, layout: SheetLayout) => Effect.Effect<Buffer, ExportError>;
  /** The export's graphics rehearsed on the session's rasteriser (exporter/rehearse.ts), within `budgetMs`. */
  readonly rehearse: (budgetMs: number) => Effect.Effect<Rehearsal, ExportError>;
}

export interface ExporterShape {
  readonly start: (input: ExportInput) => Effect.Effect<{ jobId: string }, ExportError>;
  readonly cancel: (jobId: string) => Effect.Effect<void>;
  readonly jobs: Stream.Stream<ReadonlyArray<ExportJob>>;
  /** The jobs right now (the Download route, D109). */
  readonly jobList: Effect.Effect<ReadonlyArray<ExportJob>>;
  /** Whether an export is queued, preparing or rendering, now (analysis yields to it, D66). */
  readonly busy: () => boolean;
  /** Frames of the open project as JPEGs, `width` px wide (the agent's render_frames). */
  /** `project`: draw this project (the open one's folder and media) instead of the open one as it is: a storyboard still of a graphic not placed yet. */
  readonly renderFrames: (frames: ReadonlyArray<number>, width: number, project?: Project) => Effect.Effect<ReadonlyArray<RenderedFrame>, ExportError>;
  /**
   * D292: `use` with one frame session of the open project (one rasteriser, one temp folder, the
   * plan once per width), closed when it ends: many renders without a rasteriser start each.
   */
  readonly frameSession: <A, E, R>(use: (session: FrameSessionShape) => Effect.Effect<A, E, R>, options?: FrameSessionOptions) => Effect.Effect<A, E | ExportError, R>;
  /** contact_sheet (D65): the first video stream of `path` at each of `seconds`, `width` px wide, as JPEGs. */
  readonly mediaFrames: (path: string, seconds: ReadonlyArray<number>, width: number, fps: number) => Effect.Effect<ReadonlyArray<MediaFrame>, ExportError>;
  /** contact_sheet (D65): the cells in a grid with their captions, drawn by the rasteriser, as one JPEG. */
  readonly sheetImage: (cells: ReadonlyArray<{ readonly jpeg: Buffer; readonly caption: string }>, layout: SheetLayout) => Effect.Effect<Buffer, ExportError>;
  /** D105: the open project's subtitles as a .srt or .vtt file (the format by the extension), no video. */
  readonly saveSubtitles: (input: { readonly output: string; readonly overwrite?: boolean | undefined }) => Effect.Effect<SavedSubtitles, ExportError>;
  /** D246: the loudness gain the export would use for `targetLufs` (the preview's At target). */
  readonly previewLoudness: (targetLufs: number) => Effect.Effect<{ gainDb?: number; lufs?: number; cancelled?: boolean }, ExportError>;
}

export class Exporter extends Context.Service<Exporter, ExporterShape>()("uncut/Exporter") {}

const MAX_JOBS_KEPT = 10;

export const layer = Layer.effect(
  Exporter,
  Effect.gen(function* () {
    const projects = yield* Projects;
    const config = yield* ServerConfig;
    const jobsRef = yield* SubscriptionRef.make<ReadonlyArray<ExportJob>>([]);
    const controllers = new Map<string, AbortController>();
    let queue: Promise<void> = Promise.resolve();
    // The job running now, so shutdown can wait for its cleanup.
    let running: Promise<void> | undefined;
    void sweepStaleTemp();

    const patch = (id: string, change: Partial<ExportJob>) =>
      Effect.runSync(SubscriptionRef.update(jobsRef, (jobs) => jobs.map((j) => (j.id === id ? { ...j, ...change } : j))));

    // The server is going away: stop everything and wait (bounded) until the running job has
    // killed its processes and removed its temp folder; bin.ts exits after a second regardless.
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const c of controllers.values()) c.abort();
        if (running) await Promise.race([running.catch(() => {}), new Promise((r) => setTimeout(r, 900))]);
      }),
    );

    const ffmpegBin = async () => {
      await config.shellReady;
      return which("ffmpeg", process.env.PATH ?? "");
    };

    /** The open project, its folder and a resolver for its media paths. */
    const current = Effect.gen(function* () {
      const open = yield* projects.current;
      if (!open) return yield* new ExportError({ reason: "no-project", message: "Open a project first." });
      const project = open.project as Project;
      const mediaPath = (m: Media) => (isAbsolute(m.path) ? m.path : resolve(open.dir, m.path));
      return { dir: open.dir, project, mediaPath };
    });

    /** Media files the plan needs that aren't there, as a sentence (or undefined). */
    const missingMedia = async (plan: ExportPlan) => {
      const missing: Array<string> = [];
      for (const f of plan.files) if (!(await exists(f.path))) missing.push(`${f.media.name} (${f.path})`);
      if (!missing.length) return undefined;
      return `Can't export: ${missing.length === 1 ? `${missing[0]} is missing` : `these files are missing: ${missing.join(", ")}`}. Put ${missing.length === 1 ? "it" : "them"} back or remove ${missing.length === 1 ? "its clips" : "their clips"}, then export again.`;
    };

    const duckEnvelopes = makeDuckEnvelopes();

    const runJob = makeRunJob({ patch, ffmpegBin, missingMedia, duckEnvelopes });

    const start = (input: ExportInput) =>
      Effect.gen(function* () {
        const { dir, project: whole, mediaPath } = yield* current;
        // A part of the timeline (D127): the project cut to it, so the picture, the sound, captions
        // and the subtitles file all start at its first frame.
        const sliced = input.range ? sliceProject(whole, input.range) : whole;
        if ("problem" in sliced) return yield* new ExportError({ reason: "empty", message: sliced.problem });
        const project = sliced;
        const range = input.range ? clampRange(whole, input.range) : undefined;
        const output = input.output.trim();
        if (!isAbsolute(output) || !/\.mp4$/i.test(output)) return yield* new ExportError({ reason: "invalid-path", message: "Choose where to save the video: a .mp4 file." });
        const folder = yield* Effect.promise(() => stat(dirname(output)).then((s) => s.isDirectory(), () => false));
        if (!folder) return yield* new ExportError({ reason: "invalid-path", message: `The folder ${dirname(output)} doesn't exist.` });
        const writable = yield* Effect.promise(() => access(dirname(output), constants.W_OK).then(() => undefined, (error: unknown) => error));
        if (writable) return yield* new ExportError({ reason: "invalid-path", message: plainFsError(writable, dirname(output)) });
        const target = yield* Effect.promise(() => canonical(output));
        const media = yield* Effect.promise(() => Promise.all(project.media.map((m) => canonical(mediaPath(m)))));
        if (media.includes(target)) return yield* new ExportError({ reason: "source-media", message: `Saving as ${basename(output)} would replace footage this project uses. Choose another name or folder.` });
        const busy = yield* Effect.promise(async () => {
          for (const j of Effect.runSync(SubscriptionRef.get(jobsRef))) if (["queued", "preparing", "rendering"].includes(j.phase) && (await canonical(j.output)) === target) return true;
          return false;
        });
        if (busy) return yield* new ExportError({ reason: "busy", message: `Another export is already saving to ${basename(output)}. Wait for it, or choose another name.` });
        if (!input.overwrite && (yield* Effect.promise(() => exists(output)))) return yield* new ExportError({ reason: "exists", message: `${basename(output)} already exists in that folder.` });
        // Subtitles (D105): a file next to the video (same name, .srt / .vtt) and / or a soft track.
        const subtitlesFile = input.subtitles?.file ? output.replace(/\.mp4$/i, `.${input.subtitles.file}`) : undefined;
        if ((subtitlesFile || input.subtitles?.track) && !subtitleCues(project).length) return yield* new ExportError({ reason: "empty", message: NO_SUBTITLES });
        if (subtitlesFile) {
          const sideTarget = yield* Effect.promise(() => canonical(subtitlesFile));
          if (media.includes(sideTarget)) return yield* new ExportError({ reason: "source-media", message: `Saving as ${basename(subtitlesFile)} would replace a file this project uses. Choose another name or folder.` });
          const imported = yield* Effect.promise(() => overwritesImported(dir, subtitlesFile));
          if (imported) return yield* new ExportError({ reason: "source-media", message: imported });
          if (!input.overwrite && (yield* Effect.promise(() => exists(subtitlesFile)))) return yield* new ExportError({ reason: "exists", message: `${basename(subtitlesFile)} already exists in that folder.` });
        }
        if (!(yield* Effect.promise(ffmpegBin))) return yield* new ExportError({ reason: "no-ffmpeg", message: "ffmpeg isn't installed, and Uncut needs it to export." });
        // F4 (D171): H.264 unless HEVC is asked for; the Advanced size, rate and bitrate when given.
        const video = input.video ?? {};
        const codec = video.codec ?? "h264";
        const bad = (x: number | undefined, lo: number, hi: number) => x !== undefined && !(Number.isFinite(x) && x >= lo && x <= hi);
        if (bad(video.bitrateMbps, 0.1, 500) || bad(video.shortSide, 16, 8192) || bad(video.fps, 1, 120)) return yield* new ExportError({ reason: "invalid-settings", message: "Those video settings can't be used: a bitrate of 0.1 to 500 Mb/s, a size of 16 to 8192 px and 1 to 120 fps." });
        const size = outputSize(project.canvas, input.quality, video.shortSide);
        const bin = (yield* Effect.promise(ffmpegBin))!;
        if (codec === "hevc" && !canHevc(yield* Effect.promise(() => capsOf(bin)))) return yield* new ExportError({ reason: "no-codec", message: "This ffmpeg can't make HEVC videos. Choose H.264." });
        const sized = yield* Effect.promise(() => withPictureSizes(bin, project, mediaPath));
        // D198: graphics with the fonts and logos they name; the kit's faces for texts and components.
        const { graphics, fonts } = yield* Effect.promise(() => projectGraphics(config, dir, project));
        // Ducking (D85) needs the key media's loudness envelopes, noise removal (D88) its track's:
        // the cached ones now; the job measures the rest before rendering (one quick ffmpeg pass each).
        const envelopes = yield* Effect.promise(() => duckEnvelopes(bin, dir, sized, false));
        const burnCaptions = input.burnCaptions !== false;
        const motionBlur = input.motionBlur ?? motionBlurDefault(project, input.quality);
        const replan = (all: ReadonlyMap<string, SpeechEnvelope | null>) => planExport(sized, { mediaPath, ...size, graphic: (src) => graphics.get(src), envelopes: all, burnCaptions, motionBlur });
        const plan = replan(envelopes);
        if ("problem" in plan) return yield* new ExportError({ reason: "empty", message: plan.problem });
        const missing = yield* Effect.promise(() => missingMedia(plan));
        if (missing) return yield* new ExportError({ reason: "missing-media", message: missing });
        const id = randomUUID();
        const targetLufs = targetOfChoice(input.loudness, input.targetLufs);
        const job: ExportJob = {
          id,
          projectDir: dir,
          name: project.name,
          output,
          quality: input.quality,
          codec,
          ...(video.encoder !== undefined ? { encoder: video.encoder } : {}),
          ...(video.bitrateMbps !== undefined ? { bitrateMbps: video.bitrateMbps } : {}),
          loudness: input.loudness,
          ...(targetLufs !== undefined ? { targetLufs } : {}),
          phase: "queued",
          progress: 0,
          width: size.width,
          height: size.height,
          fps: video.fps ?? project.canvas.fps,
          seconds: Math.round((plan.frames / plan.fps) * 100) / 100,
          startedAt: new Date().toISOString(),
          ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
          ...(subtitlesFile ? { subtitlesFile } : {}),
          ...(input.subtitles?.track ? { subtitleTrack: subtitleLanguageTag(input.subtitles.language) } : {}),
          ...(burnCaptions ? {} : { burnCaptions: false }),
          ...(range ? { range } : {}),
          motionBlur,
          ...(input.agent ? { agent: true } : {}),
        };
        const controller = new AbortController();
        controllers.set(id, controller);
        yield* SubscriptionRef.update(jobsRef, (jobs) => {
          const finished = jobs.filter((j) => j.phase === "done" || j.phase === "failed" || j.phase === "cancelled");
          return [...jobs.filter((j) => !finished.includes(j)), ...finished.slice(-MAX_JOBS_KEPT), job];
        });
        // One at a time, outside the request: a dropped connection doesn't stop it.
        queue = queue.then(async () => {
          if (controller.signal.aborted) return; // cancelled while queued: already marked
          // Out of "queued" before anything async, so a cancel from now on waits for the cleanup.
          patch(id, { phase: "preparing", startedAt: new Date().toISOString() });
          running = runJob(job, plan, sized, mediaPath, input.overwrite === true, controller.signal, replan, envelopes, RASTER_CSS + fonts.kitCss);
          await running;
          running = undefined;
        }).finally(() => controllers.delete(id));
        return { jobId: id };
      });

    const cancel = (jobId: string) =>
      Effect.sync(() => {
        const controller = controllers.get(jobId);
        if (!controller) return;
        controller.abort();
        // Still waiting its turn: nothing to clean up, so it's cancelled now, not when the one ahead ends.
        const job = Effect.runSync(SubscriptionRef.get(jobsRef)).find((j) => j.id === jobId);
        if (job?.phase === "queued") patch(jobId, { phase: "cancelled", finishedAt: new Date().toISOString() });
      });

    // ---- the agent's frames ----

    const renderFrames = (frames: ReadonlyArray<number>, width: number, instead?: Project) =>
      Effect.gen(function* () {
        const open = yield* current;
        const { dir, mediaPath } = open;
        const project = instead ?? open.project;
        const bin = yield* Effect.promise(ffmpegBin);
        if (!bin) return yield* new ExportError({ reason: "no-ffmpeg", message: "ffmpeg isn't installed, so frames can't be rendered." });
        return yield* Effect.tryPromise({
          try: async (signal) => {
            const { graphics, fonts } = await projectGraphics(config, dir, project);
            return renderFramesWith(bin, project, mediaPath, graphics, frames, width, signal, RASTER_CSS + fonts.kitCss);
          },
          catch: (error) => new ExportError({ reason: "missing-media", message: (error as Error).message }),
        });
      });

    const frameSession = <A, E, R>(use: (session: FrameSessionShape) => Effect.Effect<A, E, R>, options: FrameSessionOptions = {}) =>
      Effect.gen(function* () {
        const { dir, project, mediaPath } = yield* current;
        const bin = yield* Effect.promise(ffmpegBin);
        if (!bin) return yield* new ExportError({ reason: "no-ffmpeg", message: "ffmpeg isn't installed, so frames can't be rendered." });
        const failed = (error: unknown) => new ExportError({ reason: "missing-media", message: (error as Error).message });
        return yield* Effect.acquireUseRelease(
          Effect.tryPromise({
            try: async () => {
              const { graphics, fonts } = await projectGraphics(config, dir, project);
              const life = new AbortController();
              const session = await openFrameSession(bin, project, mediaPath, graphics, life.signal, RASTER_CSS + fonts.kitCss, options);
              return { session, life };
            },
            catch: failed,
          }),
          ({ session }) =>
            use({
              render: (frames, width, o) => Effect.tryPromise({ try: (signal) => session.render(frames, width, { ...o, signal }), catch: failed }),
              // A sheet the session can't draw gets the sheet's own rasteriser.
              sheet: (cells, layout) => Effect.tryPromise({ try: () => session.sheet(cells, layout), catch: (error) => error }).pipe(Effect.catch(() => sheetImage(cells, layout))),
              rehearse: (budgetMs) => Effect.tryPromise({ try: (signal) => session.rehearse(budgetMs, { signal }), catch: failed }),
            }),
          ({ session, life }) =>
            Effect.promise(async () => {
              life.abort();
              await session.close();
            }),
        );
      });

    // ---- the agent's contact sheets ----

    const mediaFrames = (path: string, seconds: ReadonlyArray<number>, width: number, fps: number) =>
      Effect.gen(function* () {
        const bin = yield* Effect.promise(ffmpegBin);
        if (!bin) return yield* new ExportError({ reason: "no-ffmpeg", message: "ffmpeg isn't installed, so frames can't be pulled from the footage." });
        return yield* Effect.tryPromise({
          try: (signal) => mediaFramesWith(bin, path, seconds, width, fps, signal),
          catch: (error) => new ExportError({ reason: "source-media", message: (error as Error).message }),
        });
      });

    const sheetImage = (cells: ReadonlyArray<{ readonly jpeg: Buffer; readonly caption: string }>, layout: SheetLayout) =>
      Effect.tryPromise({
        // A rasteriser that stalls (seen once on a loaded machine) gets one fresh try.
        try: () => drawSheet(cells, layout).catch(() => drawSheet(cells, layout)),
        catch: (error) => new ExportError({ reason: "source-media", message: `Couldn't draw the contact sheet: ${(error as Error).message}` }),
      });

    const saveSubtitles = ({ output, overwrite }: { readonly output: string; readonly overwrite?: boolean | undefined }) =>
      Effect.gen(function* () {
        const { dir, project, mediaPath } = yield* current;
        const saved = yield* Effect.promise(() => saveSubtitlesFile(project, dir, mediaPath, output, overwrite === true));
        if ("reason" in saved) return yield* new ExportError({ reason: saved.reason, message: saved.message });
        return saved;
      });

    const measureLoudness = makePreviewLoudness();
    const previewLoudness = (targetLufs: number) =>
      Effect.gen(function* () {
        const { dir, project, mediaPath } = yield* current;
        const bin = yield* Effect.promise(ffmpegBin);
        if (!bin) return yield* new ExportError({ reason: "no-ffmpeg", message: "ffmpeg isn't installed, and Uncut needs it to measure the loudness." });
        // The cached envelopes only (ducking and noise removal as the preview hears them now).
        const envelopes = yield* Effect.promise(() => duckEnvelopes(bin, dir, project, false));
        const r = yield* Effect.promise(() => measureLoudness(bin, project, mediaPath, envelopes, targetLufs));
        if ("problem" in r) return yield* new ExportError({ reason: "empty", message: r.problem });
        return r;
      });

    const busy = () => Effect.runSync(SubscriptionRef.get(jobsRef)).some((j) => j.phase === "queued" || j.phase === "preparing" || j.phase === "rendering");
    return Exporter.of({ start, cancel, jobs: SubscriptionRef.changes(jobsRef), jobList: SubscriptionRef.get(jobsRef), busy, renderFrames, frameSession, mediaFrames, sheetImage, saveSubtitles, previewLoudness });
  }),
);
