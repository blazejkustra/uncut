// A graphic's elements for the timeline and the Inspector (D316): read once from the server per
// project and file, laid out in rows under the item.
import { useSyncExternalStore } from "react";

import { planElementEdit, type GraphicElement, type GraphicElements } from "@uncut/core/graphicElements";
import type { Item } from "@uncut/core/types";

import { getPlayback } from "../preview/playback.ts";
import type { ProjectModel } from "../state/project.ts";
import { state } from "../state/store/core.ts";
import { graphicElementsUrl } from "../state/store/urls.ts";
import { findItem, type Plan } from "./edit.ts";

export type ElementsState = { readonly status: "loading" } | ({ readonly status: "ready" } & GraphicElements);

const found = new Map<string, ElementsState>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version++;
  for (const l of listeners) l();
};

async function load(key: string, src: string) {
  const url = graphicElementsUrl(src);
  if (!url) return void found.delete(key);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(await response.text());
    found.set(key, { status: "ready", ...((await response.json()) as GraphicElements) });
  } catch (error) {
    found.set(key, { status: "ready", elements: [], reason: `Uncut couldn't read this graphic's elements (${(error as Error).message}). It stays one block.` });
  }
  notify();
}

/** What's known of `src`'s elements; the first ask reads them. */
export function elementsOf(src: string | undefined): ElementsState | undefined {
  const dir = state.snapshot?.dir;
  if (!src || !dir) return undefined;
  const key = `${dir}\n${src}`;
  const known = found.get(key);
  if (known) return known;
  found.set(key, { status: "loading" });
  void load(key, src);
  return { status: "loading" };
}

/** Redraws when any graphic's elements arrive. */
export const useElementsVersion = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => version,
  );

export const ROW_HEIGHT = 20;
/** Rows shown at once; more scroll inside the graphic's area. */
export const MAX_ROWS = 6;
const ROWS_PAD = 4;

/** The height the rows add to the lane. */
export const rowsHeight = (rows: number) => (rows ? Math.min(rows, MAX_ROWS) * ROW_HEIGHT + ROWS_PAD : 0);

/** The selected element with its item, when one is selected and known. */
export function selectedElement(project: ProjectModel): { readonly item: Item; readonly element: GraphicElement } | undefined {
  const { selected, element: key } = getPlayback();
  const item = key === undefined ? undefined : findItem(project, selected)?.item;
  const known = item ? elementsOf(item.src) : undefined;
  const element = known?.status === "ready" ? known.elements.find((e) => e.key === key) : undefined;
  return item && element ? { item, element } : undefined;
}

/** ⌫ on a selected element. */
export function planDeleteElement(project: ProjectModel): Plan | undefined {
  const found = selectedElement(project);
  return found && { ops: [planElementEdit(found.item, found.element, { hidden: true })], summary: `Deleted ${found.element.name}` };
}

const collapsed = new Set<string>();
export const isCollapsed = (id: string) => collapsed.has(id);
export function toggleCollapsed(id: string) {
  if (!collapsed.delete(id)) collapsed.add(id);
  notify();
}
