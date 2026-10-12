// Importing media into a project, as a server-side job: probe each file with the media core
// (ffprobe for formats it can't read), add them in one undoable edit to the project that was
// open when the import started, then make poster thumbnails. Footage is referenced by path,
// never copied (D12). Jobs run one at a time and aren't tied to the request that started them.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

import { ProjectError, type ImportJob, type MediaImportResult, type ProjectSnapshot } from "@uncut/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerConfig } from "./config.ts";
import { MediaCore, type ProbeInfo, type ProbeOutcome } from "./mediaCore.ts";
import { runProbe } from "./probe.ts";
import { Projects } from "./projects.ts";
import { which } from "./setup.ts";
import { withoutApiKey } from "./shellEnv.ts";

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
}

export class MediaLibrary extends Context.Service<MediaLibrary, MediaLibraryShape>()("uncut/MediaLibrary") {}

export interface MediaEntry {
  readonly id: string;
  readonly kind: "video" | "audio" | "image";
  readonly name: string;
  readonly path: string;
  readonly probe: { frames?: number; fps?: number; width?: number; height?: number; hasAudio: boolean };
}

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

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic"]);
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
    const makePoster = (entry: MediaEntry, info: ProbeInfo, dir: string) =>
      Effect.gen(function* () {
        if (entry.kind === "audio") return false;
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
      /** Completed once the media is in the project (or the job failed before that). */
      readonly added?: Deferred.Deferred<AgentImport, string> | undefined;
    }

    const runJob = (jobId: string, openId: number, dir: string, paths: ReadonlyArray<string>, options: JobOptions = {}) =>
      Effect.gen(function* () {
        const skipped: Array<{ path: string; reason: string; at: number }> = [];
        const failed: Array<{ path: string; message: string; at: number }> = [];
        const todo: Array<{ path: string; real: string; at: number }> = [];
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
              // The project stores the picture as shown: a phone clip turned 90° is portrait.
              const turned = info.rotation === 90 || info.rotation === 270;
              const width = turned ? info.height : info.width;
              const height = turned ? info.width : info.height;
              const frames = info.kind !== "image" && info.durationSeconds ? Math.max(1, Math.floor(info.durationSeconds * fps)) : undefined;
              const name = options.names?.get(p.path) ?? basename(p.path);
              entries.push({
                info,
                entry: {
                  id: mediaId(name, taken),
                  kind: info.kind,
                  name,
                  path: p.path,
                  probe: { ...(frames ? { frames } : {}), ...(info.fpsValue ? { fps: info.fpsValue } : {}), ...(width ? { width } : {}), ...(height ? { height } : {}), hasAudio: info.hasAudio },
                },
              });
            }
            if (entries.length === 0) return undefined;
            return {
              ops: entries.map(({ entry }) => ({ op: "add_media", media: entry })),
              summary: entries.length === 1 ? `Import ${entries[0]!.entry.name}` : `Import ${entries.length} files`,
            };
          }),
          options.agent,
        );

        const inOrder = <A extends { at: number }>(list: Array<A>) => [...list].sort((a, b) => a.at - b.at).map(({ at: _, ...rest }) => rest);
        if (options.added) yield* Deferred.succeed(options.added, { snapshot, entries: entries.map((e) => e.entry), skipped: inOrder(skipped), failed: inOrder(failed) });

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
        const job: ImportJob = { id, projectDir: open.dir, total: paths.length, phase: "queued", probed: 0, postersDone: 0, postersTotal: 0, ...(options.agent ? { agent: true } : {}) };
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
        return { jobId: yield* queueJob(open, paths) };
      });

    const importForAgent = ({ openId, dir, turnId, paths, names }: AgentImportInput) =>
      Effect.gen(function* () {
        const added = yield* Deferred.make<AgentImport, string>();
        yield* queueJob({ openId, dir }, paths, { agent: { turnId }, names, added });
        return yield* Deferred.await(added).pipe(Effect.mapError((message) => new ProjectError({ reason: "io", message, details: [] })));
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
    });
  }),
);
