// Nest and unnest planners (edit.ts): neighbouring Main items into a sequence, and back.
import { canUnnest } from "@uncut/core/nesting";
import { type ProjectModel, uniqueId } from "../../state/project.ts";
import { type Plan, draftOf, findItem } from "./base.ts";

export function planNest(project: ProjectModel, ids: ReadonlyArray<string>): Plan | { readonly problem: string } {
  const placed = ids.map((id) => findItem(project, id)).filter((p) => p !== undefined);
  if (!placed.length || placed.some((p) => p.track.role !== "main")) return { problem: "Select items on Main to nest them." };
  const items = [...placed].sort((a, b) => a.index - b.index).map((p) => p.item.id);
  const item = uniqueId(project, "nested");
  const plan = { ops: [{ op: "nest_items" as const, items, sequence: `${item}-sequence`, item, name: "Sequence" }], summary: "Nest into a sequence" };
  const draft = draftOf(project, plan.ops);
  return "problem" in draft ? draft : plan;
}

export function planUnnest(project: ProjectModel, id: string): Plan | { readonly problem: string } {
  const placed = findItem(project, id);
  if (!placed || placed.item.type !== "sequence") return { problem: "Select a sequence item to unnest it." };
  if (!canUnnest(project, placed.item)) return { problem: "Only a sequence played whole, once, with one track can be unnested." };
  return { ops: [{ op: "unnest_item", item: id }], summary: "Unnest" };
}
