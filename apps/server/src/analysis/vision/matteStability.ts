// D332: a matte that holds still where the picture does. Whatever module made it, a matte can drop a
// person for a frame or two or flicker where nothing moved. Two steps:
// - holds: a frame whose matte collapses, or bursts far past the last good one, and comes back
//   within a short stretch with no shot cut in between, shows the last good frame's matte instead
//   (matteHold.ts moves it with its subject);
// - a temporal median: each pixel takes the median of its own value and its two neighbours' where
//   the picture there is the same in all three (no cut between), so a moving edge keeps its own
//   frame's value: no lag and no trails.
// The survey (areas, cuts, holds) keeps a few numbers a frame; the median three frames.

export const STABILITY = {
  /** The survey reads the matte and the picture this many pixels wide. */
  surveyWidth: 64,
  /** The median compares pictures this many pixels wide. */
  gateWidth: 480,
  /** A frame whose matte covers less than this share of the last good one's has dropped out. */
  collapse: 0.3,
  /** One that covers more than this many times the last good one's (plus `burstMargin`) has burst. */
  burst: 2.5,
  burstMargin: 0.01,
  /** A held matte shows only while the picture in its box stays within this many grey levels (mean, the box averaged to 128 × 64) of the good frame's, moved with it. */
  viewLevels: 28,
  /** A matte covering less than this is empty: nothing to hold. */
  minArea: 0.005,
  /** A matte under this has dropped out when the last few good ones were over 1/collapse times bigger. */
  nearEmpty: 0.01,
  /** The longest dropout held, and the longest burst. */
  holdSeconds: 0.5,
  burstSeconds: 0.1,
  /** A cut: the picture changes by at least this many grey levels, `cutRatio` times its neighbours' change. */
  cutLevels: 20,
  cutRatio: 3,
  /** A pixel moved when its picture changed by more than this many grey levels on average within `gateReach` gate pixels. */
  gateLevels: 6,
  gateReach: 3,
} as const;

/** How much of the picture a grey matte keeps, 0 to 1. */
export function coverage(frame: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]!;
  return frame.length ? sum / (255 * frame.length) : 0;
}

/** The mean difference of two grey frames, in grey levels. */
export function meanDifference(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return a.length ? sum / a.length : 0;
}

/**
 * cutBefore[t] is 1 when a shot cut falls between frames t − 1 and t; change[t] is the picture's
 * change there. A change after it counts only when the next one is as big, so a one-frame flash
 * (two big changes in a row) is still a cut and a pan (big changes all along) isn't.
 */
export function findCuts(change: ArrayLike<number>): Uint8Array {
  const cuts = new Uint8Array(change.length);
  for (let t = 1; t < change.length; t++) {
    const around = Math.max(change[t - 1] ?? 0, Math.min(change[t + 1] ?? 0, change[t + 2] ?? 0), 2);
    if (change[t]! >= STABILITY.cutLevels && change[t]! >= STABILITY.cutRatio * around) cuts[t] = 1;
  }
  return cuts;
}

const collapsed = (area: number, good: number) => area < STABILITY.collapse * good;
const nearEmpty = (area: number) => area < STABILITY.nearEmpty;
const burst = (area: number, good: number) => area > STABILITY.burst * good + STABILITY.burstMargin;

export interface HoldLimits {
  /** The longest dropout held, in frames. */
  readonly hold: number;
  /** The longest burst held, in frames. */
  readonly burst: number;
}

export const holdLimits = (fps: number): HoldLimits => ({
  hold: Math.max(1, Math.round(STABILITY.holdSeconds * fps)),
  burst: Math.max(1, Math.round(STABILITY.burstSeconds * fps)),
});

/** A matte that empties is measured against the largest of the last few good frames, so one that fades out over two frames still counts. */
const RECENT = 3;

interface Reference {
  /** The last good frame, the one a dropout holds. */
  readonly good: number;
  /** The largest of the last RECENT good frames' areas. */
  readonly most: number;
  readonly last: number;
}

type Dropout = "collapse" | "burst";

const dropoutOf = (area: number, ref: Reference): Dropout | undefined =>
  collapsed(area, ref.last) || (nearEmpty(area) && collapsed(area, ref.most)) ? "collapse" : burst(area, ref.last) ? "burst" : undefined;

/**
 * For each frame, the frame whose matte it shows: itself, or the last good frame across a dropout
 * (collapsed or burst) that ends within the limits with no cut in between. A matte that stays
 * collapsed (the subject left) or stays big (someone came in) is taken as it is.
 */
export function planHolds(areas: ArrayLike<number>, cutBefore: ArrayLike<number>, limits: HoldLimits): Int32Array {
  const use = Int32Array.from({ length: areas.length }, (_, t) => t);
  let recent: Array<number> = [];
  let t = 0;
  while (t < areas.length) {
    if (cutBefore[t]) recent = [];
    const ref: Reference | undefined = recent.length
      ? { good: recent.at(-1)!, most: Math.max(...recent.map((k) => areas[k]!)), last: areas[recent.at(-1)!]! }
      : undefined;
    const end = ref ? dropoutEnd(areas, cutBefore, ref, t, limits) : -1;
    if (end > 0) use.fill(ref!.good, t, end);
    const accepted = end > 0 ? end : t;
    recent = [...recent, accepted].slice(-RECENT);
    t = accepted + 1;
  }
  return use;
}

/** Where a dropout starting at t ends: the first frame like the good ones again, or −1 when t isn't one. */
function dropoutEnd(areas: ArrayLike<number>, cutBefore: ArrayLike<number>, ref: Reference, t: number, limits: HoldLimits): number {
  const kind = ref.most < STABILITY.minArea || cutBefore[t] ? undefined : dropoutOf(areas[t]!, ref);
  if (!kind) return -1;
  const longest = kind === "collapse" ? limits.hold : limits.burst;
  for (let q = t + 1; q <= t + longest && q < areas.length; q++) {
    const now = dropoutOf(areas[q]!, ref);
    if (cutBefore[q] || (now && now !== kind)) return -1;
    if (!now) return q;
  }
  return -1;
}

/** One frame for the median: its matte (a held one already swapped in) and its picture at the gate size. */
export interface MedianFrame {
  readonly matte: Uint8Array;
  readonly picture: Uint8Array | undefined;
  /** A dropout frame (held or not): it neither votes for its neighbours nor is smoothed. */
  readonly dropout: boolean;
  readonly cutBefore: boolean;
}

export interface MedianSize {
  readonly width: number;
  readonly height: number;
  readonly gateWidth: number;
  readonly gateHeight: number;
}

const votes = (frame: MedianFrame | undefined): frame is MedianFrame & { readonly picture: Uint8Array } => !!frame?.picture && !frame.dropout;

/** Streams frames in and their smoothed mattes out one frame behind, keeping three. */
export class TemporalMedian {
  private readonly size: MedianSize;
  /** A matte column's gate column, and a matte row's first gate pixel. */
  private readonly gateX: Int32Array;
  private readonly gateRow: Int32Array;
  private window: Array<MedianFrame> = [];

  constructor(size: MedianSize) {
    this.size = size;
    this.gateX = Int32Array.from({ length: size.width }, (_, x) => Math.min(size.gateWidth - 1, Math.floor((x * size.gateWidth) / size.width)));
    this.gateRow = Int32Array.from(
      { length: size.height },
      (_, y) => Math.min(size.gateHeight - 1, Math.floor((y * size.gateHeight) / size.height)) * size.gateWidth,
    );
  }

  /** Takes the next frame; answers the matte now ready (none for the first frame). */
  push(frame: MedianFrame): Array<Uint8Array> {
    this.window = [...this.window, frame].slice(-3);
    return this.window.length < 2 ? [] : [this.smooth(this.window.at(-3), this.window.at(-2)!, frame)];
  }

  /** The last matte, once the last frame is in. */
  flush(): Array<Uint8Array> {
    const last = this.window.at(-1);
    return last ? [last.matte] : [];
  }

  private smooth(before: MedianFrame | undefined, centre: MedianFrame, after: MedianFrame | undefined): Uint8Array {
    if (!votes(centre) || !votes(before) || !votes(after) || centre.cutBefore || after.cutBefore) return centre.matte;
    const { gateWidth, gateHeight } = this.size;
    const stillBefore = stillMap(centre.picture, before.picture, gateWidth, gateHeight);
    const stillAfter = stillMap(centre.picture, after.picture, gateWidth, gateHeight);
    const out = new Uint8Array(centre.matte.length);
    const { width, height } = this.size;
    for (let y = 0; y < height; y++) {
      const row = this.gateRow[y]!;
      for (let x = 0, i = y * width; x < width; x++, i++) {
        const own = centre.matte[i]!;
        const g = row + this.gateX[x]!;
        out[i] = stillBefore[g] && stillAfter[g] ? median3(own, before.matte[i]!, after.matte[i]!) : own;
      }
    }
    return out;
  }
}

const median3 = (a: number, b: number, c: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

/** 1 where two pictures' mean difference over the gateReach neighbourhood is at most gateLevels, so a pixel near motion counts as moving. */
export function stillMap(a: Uint8Array, b: Uint8Array, w: number, h: number): Uint8Array {
  const diff = new Int32Array(w * h);
  for (let i = 0; i < diff.length; i++) diff[i] = Math.abs(a[i]! - b[i]!);
  const sums = boxSum(boxSum(diff, w, h, 1, w), h, w, w, 1);
  const side = 2 * STABILITY.gateReach + 1;
  const most = STABILITY.gateLevels * side * side;
  const still = new Uint8Array(w * h);
  for (let i = 0; i < still.length; i++) still[i] = sums[i]! <= most ? 1 : 0;
  return still;
}

/** Each value summed with its gateReach neighbours either way along lines of `length` values `step` apart (lines `stride` apart); edges repeat. */
function boxSum(src: Int32Array, length: number, lines: number, step: number, stride: number): Int32Array {
  const out = new Int32Array(src.length);
  const reach = STABILITY.gateReach;
  const at = (base: number, i: number) => src[base + Math.min(length - 1, Math.max(0, i)) * step]!;
  for (let line = 0; line < lines; line++) {
    const base = line * stride;
    let sum = 0;
    for (let i = -reach; i <= reach; i++) sum += at(base, i);
    for (let i = 0; i < length; i++) {
      out[base + i * step] = sum;
      sum += at(base, i + reach + 1) - at(base, i - reach);
    }
  }
  return out;
}
