// What the Export dialog's "In to Out" and "Selected clips" mean right now (G7, D127), also sent with
// an agent message for export_video. Kept apart from exportRange.ts, which stays free of the store.
import type { Project } from "../state/store.ts";
import { layoutOf } from "../state/project.ts";
import { findItem } from "../timeline/edit.ts";
import type { FrameSpan } from "./exportRange.ts";

/**
 * What "In to Out" and "Selected clips" mean right now: the marks (an unset one is the start or the
 * end) and the span of the selected items (captions left out). The dialog and export_video
 * (sent with the agent's message) read the same.
 */
export function exportSpans(
  project: Project,
  at: {
    readonly markIn: number | undefined;
    readonly markOut: number | undefined;
    readonly selected: string | undefined;
    readonly also: ReadonlyArray<string>;
  },
): { readonly marks?: FrameSpan; readonly selection?: FrameSpan } {
  const end = layoutOf(project).end;
  const marks = at.markIn !== undefined || at.markOut !== undefined ? { from: at.markIn ?? 0, to: at.markOut ?? end } : undefined;
  const picked = (at.selected === undefined ? [] : [at.selected, ...at.also])
    .map((id) => findItem(project, id))
    .filter((p) => p !== undefined && p.item.type !== "captions");
  const selection = picked.length
    ? { from: Math.min(...picked.map((p) => p!.start)), to: Math.max(...picked.map((p) => p!.start + p!.item.duration)) }
    : undefined;
  return { ...(marks ? { marks } : {}), ...(selection ? { selection } : {}) };
}
