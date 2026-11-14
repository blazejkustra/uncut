// Slip and roll planners (edit.ts): a drag in timeline frames, clamped to the media both ways, as one op.
import { adjacentAfter } from "@uncut/core/apply-ops";
import type { Item } from "@uncut/core/types";
import type { ProjectModel } from "../../state/project.ts";
import { type Placed, type Plan, findItem, lockOf } from "./base.ts";

export interface SlipRollPlan extends Plan {
  /** The frame the tip points at. */
  readonly at: number;
  readonly tip: string;
}

/** The media's length in frames when an item runs out of it, and whether it plays from a time at all. */
function mediaLimit(project: ProjectModel, item: Item) {
  const media = item.media ? project.media.find((m) => m.id === item.media) : undefined;
  const timed = media ? media.kind !== "image" : item.in !== undefined;
  const free = item.loop === true || (item.type === "clip" && item.hold === true);
  return { timed, frames: timed && !free ? media?.probe?.frames : undefined };
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const signed = (frames: number) => `${frames > 0 ? "+" : ""}${frames} ${Math.abs(frames) === 1 ? "frame" : "frames"}`;

export interface SlipLimits {
  readonly placed: Placed;
  /** How far the item can slip, in its own frames: `lo` ≤ 0 (earlier media) ≤ `hi` (later). */
  readonly lo: number;
  readonly hi: number;
}

/** How far `itemId` can slip, or why it can't (the Slip tool and the slip view, slipView.ts, share these). */
export function slipLimits(project: ProjectModel, itemId: string): SlipLimits | { readonly problem: string } {
  const placed = findItem(project, itemId);
  if (!placed) return { problem: "That item isn't in the project any more." };
  const locked = lockOf(placed);
  if (locked) return { problem: locked };
  const { item } = placed;
  const { timed, frames } = mediaLimit(project, item);
  if (!timed || !item.media || (item.type !== "clip" && item.type !== "audio")) return { problem: "Only clips and sounds with video or audio slip." };
  const speed = item.speed ?? 1;
  const from = item.in ?? 0;
  const lo = Math.min(0, -Math.floor(from / speed));
  const hi = Math.max(0, frames === undefined ? Infinity : Math.floor((frames - from) / speed - item.duration));
  if (lo === 0 && hi === 0) return { problem: "This clip already shows all its media: trim it to have frames to slip." };
  return { placed, lo, hi };
}

/** Slip `itemId` by `frames` of its own (> 0: later media), clamped to the media at both ends. */
export function planSlipBy(project: ProjectModel, itemId: string, frames: number): SlipRollPlan | { readonly problem: string } {
  const limits = slipLimits(project, itemId);
  if ("problem" in limits) return limits;
  const { placed, lo, hi } = limits;
  const slip = clamp(Math.round(frames), lo, hi);
  const tip = `Slip ${signed(slip)}`;
  if (slip === 0) return { ops: [], summary: "", at: placed.start, tip };
  return { ops: [{ op: "slip_item", item: placed.item.id, frames: slip }], summary: `Slip ${placed.item.id}`, at: placed.start, tip };
}

/**
 * Slip: `delta` frames of pointer to the right pull the picture right, so earlier frames show, as
 * on a filmstrip. Clamped to the media at both ends.
 */
export function planSlip(project: ProjectModel, itemId: string, delta: number): SlipRollPlan | { readonly problem: string } {
  return planSlipBy(project, itemId, -Math.round(delta));
}

/** The item whose end is `placed`'s start, for a roll pressed on its left half. */
export function rollTarget(placed: Placed, atStart: boolean): string {
  if (!atStart) return placed.item.id;
  const before =
    placed.track.role === "main" ? placed.track.items[placed.index - 1] : placed.track.items.find((i) => (i.start ?? 0) + i.duration === placed.start);
  return before?.id ?? placed.item.id;
}

/** Roll the cut after `itemId` by `delta` frames, clamped so both items keep a frame and stay in their media. */
export function planRoll(project: ProjectModel, itemId: string, delta: number): SlipRollPlan | { readonly problem: string } {
  const placed = findItem(project, itemId);
  if (!placed) return { problem: "That item isn't in the project any more." };
  const next = adjacentAfter(placed.track, placed.index);
  const after = next && findItem(project, next.id);
  if (!after) return { problem: "Roll moves a cut between two items that touch: there's no item right after this one." };
  const locked = lockOf(placed) ?? lockOf(after);
  if (locked) return { problem: locked };
  const { item } = placed;
  const out = mediaLimit(project, item);
  const into = mediaLimit(project, after.item);
  const speed = item.speed ?? 1;
  const hi = Math.min(after.item.duration - 1, out.frames === undefined ? Infinity : Math.floor((out.frames - (item.in ?? 0)) / speed - item.duration));
  const lo = Math.max(1 - item.duration, into.timed ? -Math.floor((after.item.in ?? 0) / (after.item.speed ?? 1)) : -Infinity);
  const roll = clamp(Math.round(delta), Math.min(lo, 0), Math.max(hi, 0));
  const at = after.start + roll;
  const tip = `Cut ${signed(roll)}`;
  if (roll === 0) return { ops: [], summary: "", at, tip };
  return { ops: [{ op: "roll_edit", item: item.id, frames: roll }], summary: `Roll the cut after ${item.id}`, at, tip };
}
