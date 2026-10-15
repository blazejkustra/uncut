// Drawing an export's raster layers with the rasteriser (a step of the export job).
import { link, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { graphicInfo, type Media, type Project } from "@uncut/core";

import { rasterLooks, RASTER_CSS, type ExportPlan, type RasterOutput, type VisualLayer } from "../exportPlan.ts";
import { type Rasterizer } from "../rasterizer.ts";
import { Cancelled } from "./ffmpeg.ts";
import { withMedia } from "./graphics.ts";

/** Draw every raster layer (and the canvas colour) with the rasteriser, into `dir`. */
export const rasterise = async (r: Rasterizer, plan: ExportPlan, project: Project, mediaPath: (m: Media) => string, dir: string, signal: AbortSignal, css: string = RASTER_CSS) => {
  const { width, height } = plan.canvas;
  const background = join(dir, "background.png");
  await r.render({ width, height, css, html: plan.backgroundHtml, out: background });
  const rasters = new Map<VisualLayer, RasterOutput>();
  const urls = new Map<string, string>();
  // Every distinct look drawn once (D79 review: slices and layers share looks), then linked per layer.
  const drawnLooks = new Map<string, string>();
  for (const [j, html] of rasterLooks(plan).entries()) {
    if (signal.aborted) throw new Cancelled();
    const out = join(dir, `look-${j}.png`);
    await r.render({ width, height, css, html: await withMedia(html, project, mediaPath, urls), out });
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
