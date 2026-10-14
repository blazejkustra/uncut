// The preview's view (G6, D120): zoom (Fit, or canvas pixels per screen pixel: 0.5, 1, 2…) and
// pan, plus the full-window preview (G7b). Only how the editor shows the canvas: the project and
// the export never see it.
import type React from "react";
import { useEffect, useRef, useState, type RefObject } from "react";

export type PreviewZoom = "fit" | number;
export const ZOOM_STEPS: ReadonlyArray<number> = [0.5, 1, 2];
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

export interface Pan {
  readonly x: number;
  readonly y: number;
}

/**
 * The pan that keeps the canvas point under (cx, cy) (relative to the view's centre) in place when
 * the scale goes from `from` to `to`.
 */
export function zoomAround(pan: Pan, from: number, to: number, cx: number, cy: number): Pan {
  const k = to / from;
  return { x: cx - (cx - pan.x) * k, y: cy - (cy - pan.y) * k };
}

/** Keep at least `keep` px of the picture inside the view. */
export function clampPan(pan: Pan, picture: { w: number; h: number }, view: { w: number; h: number }, keep = 48): Pan {
  const mx = Math.max(0, (picture.w + view.w) / 2 - keep);
  const my = Math.max(0, (picture.h + view.h) / 2 - keep);
  return { x: Math.min(mx, Math.max(-mx, pan.x)), y: Math.min(my, Math.max(-my, pan.y)) };
}

/**
 * Wheel and hand gestures on the preview's area: ⌘ or ctrl + wheel (a trackpad pinch arrives as
 * ctrl + wheel) zooms around the pointer, and is never Electron's page zoom; a plain wheel pans
 * while zoomed in; with the hand on, a drag pans. `fitScale` is the scale Fit would use.
 */
export function useViewport(area: RefObject<HTMLDivElement | null>, fitScale: number) {
  const [zoom, setZoomState] = useState<PreviewZoom>("fit");
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [hand, setHand] = useState(false);
  const scale = zoom === "fit" ? fitScale : zoom;
  const live = useRef({ scale, zoom, pan, fitScale });
  live.current = { scale, zoom, pan, fitScale };

  const setZoom = (z: PreviewZoom) => {
    setZoomState(z);
    if (z === "fit") setPan({ x: 0, y: 0 });
  };

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const now = live.current;
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        if (!(now.fitScale > 0)) return;
        const r = el.getBoundingClientRect();
        const factor = Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.002));
        const to = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, now.scale * factor));
        const cx = e.clientX - (r.left + r.width / 2);
        const cy = e.clientY - (r.top + r.height / 2);
        setPan(zoomAround(now.pan, now.scale, to, cx, cy));
        setZoomState(to);
        return;
      }
      if (now.zoom === "fit") return;
      e.preventDefault();
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [area]);

  /**
   * A press with the hand on, or a middle-button press (U10) at any zoom: drag pans. Returns true
   * when it took the press. Only the view moves; the project never changes.
   */
  const handDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!(e.button === 1 || (hand && e.button === 0))) return false;
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, pan: live.current.pan };
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    target.classList.add("panning");
    const move = (ev: PointerEvent) => setPan({ x: start.pan.x + ev.clientX - start.x, y: start.pan.y + ev.clientY - start.y });
    const up = () => {
      target.classList.remove("panning");
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
    return true;
  };

  return { zoom, scale, pan, hand, setZoom, setHand, handDown };
}
