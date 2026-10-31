// A graphic's elements (D316): its document drawn in a rasteriser with the project's media, without
// capturing, and what it shows at each sample read (core GRAPHIC_SCAN). Measured once per document
// and kept in the project's .cache: edits carry the span they were made from, so the export never
// needs this, and only the timeline, the Inspector and the agent read it.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  type GraphicElements,
  type Item,
  type Media,
  type Project,
  type ScannedElement,
  graphicDocument,
  graphicElementsFrom,
  graphicInfo,
  graphicTime,
  joinScans,
  scanTimes,
} from "@uncut/core";

import { capsOf } from "./exporter/ffmpeg.ts";
import { projectGraphics } from "./exporter/graphics.ts";
import { graphicMediaSource } from "./graphicMedia.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "./rasterizer.ts";

/** Samples at most, whatever the graphic's length, and per rasteriser request (each stays under its deadline). */
const MAX_SAMPLES = 6000;
const CHUNK = 500;
/** A graphic slower than this to sample stays one block. */
const BUDGET_MS = 90_000;
/** Bump when a scan's result changes shape or meaning: older cache files are then ignored. */
const CACHE_VERSION = 1;

export interface ScanPaths {
  readonly graphicLibsDir: string;
  readonly fontsDir: string;
  readonly dataDir: string;
}

const itemsOf = (project: Project, src: string) => project.tracks.flatMap((t) => t.items).filter((i) => i.type === "graphic" && i.src === src);

/** The graphic's own length that the project shows, in frames (at least the longest item's). */
const ownLength = (items: ReadonlyArray<Item>) => Math.max(1, ...items.map((i) => graphicTime(i, i.duration - 1) + 1));

const failed = (why: string): GraphicElements => ({
  elements: [],
  reason: `Uncut couldn't read this graphic's elements (${why}). It stays one block: edit it as a whole.`,
});

/** The page's elements at each of `ts`, a request at a time, or why it stopped. */
async function scanned(raster: Rasterizer, job: { doc: string; info: Record<string, unknown>; width: number; height: number }, ts: ReadonlyArray<number>) {
  const chunks: Array<ReadonlyArray<ScannedElement>> = [];
  const offsets: Array<number> = [];
  const deadline = Date.now() + BUDGET_MS;
  for (let at = 0; at < ts.length; at += CHUNK) {
    if (Date.now() > deadline) return undefined;
    const reply = await raster.render({ kind: "graphic-scan", ...job, ts: ts.slice(at, at + CHUNK) });
    if (!reply || !Array.isArray(reply.scan)) return undefined;
    chunks.push(reply.scan as ReadonlyArray<ScannedElement>);
    offsets.push(at);
  }
  return joinScans(chunks, offsets);
}

async function measure(bin: string, dir: string, project: Project, src: string, doc: string, items: ReadonlyArray<Item>): Promise<GraphicElements> {
  const command = rasterizerCommand();
  if ("problem" in command) return failed(command.problem);
  const fps = project.canvas.fps;
  const length = ownLength(items);
  const caps = await capsOf(bin);
  const mediaPath = (m: Media) => (isAbsolute(m.path) ? m.path : resolve(dir, m.path));
  const media = graphicMediaSource({ bin, media: () => project.media, mediaPath, videotoolbox: caps.videotoolboxDecode });
  const raster = await startRasterizer(command, undefined, { media: media.file });
  try {
    const ts = scanTimes(length / fps, MAX_SAMPLES);
    const info = { ...graphicInfo({ ...items[0]!, elements: undefined } as Item, project.canvas, 0), duration: length } as unknown as Record<string, unknown>;
    const scan = await scanned(raster, { doc, info, width: project.canvas.width, height: project.canvas.height }, ts);
    if (!scan) return failed(`${src} took too long to draw`);
    return graphicElementsFrom(scan, ts, fps, length);
  } finally {
    await raster.close().catch(() => {});
    media.close();
  }
}

const running = new Map<string, Promise<GraphicElements>>();

/**
 * The elements of the project's graphic `src`, on the graphic's own frames. Measured once per
 * document, canvas and fps; the same scan answers while the file's items don't reach past what it
 * covered. A failure comes back as `reason`, never thrown, and isn't kept.
 */
export async function graphicElementsOf(paths: ScanPaths, bin: string | undefined, dir: string, project: Project, src: string): Promise<GraphicElements> {
  const items = itemsOf(project, src);
  if (!items.length) return { elements: [], reason: `${src} isn't on the timeline.` };
  const html = (await projectGraphics(paths, dir, project)).graphics.get(src);
  if (html === undefined) return failed(`${src} couldn't be read`);
  const doc = graphicDocument(html, project.canvas);
  const { width, height, fps } = project.canvas;
  const key = createHash("sha256")
    .update(JSON.stringify([CACHE_VERSION, width, height, fps, items[0]!.props ?? null]))
    .update(doc)
    .digest("hex");
  const folder = join(dir, ".cache", "graphic-elements");
  const file = join(folder, `${key}.json`);
  const length = ownLength(items);
  const cached = await readFile(file, "utf8")
    .then((text) => JSON.parse(text) as { readonly length: number; readonly result: GraphicElements })
    .catch(() => undefined);
  if (cached && cached.length >= length) return cached.result;
  const inFlight = running.get(key);
  if (inFlight) return inFlight;
  if (!bin) return failed("ffmpeg isn't installed");
  const work = measure(bin, dir, project, src, doc, items)
    .then(async (result) => {
      const kept = result.elements.length > 0 || !result.reason?.startsWith("Uncut couldn't read");
      if (kept) {
        await mkdir(folder, { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify({ length, result }));
        await rename(temp, file);
      }
      return result;
    })
    .catch((error: Error) => failed(error.message))
    .finally(() => running.delete(key));
  running.set(key, work);
  return work;
}
