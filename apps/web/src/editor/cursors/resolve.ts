// D348: a cursor target in pixels, read from the editor's layout as it is now (zoom, scroll, open
// panels). Each panel bounds its cursors: a target scrolled out of view pins to the edge.
import type { AgentCursorTarget } from "@uncut/contracts";

import type { ProjectModel } from "../../state/project.ts";
import { pinTo, type Bounds, type Pin, type Point } from "./place.ts";

export interface Spot extends Point {
  /** The panel it's in: a user's drag there hides the cursor. */
  readonly panel?: Element | undefined;
  readonly pin?: Pin | undefined;
  /** At the agent panel's edge: the pill alone, to the left of x. */
  readonly parked?: boolean;
  /** A stretch of the ruler the call reads, in pixels. */
  readonly band?: { readonly left: number; readonly right: number; readonly y: number } | undefined;
}

const PARK_TOP = 84;
const PARK_STEP = 34;

const boundsOf = (r: DOMRect): Bounds => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
const centreY = (r: DOMRect) => r.top + r.height / 2;

interface TimelineBox {
  readonly body: HTMLElement;
  readonly ruler: DOMRect;
  readonly ppf: number;
  readonly lanes: Bounds;
}

function timelineBox(): TimelineBox | undefined {
  const body = document.querySelector<HTMLElement>(".bottom-body");
  const timeline = body?.querySelector<HTMLElement>("[data-testid=timeline]");
  const ruler = timeline?.querySelector("[data-testid=ruler]")?.getBoundingClientRect();
  const heads = timeline?.querySelector("[data-testid=track-heads]")?.getBoundingClientRect();
  if (!body || !timeline || !ruler || !heads) return undefined;
  const view = body.getBoundingClientRect();
  return { body, ruler, ppf: Number(timeline.dataset.ppf) || 0, lanes: { left: heads.right, top: ruler.bottom, right: view.right, bottom: view.bottom } };
}

const frameX = (box: TimelineBox, frame: number) => box.ruler.left + frame * box.ppf;
const inLanes = (box: TimelineBox, point: Point): Spot => ({ ...pinTo(point, box.lanes), panel: box.body });

function rulerSpot(box: TimelineBox, frame: number, end?: number): Spot {
  const y = centreY(box.ruler);
  const pinned = pinTo({ x: frameX(box, frame), y }, { ...box.lanes, top: box.ruler.top, bottom: box.ruler.bottom });
  const band =
    end === undefined
      ? undefined
      : { left: Math.max(box.lanes.left, frameX(box, frame)), right: Math.min(box.lanes.right, frameX(box, end)), y: box.ruler.bottom - 3 };
  return { ...pinned, panel: box.body, band: band && band.right > band.left ? band : undefined };
}

function itemSpot(target: AgentCursorTarget, box: TimelineBox): Spot | undefined {
  const el = target.item ? box.body.querySelector(`[data-testid=timeline-item][data-item="${CSS.escape(target.item)}"]`) : null;
  if (el) {
    const r = el.getBoundingClientRect();
    const x =
      target.offset !== undefined ? r.left + target.offset * box.ppf : target.at === "end" ? r.right : target.at === "centre" ? r.left + r.width / 2 : r.left;
    return inLanes(box, { x, y: centreY(r) });
  }
  if (target.frame === undefined) return undefined;
  const lane = target.track ? box.body.querySelector(`[data-testid=lane][data-track="${CSS.escape(target.track)}"]`) : null;
  return lane ? inLanes(box, { x: frameX(box, target.frame), y: centreY(lane.getBoundingClientRect()) }) : rulerSpot(box, target.frame);
}

function trackSpot(track: string, box: TimelineBox): Spot | undefined {
  const lane = box.body.querySelector(`[data-testid=lane][data-track="${CSS.escape(track)}"]`);
  return lane ? inLanes(box, { x: box.lanes.left + 24, y: centreY(lane.getBoundingClientRect()) }) : undefined;
}

function previewSpot(): Spot | undefined {
  const frame = document.querySelector("[data-testid=preview-frame]")?.getBoundingClientRect();
  const stage = document.querySelector("[data-testid=stage]") ?? undefined;
  return frame && frame.width ? { x: frame.left + frame.width * 0.5, y: frame.top + frame.height * 0.5, panel: stage } : undefined;
}

/** The main-track clip a media's words are heard in, when the Transcript panel isn't open. */
const clipOfMedia = (project: ProjectModel, media: string) => project.tracks.find((t) => t.role === "main")?.items.find((i) => i.media === media)?.id;

function wordsSpot(target: AgentCursorTarget, project: ProjectModel, box: TimelineBox | undefined): Spot | undefined {
  const panel = document.querySelector("[data-testid=transcript-panel]");
  const scope = target.item ? `[data-clip="${CSS.escape(target.item)}"]` : target.media ? `[data-media="${CSS.escape(target.media)}"]` : "";
  const block = panel?.querySelector(`[data-testid=tx-block]${scope}`);
  const word =
    (target.from !== undefined ? block?.querySelector(`[data-testid=tx-word][data-index="${target.from}"]`) : undefined) ??
    block?.querySelector("[data-testid=tx-word]");
  if (panel && word) {
    const r = word.getBoundingClientRect();
    return { ...pinTo({ x: r.left + 2, y: r.bottom - 2 }, boundsOf(panel.getBoundingClientRect())), panel };
  }
  const item = target.item ?? (target.media ? clipOfMedia(project, target.media) : undefined);
  return item && box ? itemSpot({ kind: "item", item, at: "centre" }, box) : undefined;
}

/** The agent panel's edge (the side panel, focus mode's chat), one row per agent. */
export function parkSpot(row: number): Spot {
  const panel = document.querySelector("aside.side") ?? document.querySelector("[data-testid=focus-agent]");
  const r = panel?.getBoundingClientRect();
  const x = r ? r.left - 8 : window.innerWidth - 16;
  return { x, y: (r ? r.top : 0) + PARK_TOP + row * PARK_STEP, parked: true, panel: panel ?? undefined };
}

/** Where `target` is on screen now; undefined when it can't be found (the cursor stays where it is). */
export function resolveTarget(target: AgentCursorTarget, project: ProjectModel, row: number): Spot | undefined {
  if (target.kind === "park") return parkSpot(row);
  if (target.kind === "stay") return undefined;
  const box = timelineBox();
  if (target.kind === "words") return wordsSpot(target, project, box);
  if (target.kind === "time" && target.preview) {
    const spot = previewSpot();
    const band = box && target.frame !== undefined ? rulerSpot(box, target.frame, target.end ?? target.frame + 1).band : undefined;
    return spot ? { ...spot, band } : box && target.frame !== undefined ? rulerSpot(box, target.frame, target.end) : undefined;
  }
  if (!box) return undefined;
  if (target.kind === "time") return target.frame === undefined ? undefined : rulerSpot(box, target.frame, target.end);
  if (target.kind === "track") return target.track ? trackSpot(target.track, box) : undefined;
  return itemSpot(target, box);
}

/** The timeline's scroller and how far a target's frame is outside its view, for Follow agent. */
export function followScroll(target: AgentCursorTarget): { readonly body: HTMLElement; readonly by: number } | undefined {
  if (target.frame === undefined || (target.kind !== "item" && target.kind !== "time")) return undefined;
  const box = timelineBox();
  if (!box) return undefined;
  const x = itemX(target, box) ?? frameX(box, target.frame);
  if (x >= box.lanes.left + 40 && x <= box.lanes.right - 40) return undefined;
  return { body: box.body, by: x - (box.lanes.left + box.lanes.right) / 2 };
}

function itemX(target: AgentCursorTarget, box: TimelineBox) {
  if (target.kind !== "item" || !target.item) return undefined;
  const r = box.body.querySelector(`[data-testid=timeline-item][data-item="${CSS.escape(target.item)}"]`)?.getBoundingClientRect();
  return r ? r.left + r.width / 2 : undefined;
}
