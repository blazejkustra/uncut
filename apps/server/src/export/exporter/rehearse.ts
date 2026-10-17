// The export's graphics rehearsed (round 2's A2: render_frames and the critic's scan drew a few
// frames each, so a graphic that broke only on a long contiguous run, a picture it held going
// detached at frame 511, shipped a film that couldn't export). A rehearsal calls each graphic's
// render(t) exactly as the export does: the same plan (motion blur's sub-frames included), the same
// order, the same rasteriser window and page (graphicDocument, its media cache and sweep), a held
// frame not drawn again; only nothing is captured or encoded, so it runs at render(t)'s own speed.
// Bounded by a time budget: it covers the film from its start as far as the budget goes and says so.
import { createHash } from "node:crypto";

import type { ExportPlan, VisualLayer } from "../exportPlan.ts";
import type { Rasterizer } from "../rasterizer.ts";

/** Frames per rasteriser request (each request is under the rasteriser's own deadline). */
export const REHEARSE_CHUNK = 60;

export interface Rehearsal {
  /** The first frame the export would fail at, as a sentence (the graphic, the film's second, why). */
  readonly failure?: string;
  /** The film's frame of the failure. */
  readonly frame?: number;
  /** Graphic frames called, and how many the export calls. */
  readonly covered: number;
  readonly total: number;
  /** The film's second the rehearsal reached (all of it when covered === total). */
  readonly reached: number;
}

type GraphicLayer = Extract<VisualLayer, { kind: "graphic" }>;

/** A graphic layer's calls as the export makes them: each frame's moments, a frame equal to the one before it held (not drawn). */
export function rehearsalCalls(layer: GraphicLayer, fps: number): Array<{ readonly i: number; readonly local: number; readonly ts: ReadonlyArray<number> }> {
  const out: Array<{ i: number; local: number; ts: ReadonlyArray<number> }> = [];
  let prev: ReadonlyArray<number> | undefined;
  for (const [i, local] of layer.frames.entries()) {
    const ts = layer.motion?.ts[i] ?? [local / fps];
    if (prev && prev.length === ts.length && prev.every((t, j) => t === ts[j])) continue;
    prev = ts;
    out.push({ i, local, ts });
  }
  return out;
}

// Rehearsals that covered every call of a set of layers without a failure (bounded): not run again.
const passed = new Set<string>();
const PASSED_MAX = 64;
const keyOf = (layers: ReadonlyArray<GraphicLayer>) => {
  const h = createHash("sha256");
  for (const l of layers) h.update(l.doc).update(JSON.stringify([l.f0, l.frames, l.motion?.ts ?? null, l.item.props ?? null]));
  return h.digest("hex");
};

/**
 * Rehearse `plan`'s graphics on `r` within `budgetMs` (see the header). `width`/`height`: the
 * canvas the export draws at. Already passed (the same documents, frames and sub-frames): nothing run.
 */
export async function rehearseGraphics(r: Rasterizer, plan: ExportPlan, o: { readonly budgetMs: number; readonly signal?: AbortSignal; readonly now?: () => number }): Promise<Rehearsal> {
  const now = o.now ?? Date.now;
  const fps = plan.fps;
  const layers = plan.visuals.filter((l): l is GraphicLayer => l.kind === "graphic");
  const calls = layers.map((l) => rehearsalCalls(l, fps));
  const total = calls.reduce((n, c) => n + c.length, 0);
  const end = layers.reduce((s, l) => Math.max(s, l.f1 / fps), 0);
  if (!total) return { covered: 0, total: 0, reached: end };
  const key = keyOf(layers);
  if (passed.has(key)) return { covered: total, total, reached: end };
  const deadline = now() + o.budgetMs;
  let covered = 0;
  let reached = 0;
  let fresh = true;
  const { width, height } = plan.canvas;
  for (const [k, layer] of layers.entries()) {
    const name = `"${layer.item.name ?? layer.item.id}" (${layer.item.src})`;
    const info = { fps, duration: (layer.item.in ?? 0) + layer.item.duration, width, height, props: layer.item.props ?? {} };
    const list = calls[k]!;
    for (let a = 0; a < list.length; a += REHEARSE_CHUNK) {
      if (o.signal?.aborted || now() > deadline) return { covered, total, reached };
      const chunk = list.slice(a, a + REHEARSE_CHUNK);
      try {
        await r.render({ kind: "graphic-run", width, height, doc: layer.doc, info, frames: chunk.map((c) => c.local), ...(layer.motion ? { ts: chunk.map((c) => c.ts) } : {}), name, fresh });
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        const m = /at its frame (\d+(?:\.\d+)?): ([\s\S]*)$/.exec(message);
        const local = m ? Number(m[1]) : chunk[0]!.local;
        const why = (m ? m[2]! : message.replace(/^The text renderer failed: /, "")).replace(`${name}: `, "");
        const at = chunk.find((c) => c.local === local) ?? chunk[0]!;
        const second = (layer.f0 + at.i) / fps;
        return { frame: layer.f0 + at.i, failure: `The graphic ${name} would stop the export at ${second.toFixed(2)} s (its frame ${local}): ${why}`, covered: covered + chunk.indexOf(at), total, reached: second };
      }
      fresh = false;
      covered += chunk.length;
      reached = (layer.f0 + chunk.at(-1)!.i + 1) / fps;
    }
  }
  if (passed.size >= PASSED_MAX) passed.delete(passed.values().next().value!);
  passed.add(key);
  return { covered, total, reached: end };
}

/** The rehearsal as a line for the agent or the critic ("" when there were no graphics to rehearse). */
export function rehearsalLine(x: Rehearsal): string {
  if (x.failure) return `${x.failure}. Fix the graphic: the export calls render(t) for every frame in order (and each motion-blur sub-frame), so whatever throws on any frame stops it.`;
  if (!x.total) return "";
  if (x.covered >= x.total) return "Export rehearsal: every graphic frame ran as the export runs it, in order with motion blur's sub-frames, without an error.";
  return `Export rehearsal: the graphics ran as the export runs them up to ${x.reached.toFixed(2)} s (${x.covered} of ${x.total} frames, time budget) without an error; past that not checked.`;
}
