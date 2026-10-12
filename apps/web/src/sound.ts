// Sound editing (phase 4 chunk 5, D54): pure planners for the Inspector's volume and fades, the
// timeline's fade handles and the track volume. Like the text and timeline planners (D52/D53),
// every gesture becomes one project.edit (validated, one ⌘Z, in the agent's next note). Values are
// clamped to what the server accepts, so a slider can't make an edit that is refused: volume
// −60 (silence) … +12 dB, fades ≥ 0 and fade in + fade out ≤ the item's length. Defaults are
// removed rather than stored (0 dB, no fade), so project.json stays clean.
import { MAX_DB, SILENCE_DB, soundMedia } from "@uncut/core/audio";
import { dbWords } from "@uncut/core/edit-log";

import type { Plan } from "./edit.ts";
import { itemLabel, type Item, type ProjectModel, type Track } from "./project.ts";
import { planUpdate } from "./text.ts";

type Problem = { readonly problem: string };

/** A volume as the server takes it: −60…+12 dB in tenths. */
export const clampDb = (db: number) => Math.round(Math.min(MAX_DB, Math.max(SILENCE_DB, db)) * 10) / 10;

/** Whether an item has sound the Inspector can change (a clip whose media has audio, an audio item). */
export const hasSound = (project: ProjectModel, item: Item) => soundMedia(project, item) !== undefined;

const find = (project: ProjectModel, id: string) => {
  for (const track of project.tracks) {
    const item = track.items.find((i) => i.id === id);
    if (item) return item;
  }
  return undefined;
};

/** The item's volume in dB. 0 dB removes the field. */
export function planGain(project: ProjectModel, itemId: string, db: number): Plan | Problem {
  const item = find(project, itemId);
  if (!item) return { problem: "That item isn't in the project any more." };
  if (!hasSound(project, item)) return { problem: "That item has no sound." };
  const next = clampDb(db);
  if (next === (item.gainDb ?? 0)) return { ops: [], summary: "" };
  return planUpdate(project, itemId, { gainDb: next === 0 ? null : next }, `Set volume of ${itemLabel(project, item)} to ${dbWords(next)}`);
}

/**
 * A fade in or out, in frames. Clamped to 0…(length − the other fade), so the two never overlap
 * past the item (the server refuses that). 0 removes the fade.
 */
export function planFade(project: ProjectModel, itemId: string, edge: "in" | "out", frames: number): Plan | Problem {
  const item = find(project, itemId);
  if (!item) return { problem: "That item isn't in the project any more." };
  if (!hasSound(project, item)) return { problem: "That item has no sound." };
  const key = edge === "in" ? "fadeIn" : "fadeOut";
  const other = (edge === "in" ? item.fadeOut : item.fadeIn) ?? 0;
  const next = Math.max(0, Math.min(item.duration - other, Math.round(frames)));
  if (next === (item[key] ?? 0)) return { ops: [], summary: "" };
  const secs = (next / project.canvas.fps).toFixed(1);
  const name = itemLabel(project, item);
  return planUpdate(project, itemId, { [key]: next === 0 ? null : next }, next === 0 ? `Remove the fade ${edge} on ${name}` : `Fade ${edge} ${name} over ${secs} s`);
}

/** A track's volume in dB (the mixer is replaced whole, so mute and the rest are kept). */
export function planTrackGain(project: ProjectModel, trackId: string, db: number): Plan | Problem {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return { problem: "That track isn't in the project any more." };
  const next = clampDb(db);
  if (next === (track.mixer?.gainDb ?? 0)) return { ops: [], summary: "" };
  const { gainDb: _, ...rest } = track.mixer ?? {};
  const mixer = next === 0 ? rest : { ...rest, gainDb: next };
  return { ops: [{ op: "update_track", track: track.id, set: { mixer: Object.keys(mixer).length ? mixer : null } }], summary: `Set volume of track ${track.name} to ${dbWords(next)}` };
}

/** Tracks whose items can sound: audio tracks, and video tracks holding a clip with sound. */
export const soundTrack = (project: ProjectModel, track: Track) => track.kind === "audio" || (track.kind === "video" && track.items.some((i) => hasSound(project, i)));

/** The volume slider's position for a dB value and back: −60 shows as −∞. */
export const dbLabel = (db: number) => (db <= SILENCE_DB ? "−∞" : `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(Math.round(db * 10) / 10)}`);
