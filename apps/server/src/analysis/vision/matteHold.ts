// D332: the matte a dropout frame shows. The last good frame's, moved by how the picture inside its
// matte's box moved since (phase correlation, so a pan carries a bystander away and a tracked
// runner stays put), and only while the picture there still matches: a view that changed lets
// the hold go and the frame shows its own matte.
import { PhaseCorrelator } from "../video/phaseCorrelator.ts";
import { STABILITY } from "./matteStability.ts";

const PATCH_W = 128;
const PATCH_H = 64;
/** A matte pixel at this grey or more counts as kept. */
const KEEP = 128;
/** The box is padded by this share of its size each side, so the correlation sees some of what's around the subject. */
const PAD = 0.25;

export interface Picture {
  readonly pixels: Uint8Array;
  readonly w: number;
  readonly h: number;
}

export interface Good {
  readonly matte: Uint8Array;
  readonly picture: Picture;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The box (in gate pixels) of what a w × h matte keeps, padded; undefined when it keeps nothing. */
export function keptBox(matte: Uint8Array, w: number, h: number, gate: Picture): Box | undefined {
  let x0 = gate.w;
  let y0 = gate.h;
  let x1 = -1;
  let y1 = -1;
  for (let gy = 0; gy < gate.h; gy++) {
    const row = Math.floor(((gy + 0.5) * h) / gate.h) * w;
    for (let gx = 0; gx < gate.w; gx++) {
      if (matte[row + Math.floor(((gx + 0.5) * w) / gate.w)]! < KEEP) continue;
      x0 = Math.min(x0, gx);
      x1 = Math.max(x1, gx);
      y0 = Math.min(y0, gy);
      y1 = Math.max(y1, gy);
    }
  }
  if (x1 < 0) return undefined;
  const padX = Math.ceil((x1 - x0 + 1) * PAD);
  const padY = Math.ceil((y1 - y0 + 1) * PAD);
  const x = Math.max(0, x0 - padX);
  const y = Math.max(0, y0 - padY);
  return { x, y, w: Math.min(gate.w, x1 + 1 + padX) - x, h: Math.min(gate.h, y1 + 1 + padY) - y };
}

/** The box of a picture averaged down to the correlator's patch. */
function patchOf(picture: Picture, box: Box): Uint8Array {
  const out = new Uint8Array(PATCH_W * PATCH_H);
  for (let py = 0; py < PATCH_H; py++) {
    const y0 = box.y + Math.floor((py * box.h) / PATCH_H);
    const y1 = Math.max(y0 + 1, box.y + Math.floor(((py + 1) * box.h) / PATCH_H));
    for (let px = 0; px < PATCH_W; px++) {
      const x0 = box.x + Math.floor((px * box.w) / PATCH_W);
      const x1 = Math.max(x0 + 1, box.x + Math.floor(((px + 1) * box.w) / PATCH_W));
      let sum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += picture.pixels[y * picture.w + x]!;
      out[py * PATCH_W + px] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
    }
  }
  return out;
}

/** How far the patch moved from `before` to `after`, in patch pixels. */
function patchMotion(before: Uint8Array, after: Uint8Array): { readonly dx: number; readonly dy: number } {
  const correlator = new PhaseCorrelator(PATCH_W, PATCH_H);
  correlator.push(before, PATCH_W, PATCH_H);
  const moved = correlator.push(after, PATCH_W, PATCH_H)!;
  return { dx: Math.round(moved.dx), dy: Math.round(moved.dy) };
}

/** The mean difference between patch `before` moved by (dx, dy) and `after`, over the pixels that overlap. */
function residual(before: Uint8Array, after: Uint8Array, dx: number, dy: number): number {
  let sum = 0;
  let n = 0;
  for (let y = Math.max(0, -dy); y < Math.min(PATCH_H, PATCH_H - dy); y++)
    for (let x = Math.max(0, -dx); x < Math.min(PATCH_W, PATCH_W - dx); x++) {
      sum += Math.abs(before[y * PATCH_W + x]! - after[(y + dy) * PATCH_W + x + dx]!);
      n++;
    }
  return n ? sum / n : Infinity;
}

/** A w × h matte moved by (dx, dy) pixels; what comes in from outside is empty. */
export function shiftedMatte(matte: Uint8Array, w: number, h: number, dx: number, dy: number): Uint8Array {
  if (!dx && !dy) return matte;
  const out = new Uint8Array(w * h);
  for (let y = Math.max(0, dy); y < Math.min(h, h + dy); y++) {
    const from = (y - dy) * w;
    const x0 = Math.max(0, dx);
    const x1 = Math.min(w, w + dx);
    out.set(matte.subarray(from + x0 - dx, from + x1 - dx), y * w + x0);
  }
  return out;
}

/** The matte a dropout frame with picture `now` shows: the good frame's, moved with its subject; undefined when the view changed too much. */
export function heldMatte(good: Good, now: Picture | undefined, w: number, h: number): Uint8Array | undefined {
  if (!now) return undefined;
  const box = keptBox(good.matte, w, h, good.picture);
  if (!box) return undefined;
  const before = patchOf(good.picture, box);
  const after = patchOf(now, box);
  const motion = patchMotion(before, after);
  const still = residual(before, after, 0, 0);
  const moved = residual(before, after, motion.dx, motion.dy);
  if (Math.min(still, moved) > STABILITY.viewLevels) return undefined;
  if (still <= moved) return good.matte;
  return shiftedMatte(good.matte, w, h, Math.round((motion.dx * box.w * w) / (PATCH_W * now.w)), Math.round((motion.dy * box.h * h) / (PATCH_H * now.h)));
}
