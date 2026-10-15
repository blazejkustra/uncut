// Pressing a transition marker: select its cut; dragging an edge sets its length (D73).
import type React from "react";
import { draftOf, findItem, lockOf, planSetTransition, secondsLabel, type Plan } from "../edit.ts";
import { playback } from "../../preview/playback.ts";
import type { ProjectModel } from "../../state/project.ts";
import { actions, getState, projectOf, type AppStateShape } from "../../state/store.ts";
import { DRAG_PX } from "../ItemBox.tsx";
import type { DragView } from "./dragView.ts";
import type { LaneGeometry } from "./lanes.ts";

export interface TransitionDragCtx {
  readonly project: ProjectModel;
  readonly fps: number;
  readonly online: boolean;
  readonly snapshot: AppStateShape["snapshot"];
  readonly frameAt: LaneGeometry["frameAt"];
  readonly setDrag: React.Dispatch<React.SetStateAction<DragView | undefined>>;
  readonly stopDrag: React.RefObject<(() => void) | undefined>;
}

export function makeTransitionDrag(ctx: TransitionDragCtx) {
  const { project, fps, online, snapshot, frameAt, setDrag, stopDrag } = ctx;
  /**
   * Press on a transition marker: select its cut. From an edge, dragging changes its length,
   * centred on the cut (the edge follows the pointer, so the length is twice its distance from
   * the cut), clamped to what fits there; one edit on release ("Changed transition to 0.8 s").
   */
  const onTransitionDown = (e: React.PointerEvent, itemId: string, cutFrame: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    playback.selectCut(itemId);
    const edge = (e.target as HTMLElement).dataset.trEdge;
    const base = project;
    const placed = findItem(base, itemId);
    const tr = placed?.item.transitionIn;
    const origin = { dir: snapshot?.dir, revision: snapshot?.revision };
    if (!edge || !placed || !tr || lockOf(placed) || !online) return;
    e.preventDefault();
    const x0 = e.clientX;
    let active = false;
    let plan: Plan | undefined;
    const compute = (ev: PointerEvent, against: ProjectModel) => {
      plan = undefined;
      const now = findItem(against, itemId)?.item.transitionIn;
      if (!now) return;
      const wanted = Math.max(1, Math.round(2 * Math.abs(frameAt(ev.clientX) - cutFrame)));
      const p = planSetTransition(against, itemId, { module: now.module, duration: wanted });
      if ("problem" in p) return setDrag({ itemId: `tr:${itemId}`, mode: "transition", view: against, refused: p.problem, tipAt: cutFrame, tip: p.problem });
      const draft = draftOf(against, p.ops);
      if (!("problem" in draft)) plan = p;
      const shown = ("project" in draft ? findItem(draft.project, itemId)?.item.transitionIn?.duration : undefined) ?? now.duration;
      setDrag({
        itemId: `tr:${itemId}`,
        mode: "transition",
        view: "problem" in draft ? against : draft.project,
        ...("problem" in draft ? { refused: draft.problem } : {}),
        tipAt: cutFrame + shown / 2,
        tip: "problem" in draft ? draft.problem : `${secondsLabel(shown, fps)} (${shown} frames)`,
      });
    };
    const move = (ev: PointerEvent) => {
      if (!active && Math.abs(ev.clientX - x0) < DRAG_PX) return;
      if (!active) playback.pause();
      active = true;
      compute(ev, base);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      if (stopDrag.current === cancel) stopDrag.current = undefined;
    };
    const cancel = () => {
      stop();
      setDrag(undefined);
    };
    const up = (ev: PointerEvent) => {
      stop();
      if (!active) return;
      const now = getState().snapshot;
      if (!now || now.dir !== origin.dir) return setDrag(undefined);
      const fresh = now.revision !== origin.revision;
      compute(ev, fresh ? projectOf(now) : base);
      const sent = plan;
      if (!sent?.ops.length) return setDrag(undefined);
      void actions.timelineEdit(sent, { baseRevision: fresh ? now.revision : origin.revision, dir: now.dir }).finally(() => setDrag(undefined));
    };
    stopDrag.current?.();
    stopDrag.current = cancel;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  };
  return { onTransitionDown };
}
