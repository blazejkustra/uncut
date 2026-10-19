// The export's graphics rehearsed (round 2's A2: render_frames and the critic's scan drew a few
// frames each, so a graphic that broke only on a long contiguous run, a picture it held going
// detached at frame 511, shipped a film that couldn't export). A rehearsal calls each graphic's
// render(t) exactly as the export does: the same plan (motion blur's sub-frames included), the same
// order, the same rasteriser window and page (graphicDocument, its media cache and sweep), a held
// frame not drawn again; only nothing is captured or encoded, so it runs at render(t)'s own speed.
// Bounded by a time budget: it covers the film from its start as far as the budget goes and says so.
import { createHash } from "node:crypto";

import { BLUR_REFINE, blurLevels, blurRefinable } from "@uncut/core";

import type { ExportPlan, VisualLayer } from "../exportPlan.ts";
import { type Rasterizer, RENDER_TIMEOUT_MS } from "../rasterizer.ts";

/**
 * At most this many frames, and this many render(t) calls (motion blur's sub-frames count), per
 * rasteriser request: each request is under the rasteriser's own 30 s deadline, which a graphic
 * drawing footage at 12 sub-frames a frame mustn't reach.
 */
export const REHEARSE_CHUNK = 60;
export const REHEARSE_CALLS = 120;
/** The rasteriser's deadline for one request (rasterizer.ts): a rehearsal that hits it stops there, it doesn't fail. */
const STALLED = /The text renderer took too long/;

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
  /** A request took longer than the rasteriser's deadline: the rehearsal stopped there (not a failure). */
  readonly stalled?: boolean;
}

type GraphicLayer = Extract<VisualLayer, { kind: "graphic" }>;

/**
 * D309: every this many-th frame drawn with motion blur is rehearsed as the export draws a fast
 * move's frame: its sub-frames, then each finer grid motion blur may refine it through (core
 * blurLevels), each in time order. Which frames the export refines depends on their pictures, which
 * a rehearsal doesn't capture: these samples catch a graphic that throws between sub-frames.
 */
export const REHEARSE_REFINED_EVERY = 30;

/** A graphic layer's calls as the export makes them: each frame's moments, a frame equal to the one before it held (not drawn). */
export function rehearsalCalls(layer: GraphicLayer, fps: number): Array<{ readonly i: number; readonly local: number; readonly ts: ReadonlyArray<number> }> {
  const out: Array<{ i: number; local: number; ts: ReadonlyArray<number> }> = [];
  let prev: ReadonlyArray<number> | undefined;
  for (const [i, local] of layer.frames.entries()) {
    const ts = layer.motion?.ts[i] ?? [local / fps];
    if (prev && prev.length === ts.length && prev.every((t, j) => t === ts[j])) continue;
    prev = ts;
    const refined = layer.motion && out.length % REHEARSE_REFINED_EVERY === 0 && blurRefinable(ts) ? [ts, ...blurLevels(ts, Math.max(BLUR_REFINE.max, ts.length))].flat() : ts;
    out.push({ i, local, ts: refined });
  }
  return out;
}

// Rehearsals of a set of layers (bounded), with the budget each had: one that covered everything or
// failed isn't run again, nor a partial one for a budget no bigger (render_frames' calls would
// otherwise rehearse the same first seconds every time).
const done = new Map<string, { readonly result: Rehearsal; readonly budgetMs: number }>();
const DONE_MAX = 64;
const remember = (key: string, result: Rehearsal, budgetMs: number) => {
  if (result.stalled) return result;
  done.delete(key);
  if (done.size >= DONE_MAX) done.delete(done.keys().next().value!);
  done.set(key, { result, budgetMs });
  return result;
};
// A graphic that stalled (a request past the rasteriser's own deadline), by the same key: said again
// at once rather than waiting out the deadline on every call; a changed graphic has another key.
const stalls = new Map<string, Rehearsal>();
const rememberStall = (key: string, result: Rehearsal) => {
  stalls.delete(key);
  if (stalls.size >= DONE_MAX) stalls.delete(stalls.keys().next().value!);
  stalls.set(key, result);
  return result;
};
// The canvas and fps too: render(t, info) gets them (a canvas or fps change reruns it), as do the item's in and duration.
const keyOf = (layers: ReadonlyArray<GraphicLayer>, plan: ExportPlan) => {
  const h = createHash("sha256").update(JSON.stringify([plan.canvas.width, plan.canvas.height, plan.fps]));
  for (const l of layers) h.update(l.doc).update(JSON.stringify([l.f0, l.frames, l.motion?.ts ?? null, l.item.props ?? null, l.item.in ?? 0, l.item.duration]));
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
  const key = keyOf(layers, plan);
  const stalledBefore = stalls.get(key);
  if (stalledBefore) return stalledBefore;
  const before = done.get(key);
  if (before && (before.result.failure || before.result.covered >= total || before.budgetMs >= o.budgetMs)) return before.result;
  const deadline = now() + o.budgetMs;
  let covered = 0;
  let reached = 0;
  let fresh = true;
  const { width, height } = plan.canvas;
  for (const [k, layer] of layers.entries()) {
    const name = `"${layer.item.name ?? layer.item.id}" (${layer.item.src})`;
    const info = { fps, duration: (layer.item.in ?? 0) + layer.item.duration, width, height, props: layer.item.props ?? {} };
    const list = calls[k]!;
    for (let a = 0; a < list.length; ) {
      if (o.signal?.aborted) return { covered, total, reached };
      // Each request waits at most what's left of the budget (and never past the rasteriser's own deadline).
      const left = deadline - now();
      if (left <= 0) return remember(key, { covered, total, reached }, o.budgetMs);
      const capped = left < RENDER_TIMEOUT_MS;
      let b = a + 1;
      for (let calls = list[a]!.ts.length; b < list.length && b - a < REHEARSE_CHUNK && calls + list[b]!.ts.length <= REHEARSE_CALLS; b++) calls += list[b]!.ts.length;
      const chunk = list.slice(a, b);
      a = b;
      try {
        await r.render({ kind: "graphic-run", width, height, doc: layer.doc, info, frames: chunk.map((c) => c.local), ...(layer.motion ? { ts: chunk.map((c) => c.ts) } : {}), name, fresh }, { timeoutMs: left });
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        // Cut short by the budget: the time budget ran out (as between requests). Past the
        // rasteriser's own deadline: a stall, remembered for this graphic.
        if (STALLED.test(message)) return capped ? remember(key, { covered, total, reached }, o.budgetMs) : rememberStall(key, { covered, total, reached, stalled: true });
        // Stopped (the turn, the session closed under it): the rasteriser's "stopped" isn't the graphic's failure.
        if (o.signal?.aborted) return { covered, total, reached };
        const m = /at its frame (\d+(?:\.\d+)?): ([\s\S]*)$/.exec(message);
        const local = m ? Number(m[1]) : chunk[0]!.local;
        const why = (m ? m[2]! : message.replace(/^The text renderer failed: /, "")).replace(`${name}: `, "");
        const at = chunk.find((c) => c.local === local) ?? chunk[0]!;
        const second = (layer.f0 + at.i) / fps;
        const failed = { frame: layer.f0 + at.i, failure: `The graphic ${name} would stop the export at ${second.toFixed(2)} s (its frame ${local}): ${why}`, covered: covered + chunk.indexOf(at), total, reached: second };
        // Only a failure the graphic's own render(t) threw is kept: a rasteriser that crashed or
        // stopped is said this once and rehearsed again next time.
        return m ? remember(key, failed, o.budgetMs) : failed;
      }
      fresh = false;
      covered += chunk.length;
      reached = (layer.f0 + chunk.at(-1)!.i + 1) / fps;
    }
  }
  return remember(key, { covered, total, reached: end }, o.budgetMs);
}

/** The rehearsal as a line for the agent or the critic ("" when there were no graphics to rehearse). */
export function rehearsalLine(x: Rehearsal): string {
  if (x.failure) return `${x.failure}. Fix the graphic: the export calls render(t) for every frame in order (and each motion-blur sub-frame), so whatever throws on any frame stops it.`;
  if (!x.total) return "";
  if (x.covered >= x.total) return "Export rehearsal: every graphic frame ran as the export runs it, in order with motion blur's sub-frames, without an error.";
  return `Export rehearsal: the graphics ran as the export runs them up to ${x.reached.toFixed(2)} s (${x.covered} of ${x.total} frames, ${x.stalled ? "then a stretch took longer than the renderer waits" : "time budget"}) without an error; past that not checked.`;
}
