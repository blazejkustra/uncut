// Motion defects only consecutive full-size frames show (handoff 13 and 16): text that shakes by a
// pixel (moves 1 px and comes straight back while the rest holds still: in argent-100s the spring's
// sub-pixel tail moved a card smoothly while its words jumped whole pixels), and a 1 px sliver along
// the frame's edge (argent-family: a full-screen panel landing 0.3 px short of the left edge showed
// a line of the camera under it). Both are a pixel at the canvas's own size, so a scaled-down strip
// or the critic's 64 px scan can't see them. Measured on grey frames at the canvas size (criticMotion
// grayFrames); render_frames' run and review_submit render them.
import type { CriticFinding } from "./agentCritic.ts";
import { grayFrames } from "./criticMotion.ts";

/** Tiles the frame is cut into for the shift search (px). */
export const TILE_W = 96;
export const TILE_H = 48;
/** The largest vertical shift (px) searched between two frames. */
export const MAX_SHIFT = 2;
/** A tile with less vertical detail than this (mean |Δ| between rows, 0..255) has nothing to track. */
export const MIN_DETAIL = 2;
/** Below this mean difference (0..255) a tile hasn't moved; a shift must match this well, or this share of the unmoved difference. */
export const STILL_DIFF = 0.75;
export const MATCH_DIFF = 2;
export const MATCH_SHARE = 0.25;
/** A shake comes back within this many frames and is followed by this many frames that don't carry on in its return's direction. */
export const SHAKE_GAP = 4;
export const SHAKE_REST = 3;
/**
 * A sliver: along an edge, the outermost line differs from the next by at least SLIVER_STEP (0..255)
 * while the next two lines agree within SLIVER_FLAT, over at least SLIVER_SHARE of the edge.
 */
export const SLIVER_STEP = 20;
export const SLIVER_FLAT = 6;
export const SLIVER_SHARE = 0.5;

export interface GrayFrame {
  readonly frame: number;
  readonly gray: Uint8Array;
}
export interface Shake {
  /** The frame the region first moves on, and the frame it is back on. */
  readonly frame: number;
  readonly back: number;
  /** "up" when it first moves up. */
  readonly way: "up" | "down";
  /** The region (canvas px) covering every tile that shook there. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly tiles: number;
}
export type Edge = "left" | "right" | "top" | "bottom";
export interface Sliver {
  readonly edge: Edge;
  readonly start: number;
  readonly end: number;
}

function meanDiff(a: Uint8Array, b: Uint8Array, width: number, x0: number, y0: number, w: number, h: number, shift: number): number {
  let sum = 0;
  for (let y = y0; y < y0 + h; y++) {
    const ra = y * width + x0;
    const rb = (y + shift) * width + x0;
    for (let x = 0; x < w; x++) sum += Math.abs(a[ra + x]! - b[rb + x]!);
  }
  return sum / (w * h);
}

function detail(a: Uint8Array, width: number, x0: number, y0: number, w: number, h: number): number {
  let sum = 0;
  for (let y = y0; y < y0 + h - 1; y++) for (let x = x0; x < x0 + w; x++) sum += Math.abs(a[y * width + x]! - a[(y + 1) * width + x]!);
  return sum / (w * (h - 1));
}

/** How far (px, down positive) a tile's picture moved from `a` to `b`: 0 still, undefined when it changed some other way or holds nothing to track. */
export function tileShift(a: Uint8Array, b: Uint8Array, width: number, x0: number, y0: number, w: number, h: number): number | undefined {
  const still = meanDiff(a, b, width, x0, y0, w, h, 0);
  if (still < STILL_DIFF) return 0;
  if (detail(a, width, x0, y0, w, h) < MIN_DETAIL) return undefined;
  let best = 0;
  let bestDiff = still;
  for (let s = -MAX_SHIFT; s <= MAX_SHIFT; s++) {
    if (s === 0) continue;
    const d = meanDiff(a, b, width, x0, y0, w, h, s);
    if (d < bestDiff) [best, bestDiff] = [s, d];
  }
  return best !== 0 && bestDiff <= Math.max(MATCH_DIFF, MATCH_SHARE * still) ? best : undefined;
}

/** Index of the shake that starts at step i of `steps` (each the shift from one frame to the next), if one does. */
function shakeAt(steps: ReadonlyArray<number | undefined>, i: number): number | undefined {
  const first = steps[i];
  if (first !== 1 && first !== -1) return undefined;
  for (let j = i + 1; j <= i + SHAKE_GAP && j < steps.length; j++) {
    const s = steps[j];
    if (s === 0) continue;
    if (s !== -first) return undefined;
    if (j + SHAKE_REST >= steps.length) return undefined;
    const after = steps.slice(j + 1, j + 1 + SHAKE_REST);
    return after.every((x) => x !== undefined && Math.sign(x) !== Math.sign(s)) ? j : undefined;
  }
  return undefined;
}

/**
 * Regions that move exactly 1 px and come straight back (within SHAKE_GAP frames), then don't
 * carry on in the direction they came back in: a shake, never a move, a float or a settle. `frames`
 * are consecutive frames of the edit, each width × height grey.
 */
export function findShakes(frames: ReadonlyArray<GrayFrame>, width: number, height: number): Array<Shake> {
  if (frames.length < SHAKE_REST + 3) return [];
  const found = new Map<string, { frame: number; back: number; way: "up" | "down"; x0: number; y0: number; x1: number; y1: number; tiles: number }>();
  for (let y0 = MAX_SHIFT; y0 + TILE_H + MAX_SHIFT <= height; y0 += TILE_H) {
    for (let x0 = 0; x0 + TILE_W <= width; x0 += TILE_W) {
      const steps = frames
        .slice(1)
        .map((f, k) => (f.frame === frames[k]!.frame + 1 ? tileShift(frames[k]!.gray, f.gray, width, x0, y0, TILE_W, TILE_H) : undefined));
      for (let i = 0; i < steps.length; i++) {
        const j = shakeAt(steps, i);
        if (j === undefined) continue;
        const frame = frames[i + 1]!.frame;
        const back = frames[j + 1]!.frame;
        const key = `${frame}:${back}`;
        const had = found.get(key);
        const tile = { x0, y0, x1: x0 + TILE_W, y1: y0 + TILE_H };
        found.set(
          key,
          had
            ? {
                ...had,
                x0: Math.min(had.x0, tile.x0),
                y0: Math.min(had.y0, tile.y0),
                x1: Math.max(had.x1, tile.x1),
                y1: Math.max(had.y1, tile.y1),
                tiles: had.tiles + 1,
              }
            : { frame, back, way: steps[i]! < 0 ? "up" : "down", ...tile, tiles: 1 },
        );
        i = j;
      }
    }
  }
  return [...found.values()]
    .map((s) => ({ frame: s.frame, back: s.back, way: s.way, x: s.x0, y: s.y0, w: s.x1 - s.x0, h: s.y1 - s.y0, tiles: s.tiles }))
    .sort((a, b) => a.frame - b.frame || b.tiles - a.tiles);
}

/** The pixel of `edge`'s line `depth` (0 the outermost) at position i along it. */
function edgePixel(gray: Uint8Array, width: number, height: number, edge: Edge, depth: number, i: number): number {
  if (edge === "left") return gray[i * width + depth]!;
  if (edge === "right") return gray[i * width + width - 1 - depth]!;
  if (edge === "top") return gray[depth * width + i]!;
  return gray[(height - 1 - depth) * width + i]!;
}

/** Whether `edge` of a width × height grey frame has a 1 px line unlike the picture inside it. */
export function hasSliver(gray: Uint8Array, width: number, height: number, edge: Edge): boolean {
  const n = edge === "left" || edge === "right" ? height : width;
  let lined = 0;
  for (let i = 0; i < n; i++) {
    const outer = edgePixel(gray, width, height, edge, 0, i);
    const inner = edgePixel(gray, width, height, edge, 1, i);
    const deeper = edgePixel(gray, width, height, edge, 2, i);
    if (Math.abs(outer - inner) >= SLIVER_STEP && Math.abs(inner - deeper) <= SLIVER_FLAT) lined++;
  }
  return lined >= SLIVER_SHARE * n;
}

/** The runs of frames with a sliver along an edge. */
export function findSlivers(frames: ReadonlyArray<GrayFrame>, width: number, height: number): Array<Sliver> {
  const out: Array<Sliver> = [];
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    let open: { start: number; end: number } | undefined;
    for (const f of frames) {
      if (!hasSliver(f.gray, width, height, edge)) {
        if (open) out.push({ edge, ...open });
        open = undefined;
      } else if (open && f.frame === open.end + 1) open.end = f.frame;
      else {
        if (open) out.push({ edge, ...open });
        open = { start: f.frame, end: f.frame };
      }
    }
    if (open) out.push({ edge, ...open });
  }
  return out.sort((a, b) => a.start - b.start);
}

const secs = (frame: number, fps: number) => `${(frame / fps).toFixed(2)} s`;

/** What render_frames' run and review_submit say about them (rule "motion", never a blocker: a pixel is easy to miss and to over-read). */
export function jitterFindings(shakes: ReadonlyArray<Shake>, slivers: ReadonlyArray<Sliver>, fps: number): Array<CriticFinding> {
  const out: Array<CriticFinding> = [];
  for (const s of shakes.slice(0, 4)) {
    out.push({
      rule: "motion",
      key: `motion:shake:${s.frame}`,
      frame: s.frame,
      range: { start: s.frame, end: s.back },
      hard: false,
      message: `Shaking by a pixel at f ${s.frame} to f ${s.back} (${secs(s.frame, fps)}): the picture at x ${s.x} to ${s.x + s.w}, y ${s.y} to ${s.y + s.h} moves 1 px ${s.way} and straight back while it otherwise holds still, which reads as text vibrating. Usually a move whose last fraction of a pixel lands on text: text is drawn on whole pixels and the box around it isn't. Uncut puts an element whose translate() is under a pixel from its place exactly there; for a move that rests elsewhere, a scale, a canvas or an SVG text, end the move exactly on its value (or round it to whole pixels) once it is under a pixel away.`,
    });
  }
  for (const s of slivers.slice(0, 4)) {
    out.push({
      rule: "motion",
      key: `motion:sliver:${s.edge}:${s.start}`,
      frame: s.start,
      range: { start: s.start, end: s.end },
      hard: false,
      message: `A 1 px line along the ${s.edge} edge from f ${s.start} to f ${s.end} (${secs(s.start, fps)} to ${secs(s.end + 1, fps)}): the outermost pixels differ from the picture right inside them, like a full-screen layer stopping a fraction of a pixel short and showing what is under it. Make the layer cover the frame past that edge (a few px of bleed) or end its move on a whole pixel.`,
    });
  }
  return out;
}

/** The shakes and slivers in consecutive frames of the edit rendered at the canvas size (JPEGs). */
export async function measureRun(
  ffmpeg: string,
  frames: ReadonlyArray<{ readonly frame: number; readonly jpeg: Buffer }>,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<{ shakes: Array<Shake>; slivers: Array<Sliver> }> {
  const grays = await grayFrames(
    ffmpeg,
    frames.map((f) => f.jpeg),
    width,
    height,
    signal,
  );
  const run = frames.map((f, i) => ({ frame: f.frame, gray: grays[i]! }));
  return { shakes: findShakes(run, width, height), slivers: findSlivers(run, width, height) };
}

/**
 * review_submit's runs at the canvas size: FINE_RUN consecutive frames from FINE_LEAD_S after
 * FINE_WINDOWS of the scene changes (spread evenly), where what just came in settles; rendered
 * within FINE_BUDGET_MS (about 0.4 s a frame at 1080p).
 */
export const FINE_WINDOWS = 3;
export const FINE_LEAD_S = 0.1;
export const FINE_RUN = 16;
export const FINE_BUDGET_MS = 15_000;

export function finePlan(anchors: ReadonlyArray<{ readonly frame: number }>, fps: number, duration: number): Array<Array<number>> {
  if (!anchors.length || duration < SHAKE_REST + 3) return [];
  const picked =
    anchors.length <= FINE_WINDOWS
      ? anchors
      : Array.from({ length: FINE_WINDOWS }, (_, i) => anchors[Math.round((i * (anchors.length - 1)) / (FINE_WINDOWS - 1))]!);
  const runs: Array<Array<number>> = [];
  let covered = -1;
  for (const a of picked) {
    const start = Math.max(covered + 1, Math.min(duration - FINE_RUN, a.frame + Math.round(FINE_LEAD_S * fps)), 0);
    const end = Math.min(duration - 1, start + FINE_RUN - 1);
    if (end - start + 1 < SHAKE_REST + 3) continue;
    runs.push(Array.from({ length: end - start + 1 }, (_, i) => start + i));
    covered = end;
  }
  return runs;
}
