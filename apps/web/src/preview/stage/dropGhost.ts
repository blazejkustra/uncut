import type { Op } from "@uncut/core/types";
import { componentHtml } from "@uncut/core/components";
import { textHtml } from "@uncut/core/render";
import { getPlayback } from "../playback.ts";
import { type ProjectModel, planAddText, type Item } from "../../state/project.ts";
import { textPresets } from "../../state/store.ts";
import { planAddComponent } from "../components.ts";

/**
 * What a library tile dragged over the canvas would add at `at` (X2, D132): the element its drop
 * makes (the same planner), drawn by core (textHtml / componentHtml) as the export would, for the
 * faint ghost under the pointer. Undefined when the plan is refused or there's nothing to draw.
 */
export function dropGhostHtml(project: ProjectModel, what: { text?: string | undefined; component?: string | undefined }, at: { x: number; y: number }): string | undefined {
  const frame = getPlayback().frame;
  if (what.text !== undefined) {
    const preset = textPresets().find((p) => p.id === what.text);
    if (!preset) return undefined;
    const plan = planAddText(project, preset, frame, at);
    if ("problem" in plan) return undefined;
    return (plan.ops as ReadonlyArray<Op>).flatMap((op) => (op.op === "insert_item" ? [textHtml(op.item as Item, { ...project, textLooks: project.textLooks ?? 1 }).replace(/ data-item="[^"]*"/, "")] : [])).join("");
  }
  if (!what.component) return undefined;
  const plan = planAddComponent(project, what.component, frame, { at });
  if ("problem" in plan) return undefined;
  const item = (plan.ops as ReadonlyArray<Op>).flatMap((op) => (op.op === "insert_item" && (op.item as Item).type === "component" ? [op.item as Item] : []))[0];
  return item ? componentHtml(item, project, 0, { fps: project.canvas.fps })?.replace(/ data-item="[^"]*"/, "") : undefined;
}
