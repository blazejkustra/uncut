// Audio maths shared by the preview's playback mix and export (D39, D54): which items sound at
// project frame f, from where in their media, and how loud. Like visualsAt, frame f is the moment
// f / fps and may be fractional (the playback clock is).
//
// Loudness of an item at f, as a linear amplitude factor:
//   dB   = item.gainDb + gainKeys envelope at f + track.mixer.gainDb   (each 0 when unset)
//   gain = dbToGain(dB) × fade in × fade out × transition
// - gainKeys are an envelope in dB on top of gainDb: linear in dB between keys, held before the
//   first and after the last (frames from the item's start).
// - Fades are linear in amplitude (ffmpeg afade's default "tri" curve): 0 at the item's start →
//   1 after fadeIn frames; 1 at fadeOut frames before its end → 0 at its end.
// - A main-track transition crossfades the sound too, linearly over the transition's frames
//   (centred on the cut, like the picture): the outgoing clip goes 1 → 0 while the incoming one
//   goes 0 → 1. The item's own fade on that side is skipped, as the picture skips its animation.
// - A muted track is silent (gain 0); if any track is soloed, only soloed tracks sound. A hidden
//   track only hides the picture: its clips still sound (mute is the sound's switch).
// - dB at or below SILENCE_DB is silence (the volume slider's "−∞").
import type { Item, Project, Track } from "./types.ts";

export const SILENCE_DB = -60;
export const MAX_DB = 12;

export const dbToGain = (db: number) => (db <= SILENCE_DB ? 0 : 10 ** (db / 20));
export const gainToDb = (gain: number) => (gain <= 0 ? -Infinity : 20 * Math.log10(gain));

const clamp01 = (p: number) => Math.min(1, Math.max(0, p));

export interface Audible {
  readonly item: Item;
  readonly track: Track;
  /** Linear amplitude factor (see the header); 0 while muted. */
  readonly gain: number;
  /** Where in the media, in seconds. */
  readonly source: number;
  /** The track is muted (or another is soloed): listed so playback can keep it warm, but silent. */
  readonly muted: boolean;
}

/** The gainKeys envelope in dB at `local` frames from the item's start. */
export function keyDbAt(keys: Item["gainKeys"], local: number): number {
  if (!keys?.length) return 0;
  const sorted = [...keys].sort((a, b) => a.frame - b.frame);
  if (local <= sorted[0]!.frame) return sorted[0]!.db;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (local <= b.frame) return b.frame === a.frame ? b.db : a.db + ((b.db - a.db) * (local - a.frame)) / (b.frame - a.frame);
  }
  return sorted.at(-1)!.db;
}

/** Fade in × fade out at `local` frames from the item's start (skipping a side a transition blends). */
export function fadeAt(item: Pick<Item, "duration" | "fadeIn" | "fadeOut">, local: number, { skipIn = false, skipOut = false } = {}): number {
  let g = 1;
  if (!skipIn && item.fadeIn && item.fadeIn > 0) g *= clamp01(local / item.fadeIn);
  if (!skipOut && item.fadeOut && item.fadeOut > 0) g *= clamp01((item.duration - local) / item.fadeOut);
  return g;
}

/** The item's media, if the item can make sound: an audio item, or a clip whose media has audio. */
export function soundMedia(project: Pick<Project, "media">, item: Item) {
  if (item.type !== "clip" && item.type !== "audio") return undefined;
  const media = item.media ? project.media.find((m) => m.id === item.media) : undefined;
  if (!media || media.kind === "image") return undefined;
  if (media.kind === "audio" || media.probe?.hasAudio) return media;
  return undefined;
}

/**
 * The frames an item sounds over: its own, plus half a transition on either side of a main-track
 * cut (the outgoing clip plays on into the incoming one, which starts early).
 */
export function audioSpan(track: Track, index: number, start: number): { from: number; to: number; half: number; nextHalf: number } {
  const item = track.items[index]!;
  const main = track.role === "main";
  const half = main && item.transitionIn ? item.transitionIn.duration / 2 : 0;
  const next = track.items[index + 1];
  const nextHalf = main && next?.transitionIn ? next.transitionIn.duration / 2 : 0;
  return { from: start - half, to: start + item.duration + nextHalf, half, nextHalf };
}

/** Where in its media an item is `local` frames after its start, in seconds (looped audio wraps). */
export function sourceAt(project: Pick<Project, "media" | "canvas">, item: Item, local: number): number {
  const fps = project.canvas.fps;
  let frames = (item.in ?? 0) + local * (item.speed ?? 1);
  const length = item.loop ? project.media.find((m) => m.id === item.media)?.probe?.frames : undefined;
  if (length && length > 0 && frames >= length) frames %= length;
  return frames / fps;
}

/** Whether a track sounds at all: not muted, and soloed if any track is. */
export function trackAudible(project: Pick<Project, "tracks">, track: Track): boolean {
  if (track.mixer?.mute) return false;
  return !project.tracks.some((t) => t.mixer?.solo) || track.mixer?.solo === true;
}

/** An item's gain at `local` frames from its start (see the header), before mute and solo. */
export function itemGain(track: Track, index: number, local: number): number {
  const item = track.items[index]!;
  const { half, nextHalf } = audioSpan(track, index, 0);
  const db = (item.gainDb ?? 0) + keyDbAt(item.gainKeys, Math.min(item.duration, Math.max(0, local))) + (track.mixer?.gainDb ?? 0);
  let gain = dbToGain(db) * fadeAt(item, local, { skipIn: half > 0, skipOut: nextHalf > 0 });
  if (half > 0 && local < half) gain *= clamp01((local + half) / (2 * half));
  if (nextHalf > 0 && local > item.duration - nextHalf) gain *= clamp01((item.duration + nextHalf - local) / (2 * nextHalf));
  return gain;
}

/** Everything that sounds at frame f, with its gain and source time, in track order. */
export function audibleAt(project: Pick<Project, "tracks" | "media" | "canvas">, starts: ReadonlyMap<string, number>, f: number): Array<Audible> {
  const out: Array<Audible> = [];
  for (const track of project.tracks) {
    const on = trackAudible(project, track);
    track.items.forEach((item, index) => {
      if (!soundMedia(project, item)) return;
      const start = starts.get(item.id) ?? 0;
      const { from, to } = audioSpan(track, index, start);
      if (f < from || f >= to) return;
      const local = f - start;
      out.push({ item, track, gain: on ? itemGain(track, index, local) : 0, source: sourceAt(project, item, local), muted: !on });
    });
  }
  return out;
}
