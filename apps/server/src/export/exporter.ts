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
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, link, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import { ExportError, type ExportJob, type ExportLoudness, type ExportQuality, type ExportSubtitles } from "@uncut/contracts";
import { decodeEnvelope, denoiseMediaIds, duckMediaIds, flattenCues, subtitleCues, subtitleFormatOf, subtitleLanguageTag, targetOfChoice, writeSubtitles, type SpeechEnvelope, type SubtitleFormat } from "@uncut/core";
import { clipFx, colourLut, cubeText, fitRect, fxOverlayHtml, hasOverlay, needsPicturePass } from "@uncut/core";
import { baseBox, canvasBox, componentHtml, irisRadius, maskGeq, moveBox, graphicDocument, graphicInfo, GRAPHIC_SRC, isDrawnComponent, isPlainBox, isSvg, layout, MAX_GRAPHIC_BYTES, solidHtml, SOLID, textHtml, visualsAt, type Media, type Project } from "@uncut/core";
import { clampRange, sliceProject } from "@uncut/core/slice";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { sheetHtml, type SheetLayout } from "../agent/agentFootage.ts";
import { ServerConfig } from "../app/config.ts";
import {
  boxGraph,
  exportCommand,
  fxGraph,
  planLuts,
  placementOf,
  planLoudness,
  outputSize,
  planExport,
  rasterLooks,
  RASTER_CSS,
  sourceFramePick,
  graphFileArgs,
  MEDIA_TOKEN,
  mediaToken,
  silentFailure,
  svgClipHtml,
  blurFilters,
  untaggedFilter,
  type Caps,
  type ExportPlan,
  type RasterOutput,
  type VisualLayer,
} from "./exportPlan.ts";
import { analyzeLoudness, cachedFor, fingerprint, targetOf, writeCached, type LoudnessResult } from "../analysis/analysis.ts";
import { Projects } from "../project/projects.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "./rasterizer.ts";
import { which } from "../app/setup.ts";
import { overwritesImported } from "./subtitleSources.ts";
import { withoutApiKey } from "../app/shellEnv.ts";

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
}

/** How long an export waits to measure a ducking key's loudness that isn't cached (D85). */
const DUCK_MEASURE_MS = 60_000;

export interface RenderedFrame {
  readonly frame: number;
  readonly jpeg: Buffer;
  /** What this frame leaves out (a graphic whose file couldn't be read), as sentences. */
  readonly notes?: ReadonlyArray<string>;
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
  readonly renderFrames: (frames: ReadonlyArray<number>, width: number) => Effect.Effect<ReadonlyArray<RenderedFrame>, ExportError>;
  /** contact_sheet (D65): the first video stream of `path` at each of `seconds`, `width` px wide, as JPEGs. */
  readonly mediaFrames: (path: string, seconds: ReadonlyArray<number>, width: number, fps: number) => Effect.Effect<ReadonlyArray<MediaFrame>, ExportError>;
  /** contact_sheet (D65): the cells in a grid with their captions, drawn by the rasteriser, as one JPEG. */
  readonly sheetImage: (cells: ReadonlyArray<{ readonly jpeg: Buffer; readonly caption: string }>, layout: SheetLayout) => Effect.Effect<Buffer, ExportError>;
  /** D105: the open project's subtitles as a .srt or .vtt file (the format by the extension), no video. */
  readonly saveSubtitles: (input: { readonly output: string; readonly overwrite?: boolean | undefined }) => Effect.Effect<SavedSubtitles, ExportError>;
}

export interface SavedSubtitles {
  readonly path: string;
  readonly format: SubtitleFormat;
  readonly cues: number;
}

/** Said when there is nothing to put in a subtitles file. */
export const NO_SUBTITLES = "There are no captions or subtitles to export: make captions (Transcript, Make captions) or import a .srt or .vtt file first.";

/** Write a file into place without leaving half of it: a sibling temp file, then a rename. */
async function writeInto(path: string, text: string) {
  const staging = join(dirname(path), `.${basename(path)}.uncut-${randomUUID().slice(0, 8)}`);
  try {
    await writeFile(staging, text);
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}

/**
 * D105: the open project's subtitles (core subtitleCues: captions cards and Subtitles tracks, merged
 * by time) written to `output` (.srt or .vtt), or why not: the same path checks as a video export.
 */
export async function saveSubtitlesFile(project: Project, projectDir: string, mediaPath: (m: Media) => string, output: string, overwrite = false): Promise<SavedSubtitles | { readonly reason: "invalid-path" | "exists" | "empty" | "source-media"; readonly message: string }> {
  const path = output.trim();
  const format = subtitleFormatOf(path);
  if (!isAbsolute(path) || !format) return { reason: "invalid-path", message: "Choose where to save the subtitles: a .srt or .vtt file." };
  const folder = await stat(dirname(path)).then((s) => s.isDirectory(), () => false);
  if (!folder) return { reason: "invalid-path", message: `The folder ${dirname(path)} doesn't exist.` };
  const writable = await access(dirname(path), constants.W_OK).then(() => undefined, (error: unknown) => error);
  if (writable) return { reason: "invalid-path", message: plainFsError(writable, dirname(path)) };
  const target = await canonical(path);
  for (const m of project.media) if ((await canonical(mediaPath(m))) === target) return { reason: "source-media", message: `Saving as ${basename(path)} would replace a file this project uses. Choose another name or folder.` };
  const imported = await overwritesImported(projectDir, path);
  if (imported) return { reason: "source-media", message: imported };
  if (!overwrite && (await exists(path))) return { reason: "exists", message: `${basename(path)} already exists in that folder.` };
  const cues = subtitleCues(project);
  if (!cues.length) return { reason: "empty", message: NO_SUBTITLES };
  try {
    await writeInto(path, writeSubtitles(cues, project.canvas.fps, format));
  } catch (error) {
    return { reason: "invalid-path", message: plainFsError(error, dirname(path)) };
  }
  return { path, format, cues: cues.length };
}

export class Exporter extends Context.Service<Exporter, ExporterShape>()("uncut/Exporter") {}

const MAX_JOBS_KEPT = 10;
const TEMP_PREFIX = "uncut-export-";
/** A temp folder of this server's: the prefix, our pid (so a sweep can tell whose it is), random. */
const makeTemp = () => mkdtemp(join(tmpdir(), `${TEMP_PREFIX}${process.pid}-`));

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Removes export and rasteriser temp folders a server left behind (a crash, a forced quit) from
 * the OS temp dir: those whose owning server (the pid in the name) is gone, and any older than an
 * hour without a pid in the name.
 */
export async function sweepStaleTemp(dir = tmpdir(), now = Date.now()) {
  const names = await readdir(dir).catch(() => [] as Array<string>);
  await Promise.all(
    names.map(async (name) => {
      const m = /^(?:uncut-export-|uncut-render-profile-)(?:(\d+)-)?[A-Za-z0-9]{6}$/.exec(name);
      if (!m) return;
      const pid = m[1] ? Number(m[1]) : undefined;
      if (pid === process.pid) return;
      if (pid !== undefined ? pidAlive(pid) : now - (await stat(join(dir, name)).then((s) => s.mtimeMs, () => now)) < 3600_000) return;
      await rm(join(dir, name), { recursive: true, force: true }).catch(() => {});
    }),
  );
}

/** A file system error as a sentence. */
export function plainFsError(error: unknown, where: string): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  switch (code) {
    case "EACCES":
    case "EPERM":
      return `Uncut isn't allowed to write in ${where}. Choose another folder.`;
    case "EROFS":
      return `${where} is read-only. Choose another folder.`;
    case "ENOSPC":
      return "The disk is full. Free some space or choose another disk, then export again.";
    case "EDQUOT":
      return "You're over your disk quota. Free some space, then export again.";
    case "ENOENT":
      return `${where} isn't there any more. Choose another folder.`;
    case "EXDEV":
      return `The video couldn't be moved to ${where}. Choose another folder.`;
    default:
      return (error as Error)?.message || "The export stopped unexpectedly.";
  }
}

/**
 * A project's graphic files (D78), read once: src → its HTML. Only files inside the project's
 * graphics/ folder (by realpath, so a symlink can't reach out), named as the format says, at most
 * MAX_GRAPHIC_BYTES; anything else is left out (the plan then warns that it isn't drawn).
 */
export async function readGraphics(dir: string, project: Project): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const srcs = new Set(project.tracks.flatMap((t) => t.items).filter((i) => i.type === "graphic" && typeof i.src === "string").map((i) => i.src!));
  if (!srcs.size) return out;
  const folder = await realpath(join(dir, "graphics")).catch(() => undefined);
  const home = await realpath(dir).catch(() => undefined);
  // A graphics folder that is a symlink out of the project is no source of graphics.
  if (!folder || !home || !folder.startsWith(`${home}/`)) return out;
  for (const src of srcs) {
    if (!GRAPHIC_SRC.test(src)) continue;
    try {
      const real = await realpath(resolve(dir, src));
      if (!real.startsWith(`${folder}/`)) continue;
      const s = await stat(real);
      if (!s.isFile() || s.size > MAX_GRAPHIC_BYTES) continue;
      out.set(src, await readFile(real, "utf8"));
    } catch {}
  }
  return out;
}

/** Images a component can show (as data: URLs in the rasteriser): what Chromium decodes. TIFF and HEIC it doesn't, so the Inspector doesn't offer them (core COMPONENT_IMAGE). */
const IMAGE_MIME: Readonly<Record<string, string>> = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };
const BLANK_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const TOKEN = new RegExp(`${MEDIA_TOKEN}([a-z0-9][a-z0-9-]*)`, "g");

/**
 * HTML from the plan with each media placeholder (a component's logo, an SVG clip) replaced by the
 * file as a data: URL, which is all the rasteriser page may load. A file it can't read (or a kind
 * Chromium can't show) becomes a transparent pixel. `cache` keeps each file's URL for the run.
 */
async function withMedia(html: string, project: Project, mediaPath: (m: Media) => string, cache: Map<string, string>): Promise<string> {
  const ids = [...new Set([...html.matchAll(TOKEN)].map((m) => m[1]!))];
  for (const id of ids) {
    if (cache.has(id)) continue;
    const media = project.media.find((m) => m.id === id);
    const mime = media ? IMAGE_MIME[extname(media.path).toLowerCase()] : undefined;
    let url = BLANK_PIXEL;
    if (media && mime) url = await readFile(mediaPath(media)).then((b) => `data:${mime};base64,${b.toString("base64")}`, () => BLANK_PIXEL);
    cache.set(id, url);
  }
  return html.replace(TOKEN, (_, id: string) => cache.get(id) ?? BLANK_PIXEL);
}

/** A path as the file system knows it (symlinks resolved), the parent's when it doesn't exist yet. */
const canonical = async (path: string) => {
  try {
    return await realpath(path);
  } catch {
    return join(await realpath(dirname(path)).catch(() => dirname(path)), basename(path));
  }
};

class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/** What this ffmpeg can do, asked once per binary. */
const capsCache = new Map<string, Promise<Caps>>();
const capsOf = (bin: string) => {
  let caps = capsCache.get(bin);
  if (!caps) {
    const list = (args: Array<string>) => run(bin, args, undefined).then((r) => r.stdout, () => "");
    caps = Promise.all([list(["-hide_banner", "-encoders"]), list(["-hide_banner", "-hwaccels"]), list(["-version"])]).then(([encoders, hwaccels, version]) => {
      const major = /^ffmpeg version n?(\d+)\./m.exec(version)?.[1];
      return {
        encoders: new Set([...encoders.matchAll(/^\s*[VAS][\w.]{5}\s+(\S+)/gm)].map((m) => m[1]!)),
        videotoolboxDecode: /^videotoolbox$/m.test(hwaccels),
        major: major === undefined ? undefined : Number(major),
      };
    });
    capsCache.set(bin, caps);
  }
  return caps;
};

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a tool to the end, killing it (SIGKILL) if `signal` aborts. stdout lines go to `onLine`
 * when given (ffmpeg's -progress), else are kept; stderr keeps its last 64 kB.
 */
function run(bin: string, args: ReadonlyArray<string>, signal: AbortSignal | undefined, onLine?: (line: string) => void): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new Cancelled());
    const child = spawn(bin, [...args], { env: withoutApiKey(process.env), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let partial = "";
    child.stdout.on("data", (d: Buffer) => {
      if (!onLine) return void (stdout += d);
      const lines = (partial + d).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    });
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d).slice(-65536)));
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new Cancelled());
      resolvePromise({ code, stdout, stderr });
    });
  });
}

/**
 * The project with the picture size of media whose probe lacks it read from the file (D75 review):
 * a box fits the picture by its aspect, as the preview's object-fit does with the decoded size.
 */
async function withPictureSizes(ffmpeg: string, project: Project, mediaPath: (m: Media) => string, signal?: AbortSignal): Promise<Project> {
  const ffprobe = join(dirname(ffmpeg), "ffprobe");
  const media = await Promise.all(
    project.media.map(async (m) => {
      if (m.kind === "audio" || (m.probe?.width && m.probe?.height)) return m;
      const r = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", mediaPath(m)], signal ?? new AbortController().signal).catch(() => undefined);
      try {
        const stream = r?.code === 0 ? (JSON.parse(r.stdout) as { streams?: Array<{ width?: number; height?: number }> }).streams?.[0] : undefined;
        return stream?.width && stream.height ? { ...m, probe: { ...(m.probe ?? {}), width: stream.width, height: stream.height } } : m;
      } catch {
        return m;
      }
    }),
  );
  return { ...project, media };
}

/**
 * Video files of a plan whose first video stream has no colour tags, with their height (see
 * CommandOptions.untagged): the preview (Chromium on macOS) reads those as BT.601 with SMPTE-C
 * primaries below 720 lines and as BT.709 from 720 up.
 */
async function untaggedFiles(ffmpeg: string, plan: ExportPlan, signal: AbortSignal): Promise<Map<string, number>> {
  const ffprobe = join(dirname(ffmpeg), "ffprobe");
  const out = new Map<string, number>();
  const videos = new Set(plan.visuals.flatMap((l) => (l.kind === "video" ? [l.file] : [])));
  for (const file of videos) {
    const r = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_space,height", "-of", "json", file], signal).catch((error: Error) => {
      if (error instanceof Cancelled) throw error;
      return undefined;
    });
    let stream: { color_space?: string; height?: number } | undefined;
    try {
      stream = r?.code === 0 ? (JSON.parse(r.stdout) as { streams?: Array<{ color_space?: string; height?: number }> }).streams?.[0] : undefined;
    } catch {}
    if (stream && (!stream.color_space || stream.color_space === "unknown")) out.set(file, stream.height ?? 0);
  }
  return out;
}

/** The last useful lines of ffmpeg's stderr, for an error message. */
const ffmpegError = (stderr: string) =>
  stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(frame=|size=|Press \[q\])/.test(l))
    .slice(-3)
    .join(" ")
    .slice(0, 600);

const exists = (path: string) => access(path, constants.F_OK).then(() => true, () => false);

/** Move a finished file into place: a rename on the same volume, else copy and delete. */
async function moveInto(from: string, to: string) {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    const staging = join(dirname(to), `.${basename(to)}.uncut-${randomUUID().slice(0, 8)}`);
    try {
      await copyFile(from, staging);
      await rename(staging, to);
    } finally {
      await rm(staging, { force: true });
      await rm(from, { force: true });
    }
  }
}

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

    /** Draw every raster layer (and the canvas colour) with the rasteriser, into `dir`. */
    const rasterise = async (r: Rasterizer, plan: ExportPlan, project: Project, mediaPath: (m: Media) => string, dir: string, signal: AbortSignal) => {
      const { width, height } = plan.canvas;
      const background = join(dir, "background.png");
      await r.render({ width, height, css: RASTER_CSS, html: plan.backgroundHtml, out: background });
      const rasters = new Map<VisualLayer, RasterOutput>();
      const urls = new Map<string, string>();
      // Every distinct look drawn once (D79 review: slices and layers share looks), then linked per layer.
      const drawnLooks = new Map<string, string>();
      for (const [j, html] of rasterLooks(plan).entries()) {
        if (signal.aborted) throw new Cancelled();
        const out = join(dir, `look-${j}.png`);
        await r.render({ width, height, css: RASTER_CSS, html: await withMedia(html, project, mediaPath, urls), out });
        drawnLooks.set(html, out);
      }
      for (const [k, layer] of plan.visuals.entries()) {
        if (signal.aborted) throw new Cancelled();
        if (layer.kind !== "raster" && layer.kind !== "graphic") continue;
        const states: Array<string> = [];
        let frames: ReadonlyArray<number> = [];
        if (layer.kind === "graphic") {
          // A graphic (D78): each frame it shows drawn once, render(t) called with t in seconds from its start.
          const drawn = new Map<number, number>();
          for (const local of layer.frames) {
            if (drawn.has(local)) continue;
            if (signal.aborted) throw new Cancelled();
            // The same document at the same frame in another slice of the item: drawn already.
            const seen = drawnLooks.get(`graphic:${local}:${layer.doc}`);
            if (seen) {
              drawn.set(local, states.length);
              states.push(seen);
              continue;
            }
            const out = join(dir, `l${k}-g${local}.png`);
            await r.render({ kind: "graphic", width, height, doc: layer.doc, t: local / plan.fps, info: graphicInfo(layer.item, { ...plan.canvas, fps: plan.fps }, local), out, name: `"${layer.item.name ?? layer.item.id}" (${layer.item.src})` }).catch((error: Error) => {
              throw new Error(`The graphic "${layer.item.name ?? layer.item.id}" (${layer.item.src}) couldn't be drawn at ${(local / plan.fps).toFixed(2)} s: ${error.message.replace(/^The text renderer failed: /, "")}`);
            });
            drawn.set(local, states.length);
            states.push(out);
            drawnLooks.set(`graphic:${local}:${layer.doc}`, out);
          }
          frames = layer.frames.map((local) => drawn.get(local)!);
        } else {
          for (const html of layer.states) states.push(drawnLooks.get(html)!);
          frames = layer.frames;
        }
        if (states.length === 1) {
          rasters.set(layer, { kind: "still", png: states[0]! });
          continue;
        }
        // One file per frame, each a hard link to its look: exact at every animation frame.
        const folder = join(dir, `l${k}`);
        await mkdir(folder);
        for (const [i, s] of frames.entries()) await link(states[s]!, join(folder, `${String(i).padStart(6, "0")}.png`));
        rasters.set(layer, { kind: "sequence", pattern: join(folder, "%06d.png") });
      }
      return { background, rasters };
    };

    /**
     * The loudness envelopes ducking (D85) and noise removal (D88) need, by media id: cached ones, and the missing ones
     * measured here (loudness analysis, written to the cache like the queue's). One that can't be
     * measured is left out: planExport then skips that duck with a warning.
     */
    /** Media (by content fingerprint) whose loudness couldn't be measured for an export this session (D85, D88). */
    const unmeasurable = new Set<string>();
    const duckEnvelopes = async (bin: string, dir: string, project: Project, measure: boolean, signal?: AbortSignal) => {
      const out = new Map<string, SpeechEnvelope | null>();
      for (const id of new Set([...duckMediaIds(project), ...denoiseMediaIds(project)])) {
        const media = project.media.find((m) => m.id === id);
        if (!media) continue;
        const target = targetOf(dir, media, project.canvas.fps);
        let result = (await cachedFor(target, "loudness")) as LoudnessResult | undefined;
        if (!result && !measure) continue;
        if (!result) {
          if (signal?.aborted) throw new Cancelled();
          // A file whose measurement failed or timed out this session isn't tried again on every export.
          const fp = await fingerprint(target.path).catch(() => target.path);
          if (unmeasurable.has(fp)) continue;
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), DUCK_MEASURE_MS);
            const onAbort = () => controller.abort();
            signal?.addEventListener("abort", onAbort, { once: true });
            try {
              result = await analyzeLoudness(bin, target.path, { signal: controller.signal, seconds: target.seconds });
            } finally {
              clearTimeout(timer);
              signal?.removeEventListener("abort", onAbort);
            }
            await writeCached(dir, fp, "loudness", result).catch(() => {});
          } catch (error) {
            // Cancelling the export stops the measurement: that is the export's cancel, not a failure.
            if (signal?.aborted || error instanceof Cancelled) throw new Cancelled();
            unmeasurable.add(fp);
            continue;
          }
        }
        out.set(id, result.hasAudio ? (decodeEnvelope(result.envelope) ?? null) : null);
      }
      return out;
    };

    const runJob = async (job: ExportJob, planned: ExportPlan, project: Project, mediaPath: (m: Media) => string, overwrite: boolean, signal: AbortSignal, replan: (envelopes: ReadonlyMap<string, SpeechEnvelope | null>) => ExportPlan | { readonly problem: string }, cachedEnvelopes: ReadonlyMap<string, SpeechEnvelope | null>) => {
      let plan = planned;
      const started = Date.now();
      let temp: string | undefined;
      let rasterizer: Rasterizer | undefined;
      let end: Partial<ExportJob> = { phase: "failed" };
      try {
        const bin = await ffmpegBin();
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
        const missing = await missingMedia(plan);
        if (missing) throw new Error(missing);
        const caps = await capsOf(bin);
        temp = await makeTemp();
        if (signal.aborted) throw new Cancelled();

        const command = rasterizerCommand();
        if ("problem" in command) throw new Error(command.problem);
        rasterizer = await startRasterizer(command);
        const onAbort = () => void rasterizer?.close();
        signal.addEventListener("abort", onAbort, { once: true });
        const { background, rasters } = await rasterise(rasterizer, plan, project, mediaPath, temp, signal);
        signal.removeEventListener("abort", onAbort);
        await rasterizer.close();
        rasterizer = undefined;

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

        const partial = join(temp, "export.mp4");
        const untagged = await untaggedFiles(bin, plan, signal);
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
        const cmd = exportCommand(plan, { untagged, background, rasters, caps, quality: job.quality, loudnorm, loudness, output: partial, subtitles, luts });
        const graphFile = join(temp, "graph.txt");
        await writeFile(graphFile, cmd.graph);
        const total = plan.frames / plan.fps;
        const renderStart = Date.now();
        patch(job.id, { phase: "rendering", progress: 0 });
        let lastPatch = 0;
        const r = await run(
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
        if (r.code !== 0) throw new Error(`ffmpeg couldn't make the video: ${ffmpegError(r.stderr)}`);
        if (signal.aborted) throw new Cancelled();
        const silent = silentFailure(r.stderr);
        if (silent) throw new Error(`ffmpeg couldn't draw part of the video: ${silent}`);
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
        if (temp) await rm(temp, { recursive: true, force: true }).catch(() => {});
      }
      patch(job.id, { ...end, finishedAt: new Date().toISOString(), elapsedSeconds: Math.round((Date.now() - started) / 100) / 10 });
    };

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
        const size = outputSize(project.canvas, input.quality);
        const bin = (yield* Effect.promise(ffmpegBin))!;
        const sized = yield* Effect.promise(() => withPictureSizes(bin, project, mediaPath));
        const graphics = yield* Effect.promise(() => readGraphics(dir, project));
        // Ducking (D85) needs the key media's loudness envelopes, noise removal (D88) its track's:
        // the cached ones now; the job measures the rest before rendering (one quick ffmpeg pass each).
        const envelopes = yield* Effect.promise(() => duckEnvelopes(bin, dir, sized, false));
        const burnCaptions = input.burnCaptions !== false;
        const replan = (all: ReadonlyMap<string, SpeechEnvelope | null>) => planExport(sized, { mediaPath, ...size, graphic: (src) => graphics.get(src), envelopes: all, burnCaptions });
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
          loudness: input.loudness,
          ...(targetLufs !== undefined ? { targetLufs } : {}),
          phase: "queued",
          progress: 0,
          width: size.width,
          height: size.height,
          fps: project.canvas.fps,
          seconds: Math.round((plan.frames / plan.fps) * 100) / 100,
          startedAt: new Date().toISOString(),
          ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
          ...(subtitlesFile ? { subtitlesFile } : {}),
          ...(input.subtitles?.track ? { subtitleTrack: subtitleLanguageTag(input.subtitles.language) } : {}),
          ...(burnCaptions ? {} : { burnCaptions: false }),
          ...(range ? { range } : {}),
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
          running = runJob(job, plan, sized, mediaPath, input.overwrite === true, controller.signal, replan, envelopes);
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

    const renderFrames = (frames: ReadonlyArray<number>, width: number) =>
      Effect.gen(function* () {
        const { dir, project, mediaPath } = yield* current;
        const bin = yield* Effect.promise(ffmpegBin);
        if (!bin) return yield* new ExportError({ reason: "no-ffmpeg", message: "ffmpeg isn't installed, so frames can't be rendered." });
        return yield* Effect.tryPromise({
          try: async (signal) => renderFramesWith(bin, project, mediaPath, await readGraphics(dir, project), frames, width, signal),
          catch: (error) => new ExportError({ reason: "missing-media", message: (error as Error).message }),
        });
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

    const busy = () => Effect.runSync(SubscriptionRef.get(jobsRef)).some((j) => j.phase === "queued" || j.phase === "preparing" || j.phase === "rendering");
    return Exporter.of({ start, cancel, jobs: SubscriptionRef.changes(jobsRef), jobList: SubscriptionRef.get(jobsRef), busy, renderFrames, mediaFrames, sheetImage, saveSubtitles });
  }),
);

/** The colour tables (D136) a plan uses, as .cube files in `dir`, by key. */
async function writeLuts(plan: Pick<ExportPlan, "visuals">, dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const lut of planLuts(plan)) {
    const file = join(dir, `lut-${lut.key}.cube`);
    await writeFile(file, cubeText(lut));
    out.set(lut.key, file);
  }
  return out;
}

/**
 * Frames of the edit as JPEGs, built the way export builds them: the canvas colour, then every
 * visual at f in visualsAt order (footage at its source time, text and backgrounds drawn by
 * Chromium with the frame's opacity and motion), one ffmpeg run per frame.
 */
async function renderFramesWith(bin: string, unsized: Project, mediaPath: (m: Media) => string, graphics: ReadonlyMap<string, string>, frames: ReadonlyArray<number>, width: number, signal: AbortSignal): Promise<Array<RenderedFrame>> {
  const project = await withPictureSizes(bin, unsized, mediaPath, signal);
  const { starts, duration } = layout(project);
  const W = Math.max(2, Math.round(width / 2) * 2);
  const H = Math.max(2, Math.round((W * project.canvas.height) / project.canvas.width / 2) * 2);
  const caps = await capsOf(bin);
  const command = rasterizerCommand();
  if ("problem" in command) throw new Error(command.problem);
  const temp = await makeTemp();
  let raster: Rasterizer | undefined;
  const onAbort = () => void raster?.close();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    raster = await startRasterizer(command);
    const { width: cw, height: ch } = project.canvas;
    const background = join(temp, "bg.png");
    const plan = planExport(project, { mediaPath, width: W, height: H, graphic: (src) => graphics.get(src) });
    const urls = new Map<string, string>();
    // Components' media references as placeholders, swapped for data: URLs before drawing (as the export does).
    const target = { ...project, mediaUrl: (id: string) => (project.media.find((m) => m.id === id)?.kind === "image" ? mediaToken(id) : undefined) };
    const draw = async (html: string, png: string) => raster!.render({ width: cw, height: ch, css: RASTER_CSS, html: await withMedia(html, project, mediaPath, urls), out: png });
    await raster.render({ width: cw, height: ch, css: RASTER_CSS, html: "problem" in plan ? "" : plan.backgroundHtml, out: background });
    const untagged = "problem" in plan ? new Map<string, number>() : await untaggedFiles(bin, plan, signal);
    const out: Array<RenderedFrame> = [];
    // The colour tables (D136) written so far, by key.
    const luts = new Map<string, string>();
    for (const requested of frames) {
      const f = Math.max(0, Math.min(duration - 1, Math.floor(requested)));
      const notes: Array<string> = [];
      const inputs: Array<string> = ["-i", background];
      const graph: Array<string> = [`[0:v]scale=${W}:${H},format=rgba[b0]`];
      let base = "b0";
      let k = 0;
      for (const v of visualsAt(project, starts, f)) {
        const media = v.item.media ? project.media.find((m) => m.id === v.item.media) : undefined;
        let input: Array<string> | undefined;
        // The source frame on screen at that moment, picked like the export picks it (exportPlan.ts).
        const pick = sourceFramePick(v.source, project.canvas.fps, v.item.type === "clip" && v.item.hold === true && !v.item.loop);
        const local = f - (starts.get(v.item.id) ?? 0);
        const svg = v.item.type === "clip" && isSvg(media) && !!v.box;
        if (v.item.type === "clip" && media && media.kind === "video") input = [...(caps.videotoolboxDecode ? ["-hwaccel", "videotoolbox"] : []), ...pick.seekArgs, "-i", mediaPath(media)];
        else if (svg) {
          // An SVG (D76): drawn by Chromium in its box, as the export does.
          const png = join(temp, `f${f}-${k}.png`);
          await draw(svgClipHtml(v.item, v.box!, mediaToken(media!.id), v.opacity), png);
          input = ["-f", "image2", "-pattern_type", "none", "-i", png];
        } else if (v.item.type === "clip" && media && media.kind === "image") input = ["-f", "image2", "-pattern_type", "none", "-i", mediaPath(media)];
        else if ((v.item.type === "text" && typeof v.item.text === "string") || (v.item.type === "component" && v.item.component === SOLID) || isDrawnComponent(v.item)) {
          const png = join(temp, `f${f}-${k}.png`);
          const html =
            v.item.type === "text"
              ? textHtml(v.item, project, { opacity: v.opacity, motion: v.motion })
              : v.item.component === SOLID
                ? solidHtml(v.item, project, { opacity: v.opacity })
                : componentHtml(v.item, target, local, { opacity: v.opacity, motion: v.motion, fps: project.canvas.fps, ...(v.box ? { box: v.box } : {}) });
          await draw(html, png);
          input = ["-f", "image2", "-pattern_type", "none", "-i", png];
        } else if (v.item.type === "graphic" && typeof v.item.src === "string") {
          // A graphic (D78) at this frame; its opacity goes on below, like a clip's.
          const html = graphics.get(v.item.src);
          if (html === undefined) {
            notes.push(`the graphic "${v.item.name ?? v.item.id}" isn't drawn: ${v.item.src} couldn't be read (missing, outside graphics/, over ${MAX_GRAPHIC_BYTES / 1024} KB or a name it doesn't take)`);
            continue;
          }
          const png = join(temp, `f${f}-${k}-g.png`);
          const at = Math.max(0, Math.min(v.item.duration - 1, local));
          await raster.render({ kind: "graphic", width: cw, height: ch, doc: graphicDocument(html, project.canvas), t: at / project.canvas.fps, info: graphicInfo(v.item, project.canvas, at), out: png, name: `"${v.item.name ?? v.item.id}" (${v.item.src})` });
          input = ["-f", "image2", "-pattern_type", "none", "-i", png];
        }
        if (!input) continue;
        // A wipe transition shows the left X pixels (even, as the export's crop does).
        const shown = v.wipe === undefined ? W : 2 * Math.floor((W * v.wipe) / 2);
        if (shown <= 0) continue;
        const fade = (v.item.type === "clip" && !svg) || v.item.type === "graphic" ? `,colorchannelmixer=aa=${v.opacity.toFixed(4)}` : "";
        const tag = media ? untaggedFilter(untagged.get(mediaPath(media))) : "";
        const picked = v.item.type === "clip" && media?.kind === "video" ? `${tag}${pick.filter},` : "trim=end_frame=1,setpts=0,";
        // An iris (D79): alpha times the disc at the canvas's centre, for a layer whose top-left is at (ox, oy).
        // A reveal shape (D133): alpha times core's coverage, the same way.
        const iris = (ox: number, oy: number) =>
          v.iris !== undefined
            ? `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(${irisRadius(v.iris, { width: W, height: H }).toFixed(4)}-hypot(X+${ox + 0.5}-${W / 2},Y+${oy + 0.5}-${H / 2})+0.5,0,1)'`
            : v.mask
              ? `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(${maskGeq(v.mask.shape, v.mask.p.toFixed(6), W, H, `(X+${ox + 0.5})`, `(Y+${oy + 0.5})`)}+0.5,0,1)'`
              : "";
        // A blur dissolve (D133): gblur at the frame's sigma (output px).
        const blur = v.blur ? `,${blurFilters((v.blur * H) / ch)}` : "";
        // A clip's looks and effects (D136): picture effects before its box (which it then always has), overlays after it.
        const effects = v.item.type === "clip" && media && !svg ? clipFx(v.item) : undefined;
        const picture = needsPicturePass(effects) || effects?.blur !== undefined;
        const overlay = async () => {
          if (!effects || !hasOverlay(effects) || !v.box) return;
          const png = join(temp, `f${f}-${k}-fx.png`);
          await draw(fxOverlayHtml(effects, v.box, local), png);
          k++;
          inputs.push("-f", "image2", "-pattern_type", "none", "-i", png);
          graph.push(`[${k}:v:0]scale=${W}:${H},format=rgba,colorchannelmixer=aa=${v.opacity.toFixed(4)}${blur}${iris(0, 0)}${shown < W ? `,crop=w=${shown}:h=${H}:x=0:y=0,pad=${W}:${H}:0:0:color=black@0` : ""}[l${k}]`);
          graph.push(`[${base}][l${k}]overlay=format=auto[b${k}]`);
          base = `b${k}`;
        };
        if (v.box && media && !svg && (picture || !isPlainBox(v.box, project.canvas))) {
          // A box (D75; moved by a push or zoom, D79), made as the export makes it; a wipe or iris reveals the canvas.
          const p = placementOf(v.box, W / cw, H / ch, baseBox(v.item, project.canvas, media.probe));
          const visible = Math.min(p.w, shown - p.x);
          if (visible <= 0) continue;
          k++;
          inputs.push(...input);
          if (picture && effects) {
            const lut = effects.colour ? colourLut(effects.colour) : undefined;
            if (lut && !luts.has(lut.key)) {
              const file = join(temp, `lut-${lut.key}.cube`);
              await writeFile(file, cubeText(lut));
              luts.set(lut.key, file);
            }
            // The effects' size as the export's: the picture's fit before any zoom (its placement's when unzoomed).
            const fit = fitRect(baseBox(v.item, project.canvas, media.probe), v.box.fit, media.probe);
            const zoomed = v.box.scale !== 1;
            const lf = { fx: effects, start: starts.get(v.item.id) ?? 0, w: zoomed ? Math.max(1, Math.round((fit.w * W) / cw)) : p.cw, h: zoomed ? Math.max(1, Math.round((fit.h * H) / ch)) : p.ch, k: H / ch, ...(lut ? { lut } : {}) };
            graph.push(`[${k}:v:0]${picked}null[e${k}]`, ...fxGraph(lf, `e${k}`, `s${k}`, project.canvas.fps, f, luts), ...boxGraph([p], `s${k}`, `r${k}`, project.canvas.fps));
          } else graph.push(`[${k}:v:0]${picked}null[s${k}]`, ...boxGraph([p], `s${k}`, `r${k}`, project.canvas.fps));
          graph.push(`[r${k}]format=rgba${fade}${blur}${visible < p.w ? `,crop=w=${visible}:h=${p.h}:x=0:y=0:exact=1` : ""}${iris(p.x, p.y)}[l${k}]`);
          graph.push(`[${base}][l${k}]overlay=x=${p.x}:y=${p.y}:format=auto[b${k}]`);
          base = `b${k}`;
          await overlay();
          continue;
        }
        k++;
        inputs.push(...input);
        const full = `[${k}:v:0]${picked}scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba${fade}`;
        if (!v.box && (v.shift !== undefined || v.shiftY !== undefined || v.zoom !== undefined)) {
          // Text, a background or a graphic pushed or zoomed (D79): the canvas as its box, moved.
          const p = placementOf(moveBox(canvasBox(project.canvas), v.shift, v.zoom, v.shiftY), W / cw, H / ch, canvasBox(project.canvas));
          graph.push(`${full}[s${k}]`, ...boxGraph([p], `s${k}`, `r${k}`, project.canvas.fps));
          graph.push(`[r${k}]format=rgba${blur}[l${k}]`);
          graph.push(`[${base}][l${k}]overlay=x=${p.x}:y=${p.y}:format=auto[b${k}]`);
          base = `b${k}`;
          continue;
        }
        graph.push(`${full}${blur}${iris(0, 0)}${shown < W ? `,crop=w=${shown}:h=${H}:x=0:y=0,pad=${W}:${H}:0:0:color=black@0` : ""}[l${k}]`);
        graph.push(`[${base}][l${k}]overlay=format=auto[b${k}]`);
        base = `b${k}`;
        await overlay();
      }
      graph.push(`[${base}]format=yuvj420p[out]`);
      const file = join(temp, `frame-${f}.jpg`);
      const r = await run(bin, ["-hide_banner", "-nostdin", "-y", "-v", "error", ...inputs, "-filter_complex", graph.join(";"), "-map", "[out]", "-frames:v", "1", "-q:v", "4", "-update", "1", file], signal);
      if (r.code !== 0) throw new Error(`Frame ${f} couldn't be rendered: ${ffmpegError(r.stderr)}`);
      out.push({ frame: f, jpeg: await readFile(file), ...(notes.length ? { notes } : {}) });
    }
    return out;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await raster?.close().catch(() => {});
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

/** The contact sheet's grid drawn by a rasteriser of its own, as a JPEG. */
async function drawSheet(cells: ReadonlyArray<{ readonly jpeg: Buffer; readonly caption: string }>, layout: SheetLayout): Promise<Buffer> {
  const command = rasterizerCommand();
  if ("problem" in command) throw new Error(command.problem);
  const temp = await makeTemp();
  let raster: Rasterizer | undefined;
  try {
    raster = await startRasterizer(command);
    const out = join(temp, "sheet.jpg");
    await raster.render({ width: layout.width, height: layout.height, css: "", html: sheetHtml(cells, layout), out });
    return await readFile(out);
  } finally {
    await raster?.close().catch(() => {});
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

/** At most this many ffmpeg runs at once when pulling a contact sheet's frames from footage. */
const SHEET_CONCURRENCY = 4;

/** A frame pulled from a media file for a contact sheet, and the moment (seconds) it was taken at. */
export interface MediaFrame {
  readonly jpeg: Buffer;
  readonly seconds: number;
}

/**
 * One JPEG per moment of a media file, `width` px wide (height kept to the picture's shape), a
 * few at a time, each the source frame the preview and export show at that moment in a `fps`
 * project (sourceFramePick, D38). Always the file's first video stream (0:v:0): DJI clips also
 * carry an mjpeg cover picture and data streams, and ffmpeg's own pick is the largest picture.
 * A moment past the end of the video stream (its probed length can include longer sound) shows
 * the stream's last frame, and says so through `seconds`.
 */
async function mediaFramesWith(bin: string, path: string, seconds: ReadonlyArray<number>, width: number, fps: number, signal: AbortSignal): Promise<Array<MediaFrame>> {
  const caps = await capsOf(bin);
  const temp = await makeTemp();
  let streamEnd: Promise<number | undefined> | undefined;
  const videoEnd = () =>
    (streamEnd ??= run(join(dirname(bin), "ffprobe"), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration:format=duration", "-of", "json", path], signal).then(
      (r) => {
        try {
          const j = JSON.parse(r.stdout) as { streams?: Array<{ duration?: string }>; format?: { duration?: string } };
          const d = Number(j.streams?.[0]?.duration ?? j.format?.duration);
          return Number.isFinite(d) && d > 0 ? d : undefined;
        } catch {
          return undefined;
        }
      },
      () => undefined,
    ));
  try {
    const out: Array<MediaFrame> = new Array(seconds.length);
    const grab = async (i: number) => {
      const file = join(temp, `cell-${i}.jpg`);
      const pullAt = async (at: number) => {
        const pick = sourceFramePick(at, fps);
        const r = await run(bin, ["-hide_banner", "-nostdin", "-y", "-v", "error", ...(caps.videotoolboxDecode ? ["-hwaccel", "videotoolbox"] : []), ...pick.seekArgs, "-i", path, "-map", "0:v:0", "-vf", `${pick.filter},scale=${Math.max(16, Math.round(width / 2) * 2)}:-2`, "-frames:v", "1", "-q:v", "4", "-update", "1", file], signal);
        // Past the end of the picture ffmpeg writes nothing (and, since 7, exits with an error saying so).
        if (r.code !== 0 && /Nothing was written into output file|received no packets/.test(r.stderr)) return undefined;
        if (r.code !== 0) throw new Error(`Couldn't read ${basename(path)} at ${at.toFixed(2)} s: ${ffmpegError(r.stderr) || `ffmpeg exited with ${r.code}`}`);
        return readFile(file).catch(() => undefined);
      };
      const got = await pullAt(seconds[i]!);
      if (got?.length) return void (out[i] = { jpeg: got, seconds: seconds[i]! });
      // No frame and no error: the moment is past the end of the video stream. Show its last frame.
      const end = await videoEnd();
      const last = end !== undefined ? Math.max(0, end - 0.001) : undefined;
      const tail = last !== undefined && last < seconds[i]! ? await pullAt(last) : undefined;
      if (!tail?.length) throw new Error(`No picture at ${seconds[i]!.toFixed(2)} s of ${basename(path)}.`);
      out[i] = { jpeg: tail, seconds: last! };
    };
    let next = 0;
    let stopped = false;
    const worker = async () => {
      try {
        while (next < seconds.length && !stopped) await grab(next++);
      } catch (error) {
        stopped = true; // the other workers finish the frame they're on, then stop
        throw error;
      }
    };
    // All settled before the temp folder goes, so no ffmpeg is still writing into it.
    const settled = await Promise.allSettled(Array.from({ length: Math.min(SHEET_CONCURRENCY, seconds.length) }, worker));
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failure) throw failure.reason;
    return out;
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Whether `output` is (the same file as) a media file the plan reads. */
async function replacesMedia(output: string, plan: ExportPlan) {
  const target = await canonical(output);
  for (const f of plan.files) if ((await canonical(f.path)) === target) return true;
  return false;
}

/** The prefix of every export's temp folder in the OS temp dir (the tests look for leftovers). */
export const EXPORT_TEMP_PREFIX = TEMP_PREFIX;
