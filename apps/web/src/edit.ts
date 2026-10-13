// Manual timeline editing (phase 4 chunk 3, D52): pure planners that turn a gesture into edit ops.
// The timeline previews a drag by applying the planned ops locally with @uncut/core's engine (no
// server round trip per mouse move) and sends one project.edit when the mouse is released, so
// every action is validated by the server, undoes in one step and reaches the agent's note (D6).
import { applyEdit, createSession, EditError } from "@uncut/core/apply-ops";
import { soundMedia } from "@uncut/core/audio";
import { timelineProblems } from "@uncut/core/rules";
import { cutsOf, defaultFrames, overlaps, transitionInfo, transitionLimits, transitionName, type Cut } from "@uncut/core/transitions";
import type { Op, TimedModule } from "@uncut/core/types";

import { layoutOf, uniqueId, type Item, type ProjectModel, type Track } from "./project.ts";

/** How close (in pixels) an edge must come to a snap target to stick to it. */
export const SNAP_PX = 6;

export interface Placed {
  readonly item: Item;
  readonly track: Track;
  /** Index in the track's items (array order; only main's order means time). */
  readonly index: number;
  readonly start: number;
}

export function findItem(project: ProjectModel, id: string | undefined): Placed | undefined {
  if (id === undefined) return undefined;
  const { starts } = layoutOf(project);
  for (const track of project.tracks) {
    const index = track.items.findIndex((i) => i.id === id);
    if (index !== -1) return { item: track.items[index]!, track, index, start: starts.get(id) ?? 0 };
  }
  return undefined;
}

// Which track kinds take which item types (the validator's rule, spec/schema).
const TRACK_KINDS: Readonly<Record<Item["type"], Track["kind"]>> = { clip: "video", component: "video", graphic: "video", text: "text", captions: "text", audio: "audio" };
export const fitsTrack = (item: Item, track: Track) => TRACK_KINDS[item.type] === track.kind;

const lockedProblem = (track: Track) => `The ${track.name} track is locked. Unlock it to edit it.`;

/** Why an item can't be edited by hand, if it can't. */
export function lockOf(placed: Placed): string | undefined {
  if (placed.track.locked) return lockedProblem(placed.track);
  if (placed.item.locked) return "That item is locked.";
  return undefined;
}

// ---- beats (D70) ----

/** Beat times (seconds of each media file) of the media whose beats are cached, by media id. */
export type BeatMap = ReadonlyMap<string, ReadonlyArray<number>>;
/** The beats a snap may use, and the zoom (beats closer than MIN_BEAT_PX on screen aren't targets). */
export interface BeatSnap {
  readonly beats: BeatMap;
  /** Pixels per frame. */
  readonly ppf: number;
}
/** Beats drawn and snapped to only when at least this far apart on screen: closer, every drop would stick to one. */
export const MIN_BEAT_PX = 2 * SNAP_PX;

/**
 * Where an item's beats fall, in frames from the item's start (fractional, in [0, duration)): a
 * beat at t seconds of the media is at (t·fps − in) / speed, repeated every media length when
 * the item loops. Only clips and audio items with sound have beats.
 */
export function beatsInItem(project: ProjectModel, item: Item, beats: ReadonlyArray<number>): Array<number> {
  if (!beats.length || !soundMedia(project, item)) return [];
  const fps = project.canvas.fps;
  const speed = item.speed ?? 1;
  const from = item.in ?? 0;
  const media = project.media.find((m) => m.id === item.media);
  const length = item.loop ? media?.probe?.frames : undefined;
  const out: Array<number> = [];
  const add = (mediaFrame: number) => {
    const local = (mediaFrame - from) / speed;
    if (local >= 0 && local < item.duration) out.push(local);
  };
  if (!length) for (const t of beats) add(t * fps);
  else {
    // Looped: the media plays from `in` and wraps at its end.
    const end = from + item.duration * speed;
    for (let base = 0; base < end; base += length) for (const t of beats) if (t * fps < length) add(t * fps + base);
    out.sort((a, b) => a - b);
  }
  return out;
}

/** The median gap between neighbouring values (frames), 0 with fewer than two. */
const medianGap = (frames: ReadonlyArray<number>) => {
  if (frames.length < 2) return 0;
  const gaps = frames.slice(1).map((f, i) => f - frames[i]!).sort((a, b) => a - b);
  return gaps[gaps.length >> 1]!;
};

/** An item's beats as drawn: local frames, or none when they'd be closer than `minPx` apart at this zoom. */
export function visibleBeats(project: ProjectModel, item: Item, beats: ReadonlyArray<number> | undefined, ppf: number, minPx = MIN_BEAT_PX): Array<number> {
  const local = beats ? beatsInItem(project, item, beats) : [];
  return local.length > 1 && medianGap(local) * ppf < minPx ? [] : local;
}

/** Timeline frames (whole) of the beats of every item `include` accepts, at a zoom where they're far enough apart. */
export function beatTargets(project: ProjectModel, snap: BeatSnap | undefined, include: (item: Item, track: Track, index: number) => boolean = () => true): Array<number> {
  if (!snap || !snap.beats.size) return [];
  const { starts } = layoutOf(project);
  const out: Array<number> = [];
  for (const track of project.tracks) {
    track.items.forEach((item, index) => {
      const beats = item.media ? snap.beats.get(item.media) : undefined;
      if (!beats || !include(item, track, index)) return;
      const start = starts.get(item.id) ?? 0;
      for (const f of visibleBeats(project, item, beats, snap.ppf)) out.push(Math.round(start + f));
    });
  }
  return out;
}

/**
 * The trimmed item's own beats that stay put while an edge moves, over all of its media the edge
 * can reach (dragging the end out past the last beat it plays now still finds the next one): the
 * end edge, and the start edge of a free-track item (start and in move together). A main clip
 * trimmed from the start keeps its start and shifts its content, so its beats move: none.
 */
function ownTrimBeats(project: ProjectModel, placed: Placed, edge: "start" | "end", snap: BeatSnap | undefined): Array<number> {
  const { item, start, track } = placed;
  const beats = item.media ? snap?.beats.get(item.media) : undefined;
  if (!snap || !beats || (edge === "start" && track.role === "main")) return [];
  const speed = item.speed ?? 1;
  const from = item.in ?? 0;
  const length = project.media.find((m) => m.id === item.media)?.probe?.frames;
  // The whole reach as one virtual item (a looped one: as far again as it's long).
  const reach = item.loop || !length ? item.duration * 2 : Math.max(item.duration, Math.floor((length - from) / speed));
  const virtual: Item = edge === "end" ? { ...item, duration: reach } : { ...item, in: 0, duration: item.duration + from / speed };
  const base = edge === "end" ? start : start - from / speed;
  return visibleBeats(project, virtual, beats, snap.ppf).map((f) => Math.round(base + f));
}

/** Where the playhead goes when dragged to `frame` with snapping on: the nearest beat within `threshold` frames, else `frame`. */
export function snapPlayhead(project: ProjectModel, frame: number, snap: BeatSnap | undefined, threshold: number): { frame: number; snapAt?: number } {
  let best: number | undefined;
  for (const t of beatTargets(project, snap)) if (Math.abs(t - frame) <= threshold && (best === undefined || Math.abs(t - frame) < Math.abs(best - frame))) best = t;
  return best === undefined ? { frame } : { frame: best, snapAt: best };
}

/** Snap targets in frames: 0, the playhead, every other item's start and end, and the beats of other items (D70). */
export function snapTargets(project: ProjectModel, playhead: number, exclude: string, beats?: BeatSnap): Array<number> {
  const { starts } = layoutOf(project);
  const targets = new Set([0, Math.floor(playhead)]);
  for (const track of project.tracks) {
    for (const item of track.items) {
      if (item.id === exclude) continue;
      const s = starts.get(item.id) ?? 0;
      targets.add(s);
      targets.add(s + item.duration);
    }
  }
  // The moved item's own beats move with it.
  for (const b of beatTargets(project, beats, (item) => item.id !== exclude)) targets.add(b);
  return [...targets];
}

/**
 * Snap targets for trimming an edge: as snapTargets, minus the edge's own position (on main the
 * neighbour's edge sits there, which would pull every small trim back to nothing) and minus the
 * main clips after this one, which ripple with the edge. Beats (D70) of items that stay put count,
 * the trimmed item's own included (trimming music to end on its beat): only a main clip trimmed
 * from the start shifts its own beats (its start stays, its content moves), so those don't.
 */
export function trimSnapTargets(project: ProjectModel, playhead: number, itemId: string, edge: "start" | "end", beats?: BeatSnap): Array<number> {
  const placed = findItem(project, itemId);
  if (!placed) return [];
  const own = edge === "start" ? placed.start : placed.start + placed.item.duration;
  const { starts } = layoutOf(project);
  const targets = new Set([0, Math.floor(playhead)]);
  const ripples = (track: Track, index: number) => track.role === "main" && placed.track.role === "main" && index > placed.index;
  for (const track of project.tracks) {
    track.items.forEach((item, index) => {
      if (item.id === itemId) return;
      if (ripples(track, index)) return;
      const s = starts.get(item.id) ?? 0;
      targets.add(s);
      targets.add(s + item.duration);
    });
  }
  for (const b of beatTargets(project, beats, (item, track, index) => !ripples(track, index) && item.id !== itemId)) targets.add(b);
  for (const b of ownTrimBeats(project, placed, edge, beats)) targets.add(b);
  targets.delete(own);
  return [...targets];
}

export interface Snap {
  readonly targets: ReadonlyArray<number>;
  /** In frames. */
  readonly threshold: number;
}

/** The nearest target within the threshold of any of `edges` (frames); the shift to apply and where. */
function nearestSnap(edges: ReadonlyArray<number>, snap: Snap | undefined): { shift: number; at: number } | undefined {
  if (!snap) return undefined;
  let best: { shift: number; at: number } | undefined;
  for (const edge of edges) {
    for (const t of snap.targets) {
      const shift = t - edge;
      if (Math.abs(shift) <= snap.threshold && (!best || Math.abs(shift) < Math.abs(best.shift))) best = { shift, at: t };
    }
  }
  return best;
}

/** Free-track items other than `exclude`, in time order (array order on a free track isn't time). */
const others = (track: Track, exclude: string) =>
  track.items.filter((i) => i.id !== exclude).map((i) => ({ start: i.start ?? 0, end: (i.start ?? 0) + i.duration })).sort((a, b) => a.start - b.start);

/**
 * Where an item `duration` long can go on a free track nearest to `start` without overlapping
 * anything (D52: a move onto another item snaps to the closest free spot). There is always room
 * after the last item.
 */
export function nearestFreeSpot(track: Track, exclude: string, start: number, duration: number): number {
  const busy = others(track, exclude);
  const fits = (s: number) => s >= 0 && busy.every((b) => s + duration <= b.start || s >= b.end);
  if (fits(start)) return start;
  const candidates = [0, ...busy.flatMap((b) => [b.start - duration, b.end])].filter(fits);
  return candidates.reduce((best, c) => (Math.abs(c - start) < Math.abs(best - start) ? c : best), Math.max(0, ...busy.map((b) => b.end)));
}

/** set_transition null for each of these main items that has a transition in. */
const dropTransitions = (items: ReadonlyArray<Item | undefined>): Array<Op> =>
  [...new Set(items)].filter((i): i is Item => !!i?.transitionIn).map((i) => ({ op: "set_transition", item: i.id, transition: null }));

export interface Plan {
  readonly ops: ReadonlyArray<Op>;
  readonly summary: string;
}

export interface MovePlan extends Plan {
  /** Where the item lands: its track, and its start (free) or index (main). */
  readonly track: string;
  readonly start?: number;
  readonly index?: number;
  /** The frame it snapped to, for the snap line. */
  readonly snapAt?: number;
}

/**
 * Move an item to `desiredStart` on track `trackId` (its own track, or a compatible one).
 * Free tracks: the start snaps (either edge), then moves to the nearest free spot if something
 * is in the way. Main: the item is reordered to the slot its middle is over; main items have no
 * start. No ops when it would land where it is.
 */
export function planMove(project: ProjectModel, itemId: string, trackId: string, desiredStart: number, snap?: Snap): MovePlan | { readonly problem: string } {
  const placed = findItem(project, itemId);
  if (!placed) return { problem: "That item isn't in the project any more." };
  const locked = lockOf(placed);
  if (locked) return { problem: locked };
  const target = project.tracks.find((t) => t.id === trackId);
  if (!target) return { problem: "That track isn't in the project any more." };
  if (!fitsTrack(placed.item, target)) return { problem: `A ${placed.item.type} item can't go on the ${target.name} track.` };
  if (target.locked) return { problem: lockedProblem(target) };
  const { item, track } = placed;
  const onTrack = target.id === track.id ? {} : { track: target.id };
  if (target.role === "main") {
    // Slots among the other main items, back to back; the index is after the item is taken out
    // (move_item removes it first).
    const rest = target.items.filter((i) => i.id !== item.id);
    const middle = desiredStart + item.duration / 2;
    let t = 0;
    let index = 0;
    for (const other of rest) {
      if (t + other.duration / 2 < middle) index++;
      t += other.duration;
    }
    if (target.id === track.id && index === placed.index) return { ops: [], summary: "", track: target.id, index };
    // The cuts the clip leaves and joins change, so the transitions at them go (D52): its own,
    // the one into the clip after it, and the one into the clip it lands before.
    const cut = [item, track.role === "main" ? track.items[placed.index + 1] : undefined, rest[index]];
    return { ops: [...dropTransitions(cut), { op: "move_item", item: item.id, ...onTrack, index }], summary: `Move ${item.id}`, track: target.id, index };
  }
  let start = Math.max(0, Math.round(desiredStart));
  const snapped = nearestSnap([start, start + item.duration], snap);
  if (snapped) start = Math.max(0, start + snapped.shift);
  const landing = nearestFreeSpot(target, item.id, start, item.duration);
  const snapAt = snapped && landing === start ? snapped.at : undefined;
  if (target.id === track.id && landing === placed.start) return { ops: [], summary: "", track: target.id, start: landing, ...(snapAt !== undefined ? { snapAt } : {}) };
  // Off main: the clip after it loses the transition from it (its own goes with the move).
  const leaving = track.role === "main" ? dropTransitions([track.items[placed.index + 1]]) : [];
  return {
    ops: [...leaving, { op: "move_item", item: item.id, ...onTrack, start: landing }],
    summary: `Move ${item.id}`,
    track: target.id,
    start: landing,
    ...(snapAt !== undefined ? { snapAt } : {}),
  };
}

export interface TrimPlan extends Plan {
  /** The item's start and length after the trim, as the timeline shows them. */
  readonly start: number;
  readonly duration: number;
  readonly snapAt?: number;
}

/**
 * Drag an edge by `delta` frames (positive: to the right). Clamped to at least one frame, to
 * the media's length for video and audio (left edge: `in` can't go below 0; right edge: not past
 * the last frame), to frame 0 and the neighbours on a free track. On main the start stays and
 * the clips after it ripple. The moving edge snaps first, then is clamped.
 */
export function planTrim(project: ProjectModel, itemId: string, edge: "start" | "end", delta: number, snap?: Snap): TrimPlan | { readonly problem: string } {
  const placed = findItem(project, itemId);
  if (!placed) return { problem: "That item isn't in the project any more." };
  const locked = lockOf(placed);
  if (locked) return { problem: locked };
  const { item, track, start } = placed;
  const end = start + item.duration;
  const main = track.role === "main";
  const media = item.media ? project.media.find((m) => m.id === item.media) : undefined;
  const busy = main ? [] : others(track, item.id);
  let moved = Math.round(delta);
  const snapped = nearestSnap([edge === "start" ? start + moved : end + moved], snap);
  if (snapped) moved += snapped.shift;
  // How short the item may get: one frame, its animations and fades, a transition at either cut
  // needs both clips twice its length, and (end edge) its last key.
  const next = main ? track.items[placed.index + 1] : undefined;
  const own = main ? (item.transitionIn?.duration ?? 0) : 0;
  const into = next?.transitionIn?.duration ?? 0;
  // The media an overlapping transition needs past the cut (a dip to black needs none).
  const ownHandle = main && item.transitionIn && overlaps(item.transitionIn.module) ? Math.ceil(own / 2) : 0;
  const intoHandle = next?.transitionIn && overlaps(next.transitionIn.module) ? Math.ceil(into / 2) : 0;
  const anims = Object.values(item.animation ?? {}).map((a) => a?.duration ?? 0);
  const keys = edge === "end" ? [...(item.keys ?? []), ...(item.gainKeys ?? [])].map((k) => k.frame) : [];
  const minDuration = Math.max(1, 2 * own, 2 * into, (item.fadeIn ?? 0) + (item.fadeOut ?? 0), ...anims, ...keys);
  const speed = item.speed ?? 1;
  // Video and audio play from a time in their media; still images and text can grow freely.
  const timed = media ? media.kind !== "image" : item.in !== undefined;
  const frames = timed ? media?.probe?.frames : undefined;
  let lo: number;
  let hi: number;
  if (edge === "start") {
    // moved > 0 shortens from the left. A transition into this clip needs media before its in-point.
    hi = item.duration - minDuration;
    lo = -Infinity;
    if (timed) lo = Math.max(lo, Math.ceil(-((item.in ?? 0) - (media?.kind === "video" ? ownHandle : 0)) / speed));
    if (!main) lo = Math.max(lo, -start, ...busy.filter((b) => b.end <= start).map((b) => b.end - start));
  } else {
    // A transition out of this clip needs media after its out-point.
    lo = minDuration - item.duration;
    hi = Infinity;
    if (frames && !item.loop) hi = Math.floor((frames - (item.in ?? 0) - (media?.kind === "video" ? intoHandle : 0)) / speed - item.duration);
    if (!main) hi = Math.min(hi, ...busy.filter((b) => b.start >= end).map((b) => b.start - end));
  }
  // Already outside the limits (e.g. a project edited elsewhere): don't make it worse.
  lo = Math.min(lo, 0);
  hi = Math.max(hi, 0);
  const clamped = Math.min(hi, Math.max(lo, moved));
  const snapAt = snapped && clamped === moved ? snapped.at : undefined;
  const trim = edge === "start" ? clamped : -clamped;
  const after = { start: edge === "start" && !main ? start + clamped : start, duration: item.duration - trim, ...(snapAt !== undefined ? { snapAt } : {}) };
  if (clamped === 0) return { ops: [], summary: "", ...after };
  return { ops: [{ op: "trim_item", item: item.id, edge, frames: trim }], summary: `Trim ${item.id}`, ...after };
}

export interface SplitPlan extends Plan {
  readonly newId: string;
}

/**
 * Split at the playhead (D52): the selected item if the playhead is inside it (not on its first
 * frame), otherwise the main-track clip under the playhead. With an item selected that the
 * playhead isn't over, nothing is split (and the user is told), so a split never lands on
 * something the user didn't mean.
 */
export function planSplit(project: ProjectModel, selected: string | undefined, frame: number): SplitPlan | { readonly problem: string } {
  const f = Math.floor(frame);
  const inside = (p: Placed) => p.start < f && f < p.start + p.item.duration;
  // Selected captions (D82) aren't split: they follow the main track, so S splits the clip there.
  const picked = findItem(project, selected);
  const sel = picked?.item.type === "captions" ? undefined : picked;
  let target: Placed | undefined;
  if (sel) {
    if (!inside(sel)) return { problem: "Move the playhead over the selected item to split it." };
    target = sel;
  } else {
    const main = project.tracks.find((t) => t.role === "main");
    const item = main?.items.find((i) => inside(findItem(project, i.id)!));
    target = item && findItem(project, item.id);
    if (!target) return { problem: "Put the playhead over a clip on the main track (or select an item) to split it." };
  }
  const locked = lockOf(target);
  if (locked) return { problem: locked };
  // A transition at either cut needs the half next to it to be at least twice its length.
  if (target.track.role === "main") {
    const at = f - target.start;
    const own = target.item.transitionIn?.duration ?? 0;
    const into = target.track.items[target.index + 1]?.transitionIn?.duration ?? 0;
    if (at < 2 * own || target.item.duration - at < 2 * into) return { problem: "That's too close to a transition to split there. Move the playhead further from it." };
  }
  const newId = uniqueId(project, target.item.id.replace(/-\d+$/, "") || "item");
  return { ops: [{ op: "split_item", item: target.item.id, at: f - target.start, newId }], summary: `Split ${target.item.id}`, newId };
}

/** Delete an item; on main the clips after it close the gap (the track is magnetic). */
export function planDelete(project: ProjectModel, selected: string | undefined): Plan | { readonly problem: string } {
  const placed = findItem(project, selected);
  if (!placed) return { problem: "Select an item to delete it." };
  const locked = lockOf(placed);
  if (locked) return { problem: locked };
  // On main the clip after it now follows another clip, so its transition goes too.
  const next = placed.track.role === "main" ? placed.track.items[placed.index + 1] : undefined;
  return { ops: [...dropTransitions([next]), { op: "delete_item", item: placed.item.id }], summary: `Delete ${placed.item.id}` };
}

// ---- transitions (D73) ----

/** The main track's cuts (see core cutsOf). */
export const mainCuts = (project: ProjectModel): Array<Cut> => cutsOf(project.tracks.find((t) => t.role === "main"));

/** The cut nearest to a frame, if the main track has one. */
export function nearestCut(project: ProjectModel, frame: number): Cut | undefined {
  let best: Cut | undefined;
  for (const cut of mainCuts(project)) if (!best || Math.abs(cut.frame - frame) < Math.abs(best.frame - frame)) best = cut;
  return best;
}

/** "0.5 s", "1.25 s": a transition's length for labels. */
export const secondsLabel = (frames: number, fps: number) => `${Math.round((frames / fps) * 100) / 100} s`;

/**
 * Set, change or remove (null) the transition into the main item `itemId`, as one edit with the
 * label history.db and the agent's note show ("Added crossfade", "Changed transition to 0.8 s",
 * "Changed transition to wipe", "Removed crossfade"). A new one gets the module's default length;
 * a changed type keeps the length; every length is clamped to the module's limits and the cut's
 * (core transitionLimits: half the shorter clip, the media handles). No ops when nothing changes.
 */
export function planSetTransition(project: ProjectModel, itemId: string, next: { readonly module: string; readonly duration?: number } | null): Plan | { readonly problem: string } {
  const placed = findItem(project, itemId);
  if (!placed || placed.track.role !== "main") return { problem: "Transitions go between two clips on the main track." };
  if (placed.index === 0) return { problem: "The first clip on the main track has nothing to transition from." };
  const locked = lockOf(placed) ?? (placed.track.items[placed.index - 1]?.locked ? "The clip before this cut is locked." : undefined);
  if (locked) return { problem: locked };
  const before = placed.item.transitionIn;
  if (next === null) {
    if (!before) return { ops: [], summary: "" };
    return { ops: [{ op: "set_transition", item: itemId, transition: null }], summary: `Removed ${transitionName(before.module).toLowerCase()}` };
  }
  const limits = transitionLimits(project, itemId, next.module);
  if ("problem" in limits) return limits;
  const info = transitionInfo(next.module);
  const wanted = next.duration ?? before?.duration ?? (info ? defaultFrames(info, project.canvas.fps) : limits.min);
  const duration = Math.min(limits.max, Math.max(limits.min, Math.round(wanted)));
  const transition: TimedModule = { module: next.module, duration };
  if (before && before.module === transition.module && before.duration === duration) return { ops: [], summary: "" };
  const name = transitionName(next.module).toLowerCase();
  const summary = !before ? `Added ${name}` : before.module !== next.module ? `Changed transition to ${name}` : `Changed transition to ${secondsLabel(duration, project.canvas.fps)}`;
  return { ops: [{ op: "set_transition", item: itemId, transition }], summary };
}

export type TrackFlag = "hidden" | "locked" | "mute";

export const trackFlag = (track: Track, flag: TrackFlag) => (flag === "mute" ? track.mixer?.mute === true : track[flag] === true);

/** Hide, lock or mute a track (mute is stored in its mixer; it becomes audible in chunk 5). */
export function planTrackFlag(project: ProjectModel, trackId: string, flag: TrackFlag): Plan | { readonly problem: string } {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return { problem: "That track isn't in the project any more." };
  const on = !trackFlag(track, flag);
  const verb = { hidden: on ? "Hide" : "Show", locked: on ? "Lock" : "Unlock", mute: on ? "Mute" : "Unmute" }[flag];
  // Off removes the flag (null), so project.json stays clean; mute keeps the rest of the mixer.
  const set = flag === "mute" ? { mixer: { ...track.mixer, mute: on } } : { [flag]: on ? true : null };
  return { ops: [{ op: "update_track", track: track.id, set }], summary: `${verb} track ${track.name}` };
}

/**
 * The project after `ops`, checked with the same timeline rules as the server (core rules.ts), for
 * previewing a drag and checking an action before it is sent: a plan the server would refuse is
 * never shown as droppable. The problem is a sentence for the user.
 */
export function draftOf(project: ProjectModel, ops: ReadonlyArray<Op>): { readonly project: ProjectModel } | { readonly problem: string } {
  if (!ops.length) return { project };
  try {
    return { project: applyEdit(createSession(project), { actor: "user", ops }, timelineProblems).project };
  } catch (error) {
    const first = error instanceof EditError ? (error.details[0] as { message?: string } | undefined) : undefined;
    return { problem: `Can't do that: ${first?.message ?? (error as Error).message}.` };
  }
}
