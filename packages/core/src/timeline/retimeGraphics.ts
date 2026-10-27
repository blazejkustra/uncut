// C6: a ripple cut takes the same stretch out of a graphic that spans it. A graphic drawn over the
// film (a panel whose render(t) times its beats to the speech) keeps absolute times, so when
// footage before a beat is cut the beat would come late. When an edit only removes frames from the
// main track (trims, deletes, cuts inside clips, closed gaps: what is left keeps its order and moves
// earlier), every unlocked graphic off Main that overlaps a removed stretch loses that stretch too:
// it starts earlier by what was cut before it, gets shorter by what was cut inside it, its own
// time skips the cut (`skips`, read by graphicLocal) and its box keys after the cut move with it.
// Any other edit (an insert, a reorder, a slip, a speed change) leaves graphics alone.
import { graphicTime } from "../visual/graphics.ts";
import { applyEdit, createSession, keysWithoutSpan } from "./apply-ops.ts";
import { layout } from "./timeline.ts";
import type { Id, Item, Op, Project, Track } from "./types.ts";

/** Frames [at, at + frames) of the timeline before the edit that the edit removed. */
export interface RippleSpan {
  readonly at: number;
  readonly frames: number;
}

/** A graphic a cut re-timed: how many frames of its time went, at how many cuts, and its first cut (frames after the edit). */
export interface GraphicRetime {
  readonly id: Id;
  readonly src: string;
  readonly frames: number;
  readonly cuts: number;
  readonly at: number;
}

interface Segment {
  readonly from: number;
  readonly to: number;
  readonly shift: number;
}

const mainOf = (project: Project) => project.tracks.find((t) => t.role === "main");

function playsSource(project: Project, item: Item) {
  if (item.type === "graphic") return true;
  if (!item.media) return item.in !== undefined;
  return project.media.find((m) => m.id === item.media)?.kind !== "image";
}

/** Old frames of `old` that `now` shows, if `now` is a piece of it (same source, same speed, inside its range). */
function pieceOf(project: Project, old: Item, oldStart: number, now: Item, nowStart: number): Segment | undefined {
  if (old.type !== now.type || old.media !== now.media || (old.speed ?? 1) !== (now.speed ?? 1)) return undefined;
  if (!playsSource(project, now))
    return old.id === now.id && old.duration === now.duration ? { from: oldStart, to: oldStart + old.duration, shift: oldStart - nowStart } : undefined;
  const offset = Math.round(((now.in ?? 0) - (old.in ?? 0)) / (now.speed ?? 1));
  if (offset < 0 || offset + now.duration > old.duration) return undefined;
  return { from: oldStart + offset, to: oldStart + offset + now.duration, shift: oldStart + offset - nowStart };
}

/**
 * What an edit cut out of the main track, as stretches of the old timeline, when it only removed
 * frames (what is left keeps its order and moves earlier); undefined for any other edit. Where the
 * stretch between two kept pieces is longer than what went (a main item without source time whose
 * length changed, a gap that stayed), the frames that went are counted at its end.
 */
export function rippleSpans(before: Project, after: Project): Array<RippleSpan> | undefined {
  const oldMain = mainOf(before);
  const newMain = mainOf(after);
  if (!oldMain || !newMain) return undefined;
  const oldStarts = layout(before).starts;
  const newStarts = layout(after).starts;
  const segments: Array<Segment> = [];
  for (const now of newMain.items) {
    const nowStart = newStarts.get(now.id)!;
    const same = oldMain.items.find((o) => o.id === now.id);
    const candidates = same ? [same] : oldMain.items.filter((o) => playsSource(after, now) && o.media === now.media);
    const segment = candidates.map((o) => pieceOf(after, o, oldStarts.get(o.id)!, now, nowStart)).find(Boolean);
    if (segment) segments.push(segment);
    else if (!same || playsSource(after, now)) return undefined;
  }
  const end = (track: Track, starts: ReadonlyMap<Id, number>) => (track.items.length ? starts.get(track.items.at(-1)!.id)! + track.items.at(-1)!.duration : 0);
  const oldEnd = end(oldMain, oldStarts);
  segments.sort((a, b) => a.from - b.from);
  segments.push({ from: oldEnd, to: oldEnd, shift: oldEnd - end(newMain, newStarts) });
  const spans: Array<RippleSpan> = [];
  let covered = 0;
  let shift = 0;
  for (const s of segments) {
    if (s.from < covered || s.shift < shift) return undefined;
    const frames = s.shift - shift;
    if (frames > 0) {
      if (covered + frames > s.from) return undefined;
      spans.push({ at: s.from - frames, frames });
    }
    covered = s.to;
    shift = s.shift;
  }
  return spans;
}

const removedBefore = (spans: ReadonlyArray<RippleSpan>, frame: number) => spans.reduce((sum, s) => sum + Math.max(0, Math.min(frame - s.at, s.frames)), 0);

/** The update_item that takes `spans` (old timeline frames) out of a graphic that starts at `start`, or undefined when none falls in it or nothing would be left. */
function retimeOne(item: Item, start: number, spans: ReadonlyArray<RippleSpan>, fps: number): { op: Op; frames: number; cuts: number; at: number } | undefined {
  const local = spans.map((s) => ({ from: Math.max(0, s.at - start), to: Math.min(item.duration, s.at + s.frames - start) })).filter((s) => s.to > s.from);
  const frames = local.reduce((sum, s) => sum + s.to - s.from, 0);
  if (!frames || frames >= item.duration) return undefined;
  const cut = (f: number) => local.some((s) => f >= s.from && f < s.to);
  const times: Array<number> = [];
  for (let f = 0; f < item.duration; f++) if (!cut(f)) times.push(graphicTime(item, f));
  const skips: Array<{ at: number; frames: number }> = [];
  for (let k = 1; k < times.length; k++) if (times[k]! - times[k - 1]! > 1) skips.push({ at: k, frames: times[k]! - times[k - 1]! - 1 });
  const duration = times.length;
  let keys = item.keys;
  let length = item.duration;
  for (const s of [...local].reverse()) {
    if (keys) keys = keysWithoutSpan(keys, s.from, s.to, fps, length);
    length -= s.to - s.from;
  }
  const animation =
    item.animation && Object.fromEntries(Object.entries(item.animation).map(([k, a]) => [k, a && { ...a, duration: Math.min(a.duration, duration) }]));
  const newStart = start - removedBefore(spans, start);
  const set = {
    start: newStart,
    duration,
    in: times[0]! > 0 || item.in !== undefined ? times[0]! : null,
    skips: skips.length ? skips : null,
    ...(item.keys ? { keys: keys?.length ? keys : null } : {}),
    ...(animation ? { animation } : {}),
  };
  return { op: { op: "update_item", item: item.id, set }, frames, cuts: local.length, at: newStart + local[0]!.from };
}

const seconds = (frames: number, fps: number) => `${(Math.round((frames / fps) * 10) / 10).toFixed(1)} s`;

/** One sentence per re-timed graphic, for the agent's edit result. */
export const retimeNotes = (retimed: ReadonlyArray<GraphicRetime>, fps: number): Array<string> =>
  retimed.map(
    (r) =>
      `${r.id} (${r.src}): ${seconds(r.frames, fps)} of its own time went with the footage at ${seconds(r.at, fps)}${r.cuts > 1 ? ` and ${r.cuts - 1} later cut${r.cuts > 2 ? "s" : ""}` : ""} (its skips), so its later beats and keys still land on the footage. Don't shift its render(t) times by hand.`,
  );

/** The ids an op names (the items it changes). */
function named(op: Op): Array<Id> {
  if (op.op === "insert_item") return [op.item.id];
  if (op.op === "split_item") return [op.item, op.newId];
  return "item" in op && typeof op.item === "string" ? [op.item] : [];
}

/**
 * `ops` with the update_items that re-time the graphics a ripple cut in them spans (see the
 * header), and which graphics those are. Graphics the ops already change are left as the ops
 * have them. An edit that doesn't apply comes back as it is (the real apply says why).
 */
export function withGraphicRetime(
  project: Project,
  ops: ReadonlyArray<Op>,
): { readonly ops: ReadonlyArray<Op>; readonly retimed: ReadonlyArray<GraphicRetime> } {
  let after: Project;
  try {
    after = applyEdit(createSession(project), { actor: "agent", ops }).project;
  } catch {
    return { ops, retimed: [] };
  }
  const spans = rippleSpans(project, after);
  if (!spans?.length) return { ops, retimed: [] };
  const touched = new Set(ops.flatMap(named));
  const starts = layout(project).starts;
  const extra: Array<Op> = [];
  const retimed: Array<GraphicRetime> = [];
  for (const track of after.tracks) {
    if (track.role === "main" || track.locked) continue;
    for (const item of track.items) {
      if (item.type !== "graphic" || item.locked || item.linkedTo || touched.has(item.id) || !starts.has(item.id)) continue;
      const done = retimeOne(item, starts.get(item.id)!, spans, project.canvas.fps);
      if (!done) continue;
      extra.push(done.op);
      retimed.push({ id: item.id, src: item.src ?? "", frames: done.frames, cuts: done.cuts, at: done.at });
    }
  }
  return { ops: [...ops, ...extra], retimed };
}
