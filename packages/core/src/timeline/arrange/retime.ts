import { applyEdit, createSession } from "../apply-ops.ts";
import { layout } from "../timeline.ts";
import { soundMedia } from "../../audio/audio.ts";
import {
  isRamped,
  localForSource,
  presetKeys,
  RAMP_EASES,
  RAMP_PRESETS,
  RAMP_SPEED,
  rampProblem,
  reverseProblem,
  sourceFrames,
  sourceSpan,
  trimSpeedKeys,
  type SpeedKey,
} from "../speedRamp.ts";
import type { Project, Id, Track, Item, Op } from "../types.ts";
import { freeAudioTrack, isFree, uniqueIn, nextName, tryOps, takenIds } from "./place.ts";

export const locate = (project: Pick<Project, "tracks">, id: Id) => {
  for (const track of project.tracks) {
    const index = track.items.findIndex((i) => i.id === id);
    if (index !== -1) return { track, index, item: track.items[index]! };
  }
  return undefined;
};
export const lockProblem = (track: Track, item: Item) =>
  track.locked ? `The ${track.name} track is locked. Unlock it to edit it.` : item.locked ? "That item is locked." : undefined;

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
export function planDetachAudio(
  project: Pick<Project, "tracks" | "media" | "canvas">,
  itemId: Id,
  taken: Set<string>,
  options: { readonly id?: Id; readonly track?: Id } = {},
): DetachAudioPlan | { readonly problem: string } {
  const found = locate(project, itemId);
  if (!found) return { problem: "That item isn't in the project any more." };
  const { track, item } = found;
  if (item.type !== "clip") return { problem: "Only a clip's sound can be detached." };
  if (item.mute) return { problem: "This clip's sound is already off (detached or muted)." };
  if (isRamped(item)) return { problem: "A clip with a speed ramp plays without its sound, so there's none to detach." };
  if (item.reverse) return { problem: "A reversed clip's sound can't be detached: play it forwards first." };
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
 * pitch follow the speed (absent: unchanged). Checked with the timeline rules. A speed ramp
 * (D327) is replaced by the constant speed.
 */
export function planSetSpeed(project: Project, itemId: Id, speed: number, keepPitch?: boolean): RetimePlan | { readonly problem: string } {
  const found = locate(project, itemId);
  if (!found) return { problem: "That item isn't in the project any more." };
  const { track, item } = found;
  if (item.type !== "clip" && item.type !== "audio") return { problem: "Only clips and audio items have a speed." };
  const media = project.media.find((m) => m.id === item.media);
  if (!media || media.kind === "image") return { problem: "A still picture has no speed." };
  const locked = lockProblem(track, item);
  if (locked) return { problem: locked };
  if (!Number.isFinite(speed) || speed < SPEED_RANGE.min || speed > SPEED_RANGE.max)
    return { problem: `Pick a speed from ${SPEED_RANGE.min}× to ${SPEED_RANGE.max}×.` };
  const ramped = isRamped(item);
  const old = item.speed ?? 1;
  const next = Math.round(speed * 1000) / 1000;
  let duration = Math.max(1, Math.round(ramped ? sourceSpan(item) / next : item.duration * (old / next)));
  const frames = media.probe?.frames;
  const from = item.in ?? 0;
  if (frames && !item.loop && !(item.type === "clip" && item.hold) && from + duration * next > frames)
    duration = Math.max(1, Math.floor((frames - from) / next));
  const set: Record<string, unknown> = { speed: next === 1 ? null : next, duration, ...(ramped ? { speedKeys: null } : {}) };
  if (keepPitch !== undefined) set.keepPitch = keepPitch ? null : false;
  if (next === old && keepPitch === undefined && !ramped) return { ops: [], summary: "", duration: item.duration };
  const summary = next === old && !ramped ? (keepPitch === false ? "Pitch follows speed" : "Keep pitch") : `Speed ${speedLabel(next)}`;
  return retimed(project, found, duration, set, summary, "at that speed", ramped ? duration / item.duration : old / next);
}

export interface RetimePlan {
  readonly ops: ReadonlyArray<Op>;
  readonly summary: string;
  readonly duration: number;
}

/**
 * An update that gives an item a new length on the timeline (`set` with its new duration and
 * timing): volume and box keys and animations scale with it, fades stay within it, and a main
 * transition that no longer fits goes.
 */
function retimed(
  project: Project,
  found: NonNullable<ReturnType<typeof locate>>,
  duration: number,
  fields: Record<string, unknown>,
  summary: string,
  why: string,
  ratio = duration / found.item.duration,
): RetimePlan | { readonly problem: string } {
  const { track, item } = found;
  const scale = (f: number) => Math.min(duration, Math.round(f * ratio));
  const set: Record<string, unknown> = { ...fields, duration };
  if (item.keys?.length) set.keys = item.keys.map((k) => ({ ...k, frame: scale(k.frame) }));
  if (item.gainKeys?.length) set.gainKeys = item.gainKeys.map((k) => ({ ...k, frame: scale(k.frame) }));
  if (item.animation)
    set.animation = Object.fromEntries(
      Object.entries(item.animation).map(([k, a]) => [k, a ? { ...a, duration: Math.max(1, Math.min(duration, Math.round(a.duration * ratio))) } : a]),
    );
  const fadeIn = item.fadeIn ? Math.min(item.fadeIn, duration) : undefined;
  const fadeOut = item.fadeOut ? Math.min(item.fadeOut, duration - (fadeIn ?? 0)) : undefined;
  if (item.fadeIn !== undefined) set.fadeIn = fadeIn ?? null;
  if (item.fadeOut !== undefined) set.fadeOut = fadeOut && fadeOut > 0 ? fadeOut : null;
  const ops: Array<Op> = [{ op: "update_item", item: item.id, set }];
  // A main transition that no longer fits goes (the cut stays).
  const draft = tryOps(project, ops);
  if ("problem" in draft && track.role === "main") {
    const drop: Array<Op> = [];
    if (item.transitionIn) drop.push({ op: "set_transition", item: item.id, transition: null });
    const after = track.items[found.index + 1];
    if (after?.transitionIn) drop.push({ op: "set_transition", item: after.id, transition: null });
    const retry = tryOps(project, [...drop, ...ops]);
    if ("problem" in retry) return retry;
    return { ops: [...drop, ...ops], summary, duration };
  }
  if ("problem" in draft) return /overlaps/.test(draft.problem) ? { problem: `There's no room on this track for it ${why}: move the next item first.` } : draft;
  return { ops, summary, duration };
}

/** The local length at which `keys(duration)` plays `span` media frames, at most `room` (the media left). */
function rampLength(keysFor: (duration: number) => ReadonlyArray<SpeedKey>, span: number, room: number): number {
  const played = (d: number) => sourceFrames({ speedKeys: keysFor(d) }, d);
  let duration = Math.max(1, Math.round(span));
  for (let pass = 0; pass < 4; pass++) duration = Math.max(1, Math.round((duration * span) / Math.max(1e-9, played(duration))));
  while (duration > 1 && played(duration) > room) duration--;
  return duration;
}

/**
 * A speed ramp on a clip (D327): a preset (RAMP_PRESETS, its keys placed over the clip's new
 * length), keys of its own (local frames) or null (back to normal speed). The clip keeps playing the
 * same stretch of its media, so its length becomes the curve's: the local length whose integral is
 * that stretch. Keys, fades and animations scale as for a speed change. A ramped clip is silent.
 */
export function planSpeedRamp(project: Project, itemId: Id, ramp: string | ReadonlyArray<SpeedKey> | null): RetimePlan | { readonly problem: string } {
  const found = locate(project, itemId);
  if (!found) return { problem: "That item isn't in the project any more." };
  const { track, item } = found;
  const locked = lockProblem(track, item);
  if (locked) return { problem: locked };
  if (ramp === null) {
    if (!isRamped(item)) return { ops: [], summary: "", duration: item.duration };
    return planSetSpeed(project, itemId, 1);
  }
  const problem = rampProblem(project, item);
  if (problem) return { problem };
  const preset = typeof ramp === "string" ? RAMP_PRESETS[ramp] : undefined;
  if (typeof ramp === "string" && !preset) return { problem: `There's no ramp called "${ramp}": pick ${Object.keys(RAMP_PRESETS).join(", ")}.` };
  if (Array.isArray(ramp)) {
    const bad = ramp.find(
      (k) => !Number.isInteger(k.frame) || !(k.speed >= RAMP_SPEED.min && k.speed <= RAMP_SPEED.max) || (k.ease !== undefined && !RAMP_EASES.includes(k.ease)),
    );
    if (bad || !ramp.length)
      return {
        problem: `Each key needs a whole frame, a speed from ${RAMP_SPEED.min}× to ${RAMP_SPEED.max}× and an ease of ${RAMP_EASES.join(", ")} (or none).`,
      };
  }
  const media = project.media.find((m) => m.id === item.media)!;
  const span = sourceSpan(item);
  const room = media.probe?.frames ? media.probe.frames - (item.in ?? 0) : Infinity;
  const keysFor = (d: number) => (preset ? presetKeys(preset, d) : (ramp as ReadonlyArray<SpeedKey>).map((k) => ({ ...k })));
  let duration = preset ? rampLength(keysFor, span, room) : Math.max(1, Math.round(localForSource({ speedKeys: keysFor(item.duration) }, span)));
  const speedKeys = keysFor(duration);
  while (duration > 1 && sourceFrames({ speedKeys }, duration) > room) duration--;
  return retimed(
    project,
    found,
    duration,
    { speed: null, speedKeys: preset ? speedKeys : trimSpeedKeys(speedKeys, duration) },
    `Speed ramp ${preset?.label ?? ""}`.trim(),
    "with that ramp",
  );
}

/**
 * Reverse a clip (D327) or play it forwards again: the same stretch of its media, the other way.
 * A reversed clip's in point counts from its media's end, so it is converted here.
 */
export function planReverse(project: Project, itemId: Id, reverse: boolean): RetimePlan | { readonly problem: string } {
  const found = locate(project, itemId);
  if (!found) return { problem: "That item isn't in the project any more." };
  const { track, item } = found;
  const locked = lockProblem(track, item);
  if (locked) return { problem: locked };
  if (!!item.reverse === reverse) return { ops: [], summary: "", duration: item.duration };
  const problem = reverseProblem(project, item);
  if (problem) return { problem };
  const length = project.media.find((m) => m.id === item.media)!.probe!.frames!;
  // Floored, so the stretch read the other way still ends within the media.
  const at = Math.max(0, Math.floor(length - (item.in ?? 0) - sourceSpan(item) + 1e-9));
  const ops: Array<Op> = [{ op: "update_item", item: item.id, set: { reverse: reverse ? true : null, in: at } }];
  const draft = tryOps(project, ops);
  if ("problem" in draft) return draft;
  return { ops, summary: reverse ? "Reverse" : "Play forwards", duration: item.duration };
}

/** Ops that move, cut or retime an item itself (a linked sound touched like this goes its own way). */
const RETIME_KEYS = new Set(["start", "in", "duration", "speed", "speedKeys", "reverse", "media", "loop"]);
const retimes = (op: Op): string | undefined => {
  if (op.op === "move_item" || op.op === "trim_item" || op.op === "split_item" || op.op === "slip_item" || op.op === "roll_edit") return op.item;
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
  const linked = project.tracks.flatMap((t) =>
    t.role === "main"
      ? []
      : t.items.filter((i) => (i.type === "audio" || i.type === "clip") && typeof i.linkedTo === "string").map((i) => ({ item: i, track: t })),
  );
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
  const beforeStarts = layout(project).starts;
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
    const aStart = beforeStarts.get(a.id) ?? 0;
    pieces.forEach(({ item: d }, i) => {
      let speed = d.speed ?? 1;
      let from = Math.max(0, (d.in ?? 0) + offset);
      let duration = d.duration;
      let start = starts.get(d.id) ?? 0;
      let keepPitch = d.keepPitch;
      let linkedTo: string | undefined = d.id;
      // Issue #118: a piece that plays another media now (a replaced fragment): the linked item
      // plays on there as it did before (a cutaway over the same sound), no longer following it.
      if (clipBefore && d.media !== clipBefore.media) {
        const s = Math.max(start, aStart);
        const e = Math.min(start + d.duration, aStart + a.duration);
        if (e <= s) {
          if (i === 0) extra.push({ op: "delete_item", item: a.id });
          return;
        }
        speed = a.speed ?? 1;
        from = (a.in ?? 0) + Math.round((s - aStart) * speed);
        start = s;
        duration = e - s;
        keepPitch = a.keepPitch;
        linkedTo = undefined;
      } else if (frames && !d.loop && !(isClip && a.hold) && from + duration * speed > frames) duration = Math.max(1, Math.floor((frames - from) / speed));
      const several = pieces.length > 1;
      const fadeIn = i === 0 && a.fadeIn ? Math.min(a.fadeIn, duration) : undefined;
      const fadeOut = i === pieces.length - 1 && a.fadeOut ? Math.min(a.fadeOut, duration - (fadeIn ?? 0)) : undefined;
      const want = { start, in: from, duration, speed: speed === 1 ? undefined : speed, keepPitch: keepPitch === false ? false : undefined, linkedTo };
      if (i === 0) {
        const cur = now.item;
        const same =
          cur.start === want.start &&
          (cur.in ?? 0) === want.in &&
          cur.duration === want.duration &&
          cur.speed === want.speed &&
          cur.keepPitch === want.keepPitch &&
          cur.linkedTo === want.linkedTo &&
          !several;
        if (same) return;
        const keys = cur.gainKeys?.length && (several || cur.in !== want.in || cur.duration !== want.duration || cur.speed !== want.speed);
        const boxKeys = isClip && cur.keys?.length && (several || cur.duration !== want.duration || cur.speed !== want.speed);
        extra.push({
          op: "update_item",
          item: a.id,
          set: {
            start,
            in: from,
            duration,
            speed: want.speed ?? null,
            keepPitch: want.keepPitch ?? null,
            linkedTo: linkedTo ?? null,
            fadeIn: fadeIn || null,
            fadeOut: fadeOut && fadeOut > 0 ? fadeOut : null,
            ...(keys ? { gainKeys: null } : {}),
            ...(boxKeys ? { keys: null } : {}),
          },
        });
        return;
      }
      if (isClip) {
        // A linked picture's piece: the same clip (box, effects, look) over the piece's stretch.
        const { fadeIn: _fi, fadeOut: _fo, keys: _k, gainKeys: _g, animation: _a, speed: _s, keepPitch: _p, ...rest } = a;
        const id = uniqueIn(a.id.replace(/-\d+$/, "") || "clip", taken);
        extra.push({
          op: "insert_item",
          track: now.track.id,
          item: {
            ...rest,
            id,
            in: from,
            start,
            duration,
            ...(want.speed ? { speed: want.speed } : {}),
            ...(want.keepPitch === false ? { keepPitch: false } : {}),
            ...(fadeOut && fadeOut > 0 ? { fadeOut } : {}),
            ...(linkedTo ? { linkedTo } : {}),
          } as Item,
        });
        return;
      }
      const id = uniqueIn("audio", taken);
      extra.push({
        op: "insert_item",
        track: now.track.id,
        item: {
          id,
          type: "audio",
          media: a.media!,
          in: from,
          start,
          duration,
          ...(want.speed ? { speed: want.speed } : {}),
          ...(want.keepPitch === false ? { keepPitch: false } : {}),
          ...(a.gainDb !== undefined ? { gainDb: a.gainDb } : {}),
          ...(a.mute ? { mute: true } : {}),
          ...(a.name ? { name: a.name } : {}),
          ...(fadeOut && fadeOut > 0 ? { fadeOut } : {}),
          ...(linkedTo ? { linkedTo } : {}),
        },
      });
    });
  }
  const synced = [...ops, ...unlink, ...extra];
  if (!extra.length) return synced;
  const check = tryOps(project, synced);
  if (!("problem" in check)) return synced;
  // Something is in the way: the linked items stop following rather than the edit failing.
  return [
    ...ops,
    ...unlink,
    ...linked
      .filter(({ item }) => afterItems.has(item.id) && !unlink.some((u) => (u as { item: string }).item === item.id))
      .map(({ item }) => ({ op: "update_item" as const, item: item.id, set: { linkedTo: null } })),
  ];
}
