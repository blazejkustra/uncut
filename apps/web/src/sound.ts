// Sound editing (phase 4 chunk 5, D54): pure planners for the Inspector's volume and fades, the
// timeline's fade handles and the track volume. Like the text and timeline planners (D52/D53),
// every gesture becomes one project.edit (validated, one ⌘Z, in the agent's next note). Values are
// clamped to what the server accepts, so a slider can't make an edit that is refused: volume
// −60 (silence) … +12 dB, fades ≥ 0 and fade in + fade out ≤ the item's length. Defaults are
// removed rather than stored (0 dB, no fade), so project.json stays clean.
import { keyDbAt, MAX_DB, SILENCE_DB, soundMedia } from "@uncut/core/audio";
import { dbWords, panWords } from "@uncut/core/edit-log";

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

// ---- the Mixer (D83) ----

/** A pan as the server takes it: −1…1 in hundredths. */
export const clampPan = (pan: number) => Math.round(Math.min(1, Math.max(-1, Number.isFinite(pan) ? pan : 0)) * 100) / 100;

/** A pan in words: "centre", "30 % left", "100 % right". */
export { panWords };
/** The pan's short label on a strip: "C", "L30", "R100". */
export const panShort = (pan: number) => (pan === 0 ? "C" : `${pan < 0 ? "L" : "R"}${Math.round(Math.abs(pan) * 100)}`);

/** A track's pan (the mixer is replaced whole, so its other fields are kept). 0 removes the field. */
export function planTrackPan(project: ProjectModel, trackId: string, pan: number): Plan | Problem {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return { problem: "That track isn't in the project any more." };
  const next = clampPan(pan);
  if (next === (track.mixer?.pan ?? 0)) return { ops: [], summary: "" };
  const { pan: _, ...rest } = track.mixer ?? {};
  const mixer = next === 0 ? rest : { ...rest, pan: next };
  return { ops: [{ op: "update_track", track: track.id, set: { mixer: Object.keys(mixer).length ? mixer : null } }], summary: `Pan ${track.name} ${panWords(next)}` };
}

/** The master volume (project master.gainDb, after the track sum). 0 dB removes the field; loudness and the rest are kept. */
export function planMasterGain(project: ProjectModel, db: number): Plan | Problem {
  const next = clampDb(db);
  if (next === (project.master?.gainDb ?? 0)) return { ops: [], summary: "" };
  const { gainDb: _, ...rest } = project.master ?? {};
  const master = next === 0 ? rest : { ...rest, gainDb: next };
  return { ops: [{ op: "update_project", set: { master: Object.keys(master).length ? master : null } }], summary: `Set master volume to ${dbWords(next)}` };
}

/** Why the master volume may not change the export's level (D83): loudness targets normalise after it. */
export const MASTER_EXPORT_NOTE = "The master volume changes what you hear here and an export set to As mixed. Normal and Quieter even the loudness out afterwards, so there it only matters for the balance into the normaliser; at −∞ the export is silent.";

// ---- volume keys on the timeline (D83) ----

type GainKey = { readonly frame: number; readonly db: number };
const sortedKeys = (item: Item): Array<GainKey> => [...(item.gainKeys ?? [])].sort((a, b) => a.frame - b.frame);
const secsOf = (frames: number, fps: number) => `${(frames / fps).toFixed(1)} s`;
/** A key's dB, so that the item's volume plus it stays within −60…+12 dB, in tenths. */
const clampKeyDb = (item: Item, db: number) => Math.round(Math.min(MAX_DB - (item.gainDb ?? 0), Math.max(SILENCE_DB - (item.gainDb ?? 0), db)) * 10) / 10;

/** The item's volume curve at `local` frames from its start, in dB: gainDb + the keys' envelope (what the line on the timeline shows). */
export const envelopeDbAt = (item: Item, local: number) => (item.gainDb ?? 0) + keyDbAt(item.gainKeys, Math.min(item.duration, Math.max(0, local)));

/**
 * Where a dB value sits on the timeline's volume line and the Mixer's faders, 0 at the top and 1 at
 * the bottom: +12 dB at the top, linear in dB down to −24 dB at three quarters (0 dB a quarter
 * down), then −24 … −60 (silence) over the last quarter.
 */
export function levelY(db: number): number {
  const d = Math.min(MAX_DB, Math.max(SILENCE_DB, db));
  return d >= -24 ? ((MAX_DB - d) / 36) * 0.75 : 0.75 + ((-24 - d) / 36) * 0.25;
}
/** levelY's inverse. */
export function yLevel(y: number): number {
  const p = Math.min(1, Math.max(0, y));
  return p <= 0.75 ? MAX_DB - (p / 0.75) * 36 : -24 - ((p - 0.75) / 0.25) * 36;
}

/** Add a volume key at `frame` (from the item's start) with the curve's value there unless `db` (the item's dB there) is given. */
export function planAddGainKey(project: ProjectModel, itemId: string, frame: number, db?: number): Plan | Problem {
  const item = find(project, itemId);
  if (!item) return { problem: "That item isn't in the project any more." };
  if (!hasSound(project, item)) return { problem: "That item has no sound." };
  const f = Math.max(0, Math.min(item.duration, Math.round(frame)));
  const keyDb = clampKeyDb(item, db === undefined ? keyDbAt(item.gainKeys, f) : db - (item.gainDb ?? 0));
  if (sortedKeys(item).some((k) => k.frame === f && k.db === keyDb)) return { ops: [], summary: "" };
  const keys = sortedKeys(item).filter((k) => k.frame !== f);
  keys.push({ frame: f, db: keyDb });
  keys.sort((a, b) => a.frame - b.frame);
  const fps = project.canvas.fps;
  return planUpdate(project, itemId, { gainKeys: keys }, `Add volume key at ${secsOf(f, fps)}${db === undefined ? "" : ` (${dbWords((item.gainDb ?? 0) + keyDb)})`}`);
}

/**
 * Move key `index` (of the keys in frame order) to `frame`, the item's volume there `db`. It stays
 * strictly between its neighbours (one frame clear of each, so two keys never share a frame and
 * the move never swallows one) and inside the item; with no room either side it keeps its frame.
 */
export function planMoveGainKey(project: ProjectModel, itemId: string, index: number, frame: number, db: number): Plan | Problem {
  const item = find(project, itemId);
  if (!item) return { problem: "That item isn't in the project any more." };
  const keys = sortedKeys(item);
  const key = keys[index];
  if (!key) return { problem: "That volume key isn't there any more." };
  const lo = index > 0 ? keys[index - 1]!.frame + 1 : 0;
  const hi = index < keys.length - 1 ? keys[index + 1]!.frame - 1 : item.duration;
  const f = lo > hi ? key.frame : Math.max(lo, Math.min(hi, Math.round(frame)));
  const next = { frame: f, db: clampKeyDb(item, db - (item.gainDb ?? 0)) };
  if (next.frame === key.frame && next.db === key.db) return { ops: [], summary: "" };
  keys[index] = next;
  const fps = project.canvas.fps;
  return planUpdate(project, itemId, { gainKeys: keys }, `Move volume key to ${secsOf(f, fps)}, ${dbWords((item.gainDb ?? 0) + next.db)}`);
}

/** Remove key `index` (of the keys in frame order), only that one; the last one removes gainKeys. */
export function planRemoveGainKey(project: ProjectModel, itemId: string, index: number): Plan | Problem {
  const item = find(project, itemId);
  if (!item) return { problem: "That item isn't in the project any more." };
  const keys = sortedKeys(item);
  const key = keys[index];
  if (!key) return { problem: "That volume key isn't there any more." };
  const rest = keys.filter((_, i) => i !== index);
  return planUpdate(project, itemId, { gainKeys: rest.length ? rest : null }, `Remove volume key at ${secsOf(key.frame, project.canvas.fps)}`);
}

/** The index (in frame order) of the key at `frame` in a plan's gainKeys, for selecting the key an edit made. */
export const keyIndexAt = (keys: ReadonlyArray<GainKey> | null | undefined, frame: number) => (keys ? [...keys].sort((a, b) => a.frame - b.frame).findIndex((k) => k.frame === frame) : -1);
