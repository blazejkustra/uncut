// The agent's media tools: media_import, contact_sheet, media_analyze and the analysis helpers they share.
import { basename, isAbsolute, resolve } from "node:path";
import type { Analyzer } from "@uncut/contracts";
import { type Project, decodeEnvelope, describeOp, type Op, duckMediaIds, layout, type SpeechEnvelope } from "@uncut/core";
import * as Effect from "effect/Effect";
import {
  cachedFor,
  parseAnalyzers,
  targetOf,
  type AnalysisTarget,
  type LoudnessResult,
  type Outcome,
  type RequestOptions,
  type SilenceRange,
} from "../../analysis/analysis.ts";
import { transcriptSummary } from "../agentTranscript.ts";
import { BEATS_NOTE, beatsOut } from "../agentBeats.ts";
import type { BeatsResult } from "../../analysis/beats.ts";
import type { TranscriptResult } from "../../analysis/transcription.ts";
import { framesFor, shotCells, VIDEO_NOTE, videoOut } from "../agentVideo.ts";
import { capSkipped, CELL_WIDTH, clock, DEFAULT_CELLS, MAX_CELLS, planImport, sheetFrames, sheetLayout } from "../agentFootage.ts";
import { shownPath } from "../agentPermissions.ts";
import type { MediaEntry } from "../../media/media.ts";
import { importablePath } from "../../media/mediaIndex.ts";
import type { ProjectView } from "../../project/projects.ts";
import type { VideoResult } from "../../analysis/videoAnalysis.ts";
import { type Running, pushEdit } from "../session/types.ts";
import { noteFor } from "../turns/notes.ts";
import { realOr, analyzeWaitMs, SILENCES_WAIT_MS, columnsNote, loudnessOut } from "./common.ts";
import type { CoreCtx } from "../session/core.ts";
import type { makeMeasureTools } from "./measure.ts";

export const makeMediaTools = (ctx: CoreCtx) => {
  const { textResult, media, persist, publish, view, analysis, exporter } = ctx;

  // ---- tools ----

  /** A media entry as media_import returns it: its probe in project terms. */
  const entryInfo = (e: MediaEntry, fps: number) => ({
    id: e.id,
    kind: e.kind,
    name: e.name,
    path: e.path,
    ...(e.probe.frames ? { frames: e.probe.frames, seconds: Number((e.probe.frames / fps).toFixed(2)) } : {}),
    ...(e.probe.fps ? { fps: Number(e.probe.fps.toFixed(3)) } : {}),
    ...(e.probe.width ? { width: e.probe.width, height: e.probe.height } : {}),
    hasAudio: e.probe.hasAudio,
  });

  // media_import (D65): files or a folder's media files, through the Library's import job but
  // as the agent's edit (one entry in the turn, so Undo turn takes it back and the next
  // manual-edit note doesn't list it).
  const mediaImport = (r: Running, v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const hasPath = args.path !== undefined;
      const hasPaths = args.paths !== undefined;
      if (hasPath === hasPaths) return textResult("Pass path (one file or folder) or paths (a list of them), not both.", true);
      if (hasPaths && !Array.isArray(args.paths)) return textResult("paths must be a list of absolute paths.", true);
      const raw: ReadonlyArray<unknown> = hasPath ? [args.path] : (args.paths as ReadonlyArray<unknown>);
      const name = typeof args.name === "string" ? args.name.trim() : undefined;
      if (args.name !== undefined && !name) return textResult("name must be a non-empty string.", true);
      const planned = yield* Effect.promise(() => planImport(raw, v.dir));
      if ("refused" in planned) return textResult(planned.refused, true);
      let plan = planned;
      if (name && plan.files.length !== 1) return textResult("name is only for importing one file; leave it out for a folder or several paths.", true);
      if (!plan.files.length) return textResult({ imported: [], ...capSkipped(plan.skipped), failed: [], note: "Nothing to import: no media files there." });
      // D205 (D12): a file inside another project's folder or this one's .cache/work/ is copied into
      // this one's media/imports (that project may move or go, the cache is disposable); anything
      // else is referenced where it is.
      const copied: Array<string> = [];
      const files: Array<string> = [];
      for (const f of plan.files) {
        const target = yield* Effect.promise(() => importablePath(f, v.dir).catch(() => ({ path: f, copied: false })));
        files.push(target.path);
        if (target.copied) copied.push(shownPath(target.path, v.dir));
      }
      plan = { ...plan, files };
      // Uninterruptible: a turn stopped mid-import still gets the edit on its card (so Undo turn
      // can take back media the job adds anyway).
      const outcome = yield* Effect.uninterruptible(
        media
          .importForAgent({
            openId: r.openId,
            dir: v.dir,
            turnId: r.turn.id,
            paths: plan.files,
            names: name ? new Map([[plan.files[0]!, name]]) : undefined,
            ...(copied.length ? { relativePaths: true } : {}),
          })
          .pipe(
            Effect.map((value) => {
              const { snapshot, entries } = value;
              const subs = value.subtitles ?? [];
              if (snapshot) {
                const lines = [
                  ...entries.map((entry) => describeOp({ op: "add_media", media: entry } as Op, snapshot.project as Project)),
                  ...subs.map((s) => `Imported ${s.cues} subtitle cue${s.cues === 1 ? "" : "s"} from ${basename(s.path)} as track ${s.track}`),
                ];
                const count = entries.length + subs.length;
                pushEdit(r, {
                  revision: snapshot.revision,
                  summary:
                    count === 1
                      ? entries.length
                        ? `Imported ${entries[0]!.name}`
                        : `Imported subtitles ${basename(subs[0]!.path)}`
                      : `Imported ${count} files`,
                  lines,
                  ...(entries.length ? { media: entries.map((e) => e.id) } : {}),
                });
                persist(r.owner);
                publish();
                // The agent may edit from the revision it gets back: user edits made since its last
                // read are in that state, and come back with the result (userChanges), so it knows.
                r.owner.seen.add(snapshot.revision);
              }
              const now = view();
              return { ok: true as const, value, userChanges: snapshot && now ? noteFor(now, r.owner.agentSeen) : "" };
            }),
            Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
          ),
      );
      if (!outcome.ok) return textResult(`The import didn't finish: ${outcome.message}`, true);
      const { snapshot, entries, skipped, failed } = outcome.value;
      const project = (snapshot?.project ?? v.session.project) as Project;
      // Files already in the project say which media they are.
      const byPath = new Map<string, string>();
      for (const m of project.media) byPath.set(yield* Effect.promise(() => realOr(m.path, v.dir)), m.id);
      const skippedOut: Array<{ path: string; reason: string; id?: string }> = [...plan.skipped];
      for (const s of skipped) {
        const id = byPath.get(yield* Effect.promise(() => realOr(s.path, v.dir)));
        skippedOut.push(id ? { ...s, id } : s);
      }
      return textResult({
        ...(snapshot ? { revision: snapshot.revision } : {}),
        imported: entries.map((e) => entryInfo(e, project.canvas.fps)),
        // Subtitles (D105): a Subtitles text track of plain text items, one per cue, at the edit's frames.
        ...(outcome.value.subtitles?.length
          ? {
              subtitles: outcome.value.subtitles.map((s) => ({
                ...s,
                note: `Text items on track ${s.track}, one per cue; subtitles_export writes them (with any captions) as .srt or .vtt.`,
              })),
            }
          : {}),
        ...capSkipped(skippedOut),
        failed,
        ...(copied.length
          ? { copied, copiedNote: "These lived inside another project or in .cache/work/, so they were copied into this project's media/imports (D12)." }
          : {}),
        ...(entries.length ? { note: "Frames, in and duration are project frames; probe frames is each file's length in them." } : {}),
        ...(outcome.userChanges
          ? {
              userChanges: outcome.userChanges,
              userNote: "The user changed the project since your read; the revision above includes their changes. Keep them.",
            }
          : {}),
      });
    });

  // Starts (or joins) analysis jobs and waits up to ANALYZE_WAIT_MS for them: each comes back
  // with its outcome, or without one (still queued or running; the job says how far).
  const requestAndWait = (requests: ReadonlyArray<{ readonly target: AnalysisTarget; readonly analyzer: Analyzer; readonly options?: RequestOptions }>) =>
    Effect.promise(async () => {
      const requested = await Promise.all(requests.map(async (q) => ({ ...q, r: await analysis.request(q.target, q.analyzer, q.options) })));
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<undefined>((r) => (timer = setTimeout(r, analyzeWaitMs(), undefined)));
      timer?.unref();
      try {
        return await Promise.all(
          requested.map(async ({ target, analyzer, r }) => ({
            target,
            analyzer,
            jobId: r.job?.id,
            outcome: (await Promise.race([r.done, deadline])) as Outcome | undefined,
          })),
        );
      } finally {
        clearTimeout(timer);
      }
    });
  /** A job still going, as the agent sees it. */
  const pendingOut = (jobId: string | undefined) => {
    const job = jobId ? analysis.job(jobId) : undefined;
    if (job?.phase === "queued")
      return {
        state: "queued" as const,
        ...(job.waiting ? { waitingFor: "an export to finish" } : job.analyzer === "transcript" ? { waitingFor: "another transcript to finish" } : {}),
      };
    return {
      state: "running" as const,
      progress: job?.progress ?? 0,
      ...(job?.stage === "model" ? { stage: "downloading the speech model (first transcript only)" } : {}),
    };
  };
  /**
   * The loudness analyzer's silences and speech envelope: transcript pauses and cuts by text are
   * aligned to them (D74: whisper's word edges alone clip words). Cached, or (transcript_edit, which cuts) the loudness
   * pass is run (one quick ffmpeg pass, a few seconds for a long talk) and waited for up to
   * SILENCES_WAIT_MS; without them (it failed, or an export holds the queue) the transcript's own
   * edges are used. `run` false: cached only (transcript_read and media_analyze's summary only
   * report; media_analyze runs loudness when asked).
   */
  const soundOf = (loud: LoudnessResult | undefined) => (loud?.hasAudio ? { silences: loud.silence?.ranges, envelope: decodeEnvelope(loud.envelope) } : {});
  const silencesOf = async (
    target: AnalysisTarget,
    run = true,
  ): Promise<{ silences?: ReadonlyArray<SilenceRange> | undefined; envelope?: SpeechEnvelope | undefined }> => {
    const cached = (await cachedFor(target, "loudness")) as LoudnessResult | undefined;
    if (cached) return soundOf(cached);
    if (!run) return {};
    const { done } = await analysis.request(target, "loudness");
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<undefined>((r) => (timer = setTimeout(r, Math.min(SILENCES_WAIT_MS, analyzeWaitMs()), undefined)));
    timer?.unref();
    try {
      const outcome = await Promise.race([done, deadline]);
      return soundOf(outcome?.state === "done" ? (outcome.result as LoudnessResult) : undefined);
    } finally {
      clearTimeout(timer);
    }
  };
  /**
   * Ducking's key media without a loudness analysis (D85): started together and waited for up to
   * SILENCES_WAIT_MS. A sentence for timeline_edit's answer saying, per media, measured (heard now),
   * no sound (nothing to duck under), couldn't be measured, or still measuring; undefined when all
   * were measured already.
   */
  const duckAnalysis = async (dir: string, project: Project): Promise<string | undefined> => {
    const fps = project.canvas.fps;
    const pending = [];
    for (const id of duckMediaIds(project)) {
      const m = project.media.find((x) => x.id === id);
      if (!m) continue;
      const target = targetOf(dir, m, fps);
      if (await cachedFor(target, "loudness")) continue;
      pending.push({ name: m.name ?? id, target });
    }
    if (!pending.length) return undefined;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"waiting">((r) => (timer = setTimeout(() => r("waiting"), Math.min(SILENCES_WAIT_MS, analyzeWaitMs()))));
    timer?.unref();
    try {
      const outcomes = await Promise.all(
        pending.map(async (p) => {
          const { done } = await analysis.request(p.target, "loudness");
          const o = await Promise.race([done, deadline]);
          if (o === "waiting") return { name: p.name, kind: "waiting" as const };
          if (o.state === "done") return { name: p.name, kind: (o.result as LoudnessResult).hasAudio ? ("measured" as const) : ("silent" as const) };
          return { name: p.name, kind: "failed" as const, why: o.state === "failed" ? o.error : "it was stopped" };
        }),
      );
      const of = (kind: string) => outcomes.filter((o) => o.kind === kind);
      const list = (xs: ReadonlyArray<{ name: string }>) => xs.map((x) => x.name).join(", ");
      return [
        of("measured").length ? `Measured the loudness of ${list(of("measured"))} for ducking: it's heard now.` : "",
        of("silent").length ? `${list(of("silent"))} has no sound, so nothing ducks under it.` : "",
        ...of("failed").map(
          (o) => `The loudness of ${o.name} couldn't be measured (${"why" in o ? o.why : ""}), so nothing ducks under it; media_analyze loudness tries again.`,
        ),
        of("waiting").length
          ? `Still measuring the loudness of ${list(of("waiting"))} for ducking; nothing ducks under it until that's done (media_analyze loudness follows it).`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
    } finally {
      clearTimeout(timer);
    }
  };
  const cancelledNote = "The analysis was stopped (by the user, or the project closed) before it finished. Ask again to run it.";

  // contact_sheet (D65): frames of a media file (pulled from the original, 0:v:0) or of the edit
  // (exporter.renderFrames), in a grid with each cell's frame and time, as one JPEG.
  const contactSheet = (v: ProjectView, args: Record<string, unknown>, onFrames?: (frames: ReadonlyArray<number>) => void) =>
    Effect.gen(function* () {
      if (args.at !== undefined && args.at !== "every" && args.at !== "shots") return textResult('at must be "every" or "shots".', true);
      const atShots = args.at === "shots";
      if (atShots && typeof args.media !== "string")
        return textResult('at "shots" needs media: the shots of a media file (one frame per shot). For the edit, use every or max.', true);
      if (atShots && args.every !== undefined) return textResult('every goes with at "every"; at "shots" shows one frame per shot (max caps how many).', true);
      const int = (value: unknown, lo: number, hi: number) =>
        value === undefined ? undefined : Number.isInteger(value) && (value as number) >= lo && (value as number) <= hi ? (value as number) : null;
      const every = int(args.every, 1, Number.MAX_SAFE_INTEGER);
      const columns = int(args.columns, 1, 10);
      const max = int(args.max, 1, MAX_CELLS);
      if (every === null) return textResult("every must be a whole number of frames, at least 1.", true);
      if (columns === null) return textResult("columns must be 1 to 10.", true);
      if (max === null) return textResult(`max must be 1 to ${MAX_CELLS}.`, true);
      const range = args.range as { start?: unknown; end?: unknown } | undefined;
      if (range !== undefined && (typeof range !== "object" || !Number.isInteger(range.start) || !Number.isInteger(range.end) || (range.start as number) < 0)) {
        return textResult("range must be { start, end } in whole frames (start from 0).", true);
      }
      const project = v.session.project;
      const fps = project.canvas.fps;
      const limit = max ?? (every !== undefined ? MAX_CELLS : DEFAULT_CELLS);
      if (typeof args.media === "string") {
        const m = project.media.find((x) => x.id === args.media);
        if (!m)
          return textResult(
            `There's no media "${args.media}". project_read lists the media ids: ${project.media.map((x) => x.id).join(", ") || "(none yet)"}.`,
            true,
          );
        if (m.kind !== "video")
          return textResult(
            `${m.id} is ${m.kind === "audio" ? "a sound file, with no picture" : "a still image; render_frames or the preview shows it"}. contact_sheet takes video.`,
            true,
          );
        const length = m.probe?.frames ?? 0;
        if (!length) return textResult(`${m.id} has no known length, so it can't be sampled.`, true);
        const start = range ? (range.start as number) : 0;
        const end = range ? Math.min(range.end as number, length) : length;
        let frames: ReadonlyArray<number> | { readonly refused: string };
        let shotLines: Array<string> | undefined;
        let shotNote = "";
        if (atShots) {
          if (start >= end)
            return textResult(
              start >= length ? `${m.id} is ${length} frames long; the range starts after its end.` : `The range is empty (${start} to ${end}).`,
              true,
            );
          // The shots come from the video analysis (cached, or run now, joining a running job).
          const [answer] = yield* requestAndWait([{ target: targetOf(v.dir, m, fps), analyzer: "video" }]);
          const outcome = answer!.outcome;
          if (!outcome) {
            const p = pendingOut(answer!.jobId);
            return textResult({
              media: m.id,
              video: p,
              note: `Finding the shots needs the video analysis, which is still ${p.state === "queued" ? "waiting" : "running"} after ${Math.round(analyzeWaitMs() / 1000)} s. Call contact_sheet again with the same arguments; it joins the running job.`,
            });
          }
          if (outcome.state === "failed") return textResult(`Couldn't find the shots of ${m.id}: ${outcome.error}`, true);
          if (outcome.state === "cancelled") return textResult(`Couldn't find the shots of ${m.id}: ${cancelledNote}`, true);
          const result = outcome.result as VideoResult;
          if (!result.hasVideo) return textResult(`ffmpeg found no picture in ${m.id}.`, true);
          const cells = shotCells(result, fps, length, range ? { start, end } : undefined, limit);
          if (!cells.shots.length) return textResult(`No shot of ${m.id} overlaps frames ${start}–${end}.`, true);
          frames = cells.shots.map((x) => x.frame);
          shotLines = cells.shots.map((x) => `shot frames ${x.start}–${x.end} (${clock(x.start / fps)}–${clock(x.end / fps)})`);
          shotNote = `${cells.total} shot${cells.total === 1 ? "" : "s"}${range ? " in the range" : ""}${cells.total > cells.shots.length ? `, ${cells.shots.length} of them shown (spread evenly; pass a range or max for others)` : ""}; each cell is the middle frame of its shot, and its line says the shot's frames [start, end).${range ? " A shot that only overlaps the range is shown whole, so its middle frame can lie outside the range." : ""}`;
        } else frames = sheetFrames(start, end, every, limit);
        if ("refused" in frames)
          return textResult(range && start >= length ? `${m.id} is ${length} frames long; the range starts after its end.` : frames.refused, true);
        const aspect = m.probe?.width && m.probe?.height ? m.probe.width / m.probe.height : 16 / 9;
        const grid = sheetLayout(frames.length, aspect, columns);
        const path = isAbsolute(m.path) ? m.path : resolve(v.dir, m.path);
        const sheet = yield* exporter
          .mediaFrames(
            path,
            frames.map((f) => f / fps),
            CELL_WIDTH,
            fps,
          )
          .pipe(
            Effect.flatMap((pulled) => {
              // A moment past the end of the picture shows its last frame: label the cell with the frame shown.
              const shown = pulled.map((p, i) => (p.seconds < frames[i]! / fps ? Math.floor(p.seconds * fps + 1e-6) : frames[i]!));
              return exporter
                .sheetImage(
                  pulled.map((p, i) => ({ jpeg: p.jpeg, caption: `${i + 1}   f ${shown[i]}   ${clock(shown[i]! / fps)}` })),
                  grid,
                )
                .pipe(Effect.map((jpeg) => ({ jpeg, shown })));
            }),
            Effect.map(({ jpeg, shown }) => ({ ok: true as const, jpeg, shown })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
          );
        if (!sheet.ok) return textResult(`Couldn't make the contact sheet: ${sheet.message}`, true);
        const cells = sheet.shown.map((f, i) => `${i + 1}: frame ${f} (${clock(f / fps)})${shotLines ? `, ${shotLines[i]}` : ""}`);
        const past = frames.flatMap((f, i) =>
          sheet.shown[i] !== f ? [`frame ${f} is past the end of the picture, so cell ${i + 1} shows its last frame, ${sheet.shown[i]}`] : [],
        );
        const notes = [shotNote, columnsNote(columns, grid.columns), past.length ? `Note: ${past.join("; ")}.` : ""].filter(Boolean).join(" ");
        return {
          content: [
            {
              type: "text" as const,
              text: `Contact sheet of ${m.id} (${m.name}), ${frames.length} cells in ${grid.columns} columns, ${grid.width}×${grid.height}, read left to right, top to bottom. Frames are project frames of the media (use them as in; ${fps} per second), times are media time; each cell is the frame the preview and export show there.${notes ? ` ${notes}` : ""}\n${cells.join("\n")}`,
            },
            { type: "image" as const, data: sheet.jpeg.toString("base64"), mimeType: "image/jpeg" },
          ],
        };
      }
      if (args.media !== undefined) return textResult("media must be a media id.", true);
      const { duration } = layout(project);
      const total = project.tracks.some((t) => t.items.length) ? duration : 0;
      if (!total) return textResult("The timeline is empty: there's nothing to sample yet. Pass media to look at a media file.", true);
      const start = range ? (range.start as number) : 0;
      const end = range ? Math.min(range.end as number, total) : total;
      if (start >= total) return textResult(`The edit is ${total} frames long; the range starts after its end.`, true);
      const frames = sheetFrames(start, end, every, limit);
      if ("refused" in frames) return textResult(frames.refused, true);
      const grid = sheetLayout(frames.length, project.canvas.width / project.canvas.height, columns);
      const sheet = yield* exporter.renderFrames(frames, CELL_WIDTH).pipe(
        Effect.flatMap((list) =>
          exporter
            .sheetImage(
              list.map((f, i) => ({ jpeg: f.jpeg, caption: `${i + 1}   f ${f.frame}   ${clock(f.frame / fps)}` })),
              grid,
            )
            .pipe(Effect.map((jpeg) => ({ jpeg, shown: list.map((f) => f.frame) }))),
        ),
        Effect.map(({ jpeg, shown }) => ({ ok: true as const, jpeg, shown })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
      );
      if (!sheet.ok) return textResult(`Couldn't make the contact sheet: ${sheet.message}`, true);
      onFrames?.(sheet.shown);
      const cells = sheet.shown.map((f, i) => `${i + 1}: frame ${f} (${clock(f / fps)})`);
      const notes = columnsNote(columns, grid.columns);
      return {
        content: [
          {
            type: "text" as const,
            text: `Contact sheet of the edit (revision ${v.session.revision}), ${frames.length} cells in ${grid.columns} columns, ${grid.width}×${grid.height}, drawn as the export draws them, read left to right, top to bottom.${notes ? ` ${notes}` : ""}\n${cells.join("\n")}`,
          },
          { type: "image" as const, data: sheet.jpeg.toString("base64"), mimeType: "image/jpeg" },
        ],
      };
    });

  // media_analyze (D66): starts (or joins) the analysis jobs, waits up to ANALYZE_WAIT_MS for them,
  // and returns the results, or "running" with progress so the agent asks again. A cached
  // result comes back at once without ffmpeg. Stopping the turn doesn't stop the jobs: their
  // results land in the cache for the next ask.
  const mediaAnalyze = (v: ProjectView, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const project = v.session.project;
      if (typeof args.media !== "string") return textResult("Pass media: a media id from project_read.", true);
      const m = project.media.find((x) => x.id === args.media);
      if (!m)
        return textResult(
          `There's no media "${args.media}". project_read lists the media ids: ${project.media.map((x) => x.id).join(", ") || "(none yet)"}.`,
          true,
        );
      const parsed = parseAnalyzers(args.analyzers);
      if ("refused" in parsed) return textResult(parsed.refused, true);
      const range = args.range as { start?: unknown; end?: unknown } | undefined;
      if (
        range !== undefined &&
        (typeof range !== "object" ||
          !Number.isInteger(range.start) ||
          !Number.isInteger(range.end) ||
          (range.start as number) < 0 ||
          (range.end as number) <= (range.start as number))
      ) {
        return textResult("range must be { start, end } in whole project frames of the media, start from 0 and before end.", true);
      }
      const fps = project.canvas.fps;
      const length = m.probe?.frames;
      const target = targetOf(v.dir, m, fps);
      const waitMs = analyzeWaitMs();
      const results = yield* requestAndWait(parsed.analyzers.map((analyzer) => ({ target, analyzer })));
      const frames = framesFor(fps, length);
      const out: Record<string, unknown> = { media: m.id };
      let pending = false;
      for (const { analyzer, jobId, outcome } of results) {
        if (!outcome) {
          pending = true;
          out[analyzer] = pendingOut(jobId);
          continue;
        }
        if (outcome.state === "failed") out[analyzer] = { state: "failed", error: outcome.error };
        else if (outcome.state === "cancelled") out[analyzer] = { state: "cancelled", note: cancelledNote };
        else if (analyzer === "video")
          out[analyzer] = videoOut(outcome.result as VideoResult, outcome.cached, frames, range as { start: number; end: number } | undefined, fps);
        else if (analyzer === "beats")
          out[analyzer] = beatsOut(outcome.result as BeatsResult, outcome.cached, frames, range as { start: number; end: number } | undefined, fps);
        else if (analyzer === "transcript")
          out[analyzer] = transcriptSummary(outcome.result as TranscriptResult, outcome.cached, yield* Effect.promise(() => silencesOf(target, false)));
        else out[analyzer] = loudnessOut(outcome.result as LoudnessResult, outcome.cached, frames, range as { start: number; end: number } | undefined);
      }
      // Finished results keep their explanation even while another analyzer is still going.
      const finished = new Set(results.filter((x) => x.outcome?.state === "done").map((x) => x.analyzer));
      const notes: Array<string> = [];
      if (pending)
        notes.push(
          `Still analysing after ${Math.round(waitMs / 1000)} s. Call media_analyze again with the same arguments to get the rest; it joins the running job (finished results come from the cache).`,
        );
      if (finished.has("loudness"))
        notes.push(
          "loudness: silences are where the sound stays below thresholdDb for at least minSeconds. start and end are project frames of the media (use them as in): start is the first silent frame, end the frame after the last, both inside the silence; startSeconds and endSeconds are media time. integratedLufs is the whole file's loudness (EBU R128; about −14 LUFS is usual for online video), loudnessRangeLu how much it varies, truePeakDbtp its loudest peak.",
        );
      if (finished.has("video")) notes.push(`video: ${VIDEO_NOTE}`);
      if (finished.has("beats")) notes.push(`beats: ${BEATS_NOTE}`);
      if (finished.has("transcript"))
        notes.push(
          "transcript: transcribed on this Mac (whisper.cpp). This is a summary; transcript_read gives the words with their frames, fillers and pauses.",
        );
      if (notes.length) out.note = notes.join(" ");
      return textResult(out);
    });

  return { requestAndWait, pendingOut, cancelledNote, silencesOf, mediaImport, entryInfo, contactSheet, mediaAnalyze, duckAnalysis };
};

export type MediaCtx = CoreCtx & ReturnType<typeof makeMediaTools> & ReturnType<typeof makeMeasureTools>;
