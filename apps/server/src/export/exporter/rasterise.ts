// Drawing an export's raster layers with the rasteriser (a step of the export job).
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { link, mkdir, open, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { graphicInfo, type Media, type Project } from "@uncut/core";

import { RASTER_CSS, type ExportPlan, type RasterOutput, type VisualLayer } from "../exportPlan.ts";
import { type Rasterizer, type RasterJob } from "../rasterizer.ts";
import { Cancelled, ffmpegError, run } from "./ffmpeg.ts";
import { withMedia } from "./graphics.ts";

/** The ffmpeg that turns a streamed layer's raw frames into its lossless video (D291). */
export interface SequenceFfmpeg {
  readonly bin: string;
  /** Its major version (`-fps_mode` from 5.1 on; `-vsync` before). */
  readonly major?: number | undefined;
  /** The bytes free for the export's temp folder (a test passes a tiny number); `statfs` by default. */
  readonly freeBytes?: ((dir: string) => Promise<number>) | undefined;
}

/**
 * The share of its raw BGRA size a streamed layer's FFV1 video is assumed to take, for the free-space
 * check (D291). Measured (1080×1350): drone footage drawn by a graphic 0.22, a moving gradient with
 * shapes 0.057, text-like shapes on transparency 0.034. A graphic may draw footage, grainier than
 * that: twice the worst measured. Text and components are mostly transparent: about twice the
 * gradient. Erring higher would refuse exports that fit (a minute of captions isn't gigabytes);
 * a disk that fills anyway is said plainly (`diskFull`).
 */
export const STREAM_RATIO = { graphic: 0.45, raster: 0.1 } as const;

const freeBytesOf = async (dir: string) => {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
};

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(bytes < 1e9 ? 2 : 1)} GB`;

/** ffmpeg's or the file system's "disk full" (D291). */
const NO_SPACE = /No space left on device|ENOSPC/i;
const diskFull = (folder: string) => `The disk filled up in ${folder} while the export drew its graphics. Free some space, then export again.`;

/**
 * The FFV1 arguments for a streamed layer (D291): intra-only (`-g 1`), range coder with the large
 * context, 16 slices (encoded in parallel; ~11 ms a 1080×1350 footage frame on an M-series Mac,
 * under the rasteriser's ~15 ms) or one for a picture too small for 16.
 */
export const ffv1Args = (width: number, height: number) => ["-c:v", "ffv1", "-level", "3", "-coder", "1", "-context", "1", "-g", "1", "-slices", Math.min(width, height) >= 64 ? "16" : "1"];

/** A thrown value's message; one that isn't an Error (or has none) said as what it is, never "undefined". */
const messageOf = (error: unknown): string => {
  const m = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof m === "string" && m) return m;
  return error === undefined || error === null ? "it failed without saying why" : String(error);
};

/** Requests sent ahead of the one being drawn (D291): the rasteriser's round trips overlap its drawing. */
const IN_FLIGHT = 4;

/**
 * Whether a raster layer is streamed (D291) rather than drawn as one PNG per look and linked per
 * frame: a graphic that changes, always; text or a component when it has many looks for its frames
 * (a PNG costs ~70 ms to encode in the rasteriser, a streamed frame a few ms), else its few looks
 * are cheaper drawn once and linked.
 */
export const streamsLayer = (layer: VisualLayer) => {
  if (layer.kind === "graphic") return !!layer.motion || new Set(layer.frames).size > 1;
  if (layer.kind !== "raster") return false;
  return layer.states.length > 1 && layer.states.length * 8 >= layer.frames.length;
};

/** Draw every raster layer (and the canvas colour) with the rasteriser, into `dir`. */
export const rasterise = async (r: Rasterizer, plan: ExportPlan, project: Project, mediaPath: (m: Media) => string, dir: string, signal: AbortSignal, css: string = RASTER_CSS, ff?: SequenceFfmpeg) => {
  const { width, height } = plan.canvas;
  // Without an ffmpeg to stream into (render_frames' few frames), every layer is drawn as PNGs.
  const streamed = (layer: VisualLayer) => !!ff && streamsLayer(layer);
  // D291: the streamed layers stay on disk until the final encode; refused before anything is drawn when they can't fit.
  const need = plan.visuals.reduce((sum, l) => (streamed(l) ? sum + (l.f1 - l.f0) * width * height * 4 * (l.kind === "graphic" ? STREAM_RATIO.graphic : STREAM_RATIO.raster) : sum), 0);
  if (need > 0) {
    const free = await (ff!.freeBytes ?? freeBytesOf)(dir);
    if (free < need) throw new Error(`This export needs about ${gb(need)} free in ${dirname(dir)} for its graphics; there's ${gb(free)}.`);
  }
  const background = join(dir, "background.png");
  await r.render({ width, height, css, html: plan.backgroundHtml, out: background });
  const rasters = new Map<VisualLayer, RasterOutput>();
  const urls = new Map<string, string>();
  // Every distinct look of the layers not streamed drawn once (D79 review: slices and layers share looks), then linked per layer.
  const drawnLooks = new Map<string, string>();
  const looks = [...new Set(plan.visuals.flatMap((l) => (l.kind === "raster" && !streamed(l) ? l.states : [])))];
  for (const [j, html] of looks.entries()) {
    if (signal.aborted) throw new Cancelled();
    const out = join(dir, `look-${j}.png`);
    await r.render({ width, height, css, html: await withMedia(html, project, mediaPath, urls), out });
    drawnLooks.set(html, out);
  }
  const graphicName = (layer: VisualLayer) => `"${layer.item.name ?? layer.item.id}" (${layer.item.src})`;
  const graphicError = (layer: VisualLayer, local: number) => (error: unknown) => {
    if (error instanceof Cancelled) throw error;
    // Its own name comes first in the rasteriser's message ("film" (graphics/x.html): …): said once.
    const why = messageOf(error).replace(/^The text renderer failed: /, "").replace(`${graphicName(layer)}: `, "");
    throw new Error(`The graphic "${layer.item.name ?? layer.item.id}" (${layer.item.src}) couldn't be drawn at ${(local / plan.fps).toFixed(2)} s (its frame ${local}): ${why}`);
  };
  for (const [k, layer] of plan.visuals.entries()) {
    if (signal.aborted) throw new Cancelled();
    if (layer.kind !== "raster" && layer.kind !== "graphic") continue;
    if (streamed(layer)) {
      rasters.set(layer, await streamLayer(r, ff!, layer, { dir, k, width, height, fps: plan.fps, css, signal }, async (send) => {
        if (layer.kind === "graphic") {
          // A graphic (D78): render(t) at each of the frame's moments (one, or motion blur's sub-frames).
          for (const [i, local] of layer.frames.entries()) {
            const ts = layer.motion?.ts[i] ?? [local / plan.fps];
            const prev = i > 0 ? (layer.motion?.ts[i - 1] ?? [layer.frames[i - 1]! / plan.fps]) : undefined;
            if (prev && prev.length === ts.length && prev.every((t, j) => t === ts[j])) await send({ kind: "seq-hold", count: 1 });
            else await send({ kind: "seq-graphic", doc: layer.doc, ts, info: graphicInfo(layer.item, { ...plan.canvas, fps: plan.fps }, local), name: graphicName(layer) }, graphicError(layer, local));
          }
        } else {
          for (const [i, s] of layer.frames.entries()) {
            if (i > 0 && s === layer.frames[i - 1]) await send({ kind: "seq-hold", count: 1 });
            else await send({ kind: "seq-html", css, html: await withMedia(layer.states[s]!, project, mediaPath, urls) });
          }
        }
      }));
      continue;
    }
    const states: Array<string> = [];
    let frames: ReadonlyArray<number> = [];
    if (layer.kind === "graphic") {
      // A graphic without an ffmpeg to stream into (or that never changes): each frame it shows drawn once as a PNG.
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
        await r.render({ kind: "graphic", width, height, doc: layer.doc, t: local / plan.fps, info: graphicInfo(layer.item, { ...plan.canvas, fps: plan.fps }, local), out, name: graphicName(layer) }).catch(graphicError(layer, local));
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

type SeqFrame = Extract<RasterJob, { kind: "seq-graphic" | "seq-html" | "seq-hold" }>;

/**
 * One layer streamed (D291): a FIFO, an ffmpeg reading raw frames from it into the layer's one
 * lossless video (FFV1 in Matroska, straight BGRA as it comes: no conversion, alpha exact; a few
 * times smaller than the PNG sequence it replaces), and the rasteriser writing them (`draw` sends
 * each frame, a few requests ahead): one straight-alpha BGRA frame per frame (motion blur's
 * sub-frames already averaged by the rasteriser; ffmpeg 8's unpremultiply filter can't be relied
 * on for it). Memory stays bounded: the FIFO blocks the rasteriser while ffmpeg catches up.
 */
async function streamLayer(r: Rasterizer, ff: SequenceFfmpeg, layer: VisualLayer, o: { dir: string; k: number; width: number; height: number; fps: number; css: string; signal: AbortSignal }, draw: (send: (job: SeqFrame, onError?: (e: Error) => never) => Promise<void>) => Promise<void>): Promise<RasterOutput> {
  const frames = layer.f1 - layer.f0;
  const name = `"${layer.item.name ?? layer.item.id}"`;
  const fifo = join(o.dir, `l${o.k}.fifo`);
  await promisify(execFile)("mkfifo", [fifo]);
  const file = join(o.dir, `l${o.k}.mkv`);
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  o.signal.addEventListener("abort", onAbort, { once: true });
  const passthrough = ff.major !== undefined && ff.major < 5 ? ["-vsync", "passthrough"] : ["-fps_mode", "passthrough"];
  let ended = false;
  const encoding = run(ff.bin, ["-hide_banner", "-nostdin", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${o.width}x${o.height}`, "-framerate", String(o.fps), "-i", fifo, ...passthrough, ...ffv1Args(o.width, o.height), "-pix_fmt", "bgra", "-f", "matroska", file], stop.signal).finally(() => {
    // An ffmpeg gone before the rasteriser opened the FIFO would leave it waiting for a reader:
    // open and close the read side, so its next write fails instead (EPIPE).
    if (!ended) void open(fifo, constants.O_RDONLY | constants.O_NONBLOCK).then((fh) => fh.close(), () => {});
  });
  encoding.catch(() => {});
  const pending: Array<Promise<unknown>> = [];
  try {
    await r.render({ kind: "seq-open", width: o.width, height: o.height, out: fifo });
    await draw(async (job, onError) => {
      if (o.signal.aborted) throw new Cancelled();
      const p: Promise<unknown> = onError ? r.render(job).catch(onError) : r.render(job);
      // Handled when its turn comes; until then a failure mustn't count as unhandled.
      p.catch(() => {});
      pending.push(p);
      // Ahead by IN_FLIGHT at most; a failure shows at the latest when its turn comes.
      if (pending.length >= IN_FLIGHT) await pending.shift();
    });
    while (pending.length) await pending.shift();
    await r.render({ kind: "seq-close" });
    ended = true;
  } catch (error) {
    ended = true;
    await Promise.allSettled(pending);
    // An ffmpeg that stopped on a full disk shows to the rasteriser as a broken pipe: said as what it is.
    const gone = await Promise.race([encoding.catch(() => undefined), new Promise<undefined>((done) => setTimeout(done, 200, undefined))]);
    stop.abort();
    await r.render({ kind: "seq-close" }).catch(() => {});
    if (o.signal.aborted) throw new Cancelled();
    if (gone && gone.code !== 0 && NO_SPACE.test(gone.stderr)) throw new Error(diskFull(dirname(o.dir)));
    throw error;
  } finally {
    o.signal.removeEventListener("abort", onAbort);
  }
  const done = await encoding;
  if (done.code !== 0) throw new Error(NO_SPACE.test(done.stderr) ? diskFull(dirname(o.dir)) : `ffmpeg couldn't take the frames of ${name}: ${ffmpegError(done.stderr)}`);
  // Its frames counted from the file (one packet each, intra-only: copied, not decoded).
  const counted = await run(ff.bin, ["-hide_banner", "-nostdin", "-v", "error", "-nostats", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "null", "-progress", "pipe:1", "-"], o.signal);
  const written = Number([...counted.stdout.matchAll(/^frame=(\d+)/gm)].pop()?.[1] ?? NaN);
  if (counted.code !== 0 || written !== frames) throw new Error(`The frames of ${name} came out ${Number.isNaN(written) ? "unreadable" : written}, not ${frames}.`);
  return { kind: "video", file, frames };
}
