// Arranging media on the timeline (feedback round 1: D122 tracks, D123 detach audio, D124 audio
// tracks, D125 speed). Pure planners shared by the renderer (drops, "Add to timeline", the context
// menu), the server (a Finder drop imports and places in one edit) and the agent's convenience ops.
// Browser-safe.
//
// D122, what "main" means: the main track is the magnetic spine (back to back, ripple, transitions,
// transcript cuts, captions follow its clips). Every other video track is an overlay with free
// starts, drawn over the tracks below it (track order is the stacking order); clips there never
// ripple, carry no transitions, aren't cut by the transcript and aren't followed by captions.
import { applyEdit, createSession, EditError } from "./apply-ops.ts";
import { timelineProblems } from "./rules.ts";
import { layout } from "./timeline.ts";
import { soundMedia } from "../audio/audio.ts";
import type { Frame, Id, Item, Media, Op, Project, Track } from "./types.ts";

/** A still image placed on the timeline lasts this long. */
export const IMAGE_SECONDS = 5;

const uniqueIn = (base: string, taken: Set<string>) => {
  for (let n = 1; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
};

/** Every id in use (media, tracks, items, scenes). */
export const takenIds = (project: Pick<Project, "media" | "tracks"> & Partial<Pick<Project, "scenes">>) =>
  new Set([...project.media.map((m) => m.id), ...project.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)]), ...(project.scenes ?? []).map((s) => s.id)]);

/** Free-track items other than `exclude`, as [start, end) in time order. */
export function busySpans(track: Track, exclude?: string): Array<{ start: number; end: number }> {
  return track.items
    .filter((i) => i.id !== exclude)
    .map((i) => ({ start: i.start ?? 0, end: (i.start ?? 0) + i.duration }))
    .sort((a, b) => a.start - b.start);
}

/** Whether [start, start + duration) is free on a free track (ignoring `exclude`). */
export const isFree = (track: Track, start: number, duration: number, exclude?: string) => busySpans(track, exclude).every((b) => start + duration <= b.start || start >= b.end);

/**
 * Where an item `duration` long can go on a free track nearest to `start` without overlapping
 * anything (D52). There is always room after the last item.
 */
export function nearestFreeSpot(track: Track, exclude: string | undefined, start: number, duration: number): number {
  const busy = busySpans(track, exclude);
  const fits = (s: number) => s >= 0 && busy.every((b) => s + duration <= b.start || s >= b.end);
  if (fits(start)) return start;
  const candidates = [0, ...busy.flatMap((b) => [b.start - duration, b.end])].filter(fits);
  return candidates.reduce((best, c) => (Math.abs(c - start) < Math.abs(best - start) ? c : best), Math.max(0, ...busy.map((b) => b.end)));
}

/** The main-track slot (index) a clip whose middle is at `middle` lands in (D52's reorder rule), among `items`. */
export function mainSlot(items: ReadonlyArray<Pick<Item, "duration">>, middle: number): number {
  let t = 0;
  let index = 0;
  for (const other of items) {
    if (t + other.duration / 2 < middle) index++;
    t += other.duration;
  }
  return index;
}

/** Which item type media of this kind becomes on a track of this kind, if any (video on an audio track: its sound). */
export function itemTypeFor(media: Pick<Media, "kind" | "probe">, track: Pick<Track, "kind">): "clip" | "audio" | undefined {
  if (track.kind === "video") return media.kind === "audio" ? undefined : "clip";
  if (track.kind === "audio") return media.kind === "audio" || (media.kind === "video" && media.probe?.hasAudio) ? "audio" : undefined;
  return undefined;
}

/** A media file to place: an entry of the project, or one being added in the same edit. */
export type PlaceMedia = Pick<Media, "id" | "kind" | "name" | "probe">;

export interface PlacedItem {
  readonly itemId: Id;
  readonly trackId: Id;
  readonly start: Frame;
}

export interface PlaceMediaPlan {
  readonly ops: ReadonlyArray<Op>;
  readonly placed: ReadonlyArray<PlacedItem>;
}

/** The length a media file gets on the timeline, in project frames (undefined: unknown, can't be placed). */
export const placedLength = (media: PlaceMedia, fps: number, imageSeconds = IMAGE_SECONDS) => (media.kind === "image" ? Math.max(1, Math.round(imageSeconds * fps)) : media.probe?.frames && media.probe.frames > 0 ? Math.floor(media.probe.frames) : undefined);

/**
 * The first unlocked, heard audio track (not main) free over [start, start + duration), or undefined
 * (D124: several sounds at once each get their own track; music, sfx and voice overlap freely).
 */
export function freeAudioTrack(project: Pick<Project, "tracks">, start: number, duration: number): Track | undefined {
  // Not a muted track, nor one a solo elsewhere silences: the new sound would be unheard.
  const solo = project.tracks.some((t) => t.mixer?.solo === true);
  return project.tracks.find((t) => t.kind === "audio" && t.role !== "main" && !t.locked && !t.mixer?.mute && (!solo || t.mixer?.solo === true) && isFree(t, start, duration));
}

/** The next "Audio" track name: Audio, Audio 2, … */
const nextName = (project: Pick<Project, "tracks">, base: string) => {
  const used = new Set(project.tracks.map((t) => t.name));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
};

/**
 * The ops that put `media` on the timeline at `frame` (D122, D124), one file after another:
 * - on `track` when given and it takes the media (main: in the slot nearest the frame, the next
 *   files after it; a free track: at the frame, each on the nearest free spot after the previous);
 *   a video file on an audio track places its sound;
 * - otherwise sound goes on the first audio track free for its whole length at the frame (a new
 *   "Audio N" track at the bottom when none is), and pictures go on the main track when it's empty,
 *   else at the frame on the nearest video track above main that is free for the whole length (a new
 *   "Video N" track just above main when none is).
 * Nothing that is already there moves (except main's ripple when inserting into it). `taken` holds
 * every id in use and gets the new ones. Media of unknown length are refused.
 */
export function planPlaceMedia(project: Pick<Project, "tracks" | "canvas">, media: ReadonlyArray<PlaceMedia>, at: { readonly frame: Frame; readonly track?: Id | undefined; /** A photo's length (F30: the app's default; IMAGE_SECONDS when absent). */ readonly imageSeconds?: number | undefined }, taken: Set<string>): PlaceMediaPlan | { readonly problem: string } {
  const fps = project.canvas.fps;
  // The project as the ops so far leave it (tracks only, starts resolved for free tracks).
  let tracks: Array<Track> = project.tracks.map((t) => ({ ...t, items: [...t.items] }));
  const ops: Array<Op> = [];
  const placed: Array<PlacedItem> = [];
  let cursor = Math.max(0, Math.floor(at.frame));
  let mainIndex: number | undefined;
  const target = at.track !== undefined ? tracks.find((t) => t.id === at.track) : undefined;
  if (target?.locked) return { problem: `The ${target.name} track is locked. Unlock it to add to it.` };
  for (const m of media) {
    const length = placedLength(m, fps, at.imageSeconds);
    if (!length) return { problem: `${m.name} has no known length, so it can't go on the timeline.` };
    let track = target && itemTypeFor(m, target) ? target : undefined;
    const type = track ? itemTypeFor(m, track)! : m.kind === "audio" ? "audio" : "clip";
    if (!track) {
      const main = tracks.find((t) => t.role === "main");
      if (type === "audio") track = freeAudioTrack({ tracks }, cursor, length);
      else if (main && !main.locked && main.items.length === 0) track = main;
      else {
        const mi = tracks.findIndex((t) => t.role === "main");
        track = tracks.slice(0, Math.max(0, mi)).reverse().find((t) => t.kind === "video" && !t.locked && isFree(t, cursor, length));
      }
      if (!track) {
        const audio = type === "audio";
        const id = uniqueIn(audio ? "audio-track" : "video-track", taken);
        const name = nextName({ tracks }, audio ? "Audio" : "Video");
        const mi = tracks.findIndex((t) => t.role === "main");
        const index = audio ? tracks.length : Math.max(0, mi);
        ops.push({ op: "add_track", track: { id, kind: audio ? "audio" : "video", name }, index });
        track = { id, kind: audio ? "audio" : "video", name, items: [] };
        tracks.splice(index, 0, track);
      }
    }
    const itemId = uniqueIn(type === "audio" ? "audio" : "clip", taken);
    const body = { id: itemId, type, media: m.id, ...(m.kind === "image" ? {} : { in: 0 }), duration: length } as Item;
    let start: number;
    if (track.role === "main") {
      // The cut nearest the drop: after every clip whose middle is at or before it.
      if (mainIndex === undefined) mainIndex = mainSlot(track.items, cursor + 0.5);
      const index = mainIndex++;
      start = track.items.slice(0, index).reduce((n, i) => n + i.duration, 0);
      // The clip it lands before now follows a new clip: the transition into it goes.
      const before = track.items[index];
      if (before?.transitionIn) ops.push({ op: "set_transition", item: before.id, transition: null });
      ops.push({ op: "insert_item", track: track.id, index, item: body });
      const updated: Track = { ...track, items: [...track.items.slice(0, index), body, ...track.items.slice(index)] };
      tracks = tracks.map((t) => (t.id === track!.id ? updated : t));
      cursor = start + length;
    } else {
      start = nearestFreeSpot(track, undefined, cursor, length);
      const item = { ...body, start } as Item;
      ops.push({ op: "insert_item", track: track.id, item });
      const updated: Track = { ...track, items: [...track.items, item] };
      tracks = tracks.map((t) => (t.id === track!.id ? updated : t));
      cursor = start + length;
    }
    placed.push({ itemId, trackId: track.id, start });
  }
  return { ops, placed };
}

/** The project after `ops`, checked with the timeline rules, or the first problem as a sentence. */
export function tryOps(project: Project, ops: ReadonlyArray<Op>): { readonly project: Project } | { readonly problem: string } {
  try {
    return { project: applyEdit(createSession(project), { actor: "user", ops }, timelineProblems).project };
  } catch (error) {
    const first = error instanceof EditError ? (error.details[0] as { message?: string } | undefined) : undefined;
    return { problem: `Can't do that: ${first?.message ?? (error as Error).message}.` };
  }
}

const locate = (project: Pick<Project, "tracks">, id: Id) => {
  for (const track of project.tracks) {
    const index = track.items.findIndex((i) => i.id === id);
    if (index !== -1) return { track, index, item: track.items[index]! };
  }
  return undefined;
};
const lockProblem = (track: Track, item: Item) => (track.locked ? `The ${track.name} track is locked. Unlock it to edit it.` : item.locked ? "That item is locked." : undefined);

export interface DetachAudioPlan {
  readonly ops: ReadonlyArray<Op>;
  readonly itemId: Id;
  readonly trackId: Id;
  readonly summary: string;
}

/**
 * Detach audio (D123): a clip's sound becomes its own audio item, the clip muted, in one edit.
 * The audio item plays the same media from the same point at the same speed and pitch, starts
 * where the clip starts and takes over the clip's volume, fades and volume keys (the clip's are
 * removed: it's silent now); a held clip's sound stops at its media's end. It goes on the first
 * audio track free for that stretch, else on a new "Audio N" track. Captions and transcript cuts
 * keep following the clip on main (its picture), not the detached sound.
 */
export function planDetachAudio(project: Pick<Project, "tracks" | "media" | "canvas">, itemId: Id, taken: Set<string>, options: { readonly id?: Id; readonly track?: Id } = {}): DetachAudioPlan | { readonly problem: string } {
  const found = locate(project, itemId);
  if (!found) return { problem: "That item isn't in the project any more." };
  const { track, item } = found;
  if (item.type !== "clip") return { problem: "Only a clip's sound can be detached." };
  if (item.mute) return { problem: "This clip's sound is already off (detached or muted)." };
  const media = soundMedia(project, item);
  if (!media) return { problem: "This clip has no sound to detach." };
  const locked = lockProblem(track, item);
  if (locked) return { problem: locked };
  const { starts } = layout(project);
  const start = starts.get(item.id) ?? 0;
  const speed = item.speed ?? 1;
  const from = item.in ?? 0;
  const frames = media.probe?.frames;
  // A held clip (D94) is silent past its media's end, so its sound stops there.
  let duration = item.duration;
  if (frames && !item.loop && from + duration * speed > frames) duration = Math.max(1, Math.floor((frames - from) / speed));
  const ops: Array<Op> = [];
  let target = options.track !== undefined ? project.tracks.find((t) => t.id === options.track) : freeAudioTrack(project, start, duration);
  if (options.track !== undefined) {
    if (!target || target.kind !== "audio" || target.role === "main") return { problem: `There's no audio track "${options.track}".` };
    if (target.locked) return { problem: `The ${target.name} track is locked.` };
    if (!isFree(target, start, duration)) return { problem: `The ${target.name} track isn't free there.` };
  }
  if (!target) {
    const id = uniqueIn("audio-track", taken);
    const name = nextName(project, "Audio");
    ops.push({ op: "add_track", track: { id, kind: "audio", name } });
    target = { id, kind: "audio", name, items: [] };
  }
  const id = options.id ?? uniqueIn("audio", taken);
  if (options.id) taken.add(options.id);
  const clamp = (n: number | undefined) => (n === undefined ? undefined : Math.min(n, duration));
  const fadeIn = clamp(item.fadeIn);
  const fadeOut = clamp(item.fadeOut);
  const fades = (fadeIn ?? 0) + (fadeOut ?? 0) > duration ? {} : { ...(fadeIn ? { fadeIn } : {}), ...(fadeOut ? { fadeOut } : {}) };
  const gainKeys = item.gainKeys?.filter((k) => k.frame <= duration);
  const audio: Item = {
    id,
    type: "audio",
    media: media.id,
    in: from,
    start,
    duration,
    ...(speed !== 1 ? { speed } : {}),
    ...(item.keepPitch === false ? { keepPitch: false } : {}),
    ...(item.loop ? { loop: true } : {}),
    ...(item.gainDb !== undefined ? { gainDb: item.gainDb } : {}),
    ...fades,
    ...(gainKeys?.length ? { gainKeys } : {}),
    linkedTo: item.id,
  };
  ops.push({ op: "insert_item", track: target.id, item: audio });
  ops.push({ op: "update_item", item: item.id, set: { mute: true, gainDb: null, fadeIn: null, fadeOut: null, gainKeys: null } });
  return { ops, itemId: id, trackId: target.id, summary: `Detach audio from ${item.name ?? media.name}` };
}

/** Speed presets the editor offers (D125). */
export const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
export const SPEED_RANGE = { min: 0.1, max: 10 } as const;

/** "2×", "0.5×", "1.25×" */
export const speedLabel = (speed: number) => `${Math.round(speed * 100) / 100}×`;

/**
 * Change a clip's or an audio item's speed (D125): it keeps playing the same stretch of its media,
 * so its length on the timeline becomes duration × old speed / new speed (a main clip's neighbours
 * ripple; on a free track it must still fit before the next item). Volume and box keys and
 * animations scale with it, fades are kept within the new length. `keepPitch` false lets the
 * pitch follow the speed (absent: unchanged). Checked with the timeline rules.
 */
export function planSetSpeed(project: Project, itemId: Id, speed: number, keepPitch?: boolean): { readonly ops: ReadonlyArray<Op>; readonly summary: string; readonly duration: number } | { readonly problem: string } {
  const found = locate(project, itemId);
  if (!found) return { problem: "That item isn't in the project any more." };
  const { track, item } = found;
  if (item.type !== "clip" && item.type !== "audio") return { problem: "Only clips and audio items have a speed." };
  const media = project.media.find((m) => m.id === item.media);
  if (!media || media.kind === "image") return { problem: "A still picture has no speed." };
  const locked = lockProblem(track, item);
  if (locked) return { problem: locked };
  if (!Number.isFinite(speed) || speed < SPEED_RANGE.min || speed > SPEED_RANGE.max) return { problem: `Pick a speed from ${SPEED_RANGE.min}× to ${SPEED_RANGE.max}×.` };
  const old = item.speed ?? 1;
  const next = Math.round(speed * 1000) / 1000;
  const ratio = old / next;
  let duration = Math.max(1, Math.round(item.duration * ratio));
  const frames = media.probe?.frames;
  const from = item.in ?? 0;
  if (frames && !item.loop && !(item.type === "clip" && item.hold) && from + duration * next > frames) duration = Math.max(1, Math.floor((frames - from) / next));
  const scale = (f: number) => Math.min(duration, Math.round(f * ratio));
  const set: Record<string, unknown> = { speed: next === 1 ? null : next, duration };
  if (keepPitch !== undefined) set.keepPitch = keepPitch ? null : false;
  if (item.keys?.length) set.keys = item.keys.map((k) => ({ ...k, frame: scale(k.frame) }));
  if (item.gainKeys?.length) set.gainKeys = item.gainKeys.map((k) => ({ ...k, frame: scale(k.frame) }));
  if (item.animation) set.animation = Object.fromEntries(Object.entries(item.animation).map(([k, a]) => [k, a ? { ...a, duration: Math.max(1, Math.min(duration, Math.round(a.duration * ratio))) } : a]));
  const fadeIn = item.fadeIn ? Math.min(item.fadeIn, duration) : undefined;
  const fadeOut = item.fadeOut ? Math.min(item.fadeOut, duration - (fadeIn ?? 0)) : undefined;
  if (item.fadeIn !== undefined) set.fadeIn = fadeIn ?? null;
  if (item.fadeOut !== undefined) set.fadeOut = fadeOut && fadeOut > 0 ? fadeOut : null;
  if (next === old && keepPitch === undefined) return { ops: [], summary: "", duration: item.duration };
  const ops: Array<Op> = [{ op: "update_item", item: item.id, set }];
  // A main transition that no longer fits goes (the cut stays).
  const draft = tryOps(project, ops);
  if ("problem" in draft && track.role === "main") {
    const drop: Array<Op> = [];
    const index = found.index;
    if (item.transitionIn) drop.push({ op: "set_transition", item: item.id, transition: null });
    const after = track.items[index + 1];
    if (after?.transitionIn) drop.push({ op: "set_transition", item: after.id, transition: null });
    const retry = tryOps(project, [...drop, ...ops]);
    if ("problem" in retry) return retry;
    return { ops: [...drop, ...ops], summary: `Speed ${speedLabel(next)}`, duration };
  }
  if ("problem" in draft) return /overlaps/.test(draft.problem) ? { problem: "There's no room on this track for it at that speed: move the next item first." } : draft;
  return { ops, summary: next === old ? (keepPitch === false ? "Pitch follows speed" : "Keep pitch") : `Speed ${speedLabel(next)}`, duration };
}

/** Ops that move, cut or retime an item itself (a linked sound touched like this goes its own way). */
const RETIME_KEYS = new Set(["start", "in", "duration", "speed", "media", "loop"]);
const retimes = (op: Op): string | undefined => {
  if (op.op === "move_item" || op.op === "trim_item" || op.op === "split_item") return op.item;
  if (op.op === "update_item" && Object.keys(op.set).some((k) => RETIME_KEYS.has(k))) return op.item;
  return undefined;
};

/**
 * Linked sound (D123): an audio item with `linkedTo` (Detach audio sets it) follows its clip until
 * the user moves, trims, splits or retimes the sound itself. This returns `ops` plus the ops that
 * keep every linked sound in step with what `ops` did to its clip: the same start, in point, length
 * and speed (a ripple, a trim, a speed change, a move), a piece per piece when the clip was split or
 * cut by its transcript (the words cut from the picture are cut from the sound too), gone when the
 * clip is gone. A sound the ops touch directly is unlinked instead. If keeping them in step would
 * break the timeline (something else in the way on the sound's track), they're unlinked rather than
 * the edit refused. Pure; run where edits are applied (the server) and drafted (the renderer).
 */
export function withLinkedAudio(project: Project, ops: ReadonlyArray<Op>): ReadonlyArray<Op> {
  const linked = project.tracks.flatMap((t) => t.items.filter((i) => i.type === "audio" && typeof i.linkedTo === "string").map((i) => ({ item: i, track: t })));
  if (!linked.length || !ops.length) return ops;
  let after: Project;
  try {
    after = applyEdit(createSession(project), { actor: "user", ops }).project;
  } catch {
    return ops;
  }
  // Where each item came from: a split's new half descends from the item split.
  const origin = new Map<string, string>();
  const originOf = (id: string): string => {
    const o = origin.get(id);
    return o === undefined || o === id ? id : originOf(o);
  };
  for (const op of ops) if (op.op === "split_item") origin.set(op.newId, op.item);
  const touched = new Set(ops.map(retimes).filter((id): id is string => !!id));
  const { starts } = layout(after);
  const afterItems = new Map(after.tracks.flatMap((t) => t.items.map((i) => [i.id, { item: i, track: t }] as const)));
  const taken = takenIds(after);
  const extra: Array<Op> = [];
  const unlink: Array<Op> = [];
  for (const { item: a } of linked) {
    // The sound itself was moved, trimmed, split or retimed: it's on its own now (its halves too).
    const own = [...afterItems.keys()].filter((id) => originOf(id) === a.id);
    if (touched.has(a.id) || [...touched].some((id) => originOf(id) === a.id)) {
      for (const id of own) if (afterItems.get(id)?.item.linkedTo !== undefined) unlink.push({ op: "update_item", item: id, set: { linkedTo: null } });
      continue;
    }
    const now = afterItems.get(a.id);
    // Locked: left exactly as it is.
    if (!now || now.track.locked || now.item.locked) continue;
    const clip = a.linkedTo!;
    const pieces = [...afterItems.values()]
      .filter(({ item }) => item.type === "clip" && originOf(item.id) === clip)
      .sort((x, y) => (starts.get(x.item.id) ?? 0) - (starts.get(y.item.id) ?? 0));
    if (!pieces.length) {
      // Its clip is gone (deleted, or every word of it cut): so is its sound.
      extra.push({ op: "delete_item", item: a.id });
      continue;
    }
    const media = after.media.find((m) => m.id === a.media);
    const frames = media?.probe?.frames;
    pieces.forEach(({ item: d }, i) => {
      const speed = d.speed ?? 1;
      const from = d.in ?? 0;
      let duration = d.duration;
      if (frames && !d.loop && from + duration * speed > frames) duration = Math.max(1, Math.floor((frames - from) / speed));
      const start = starts.get(d.id) ?? 0;
      const several = pieces.length > 1;
      const fadeIn = i === 0 && a.fadeIn ? Math.min(a.fadeIn, duration) : undefined;
      const fadeOut = i === pieces.length - 1 && a.fadeOut ? Math.min(a.fadeOut, duration - (fadeIn ?? 0)) : undefined;
      const want = { start, in: from, duration, speed: speed === 1 ? undefined : speed, keepPitch: d.keepPitch === false ? false : undefined, linkedTo: d.id };
      if (i === 0) {
        const cur = now.item;
        const same = cur.start === want.start && (cur.in ?? 0) === want.in && cur.duration === want.duration && cur.speed === want.speed && cur.keepPitch === want.keepPitch && cur.linkedTo === want.linkedTo && !several;
        if (same) return;
        const keys = cur.gainKeys?.length && (several || cur.in !== want.in || cur.duration !== want.duration || cur.speed !== want.speed);
        extra.push({
          op: "update_item",
          item: a.id,
          set: { start, in: from, duration, speed: want.speed ?? null, keepPitch: want.keepPitch ?? null, linkedTo: d.id, fadeIn: fadeIn || null, fadeOut: fadeOut && fadeOut > 0 ? fadeOut : null, ...(keys ? { gainKeys: null } : {}) },
        });
        return;
      }
      const id = uniqueIn("audio", taken);
      extra.push({
        op: "insert_item",
        track: now.track.id,
        item: { id, type: "audio", media: a.media!, in: from, start, duration, ...(want.speed ? { speed: want.speed } : {}), ...(want.keepPitch === false ? { keepPitch: false } : {}), ...(a.gainDb !== undefined ? { gainDb: a.gainDb } : {}), ...(fadeOut && fadeOut > 0 ? { fadeOut } : {}), linkedTo: d.id },
      });
    });
  }
  const synced = [...ops, ...unlink, ...extra];
  if (!extra.length) return synced;
  const check = tryOps(project, synced);
  if (!("problem" in check)) return synced;
  // Something is in the way: the sounds stop following rather than the edit failing.
  return [...ops, ...unlink, ...linked.filter(({ item }) => afterItems.has(item.id) && !unlink.some((u) => (u as { item: string }).item === item.id)).map(({ item }) => ({ op: "update_item" as const, item: item.id, set: { linkedTo: null } }))];
}
