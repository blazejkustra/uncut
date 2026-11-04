// Vision results for clips (D328): the mattes that background removal (effect.cutout) and the face
// boxes that face blur (effect.face-blur) and auto reframe read, for the stretch of the media each
// clip shows (core visionRange). Made through VisionAnalysis (D325) from media files of the open
// project only (D12: `visionMediaPath`), one run per result shared by everyone who waits for it
// (the preview's queue, an export, render_frames, a reframe), and held while an export or a frame
// session reads it, so the preview's cleanup can't remove it. The preview's queue gives a matte an
// H.264 copy (<video> can't play FFV1): <matte>.preview.mp4 beside it; nothing else waits for it.
import { realpath, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { type FacesResult, type MatteInfo, type MatteMode } from "@uncut/contracts";
import { CUTOUT, FACE_BLUR, effectOptions, visionProblem, visionRange, type FaceFrames, type Item, type Media, type Project } from "@uncut/core";
import { flattenSequences } from "@uncut/core/nesting";

import { run } from "../../export/exporter/ffmpeg.ts";
import { VisionFailure, type VisionAnalysis } from "./vision.ts";

export type ClipVisionOutput = "matte" | "faces";

/** One vision result a clip needs: its media, the output (and matte mode) and the media's seconds [start, end). */
export interface ClipVisionRequest {
  readonly output: ClipVisionOutput;
  readonly mode?: MatteMode | undefined;
  readonly start: number;
  readonly end: number;
}

export interface ClipVisionTarget extends ClipVisionRequest {
  readonly media: Media;
  /** The media's file, checked (visionMediaPath). */
  readonly path: string;
  readonly dir: string;
  /** media id, output, mode and range. */
  readonly id: string;
}

/** A made result: a matte (its file, the preview's copy, its info) or faces, and its cache file's key (the name without extension). */
export type ClipVisionResult =
  | { readonly output: "matte"; readonly key: string; readonly video: string; readonly info: MatteInfo }
  | { readonly output: "faces"; readonly key: string; readonly file: string; readonly result: FacesResult };

export const requestId = (mediaId: string, r: ClipVisionRequest) => `${mediaId}|${r.output}|${r.mode ?? ""}|${r.start}-${r.end}`;

const live = (item: Item, module: string) => item.effects?.find((e) => e.module === module && !e.bypass);

/** The vision results a clip's effects read (none for a clip that can't use them). */
export function clipRequests(project: Pick<Project, "media" | "canvas" | "tracks">, item: Item): Array<ClipVisionRequest> {
  const range = visionRange(project, item);
  if (!range) return [];
  const out: Array<ClipVisionRequest> = [];
  const cutout = live(item, CUTOUT);
  if (cutout && !visionProblem(project, item, "matte")) out.push({ output: "matte", mode: effectOptions(CUTOUT, cutout.params).mode as MatteMode, ...range });
  if (live(item, FACE_BLUR) && !visionProblem(project, item, "faces")) out.push({ output: "faces", ...range });
  return out;
}

/**
 * D12: a media item's file, when vision may read it: a media item of the project, a file, and not
 * inside the project's folder except its media/ folder (never .cache or the project's own files).
 */
export async function visionMediaPath(dir: string, media: Media): Promise<string> {
  const raw = isAbsolute(media.path) ? media.path : resolve(dir, media.path);
  const path = await realpath(raw).catch(() => undefined);
  if (!path || !(await stat(path).catch(() => undefined))?.isFile()) throw new VisionFailure("invalid", `${media.name || media.id}'s file isn't there.`);
  const root = await realpath(dir).catch(() => resolve(dir));
  const inside = relative(root, path);
  const within = inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
  if (within && inside.split(sep)[0] !== "media")
    throw new VisionFailure("invalid", `${media.name || media.id} points inside the project's own files, which vision doesn't read.`);
  if (path.split(sep).includes(".cache")) throw new VisionFailure("invalid", `${media.name || media.id} points into a cache folder, which vision doesn't read.`);
  return path;
}

/** A result a clip reads whose media vision may not read (offline, or outside the D12 rules), and why. */
export interface RefusedTarget extends ClipVisionRequest {
  readonly media: Media;
  readonly id: string;
  readonly reason: string;
}

/** Every vision result the project's clips read, one per media and request, and those it can't make. */
export async function clipVisionTargets(project: Project, dir: string): Promise<{ readonly targets: Array<ClipVisionTarget>; readonly refused: Array<RefusedTarget> }> {
  const flat = flattenSequences(project);
  const out = new Map<string, ClipVisionTarget>();
  const refused = new Map<string, RefusedTarget>();
  for (const item of flat.tracks.flatMap((t) => t.items)) {
    const media = item.type === "clip" ? flat.media.find((m) => m.id === item.media) : undefined;
    if (!media) continue;
    for (const request of clipRequests(flat, item)) {
      const id = requestId(media.id, request);
      if (out.has(id) || refused.has(id)) continue;
      try {
        out.set(id, { ...request, media, path: await visionMediaPath(dir, media), dir, id });
      } catch (error) {
        refused.set(id, { ...request, media, id, reason: (error as Error).message });
      }
    }
  }
  return { targets: [...out.values()], refused: [...refused.values()] };
}

// ---- making results, shared ----

type Encoder = ReadonlyArray<string>;

/** H.264 of the matte for the preview: grey in the picture, keyframes every 10 frames, the matte's own frame grid. */
async function matteEncoder(ffmpeg: string): Promise<Encoder> {
  const r = await run(ffmpeg, ["-hide_banner", "-v", "error", "-h", "encoder=libx264"], undefined).catch(() => undefined);
  if (r && r.code === 0 && /libx264/.test(r.stdout + r.stderr)) return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-g", "10", "-bf", "0"];
  return ["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-q:v", "80", "-g", "10", "-bf", "0"];
}

export const previewOf = (video: string) => video.replace(/\.mkv$/, ".preview.mp4");

/** Makes the matte's preview copy unless it's there: H.264 at even sizes (an odd one is stretched by a pixel). */
export async function makePreview(ffmpeg: string, video: string, signal: AbortSignal): Promise<string> {
  const out = previewOf(video);
  if ((await stat(out).catch(() => undefined))?.isFile()) return out;
  const part = `${out}.part`;
  try {
    const encoder = await matteEncoder(ffmpeg);
    const args = ["-hide_banner", "-nostdin", "-y", "-v", "error", "-threads", "4", "-i", video, "-vf", "scale=trunc((iw+1)/2)*2:trunc((ih+1)/2)*2,format=yuv420p", ...encoder, "-threads", "4", "-color_range", "tv", "-movflags", "+faststart", "-f", "mp4", part];
    const r = await run(ffmpeg, args, signal);
    if (r.code !== 0) throw new VisionFailure("failed", `ffmpeg couldn't make the matte's preview: ${r.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
    await rename(part, out);
    return out;
  } finally {
    await rm(part, { force: true }).catch(() => {});
  }
}

export interface EnsureOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((fraction: number) => void) | undefined;
}

interface SharedRun {
  readonly done: Promise<ClipVisionResult>;
  readonly controller: AbortController;
  readonly progress: Set<(fraction: number) => void>;
  wanted: number;
}

const inflight = new Map<string, SharedRun>();
/** Cache files an export or a frame session will read (by path, how many hold each). */
const pins = new Map<string, number>();

/**
 * One result made (or found in the cache), pinned from the moment it exists until the run's
 * waiters have taken their own pins (`settled`).
 */
async function make(vision: VisionAnalysis, target: ClipVisionTarget, signal: AbortSignal, report: (f: number) => void, settled: Promise<unknown>): Promise<ClipVisionResult> {
  const where = { dir: target.dir, path: target.path };
  const result: ClipVisionResult =
    target.output === "faces"
      ? await vision.faces(where, { start: target.start, end: target.end }, { signal, onProgress: report }).then((made) => ({
          output: "faces" as const,
          key: basename(made.file, ".json"),
          file: made.file,
          result: made.result,
        }))
      : await vision.matte(where, { start: target.start, end: target.end, mode: target.mode ?? "person" }, { signal, onProgress: report }).then((made) => ({
          output: "matte" as const,
          key: basename(made.video, ".mkv"),
          video: made.video,
          info: made.info,
        }));
  const release = pinVision([result]);
  void settled.finally(() => setImmediate(release));
  return result;
}

const aborted = (signal: AbortSignal | undefined) =>
  new Promise<"aborted">((resolveAbort) => {
    if (!signal) return;
    if (signal.aborted) return resolveAbort("aborted");
    signal.addEventListener("abort", () => resolveAbort("aborted"), { once: true });
  });

/** Stopped while waiting: the caller's own signal aborted. */
export class VisionStopped extends Error {
  constructor() {
    super("Stopped.");
  }
}

/**
 * A clip vision result, cached or made now. Everyone asking for the same one waits for one run; a
 * caller whose signal aborts stops waiting (VisionStopped), and the run stops when no one waits.
 */
export async function ensureClipVision(vision: VisionAnalysis, target: ClipVisionTarget, options: EnsureOptions = {}): Promise<ClipVisionResult> {
  if (options.signal?.aborted) throw new VisionStopped();
  const stopping = inflight.get(target.id + target.dir);
  if (stopping?.controller.signal.aborted) await stopping.done.catch(() => {});
  let shared = inflight.get(target.id + target.dir);
  if (!shared) {
    const controller = new AbortController();
    const progress = new Set<(fraction: number) => void>();
    let settle = () => {};
    const settled = new Promise<void>((resolveSettled) => (settle = resolveSettled));
    const done = make(vision, target, controller.signal, (f) => progress.forEach((p) => p(f)), settled).finally(() => {
      inflight.delete(target.id + target.dir);
      settle();
    });
    done.catch(() => {});
    shared = { done, controller, progress, wanted: 0 };
    inflight.set(target.id + target.dir, shared);
  }
  const run = shared;
  run.wanted++;
  if (options.onProgress) run.progress.add(options.onProgress);
  try {
    const answer = await Promise.race([run.done, aborted(options.signal)]);
    if (answer === "aborted") throw new VisionStopped();
    return answer;
  } finally {
    if (options.onProgress) run.progress.delete(options.onProgress);
    run.wanted--;
    if (run.wanted === 0) run.controller.abort();
  }
}

const filesOf = (r: ClipVisionResult) => (r.output === "matte" ? [r.video, r.video.replace(/\.mkv$/, ".json"), previewOf(r.video)] : [r.file]);

/** Keeps results on disk while something will read them; the returned function lets them go. */
export function pinVision(results: ReadonlyArray<ClipVisionResult>): () => void {
  const files = results.flatMap(filesOf);
  for (const f of files) pins.set(f, (pins.get(f) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const f of files) {
      const n = (pins.get(f) ?? 1) - 1;
      if (n > 0) pins.set(f, n);
      else pins.delete(f);
    }
  };
}

/** How long a matte a reframe read is kept after it, though no clip reads it. */
export const VISION_HOLD_MS = 10 * 60_000;
const held = new Map<string, { readonly timer: ReturnType<typeof setTimeout>; readonly release: () => void }>();

/** Keeps a result for VISION_HOLD_MS (a reframe's matte: a second reframe reads it again). */
export function holdVision(result: ClipVisionResult) {
  const key = filesOf(result)[0]!;
  const was = held.get(key);
  if (was) {
    clearTimeout(was.timer);
    was.release();
  }
  const release = pinVision([result]);
  const timer = setTimeout(() => {
    held.delete(key);
    release();
  }, VISION_HOLD_MS);
  timer.unref();
  held.set(key, { timer, release });
}

export const visionPinned = (file: string) => pins.has(file);
/** Whether any result is being made (the preview's cleanup waits). */
export const visionBusy = () => inflight.size > 0;

// ---- what the export and render_frames read ----

/** The vision data the export planner reads for a clip's media and request. */
export interface ClipVisionData {
  readonly matte?: { readonly file: string; readonly info: Pick<MatteInfo, "fps" | "times" | "width" | "height"> };
  readonly faces?: FaceFrames;
}

/** The planner's lookup (export plan's `vision`) from made results, and why the others weren't made. */
export function visionResolver(ready: Pick<ReadyVision, "made" | "failed">) {
  return (media: Media, request: ClipVisionRequest): ClipVisionData | { readonly problem: string } | undefined => {
    const id = requestId(media.id, request);
    const r = ready.made.get(id);
    if (!r) {
      const problem = ready.failed.get(id);
      return problem ? { problem } : undefined;
    }
    return r.output === "matte" ? { matte: { file: r.video, info: r.info } } : { faces: r.result };
  };
}

export interface ReadyVision {
  readonly made: Map<string, ClipVisionResult>;
  /** Why some results couldn't be made (the module's own sentence), by request id. */
  readonly failed: Map<string, string>;
  readonly release: () => void;
}

/**
 * Makes the vision results a project's clips read (the missing ones), held on disk until `release`.
 * A result that can't be made (no module here, the module's error) is left out with its sentence;
 * a stop (the signal) rejects.
 */
export async function readyVision(
  vision: VisionAnalysis | undefined,
  project: Project,
  dir: string,
  options: { readonly signal?: AbortSignal | undefined; readonly onStep?: ((done: number, total: number) => void) | undefined } = {},
): Promise<ReadyVision> {
  const { targets, refused } = await clipVisionTargets(project, dir);
  const made = new Map<string, ClipVisionResult>();
  const failed = new Map<string, string>(refused.map((r) => [r.id, r.reason]));
  const releases: Array<() => void> = [];
  const release = () => releases.forEach((r) => r());
  try {
    for (const [k, target] of targets.entries()) {
      options.onStep?.(k, targets.length);
      if (!vision) {
        failed.set(target.id, "Vision isn't available here.");
        continue;
      }
      try {
        const result = await ensureClipVision(vision, target, { signal: options.signal });
        made.set(target.id, result);
        releases.push(pinVision([result]));
      } catch (error) {
        if (error instanceof VisionStopped || options.signal?.aborted) throw error;
        failed.set(target.id, (error as Error).message);
      }
    }
  } catch (error) {
    release();
    throw error;
  }
  return { made, failed, release };
}


/** Clips with face blur whose faces weren't found, by name, with why: the export stops rather than show them (D328). */
export function unblurredClips(project: Project, ready: Pick<ReadyVision, "made" | "failed">): Array<string> {
  const flat = flattenSequences(project);
  const out: Array<string> = [];
  for (const item of flat.tracks.flatMap((t) => t.items)) {
    const media = item.type === "clip" ? flat.media.find((m) => m.id === item.media) : undefined;
    if (!media || !live(item, FACE_BLUR)) continue;
    const request = clipRequests(flat, item).find((r) => r.output === "faces");
    const why = request ? (ready.made.has(requestId(media.id, request)) ? undefined : (ready.failed.get(requestId(media.id, request)) ?? "it wasn't analysed")) : visionProblem(flat, item, "faces");
    if (why) out.push(`"${item.name ?? media.name ?? item.id}" (${why.replace(/\.$/, "")})`);
  }
  return out;
}
