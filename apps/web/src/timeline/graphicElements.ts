// A graphic's elements for the timeline and the Inspector (D316): read once from the server per
// project and file, laid out in rows under the item.
import { useSyncExternalStore } from "react";

import { NO_BASIS, planElementEdit, validBasis, type ElementBasis, type GraphicElement, type GraphicElements } from "@uncut/core/graphicElements";
import { graphicTime } from "@uncut/core/graphics";
import type { Id, Item } from "@uncut/core/types";

import { getPlayback, playback } from "../preview/playback.ts";
import type { ProjectModel } from "../state/project.ts";
import { projectOf, state } from "../state/store/core.ts";
import { graphicElementsUrl } from "../state/store/urls.ts";
import { findItem, type Plan } from "./edit.ts";

export type ElementsState = { readonly status: "loading" } | ({ readonly status: "ready" } & GraphicElements);

/** `length`: the graphic's own frames this read covers. */
const found = new Map<string, { readonly state: ElementsState; readonly length: number }>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version++;
  for (const l of listeners) l();
};

async function read(url: string): Promise<ElementsState> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(await response.text());
    return { status: "ready", ...((await response.json()) as GraphicElements) };
  } catch (error) {
    return { status: "ready", elements: [], reason: `Uncut couldn't read this graphic's elements (${(error as Error).message}). It stays one block.` };
  }
}

async function load(key: string, src: string, item: string) {
  const url = graphicElementsUrl(src, item);
  if (!url) return void found.delete(key);
  const answer = await read(url);
  found.set(key, { state: answer, length: found.get(key)?.length ?? 0 });
  notify();
}

// One read at a time: each holds one of the page's few connections and a rasteriser for seconds.
let reads = Promise.resolve();

/**
 * What's known of a graphic item's elements; the first ask reads them, and so does an item that
 * reaches past the last read (once its drag has ended), which keeps showing until the new one is in.
 */
export function elementsOf(item: Item): ElementsState | undefined {
  const snapshot = state.snapshot;
  const { src, id } = item;
  if (!src || !snapshot) return undefined;
  const { width, height, fps } = projectOf(snapshot).canvas;
  const key = [snapshot.dir, src, `${width}x${height}@${fps}`, JSON.stringify(item.props ?? null)].join("\n");
  const known = found.get(key);
  const length = graphicTime(item, item.duration - 1) + 1;
  if (known && (known.length >= length || getPlayback().draft)) return known.state;
  const shown = known?.state ?? { status: "loading" };
  found.set(key, { state: shown, length });
  reads = reads.then(() => load(key, src, id));
  return shown;
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
  const known = item ? elementsOf(item) : undefined;
  const element = known?.status === "ready" ? known.elements.find((e) => e.key === key) : undefined;
  return item && element ? { item, element } : undefined;
}

/** Show an element just selected: the playhead goes into it, past its entrance, unless it's already there. */
export function seekToElement(start: number, from: number, to: number) {
  const frame = Math.round(getPlayback().frame);
  if (frame < start + from || frame >= start + to) playback.seek(start + from + Math.min(15, Math.floor((to - from) / 2)));
}

/** ⌫ on a selected element. */
export function planDeleteElement(project: ProjectModel): Plan | undefined {
  const found = selectedElement(project);
  return found && { ops: [planElementEdit(found.item, found.element, { hidden: true })], summary: `Deleted ${found.element.name}` };
}

const bases = new Map<string, ElementBasis>();

/** How the element moved on the canvas when its document last told (it can only tell while on screen). */
export const elementBasis = (item: Id, key: string) => bases.get(`${item}\n${key}`) ?? NO_BASIS;

export function noteElementBasis(item: Id, key: string, basis: unknown) {
  if (!validBasis(basis)) return;
  const had = elementBasis(item, key);
  if (basis.every((n, i) => n === had[i])) return;
  bases.set(`${item}\n${key}`, basis);
  notify();
}

const collapsed = new Set<string>();
export const isCollapsed = (id: string) => collapsed.has(id);
export function toggleCollapsed(id: string) {
  if (!collapsed.delete(id)) collapsed.add(id);
  notify();
}
