// D349: a video with sound goes on the timeline as a linked pair, the clip (muted) and its sound
// on an audio track, as Detach audio leaves it. Edits then follow by delta (D347).
import { DUCK } from "../../audio/effects.ts";
import { applyEdit, createSession } from "../apply-ops.ts";
import { layout } from "../timeline.ts";
import type { Id, Op, Project, Track } from "../types.ts";
import { withLinks } from "./linkFollow.ts";
import { soundOwner } from "./links.ts";
import { freeAudioTrack, nextName, takenIds, uniqueIn } from "./place.ts";
import { planDetachAudio } from "./retime.ts";

const applied = (project: Project, ops: ReadonlyArray<Op>) => applyEdit(createSession(project), { actor: "user", ops }).project;

/**
 * `ops` plus the ops that give each clip in `placed` its own linked sound on a free audio track for
 * clips' sounds (soundTrack), where the ops and what their links follow (withLinks) leave room. A
 * clip without sound, muted, ramped, reversed or locked stays as it is, and so do ops that can't apply.
 */
export function withSoundPairs(project: Project, ops: ReadonlyArray<Op>, placed: ReadonlyArray<Id>): ReadonlyArray<Op> {
  if (!placed.length) return ops;
  const followed = withLinks(project, ops);
  if ("problem" in followed) return ops;
  let now: Project;
  try {
    now = applied(project, followed.ops);
  } catch {
    return ops;
  }
  const taken = takenIds(now);
  const pairs: Array<Op> = [];
  for (const id of placed) {
    const track = soundTrack(now, id, taken);
    const plan = planDetachAudio(track.project, id, taken, { track: track.id });
    if ("problem" in plan) continue;
    const ops = [...track.ops, ...plan.ops];
    pairs.push(...ops);
    now = applied(now, ops);
  }
  return pairs.length ? [...ops, ...pairs] : ops;
}

const ducks = (track: Track) => !!track.mixer?.effects?.some((fx) => fx.module === DUCK);

/**
 * A track holding clips' own sounds: only those, or with other sounds (an effect) when it doesn't
 * duck, bypassed or not (a ducking track with a song on it is a music bed).
 */
export const holdsClipSounds = (project: Project, track: Track) => {
  const owned = track.items.filter((i) => soundOwner(project, i)).length;
  return owned > 0 && (owned === track.items.length || !ducks(track));
};

/**
 * An empty track a clip's sound can start: one Uncut named, without ducking (an emptied music bed
 * keeps its ducking; voice processing and volume are welcome).
 */
export const emptyForClipSounds = (track: Track) => !track.items.length && /^Audio( [1-9]\d*)?$/.test(track.name) && !ducks(track);

/**
 * A track a clip's sound can join: a free one already holding clips' own sounds, else an empty one
 * for them (emptyForClipSounds).
 */
function clipSoundTrack(project: Project, start: number, duration: number): Track | undefined {
  return freeAudioTrack(project, start, duration, (t) => holdsClipSounds(project, t)) ?? freeAudioTrack(project, start, duration, emptyForClipSounds);
}

/** The audio track for clip `id`'s sound: a free one for clips' sounds, else a new "Audio N" (with its op). */
function soundTrack(project: Project, id: Id, taken: Set<string>): { readonly id: Id; readonly project: Project; readonly ops: ReadonlyArray<Op> } {
  const clip = project.tracks.flatMap((t) => t.items).find((i) => i.id === id);
  const start = layout(project).starts.get(id) ?? 0;
  const found = clip && clipSoundTrack(project, start, clip.duration);
  if (found) return { id: found.id, project, ops: [] };
  const track = { id: uniqueIn("audio-track", taken), kind: "audio" as const, name: nextName(project, "Audio") };
  const ops: ReadonlyArray<Op> = [{ op: "add_track", track }];
  return { id: track.id, project: applied(project, ops), ops };
}

/** The new clips an op list inserts (insert_item, and place_item with a new item). */
export function insertedClips(ops: ReadonlyArray<unknown>): Array<Id> {
  return ops.flatMap((raw) => {
    const op = raw as { op?: unknown; item?: { id?: unknown; type?: unknown } };
    const item = op?.op === "insert_item" || op?.op === "place_item" ? op.item : undefined;
    return item && typeof item === "object" && item.type === "clip" && typeof item.id === "string" ? [item.id] : [];
  });
}
