// The project as the renderer reads it, the timeline maths it borrows from @uncut/core (D39: the
// preview, export and agent share one implementation), and the edit ops the editor sends for
// "add to timeline". The ops go through project.edit, so the server validates them and they undo.
import { SOLID } from "@uncut/core/render";
import { TEXT_STYLES, type TextPreset } from "@uncut/core/looks";
import { planInsertText } from "@uncut/core/textPlan";
import { componentInfo } from "@uncut/core/components";
import { layout } from "@uncut/core/timeline";
import { mediaIdFor, musicInProject, musicMedia, projectIds, type MusicTrack } from "@uncut/core/music";
import { libraryMediaOf } from "@uncut/core/library";
import { planPlaceMedia, takenIds } from "@uncut/core/arrange";

import type { Item, Media, Project, Track } from "@uncut/core/types";

// The format types come from @uncut/core (spec/schema). Only type imports from the package root
// would pull node:fs into the renderer, so these use the browser-safe subpaths.
export type { Item, Track };
export type MediaItem = Media;
export type ProjectModel = Project;

export interface Layout {
  readonly starts: Map<string, number>;
  /** Where the last item ends, in frames; 0 for an empty project. */
  readonly end: number;
  /** Frames playback runs over: [0, frames - 1]. At least 1, so an empty project has frame 0. (The playhead can also rest at `end`.) */
  readonly frames: number;
}

// Snapshots are immutable, so the layout of one project object never changes.
const layouts = new WeakMap<ProjectModel, Layout>();
export function layoutOf(project: ProjectModel): Layout {
  let l = layouts.get(project);
  if (!l) {
    const { starts, duration } = layout(project);
    const end = project.tracks.some((t) => t.items.length) ? duration : 0;
    l = { starts, end, frames: Math.max(1, end) };
    layouts.set(project, l);
  }
  return l;
}

/**
 * Tracks top to bottom as the timeline shows them (D28, CapCut order): the visual tracks in
 * project order, which is also how the preview stacks them (core visualsAt draws the first track
 * on top), then audio. New overlay and text tracks go in front of Main, so they sit above it.
 */
export const displayTracks = (project: ProjectModel) => [
  ...project.tracks.filter((t) => t.kind !== "audio"),
  ...project.tracks.filter((t) => t.kind === "audio"),
];

/** An id no media, track, item or scene uses yet: "clip-1", "clip-2", … */
export function uniqueId(project: ProjectModel, base: string, taken = new Set<string>()) {
  const ids = new Set([
    ...taken,
    ...project.media.map((m) => m.id),
    ...project.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)]),
    ...(project.scenes ?? []).map((s) => s.id),
  ]);
  for (let n = 1; ; n++) if (!ids.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** `show`: where the playhead goes after the add (default `start`), e.g. past a text's in-move so it's on screen (F20). */
export type Planned = { readonly ops: ReadonlyArray<unknown>; readonly summary: string; readonly itemId: string; readonly start: number; readonly show?: number } | { readonly problem: string };

const IMAGE_SECONDS = 5;

/**
 * "Add to timeline" for a library tile. Video and images are appended to the end of the magnetic
 * main track (D17: no gaps, nothing shifts); audio goes on the first unlocked audio track (one is
 * created if there is none) at the playhead if the track is free there for the sound's whole
 * length, else after its last item (D54).
 */
export function planAddMedia(project: ProjectModel, mediaId: string, frame = 0): Planned {
  const media = project.media.find((m) => m.id === mediaId);
  if (!media) return { problem: "That media isn't in the project any more." };
  const fps = project.canvas.fps;
  const frames = media.probe?.frames;
  if (media.kind !== "image" && !frames) return { problem: `${media.name} has no known length, so it can't go on the timeline.` };
  if (media.kind === "audio") return planAudio(project, media, frames!, frame);
  const main = project.tracks.find((t) => t.role === "main");
  if (!main) return { problem: "This project has no main track." };
  if (main.locked) return { problem: "The main track is locked. Unlock it to add clips." };
  const mainEnd = main.items.reduce((n, i) => n + i.duration, 0);
  const itemId = uniqueId(project, "clip");
  const duration = media.kind === "image" ? IMAGE_SECONDS * fps : frames!;
  return {
    ops: [{ op: "insert_item", track: main.id, item: { id: itemId, type: "clip", media: media.id, in: 0, duration } }],
    summary: `Add ${media.name} to the timeline`,
    itemId,
    start: mainEnd,
  };
}

/**
 * "Add at playhead" for a generated result (D99): a sound goes where "Add to timeline" puts it (the
 * playhead on the first free audio track); a picture (5 s) or a video starts at the playhead on the
 * nearest video track above the main track that is free for its whole length, else on a new
 * "Generated" track just above the main track. Nothing on the main track moves.
 */
export function planAddAtPlayhead(project: ProjectModel, mediaId: string, frame: number): Planned {
  const media = project.media.find((m) => m.id === mediaId);
  if (!media) return { problem: "That media isn't in the project any more." };
  const fps = project.canvas.fps;
  const frames = media.probe?.frames;
  if (media.kind !== "image" && !frames) return { problem: `${media.name} has no known length, so it can't go on the timeline.` };
  if (media.kind === "audio") return planAudio(project, media, frames!, frame);
  const { starts } = layoutOf(project);
  const start = Math.max(0, Math.floor(frame));
  const duration = media.kind === "image" ? IMAGE_SECONDS * fps : frames!;
  const mainIndex = project.tracks.findIndex((t) => t.role === "main");
  const above = project.tracks.slice(0, Math.max(0, mainIndex)).reverse();
  const free = (t: Track) => t.items.every((i) => (starts.get(i.id) ?? 0) + i.duration <= start || start + duration <= (starts.get(i.id) ?? 0));
  const ops: Array<unknown> = [];
  const taken = new Set<string>();
  let track = above.find((t) => t.kind === "video" && !t.locked && free(t));
  if (!track) {
    const id = uniqueId(project, "generated", taken);
    taken.add(id);
    ops.push({ op: "add_track", track: { id, kind: "video", name: "Generated" }, index: Math.max(0, mainIndex) });
    track = { id, kind: "video", name: "Generated", items: [] };
  }
  const itemId = uniqueId(project, "clip", taken);
  ops.push({ op: "insert_item", track: track.id, item: { id: itemId, type: "clip", media: media.id, in: 0, start, duration } });
  return { ops, summary: `Add ${media.name} at the playhead`, itemId, start };
}

/**
 * An audio item for `media` (D124): at the playhead on the first unlocked audio track that is free
 * there for the whole sound, else on a new "Audio N" track, so music, effects and voice overlap.
 */
function planAudio(project: ProjectModel, media: Media, _length: number, frame: number): Planned {
  return planDropMedia(project, media.id, { frame });
}

/**
 * Media dropped on the timeline (D122): at the drop frame on the lane it's over when that lane takes
 * it (main: the slot nearest the drop; a free track: the nearest free spot; a video file on an audio
 * lane: its sound), else where core planPlaceMedia puts it. One edit.
 */
export function planDropMedia(project: ProjectModel, mediaId: string, at: { readonly frame: number; readonly track?: string | undefined }): Planned {
  const media = project.media.find((m) => m.id === mediaId);
  if (!media) return { problem: "That media isn't in the project any more." };
  const plan = planPlaceMedia(project, [media], at, takenIds(project));
  if ("problem" in plan) return plan;
  const first = plan.placed[0]!;
  return { ops: plan.ops, summary: `Add ${media.name} to the timeline`, itemId: first.itemId, start: first.start };
}

/** Music shorter than this before the video ends isn't worth adding (D91). */
const MIN_MUSIC_SECONDS = 3;

/**
 * A library track (D91) on the timeline, in one edit: its add_media (when it isn't in the project
 * yet; `path` is where music.add copied it) and the audio item at the playhead. It plays from the
 * playhead to the video's end at most (the whole track on an empty timeline); under 3 s left is a
 * problem, not a blip. It goes on the first unlocked audio track that is free for that stretch,
 * else on a new "Music" track (never after a voiceover, never longer than the video), and fades in
 * over 1 s and out over 2 s.
 */
export function planAddMusic(project: ProjectModel, track: MusicTrack, path: string | undefined, frame: number): Planned {
  const fps = project.canvas.fps;
  const existing = musicInProject(project, track);
  const ops: Array<unknown> = [];
  const taken = new Set<string>();
  let media = existing;
  if (!media) {
    if (!path) return { problem: `${track.title} isn't copied into the project yet.` };
    media = musicMedia(track, path, fps, projectIds(project));
    taken.add(media.id);
    ops.push({ op: "add_media", media });
  }
  const frames = media.probe?.frames ?? Math.floor(track.seconds * fps);
  const { starts, end } = layoutOf(project);
  const start = Math.max(0, Math.floor(frame));
  let duration = frames;
  if (end > 0) {
    duration = Math.min(frames, end - start);
    if (duration < MIN_MUSIC_SECONDS * fps) {
      return { problem: start >= end ? "The playhead is at the end of the video. Move it to where the music should start, then add it." : `Only ${((end - start) / fps).toFixed(1)} s of the video are left after the playhead. Move it earlier to add music there.` };
    }
  }
  const freeOn = (t: Track) => t.items.every((i) => (starts.get(i.id) ?? 0) + i.duration <= start || start + duration <= (starts.get(i.id) ?? 0));
  let target = project.tracks.find((t) => t.kind === "audio" && t.role !== "main" && !t.locked && freeOn(t));
  if (!target) {
    const id = uniqueId(project, "music", taken);
    taken.add(id);
    // Audio tracks show under the rest whatever their index; at the end it's the bottom one.
    ops.push({ op: "add_track", track: { id, kind: "audio", name: "Music" } });
    target = { id, kind: "audio", name: "Music", items: [] };
  }
  const fadeIn = Math.min(fps, Math.floor(duration / 4));
  const fadeOut = Math.min(2 * fps, Math.floor(duration / 4));
  const itemId = uniqueId(project, "audio", taken);
  ops.push({ op: "insert_item", track: target.id, item: { id: itemId, type: "audio", media: media.id, in: 0, duration, start, ...(fadeIn > 0 ? { fadeIn } : {}), ...(fadeOut > 0 ? { fadeOut } : {}) } });
  return { ops, summary: `Add ${track.title} from the music library`, itemId, start };
}

/** What library.add answered, plus what the add is (music: fades, at most to the video's end; a sound effect: whole, as it is). */
export interface LibrarySound {
  readonly libraryId: string;
  readonly name: string;
  /** Where library.add put it (media/…), when it isn't in the project yet. */
  readonly path?: string | undefined;
  readonly seconds: number;
  readonly source?: Readonly<Record<string, unknown>> | undefined;
  readonly music: boolean;
}

/**
 * A sound from the library (D134) on the timeline, in one edit: its add_media with its credits in
 * `source` (unless the same library sound is in the project already) and an audio item at the
 * playhead on the first unlocked audio track free for its stretch, else a new track (D124: sounds
 * overlap on tracks of their own). Music plays from the playhead to the video's end at most, with
 * fades, like the bundled tracks (planAddMusic); a sound effect goes in whole, without fades.
 */
export function planAddLibrarySound(project: ProjectModel, sound: LibrarySound, frame: number): Planned {
  const fps = project.canvas.fps;
  const ops: Array<unknown> = [];
  const taken = new Set<string>();
  let media: Media | undefined = libraryMediaOf(project, sound.libraryId);
  if (!media) {
    if (!sound.path) return { problem: `${sound.name} isn't in the project yet.` };
    media = { id: mediaIdFor(sound.name, projectIds(project)), kind: "audio", name: sound.name, path: sound.path, ...(sound.source ? { source: sound.source as Media["source"] } : {}), probe: { frames: Math.max(1, Math.floor(sound.seconds * fps)), hasAudio: true } };
    taken.add(media.id);
    ops.push({ op: "add_media", media });
  }
  const frames = media.probe?.frames ?? Math.max(1, Math.floor(sound.seconds * fps));
  const { starts, end } = layoutOf(project);
  const start = Math.max(0, Math.floor(frame));
  let duration = frames;
  if (sound.music && end > 0) {
    duration = Math.min(frames, end - start);
    if (duration < MIN_MUSIC_SECONDS * fps) {
      return { problem: start >= end ? "The playhead is at the end of the video. Move it to where the music should start, then add it." : `Only ${((end - start) / fps).toFixed(1)} s of the video are left after the playhead. Move it earlier to add music there.` };
    }
  }
  const freeOn = (t: Track) => t.items.every((i) => (starts.get(i.id) ?? 0) + i.duration <= start || start + duration <= (starts.get(i.id) ?? 0));
  let target = project.tracks.find((t) => t.kind === "audio" && t.role !== "main" && !t.locked && freeOn(t));
  if (!target) {
    const name = sound.music ? "Music" : "Sound effects";
    const id = uniqueId(project, sound.music ? "music" : "sfx", taken);
    taken.add(id);
    ops.push({ op: "add_track", track: { id, kind: "audio", name } });
    target = { id, kind: "audio", name, items: [] };
  }
  const fadeIn = sound.music ? Math.min(fps, Math.floor(duration / 4)) : 0;
  const fadeOut = sound.music ? Math.min(2 * fps, Math.floor(duration / 4)) : 0;
  const itemId = uniqueId(project, sound.music ? "audio" : "sound", taken);
  ops.push({ op: "insert_item", track: target.id, item: { id: itemId, type: "audio", media: media.id, in: 0, duration, start, ...(fadeIn > 0 ? { fadeIn } : {}), ...(fadeOut > 0 ? { fadeOut } : {}) } });
  return { ops, summary: `Add ${sound.name} from the ${sound.music ? "music" : "sound"} library`, itemId, start };
}

/**
 * The Text tab's presets (D80): core TEXT_PRESETS, built-in text-style looks from their manifests
 * (the three from before first, same ids), the same looks the renderer falls back to.
 */
export { TEXT_PRESETS } from "@uncut/core/looks";
export type { TextPreset } from "@uncut/core/looks";

const TEXT_SECONDS = 3;

/**
 * A text item in a preset's look at the playhead, 3 s long, on the top-most text track that is
 * free for that whole stretch (core planInsertText; the looks it comes with on the next free
 * ones). If none is, a new text track goes on top (above every other track). One edit either
 * way, so one undo removes it all.
 */
export function planAddText(project: ProjectModel, preset: TextPreset, frame: number, at?: { readonly x: number; readonly y: number }): Planned {
  const start = Math.max(0, Math.floor(frame));
  const duration = TEXT_SECONDS * project.canvas.fps;
  // Dropped on the canvas: its first line centred on the drop point's height; a look that spans
  // the safe area keeps its x and width, others start at the drop point.
  const look = TEXT_STYLES[preset.module] ?? preset.look;
  const y = at && look ? Math.round(at.y - (project.canvas.height * look.size * look.lineHeight) / 2) : undefined;
  const transform = at && look ? (look.span ? { y: y! } : { x: Math.round(at.x), y: y! }) : undefined;
  const plan = planInsertText(project, { look: preset.module, text: preset.text, start, duration, idBase: preset.look ? preset.id.split(".").at(-1)! : preset.id, ...(transform ? { transform } : {}) }, preset.look ? { [preset.module]: preset.look } : {});
  if ("problem" in plan) return plan;
  // F20 (D158): the playhead goes where the new text is fully on screen (after its in-move).
  const added = plan.ops.find((o) => o.op === "insert_item" && o.item.id === plan.itemId) as { item: Item } | undefined;
  const settle = Math.min(duration - 1, added?.item.animation?.in?.duration ?? 0);
  return { ops: plan.ops, summary: `Add ${preset.label.toLowerCase()}`, itemId: plan.itemId, start, ...(settle > 0 ? { show: start + settle } : {}) };
}

/** A background's colours in words: "Background #0B1D3A", "Gradient #0B1D3A → #3B1E54". */
const colourName = (value: unknown) => (typeof value === "string" ? value : "default");
export const backgroundLabel = (item: Item) =>
  item.props?.to !== undefined ? `${item.props?.gradient === "radial" ? "Radial gradient" : "Gradient"} ${colourName(item.props?.color)} → ${colourName(item.props.to)}` : `Background ${colourName(item.props?.color)}`;

/** What a timeline item is called: its text, a background's colour, its media's name, or its id. */
export function itemLabel(project: ProjectModel, item: Item) {
  if (item.type === "text" && typeof item.text === "string") return item.text.replace(/\[\[|\]\]|\*\*|`/g, "").replace(/\n/g, " ");
  if (item.type === "component" && item.component === SOLID && !item.name) return backgroundLabel(item);
  // A component (D76): its name, and its title or first line when it has one.
  const component = item.type === "component" && !item.name ? componentInfo(item.component) : undefined;
  if (component) {
    const p = item.props ?? {};
    const words = [p.title, p.code, Array.isArray(p.lines) ? (p.lines[0] as { text?: unknown } | undefined)?.text : undefined, p.device].find((v): v is string => typeof v === "string" && v.trim() !== "");
    return words ? `${component.name}: ${words}` : component.name;
  }
  if (item.type === "graphic" && !item.name && item.src) return `Graphic: ${item.src.replace(/^graphics\//, "")}`;
  if (item.type === "captions" && !item.name) {
    const source = project.media.find((m) => m.id === item.source);
    return source ? `Captions of ${source.name}` : "Captions";
  }
  const media = item.media ? project.media.find((m) => m.id === item.media) : undefined;
  return item.name ?? media?.name ?? item.id;
}
