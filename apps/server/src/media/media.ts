// Importing media into a project, as a server-side job: probe each file with the media core
// (ffprobe for formats it can't read), add them in one undoable edit to the project that was
// open when the import started, then make poster thumbnails. Footage is referenced by path,
// never copied (D12). Jobs run one at a time and aren't tied to the request that started them.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

import { ProjectError, type ImportJob, type MediaImportResult, type ProjectSnapshot } from "@uncut/contracts";
import { decodeSubtitleBytes, parseSubtitles, planImportSubtitles, planReshoot, subtitleFormatOf, type Overrun, type ParsedCue, type Project } from "@uncut/core";
import { planPlaceTake, type TakePlacement } from "@uncut/core/place";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerConfig } from "../app/config.ts";
import { MediaCore, type ProbeInfo, type ProbeOutcome } from "./mediaCore.ts";
import { probeSvg } from "../export/svg.ts";
import { runProbe } from "./probe.ts";
import { Projects } from "../project/projects.ts";
import { which } from "../app/setup.ts";
import { recordSubtitleSources } from "../export/subtitleSources.ts";
import { withoutApiKey } from "../app/shellEnv.ts";

export interface MediaLibraryShape {
  /** Queue an import into the open project; returns the job id at once. */
  readonly startImport: (paths: ReadonlyArray<string>) => Effect.Effect<{ jobId: string }, ProjectError>;
  readonly jobs: Stream.Stream<ReadonlyArray<ImportJob>>;
  /** Media ids of the open project whose current poster exists. */
  readonly thumbnails: Effect.Effect<ReadonlyArray<string>>;
  /** The poster file for a media id of the open project, if it exists. */
  readonly posterFor: (id: string) => Effect.Effect<string | undefined>;
  /**
   * The agent's media_import (D65): an import job like the Library's, but its edit is the agent's
   * (tagged with the turn, so Undo turn removes it and the manual-edit note doesn't list it).
   * Resolves once the media is in the project; posters carry on in the background.
   */
  readonly importForAgent: (input: AgentImportInput) => Effect.Effect<AgentImport, ProjectError>;
  /**
   * A recording a capture plugin made (D98): imported like media_import, with its `source`, stored
   * relative to the project when it's inside it (media/captures/...). The agent's (turnId) or,
   * without one, the user's edit (the Capture tab: one ⌘Z removes it).
   */
  readonly importCapture: (input: CaptureImportInput) => Effect.Effect<AgentImport, ProjectError>;
  /**
   * A re-shot recording swapped in for media `mediaId` (D98): probed, then one edit that changes
   * the media's file and trims or holds clips past the new end (core planReshoot); a new poster.
   */
  readonly replaceMedia: (input: ReplaceMediaInput) => Effect.Effect<ReplacedMedia, ProjectError>;
}

export interface CaptureImportInput {
  readonly openId: number;
  readonly dir: string;
  readonly path: string;
  readonly name?: string | undefined;
  readonly source: { readonly module: string; readonly [key: string]: unknown };
  readonly turnId?: string | undefined;
  /** D114: also put it on the timeline at this frame, in the same edit (core planPlaceTake). */
  readonly place?: { readonly frame: number; readonly placement: TakePlacement } | undefined;
}

export interface ReplaceMediaInput {
  readonly openId: number;
  readonly dir: string;
  readonly mediaId: string;
  readonly path: string;
  readonly source?: { readonly module: string; readonly [key: string]: unknown } | undefined;
  readonly overrun?: Overrun | undefined;
  readonly turnId?: string | undefined;
}

export interface ReplacedMedia {
  readonly snapshot: ProjectSnapshot | undefined;
  readonly entry: MediaEntry;
  /** The file it had before. */
  readonly previousPath: string;
  readonly warnings: ReadonlyArray<string>;
  /** The edit's ops (update_media, then the trims and holds). */
  readonly ops: ReadonlyArray<unknown>;
}

export interface AgentImportInput {
  readonly openId: number;
  readonly dir: string;
  readonly turnId: string;
  readonly paths: ReadonlyArray<string>;
  /** Display names to use instead of the file name, by path. */
  readonly names?: ReadonlyMap<string, string> | undefined;
}

export interface AgentImport {
  /** The project after the import, or undefined when nothing was added. */
  readonly snapshot: ProjectSnapshot | undefined;
  readonly entries: ReadonlyArray<MediaEntry>;
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  readonly failed: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  /** D105: .srt / .vtt files read into a Subtitles text track. */
  readonly subtitles?: ReadonlyArray<ImportedSubtitles>;
  /** D114: the timeline item a placed take got. */
  readonly placed?: { readonly itemId: string; readonly trackId: string; readonly start: number };
}

export interface ImportedSubtitles {
  readonly path: string;
  readonly track: string;
  readonly cues: number;
}

/** A subtitles file bigger than this isn't read (an hour of dense subtitles is ~100 kB). */
export const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;

/** A .srt / .vtt file's cues, or why it can't be imported (a sentence). */
export async function readSubtitleFile(path: string): Promise<{ readonly cues: ReadonlyArray<ParsedCue> } | { readonly problem: string }> {
  const name = basename(path);
  try {
    const s = await stat(path);
    if (s.size > MAX_SUBTITLE_BYTES) return { problem: `${name} is too big for a subtitles file (over ${MAX_SUBTITLE_BYTES / 1024 / 1024} MB).` };
    const parsed = parseSubtitles(decodeSubtitleBytes(await readFile(path)), name);
    return "problem" in parsed ? parsed : { cues: parsed.cues };
  } catch {
    return { problem: `${name} couldn't be read.` };
  }
}

export class MediaLibrary extends Context.Service<MediaLibrary, MediaLibraryShape>()("uncut/MediaLibrary") {}

export interface MediaEntry {
  readonly id: string;
  readonly kind: "video" | "audio" | "image";
  readonly name: string;
  readonly path: string;
  readonly probe: { frames?: number; fps?: number; width?: number; height?: number; hasAudio: boolean };
  readonly source?: { readonly module: string; readonly [key: string]: unknown };
}

/** A file inside the project folder is stored relative to it (media/captures/x.mp4, D12). */
const storedPath = (path: string, projectDir: string) => {
  const rel = relative(projectDir, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
};

type ProjectShape = {
  canvas: { fps: number };
  media: ReadonlyArray<{ id: string; path: string }>;
  tracks: ReadonlyArray<{ id: string; items: ReadonlyArray<{ id: string }> }>;
  scenes?: ReadonlyArray<{ id: string }>;
};

export const thumbDir = (projectDir: string) => join(projectDir, ".cache", "thumbs");

/** "DJI_0005 (final).MP4" → "m-dji-0005-final", made unique against `taken`. */
export const mediaId = (name: string, taken: Set<string>) => {
  const stem = name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "media";
  let id = `m-${stem}`;
  for (let n = 2; taken.has(id); n++) id = `m-${stem}-${n}`;
  taken.add(id);
  return id;
};

/** Every id the validator requires to be unique: media, tracks, items, scenes. */
const allIds = (project: ProjectShape) =>
  new Set([
    ...project.media.map((m) => m.id),
    ...project.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)]),
    ...(project.scenes ?? []).map((s) => s.id),
  ]);

const realOr = (path: string) => realpath(path).catch(() => path);

/**
 * A poster belongs to the file it was made from: its name carries a short hash of the path,
 * size and modification time, so a reused id or a changed file never shows a stale picture.
 */
export const posterKey = async (path: string) => {
  try {
    const s = await stat(path);
    return createHash("sha1").update(`${path}\0${s.size}\0${s.mtimeMs}`).digest("hex").slice(0, 12);
  } catch {
    return undefined;
  }
};
const posterName = (id: string, key: string) => `${id}--${key}.jpg`;

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".svg"]);
// ffmpeg reads "shot%d.png" as an image sequence; for one image, say it's one file.
const imageInput = (path: string) => ["-f", "image2", "-pattern_type", "none", "-i", path];

const PROBE_ERRORS: Record<string, string> = {
  "not-found": "The file doesn't exist.",
  unsupported: "Uncut can't read this kind of file yet.",
  unreadable: "The file couldn't be read",
};

/** ffprobe's JSON in the media core's shape, for formats the core doesn't parse. */
const fromFfprobe = (json: string): ProbeInfo | undefined => {
  let j: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  try {
    j = JSON.parse(json);
  } catch {
    return undefined;
  }
  const streams = j.streams ?? [];
  const image = /png_pipe|jpeg_pipe|image2|webp_pipe|gif|tiff_pipe|bmp_pipe/.test(String(j.format?.format_name ?? ""));
  const video = streams
    .filter((s) => s.codec_type === "video" && !(s.disposition as Record<string, number> | undefined)?.attached_pic)
    .sort((a, b) => Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height))[0];
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!video && !audio) return undefined;
  const [num, den] = String(video?.r_frame_rate ?? "0/0").split("/").map(Number);
  const duration = Number(j.format?.duration ?? video?.duration ?? audio?.duration);
  return {
    kind: image ? "image" : video ? "video" : "audio",
    container: String(j.format?.format_name ?? "unknown").split(",")[0]!,
    ...(Number.isFinite(duration) && !image ? { durationSeconds: duration } : {}),
    ...(video ? { width: Number(video.width), height: Number(video.height), videoCodec: String(video.codec_name) } : {}),
    ...(num && den && !image ? { fps: `${num}/${den}`, fpsValue: num / den } : {}),
    ...(audio ? { audioCodec: String(audio.codec_name) } : {}),
    hasAudio: Boolean(audio),
    via: "ffprobe",
  };
};

const MAX_JOBS_KEPT = 10;

/** A probe in project terms: the length in project frames, the picture as shown. */
const probeOf = (info: ProbeInfo, fps: number): MediaEntry["probe"] => {
  // The project stores the picture as shown: a phone clip turned 90° is portrait.
  const turned = info.rotation === 90 || info.rotation === 270;
  const width = turned ? info.height : info.width;
  const height = turned ? info.width : info.height;
  const frames = info.kind !== "image" && info.durationSeconds ? Math.max(1, Math.floor(info.durationSeconds * fps)) : undefined;
  return { ...(frames ? { frames } : {}), ...(info.fpsValue ? { fps: info.fpsValue } : {}), ...(width ? { width } : {}), ...(height ? { height } : {}), hasAudio: info.hasAudio };
};

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
        const r = yield* run(bin, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", ...input], 15000, 1024 * 1024);
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
        const r = yield* run(bin, ["-v", "error", "-y", ...input, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", out], 30000);
        const ok = r.kind === "done" && r.code === 0;
        // Older posters for this id (another file, or this file before it changed) go.
        yield* Effect.promise(async () => {
          const files = await readdir(folder).catch(() => [] as Array<string>);
          await Promise.all(files.filter((f) => f.startsWith(`${entry.id}--`) && /^[0-9a-f]{12}\.jpg$/.test(f.slice(entry.id.length + 2)) && (!ok || f !== posterName(entry.id, key))).map((f) => rm(join(folder, f), { force: true })));
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
            failed.push({ path: t.path, message: known ? (outcome.code === "unreadable" ? `${known}: ${outcome.message}.` : known) : outcome.message, at: t.at });
            continue;
          }
          probed.push({ ...t, info: outcome.info });
        }
        yield* update(jobId, { probed: paths.length, phase: "adding" });

        // Ids, duplicates against the project and the edit itself happen under the project
        // lock, against the opening of the project the import was started in.
        let entries: Array<{ entry: MediaEntry; info: ProbeInfo }> = [];
        let placed: AgentImport["placed"];
        const snapshot = yield* projects.editIn(openId, (raw, projectDir) =>
          Effect.gen(function* () {
            const project = raw as ProjectShape;
            const known = new Set<string>();
            for (const m of project.media) known.add(yield* Effect.promise(() => realOr(isAbsolute(m.path) ? m.path : resolve(projectDir, m.path))));
            const taken = allIds(project);
            const fps = project.canvas.fps;
            entries = [];
            for (const p of probed) {
              if (known.has(p.real)) {
                skipped.push({ path: p.path, reason: "Already in the project.", at: p.at });
                continue;
              }
              known.add(p.real);
              const { info } = p;
              const name = options.names?.get(p.path) ?? basename(p.path);
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
            if (count === 0) return undefined;
            // D114: a take recorded on this Mac goes on the timeline in the same edit.
            const placeOps: Array<unknown> = [];
            placed = undefined;
            const first = entries[0]?.entry;
            if (options.place && entries.length === 1 && first?.probe.frames) {
              const plan = planPlaceTake(raw as Project, { mediaId: first.id, frames: first.probe.frames, frame: options.place.frame, placement: options.place.placement }, taken);
              placeOps.push(...plan.ops);
              placed = { itemId: plan.itemId, trackId: plan.trackId, start: plan.start };
            }
            return {
              ops: [...entries.map(({ entry }) => ({ op: "add_media", media: entry })), ...subtitleOps, ...placeOps],
              summary: placed ? `Record ${entries[0]!.entry.name}` : count > 1 ? `Import ${count} files` : entries.length === 1 ? `Import ${entries[0]!.entry.name}` : `Import subtitles ${basename(subtitles[0]!.path)}`,
            };
          }),
          options.agent,
        );

        // Imported subtitles files are never written over by an export (D105).
        if (snapshot && subtitles.length) yield* Effect.promise(() => recordSubtitleSources(dir, subtitles.map((x) => x.path)).catch(() => {}));
        const inOrder = <A extends { at: number }>(list: Array<A>) => [...list].sort((a, b) => a.at - b.at).map(({ at: _, ...rest }) => rest);
        if (options.added) yield* Deferred.succeed(options.added, { snapshot, entries: entries.map((e) => e.entry), skipped: inOrder(skipped), failed: inOrder(failed), ...(subtitles.length ? { subtitles: inOrder(subtitles) } : {}), ...(snapshot && placed ? { placed } : {}) });

        // Posters after the edit (tiles show an icon until theirs exists), into the folder of
        // the project they belong to.
        yield* update(jobId, { phase: "posters", postersTotal: entries.filter((e) => e.entry.kind !== "audio").length });
        let done = 0;
        yield* Effect.forEach(
          entries,
          ({ entry, info }) =>
            makePoster(entry, info, dir).pipe(
              Effect.tap((made) => (made ? update(jobId, { postersDone: ++done }) : Effect.void)),
            ),
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
        const job: ImportJob = { id, projectDir: open.dir, total: paths.length, phase: "queued", probed: 0, postersDone: 0, postersTotal: 0, ...(options.agent || options.quiet ? { agent: true } : {}) };
        yield* SubscriptionRef.update(jobsRef, (jobs) => [...jobs.filter((j) => j.phase !== "done" && j.phase !== "failed"), ...jobs.filter((j) => j.phase === "done" || j.phase === "failed").slice(-MAX_JOBS_KEPT), job]);
        // Forked into the server's scope, not the request's: a client that goes away or times
        // out doesn't cancel the import; one job runs at a time.
        yield* Effect.forkIn(oneAtATime.withPermits(1)(runJob(id, open.openId, open.dir, paths, options)), scope);
        return id;
      });

    const startImport = (paths: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const open = yield* projects.current;
        if (!open) return yield* new ProjectError({ reason: "no-project", message: "No project is open", details: [] });
        // Files uploaded from another Mac (D108) live in the project's media/uploads/: stored
        // relative to it, so the project folder carries them wherever it goes.
        const uploads = join(open.dir, "media", "uploads") + "/";
        return { jobId: yield* queueJob(open, paths, paths.every((p) => p.startsWith(uploads)) ? { relativePaths: true } : {}) };
      });

    const importForAgent = ({ openId, dir, turnId, paths, names }: AgentImportInput) =>
      Effect.gen(function* () {
        const added = yield* Deferred.make<AgentImport, string>();
        yield* queueJob({ openId, dir }, paths, { agent: { turnId }, names, added });
        return yield* Deferred.await(added).pipe(Effect.mapError((message) => new ProjectError({ reason: "io", message, details: [] })));
      });

    const importCapture = ({ openId, dir, path, name, source, turnId, place }: CaptureImportInput) =>
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
        });
        return yield* Deferred.await(added).pipe(Effect.mapError((message) => new ProjectError({ reason: "io", message, details: [] })));
      });

    /** One file's probe, as the import job does it (the media core, ffprobe when it can't). */
    const probeFile = (path: string) =>
      Effect.gen(function* () {
        const problem = yield* precheck(path);
        if (problem) return { ok: false as const, message: problem };
        const [first] = yield* mediaCore.probeMany([path], () => {}).pipe(Effect.catchTag("MediaCoreError", (e) => Effect.succeed([{ ok: false as const, code: "error", message: e.message }] as ReadonlyArray<ProbeOutcome>)));
        let outcome = first ?? { ok: false as const, code: "error", message: "no probe" };
        if ((!outcome.ok && outcome.code === "unsupported") || (outcome.ok && outcome.info.kind !== "image" && !(outcome.info.durationSeconds && outcome.info.durationSeconds > 0))) {
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
                  result = { entry: { id, kind: old.kind, name: old.name, path: stored, probe, ...(source ?? old.source ? { source: (source ?? old.source)! } : {}) }, previousPath: old.path, warnings: plan.warnings, ops: plan.ops };
                  return { ops: plan.ops as ReadonlyArray<unknown>, summary: `Re-shoot ${old.name}` };
                },
                catch: (error) => new ProjectError({ reason: "io", message: error instanceof Error ? error.message : String(error), details: [] }),
              }),
            turnId ? { turnId } : undefined,
          )
          .pipe(Effect.mapError((error) => (error instanceof ProjectError ? error : new ProjectError({ reason: "io", message: (error as { message?: string }).message ?? String(error), details: [] }))));
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
      replaceMedia,
    });
  }),
);
