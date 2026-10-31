// The agent's view of a graphic's elements (D316): the file's elements as timeline frames, and its
// edits turned into the item's one update_item. The same core planner as the timeline's.
import {
  type ElementChange,
  type GraphicElement,
  type GraphicElements,
  type Item,
  type Op,
  type Project,
  elementSpan,
  graphicTime,
  itemFrameOf,
  layout,
  planElementChanges,
} from "@uncut/core";

export interface ElementEditArgs {
  readonly element: string;
  readonly start?: number;
  readonly end?: number;
  readonly hidden?: boolean;
  readonly text?: string | null;
  readonly color?: string | null;
  readonly x?: number;
  readonly y?: number;
  readonly scale?: number;
  readonly opacity?: number;
}

/** A graphic item of the project and where it starts, or why not. */
export function graphicItem(project: Project, id: unknown): { readonly item: Item; readonly start: number } | { readonly problem: string } {
  const item = project.tracks.flatMap((t) => t.items).find((i) => i.id === id);
  if (!item || item.type !== "graphic" || typeof item.src !== "string")
    return { problem: `There's no graphic item ${JSON.stringify(id)}; project_read lists the items.` };
  return { item, start: layout(project).starts.get(item.id) ?? 0 };
}

/** The elements as the agent reads them: start and end are timeline frames. */
export function elementRows(found: GraphicElements, item: Item, itemStart: number) {
  return found.elements.map((e) => {
    const edit = item.elements?.[e.key];
    const [a, b] = elementSpan(e, edit);
    return {
      element: e.key,
      name: e.name,
      kind: e.kind,
      ...(e.parent ? { insideOf: e.parent } : {}),
      start: itemStart + itemFrameOf(item, a),
      end: itemStart + itemFrameOf(item, b),
      timing: e.timing,
      ...(e.text ? { text: e.text.slice(0, 120) } : {}),
      ...(e.plain ? { textEditable: true } : {}),
      ...(edit ? { edit } : {}),
    };
  });
}

const changeOf = (edit: ElementEditArgs, item: Item, itemStart: number): ElementChange => {
  const { element: _element, start, end, ...rest } = edit;
  return {
    ...rest,
    ...(typeof start === "number" ? { in: graphicTime(item, start - itemStart) } : {}),
    ...(typeof end === "number" ? { out: graphicTime(item, end - itemStart) } : {}),
  };
};

/** The op for `edits`, or the first one that names no element. */
export function elementEditOp(
  found: GraphicElements,
  item: Item,
  itemStart: number,
  edits: ReadonlyArray<ElementEditArgs>,
  fps: number,
): { readonly op: Op } | { readonly problem: string } {
  const byKey = new Map<string, GraphicElement>(found.elements.map((e) => [e.key, e]));
  const missing = edits.find((e) => !byKey.has(e.element));
  if (missing) return { problem: `${item.id} has no element ${JSON.stringify(missing.element)}; graphic_elements lists them.` };
  const flattened = edits.find((e) => typeof e.text === "string" && !byKey.get(e.element)!.plain);
  if (flattened)
    return {
      problem: `${flattened.element} holds more than text, so a new text would wipe what's inside it. Change the text of the elements inside it, or write a new graphic.`,
    };
  return {
    op: planElementChanges(
      item,
      found.elements,
      edits.map((e) => ({ element: byKey.get(e.element)!, change: changeOf(e, item, itemStart) })),
      fps,
    ),
  };
}
