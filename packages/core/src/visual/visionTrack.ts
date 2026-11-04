import { momentLabel } from "../text/mentions.ts";
import { layout, pictureMedia } from "../timeline/timeline.ts";
import type { Item, Op, Project, Track } from "../timeline/types.ts";
import { clipBox, keyAt, keysOf, type Rect } from "./box.ts";
import { componentBox, isDrawnComponent } from "./components/registry.ts";
import { textPlacement } from "./render.ts";
import { FRAME_EPSILON_S, frameIndex, visionSeconds } from "./vision.ts";
import { smooth } from "./visionPlans.ts";

type Tracked = Pick<Project, "tracks" | "media" | "canvas">;
type Key = NonNullable<Item["keys"]>[number];

/** One frame of a track result: the object's box (0 to 1 of the picture), or `lost` on the last. */
export interface TrackFrame {
  readonly t: number;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly w?: number | undefined;
  readonly h?: number | undefined;
  readonly lost?: boolean | undefined;
}

export interface TrackAsk {
  readonly item: string;
  readonly target: string;
  readonly frame: number;
  readonly box: Rect;
}

export interface TrackRequest {
  /** The media's seconds [start, end) to follow, from the frame showing at `start`. */
  readonly start: number;
  readonly end: number;
  /** The object on the media's picture, 0 to 1 from the top left. */
  readonly box: Rect;
}

export interface TrackOptions {
  readonly item: string;
  readonly target: string;
  /** The media second tracking started at (TrackRequest.start). */
  readonly start: number;
  readonly scale?: boolean | undefined;
}

export type TrackPlan =
  | { readonly ops: ReadonlyArray<Op>; readonly summary: string; readonly note?: string; readonly lostFrame?: number }
  | { readonly problem: string };

export const TRACK_SMOOTH_S = 0.08;
export const TRACK_SCALE_SMOOTH_S = 0.4;
export const TRACK_TOLERANCE = 0.0015;
export const TRACK_SCALE_TOLERANCE = 0.01;
const MIN_BOX_PX = 4;

function locate(project: Pick<Project, "tracks">, id: string): { readonly index: number; readonly track: Track; readonly item: Item } | undefined {
  for (const [index, track] of project.tracks.entries()) {
    const item = track.items.find((i) => i.id === id);
    if (item) return { index, track, item };
  }
  return undefined;
}

const isVideoClip = (project: Pick<Project, "media">, item: Item) => item.type === "clip" && project.media.find((m) => m.id === item.media)?.kind === "video";

const isOverlay = (project: Tracked, item: Item) => (item.type === "text" && typeof item.text === "string") || isDrawnComponent(item) || (item.type === "clip" && !!pictureMedia(project, item));

const spanOf = (starts: ReadonlyMap<string, number>, item: Item) => {
  const from = starts.get(item.id) ?? item.start ?? 0;
  return { from, to: from + item.duration };
};

const overlap = (a: { from: number; to: number }, b: { from: number; to: number }) => a.from < b.to && b.from < a.to;

export function trackTargets(project: Tracked, itemId: string): Array<Item> {
  const found = locate(project, itemId);
  if (!found) return [];
  const { starts } = layout(project as Project);
  const span = spanOf(starts, found.item);
  return project.tracks
    .slice(found.index + 1)
    .filter((t) => t.kind === "video" && !t.hidden)
    .flatMap((t) => t.items)
    .filter((i) => isVideoClip(project, i) && overlap(span, spanOf(starts, i)));
}

export function trackProblem(project: Tracked, itemId: string, targetId?: string): string | undefined {
  const found = locate(project, itemId);
  if (!found || !isOverlay(project, found.item)) return "Tracking moves a text, a sticker or an image: pick one of those.";
  if (found.track.locked || found.item.locked) return "That item is locked: unlock it to track.";
  if (targetId === undefined) return undefined;
  const target = locate(project, targetId);
  if (!target || !isVideoClip(project, target.item)) return "Tracking follows something in a video clip: pick one under this item.";
  if (target.index <= found.index) return "That clip isn't under this item: pick a video clip on a track below it.";
  if (target.item.reverse) return "Tracking doesn't work on a clip that plays backwards: turn Play backwards off first.";
  if (target.item.loop) return "Tracking doesn't work on a looped clip: turn Loop off first.";
  if (!project.media.find((m) => m.id === target.item.media)?.probe?.frames) return "Uncut doesn't know this video's length yet, so it can't track in it.";
  return undefined;
}


function pictureAt(project: Tracked, target: Item, local: number): Rect {
  const media = project.media.find((m) => m.id === target.media)!;
  return clipBox(target, project.canvas, media.probe, local).content;
}

export function trackRequest(project: Tracked, ask: TrackAsk): TrackRequest | { readonly problem: string } {
  const problem = trackProblem(project, ask.item, ask.target);
  if (problem) return { problem };
  const { starts } = layout(project as Project);
  const overlay = locate(project, ask.item)!.item;
  const target = locate(project, ask.target)!.item;
  const under = spanOf(starts, target);
  const over = spanOf(starts, overlay);
  if (!Number.isInteger(ask.frame) || ask.frame < Math.max(under.from, over.from) || ask.frame >= Math.min(under.to, over.to))
    return { problem: "Move the playhead to a frame where both the item and the clip show, then draw the box there." };
  const local = ask.frame - under.from;
  const picture = pictureAt(project, target, local);
  const left = Math.max(ask.box.x, picture.x);
  const top = Math.max(ask.box.y, picture.y);
  const right = Math.min(ask.box.x + ask.box.w, picture.x + picture.w);
  const bottom = Math.min(ask.box.y + ask.box.h, picture.y + picture.h);
  if (!(right - left >= MIN_BOX_PX && bottom - top >= MIN_BOX_PX)) return { problem: "Draw the box around the object, on the clip's picture." };
  const box = { x: (left - picture.x) / picture.w, y: (top - picture.y) / picture.h, w: (right - left) / picture.w, h: (bottom - top) / picture.h };
  const fps = project.canvas.fps;
  const start = visionSeconds(project, target, local);
  const last = Math.min(under.to, over.to) - 1 - under.from;
  const length = project.media.find((m) => m.id === target.media)!.probe!.frames! / fps;
  const end = Math.min(length, visionSeconds(project, target, last) + 1 / fps);
  return { start, end: Math.max(end, start + 1 / fps), box };
}

function localShowing(project: Tracked, target: Item, seconds: number): number | undefined {
  for (let local = 0; local < target.duration; local++) if (visionSeconds(project, target, local) >= seconds - FRAME_EPSILON_S) return local;
  return undefined;
}

function overlayAt(project: Tracked, item: Item, local: number): { readonly x: number; readonly y: number; readonly scale: number } {
  const fps = project.canvas.fps;
  if (item.type === "text") {
    const rest = textPlacement(item, project as Parameters<typeof textPlacement>[1]);
    return { x: keyAt(item.keys, "x", local, fps) ?? rest.x, y: keyAt(item.keys, "y", local, fps) ?? rest.y, scale: keyAt(item.keys, "scale", local, fps) ?? 1 };
  }
  const media = pictureMedia(project, item);
  return media ? clipBox(item, project.canvas, media.probe, local) : componentBox(item, project.canvas, local)!;
}

interface Sample {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

function objectPath(project: Tracked, target: Item, frames: ReadonlyArray<TrackFrame>, from: number, count: number): { readonly path: Array<Sample>; readonly lostLocal?: number } {
  const lost = frames.at(-1)?.lost ? frames.at(-1)!.t : undefined;
  const boxes = lost === undefined ? frames : frames.slice(0, -1);
  const times = boxes.map((f) => f.t);
  const path: Array<Sample> = [];
  const end = Math.min(target.duration, from + count);
  for (let local = from; local < end; local++) {
    const seconds = visionSeconds(project, target, local);
    if (lost !== undefined && seconds >= lost - FRAME_EPSILON_S) return { path, lostLocal: local };
    const box = boxes[frameIndex(times, seconds)]!;
    const picture = pictureAt(project, target, local);
    const w = box.w! * picture.w;
    const h = box.h! * picture.h;
    path.push({ x: picture.x + (box.x! + box.w! / 2) * picture.w, y: picture.y + (box.y! + box.h! / 2) * picture.h, size: Math.sqrt(w * h) });
  }
  return { path };
}

/**
 * The no-lag low-pass with each end point-reflected first: a plain run bends the ends towards the
 * middle by about the object's speed times the time constant, which would shift the pin. The
 * first value stays exact.
 */
function settled(values: ReadonlyArray<number>, fps: number, seconds: number): Array<number> {
  const pad = Math.min(values.length - 1, Math.ceil(4 * seconds * fps));
  const first = values[0]!;
  const last = values.at(-1)!;
  const before = Array.from({ length: pad }, (_, i) => 2 * first - values[pad - i]!);
  const after = Array.from({ length: pad }, (_, i) => 2 * last - values[values.length - 2 - i]!);
  const out = smooth([...before, ...values, ...after], fps, seconds).slice(pad, pad + values.length);
  const shift = first - out[0]!;
  return out.map((v) => v + shift);
}

/** Ramer-Douglas-Peucker over several channels: straight lines between the indices stay within each channel's tolerance. */
export function thinPath(channels: ReadonlyArray<{ readonly values: ReadonlyArray<number>; readonly tolerance: number }>): Array<number> {
  const length = channels[0]?.values.length ?? 0;
  if (length === 0) return [];
  const kept = new Set([0, length - 1]);
  const missBy = (values: ReadonlyArray<number>, a: number, b: number, i: number) => Math.abs(values[i]! - (values[a]! + ((values[b]! - values[a]!) * (i - a)) / (b - a)));
  const worstBetween = (a: number, b: number) => {
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      for (const c of channels) {
        const miss = missBy(c.values, a, b, i) / c.tolerance;
        if (miss > worst) {
          worst = miss;
          at = i;
        }
      }
    }
    return worst > 1 ? at : -1;
  };
  const spans: Array<readonly [number, number]> = [[0, length - 1]];
  while (spans.length) {
    const [a, b] = spans.pop()!;
    const split = worstBetween(a, b);
    if (split < 0) continue;
    kept.add(split);
    spans.push([a, split], [split, b]);
  }
  return [...kept].sort((a, b) => a - b);
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

function keysKept(keys: Item["keys"], from: number, replaced: ReadonlyArray<string>): Array<Key> {
  return (keys ?? []).flatMap((k) => {
    if (k.frame < from) return [k];
    const own = Object.fromEntries(Object.entries(k).filter(([f]) => !replaced.includes(f))) as Key;
    return Object.keys(own).some((f) => f !== "frame" && f !== "ease") ? [own] : [];
  });
}

const nameOf = (project: Pick<Project, "media">, item: Item) => item.name ?? (typeof item.text === "string" && item.text.trim() ? item.text.trim().slice(0, 24) : undefined) ?? project.media.find((m) => m.id === item.media)?.name ?? item.id;

export function planTrack(project: Tracked, options: TrackOptions, frames: ReadonlyArray<TrackFrame>): TrackPlan {
  const problem = trackProblem(project, options.item, options.target);
  if (problem) return { problem };
  const { item } = locate(project, options.item)!;
  const { item: target } = locate(project, options.target)!;
  const { starts } = layout(project as Project);
  const over = spanOf(starts, item);
  const under = spanOf(starts, target);
  const anchor = localShowing(project, target, options.start);
  if (anchor === undefined) return { problem: "The clip doesn't show that moment any more, so the track wasn't applied." };
  const first = Math.max(under.from + anchor, over.from);
  if (first >= Math.min(over.to, under.to)) return { problem: "The item and the clip no longer overlap there, so the track wasn't applied." };
  const fps = project.canvas.fps;
  const { path, lostLocal } = objectPath(project, target, frames, first - under.from, over.to - first);
  const lostAt = momentLabel((lostLocal ?? 0) + under.from, fps);
  if (path.length < 2 && lostLocal !== undefined) return { problem: `The tracker lost the object straight away, at ${lostAt}. Draw a tighter box on something with clear edges.` };
  if (!path.length) return { problem: "The tracker found nothing at that moment, so the track wasn't applied." };
  const local = first - over.from;
  const base = overlayAt(project, item, local);
  const x = settled(path.map((p) => base.x + p.x - path[0]!.x), fps, TRACK_SMOOTH_S);
  const y = settled(path.map((p) => base.y + p.y - path[0]!.y), fps, TRACK_SMOOTH_S);
  const scale = options.scale ? settled(path.map((p) => (base.scale * p.size) / path[0]!.size), fps, TRACK_SCALE_SMOOTH_S) : undefined;
  const tolerance = TRACK_TOLERANCE * Math.max(project.canvas.width, project.canvas.height);
  const channels = [
    { values: x, tolerance },
    { values: y, tolerance },
    ...(scale ? [{ values: scale, tolerance: TRACK_SCALE_TOLERANCE }] : []),
  ];
  const moved = channels.some((c) => c.values.some((v) => Math.abs(v - c.values[0]!) > c.tolerance));
  const picks = moved ? thinPath(channels) : [0];
  const pins: Array<Key> = picks.map((i) => ({ frame: local + i, x: round2(x[i]!), y: round2(y[i]!), ...(scale ? { scale: round3(scale[i]!) } : {}) }));
  const kept = keysKept(item.keys, local, scale ? ["x", "y", "scale"] : ["x", "y"]);
  const keys = [...kept, ...pins].sort((a, b) => a.frame - b.frame);
  const summary = `Track ${nameOf(project, item)} to ${nameOf(project, target)}`;
  const transform = item.type === "text" ? { transform: textRest(project, item, base) } : {};
  const ops: ReadonlyArray<Op> = [{ op: "update_item", item: item.id, set: { keys, ...transform } }];
  if (lostLocal === undefined) return { ops, summary };
  const lostFrame = under.from + lostLocal;
  return { ops, summary, lostFrame, note: `The object was lost at ${momentLabel(lostFrame, fps)}, so the item stays at its last position from there.` };
}

/** The position is written out because textPlacement drops a look's width once a text has an x of its own, and a moving text mustn't reflow. */
function textRest(project: Tracked, item: Item, at: { readonly x: number; readonly y: number }) {
  const { w } = textPlacement(item, project as Parameters<typeof textPlacement>[1]);
  return { ...item.transform, x: round2(at.x), y: round2(at.y), ...(w !== undefined ? { w } : {}) };
}

export const hasPositionKeys = (item: Pick<Item, "keys">) => keysOf(item.keys, "x").length > 0 || keysOf(item.keys, "y").length > 0;

export function planUntrack(project: Tracked, itemId: string, options: { readonly scale?: boolean } = {}): TrackPlan {
  const found = locate(project, itemId);
  if (!found) return { problem: "That item isn't in the project any more." };
  if (found.track.locked || found.item.locked) return { problem: "That item is locked: unlock it first." };
  const keys = keysKept(found.item.keys, -Infinity, options.scale ? ["x", "y", "scale"] : ["x", "y"]);
  return { ops: [{ op: "update_item", item: itemId, set: { keys: keys.length ? keys : null } }], summary: `Remove the track on ${nameOf(project, found.item)}` };
}

