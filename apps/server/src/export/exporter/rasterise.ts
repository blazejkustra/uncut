// Drawing an export's raster layers with the rasteriser (a step of the export job).
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { link, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { graphicInfo, type Media, type Project } from "@uncut/core";

import { RASTER_CSS, type ExportPlan, type RasterOutput, type VisualLayer } from "../exportPlan.ts";
import { type Rasterizer, type RasterJob } from "../rasterizer.ts";
import { Cancelled, ffmpegError, run } from "./ffmpeg.ts";
import { withMedia } from "./graphics.ts";

/** The ffmpeg that turns a streamed layer's raw frames into its PNG sequence (D291). */
export interface SequenceFfmpeg {
  readonly bin: string;
  /** Its major version (`-fps_mode` from 5.1 on; `-vsync` before). */
  readonly major?: number | undefined;
}

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
  const background = join(dir, "background.png");
  await r.render({ width, height, css, html: plan.backgroundHtml, out: background });
  const rasters = new Map<VisualLayer, RasterOutput>();
  const urls = new Map<string, string>();
  // Without an ffmpeg to stream into (render_frames' few frames), every layer is drawn as PNGs.
  const streamed = (layer: VisualLayer) => !!ff && streamsLayer(layer);
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
  const graphicError = (layer: VisualLayer, local: number) => (error: Error) => {
    if (error instanceof Cancelled) throw error;
    throw new Error(`The graphic "${layer.item.name ?? layer.item.id}" (${layer.item.src}) couldn't be drawn at ${(local / plan.fps).toFixed(2)} s: ${error.message.replace(/^The text renderer failed: /, "")}`);
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
 * One layer streamed (D291): a FIFO, an ffmpeg reading raw frames from it into the layer's PNG
 * sequence, and the rasteriser writing them (`draw` sends each frame, a few requests ahead): one
 * straight-alpha BGRA frame per frame (motion blur's sub-frames already averaged by the
 * rasteriser; ffmpeg 8's unpremultiply filter can't be relied on for it). Memory stays bounded:
 * the FIFO blocks the rasteriser while ffmpeg catches up.
 */
async function streamLayer(r: Rasterizer, ff: SequenceFfmpeg, layer: VisualLayer, o: { dir: string; k: number; width: number; height: number; fps: number; css: string; signal: AbortSignal }, draw: (send: (job: SeqFrame, onError?: (e: Error) => never) => Promise<void>) => Promise<void>): Promise<RasterOutput> {
  const frames = layer.f1 - layer.f0;
  const fifo = join(o.dir, `l${o.k}.fifo`);
  await promisify(execFile)("mkfifo", [fifo]);
  const folder = join(o.dir, `l${o.k}`);
  await mkdir(folder);
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  o.signal.addEventListener("abort", onAbort, { once: true });
  const passthrough = ff.major !== undefined && ff.major < 5 ? ["-vsync", "passthrough"] : ["-fps_mode", "passthrough"];
  let ended = false;
  const encoding = run(ff.bin, ["-hide_banner", "-nostdin", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${o.width}x${o.height}`, "-framerate", String(o.fps), "-i", fifo, ...passthrough, "-c:v", "png", "-compression_level", "1", "-start_number", "0", join(folder, "%06d.png")], stop.signal).finally(() => {
    // An ffmpeg gone before the rasteriser opened the FIFO would leave it waiting for a reader:
    // open and close the read side, so its next write fails instead (EPIPE).
    if (!ended) void open(fifo, constants.O_RDONLY | constants.O_NONBLOCK).then((fh) => fh.close(), () => {});
  });
  encoding.catch(() => {});
  const pending: Array<Promise<void>> = [];
  try {
    await r.render({ kind: "seq-open", width: o.width, height: o.height, out: fifo });
    await draw(async (job, onError) => {
      if (o.signal.aborted) throw new Cancelled();
      const p = onError ? r.render(job).catch(onError) : r.render(job);
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
    stop.abort();
    await r.render({ kind: "seq-close" }).catch(() => {});
    throw o.signal.aborted ? new Cancelled() : error;
  } finally {
    o.signal.removeEventListener("abort", onAbort);
  }
  const done = await encoding;
  if (done.code !== 0) throw new Error(`ffmpeg couldn't take the frames of "${layer.item.name ?? layer.item.id}": ${ffmpegError(done.stderr)}`);
  const written = (await readdir(folder)).length;
  if (written !== frames) throw new Error(`The frames of "${layer.item.name ?? layer.item.id}" came out ${written}, not ${frames}.`);
  return { kind: "sequence", pattern: join(folder, "%06d.png") };
}
