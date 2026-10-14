// Several selected items edited at once (Fable QA round 2, F2, D147): one planner run per item,
// each against the project as the earlier ones left it, joined into one edit (one revision, one
// ⌘Z). Items the change doesn't apply to (a filter on a text) are skipped; when it applies to none,
// the first item's reason is the answer.
import type { Op } from "@uncut/core/types";

import type { ProjectModel } from "../state/project.ts";
import { draftOf, type Plan } from "./edit.ts";

type Problem = { readonly problem: string };

export interface ManyPlan extends Plan {
  /** The items it changes. */
  readonly ids: ReadonlyArray<string>;
}

/**
 * `plan` for each of `ids`, chained: item n is planned against the project with items 0…n−1's ops
 * applied, so planners that read neighbours (a main clip's speed moves the clips after it) see the
 * real timeline. `summary(n, one)` labels the edit (`one`: the single item's own label).
 */
export function planForAll(project: ProjectModel, ids: ReadonlyArray<string>, plan: (p: ProjectModel, id: string) => Plan | Problem, summary: (n: number, one: string) => string): ManyPlan | Problem {
  const unique = [...new Set(ids)];
  let current = project;
  const ops: Array<Op> = [];
  const done: Array<string> = [];
  let first: Problem | undefined;
  let one = "";
  for (const id of unique) {
    const p = plan(current, id);
    if ("problem" in p) {
      first ??= p;
      continue;
    }
    if (!p.ops.length) continue;
    const draft = draftOf(current, p.ops);
    if ("problem" in draft) {
      first ??= draft;
      continue;
    }
    current = draft.project;
    ops.push(...p.ops);
    done.push(id);
    one = p.summary;
  }
  if (!done.length) return first ?? { ops: [], summary: "", ids: [] };
  return { ops, summary: done.length === 1 ? one : summary(done.length, one), ids: done };
}
