// The left rail: the library's tabs. A long press (LONG_PRESS_MS without moving) picks a tab up;
// dragging it over another moves it there; the order is remembered on this Mac (S2, D117).
import { AudioWaveform, Blend, CircleDot, Film, Music, Palette, ScrollText, Shapes, Sparkles, Type, type LucideIcon } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";

import type { LibraryTab } from "../panels/Library.tsx";
import { loadRail, RAIL_KEY } from "./layout.ts";

export const LONG_PRESS_MS = 350;

const TABS: ReadonlyArray<{ readonly id: LibraryTab; readonly label: string; readonly title: string; readonly icon: LucideIcon }> = [
  { id: "media", label: "Media", title: "Media", icon: Film },
  // U11 (D177): the transcript of what's said on the main track, next to the media it comes from.
  { id: "transcript", label: "Transcript", title: "Transcript", icon: ScrollText },
  { id: "text", label: "Text", title: "Text", icon: Type },
  { id: "elements", label: "Elements", title: "Elements", icon: Shapes },
  { id: "audio", label: "Audio", title: "Audio", icon: Music },
  { id: "sfx", label: "Sounds", title: "Sound effects", icon: AudioWaveform },
  { id: "transitions", label: "Transitions", title: "Transitions", icon: Blend },
  { id: "effects", label: "Effects", title: "Filters and effects", icon: Palette },
  { id: "capture", label: "Capture", title: "Capture", icon: CircleDot },
  { id: "generate", label: "Generate", title: "Generate", icon: Sparkles },
];
export function Rail({ tab, onTab }: { tab: LibraryTab; onTab: (tab: LibraryTab) => void }) {
  const [order, setOrder] = useState<Array<LibraryTab>>(() => loadRail(TABS.map((t) => t.id)));
  const [lifted, setLifted] = useState<LibraryTab | undefined>();
  // A long press just ended in a drag: the click that follows the release doesn't switch tabs.
  const swallowClick = useRef(false);
  // Settings › App › Reset tab order.
  useEffect(() => {
    const reset = () => setOrder(loadRail(TABS.map((t) => t.id)));
    window.addEventListener("uncut:rail-reset", reset);
    return () => window.removeEventListener("uncut:rail-reset", reset);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>, id: LibraryTab) => {
    if (e.button !== 0) return;
    const button = e.currentTarget;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let active = false;
    let current = order;
    const timer = window.setTimeout(() => {
      active = true;
      setLifted(id);
      button.setPointerCapture(e.pointerId);
    }, LONG_PRESS_MS);
    const move = (ev: PointerEvent) => {
      if (!active) {
        // Moving before the press is long enough: an ordinary click or nothing.
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6) cleanup();
        return;
      }
      const over = document.elementsFromPoint(ev.clientX, ev.clientY).find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.rail !== undefined && el.dataset.rail !== id);
      const target = over?.dataset.rail as LibraryTab | undefined;
      if (!target) return;
      const next = current.filter((t) => t !== id);
      const at = next.indexOf(target);
      const r = over!.getBoundingClientRect();
      next.splice(ev.clientY > r.top + r.height / 2 ? at + 1 : at, 0, id);
      if (next.join() === current.join()) return;
      current = next;
      setOrder(next);
    };
    const up = () => {
      if (active) {
        swallowClick.current = true;
        setTimeout(() => (swallowClick.current = false), 0);
        localStorage.setItem(RAIL_KEY, JSON.stringify(current));
      }
      cleanup();
    };
    const cleanup = () => {
      clearTimeout(timer);
      setLifted(undefined);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <nav className="rail" data-testid="rail" data-order={order.join(",")}>
      {order.map((id) => {
        const t = TABS.find((x) => x.id === id)!;
        const Icon = t.icon;
        return (
          <button
            key={id}
            className={`${tab === id ? "active" : ""} ${lifted === id ? "lifted" : ""}`}
            data-testid={`rail-${id}`}
            data-rail={id}
            title={t.title}
            onPointerDown={(e) => onPointerDown(e, id)}
            onClick={() => {
              if (swallowClick.current) return void (swallowClick.current = false);
              onTab(id);
            }}
          >
            <Icon />
            <span>{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
