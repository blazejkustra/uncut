import { layout } from "../timeline.ts";
import type { Project, Id, Op } from "../types.ts";
import { takenIds, tryOps, uniqueIn } from "./place.ts";
import { locate, lockProblem } from "./retime.ts";

export interface ReplaceRange {
  /** The clip or audio item a piece of which is replaced. */
  readonly item: Id;
  /** Timeline frames [from, to): the piece, inside the item. */
  readonly from: number;
  readonly to: number;
  /** The media that plays there instead, from frame `in` of it (default 0). */
  readonly media: Id;
  readonly in?: number | undefined;
  /** The new piece's id when it's split off (default: the item's id, numbered); a piece from the item's start keeps the item's id. */
  readonly id?: string | undefined;
}

/**
 * Replace a fragment (issue #118, an overwrite edit): frames [from, to) of a clip or audio item play
 * another media instead (from its frame `in`, at normal speed), and nothing on the timeline moves:
 * the item is split at both ends of the piece (where they're inside it) and the piece gets the new
 * media and in point, keeping the item's look (box, effects, volume, keys). The piece is exactly as
 * long as before, so on Main every later clip, and every other track, stays in sync with the song.
 */
export function planReplaceRange(project: Project, r: ReplaceRange): { readonly ops: ReadonlyArray<Op>; readonly piece: Id; readonly summary: string } | { readonly problem: string } {
  const found = locate(project, r.item);
  if (!found) return { problem: `There's no item "${r.item}".` };
  const { track, item } = found;
  if (item.type !== "clip" && item.type !== "audio") return { problem: "Only a clip's or an audio item's piece can be replaced." };
  const locked = lockProblem(track, item);
  if (locked) return { problem: locked };
  const media = project.media.find((m) => m.id === r.media);
  if (!media) return { problem: `There's no media "${r.media}".` };
  if (item.type === "clip" && media.kind === "audio") return { problem: "A clip's piece needs a video or a picture, not a sound." };
  if (item.type === "audio" && media.kind === "image") return { problem: "A sound's piece needs a sound or a video with sound." };
  if (!Number.isInteger(r.from) || !Number.isInteger(r.to)) return { problem: "from and to are whole timeline frames." };
  const start = layout(project).starts.get(item.id) ?? 0;
  const end = start + item.duration;
  if (r.from < start || r.to > end || r.to <= r.from) return { problem: `The piece must be inside the item: frames ${start} to ${end}.` };
  const from = r.in ?? 0;
  if (!Number.isInteger(from) || from < 0) return { problem: "in is a whole frame of the media, from 0." };
  const length = r.to - r.from;
  const frames = media.probe?.frames;
  if (media.kind !== "image" && frames && from + length > frames) return { problem: `${media.name} is ${frames} frames long: from frame ${from} it can't fill ${length} frames. Start it at frame ${Math.max(0, frames - length)} or earlier.` };
  const taken = takenIds(project);
  if (r.id !== undefined && taken.has(r.id)) return { problem: `The id ${r.id} is taken.` };
  const ops: Array<Op> = [];
  let piece = item.id;
  if (r.from > start) {
    piece = r.id ?? uniqueIn(item.id, taken);
    ops.push({ op: "split_item", item: item.id, at: r.from - start, newId: piece });
  }
  if (r.to < end) ops.push({ op: "split_item", item: piece, at: length, newId: uniqueIn(item.id, taken) });
  ops.push({ op: "update_item", item: piece, set: { media: media.id, in: media.kind === "image" ? null : from, speed: null, keepPitch: null, loop: null, hold: null, name: null } });
  const tried = tryOps(project, ops);
  if ("problem" in tried) return tried;
  return { ops, piece, summary: `Replaced ${(length / project.canvas.fps).toFixed(1)} s with ${media.name}` };
}
