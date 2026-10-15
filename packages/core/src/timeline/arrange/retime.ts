import { applyEdit, createSession } from "../apply-ops.ts";
import { layout } from "../timeline.ts";
import { soundMedia } from "../../audio/audio.ts";
import type { Project, Id, Track, Item, Op } from "../types.ts";
import { freeAudioTrack, isFree, uniqueIn, nextName, tryOps, takenIds } from "./place.ts";

export const locate = (project: Pick<Project, "tracks">, id: Id) => {
  for (const track of project.tracks) {
    const index = track.items.findIndex((i) => i.id === id);
    if (index !== -1) return { track, index, item: track.items[index]! };
  }
  return undefined;
};
export const lockProblem = (track: Track, item: Item) => (track.locked ? `The ${track.name} track is locked. Unlock it to edit it.` : item.locked ? "That item is locked." : undefined);

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
 * Linked sound (D123), and linked parts of a take (D215): an audio item or an off-main clip with
 * `linkedTo` follows its clip until the user moves, trims, splits or retimes the linked item itself.
 * This returns `ops` plus the ops that keep every linked item in step with what `ops` did to its
 * clip: the same start, length and speed, its in point moved by as much as the clip's (a detached
 * sound plays the clip's own media from the same point; a take's microphone keeps its own offset
 * into its file), a piece per piece when the clip was split or cut by its transcript (the words cut
 * from the picture are cut from the sound too), gone when the clip is gone. An item the ops touch
 * directly is unlinked instead. If keeping them in step would break the timeline (something else in
 * the way on the linked item's track), they're unlinked rather than the edit refused. Pure; run where
 * edits are applied (the server) and drafted (the renderer).
 */
export function withLinkedAudio(project: Project, ops: ReadonlyArray<Op>): ReadonlyArray<Op> {
  const linked = project.tracks.flatMap((t) => (t.role === "main" ? [] : t.items.filter((i) => (i.type === "audio" || i.type === "clip") && typeof i.linkedTo === "string").map((i) => ({ item: i, track: t }))));
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
  const beforeItems = new Map(project.tracks.flatMap((t) => t.items.map((i) => [i.id, i] as const)));
  const afterItems = new Map(after.tracks.flatMap((t) => t.items.map((i) => [i.id, { item: i, track: t }] as const)));
  const taken = takenIds(after);
  const extra: Array<Op> = [];
  const unlink: Array<Op> = [];
  for (const { item: a } of linked) {
    // The linked item itself was moved, trimmed, split or retimed: it's on its own now (its halves too).
    const own = [...afterItems.keys()].filter((id) => originOf(id) === a.id);
    if (touched.has(a.id) || [...touched].some((id) => originOf(id) === a.id)) {
      for (const id of own) if (afterItems.get(id)?.item.linkedTo !== undefined) unlink.push({ op: "update_item", item: id, set: { linkedTo: null } });
      continue;
    }
    const now = afterItems.get(a.id);
    // Locked: left exactly as it is.
    if (!now || now.track.locked || now.item.locked) continue;
    const clip = a.linkedTo!;
    const clipBefore = beforeItems.get(clip);
    const pieces = [...afterItems.values()]
      .filter(({ item }) => item.type === "clip" && originOf(item.id) === clip)
      .sort((x, y) => (starts.get(x.item.id) ?? 0) - (starts.get(y.item.id) ?? 0));
    if (!pieces.length) {
      // Its clip is gone (deleted, or every word of it cut): so is the linked item.
      extra.push({ op: "delete_item", item: a.id });
      continue;
    }
    const media = after.media.find((m) => m.id === a.media);
    const frames = media?.kind === "image" ? undefined : media?.probe?.frames;
    // The linked item's in point moves with the clip's (equal for a detached sound: D123 unchanged).
    const offset = (a.in ?? 0) - (clipBefore?.in ?? a.in ?? 0);
    const isClip = a.type === "clip";
    pieces.forEach(({ item: d }, i) => {
      const speed = d.speed ?? 1;
      const from = Math.max(0, (d.in ?? 0) + offset);
      let duration = d.duration;
      if (frames && !d.loop && !(isClip && a.hold) && from + duration * speed > frames) duration = Math.max(1, Math.floor((frames - from) / speed));
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
        const boxKeys = isClip && cur.keys?.length && (several || cur.duration !== want.duration || cur.speed !== want.speed);
        extra.push({
          op: "update_item",
          item: a.id,
          set: { start, in: from, duration, speed: want.speed ?? null, keepPitch: want.keepPitch ?? null, linkedTo: d.id, fadeIn: fadeIn || null, fadeOut: fadeOut && fadeOut > 0 ? fadeOut : null, ...(keys ? { gainKeys: null } : {}), ...(boxKeys ? { keys: null } : {}) },
        });
        return;
      }
      if (isClip) {
        // A linked picture's piece: the same clip (box, effects, look) over the piece's stretch.
        const { fadeIn: _fi, fadeOut: _fo, keys: _k, gainKeys: _g, animation: _a, speed: _s, keepPitch: _p, ...rest } = a;
        const id = uniqueIn(a.id.replace(/-\d+$/, "") || "clip", taken);
        extra.push({ op: "insert_item", track: now.track.id, item: { ...rest, id, in: from, start, duration, ...(want.speed ? { speed: want.speed } : {}), ...(want.keepPitch === false ? { keepPitch: false } : {}), ...(fadeOut && fadeOut > 0 ? { fadeOut } : {}), linkedTo: d.id } as Item });
        return;
      }
      const id = uniqueIn("audio", taken);
      extra.push({
        op: "insert_item",
        track: now.track.id,
        item: { id, type: "audio", media: a.media!, in: from, start, duration, ...(want.speed ? { speed: want.speed } : {}), ...(want.keepPitch === false ? { keepPitch: false } : {}), ...(a.gainDb !== undefined ? { gainDb: a.gainDb } : {}), ...(a.mute ? { mute: true } : {}), ...(a.name ? { name: a.name } : {}), ...(fadeOut && fadeOut > 0 ? { fadeOut } : {}), linkedTo: d.id },
      });
    });
  }
  const synced = [...ops, ...unlink, ...extra];
  if (!extra.length) return synced;
  const check = tryOps(project, synced);
  if (!("problem" in check)) return synced;
  // Something is in the way: the linked items stop following rather than the edit failing.
  return [...ops, ...unlink, ...linked.filter(({ item }) => afterItems.has(item.id) && !unlink.some((u) => (u as { item: string }).item === item.id)).map(({ item }) => ({ op: "update_item" as const, item: item.id, set: { linkedTo: null } }))];
}
