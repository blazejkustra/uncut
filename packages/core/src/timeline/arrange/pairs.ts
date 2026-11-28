// D349: a video with sound goes on the timeline as a linked pair, the clip (muted) and its sound
// on an audio track, as Detach audio leaves it. Edits then follow by delta (D347).
import { applyEdit, createSession } from "../apply-ops.ts";
import type { Id, Op, Project } from "../types.ts";
import { withLinks } from "./linkFollow.ts";
import { takenIds } from "./place.ts";
import { planDetachAudio } from "./retime.ts";

const applied = (project: Project, ops: ReadonlyArray<Op>) => applyEdit(createSession(project), { actor: "user", ops }).project;

/**
 * `ops` plus the ops that give each clip in `placed` its own linked sound on a free audio track (a
 * new one when none is), where the ops and what their links follow (withLinks) leave room. A clip
 * without sound, muted, ramped, reversed or locked stays as it is, and so do ops that can't apply.
 */
export function withSoundPairs(project: Project, ops: ReadonlyArray<Op>, placed: ReadonlyArray<Id>): ReadonlyArray<Op> {
  if (!placed.length) return ops;
  const followed = withLinks(project, ops);
  if ("problem" in followed) return ops;
  let now: Project;
  try {
    now = applied(project, followed.ops);
  } catch {
    return ops;
  }
  const taken = takenIds(now);
  const pairs: Array<Op> = [];
  for (const id of placed) {
    const plan = planDetachAudio(now, id, taken);
    if ("problem" in plan) continue;
    pairs.push(...plan.ops);
    now = applied(now, plan.ops);
  }
  return pairs.length ? [...ops, ...pairs] : ops;
}

/** The new clips an op list inserts (insert_item, and place_item with a new item). */
export function insertedClips(ops: ReadonlyArray<unknown>): Array<Id> {
  return ops.flatMap((raw) => {
    const op = raw as { op?: unknown; item?: { id?: unknown; type?: unknown } };
    const item = op?.op === "insert_item" || op?.op === "place_item" ? op.item : undefined;
    return item && typeof item === "object" && item.type === "clip" && typeof item.id === "string" ? [item.id] : [];
  });
}
