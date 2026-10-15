// Gaps on the main track (D224): main items keep their order, and an item's `gap` is the empty
// frames before it. Planners that must leave the other items where they are (a delete, a drag)
// work out the gaps that put each item back at its frame; the engine's ops stay plain (a bare
// delete_item still closes up, which is what ripple delete and cuts by text want).
import { gapOf, mainStarts } from "../rules.ts";
import type { Id, Item, Op, Track } from "../types.ts";

/**
 * update_item ops giving the main items in `order` the gaps that start each at `desired(item)`, or
 * right after the item before it when that's later (a later item is pushed, never overlapped).
 * An item whose gap is already right gets no op, except ids in `cleared` (their gap is gone after
 * an earlier op in the same edit, e.g. move_item): those get one whenever it isn't 0. Also returns
 * where each lands.
 */
export function gapOpsFor(order: ReadonlyArray<Item>, desired: (item: Item, index: number) => number, cleared: ReadonlySet<Id> = new Set()): { ops: Array<Op>; starts: Map<Id, number> } {
  const ops: Array<Op> = [];
  const starts = new Map<Id, number>();
  let end = 0;
  order.forEach((item, index) => {
    const start = Math.max(end, Math.round(desired(item, index)));
    const gap = start - end;
    const had = cleared.has(item.id) ? 0 : gapOf(item);
    if (gap !== had) ops.push({ op: "update_item", item: item.id, set: { gap: gap > 0 ? gap : null } });
    starts.set(item.id, start);
    end = start + item.duration;
  });
  return { ops, starts };
}

/** Each main item's start frame, by id. */
export function mainStartsById(track: Pick<Track, "items">): Map<Id, number> {
  const s = mainStarts(track);
  return new Map(track.items.map((item, i) => [item.id, s[i]!]));
}

/**
 * Delete main items and leave their space (D224): the items after them stay where they are.
 * The update_item ops to send after the delete_item ops.
 */
export function keepMainTimes(track: Pick<Track, "items">, gone: ReadonlySet<Id>): Array<Op> {
  const before = mainStartsById(track);
  return gapOpsFor(track.items.filter((i) => !gone.has(i.id)), (item) => before.get(item.id)!).ops;
}

/**
 * Close up after deleting main items (ripple delete, a cut by text): the deleted items' own frames
 * go and the rest moves left, but the empty space that was before a deleted item stays (it goes to
 * the next item that stays). The update_item ops to send after the delete_item ops.
 */
export function rippleMainGaps(track: Pick<Track, "items">, gone: ReadonlySet<Id>): Array<Op> {
  const ops: Array<Op> = [];
  let carried = 0;
  for (const item of track.items) {
    if (gone.has(item.id)) {
      carried += gapOf(item);
      continue;
    }
    if (carried > 0) ops.push({ op: "update_item", item: item.id, set: { gap: gapOf(item) + carried } });
    carried = 0;
  }
  return ops;
}
