// Region references (issue #118, like a comment pinned to part of the picture): with the transport's
// Area tool on, a drag over the frame draws a rectangle; on release it goes to the chat as a chip at
// the playhead's frame, or over In to Out when they're set. The chips still in the composer are drawn
// on the preview (a dashed box with their label) while the frame shown is in their time.
import { useEffect, useState } from "react";
import type React from "react";
import { momentLabel } from "@uncut/core/mentions";

import { usePlayback } from "../playback.ts";
import { actions, useAppSelect } from "../../state/store.ts";
import type { ProjectModel } from "../../state/project.ts";

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

// A drag shorter than this (screen px) on either side is a click: nothing is picked.
const MIN_PX = 6;

/** The drag catcher over the frame while the Area tool is on, and the choice once a rectangle is drawn. */
export function RegionSelect({ project, onDone }: { project: ProjectModel; onDone: () => void }) {
  const { width, height, fps } = project.canvas;
  // Frame-local screen px while dragging; canvas px once drawn.
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | undefined>();
  const [picked, setPicked] = useState<{ area: Rect; screen: Rect } | undefined>();
  const markIn = usePlayback((s) => s.markIn);
  const markOut = usePlayback((s) => s.markOut);
  const frame = Math.floor(usePlayback((s) => s.frame));
  const local = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(r.width, Math.max(0, e.clientX - r.left)), y: Math.min(r.height, Math.max(0, e.clientY - r.top)), r };
  };
  const box = (d: { x0: number; y0: number; x1: number; y1: number }): Rect => ({ x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) });
  const add = (at: { frame: number } | { start: number; end: number }) => {
    if (picked) actions.addRegionToChat(picked.area, at);
    setPicked(undefined);
    onDone();
  };
  // Esc: the rectangle goes, then the tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (picked) setPicked(undefined);
      else onDone();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [picked, onDone]);
  const hasRange = markIn !== undefined && markOut !== undefined && markOut > markIn;
  const shown = drag ? box(drag) : picked?.screen;
  return (
    <div
      className="pv-region-catch"
      data-testid="region-catch"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const { x, y } = local(e);
        e.currentTarget.setPointerCapture(e.pointerId);
        setPicked(undefined);
        setDrag({ x0: x, y0: y, x1: x, y1: y });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const { x, y } = local(e);
        setDrag({ ...drag, x1: x, y1: y });
      }}
      onPointerUp={(e) => {
        if (!drag) return;
        const { x, y, r } = local(e);
        const screen = box({ ...drag, x1: x, y1: y });
        setDrag(undefined);
        if (screen.w < MIN_PX || screen.h < MIN_PX) return;
        const sx = width / Math.max(1, r.width);
        const sy = height / Math.max(1, r.height);
        setPicked({ screen, area: { x: screen.x * sx, y: screen.y * sy, w: screen.w * sx, h: screen.h * sy } });
      }}
    >
      {shown && <div className="pv-region drawing" data-testid="region-rect" style={{ left: shown.x, top: shown.y, width: shown.w, height: shown.h }} />}
      {picked && (
        <div className="pv-region-pick" data-testid="region-pick" style={{ left: picked.screen.x, top: picked.screen.y + picked.screen.h + 6 }} onPointerDown={(e) => e.stopPropagation()}>
          <button className="btn primary" data-testid="region-add-frame" onClick={() => add({ frame })}>
            Add to chat at {momentLabel(frame, fps)}
          </button>
          {hasRange && (
            <button className="btn" data-testid="region-add-range" onClick={() => add({ start: markIn!, end: markOut! })}>
              In to Out ({momentLabel(markIn!, fps)}–{momentLabel(markOut!, fps)})
            </button>
          )}
          <button className="btn ghost" data-testid="region-cancel" onClick={() => setPicked(undefined)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/** The region chips still in the composer, on the preview while the frame shown is in their time. */
export function RegionPins({ project }: { project: ProjectModel }) {
  const mentions = useAppSelect((s) => s.agentMentions);
  const draft = useAppSelect((s) => s.agentDraft);
  const shownFrame = usePlayback((s) => (!s.playing && s.hover !== undefined ? s.hover : Math.floor(s.frame)));
  const { width, height } = project.canvas;
  const pins = mentions.filter((m) => m.kind === "region" && m.area && draft.includes(`@${m.label}`));
  if (!pins.length) return null;
  return (
    <>
      {pins.map((m) => {
        const a = m.area!;
        const on = m.range ? shownFrame >= m.range.start && shownFrame < m.range.end : shownFrame === m.frame;
        if (!on) return null;
        return (
          <div
            key={m.id + m.label}
            className="pv-region pin"
            data-testid="region-pin"
            data-label={m.label}
            style={{ left: `${(a.x / width) * 100}%`, top: `${(a.y / height) * 100}%`, width: `${(a.w / width) * 100}%`, height: `${(a.h / height) * 100}%` }}
          >
            <span>{m.label}</span>
          </div>
        );
      })}
    </>
  );
}
