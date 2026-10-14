// The left rail: the library's tabs. D209 (issue #26): a plain drag (past a few pixels) moves a tab,
// a line shows where it lands; a click still switches. Right-click: Move up, Move down, Hide, and
// Reset order (which also shows the hidden ones). Hidden tabs are in the More menu at the end. The
// order and the hidden ones are remembered on this Mac (S2, D117).
import { AudioWaveform, Blend, CircleDot, Ellipsis, Film, Music, Palette, ScrollText, Shapes, Sparkles, SwatchBook, Type, type LucideIcon } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";

import type { LibraryTab } from "../panels/Library.tsx";
import { openMenu, type MenuItems } from "../timeline/ContextMenu.tsx";
import { loadHidden, loadRail, moveInRail, RAIL_HIDDEN_KEY, RAIL_KEY } from "./layout.ts";

/** Pixels a press moves before it's a drag, not a click. */
export const DRAG_THRESHOLD = 5;

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
  // D186: brand kits and skills, and the ones this project uses (a saved order gets it at the end).
  { id: "brand", label: "Brand", title: "Brand kits and skills", icon: SwatchBook },
];
const IDS = TABS.map((t) => t.id);
const info = (id: LibraryTab) => TABS.find((t) => t.id === id)!;

export function Rail({ tab, onTab }: { tab: LibraryTab; onTab: (tab: LibraryTab) => void }) {
  const [order, setOrder] = useState<Array<LibraryTab>>(() => loadRail(IDS));
  const [hidden, setHidden] = useState<Array<LibraryTab>>(() => loadHidden(IDS));
  // The tab being dragged and the one it would land before ("" = the end).
  const [drag, setDrag] = useState<{ id: LibraryTab; before: LibraryTab | "" } | undefined>();
  // A drag just ended: the click that follows the release doesn't switch tabs.
  const swallowClick = useRef(false);
  const nav = useRef<HTMLElement>(null);

  const saveOrder = (next: Array<LibraryTab>) => {
    setOrder(next);
    localStorage.setItem(RAIL_KEY, JSON.stringify(next));
  };
  const saveHidden = (next: Array<LibraryTab>) => {
    setHidden(next);
    if (next.length) localStorage.setItem(RAIL_HIDDEN_KEY, JSON.stringify(next));
    else localStorage.removeItem(RAIL_HIDDEN_KEY);
  };
  const reset = () => {
    localStorage.removeItem(RAIL_KEY);
    localStorage.removeItem(RAIL_HIDDEN_KEY);
    setOrder(loadRail(IDS));
    setHidden([]);
  };
  // Settings › App › Reset tab order.
  useEffect(() => {
    const onReset = () => reset();
    window.addEventListener("uncut:rail-reset", onReset);
    return () => window.removeEventListener("uncut:rail-reset", onReset);
  }, []);

  const shown = order.filter((id) => !hidden.includes(id));

  /** Where a pointer at clientY would drop: before the first shown tab whose middle is below it. */
  const dropBefore = (y: number, id: LibraryTab): LibraryTab | "" => {
    for (const el of nav.current?.querySelectorAll<HTMLElement>("[data-rail]") ?? []) {
      const r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) return el.dataset.rail as LibraryTab;
    }
    return id === shown.at(-1) ? id : "";
  };

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>, id: LibraryTab) => {
    if (e.button !== 0) return;
    const button = e.currentTarget;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let active = false;
    let before: LibraryTab | "" = id;
    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD) return;
        active = true;
        try {
          button.setPointerCapture(e.pointerId);
        } catch {}
      }
      before = dropBefore(ev.clientY, id);
      setDrag({ id, before });
    };
    const up = () => {
      cleanup();
      if (!active) return;
      swallowClick.current = true;
      setTimeout(() => (swallowClick.current = false), 0);
      setDrag(undefined);
      // Dropped right where it was (before itself or the next one): nothing moves.
      const target = before === "" ? undefined : before;
      if (target === id) return;
      const next = moveInRail(order, id, target);
      if (next.join() !== order.join()) saveOrder(next);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    const cancel = () => {
      cleanup();
      setDrag(undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  const menuFor = (id: LibraryTab): MenuItems => {
    const i = shown.indexOf(id);
    const step = (by: -1 | 1) => {
      const neighbour = shown[i + by];
      if (!neighbour) return;
      // Up: before the one above; down: before the one after the one below.
      saveOrder(moveInRail(order, id, by < 0 ? neighbour : shown[i + 2]));
    };
    return [
      { id: "rail-up", label: "Move up", disabled: i <= 0, run: () => step(-1) },
      { id: "rail-down", label: "Move down", disabled: i < 0 || i >= shown.length - 1, run: () => step(1) },
      "-",
      { id: "rail-hide", label: `Hide ${info(id).label}`, disabled: shown.length <= 1, run: () => saveHidden([...hidden, id]) },
      { id: "rail-reset", label: "Reset order", run: reset },
    ];
  };

  const moreMenu = (): MenuItems => [
    ...hidden.map((id) => ({ id: `rail-open-${id}`, label: info(id).title, checked: tab === id, run: () => onTab(id) })),
    "-",
    ...hidden.map((id) => ({ id: `rail-show-${id}`, label: `Show ${info(id).label} in the rail`, run: () => saveHidden(hidden.filter((h) => h !== id)) })),
    { id: "rail-reset", label: "Reset order", run: reset },
  ];

  return (
    <nav className={`rail ${drag ? "dragging" : ""}`} ref={nav} data-testid="rail" data-order={order.join(",")} data-hidden={hidden.join(",")}>
      {shown.map((id) => {
        const t = info(id);
        const Icon = t.icon;
        return (
          <button
            key={id}
            className={`${tab === id ? "active" : ""} ${drag?.id === id ? "lifted" : ""} ${drag && drag.before === id && drag.id !== id ? "drop-before" : ""}`}
            data-testid={`rail-${id}`}
            data-rail={id}
            title={t.title}
            onPointerDown={(e) => onPointerDown(e, id)}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e.clientX, e.clientY, menuFor(id), `${t.label} tab`);
            }}
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
      {drag && drag.before === "" && <div className="rail-drop-end" data-testid="rail-drop-indicator" />}
      {hidden.length > 0 && (
        <button
          className={`rail-more ${hidden.includes(tab) ? "active" : ""}`}
          data-testid="rail-more"
          title={`More: ${hidden.map((id) => info(id).label).join(", ")}`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.right + 4, r.top, moreMenu(), "More tabs");
          }}
        >
          <Ellipsis />
          <span>More</span>
        </button>
      )}
    </nav>
  );
}
