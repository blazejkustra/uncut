// One export job, from measuring and drawing to the moved file (inside the Exporter layer).
import { rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { ExportJob } from "@uncut/contracts";
import { denoiseMediaIds, duckMediaIds, flattenCues, subtitleCues, subtitleFormatOf, writeSubtitles, type Media, type Project, type SpeechEnvelope } from "@uncut/core";

import { shadeLayers } from "../shaderPass.ts";
import { exportCommand, planLoudness, RASTER_CSS, graphFileArgs, hardwareEncoderFailed, usesHardware, silentFailure, type ExportPlan } from "../exportPlan.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../rasterizer.ts";
import { overwritesImported } from "../subtitleSources.ts";
import { exists, makeTemp, writeLuts, replacesMedia, moveInto, plainFsError } from "./files.ts";
import { Cancelled, capsOf, untaggedFiles, run, ffmpegError } from "./ffmpeg.ts";
import { rasterise } from "./rasterise.ts";
import { graphicMediaSource, type GraphicMediaSource } from "../graphicMedia.ts";
import { track } from "../../telemetry/telemetry.ts";
import type { EXPORT_FAIL_CODES } from "../../telemetry/events.ts";

export interface RunJobCtx {
  readonly patch: (id: string, change: Partial<ExportJob>) => void;
  readonly ffmpegBin: () => Promise<string | undefined>;
  readonly missingMedia: (plan: ExportPlan) => Promise<string | undefined>;
  readonly duckEnvelopes: (bin: string, dir: string, project: Project, measure: boolean, signal?: AbortSignal) => Promise<Map<string, SpeechEnvelope | null>>;
}

export const makeRunJob = (ctx: RunJobCtx) => {
  const { patch, ffmpegBin, missingMedia, duckEnvelopes } = ctx;
  const runJob = async (job: ExportJob, planned: ExportPlan, project: Project, mediaPath: (m: Media) => string, overwrite: boolean, signal: AbortSignal, replan: (envelopes: ReadonlyMap<string, SpeechEnvelope | null>) => ExportPlan | { readonly problem: string }, cachedEnvelopes: ReadonlyMap<string, SpeechEnvelope | null>, css: string = RASTER_CSS) => {
    let plan = planned;
    const started = Date.now();
    let temp: string | undefined;
    let rasterizer: Rasterizer | undefined;
    let graphicMedia: GraphicMediaSource | undefined;
    let end: Partial<ExportJob> = { phase: "failed" };
    // Telemetry (D223): where a failed export stopped, as a fixed code (never its message).
    let stage: (typeof EXPORT_FAIL_CODES)[number] = "no-ffmpeg";
    let usedEncoder: "hardware" | "software" | undefined;
    try {
      const bin = await ffmpegBin();
      stage = "measure";
      if (!bin) throw new Error("ffmpeg isn't installed. Install it (brew install ffmpeg), then export again.");
      // Ducking (D85) / noise removal (D88) media whose loudness isn't cached: measured here, in
      // the job (export.start answers at once; the analysis queue waits for exports), then planned again.
      const needed = [...new Set([...duckMediaIds(project), ...denoiseMediaIds(project)])];
      if (needed.some((id) => !cachedEnvelopes.has(id))) {
        const envelopes = await duckEnvelopes(bin, job.projectDir, project, true, signal);
        const again = replan(envelopes);
        if (!("problem" in again)) {
          plan = again;
          patch(job.id, plan.warnings.length ? { warnings: plan.warnings } : { warnings: [] });
        }
      }
      stage = "missing-media";
      const missing = await missingMedia(plan);
      if (missing) throw new Error(missing);
      stage = "rasterise";
      const caps = await capsOf(bin);
      temp = await makeTemp();
      if (signal.aborted) throw new Cancelled();

      const command = rasterizerCommand();
      if ("problem" in command) throw new Error(command.problem);
      // D290: the pictures of project media its graphics draw, decoded from the originals.
      graphicMedia = graphicMediaSource({ bin, media: () => project.media, mediaPath, videotoolbox: caps.videotoolboxDecode });
      rasterizer = await startRasterizer(command, undefined, { media: graphicMedia.file });
      const onAbort = () => void rasterizer?.close();
      signal.addEventListener("abort", onAbort, { once: true });
      const { background, rasters } = await rasterise(rasterizer, plan, project, mediaPath, temp, signal, css);
      // Shader effects (D213): their frames drawn with the rasteriser's WebGPU, kept for the encode.
      const untagged = await untaggedFiles(bin, plan, signal);
      stage = "shader";
      const shaded = await shadeLayers(rasterizer, bin, plan, { caps, untagged }, temp, signal);
      signal.removeEventListener("abort", onAbort);
      await rasterizer.close();
      rasterizer = undefined;
      stage = "loudness";

      // Loudness (D87): one gain to the target before the master limiter (D86), checked through it
      // when it will work; with the limiter bypassed, two-pass loudnorm (exportPlan planLoudness).
      const { loudness, loudnorm } =
        job.targetLufs === undefined
          ? {}
          : await planLoudness(plan, job.targetLufs, async (pass, name) => {
              const graphFile = join(temp!, name);
              await writeFile(graphFile, pass.graph);
              const r = await run(bin, ["-hide_banner", "-nostdin", ...pass.inputs, ...graphFileArgs(caps, graphFile), ...pass.outputArgs], signal);
              if (r.code !== 0) throw new Error(`Measuring the loudness failed: ${ffmpegError(r.stderr)}`);
              return r.stderr;
            });

      stage = "encode";
      const partial = join(temp, "export.mp4");
      // Subtitles (D105): the cues of the project as it was when the export started, in the edit's time.
      const cues = job.subtitleTrack || job.subtitlesFile ? subtitleCues(project) : [];
      let subtitles: { file: string; language: string; show: boolean } | undefined;
      if (job.subtitleTrack) {
        // On by default only when the picture has no captions of its own (else players would show them twice).
        subtitles = { file: join(temp, "subtitles.srt"), language: job.subtitleTrack, show: job.burnCaptions === false };
        // One cue at a time in an mp4 (mov_text): overlapping cues stacked into one.
        await writeFile(subtitles.file, writeSubtitles(flattenCues(cues), plan.fps, "srt"));
      }
      const luts = await writeLuts(plan, temp);
      const video = { codec: job.codec, encoder: job.encoder, bitrateMbps: job.bitrateMbps, fps: job.fps };
      const total = plan.frames / plan.fps;
      const graphFile = join(temp, "graph.txt");
      const encode = async (choice: typeof video) => {
        const cmd = exportCommand(plan, { untagged, background, rasters, caps, quality: job.quality, video: choice, loudnorm, loudness, output: partial, subtitles, luts, shaded });
        await writeFile(graphFile, cmd.graph);
        const renderStart = Date.now();
        patch(job.id, { phase: "rendering", progress: 0 });
        let lastPatch = 0;
        return run(
          bin,
          ["-hide_banner", "-nostdin", "-y", "-nostats", "-progress", "pipe:1", "-stats_period", "0.25", ...cmd.inputs, ...graphFileArgs(caps, graphFile), ...cmd.outputArgs],
          signal,
          (line) => {
            const m = /^out_time_us=(\d+)/.exec(line);
            if (!m) return;
            const progress = Math.min(0.999, Number(m[1]) / 1e6 / total);
            const now = Date.now();
            if (now - lastPatch < 200) return;
            lastPatch = now;
            const elapsed = (now - renderStart) / 1000;
            patch(job.id, { progress, ...(progress > 0.02 ? { etaSeconds: Math.round((elapsed * (1 - progress)) / progress) } : {}) });
          },
        );
      };
      const hardware = usesHardware(job.quality, caps, video);
      usedEncoder = hardware ? "hardware" : "software";
      patch(job.id, { encoder: usedEncoder });
      let r = await encode(video);
      // D212: VideoToolbox can be listed and still refuse (no constant-quality mode on an Intel Mac,
      // no free hardware session): the same export again with the software encoder.
      if (r.code !== 0 && !signal.aborted && hardware && hardwareEncoderFailed(r.stderr)) {
        patch(job.id, { encoder: "software", warnings: [...(plan.warnings ?? []), "The hardware encoder failed on this Mac, so the software one made the video."] });
        usedEncoder = "software";
        r = await encode({ ...video, encoder: "software" });
      }
      if (r.code !== 0) throw new Error(`ffmpeg couldn't make the video: ${ffmpegError(r.stderr)}`);
      if (signal.aborted) throw new Cancelled();
      const silent = silentFailure(r.stderr);
      if (silent) throw new Error(`ffmpeg couldn't draw part of the video: ${silent}`);
      stage = "move";
      if (!job.output) throw new Error("no output");
      // The destination may have appeared while rendering; replace it only if allowed.
      if (!overwrite && (await exists(job.output))) throw new Error(`${basename(job.output)} appeared in that folder while exporting; the export wasn't moved there.`);
      if (await replacesMedia(job.output, plan)) throw new Error(`Saving as ${basename(job.output)} would replace footage this project uses. Choose another name or folder.`);
      if (job.subtitlesFile) {
        const imported = await overwritesImported(job.projectDir, job.subtitlesFile);
        if (imported) throw new Error(imported);
      }
      if (job.subtitlesFile && !overwrite && (await exists(job.subtitlesFile))) throw new Error(`${basename(job.subtitlesFile)} appeared in that folder while exporting; the export wasn't moved there.`);
      let sidecar: string | undefined;
      if (job.subtitlesFile) {
        sidecar = join(temp, basename(job.subtitlesFile));
        await writeFile(sidecar, writeSubtitles(cues, plan.fps, subtitleFormatOf(job.subtitlesFile) ?? "srt"));
      }
      try {
        await moveInto(partial, job.output);
        if (sidecar && job.subtitlesFile) await moveInto(sidecar, job.subtitlesFile);
      } catch (error) {
        throw new Error(plainFsError(error, dirname(job.output)));
      }
      end = { phase: "done", progress: 1, etaSeconds: 0 };
    } catch (error) {
      const cancelled = error instanceof Cancelled || signal.aborted;
      end = cancelled ? { phase: "cancelled" } : { phase: "failed", error: (error as NodeJS.ErrnoException)?.code ? plainFsError(error, "the temp folder") : (error as Error).message || "The export stopped unexpectedly." };
    } finally {
      // Everything it started and wrote is gone before the job says it's over.
      await rasterizer?.close().catch(() => {});
      graphicMedia?.close();
      if (temp) await rm(temp, { recursive: true, force: true }).catch(() => {});
    }
    const durationMs = Date.now() - started;
    if (end.phase === "done") {
      track("export:complete", {
        duration_ms: durationMs,
        output_ms: Math.round((plan.frames / plan.fps) * 1000),
        quality: job.quality,
        codec: job.codec ?? "h264",
        encoder: usedEncoder,
        width: job.width,
        height: job.height,
        fps: job.fps,
        range: job.range !== undefined,
        subtitles: Boolean(job.subtitlesFile || job.subtitleTrack),
      });
    } else if (end.phase === "cancelled") track("export:cancel", { duration_ms: durationMs });
    else track("export:fail", { code: stage, duration_ms: durationMs });
    patch(job.id, { ...end, finishedAt: new Date().toISOString(), elapsedSeconds: Math.round((Date.now() - started) / 100) / 10 });
  };
  return runJob;
};
