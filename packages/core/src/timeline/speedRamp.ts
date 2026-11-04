// Speed ramps and reverse (D327). A clip's `speedKeys` [{frame, speed, ease?}] (frames from the
// clip's start, any whole frame: a split or trimmed piece keeps the keys outside its own frames)
// give its speed over its local time: held before the first key and after the last, eased between
// two by the ease of the key it leaves (linear, in, out, inOut: box.ts EASES). The media frames a
// clip has played `local` frames after its start are the curve's integral from 0 to `local`
// (closed forms of the eases' integrals, no sampling); without keys it is local × speed, as before.
// A reversed clip (`reverse`) plays a virtual media that is its media backwards: its `in` counts
// from the media's end, so trims, splits and slips work unchanged, and every picture or sound read
// goes through a reversed copy of a range of the media (`reverseRange`), made on the server.
import { EASES, type Ease } from "../visual/box.ts";
import type { Item, Media, Project } from "./types.ts";

export type RampEase = Ease;
export interface SpeedKey {
  readonly frame: number;
  readonly speed: number;
  readonly ease?: RampEase;
}

export const RAMP_EASES: ReadonlyArray<RampEase> = ["linear", "in", "out", "inOut"];
export const RAMP_SPEED = { min: 0.1, max: 10 } as const;

/** ∫₀ᵖ ease(q) dq for each ease (EASES in box.ts). */
const EASE_INTEGRALS: Readonly<Record<RampEase, (p: number) => number>> = {
  linear: (p) => p ** 2 / 2,
  in: (p) => p ** 4 / 4,
  out: (p) => p - (1 - (1 - p) ** 4) / 4,
  inOut: (p) => (p < 0.5 ? p ** 4 : p - 0.5 + (2 - 2 * p) ** 4 / 16),
};

interface Segment {
  readonly frame: number;
  readonly speed: number;
  readonly ease: RampEase;
  /** The curve's integral from the first key to this one. */
  readonly acc: number;
}

const curves = new WeakMap<ReadonlyArray<SpeedKey>, ReadonlyArray<Segment> | undefined>();

const validSpeed = (s: unknown): s is number => typeof s === "number" && Number.isFinite(s) && s > 0;
const easeOf = (e: unknown): RampEase => (typeof e === "string" && (RAMP_EASES as ReadonlyArray<string>).includes(e) ? (e as RampEase) : "linear");

/** The usable keys of a curve, by frame (a later key at the same frame wins). */
export function speedKeysOf(keys: ReadonlyArray<SpeedKey> | undefined): Array<{ frame: number; speed: number; ease: RampEase }> {
  const out: Array<{ frame: number; speed: number; ease: RampEase }> = [];
  for (const k of [...(keys ?? [])].sort((a, b) => a.frame - b.frame)) {
    if (!Number.isFinite(k.frame) || !validSpeed(k.speed)) continue;
    const key = { frame: k.frame, speed: k.speed, ease: easeOf(k.ease) };
    if (out.length && out.at(-1)!.frame === k.frame) out[out.length - 1] = key;
    else out.push(key);
  }
  return out;
}

/** The area under one segment from its key to `p` (0–1) of the way to the next. */
const segmentArea = (a: Segment, b: Segment, p: number) => (b.frame - a.frame) * (a.speed * p + (b.speed - a.speed) * EASE_INTEGRALS[a.ease](p));

function curveOf(keys: ReadonlyArray<SpeedKey> | undefined): ReadonlyArray<Segment> | undefined {
  if (!keys?.length) return undefined;
  if (curves.has(keys)) return curves.get(keys);
  const list = speedKeysOf(keys);
  const segments: Array<Segment> = [];
  for (const k of list) {
    const prev = segments.at(-1);
    segments.push({ ...k, acc: prev ? prev.acc + segmentArea(prev, { ...k, acc: 0 }, 1) : 0 });
  }
  const curve = segments.length ? segments : undefined;
  curves.set(keys, curve);
  return curve;
}

/** The curve's integral from its first key to local frame t (negative before it). */
function areaTo(curve: ReadonlyArray<Segment>, t: number): number {
  const first = curve[0]!;
  if (t <= first.frame) return (t - first.frame) * first.speed;
  const last = curve.at(-1)!;
  if (t >= last.frame) return last.acc + (t - last.frame) * last.speed;
  let lo = 0;
  let hi = curve.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid]!.frame <= t) lo = mid;
    else hi = mid;
  }
  const a = curve[lo]!;
  const b = curve[hi]!;
  return a.acc + segmentArea(a, b, (t - a.frame) / (b.frame - a.frame));
}

/** The local frame where the curve's integral from its first key reaches `area`. */
function frameAtArea(curve: ReadonlyArray<Segment>, area: number): number {
  const first = curve[0]!;
  if (area <= 0) return first.frame + area / first.speed;
  const last = curve.at(-1)!;
  if (area >= last.acc) return last.frame + (area - last.acc) / last.speed;
  let i = 0;
  while (curve[i + 1]!.acc < area) i++;
  const a = curve[i]!;
  const b = curve[i + 1]!;
  let lo = 0;
  let hi = 1;
  for (let step = 0; step < 52; step++) {
    const mid = (lo + hi) / 2;
    if (a.acc + segmentArea(a, b, mid) < area) lo = mid;
    else hi = mid;
  }
  return a.frame + ((lo + hi) / 2) * (b.frame - a.frame);
}

type Timed = Pick<Item, "speed" | "speedKeys">;
/** A project for reverse ranges: its main track, when given, says how far transitions reach past a clip. */
type WithTracks = Pick<Project, "media" | "canvas"> & { readonly tracks?: Project["tracks"] };

/** Whether an item's speed follows a curve (D327). */
export const isRamped = (item: Pick<Item, "speedKeys">) => curveOf(item.speedKeys) !== undefined;

/** The item's speed at local frame `local` (its constant speed without keys). */
export function speedAt(item: Timed, local: number): number {
  const curve = curveOf(item.speedKeys);
  if (!curve) return item.speed ?? 1;
  const first = curve[0]!;
  if (local <= first.frame) return first.speed;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1]!;
    const b = curve[i]!;
    if (local < b.frame) return a.speed + (b.speed - a.speed) * EASES[a.ease]((local - a.frame) / (b.frame - a.frame));
  }
  return curve.at(-1)!.speed;
}

/** Media frames an item plays in its first `local` frames: local × speed, or the curve's integral. */
export function sourceFrames(item: Timed, local: number): number {
  const curve = curveOf(item.speedKeys);
  if (!curve) return local * (item.speed ?? 1);
  return areaTo(curve, local) - areaTo(curve, 0);
}

/** The local frame (fractional) at which an item has played `frames` media frames: the inverse of sourceFrames. */
export function localForSource(item: Timed, frames: number): number {
  const curve = curveOf(item.speedKeys);
  if (!curve) return frames / (item.speed ?? 1);
  return frameAtArea(curve, frames + areaTo(curve, 0));
}

/**
 * Whole media frames to move an item's in point by when its first `local` frames go (a trim, a
 * split's second half, a slip): rounded at a constant speed, as before; floored on a ramp, whose
 * span stays exact, so the piece never reads past where the whole one did.
 */
export const inShift = (item: Timed, local: number) => (isRamped(item) ? Math.floor(sourceFrames(item, local) + 1e-9) : Math.round(sourceFrames(item, local)));

/** Media frames the whole item plays. */
export const sourceSpan = (item: Timed & Pick<Item, "duration">) => sourceFrames(item, item.duration);

/** Keys moved by `frames` (a trimmed start or a split's second half starts that much later): the curve stays where it was. */
export const shiftSpeedKeys = (keys: ReadonlyArray<SpeedKey>, frames: number): Array<SpeedKey> => keys.map((k) => ({ ...k, frame: k.frame - frames }));

/** Keys outside [0, duration] beyond the one nearest on each side shape nothing in the item: they go. */
export function trimSpeedKeys(keys: ReadonlyArray<SpeedKey>, duration: number): Array<SpeedKey> {
  const list = [...keys].sort((a, b) => a.frame - b.frame);
  const before = list.filter((k) => k.frame < 0).at(-1);
  const after = list.find((k) => k.frame > duration);
  return list.filter((k) => (k.frame >= 0 && k.frame <= duration) || k === before || k === after);
}

// ---- presets ----

export interface RampPreset {
  readonly label: string;
  /** [share of the clip's length (0–1), speed, ease leaving it]. */
  readonly keys: ReadonlyArray<readonly [number, number, RampEase]>;
}

/** Ramps the editor offers, shaped like the velocity edits of short-video apps. */
export const RAMP_PRESETS: Readonly<Record<string, RampPreset>> = {
  montage: {
    label: "Montage",
    keys: [
      [0, 0.5, "inOut"],
      [0.25, 3, "inOut"],
      [0.5, 0.5, "inOut"],
      [0.75, 3, "inOut"],
      [1, 0.5, "linear"],
    ],
  },
  hero: {
    label: "Hero",
    keys: [
      [0, 1.5, "inOut"],
      [0.35, 0.3, "linear"],
      [0.65, 0.3, "inOut"],
      [1, 1.5, "linear"],
    ],
  },
  bullet: {
    label: "Bullet",
    keys: [
      [0, 3, "inOut"],
      [0.4, 0.15, "linear"],
      [0.6, 0.15, "inOut"],
      [1, 3, "linear"],
    ],
  },
  flashIn: {
    label: "Flash in",
    keys: [
      [0, 5, "out"],
      [0.4, 1, "linear"],
    ],
  },
  flashOut: {
    label: "Flash out",
    keys: [
      [0, 1, "linear"],
      [0.6, 1, "in"],
      [1, 5, "linear"],
    ],
  },
};

/** A preset's keys for a clip `duration` frames long. */
export const presetKeys = (preset: RampPreset, duration: number): Array<SpeedKey> =>
  preset.keys.map(([u, speed, ease]) => ({ frame: Math.round(u * duration), speed, ...(ease !== "linear" ? { ease } : {}) }));

/** The preset whose keys these are at this length, if any. */
export function presetOf(keys: ReadonlyArray<SpeedKey> | undefined, duration: number): string | undefined {
  if (!keys?.length) return undefined;
  const same = (a: ReadonlyArray<SpeedKey>, b: ReadonlyArray<SpeedKey>) =>
    a.length === b.length && a.every((k, i) => k.frame === b[i]!.frame && k.speed === b[i]!.speed && easeOf(k.ease) === easeOf(b[i]!.ease));
  return Object.keys(RAMP_PRESETS).find((name) => same(speedKeysOf(keys), speedKeysOf(presetKeys(RAMP_PRESETS[name]!, duration))));
}

// ---- reverse ----

/** A reversed copy covers whole steps of this many seconds of the media (with the clip's transition handles), so small trims reuse it. */
export const REVERSE_STEP_S = 2;

export interface ReverseRange {
  /** Media frames [from, to) (project frames) the reversed copy holds, played backwards. */
  readonly from: number;
  readonly to: number;
}

const mediaFrames = (project: Pick<Project, "media">, item: Pick<Item, "media">): Media | undefined =>
  item.media ? project.media.find((m) => m.id === item.media) : undefined;

/** The stretch of a reversed clip's media its reversed copy holds (undefined for a clip that isn't reversed or has no length). */
export function reverseRange(project: WithTracks, item: Item): ReverseRange | undefined {
  if (!item.reverse || item.type !== "clip") return undefined;
  const length = mediaFrames(project, item)?.probe?.frames;
  if (!length) return undefined;
  const step = Math.max(1, Math.round(REVERSE_STEP_S * project.canvas.fps));
  const { before, after } = transitionHandles(project, item);
  const hi = length - (item.in ?? 0) - sourceFrames(item, -before);
  const lo = length - (item.in ?? 0) - sourceFrames(item, item.duration + after);
  return { from: Math.max(0, Math.floor(lo / step) * step), to: Math.min(length, Math.ceil(hi / step) * step) };
}

/** A main clip's own frames that overlapping transitions play before its start and after its end (half of each). */
function transitionHandles(project: WithTracks, item: Item): { before: number; after: number } {
  const track = project.tracks?.find((t) => t.role === "main" && t.items.some((i) => i.id === item.id));
  if (!track) return { before: 0, after: 0 };
  const index = track.items.findIndex((i) => i.id === item.id);
  const next = track.items[index + 1];
  return { before: (item.transitionIn?.duration ?? 0) / 2, after: (next?.transitionIn?.duration ?? 0) / 2 };
}

/**
 * Seconds into a reversed clip's copy for `frames` (media frames of the virtual reversed media,
 * from its start): the copy starts at the range's end and runs back to its start.
 */
export function reversedSeconds(project: WithTracks, item: Item, frames: number): number | undefined {
  const range = reverseRange(project, item);
  const length = mediaFrames(project, item)?.probe?.frames;
  if (!range || !length) return undefined;
  return (frames + range.to - length) / project.canvas.fps;
}

/** Why a clip can't be reversed, or undefined when it can. */
export function reverseProblem(project: Pick<Project, "media" | "tracks">, item: Item): string | undefined {
  if (item.type !== "clip") return "Only clips play backwards.";
  const media = mediaFrames(project, item);
  if (!media || media.kind !== "video") return "Only video clips play backwards.";
  if (!media.probe?.frames) return "Uncut doesn't know this video's length yet, so it can't reverse it.";
  if (item.loop || item.hold) return "A looped or held clip can't play backwards: turn Loop and Hold off first.";
  if (hasFollowers(project, item)) return "Its detached sound or linked picture would still play forwards: delete or unlink it first.";
  return undefined;
}

/** Why a clip can't take a speed ramp, or undefined when it can. */
export function rampProblem(project: Pick<Project, "media" | "tracks">, item: Item): string | undefined {
  if (item.type !== "clip") return "Speed ramps are for video clips.";
  const media = mediaFrames(project, item);
  if (!media || media.kind !== "video") return "Speed ramps are for video clips.";
  if (item.loop || item.hold) return "A looped or held clip can't take a speed ramp: turn Loop and Hold off first.";
  if (hasFollowers(project, item)) return "Its detached sound or linked picture can't follow a speed ramp: delete or unlink it first.";
  return undefined;
}

const hasFollowers = (project: Pick<Project, "tracks">, item: Item) => project.tracks.some((t) => t.items.some((i) => i.linkedTo === item.id));

/** The local frame (fractional) at which an item's media is at `seconds` (sourceAt's seconds, a reversed clip's in its copy): sourceAt's inverse, loop and hold aside. */
export function localAtSeconds(project: WithTracks, item: Item, seconds: number): number {
  const fps = project.canvas.fps;
  const range = item.reverse ? reverseRange(project, item) : undefined;
  const length = mediaFrames(project, item)?.probe?.frames ?? 0;
  const frames = seconds * fps - (range ? range.to - length : 0);
  return localForSource(item, frames - (item.in ?? 0));
}
