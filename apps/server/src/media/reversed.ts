// D327: reversed copies of media ranges, for reversed clips. A copy holds media frames [from, to)
// (core reverseRange) backwards, picture and sound, at the original's size: short-GOP H.264 and AAC
// in <project>/.cache/reversed/<media id>--<key of path, size, mtime>--<from>-<to>.mp4, written as
// .part and renamed. ffmpeg's reverse and areverse hold their whole input in memory, so the range is
// reversed in chunks small enough to stay under REVERSE_BUFFER_BYTES each, one ffmpeg at a time
// (4 threads), and the chunks are joined last chunk first. The preview plays the copy; the export
// and render_frames read it, so all three show the same frames.
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { ProxyState } from "@uncut/contracts";

import { reverseRange, type Item, type Media, type Project, type ReverseRange } from "@uncut/core";
import { flattenSequences } from "@uncut/core/nesting";

import { Cancelled, ffmpegWith, run } from "../export/exporter/ffmpeg.ts";
import { posterKey } from "./mediaLibrary/helpers.ts";

/** The most decoded picture one chunk's reverse may hold (bytes). */
export const REVERSE_BUFFER_BYTES = 512e6;
/** Bytes a decoded pixel may take: 16-bit 4:4:4:4 (ProRes 4444) is 8, the most a source decodes to. */
export const BYTES_PER_PIXEL = 8;

export const reversedDir = (projectDir: string) => join(projectDir, ".cache", "reversed");
export const reversedName = (mediaId: string, key: string, range: ReverseRange) => `${mediaId}--${key}--${range.from}-${range.to}.mp4`;

/** What a reversed copy is made from and where it goes. */
export interface ReverseTarget {
  readonly media: Media;
  readonly range: ReverseRange;
  readonly input: string;
  readonly output: string;
}

/** The reversed copies a project's reversed clips read (one per media and range), for the files as they are now. */
export async function reverseTargets(project: Project, dir: string, mediaPath: (m: Media) => string): Promise<Array<ReverseTarget>> {
  const out = new Map<string, ReverseTarget>();
  const clips = flattenSequences(project)
    .tracks.flatMap((t) => t.items)
    .filter((i: Item) => i.reverse && i.type === "clip");
  for (const item of clips) {
    const media = project.media.find((m) => m.id === item.media);
    const range = reverseRange(project, item);
    if (!media || !range) continue;
    const input = mediaPath(media);
    const key = await posterKey(input);
    if (!key) continue;
    const output = join(reversedDir(dir), reversedName(media.id, key, range));
    out.set(output, { media, range, input, output });
  }
  return [...out.values()];
}

/**
 * Makes the reversed copies a project's reversed clips read (the missing ones), held on disk until
 * `release`, and gives the planner's resolver.
 */
export async function readyReversed(ffmpeg: string, project: Project, dir: string, mediaPath: (m: Media) => string, signal?: AbortSignal) {
  const targets = await reverseTargets(project, dir, mediaPath);
  const release = pinReversed(targets);
  try {
    for (const target of targets) await ensureReversed(target, { ffmpeg, fps: project.canvas.fps, signal });
  } catch (error) {
    release();
    throw error;
  }
  return { reversedFile: reversedResolver(targets), release };
}

/** The planner's resolver for reversed copies (export plan's reversedFile), from the targets. */
export function reversedResolver(targets: ReadonlyArray<ReverseTarget>) {
  const files = new Map(targets.map((t) => [`${t.media.id}|${t.range.from}-${t.range.to}`, t.output]));
  return (media: Media, range: ReverseRange) => files.get(`${media.id}|${range.from}-${range.to}`);
}

/** The media path resolver of a project folder. */
export const projectMediaPath = (dir: string) => (m: Media) => (isAbsolute(m.path) ? m.path : resolve(dir, m.path));

/** Chunks of media frames [from, to), each small enough to reverse in memory, the last one first. */
export function reverseChunks(range: ReverseRange, fps: number, media: Pick<Media, "probe">, budget = REVERSE_BUFFER_BYTES): Array<ReverseRange> {
  const w = media.probe?.width ?? 3840;
  const h = media.probe?.height ?? 2160;
  const sourceFps = media.probe?.fps ?? fps;
  const seconds = Math.min(10, budget / (w * h * BYTES_PER_PIXEL * sourceFps));
  const size = Math.max(1, Math.floor(seconds * fps));
  const chunks: Array<ReverseRange> = [];
  for (let from = range.from; from < range.to; from += size) chunks.push({ from, to: Math.min(range.to, from + size) });
  return chunks.reverse();
}

type Encoder = { readonly bin: string; readonly args: ReadonlyArray<string> };

/** libx264 when an ffmpeg has it, else VideoToolbox; keyframes every 10 frames so the preview seeks quickly. */
async function encoderOf(bin: string): Promise<Encoder> {
  const software = await ffmpegWith(bin, "libx264");
  if (software) return { bin: software, args: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-g", "10", "-bf", "0"] };
  return { bin, args: ["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-q:v", "74", "-g", "10", "-bf", "0"] };
}

const QUIET = ["-hide_banner", "-nostdin", "-y", "-v", "error", "-threads", "4", "-filter_threads", "1"];

/** One chunk's picture backwards: the frames starting in [from, to) of the media (project frames at `fps`). */
export function chunkVideoArgs(input: string, chunk: ReverseRange, fps: number, sourceFps: number, encoder: Encoder, output: string): Array<string> {
  const half = 0.5 / sourceFps;
  const start = Math.max(0, chunk.from / fps - half);
  const end = chunk.to / fps - half;
  return [
    ...QUIET,
    "-ss",
    String(start),
    "-t",
    String(Math.max(0.001, end - start)),
    "-i",
    input,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    "reverse,setpts=PTS-STARTPTS,format=yuv420p",
    ...encoder.args,
    "-threads",
    "4",
    "-fps_mode",
    "passthrough",
    "-f",
    "mp4",
    output,
  ];
}

/** One chunk's sound backwards, exactly the chunk's length (padded with silence if the sound is shorter). */
export function chunkAudioArgs(input: string, chunk: ReverseRange, fps: number, output: string): Array<string> {
  const seconds = (chunk.to - chunk.from) / fps;
  return [
    ...QUIET,
    "-ss",
    String(chunk.from / fps),
    "-t",
    String(seconds),
    "-i",
    input,
    "-map",
    "0:a:0",
    "-vn",
    "-af",
    `aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${seconds},atrim=duration=${seconds},areverse`,
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    output,
  ];
}

async function ffmpeg(bin: string, args: ReadonlyArray<string>, signal: AbortSignal | undefined) {
  const r = await run(bin, args, signal);
  if (r.code !== 0) throw new Error(`ffmpeg couldn't reverse the clip: ${r.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 400)}`);
}

const listOf = (files: ReadonlyArray<string>) => files.map((f) => `file '${f.replaceAll("'", "'\\''")}'`).join("\n") + "\n";

export interface ReverseOptions {
  readonly ffmpeg: string;
  readonly fps: number;
  readonly signal?: AbortSignal | undefined;
  /** Chunks done of all (each picture and sound chunk counts once). */
  readonly onProgress?: ((done: number, total: number) => void) | undefined;
  /** The most decoded picture a chunk may hold (default REVERSE_BUFFER_BYTES). */
  readonly bufferBytes?: number | undefined;
}

/** Makes one reversed copy (see the header). */
async function makeReversed(target: ReverseTarget, options: ReverseOptions): Promise<void> {
  const { fps, signal } = options;
  const chunks = reverseChunks(target.range, fps, target.media, options.bufferBytes);
  const hasAudio = target.media.probe?.hasAudio === true;
  const encoder = await encoderOf(options.ffmpeg);
  await mkdir(dirname(target.output), { recursive: true });
  const temp = await mkdtemp(`${target.output}.chunks-`);
  try {
    const videos: Array<string> = [];
    const sounds: Array<string> = [];
    const total = chunks.length * (hasAudio ? 2 : 1) + 1;
    let done = 0;
    for (const [k, chunk] of chunks.entries()) {
      const video = join(temp, `v${k}.mp4`);
      await ffmpeg(encoder.bin, chunkVideoArgs(target.input, chunk, fps, target.media.probe?.fps ?? fps, encoder, video), signal);
      videos.push(video);
      options.onProgress?.(++done, total);
      if (!hasAudio) continue;
      const sound = join(temp, `a${k}.wav`);
      await ffmpeg(options.ffmpeg, chunkAudioArgs(target.input, chunk, fps, sound), signal);
      sounds.push(sound);
      options.onProgress?.(++done, total);
    }
    await writeFile(join(temp, "v.txt"), listOf(videos));
    if (hasAudio) await writeFile(join(temp, "a.txt"), listOf(sounds));
    const part = `${target.output}.part`;
    const concat = (list: string) => ["-f", "concat", "-safe", "0", "-i", join(temp, list)];
    await ffmpeg(
      options.ffmpeg,
      [
        ...QUIET,
        ...concat("v.txt"),
        ...(hasAudio ? concat("a.txt") : []),
        "-map",
        "0:v:0",
        ...(hasAudio ? ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"] : []),
        "-c:v",
        "copy",
        "-tag:v",
        "avc1",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        part,
      ],
      signal,
    );
    if ((await posterKey(target.input)) !== keyOf(target.output)) throw new Error("The footage changed while it was being reversed.");
    await rename(part, target.output);
    options.onProgress?.(total, total);
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    await rm(`${target.output}.part`, { force: true }).catch(() => {});
  }
}

const keyOf = (output: string) => /--([0-9a-f]{12})--\d+-\d+\.mp4$/.exec(output)?.[1];

interface SharedRun {
  readonly done: Promise<void>;
  readonly controller: AbortController;
  readonly progress: Set<(done: number, total: number) => void>;
  wanted: number;
}

/** Copies being made, one run each, shared by everyone who asks for that copy. */
const inflight = new Map<string, SharedRun>();
/** Copies an export or a frame session will read (by output path, how many hold each). */
const pins = new Map<string, number>();

export const reversedExists = (output: string) =>
  stat(output).then(
    (s) => s.isFile(),
    () => false,
  );

/** Keeps copies on disk while something will read them; the returned function lets them go. */
export function pinReversed(targets: ReadonlyArray<ReverseTarget>): () => void {
  for (const t of targets) pins.set(t.output, (pins.get(t.output) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const t of targets) {
      const n = (pins.get(t.output) ?? 1) - 1;
      if (n > 0) pins.set(t.output, n);
      else pins.delete(t.output);
    }
  };
}

/** Whether a copy (or its .part and chunks) is being made or will be read. */
const inUse = (output: string) => pins.has(output) || inflight.has(output);

/** Resolves when `signal` aborts (never without one). */
const aborted = (signal: AbortSignal | undefined) =>
  new Promise<"aborted">((resolveAbort) => {
    if (!signal) return;
    if (signal.aborted) return resolveAbort("aborted");
    signal.addEventListener("abort", () => resolveAbort("aborted"), { once: true });
  });

function startRun(target: ReverseTarget, options: ReverseOptions): SharedRun {
  const controller = new AbortController();
  const progress = new Set<(done: number, total: number) => void>();
  const report = (done: number, total: number) => progress.forEach((p) => p(done, total));
  const done = makeReversed(target, { ...options, signal: controller.signal, onProgress: report }).finally(() => inflight.delete(target.output));
  done.catch(() => {});
  const run: SharedRun = { controller, progress, done, wanted: 0 };
  inflight.set(target.output, run);
  return run;
}

/**
 * Makes a reversed copy unless it's on disk. Everyone asking for the same copy waits for one run;
 * a caller whose signal aborts stops waiting (Cancelled), and the run stops only when no one
 * waits for it any more.
 */
export async function ensureReversed(target: ReverseTarget, options: ReverseOptions): Promise<void> {
  if (await reversedExists(target.output)) return;
  if (options.signal?.aborted) throw new Cancelled();
  const stopping = inflight.get(target.output);
  if (stopping?.controller.signal.aborted) await stopping.done.catch(() => {});
  const run = inflight.get(target.output) ?? startRun(target, options);
  run.wanted++;
  if (options.onProgress) run.progress.add(options.onProgress);
  try {
    if ((await Promise.race([run.done, aborted(options.signal)])) === "aborted") throw new Cancelled();
  } finally {
    if (options.onProgress) run.progress.delete(options.onProgress);
    run.wanted--;
    if (run.wanted === 0) run.controller.abort();
  }
}

export interface ReverseQueueOptions {
  readonly ffmpeg: () => Promise<string | undefined>;
  /** Whether an export is queued or running (it makes the copies it needs itself). */
  readonly exportBusy: () => boolean;
  readonly onChange: (states: ReadonlyArray<ProxyState>) => void;
}

type Run = { readonly target: ReverseTarget; readonly controller: AbortController };

/**
 * The open project's reversed copies for the preview (D327): reconciled with its reversed clips on
 * every change (`sync`), made one at a time in the background, with progress. Copies no clip reads
 * any more are removed.
 */
export class ReverseQueue {
  private states = new Map<string, ProxyState>();
  private targets: Array<ReverseTarget> = [];
  private running: Run | undefined;
  private dir: string | undefined;
  private fps = 30;
  private closed = false;
  private syncing = Promise.resolve();
  private readonly options: ReverseQueueOptions;

  constructor(options: ReverseQueueOptions) {
    this.options = options;
  }

  list(): ReadonlyArray<ProxyState> {
    return [...this.states.values()];
  }

  /** The reversed copy of a media range, when it's made. */
  async fileFor(mediaId: string, from: number, to: number): Promise<string | undefined> {
    const target = this.targets.find((t) => t.media.id === mediaId && t.range.from === from && t.range.to === to);
    return target && (await reversedExists(target.output)) ? target.output : undefined;
  }

  sync(dir: string | undefined, project: Project | undefined): Promise<void> {
    this.syncing = this.syncing.then(() => this.reconcile(dir, project)).catch(() => {});
    return this.syncing;
  }

  shutdown() {
    this.closed = true;
    this.running?.controller.abort();
  }

  /** Waits until nothing is queued or running (tests). */
  async idle(): Promise<void> {
    await this.syncing;
    while (this.running || this.queued().length) await new Promise((r) => setTimeout(r, 50));
  }

  pump() {
    if (this.closed || this.running || this.options.exportBusy()) return;
    const target = this.queued()[0];
    if (!target) return;
    const run: Run = { target, controller: new AbortController() };
    this.running = run;
    void this.make(run).finally(() => {
      if (this.running === run) this.running = undefined;
      this.pump();
    });
  }

  private queued = () => this.targets.filter((t) => this.states.get(t.output)?.phase === "queued");

  private async reconcile(dir: string | undefined, project: Project | undefined) {
    const targets = dir && project ? await reverseTargets(project, dir, projectMediaPath(dir)) : [];
    if (dir !== this.dir) this.states.clear();
    this.dir = dir;
    this.fps = project?.canvas.fps ?? 30;
    this.targets = targets;
    const next = new Map<string, ProxyState>();
    for (const t of targets) {
      const key = keyOf(t.output);
      const reverse = { from: t.range.from, to: t.range.to };
      const was = this.states.get(t.output);
      if (await reversedExists(t.output)) next.set(t.output, { mediaId: t.media.id, phase: "done", progress: 1, reverse, ...(key ? { key } : {}) });
      else next.set(t.output, was && was.phase !== "done" ? was : { mediaId: t.media.id, phase: "queued", progress: 0, reverse, ...(key ? { key } : {}) });
    }
    if (this.running && !next.has(this.running.target.output)) this.running.controller.abort();
    this.states = next;
    if (dir) await this.removeUnused(dir);
    this.publish();
    this.pump();
  }

  /**
   * Copies no clip reads now (a trim moved the range, a clip went forwards, its media went) and
   * leftovers of runs that didn't finish; never one being made or that an export or frame session holds.
   */
  private async removeUnused(dir: string) {
    const folder = reversedDir(dir);
    const wanted = new Set(this.targets.map((t) => t.output));
    const files = await readdir(folder).catch(() => [] as Array<string>);
    const copyOf = (name: string) => join(folder, name.replace(/(\.mp4)(\.part|\.chunks-.*)$/, "$1"));
    const leftover = (f: string) => f !== basename(copyOf(f));
    const stale = files.filter((f) => (leftover(f) || !wanted.has(copyOf(f))) && !inUse(copyOf(f)));
    await Promise.all(stale.map((f) => rm(join(folder, f), { recursive: true, force: true })));
  }

  private publish() {
    const waiting = this.options.exportBusy();
    this.options.onChange([...this.states.values()].map((s) => (s.phase === "queued" && waiting ? { ...s, waiting: "export" as const } : s)));
  }

  private set(output: string, patch: Partial<ProxyState>) {
    const s = this.states.get(output);
    if (!s) return;
    this.states.set(output, { ...s, ...patch });
    this.publish();
  }

  private async make(run: Run) {
    const { target, controller } = run;
    const ffmpeg = await this.options.ffmpeg();
    if (!ffmpeg) return this.set(target.output, { phase: "failed", error: "ffmpeg isn't installed." });
    this.set(target.output, { phase: "running", progress: 0 });
    try {
      await ensureReversed(target, {
        ffmpeg,
        fps: this.fps,
        signal: controller.signal,
        onProgress: (done, total) => this.set(target.output, { progress: Math.min(0.99, done / total) }),
      });
      this.set(target.output, { phase: "done", progress: 1 });
    } catch (error) {
      // A run someone stopped is tried again (it stays queued); only ffmpeg's own failures stick.
      if (controller.signal.aborted || error instanceof Cancelled) this.set(target.output, { phase: "queued", progress: 0 });
      else this.set(target.output, { phase: "failed", error: (error as Error).message });
    }
  }
}
