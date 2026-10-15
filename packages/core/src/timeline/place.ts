// Where a take recorded on this Mac goes on the timeline (D114), planned in the same edit as its
// add_media so one ⌘Z takes both out. Browser-safe.
//
// A voiceover goes on the first unlocked audio track called "Voiceover…" that is free at the
// playhead for the whole take, else on a new "Voiceover" track (never on a music track, never
// shifted after other items: it was recorded against that moment). A camera or screen take starts
// at the playhead on the nearest unlocked video track above the main track that is free for its
// whole length, else on a new "Recordings" track just above the main track. Nothing moves.
import { layout } from "./timeline.ts";
import type { Frame, Id, Op, Project, Track } from "./types.ts";

/** D210: "system" is this Mac's sound: an audio take on a "Mac sound" track, placed like a voiceover. */
export type TakePlacement = "voiceover" | "system" | "video";

export interface PlacedTake {
  readonly ops: ReadonlyArray<Op>;
  readonly itemId: Id;
  readonly trackId: Id;
  readonly start: Frame;
}

const AUDIO_TRACKS = {
  voiceover: { pattern: /^voiceover\b/i, base: "Voiceover", idBase: "voiceover" },
  system: { pattern: /^mac sound\b/i, base: "Mac sound", idBase: "mac-sound" },
} as const;

const unique = (base: string, taken: Set<string>) => {
  for (let n = 1; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
};

/**
 * The ops that put media `mediaId` (`frames` long; it may not be in `project` yet, its add_media
 * comes first in the same edit) on the timeline at `frame`. `taken` holds every id in use (media,
 * tracks, items, scenes) and gets the new ones.
 */
export function planPlaceTake(project: Pick<Project, "tracks">, input: { readonly mediaId: Id; readonly frames: number; readonly frame: Frame; readonly placement: TakePlacement }, taken: Set<string>): PlacedTake {
  const { starts } = layout(project);
  const start = Math.max(0, Math.floor(input.frame));
  const duration = Math.max(1, Math.floor(input.frames));
  const free = (t: Track) => t.items.every((i) => (starts.get(i.id) ?? 0) + i.duration <= start || start + duration <= (starts.get(i.id) ?? 0));
  const ops: Array<Op> = [];
  if (input.placement === "voiceover" || input.placement === "system") {
    const { pattern, base, idBase } = AUDIO_TRACKS[input.placement];
    let track = project.tracks.find((t) => t.kind === "audio" && t.role !== "main" && !t.locked && pattern.test(t.name) && free(t));
    if (!track) {
      const same = project.tracks.filter((t) => pattern.test(t.name)).length;
      const id = unique(idBase, taken);
      const name = same ? `${base} ${same + 1}` : base;
      ops.push({ op: "add_track", track: { id, kind: "audio", name } });
      track = { id, kind: "audio", name, items: [] };
    }
    const itemId = unique("audio", taken);
    ops.push({ op: "insert_item", track: track.id, item: { id: itemId, type: "audio", media: input.mediaId, in: 0, start, duration } });
    return { ops, itemId, trackId: track.id, start };
  }
  const mainIndex = project.tracks.findIndex((t) => t.role === "main");
  const above = project.tracks.slice(0, Math.max(0, mainIndex)).reverse();
  let track = above.find((t) => t.kind === "video" && !t.locked && free(t));
  if (!track) {
    const id = unique("recordings", taken);
    ops.push({ op: "add_track", track: { id, kind: "video", name: "Recordings" }, index: Math.max(0, mainIndex) });
    track = { id, kind: "video", name: "Recordings", items: [] };
  }
  const itemId = unique("clip", taken);
  ops.push({ op: "insert_item", track: track.id, item: { id: itemId, type: "clip", media: input.mediaId, in: 0, start, duration } });
  return { ops, itemId, trackId: track.id, start };
}

// ---- D211: a multi-source take (screen, camera, microphone, this Mac's sound) ----
//
// Every part goes on the timeline at the same frame, in one edit, grouped (D157: they move, trim
// and delete together; Ungroup lets them go). The recorders of a take start a few milliseconds
// apart: each part's `offsetMs` is when its recorder started after the first one's, so the earlier
// ones are trimmed at their head (`in`) by the difference and every part starts at the moment the
// last recorder started; all are as long as the shortest. The screen goes on the nearest free video
// track above Main (else a new "Screen" track just above Main), the camera on a free video track
// above the screen's (else a new "Camera" track just above it) with the layout's box, the
// microphone on a Voiceover track, this Mac's sound on a "Mac sound" track. Main isn't used here
// (a take lands over the edit); "Put on Main" (D215, arrange.ts planPutOnMain) moves its picture
// there afterwards with its parts linked under it.

export type MultiKind = "screen" | "camera" | "voiceover" | "system";
export type MultiLayoutName = "tl" | "tr" | "bl" | "br" | "side";
export const MULTI_LAYOUTS: ReadonlyArray<MultiLayoutName> = ["tl", "tr", "bl", "br", "side"];

export interface MultiPartIn {
  readonly mediaId: Id;
  readonly kind: MultiKind;
  readonly frames: number;
  readonly offsetMs: number;
}

export interface PlacedPart {
  readonly itemId: Id;
  readonly trackId: Id;
  readonly kind: MultiKind;
  readonly start: Frame;
  readonly in: Frame;
  readonly duration: Frame;
}

export interface PlacedMulti {
  readonly ops: ReadonlyArray<Op>;
  readonly items: ReadonlyArray<PlacedPart>;
  readonly group: Id | undefined;
}

/** A box in canvas pixels (D75's transform), `radius` for a round camera bubble. */
export interface LayoutBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fit: "contain" | "cover";
  readonly radius?: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Where the screen and the camera go on a `width`×`height` canvas: a corner bubble (a circle, 30%
 * of the canvas's shorter side, 4% from the edges; the screen keeps the whole frame) or side by
 * side (the screen on the left 64%, fitted; the camera filling the rest).
 */
export function multiLayoutBoxes(layout: MultiLayoutName, width: number, height: number): { readonly screen?: LayoutBox; readonly camera: LayoutBox } {
  if (layout === "side") {
    const sw = even(width * 0.64);
    return { screen: { x: 0, y: 0, w: sw, h: height, fit: "contain" }, camera: { x: sw, y: 0, w: width - sw, h: height, fit: "cover" } };
  }
  const short = Math.min(width, height);
  const size = even(short * 0.3);
  const margin = Math.round(short * 0.04);
  const x = layout === "tl" || layout === "bl" ? margin : width - margin - size;
  const y = layout === "tl" || layout === "tr" ? margin : height - margin - size;
  return { camera: { x, y, w: size, h: size, fit: "cover", radius: size / 2 } };
}

/** Frames each part is trimmed at its head so all start together (`fps` frames a second). */
export function alignParts(parts: ReadonlyArray<Pick<MultiPartIn, "offsetMs" | "frames">>, fps: number): { readonly ins: ReadonlyArray<number>; readonly duration: number } {
  const offsets = parts.map((p) => (Number.isFinite(p.offsetMs) ? Math.max(0, p.offsetMs) : 0));
  const last = Math.max(0, ...offsets);
  const ins = offsets.map((o) => Math.max(0, Math.round(((last - o) * fps) / 1000)));
  const duration = Math.max(1, Math.min(...parts.map((p, i) => Math.floor(p.frames) - ins[i]!)));
  return { ins, duration };
}

/**
 * The ops that put a multi-source take's media (added earlier in the same edit) on the timeline
 * at `frame`. `canvas` sizes the camera's box; `taken` holds every id in use and gets the new ones.
 */
export function planPlaceMulti(
  project: Pick<Project, "tracks">,
  input: { readonly parts: ReadonlyArray<MultiPartIn>; readonly frame: Frame; readonly fps: number; readonly canvas: { readonly width: number; readonly height: number }; readonly layout?: MultiLayoutName | undefined },
  taken: Set<string>,
): PlacedMulti {
  const parts = input.parts.filter((p) => p.frames > 0);
  if (!parts.length) return { ops: [], items: [], group: undefined };
  const { starts } = layout(project);
  const start = Math.max(0, Math.floor(input.frame));
  const { ins, duration } = alignParts(parts, input.fps);
  const free = (t: Pick<Track, "items">) => t.items.every((i) => (starts.get(i.id) ?? 0) + i.duration <= start || start + duration <= (starts.get(i.id) ?? 0));
  const ops: Array<Op> = [];
  // The track order as the ops leave it (index 0 is the top), with which tracks are new.
  const order: Array<{ id: Id; track?: Track }> = project.tracks.map((t) => ({ id: t.id, track: t }));
  const used = new Set<Id>();
  const group = parts.length > 1 ? unique("take", taken) : undefined;
  const items: Array<PlacedPart & { readonly index: number }> = [];
  const boxes = multiLayoutBoxes(input.layout ?? "br", input.canvas.width, input.canvas.height);
  const hasScreen = parts.some((p) => p.kind === "screen");

  /** A video track at or above index `below - 1` (nearest first) that is free; else a new one at `below`. */
  const videoTrack = (below: number, name: string, idBase: string): Id => {
    for (let i = below - 1; i >= 0; i--) {
      const t = order[i]!.track;
      if (t && t.kind === "video" && t.role !== "main" && !t.locked && !used.has(t.id) && free(t)) return t.id;
    }
    const id = unique(idBase, taken);
    // "Screen", then "Screen 2" when the project has one already.
    const same = project.tracks.filter((t) => new RegExp(`^${name}\\b`, "i").test(t.name)).length;
    const label = same ? `${name} ${same + 1}` : name;
    ops.push({ op: "add_track", track: { id, kind: "video", name: label }, index: below });
    order.splice(below, 0, { id });
    return id;
  };
  const audioTrack = (placement: "voiceover" | "system"): Id => {
    const { pattern, base, idBase } = AUDIO_TRACKS[placement];
    const found = project.tracks.find((t) => t.kind === "audio" && t.role !== "main" && !t.locked && !used.has(t.id) && pattern.test(t.name) && free(t));
    if (found) return found.id;
    const same = project.tracks.filter((t) => pattern.test(t.name)).length + order.filter((o) => !o.track && o.id.startsWith(`${idBase}-`)).length;
    const id = unique(idBase, taken);
    const name = same ? `${base} ${same + 1}` : base;
    ops.push({ op: "add_track", track: { id, kind: "audio", name } });
    order.push({ id });
    return id;
  };
  const put = (part: MultiPartIn, index: number, trackId: Id, extra: Record<string, unknown>) => {
    used.add(trackId);
    const audio = part.kind === "voiceover" || part.kind === "system";
    const itemId = unique(audio ? "audio" : "clip", taken);
    ops.push({ op: "insert_item", track: trackId, item: { id: itemId, type: audio ? "audio" : "clip", media: part.mediaId, in: ins[index]!, start, duration, ...(group ? { group } : {}), ...extra } as never });
    items.push({ index, itemId, trackId, kind: part.kind, start, in: ins[index]!, duration });
  };
  const mainIndex = () => Math.max(0, order.findIndex((o) => o.track?.role === "main"));
  const box = (b: LayoutBox) => ({ transform: { x: b.x, y: b.y, w: b.w, h: b.h, fit: b.fit, ...(b.radius ? { radius: b.radius } : {}) } });
  let screenTrack: Id | undefined;
  // The screen first (its track decides where the camera goes), then the camera, then the sound.
  const ordered = [...parts.entries()].sort(([, a], [, b]) => RANK[a.kind] - RANK[b.kind]);
  for (const [index, part] of ordered) {
    if (part.kind === "screen") {
      screenTrack = videoTrack(mainIndex(), "Screen", "screen");
      put(part, index, screenTrack, boxes.screen ? box(boxes.screen) : {});
    } else if (part.kind === "camera") {
      const below = screenTrack ? order.findIndex((o) => o.id === screenTrack) : mainIndex();
      const trackId = videoTrack(below, "Camera", "camera");
      put(part, index, trackId, hasScreen ? box(boxes.camera) : {});
    } else put(part, index, audioTrack(part.kind), {});
  }
  // Items in the parts' own order.
  return { ops, items: items.sort((a, b) => a.index - b.index).map(({ index: _, ...item }) => item), group };
}

const RANK: Record<MultiKind, number> = { screen: 0, camera: 1, voiceover: 2, system: 3 };
