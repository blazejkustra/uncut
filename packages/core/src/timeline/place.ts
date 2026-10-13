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

export type TakePlacement = "voiceover" | "video";

export interface PlacedTake {
  readonly ops: ReadonlyArray<Op>;
  readonly itemId: Id;
  readonly trackId: Id;
  readonly start: Frame;
}

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
  if (input.placement === "voiceover") {
    let track = project.tracks.find((t) => t.kind === "audio" && t.role !== "main" && !t.locked && /^voiceover\b/i.test(t.name) && free(t));
    if (!track) {
      const voiceovers = project.tracks.filter((t) => /^voiceover\b/i.test(t.name)).length;
      const id = unique("voiceover", taken);
      const name = voiceovers ? `Voiceover ${voiceovers + 1}` : "Voiceover";
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
