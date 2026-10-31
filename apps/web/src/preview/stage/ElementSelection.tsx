// The selected element of a graphic on the canvas (D316): its box, asked of the graphic's document
// because only the page knows where its script put it, and a drag that moves it. A press on a
// graphic picks the element under it the same way.
import { boxOnCanvas, fromCanvas, planElementEdit, type ElementBox } from "@uncut/core/graphicElements";
import React, { useLayoutEffect, useState } from "react";

import type { ProjectModel } from "../../state/project.ts";
import { actions, getState } from "../../state/store.ts";
import { draftOf, findItem } from "../../timeline/edit.ts";
import { elementBasis, elementsOf, noteElementBasis, selectedElement } from "../../timeline/graphicElements.ts";
import { getPlayback, playback, usePlayback, type PreviewDraft } from "../playback.ts";

interface Answer {
  readonly key?: string;
  readonly rect?: ElementBox;
  readonly basis?: unknown;
}

const frameOf = (item: string) => document.querySelector<HTMLIFrameElement>(`.pv-graphic[data-item="${CSS.escape(item)}"] iframe`);
const ASK_MS = 1000;
/** Screen pixels a thin element can be grabbed across, however little it draws. */
const GRAB_PX = 12;
let seq = 0;

/** What a graphic's document answers about a point or an element; undefined if it doesn't. */
function askGraphic(
  item: string,
  ask: { readonly point?: readonly [number, number]; readonly slop?: number; readonly keys?: ReadonlyArray<string>; readonly key?: string },
): Promise<Answer | undefined> {
  const target = frameOf(item)?.contentWindow;
  if (!target) return Promise.resolve(undefined);
  const id = ++seq;
  return new Promise((done) => {
    const finish = (answer?: Answer) => {
      clearTimeout(timer);
      window.removeEventListener("message", on);
      done(answer);
    };
    const on = (e: MessageEvent) => {
      const d = e.data as (Answer & { uncut?: string; seq?: number }) | null;
      if (e.source === target && d?.uncut === "element-answer" && d.seq === id) finish(d);
    };
    const timer = setTimeout(() => finish(), ASK_MS);
    window.addEventListener("message", on);
    target.postMessage({ uncut: "element-ask", seq: id, ...ask }, "*");
  });
}

/** Canvas pixels per screen pixel of a graphic's frame. */
const unitsOf = (iframe: HTMLIFrameElement) => iframe.offsetWidth / Math.max(1, iframe.getBoundingClientRect().width);

/** The topmost graphic's element under a press at client (x, y), selected. False when no graphic has one there. */
export async function pickElement(project: ProjectModel, x: number, y: number) {
  const wraps = [...document.querySelectorAll<HTMLElement>(".pv-graphic[data-item]")]
    .filter((w) => w.style.visibility !== "hidden" && w.querySelector("iframe")?.style.opacity !== "0")
    .sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex));
  for (const wrap of wraps) {
    const placed = findItem(project, wrap.dataset.item);
    const known = placed ? elementsOf(placed.item) : undefined;
    const iframe = wrap.querySelector("iframe");
    if (!placed || known?.status !== "ready" || !iframe) continue;
    const box = iframe.getBoundingClientRect();
    const units = unitsOf(iframe);
    const keys = known.elements.filter((e) => !placed.item.elements?.[e.key]?.hidden).map((e) => e.key);
    const answer = await askGraphic(placed.item.id, { point: [(x - box.left) * units, (y - box.top) * units], slop: (GRAB_PX / 2) * units, keys });
    if (answer?.key) {
      playback.selectElement(placed.item.id, answer.key);
      return true;
    }
  }
  return false;
}

export function ElementSelection({ project }: { project: ProjectModel }) {
  const selected = usePlayback((s) => s.selected);
  const key = usePlayback((s) => s.element);
  const frame = usePlayback((s) => Math.round(s.frame));
  const draft = usePlayback((s) => s.draft);
  const [box, setBox] = useState<ElementBox | undefined>();
  useLayoutEffect(() => {
    if (selected === undefined || key === undefined) return setBox(undefined);
    let live = true;
    const measure = () =>
      void askGraphic(selected, { key }).then((answer) => {
        if (!live) return;
        setBox(boxOnCanvas(answer?.rect, project.canvas));
        noteElementBasis(selected, key, answer?.basis);
      });
    const again = setTimeout(measure, 150);
    measure();
    return () => {
      live = false;
      clearTimeout(again);
    };
  }, [selected, key, frame, draft, project]);
  if (!box) return null;

  const press = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const found = selectedElement(project);
    const iframe = found ? frameOf(found.item.id) : null;
    const snapshot = getState().snapshot;
    const lane = found && findItem(project, found.item.id);
    if (!found || !iframe || !snapshot || !lane || lane.track.locked || found.item.locked) return;
    const units = unitsOf(iframe);
    const basis = elementBasis(found.item.id, found.element.key);
    const edit = found.item.elements?.[found.element.key];
    const x0 = e.clientX;
    const y0 = e.clientY;
    const origin = { baseRevision: snapshot.revision, dir: snapshot.dir };
    let shown: PreviewDraft | undefined;
    let change: { x: number; y: number } | undefined;
    const plan = () => planElementEdit(found.item, found.element, change!);
    const move = (ev: PointerEvent) => {
      const [x, y] = fromCanvas(basis, (ev.clientX - x0) * units, (ev.clientY - y0) * units);
      change = { x: (edit?.x ?? 0) + x, y: (edit?.y ?? 0) + y };
      const result = draftOf(project, [plan()]);
      if (!("project" in result)) return;
      shown = { base: project, project: result.project };
      playback.setDraft(shown);
    };
    const clear = () => {
      if (shown && getPlayback().draft === shown) playback.setDraft(undefined);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!change) return clear();
      void actions.timelineEdit({ ops: [plan()], summary: `Moved ${found.element.name}` }, origin).finally(clear);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const iframe = selected === undefined ? null : frameOf(selected);
  const grab = GRAB_PX * (iframe ? unitsOf(iframe) : 1);
  const grabArea = { "--grab-x": `${Math.max(0, (grab - box.width) / 2)}px`, "--grab-y": `${Math.max(0, (grab - box.height) / 2)}px` } as React.CSSProperties;
  return (
    <div
      className="pv-element-sel"
      data-testid="element-selection"
      data-element={key}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height, ...grabArea }}
      onPointerDown={press}
    />
  );
}
