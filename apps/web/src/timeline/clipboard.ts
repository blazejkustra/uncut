// Editor shortcuts' planners (G3, D118): edit points for ↑/↓, deleting several items, and the
// in-app clipboard (⌘C/⌘X/⌘V, ⌘D). Pure: they turn the project and a gesture into edit ops the
// server validates, like edit.ts.
import type { Op } from "@uncut/core/types";
import { keepMainTimes } from "@uncut/core/arrange";

import { layoutOf, uniqueId, type Item, type ProjectModel, type Track } from "../state/project.ts";
import { findItem, fitsTrack, homeKind, lockOf, type Plan } from "./edit.ts";

/** Every frame where something starts or ends (0 included), sorted: where ↑/↓ jump. */
export function editPoints(project: ProjectModel): Array<number> {
  const { starts } = layoutOf(project);
  const points = new Set<number>([0]);
  for (const t of project.tracks)
    for (const i of t.items) {
      if (i.type === "captions") continue;
      const s = starts.get(i.id) ?? 0;
      points.add(s);
      points.add(s + i.duration);
    }
  return [...points].sort((a, b) => a - b);
}

/** The edit point before (-1) or after (1) `frame`; undefined at the ends. */
export function nextEditPoint(project: ProjectModel, frame: number, direction: 1 | -1): number | undefined {
  const points = editPoints(project);
  const f = Math.round(frame);
  return direction > 0 ? points.find((p) => p > f) : points.findLast((p) => p < f);
}

/** Delete several items in one edit (D224: they leave their space, on main too; a transition into a clip that now follows a gap goes). */
export function planDeleteMany(project: ProjectModel, ids: ReadonlyArray<string>): Plan | { readonly problem: string } {
  const placed = [...new Set(ids)].map((id) => findItem(project, id)).filter((p) => p !== undefined);
  if (!placed.length) return { problem: "Select an item to delete it." };
  for (const p of placed) {
    const locked = lockOf(p);
    if (locked) return { problem: locked };
  }
  const gone = new Set(placed.map((p) => p.item.id));
  const ops: Array<Op> = [];
  for (const p of placed) {
    if (p.track.role !== "main") continue;
    // The next clip that stays now follows a gap (or another clip): its transition goes.
    const next = p.track.items.slice(p.index + 1).find((i) => !gone.has(i.id));
    if (next?.transitionIn && !ops.some((o) => o.op === "set_transition" && o.item === next.id)) ops.push({ op: "set_transition", item: next.id, transition: null });
  }
  for (const p of placed) ops.push({ op: "delete_item", item: p.item.id });
  const main = project.tracks.find((t) => t.role === "main");
  if (main && placed.some((p) => p.track.id === main.id)) ops.push(...keepMainTimes(main, gone));
  return { ops, summary: placed.length === 1 ? `Delete ${placed[0]!.item.id}` : `Delete ${placed.length} items` };
}

/** What ⌘C keeps: the items (as they were), their tracks and where they started relative to the first. */
export interface Clip {
  readonly item: Item;
  readonly track: string;
  readonly kind: Track["kind"];
  readonly main: boolean;
  readonly offset: number;
}

export function copyItems(project: ProjectModel, ids: ReadonlyArray<string>): Array<Clip> {
  const placed = [...new Set(ids)].map((id) => findItem(project, id)).filter((p) => p !== undefined && p.item.type !== "captions");
  if (!placed.length) return [];
  const first = Math.min(...placed.map((p) => p!.start));
  return placed
    .sort((a, b) => a!.start - b!.start)
    .map((p) => ({ item: structuredClone(p!.item) as Item, track: p!.track.id, kind: p!.track.role === "main" ? homeKind(p!.item) : p!.track.kind, main: p!.track.role === "main", offset: p!.start - first }));
}

const NEW_TRACK_NAMES: Readonly<Record<Track["kind"], string>> = { video: "Video", text: "Text", audio: "Audio" };

/**
 * Paste clips at `frame` (⌘V) in one edit. Each goes on its own track when that is still there,
 * unlocked and free for its whole length, else on another track of the kind that is, else on a
 * new track (video above the main track, text on top, audio at the bottom). A main-track clip is
 * inserted on the main track after the clip under the playhead (the rest moves along). New ids;
 * transitions aren't copied (the cut they sat on isn't there).
 */
export function planPaste(project: ProjectModel, clips: ReadonlyArray<Clip>, frame: number): (Plan & { readonly ids: ReadonlyArray<string> }) | { readonly problem: string } {
  if (!clips.length) return { problem: "Copy an item first (⌘C)." };
  const { starts } = layoutOf(project);
  const at = Math.max(0, Math.round(frame));
  const taken = new Set<string>();
  const ops: Array<Op> = [];
  const ids: Array<string> = [];
  // Spans claimed on each track by this paste, so two pasted items don't land on each other.
  const claimed = new Map<string, Array<readonly [number, number]>>();
  const free = (t: Track, from: number, to: number) =>
    t.items.every((i) => (starts.get(i.id) ?? 0) + i.duration <= from || to <= (starts.get(i.id) ?? 0)) && (claimed.get(t.id) ?? []).every(([a, b]) => b <= from || to <= a);
  const tracks: Array<Track> = [...project.tracks];
  const main = project.tracks.find((t) => t.role === "main");
  let mainIndex = main ? main.items.filter((i) => (starts.get(i.id) ?? 0) < at).length : 0;
  // D157: pasted groups are new groups (the copies don't join the originals').
  const groups = new Map<string, string>();
  for (const clip of clips) {
    const id = uniqueId(project, clip.item.id.replace(/-\d+$/, "") || "item", taken);
    taken.add(id);
    ids.push(id);
    const { transitionIn: _t, start: _s, group: oldGroup, ...rest } = clip.item as Item & { start?: number };
    if (oldGroup && !groups.has(oldGroup)) groups.set(oldGroup, `group-${id}`);
    const item = { ...rest, id, ...(oldGroup ? { group: groups.get(oldGroup)! } : {}) } as Item;
    if (clip.main && main && !main.locked && fitsTrack(item, main)) {
      ops.push({ op: "insert_item", track: main.id, index: mainIndex++, item });
      continue;
    }
    const from = at + clip.offset;
    const to = from + item.duration;
    const own = tracks.find((t) => t.id === clip.track && t.role !== "main");
    const usable = (t: Track) => t.role !== "main" && !t.locked && fitsTrack(item, t) && free(t, from, to);
    let track = own && usable(own) ? own : tracks.find(usable);
    if (!track) {
      const tid = uniqueId(project, clip.kind, taken);
      taken.add(tid);
      const count = tracks.filter((t) => t.kind === clip.kind).length;
      const name = `${NEW_TRACK_NAMES[clip.kind]} ${count + 1}`;
      const mainAt = tracks.findIndex((t) => t.role === "main");
      const index = clip.kind === "text" ? 0 : clip.kind === "video" ? Math.max(0, mainAt) : tracks.length;
      ops.push({ op: "add_track", track: { id: tid, kind: clip.kind, name }, index });
      track = { id: tid, kind: clip.kind, name, items: [] } as unknown as Track;
      tracks.splice(index, 0, track);
    }
    claimed.set(track.id, [...(claimed.get(track.id) ?? []), [from, to]]);
    ops.push({ op: "insert_item", track: track.id, item: { ...item, start: from } as Item });
  }
  return { ops, summary: ids.length === 1 ? `Paste ${ids[0]}` : `Paste ${ids.length} items`, ids };
}
