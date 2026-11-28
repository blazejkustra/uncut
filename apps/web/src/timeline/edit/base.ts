// Shared bits of the timeline planners (edit.ts): finding an item, track fit and locks, the plan shape, drafts.
import { applyEdit, createSession, EditError } from "@uncut/core/apply-ops";
import { fitsTrackKind, timelineProblems } from "@uncut/core/rules";
import { linkMates, withLinks } from "@uncut/core/arrange";
import type { Op } from "@uncut/core/types";
import { type Item, type Track, type ProjectModel, layoutOf } from "../../state/project.ts";

/** How close (in pixels) an edge must come to a snap target to stick to it. */
export const SNAP_PX = 6;

export interface Placed {
  readonly item: Item;
  readonly track: Track;
  /** Index in the track's items (array order; only main's order means time). */
  readonly index: number;
  readonly start: number;
}

export function findItem(project: ProjectModel, id: string | undefined): Placed | undefined {
  if (id === undefined) return undefined;
  const { starts } = layoutOf(project);
  for (const track of project.tracks) {
    const index = track.items.findIndex((i) => i.id === id);
    if (index !== -1) return { item: track.items[index]!, track, index, start: starts.get(id) ?? 0 };
  }
  return undefined;
}

// The kind of track each item type lives on off the main track (a new track for it gets this kind).
export const TRACK_KINDS: Readonly<Record<Item["type"], Track["kind"]>> = {
  clip: "video",
  component: "video",
  graphic: "video",
  text: "text",
  captions: "text",
  audio: "audio",
  sequence: "video",
};
export const homeKind = (item: Pick<Item, "type">): Track["kind"] => TRACK_KINDS[item.type];
/** Whether an item may go on a track (the validator's rule, core rules.ts): D215, the main track takes any picture, text too. */
export const fitsTrack = (item: Item, track: Track) => fitsTrackKind(item.type, track);

export const lockedProblem = (track: Track) => `The ${track.name} track is locked. Unlock it to edit it.`;

/** Why an item can't be edited by hand, if it can't. */
export function lockOf(placed: Placed): string | undefined {
  if (placed.track.locked) return lockedProblem(placed.track);
  if (placed.item.locked) return "That item is locked.";
  return undefined;
}

/** set_transition null for each of these main items that has a transition in. */
export const dropTransitions = (items: ReadonlyArray<Item | undefined>): Array<Op> =>
  [...new Set(items)].filter((i): i is Item => !!i?.transitionIn).map((i) => ({ op: "set_transition", item: i.id, transition: null }));

export interface Plan {
  readonly ops: ReadonlyArray<Op>;
  readonly summary: string;
}

/** D347: `plan` with its ops on `id` marked solo (⌥), so the items linked to it stay as they are. */
export function soloPlan<P extends Plan>(plan: P, id: string): P {
  const solo = (op: Op): Op =>
    (op.op === "move_item" || op.op === "trim_item" || op.op === "slip_item" || op.op === "split_item" || op.op === "update_item") && op.item === id
      ? { ...op, solo: true }
      : op;
  return { ...plan, ops: plan.ops.map(solo) };
}

/** "0.5 s", "1.25 s": a transition's length for labels. */
export const secondsLabel = (frames: number, fps: number) => `${Math.round((frames / fps) * 100) / 100} s`;

/**
 * The project after `ops`, checked with the same timeline rules as the server (core rules.ts), for
 * previewing a drag and checking an action before it is sent: a plan the server would refuse is
 * never shown as droppable. The problem is a sentence for the user.
 */
export function draftOf(project: ProjectModel, ops: ReadonlyArray<Op>): { readonly project: ProjectModel } | { readonly problem: string } {
  if (!ops.length) return { project };
  try {
    // D347: linked items get what the edit does to their mates, as the server applies it.
    const linked = withLinks(project, ops);
    if ("problem" in linked) return linked;
    return { project: applyEdit(createSession(project), { actor: "user", ops: linked.ops }, timelineProblems).project };
  } catch (error) {
    const first = error instanceof EditError ? (error.details[0] as { message?: string } | undefined) : undefined;
    return { problem: `Can't do that: ${first?.message ?? (error as Error).message}.` };
  }
}

/** D349: `id` and the items linked to it, which a click selects together (⌥-click: `id` alone). */
export const withLinkMates = (project: ProjectModel, id: string): Array<string> => [id, ...linkMates(project, id).map((p) => p.item.id)];

/** Whether `ids` are one item and exactly the items linked to it: edited and shown as that item. */
export function isLinkSelection(project: ProjectModel, ids: ReadonlyArray<string>): boolean {
  if (ids.length < 2) return false;
  const linked = withLinkMates(project, ids[0]!);
  return linked.length === ids.length && ids.every((id) => linked.includes(id));
}

// ---- groups (F19, D157): a kicker and its title move, trim and delete together ----

/** `ids` with every item that shares a group with one of them (the given ones first, in order). */
export function withGroups(project: ProjectModel, ids: ReadonlyArray<string>): Array<string> {
  const groups = new Set(ids.map((id) => findItem(project, id)?.item.group).filter((g): g is string => !!g));
  const out = [...ids];
  if (!groups.size) return out;
  for (const t of project.tracks) for (const i of t.items) if (i.group && groups.has(i.group) && !out.includes(i.id)) out.push(i.id);
  return out;
}
