// The project as the renderer reads it, the timeline maths it borrows from @uncut/core (D39: the
// preview, export and agent share one implementation), and the edit ops the editor sends for
// "add to timeline". The ops go through project.edit, so the server validates them and they undo.
import { SOLID, textLook } from "@uncut/core/render";
import { componentInfo } from "@uncut/core/components";
import { layout } from "@uncut/core/timeline";

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

export type Planned = { readonly ops: ReadonlyArray<unknown>; readonly summary: string; readonly itemId: string; readonly start: number } | { readonly problem: string };

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
  const { starts } = layoutOf(project);
  const frames = media.probe?.frames;
  if (media.kind !== "image" && !frames) return { problem: `${media.name} has no known length, so it can't go on the timeline.` };
  if (media.kind === "audio") {
    const ops: Array<unknown> = [];
    let track = project.tracks.find((t) => t.kind === "audio" && t.role !== "main" && !t.locked);
    const taken = new Set<string>();
    if (!track) {
      const id = uniqueId(project, "audio", taken);
      taken.add(id);
      ops.push({ op: "add_track", track: { id, kind: "audio", name: "Audio" } });
      track = { id, kind: "audio", name: "Audio", items: [] };
    }
    const at = Math.max(0, Math.floor(frame));
    const free = track.items.every((i) => (starts.get(i.id) ?? 0) + i.duration <= at || at + frames! <= (starts.get(i.id) ?? 0));
    const start = free ? at : Math.max(0, ...track.items.map((i) => (starts.get(i.id) ?? 0) + i.duration));
    const itemId = uniqueId(project, "audio", taken);
    ops.push({ op: "insert_item", track: track.id, item: { id: itemId, type: "audio", media: media.id, in: 0, duration: frames, start } });
    return { ops, summary: `Add ${media.name} to the timeline`, itemId, start };
  }
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
 * The Text tab's presets: built-in text-style modules (spec/modules/builtin/text.*.json). Their
 * size, weight and position come from core TEXT_STYLES, the same looks the renderer falls back to.
 */
export const TEXT_PRESETS = [
  { id: "title", module: "text.title", label: "Title", text: "Title" },
  { id: "text", module: "text.header", label: "Text", text: "Text" },
  { id: "lower-third", module: "text.lower-third", label: "Lower third", text: "Lower third" },
] as const;
export type TextPreset = (typeof TEXT_PRESETS)[number];

const TEXT_SECONDS = 3;

/**
 * A text item at the playhead, 3 s long, on the top-most text track that is free for that whole
 * stretch. If none is, a new text track goes on top (above every other track). One edit either
 * way, so one undo removes it all.
 */
export function planAddText(project: ProjectModel, preset: TextPreset, frame: number): Planned {
  const { width, height, fps } = project.canvas;
  const start = Math.max(0, Math.floor(frame));
  const duration = TEXT_SECONDS * fps;
  const free = (t: Track) => t.items.every((i) => (i.start ?? 0) + i.duration <= start || start + duration <= (i.start ?? 0));
  const ops: Array<unknown> = [];
  const taken = new Set<string>();
  let track = displayTracks(project).find((t) => t.kind === "text" && !t.locked && free(t));
  if (!track) {
    const id = uniqueId(project, "text", taken);
    taken.add(id);
    const name = `Text ${project.tracks.filter((t) => t.kind === "text").length + 1}`;
    ops.push({ op: "add_track", index: 0, track: { id, kind: "text", name } });
    track = { id, kind: "text", name, items: [] };
  }
  const itemId = uniqueId(project, preset.id, taken);
  const look = textLook(preset.module);
  ops.push({
    op: "insert_item",
    track: track.id,
    item: {
      id: itemId,
      type: "text",
      start,
      duration,
      text: preset.text,
      transform: { x: Math.round(width * look.x), y: Math.round(height * look.y) },
      style: { preset: preset.module, size: Math.round(height * look.size), weight: look.weight },
    },
  });
  return { ops, summary: `Add ${preset.label.toLowerCase()}`, itemId, start };
}

/** A background's colours in words: "Background #0B1D3A", "Gradient #0B1D3A → #3B1E54". */
const colourName = (value: unknown) => (typeof value === "string" ? value : "default");
export const backgroundLabel = (item: Item) =>
  item.props?.to !== undefined ? `Gradient ${colourName(item.props?.color)} → ${colourName(item.props.to)}` : `Background ${colourName(item.props?.color)}`;

/** What a timeline item is called: its text, a background's colour, its media's name, or its id. */
export function itemLabel(project: ProjectModel, item: Item) {
  if (item.type === "text" && typeof item.text === "string") return item.text.replace(/\[\[|\]\]|\*\*|`/g, "").replace(/\n/g, " ");
  if (item.type === "component" && item.component === SOLID && !item.name) return backgroundLabel(item);
  // A component (D76): its name, and its title or first line when it has one.
  const component = item.type === "component" && !item.name ? componentInfo(item.component) : undefined;
  if (component) {
    const p = item.props ?? {};
    const words = [p.title, p.code, Array.isArray(p.lines) ? (p.lines[0] as { text?: unknown } | undefined)?.text : undefined, p.device].find((v): v is string => typeof v === "string" && v.trim() !== "");
    return words ? `${component.name} · ${words}` : component.name;
  }
  if (item.type === "graphic" && !item.name && item.src) return `Graphic · ${item.src.replace(/^graphics\//, "")}`;
  const media = item.media ? project.media.find((m) => m.id === item.media) : undefined;
  return item.name ?? media?.name ?? item.id;
}
