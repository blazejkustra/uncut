// Importing media into a project, as a server-side job: probe each file with the media core
// (ffprobe for formats it can't read), add them in one undoable edit to the project that was
// open when the import started, then make poster thumbnails. Footage is referenced by path,
// never copied (D12). Jobs run one at a time and aren't tied to the request that started them.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

import { ProjectError, type ImportJob, type MediaImportResult } from "@uncut/contracts";
import { planImportSubtitles, planReshoot, subtitleFormatOf, type ParsedCue, type Project } from "@uncut/core";
import { cameraName } from "@uncut/core/mentions";
import { planPlaceMulti, planPlaceTake, type MultiKind, type MultiLayoutName, type PlacedMulti, type TakePlacement } from "@uncut/core/place";
import { planPlaceMedia, type PlaceMedia } from "@uncut/core/arrange";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerConfig } from "../app/config.ts";
import { MediaCore, type ProbeInfo, type ProbeOutcome } from "./mediaCore.ts";
import { probeSvg } from "../export/svg.ts";
import { runProbe } from "./probe.ts";
import { MATCH_FIRST_CLIP, Projects } from "../project/projects.ts";
import { which } from "../app/setup.ts";
import { recordSubtitleSources } from "../export/subtitleSources.ts";
import { withoutApiKey } from "../app/shellEnv.ts";
import {
  MediaLibrary,
  type MediaEntry,
  type AgentImport,
  type MediaDrop,
  type ImportedSubtitles,
  type AgentImportInput,
  type CaptureImportInput,
  type MultiImportInput,
  type ReplaceMediaInput,
} from "./mediaLibrary/service.ts";
import {
  IMAGE_EXT,
  imageInput,
  fromFfprobe,
  posterKey,
  thumbDir,
  posterName,
  realOr,
  readSubtitleFile,
  PROBE_ERRORS,
  type ProjectShape,
  allIds,
  matchPending,
  matchCanvas,
  mediaId,
  storedPath,
  probeOf,
} from "./mediaLibrary/helpers.ts";
export { MediaLibrary } from "./mediaLibrary/service.ts";
export type {
  MediaLibraryShape,
  MediaDrop,
  CaptureImportInput,
  MultiImportInput,
  ReplaceMediaInput,
  ReplacedMedia,
  AgentImportInput,
  AgentImport,
  ImportedSubtitles,
  MediaEntry,
} from "./mediaLibrary/service.ts";
export { MAX_SUBTITLE_BYTES, readSubtitleFile, thumbDir, mediaId, posterKey } from "./mediaLibrary/helpers.ts";

const MAX_JOBS_KEPT = 10;

export const layer = Layer.effect(
  MediaLibrary,
  Effect.gen(function* () {
    const mediaCore = yield* MediaCore;
    const projects = yield* Projects;
    const config = yield* ServerConfig;
    // Jobs outlive the request that started them: they run in the server's scope.
    const scope = yield* Effect.scope;
    const oneAtATime = yield* Semaphore.make(1);
    const jobsRef = yield* SubscriptionRef.make<ReadonlyArray<ImportJob>>([]);

    const update = (id: string, patch: Partial<ImportJob>) =>
      SubscriptionRef.update(jobsRef, (jobs) => jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)));

    const tool = (name: string) =>
      Effect.promise(async () => {
        await config.shellReady;
        return which(name, process.env.PATH ?? "");
      });
    const run = (bin: string, args: ReadonlyArray<string>, timeoutMs: number, maxBytes?: number) =>
      Effect.promise(() => runProbe(bin, args, { timeoutMs, env: withoutApiKey(process.env), ...(maxBytes ? { maxBytes } : {}) }));

    const ffprobe = (path: string) =>
      Effect.gen(function* () {
        const bin = yield* tool("ffprobe");
        if (!bin) return undefined;
        const input = IMAGE_EXT.has(extname(path).toLowerCase()) ? imageInput(path) : [path];
        // D194: local files only (a downloaded "video" that is really a playlist can't make ffprobe fetch anything).
        const r = yield* run(
          bin,
          ["-v", "error", "-protocol_whitelist", "file,pipe", "-print_format", "json", "-show_streams", "-show_format", ...input],
          15000,
          1024 * 1024,
        );
        return r.kind === "done" && r.code === 0 ? fromFfprobe(r.stdout) : undefined;
      });

    /** A poster for a video or image in `dir`; false (and no file) if ffmpeg is missing or fails. */
    const makePoster = (stored: MediaEntry, info: ProbeInfo, dir: string) =>
      Effect.gen(function* () {
        const entry = { ...stored, path: isAbsolute(stored.path) ? stored.path : resolve(dir, stored.path) };
        // No poster for audio, nor for SVG (ffmpeg can't read it; the Library shows the file itself).
        if (entry.kind === "audio" || extname(entry.path).toLowerCase() === ".svg") return false;
        const bin = yield* tool("ffmpeg");
        const key = yield* Effect.promise(() => posterKey(entry.path));
        if (!bin || !key) return false;
        const folder = thumbDir(dir);
        yield* Effect.promise(() => mkdir(folder, { recursive: true }));
        const out = join(folder, posterName(entry.id, key));
        const at = entry.kind === "video" ? Math.min(1, (info.durationSeconds ?? 0) / 3) : 0;
        const input = entry.kind === "image" ? imageInput(entry.path) : ["-hwaccel", "videotoolbox", "-ss", at.toFixed(3), "-i", entry.path];
        const r = yield* run(
          bin,
          ["-v", "error", "-y", "-protocol_whitelist", "file,pipe", ...input, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", out],
          30000,
        );
        const ok = r.kind === "done" && r.code === 0;
        // Older posters for this id (another file, or this file before it changed) go.
        yield* Effect.promise(async () => {
          const files = await readdir(folder).catch(() => [] as Array<string>);
          await Promise.all(
            files
              .filter(
                (f) => f.startsWith(`${entry.id}--`) && /^[0-9a-f]{12}\.jpg$/.test(f.slice(entry.id.length + 2)) && (!ok || f !== posterName(entry.id, key)),
              )
              .map((f) => rm(join(folder, f), { force: true })),
          );
        });
        return ok;
      });

    /** Up-front checks that don't need the media core: absolute, exists, a regular file. */
    const precheck = (path: string) =>
      Effect.promise(async (): Promise<string | undefined> => {
        if (typeof path !== "string" || !isAbsolute(path)) return "Not an absolute path.";
        try {
          const s = await stat(path);
          if (s.isDirectory()) return "Folders can't be imported yet; drop the files inside.";
          if (!s.isFile()) return "Not a regular file.";
          return undefined;
        } catch {
          return "The file doesn't exist.";
        }
      });

    interface JobOptions {
      readonly agent?: { readonly turnId: string } | undefined;
      readonly names?: ReadonlyMap<string, string> | undefined;
      /** Where each file came from (a capture, D98), by path. */
      readonly sources?: ReadonlyMap<string, { readonly module: string; readonly [key: string]: unknown }> | undefined;
      /** Store files inside the project relative to it. */
      readonly relativePaths?: boolean | undefined;
      /** Don't list the job's report in the Library (the agent's, a capture's). */
      readonly quiet?: boolean | undefined;
      /** Completed once the media is in the project (or the job failed before that). */
      readonly added?: Deferred.Deferred<AgentImport, string> | undefined;
      /** D114: the (single) imported file also goes on the timeline, in the same edit. */
      readonly place?: { readonly frame: number; readonly placement: TakePlacement } | undefined;
      /** T9 (D128): the imported files also go on the timeline (one after another), in the same edit. */
      readonly drop?: MediaDrop | undefined;
      /** D211: a multi-source take: each file's part, placed together at `frame` (when given). */
      readonly multi?:
        | {
            readonly parts: ReadonlyMap<string, { readonly kind: MultiKind; readonly offsetMs: number }>;
            readonly frame?: number | undefined;
            readonly layout?: MultiLayoutName | undefined;
            readonly summary: string;
          }
        | undefined;
    }

    const runJob = (jobId: string, openId: number, dir: string, paths: ReadonlyArray<string>, options: JobOptions = {}) =>
      Effect.gen(function* () {
        const skipped: Array<{ path: string; reason: string; at: number }> = [];
        const failed: Array<{ path: string; message: string; at: number }> = [];
        const todo: Array<{ path: string; real: string; at: number }> = [];
        const subtitleFiles: Array<{ path: string; at: number; cues: ReadonlyArray<ParsedCue> }> = [];
        const subtitles: Array<ImportedSubtitles & { at: number }> = [];
        const seen = new Set<string>();
        for (const [at, path] of paths.entries()) {
          const problem = yield* precheck(path);
          if (problem) {
            failed.push({ path: String(path), message: problem, at });
            continue;
          }
          const real = yield* Effect.promise(() => realOr(path));
          if (seen.has(real)) {
            skipped.push({ path, reason: "Already in the project.", at });
            continue;
          }
          seen.add(real);
          // Subtitles (D105) aren't media: read here, added as a Subtitles text track in the same edit.
          if (subtitleFormatOf(path)) {
            const read = yield* Effect.promise(() => readSubtitleFile(path));
            if ("problem" in read) failed.push({ path, message: read.problem, at });
            else subtitleFiles.push({ path, at, cues: read.cues });
            continue;
          }
          todo.push({ path, real, at });
        }

        yield* update(jobId, { phase: "probing" });
        const outcomes: ReadonlyArray<ProbeOutcome> = yield* mediaCore
          .probeMany(
            todo.map((t) => t.path),
            (done) => Effect.runFork(update(jobId, { probed: done + (paths.length - todo.length) })),
          )
          .pipe(Effect.catchTag("MediaCoreError", (e) => Effect.succeed(todo.map(() => ({ ok: false as const, code: "error", message: e.message })))));

        const probed: Array<{ path: string; real: string; at: number; info: ProbeInfo }> = [];
        for (const [i, t] of todo.entries()) {
          let outcome = outcomes[i]!;
          // SVG (D76): sized from the file (neither the media core nor ffmpeg reads it).
          if (extname(t.path).toLowerCase() === ".svg") outcome = yield* Effect.promise(() => probeSvg(t.path));
          if (!outcome.ok && outcome.code === "unsupported") {
            const viaFfprobe = yield* ffprobe(t.path);
            if (viaFfprobe) outcome = { ok: true, info: viaFfprobe };
          }
          if (outcome.ok && outcome.info.kind !== "image" && !(outcome.info.durationSeconds && outcome.info.durationSeconds > 0)) {
            // No length from the headers (an unusual file): ask ffprobe before giving up.
            const viaFfprobe = yield* ffprobe(t.path);
            outcome = viaFfprobe?.durationSeconds ? { ok: true, info: viaFfprobe } : { ok: false, code: "unreadable", message: "its length couldn't be read" };
          }
          if (!outcome.ok) {
            const known = PROBE_ERRORS[outcome.code];
            failed.push({
              path: t.path,
              message: known ? (outcome.code === "unreadable" ? `${known}: ${outcome.message}.` : known) : outcome.message,
              at: t.at,
            });
            continue;
          }
          probed.push({ ...t, info: outcome.info });
        }
        yield* update(jobId, { probed: paths.length, phase: "adding" });

        // Ids, duplicates against the project and the edit itself happen under the project
        // lock, against the opening of the project the import was started in.
        let entries: Array<{ entry: MediaEntry; info: ProbeInfo }> = [];
        let placed: AgentImport["placed"];
        let multiPlaced: PlacedMulti | undefined;
        let matchedDir: string | undefined;
        const snapshot = yield* projects.editIn(
          openId,
          (raw, projectDir) =>
            Effect.gen(function* () {
              const project = raw as ProjectShape;
              const known = new Set<string>();
              // The media already there, by real path: a file dropped on the timeline again is placed, not imported twice.
              const existing = new Map<string, (typeof project.media)[number]>();
              for (const m of project.media) {
                const real = yield* Effect.promise(() => realOr(isAbsolute(m.path) ? m.path : resolve(projectDir, m.path)));
                known.add(real);
                existing.set(real, m);
              }
              const taken = allIds(project);
              // D209: "Match first clip": the first video brought into an empty project sets the canvas
              // (size and rate) in this edit, before its length in frames is counted at that rate.
              const matched = (yield* Effect.promise(() => matchPending(projectDir))) ? matchCanvas(project as unknown as Project, probed) : undefined;
              const fps = matched?.fps ?? project.canvas.fps;
              entries = [];
              const entryPaths = new Map<string, string>();
              // T9 (D128): what a drop places, in the order dropped (new entries and media already in the project).
              const toPlace: Array<PlaceMedia> = [];
              for (const p of probed) {
                if (known.has(p.real)) {
                  const there = existing.get(p.real);
                  if (options.drop && there) {
                    toPlace.push(there as unknown as PlaceMedia);
                    continue;
                  }
                  skipped.push({ path: p.path, reason: "Already in the project.", at: p.at });
                  continue;
                }
                known.add(p.real);
                const { info } = p;
                // F13 (D150): camera-style file names get a short display name ("DJI 0042").
                const name = options.names?.get(p.path) ?? cameraName(basename(p.path)) ?? basename(p.path);
                const source = options.sources?.get(p.path);
                entries.push({
                  info,
                  entry: {
                    id: mediaId(name, taken),
                    kind: info.kind,
                    name,
                    path: options.relativePaths ? storedPath(p.path, projectDir) : p.path,
                    ...(source ? { source } : {}),
                    probe: probeOf(info, fps),
                  },
                });
                toPlace.push(entries.at(-1)!.entry);
                entryPaths.set(entries.at(-1)!.entry.id, p.path);
              }
              // Subtitles files (D105): each a new Subtitles track (core planImportSubtitles), planned on the
              // project as it will be (the tracks planned before it count), in the same edit as the media.
              subtitles.length = 0;
              const subtitleOps: Array<unknown> = [];
              let view = raw as Project;
              for (const f of subtitleFiles) {
                const plan = planImportSubtitles(view, f.cues, basename(f.path), taken);
                if ("problem" in plan) {
                  if (!failed.some((x) => x.path === f.path)) failed.push({ path: f.path, message: plan.problem, at: f.at });
                  continue;
                }
                subtitleOps.push(...plan.ops);
                subtitles.push({ path: f.path, track: plan.trackId, cues: plan.cues, at: f.at });
                const added = plan.ops[0] as { track: Project["tracks"][number] };
                view = { ...view, tracks: [{ ...added.track, items: [] }, ...view.tracks] };
              }
              const count = entries.length + subtitles.length;
              if (count === 0 && !toPlace.length) return undefined;
              const canvasOps = matched ? [{ op: "update_project", set: { canvas: matched } }] : [];
              if (matched) {
                matchedDir = projectDir;
                const shaped = { ...(raw as Project), canvas: matched };
                raw = shaped;
              }
              // D114: a take recorded on this Mac goes on the timeline in the same edit.
              const placeOps: Array<unknown> = [];
              placed = undefined;
              const first = entries[0]?.entry;
              if (options.place && entries.length === 1 && first?.probe.frames) {
                const plan = planPlaceTake(
                  raw as Project,
                  { mediaId: first.id, frames: first.probe.frames, frame: options.place.frame, placement: options.place.placement },
                  taken,
                );
                placeOps.push(...plan.ops);
                placed = { itemId: plan.itemId, trackId: plan.trackId, start: plan.start };
              }
              // D211: a multi-source take's parts, start-aligned and grouped, in this edit.
              multiPlaced = undefined;
              if (options.multi && options.multi.frame !== undefined && entries.length) {
                const shaped = raw as Project;
                const parts = entries.flatMap(({ entry }) => {
                  const path = entryPaths.get(entry.id);
                  const part = path ? options.multi!.parts.get(path) : undefined;
                  return part && entry.probe.frames ? [{ mediaId: entry.id, kind: part.kind, frames: entry.probe.frames, offsetMs: part.offsetMs }] : [];
                });
                multiPlaced = planPlaceMulti(
                  shaped,
                  { parts, frame: options.multi.frame, fps: shaped.canvas.fps, canvas: shaped.canvas, layout: options.multi.layout },
                  taken,
                );
                placeOps.push(...multiPlaced.ops);
              }
              // T9 (D128): files dropped on the timeline land where they were dropped, in this edit.
              let dropped = false;
              const placeable = toPlace.filter((m) => m.kind === "image" || m.probe?.frames);
              if (options.drop && placeable.length) {
                const plan = planPlaceMedia(raw as Project, placeable, options.drop, taken);
                if (!("problem" in plan)) {
                  placeOps.push(...plan.ops);
                  dropped = true;
                  const first = plan.placed[0];
                  if (first) placed = first;
                }
              }
              return {
                ops: [...canvasOps, ...entries.map(({ entry }) => ({ op: "add_media", media: entry })), ...subtitleOps, ...placeOps],
                summary: options.multi
                  ? options.multi.summary
                  : dropped
                    ? placeable.length > 1
                      ? `Add ${placeable.length} files to the timeline`
                      : `Add ${placeable[0]!.name} to the timeline`
                    : placed
                      ? `Record ${entries[0]!.entry.name}`
                      : count > 1
                        ? `Import ${count} files`
                        : entries.length === 1
                          ? `Import ${entries[0]!.entry.name}`
                          : `Import subtitles ${basename(subtitles[0]!.path)}`,
              };
            }),
          options.agent,
        );

        // D209: matched once; later imports leave the canvas alone.
        if (snapshot && matchedDir) yield* Effect.promise(() => rm(join(matchedDir!, ".cache", MATCH_FIRST_CLIP), { force: true }).catch(() => {}));
        // Imported subtitles files are never written over by an export (D105).
        if (snapshot && subtitles.length)
          yield* Effect.promise(() =>
            recordSubtitleSources(
              dir,
              subtitles.map((x) => x.path),
            ).catch(() => {}),
          );
        const inOrder = <A extends { at: number }>(list: Array<A>) => [...list].sort((a, b) => a.at - b.at).map(({ at: _, ...rest }) => rest);
        if (options.added)
          yield* Deferred.succeed(options.added, {
            snapshot,
            entries: entries.map((e) => e.entry),
            skipped: inOrder(skipped),
            failed: inOrder(failed),
            ...(subtitles.length ? { subtitles: inOrder(subtitles) } : {}),
            ...(snapshot && placed ? { placed } : {}),
            ...(snapshot && multiPlaced ? { multi: multiPlaced } : {}),
          });

        // Posters after the edit (tiles show an icon until theirs exists), into the folder of
        // the project they belong to.
        yield* update(jobId, { phase: "posters", postersTotal: entries.filter((e) => e.entry.kind !== "audio").length });
        let done = 0;
        yield* Effect.forEach(
          entries,
          ({ entry, info }) => makePoster(entry, info, dir).pipe(Effect.tap((made) => (made ? update(jobId, { postersDone: ++done }) : Effect.void))),
          { concurrency: 2, discard: true },
        );

        const result: MediaImportResult = {
          imported: entries.map(({ entry, info }) => ({ path: entry.path, id: entry.id, name: entry.name, via: info.via })),
          ...(subtitles.length ? { subtitles: inOrder(subtitles) } : {}),
          skipped: inOrder(skipped),
          failed: inOrder(failed),
        };
        yield* update(jobId, { phase: "done", result });
      }).pipe(
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause) as { message?: unknown } | undefined;
          const message = typeof error?.message === "string" ? error.message : "The import stopped unexpectedly.";
          return update(jobId, { phase: "failed", error: message }).pipe(Effect.andThen(options.added ? Deferred.fail(options.added, message) : Effect.void));
        }),
      );

    /** Add a job to the list and run it in the server's scope, one at a time. */
    const queueJob = (open: { readonly openId: number; readonly dir: string }, paths: ReadonlyArray<string>, options: JobOptions = {}) =>
      Effect.gen(function* () {
        const id = randomUUID();
        const job: ImportJob = {
          id,
          projectDir: open.dir,
          total: paths.length,
          phase: "queued",
          probed: 0,
          postersDone: 0,
          postersTotal: 0,
          ...(options.agent || options.quiet ? { agent: true } : {}),
        };
        yield* SubscriptionRef.update(jobsRef, (jobs) => [
          ...jobs.filter((j) => j.phase !== "done" && j.phase !== "failed"),
          ...jobs.filter((j) => j.phase === "done" || j.phase === "failed").slice(-MAX_JOBS_KEPT),
          job,
        ]);
        // Forked into the server's scope, not the request's: a client that goes away or times
        // out doesn't cancel the import; one job runs at a time.
        yield* Effect.forkIn(oneAtATime.withPermits(1)(runJob(id, open.openId, open.dir, paths, options)), scope);
        return id;
      });

    const startImport = (paths: ReadonlyArray<string>, drop?: MediaDrop) =>
      Effect.gen(function* () {
        const open = yield* projects.current;
        if (!open) return yield* new ProjectError({ reason: "no-project", message: "No project is open", details: [] });
        // Files uploaded from another Mac (D108) live in the project's media/uploads/: stored
        // relative to it, so the project folder carries them wherever it goes.
        const uploads = join(open.dir, "media", "uploads") + "/";
        return {
          jobId: yield* queueJob(open, paths, { ...(paths.every((p) => p.startsWith(uploads)) ? { relativePaths: true } : {}), ...(drop ? { drop } : {}) }),
        };
      });

    const importForAgent = ({ openId, dir, turnId, paths, names, relativePaths }: AgentImportInput) =>
      Effect.gen(function* () {
        const added = yield* Deferred.make<AgentImport, string>();
        yield* queueJob({ openId, dir }, paths, { agent: { turnId }, names, added, ...(relativePaths ? { relativePaths } : {}) });
        return yield* Deferred.await(added).pipe(Effect.mapError((message) => new ProjectError({ reason: "io", message, details: [] })));
      });

    const importCapture = ({ openId, dir, path, name, source, turnId, place, drop }: CaptureImportInput) =>
      Effect.gen(function* () {
        const added = yield* Deferred.make<AgentImport, string>();
        yield* queueJob({ openId, dir }, [path], {
          agent: turnId ? { turnId } : undefined,
          quiet: true,
          relativePaths: true,
          names: name ? new Map([[path, name]]) : undefined,
          sources: new Map([[path, source]]),
          added,
          place,
          drop,
        });
        return yield* Deferred.await(added).pipe(Effect.mapError((message) => new ProjectError({ reason: "io", message, details: [] })));
      });

    const importMulti = ({ openId, dir, parts, frame, layout, summary }: MultiImportInput) =>
      Effect.gen(function* () {
        const added = yield* Deferred.make<AgentImport, string>();
        yield* queueJob(
          { openId, dir },
          parts.map((p) => p.path),
          {
            quiet: true,
            relativePaths: true,
            names: new Map(parts.map((p) => [p.path, p.name])),
            sources: new Map(parts.map((p) => [p.path, p.source])),
            added,
            multi: { parts: new Map(parts.map((p) => [p.path, { kind: p.kind, offsetMs: p.offsetMs }])), frame, layout, summary },
          },
        );
        return yield* Deferred.await(added).pipe(Effect.mapError((message) => new ProjectError({ reason: "io", message, details: [] })));
      });

    /** One file's probe, as the import job does it (the media core, ffprobe when it can't). */
    const probeFile = (path: string) =>
      Effect.gen(function* () {
        const problem = yield* precheck(path);
        if (problem) return { ok: false as const, message: problem };
        const [first] = yield* mediaCore
          .probeMany([path], () => {})
          .pipe(
            Effect.catchTag("MediaCoreError", (e) =>
              Effect.succeed([{ ok: false as const, code: "error", message: e.message }] as ReadonlyArray<ProbeOutcome>),
            ),
          );
        let outcome = first ?? { ok: false as const, code: "error", message: "no probe" };
        if (
          (!outcome.ok && outcome.code === "unsupported") ||
          (outcome.ok && outcome.info.kind !== "image" && !(outcome.info.durationSeconds && outcome.info.durationSeconds > 0))
        ) {
          const viaFfprobe = yield* ffprobe(path);
          if (viaFfprobe?.durationSeconds || (viaFfprobe && !outcome.ok)) outcome = { ok: true, info: viaFfprobe };
        }
        if (!outcome.ok) return { ok: false as const, message: PROBE_ERRORS[outcome.code] ?? outcome.message };
        return { ok: true as const, info: outcome.info };
      });

    const replaceMedia = ({ openId, dir, mediaId: id, path, source, overrun, turnId }: ReplaceMediaInput) =>
      Effect.gen(function* () {
        const probed = yield* probeFile(path);
        if (!probed.ok) return yield* new ProjectError({ reason: "io", message: `The new take can't be read: ${probed.message}`, details: [] });
        let result: { entry: MediaEntry; previousPath: string; warnings: ReadonlyArray<string>; ops: ReadonlyArray<unknown> } | undefined;
        const snapshot = yield* projects
          .editIn(
            openId,
            (raw, projectDir) =>
              Effect.try({
                try: () => {
                  const project = raw as Project;
                  const old = project.media.find((m) => m.id === id);
                  if (!old) throw new Error(`There's no media ${id} in the project.`);
                  const probe = probeOf(probed.info, project.canvas.fps);
                  const stored = storedPath(path, projectDir);
                  const plan = planReshoot(project, id, { path: stored, probe, ...(source ? { source } : {}) }, overrun);
                  result = {
                    entry: { id, kind: old.kind, name: old.name, path: stored, probe, ...((source ?? old.source) ? { source: (source ?? old.source)! } : {}) },
                    previousPath: old.path,
                    warnings: plan.warnings,
                    ops: plan.ops,
                  };
                  return { ops: plan.ops as ReadonlyArray<unknown>, summary: `Re-shoot ${old.name}` };
                },
                catch: (error) => new ProjectError({ reason: "io", message: error instanceof Error ? error.message : String(error), details: [] }),
              }),
            turnId ? { turnId } : undefined,
          )
          .pipe(
            Effect.mapError((error) =>
              error instanceof ProjectError
                ? error
                : new ProjectError({ reason: "io", message: (error as { message?: string }).message ?? String(error), details: [] }),
            ),
          );
        if (!result) return yield* new ProjectError({ reason: "io", message: "Nothing was swapped in.", details: [] });
        const done = result;
        // The new poster in the background (the old one goes: makePoster keeps only the current file's).
        yield* Effect.forkIn(makePoster(done.entry, probed.info, dir).pipe(Effect.ignore), scope);
        return { snapshot, ...done };
      });

    const currentPosters = Effect.gen(function* () {
      const open = yield* projects.current;
      if (!open) return new Map<string, string>();
      const project = open.project as ProjectShape;
      const files = new Set(yield* Effect.promise(() => readdir(thumbDir(open.dir)).catch(() => [] as Array<string>)));
      const out = new Map<string, string>();
      for (const m of project.media) {
        const key = yield* Effect.promise(() => posterKey(isAbsolute(m.path) ? m.path : resolve(open.dir, m.path)));
        if (key && files.has(posterName(m.id, key))) out.set(m.id, join(thumbDir(open.dir), posterName(m.id, key)));
      }
      return out;
    });

    return MediaLibrary.of({
      startImport,
      jobs: SubscriptionRef.changes(jobsRef),
      thumbnails: Effect.map(currentPosters, (m) => [...m.keys()]),
      posterFor: (id) => Effect.map(currentPosters, (m) => m.get(id)),
      importForAgent,
      importCapture,
      importMulti,
      replaceMedia,
    });
  }),
);
