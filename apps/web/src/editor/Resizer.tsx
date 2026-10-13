import type React from "react";

import { layout, type PanelSize } from "./layout.ts";

/**
 * A drag handle on a panel's edge (G5): the left panel's right edge, the inspector's left edge,
 * the timeline's top edge. Dragging resizes live; the size is saved on release; a double click
 * puts the default back.
 */
export function Resizer({ panel }: { panel: PanelSize }) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const app = handle.closest<HTMLElement>(".app");
    const rect = app?.getBoundingClientRect() ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    // The left panel starts after the rail; its width is measured from there.
    const libLeft = app?.querySelector(".library")?.getBoundingClientRect().left ?? rect.left + 56;
    const sizeAt = (ev: { clientX: number; clientY: number }) => (panel === "lib" ? ev.clientX - libLeft : panel === "side" ? rect.right - ev.clientX : rect.bottom - ev.clientY);
    const move = (ev: PointerEvent) => layout.set(panel, sizeAt(ev), false);
    const up = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      document.body.classList.remove("resizing");
      layout.set(panel, sizeAt(ev), true);
    };
    document.body.classList.add("resizing");
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  return <div className={`resizer ${panel === "bottom" ? "h" : "v"} resizer-${panel}`} data-testid={`resize-${panel}`} title="Drag to resize, double-click to reset" onPointerDown={onPointerDown} onDoubleClick={() => layout.reset(panel)} />;
}
