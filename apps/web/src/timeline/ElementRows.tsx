// A graphic's elements under its clip on the timeline (D316): one block per element at its own in
// and out, packed in rows. Click selects (the item and the element), dragging a block moves it in
// time, its edges retime it, right-click deletes or resets it. Each gesture is one edit, drafted
// on the way so the preview follows.
import React from "react";

import { elementBlocks, planElementEdit, type ElementBlock, type ElementChange, type GraphicElement } from "@uncut/core/graphicElements";
import { graphicTime } from "@uncut/core/graphics";
import type { Item } from "@uncut/core/types";

import { getPlayback, playback, usePlayback, type PreviewDraft } from "../preview/playback.ts";
import type { ProjectModel } from "../state/project.ts";
import { actions, getState } from "../state/store.ts";
import { openMenu } from "./ContextMenu.tsx";
import { draftOf, findItem, SNAP_PX } from "./edit.ts";
import { MAX_ROWS, ROW_HEIGHT, seekToElement } from "./graphicElements.ts";
import { DRAG_PX } from "./ItemBox.tsx";
import { getTool } from "./tools.ts";
import "./elements.css";

type Grip = "move" | "start" | "end";

/** The element's new in and out, on the graphic's own frames, for a block dragged `delta` frames. */
function spanAfter(item: Item, block: ElementBlock, grip: Grip, delta: number): ElementChange {
  const shift = grip === "move" ? Math.max(-block.from, Math.min(item.duration - block.to, delta)) : delta;
  const from = grip === "end" ? block.from : Math.max(0, Math.min(block.to - 1, block.from + shift));
  const to = grip === "start" ? block.to : Math.min(item.duration, Math.max(block.from + 1, block.to + shift));
  return { in: graphicTime(item, from), out: graphicTime(item, to - 1) + 1 };
}

/** `delta` pulled onto the playhead or a neighbour's edge when an edge of the dragged block lands near one. */
function snapped(delta: number, block: ElementBlock, grip: Grip, targets: ReadonlyArray<number>, ppf: number): number {
  if (!getPlayback().snapping) return delta;
  const edges = grip === "start" ? [block.from] : grip === "end" ? [block.to] : [block.from, block.to];
  let best = delta;
  let gap = SNAP_PX / ppf;
  for (const edge of edges)
    for (const target of targets) {
      const off = Math.abs(edge + delta - target);
      if (off < gap) {
        gap = off;
        best = target - edge;
      }
    }
  return best;
}

export function elementMenu(project: ProjectModel, item: Item, element: GraphicElement) {
  const edit = (change: ElementChange) => void actions.timelineEdit({ ops: [planElementEdit(item, element, change)], summary: `Edited ${element.name}` });
  return [
    { id: "element-delete", label: "Delete element", danger: true, run: () => edit({ hidden: true }) },
    {
      id: "element-reset",
      label: "Reset element",
      disabled: !item.elements?.[element.key],
      run: () => void actions.timelineEdit({ ops: [resetOp(item, element)], summary: `Reset ${element.name}` }),
    },
  ];
}

export const resetOp = (item: Item, element: GraphicElement) =>
  planElementEdit(item, element, { in: null, out: null, hidden: null, text: null, color: null, x: null, y: null, scale: null, opacity: null });

export function ElementRows({
  project,
  item,
  start,
  ppf,
  elements,
  editable,
}: {
  project: ProjectModel;
  item: Item;
  start: number;
  ppf: number;
  elements: ReadonlyArray<GraphicElement>;
  editable: boolean;
}) {
  const selected = usePlayback((s) => (s.selected === item.id ? s.element : undefined));
  const draft = usePlayback((s) => s.draft);
  const shown = (draft && draft.base === project && findItem(draft.project, item.id)?.item) || item;
  const blocks = elementBlocks(shown, elements);
  const rows = blocks.reduce((n, b) => Math.max(n, b.row + 1), 0);

  const press = (e: React.PointerEvent, block: ElementBlock) => {
    if (e.button !== 0 || getTool() !== "select") return;
    e.stopPropagation();
    playback.selectElement(item.id, block.element.key);
    const grip = ((e.target as HTMLElement).dataset.grip as Grip | undefined) ?? "move";
    const snapshot = getState().snapshot;
    if (!editable || !snapshot) return;
    const origin = { baseRevision: snapshot.revision, dir: snapshot.dir };
    const x0 = e.clientX;
    const targets = [Math.round(getPlayback().frame) - start, ...blocks.filter((b) => b !== block).flatMap((b) => [b.from, b.to])];
    let moved = false;
    let change: ElementChange | undefined;
    let shownDraft: PreviewDraft | undefined;
    const plan = () => planElementEdit(item, block.element, change!);
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < DRAG_PX) return;
      moved = true;
      const delta = ev.metaKey ? Math.round((ev.clientX - x0) / ppf) : snapped(Math.round((ev.clientX - x0) / ppf), block, grip, targets, ppf);
      change = spanAfter(item, block, grip, delta);
      const result = draftOf(project, [plan()]);
      if (!("project" in result)) return;
      shownDraft = { base: project, project: result.project };
      playback.setDraft(shownDraft);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    const clear = () => {
      if (shownDraft && getPlayback().draft === shownDraft) playback.setDraft(undefined);
    };
    const cancel = () => (finish(), clear());
    const up = () => {
      finish();
      if (!moved || !change) {
        seekToElement(start, block.from, block.to);
        return clear();
      }
      void actions.timelineEdit({ ops: [plan()], summary: `Retimed ${block.element.name}` }, origin).finally(clear);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  return (
    <div
      className="el-rows"
      data-testid="element-rows"
      data-item={item.id}
      data-rows={rows}
      style={{
        left: start * ppf,
        width: Math.max(4, item.duration * ppf - 2),
        maxHeight: MAX_ROWS * ROW_HEIGHT,
        height: Math.min(rows, MAX_ROWS) * ROW_HEIGHT,
      }}
    >
      <div className="el-rows-inner" style={{ height: rows * ROW_HEIGHT }}>
        {blocks.map((block) => {
          const width = Math.max(3, (block.to - block.from) * ppf - 1);
          return (
            <div
              key={block.element.key}
              className={`el-block ${block.element.kind} ${selected === block.element.key ? "selected" : ""} ${item.elements?.[block.element.key] ? "edited" : ""}`}
              data-testid="element-block"
              data-element={block.element.key}
              data-from={start + block.from}
              data-to={start + block.to}
              data-row={block.row}
              title={`${block.element.name}, ${((block.to - block.from) / project.canvas.fps).toFixed(1)} s`}
              style={{ left: block.from * ppf, width, top: block.row * ROW_HEIGHT }}
              onPointerDown={(e) => press(e, block)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                playback.selectElement(item.id, block.element.key);
                if (editable) openMenu(e.clientX, e.clientY, elementMenu(project, item, block.element), "Element");
              }}
            >
              {width > 26 && <span className="el-name">{block.element.name}</span>}
              {editable && width > 10 && (
                <>
                  <span className="el-grip start" data-grip="start" data-testid="element-trim-start" />
                  <span className="el-grip end" data-grip="end" data-testid="element-trim-end" />
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
