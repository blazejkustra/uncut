// Tiles and files dropped on the lanes: media, text, elements, effects (D136), transitions on cuts (D73), Finder files (T9).
import type React from "react";
import type { Cut } from "@uncut/core/transitions";
import { bridge } from "../../state/bridge.ts";
import { actions, getState, isRemote, textPresets } from "../../state/store.ts";
import { COMPONENT_DRAG_TYPE, draggedComponent, secondsFor, setDraggedComponent, setDraggedText, TEXT_DRAG_TYPE } from "../../preview/components.ts";
import { CUT_DROP_PX, EFFECT_DRAG_TYPE, hasFiles, MEDIA_DRAG_TYPE, setDraggedEffect, setDraggedTransition, TRANSITION_DRAG_TYPE } from "../dnd.ts";
import { HEAD_WIDTH } from "./dragView.ts";
import type { LaneGeometry } from "./lanes.ts";
import { dragMayHoldLink, linkFromDrag, linkImportReady, openLinkImport } from "../../panels/library/linkImport.ts";

export interface LaneDropCtx {
  readonly fps: number;
  readonly ppf: number;
  readonly online: boolean;
  readonly cuts: ReadonlyArray<Cut>;
  readonly lanesRef: React.RefObject<HTMLDivElement | null>;
  readonly bodyRef: React.RefObject<HTMLDivElement | null>;
  readonly frameAt: LaneGeometry["frameAt"];
  readonly laneHit: LaneGeometry["laneHit"];
  readonly dropCut: string | undefined;
  readonly dropLane: string | undefined;
  readonly dropSpan: { frame: number; frames: number } | undefined;
  readonly setDropCut: React.Dispatch<React.SetStateAction<string | undefined>>;
  readonly setDropLane: React.Dispatch<React.SetStateAction<string | undefined>>;
  readonly setDropSpan: React.Dispatch<React.SetStateAction<{ frame: number; frames: number } | undefined>>;
  readonly setDropping: React.Dispatch<React.SetStateAction<boolean>>;
}

export function makeLaneDrop(ctx: LaneDropCtx) {
  const { fps, ppf, online, cuts, lanesRef, bodyRef, frameAt, laneHit, dropCut, dropLane, dropSpan, setDropCut, setDropLane, setDropSpan, setDropping } = ctx;
  /** The main cut nearest a pointer x, within CUT_DROP_PX. */
  const cutNear = (clientX: number) => {
    const f = frameAt(clientX);
    let best: (typeof cuts)[number] | undefined;
    for (const c of cuts) if (Math.abs(c.frame - f) * ppf <= CUT_DROP_PX && (!best || Math.abs(c.frame - f) < Math.abs(best.frame - f))) best = c;
    return best;
  };
  const overLanes = (x: number, y: number) => {
    const r = lanesRef.current?.getBoundingClientRect();
    const body = bodyRef.current?.getBoundingClientRect();
    return !!r && !!body && x >= Math.max(r.left, body.left + HEAD_WIDTH) && x <= Math.min(r.right, body.right) && y >= body.top && y <= body.bottom;
  };
  /** The timeline item under a pointer (an Effects tile dropped there goes on it, D136). */
  const itemAt = (x: number, y: number) => document.elementsFromPoint(x, y).find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.testid === "timeline-item")?.dataset.item;
  const onDragOver = (e: React.DragEvent) => {
    const types = [...e.dataTransfer.types];
    if (online && types.includes(EFFECT_DRAG_TYPE)) {
      if (!itemAt(e.clientX, e.clientY)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      return;
    }
    if (online && types.includes(TRANSITION_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      const over = cutNear(e.clientX)?.item.id;
      if (over !== dropCut) setDropCut(over);
      return;
    }
    // D259, D280: a link dragged from a browser (with the Import from link plugin) is imported and put here.
    const link = linkImportReady(getState().plugins) && dragMayHoldLink(e.dataTransfer);
    if (!online || ![MEDIA_DRAG_TYPE, COMPONENT_DRAG_TYPE, TEXT_DRAG_TYPE].some((t) => types.includes(t)) && !hasFiles(types) && !link) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropping(true);
    const lane = types.includes(MEDIA_DRAG_TYPE) || hasFiles(types) || link ? laneHit(e.clientY).track?.id : undefined;
    if (lane !== dropLane) setDropLane(lane);
    const tile = types.includes(TEXT_DRAG_TYPE) ? 3 : types.includes(COMPONENT_DRAG_TYPE) ? secondsFor(draggedComponent() ?? "") : undefined;
    const span = tile === undefined ? undefined : { frame: Math.max(0, Math.round(frameAt(e.clientX))), frames: tile * fps };
    if (span?.frame !== dropSpan?.frame || span?.frames !== dropSpan?.frames) setDropSpan(span);
  };
  const onDrop = (e: React.DragEvent) => {
    setDropping(false);
    setDropLane(undefined);
    setDropSpan(undefined);
    setDraggedText(undefined);
    const effect = e.dataTransfer.getData(EFFECT_DRAG_TYPE);
    if (effect) {
      e.preventDefault();
      setDraggedEffect(undefined);
      const id = itemAt(e.clientX, e.clientY);
      if (id) void actions.applyFx(effect, id);
      return;
    }
    const module = e.dataTransfer.getData(TRANSITION_DRAG_TYPE);
    if (module) {
      e.preventDefault();
      const cut = cutNear(e.clientX);
      setDropCut(undefined);
      setDraggedTransition(undefined);
      if (cut) void actions.applyTransition(module, { cut: cut.item.id });
      return;
    }
    const frame = Math.max(0, Math.round(frameAt(e.clientX)));
    // A Text tab preset (D80): added at the time it's dropped on.
    const preset = textPresets().find((p) => p.id === e.dataTransfer.getData(TEXT_DRAG_TYPE));
    if (preset) {
      e.preventDefault();
      void actions.addText(preset, { frame });
      return;
    }
    // A component from Elements (D76): added at the time it's dropped on.
    const component = e.dataTransfer.getData(COMPONENT_DRAG_TYPE) || ([...e.dataTransfer.types].includes(COMPONENT_DRAG_TYPE) ? draggedComponent() : undefined);
    if (component) {
      e.preventDefault();
      setDraggedComponent(undefined);
      void actions.addComponent(component, { frame });
      return;
    }
    const track = laneHit(e.clientY).track?.id;
    // A media tile (T1, D122): on the lane it's dropped on, at that frame.
    const id = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (id) {
      e.preventDefault();
      void actions.dropMedia(id, { frame, track });
      return;
    }
    // Files from Finder (T9, D128): imported (uploaded first when the project is remote) and put
    // there in the import's own edit.
    const files = [...e.dataTransfer.files];
    if (files.length) {
      e.preventDefault();
      if (isRemote()) void actions.uploadAndImport(files, { frame, track });
      else {
        const paths = files.map((f) => bridge.pathForFile(f)).filter((p) => p.startsWith("/"));
        void actions.importMedia(paths, { frame, track });
      }
      return;
    }
    // D259: a link: the Import from link dialog, and what it imports lands here.
    const url = linkImportReady(getState().plugins) ? linkFromDrag(e.dataTransfer) : undefined;
    if (url) {
      e.preventDefault();
      openLinkImport({ url, drop: { frame, ...(track ? { track } : {}) } });
    }
  };
  return { cutNear, overLanes, itemAt, onDragOver, onDrop };
}
