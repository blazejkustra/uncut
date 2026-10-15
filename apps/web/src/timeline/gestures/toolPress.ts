// Presses on the lanes under the Blade and Hand tools (issue #57, D230). The Select tool's presses
// go to the items and the empty timeline as before (itemDrag, scrubMarquee); the ruler always scrubs.
import type React from "react";
import { getBeats } from "../../audio/beats.ts";
import { getPlayback } from "../../preview/playback.ts";
import type { ProjectModel } from "../../state/project.ts";
import { actions } from "../../state/store.ts";
import { bladeFrame, findItem, lockOf, planBladeSplit, SNAP_PX } from "../edit.ts";
import { getTool } from "../tools.ts";
import type { LaneGeometry } from "./lanes.ts";

/** The blade's hover line: where a click would cut, on the lane of the item under the pointer. */
export interface BladeHover {
  readonly item: string;
  readonly frame: number;
  readonly snapAt?: number;
  readonly top: number;
  readonly height: number;
  /** Why a click wouldn't cut there (a locked track or item). */
  readonly refused?: string;
}

export interface ToolPressCtx {
  readonly project: ProjectModel;
  readonly ppf: number;
  readonly online: boolean;
  readonly lanesRef: React.RefObject<HTMLDivElement | null>;
  readonly bodyRef: React.RefObject<HTMLDivElement | null>;
  readonly frameAt: LaneGeometry["frameAt"];
  readonly setBlade: React.Dispatch<React.SetStateAction<BladeHover | undefined>>;
  readonly setPanning: React.Dispatch<React.SetStateAction<boolean>>;
}

export function makeToolPress(ctx: ToolPressCtx) {
  const { project, ppf, online, lanesRef, bodyRef, frameAt, setBlade, setPanning } = ctx;
  const onRuler = (target: EventTarget | null) => target instanceof Element && target.closest(".tl-ruler") !== null;

  /** The item under the pointer and the frame the blade would cut it at. */
  const bladeAt = (e: { target: EventTarget | null; clientX: number; metaKey: boolean }): BladeHover | undefined => {
    if (!(e.target instanceof Element) || onRuler(e.target)) return undefined;
    const el = e.target.closest<HTMLElement>("[data-testid=timeline-item]");
    const lane = e.target.closest<HTMLElement>("[data-testid=lane]");
    const id = el?.dataset.item;
    const placed = id ? findItem(project, id) : undefined;
    if (!placed || !lane || !lanesRef.current || placed.item.type === "captions") return undefined;
    const snapOn = getPlayback().snapping && !e.metaKey;
    const at = bladeFrame(project, placed.item.id, frameAt(e.clientX), snapOn ? { playhead: getPlayback().frame, threshold: SNAP_PX / ppf, beats: { beats: getBeats().map, ppf } } : undefined);
    if (!(placed.start < at.frame && at.frame < placed.start + placed.item.duration)) return undefined;
    const r = lane.getBoundingClientRect();
    const top = r.top - lanesRef.current.getBoundingClientRect().top;
    const refused = lockOf(placed);
    return { item: placed.item.id, frame: at.frame, ...(at.snapAt !== undefined ? { snapAt: at.snapAt } : {}), top, height: r.height, ...(refused ? { refused } : {}) };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (getTool() !== "blade") return setBlade(undefined);
    setBlade(bladeAt(e));
  };
  const onPointerLeave = () => setBlade(undefined);

  /** Capture phase: under Blade a press on an item cuts it; under Hand any press (but the ruler's) drags the view. */
  const onPointerDownCapture = (e: React.PointerEvent) => {
    const tool = getTool();
    if (e.button !== 0 || tool === "select" || onRuler(e.target)) return;
    if (tool === "blade") {
      const at = bladeAt(e);
      const onItem = e.target instanceof Element && e.target.closest("[data-testid=timeline-item]");
      if (!onItem) return;
      // An item, cut or not: the Select tool's press (select, move, trim) doesn't run.
      e.preventDefault();
      e.stopPropagation();
      if (!at || !online) return;
      void actions.timelineEdit(planBladeSplit(project, at.item, at.frame));
      return;
    }
    const body = bodyRef.current;
    if (!body) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const left = body.scrollLeft;
    const top = body.scrollTop;
    setPanning(true);
    const move = (ev: PointerEvent) => {
      body.scrollLeft = left - (ev.clientX - x0);
      body.scrollTop = top - (ev.clientY - y0);
    };
    const up = () => {
      setPanning(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  return { onPointerDownCapture, onPointerMove, onPointerLeave };
}
