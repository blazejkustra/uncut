// The timeline's right-click menu (T7, D126): an in-app menu that looks and behaves like a native
// one (opens at the pointer, kept inside the window, ↑/↓/Home/End move, → opens a submenu, ← and Esc
// close, Enter/Space choose, typing a letter jumps to the next entry with it), so the app tests and
// the remote browser get the same menu. One menu open at a time, from anywhere (openMenu).
import { Check, ChevronRight } from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

export interface MenuEntry {
  readonly id: string;
  readonly label: string;
  readonly shortcut?: string;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly danger?: boolean;
  readonly run?: () => void;
  readonly submenu?: ReadonlyArray<MenuEntry | "-">;
}
export type MenuItems = ReadonlyArray<MenuEntry | "-">;

let open: { x: number; y: number; items: MenuItems; label: string } | undefined;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};
/** Open a menu at a point (client px). */
export function openMenu(x: number, y: number, items: MenuItems, label = "Menu") {
  open = { x, y, items, label };
  notify();
}
export const closeMenu = () => {
  if (!open) return;
  open = undefined;
  notify();
};
const useOpenMenu = () => useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), () => open);

/** Mounted once (in the editor): draws the open menu, if any. */
export function ContextMenuHost() {
  const menu = useOpenMenu();
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.(".ctx-menu")) closeMenu();
    };
    const resize = () => closeMenu();
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", resize);
    };
  }, [menu]);
  if (!menu) return null;
  return <MenuList key={`${menu.x},${menu.y}`} items={menu.items} x={menu.x} y={menu.y} label={menu.label} level={0} onClose={closeMenu} />;
}

const enabled = (items: MenuItems) => items.map((e, i) => (e !== "-" && !e.disabled ? i : -1)).filter((i) => i >= 0);

function MenuList({ items, x, y, label, level, onClose, onBack }: { items: MenuItems; x: number; y: number; label: string; level: number; onClose: () => void; onBack?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [active, setActiveState] = useState(level > 0 ? (enabled(items)[0] ?? -1) : -1);
  // Keys can come faster than renders (type-ahead): they read the latest entry from here.
  const activeRef = useRef(active);
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined);
  const setActive = (i: number) => {
    activeRef.current = i;
    setActiveState(i);
  };
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | undefined>();
  // Kept inside the window: flipped left / up when it would run off.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = x + r.width > window.innerWidth - 4 ? Math.max(4, (level > 0 ? x - r.width - 180 : x - r.width)) : x;
    const ny = y + r.height > window.innerHeight - 4 ? Math.max(4, window.innerHeight - r.height - 4) : y;
    setPos({ x: nx, y: ny });
    el.focus();
  }, [x, y, level]);
  const choose = (index: number) => {
    const entry = items[index];
    if (!entry || entry === "-" || entry.disabled) return;
    if (entry.submenu) {
      const row = ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]")[index];
      const r = row?.getBoundingClientRect();
      setSub({ index, x: (r?.right ?? pos.x) + 2, y: (r?.top ?? pos.y) - 4 });
      return;
    }
    onClose();
    entry.run?.();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (sub) return;
    const list = enabled(items);
    const active = activeRef.current;
    const at = list.indexOf(active);
    const stop = () => (e.preventDefault(), e.stopPropagation());
    if (e.key === "ArrowDown") (stop(), setActive(list[(at + 1) % list.length] ?? -1));
    else if (e.key === "ArrowUp") (stop(), setActive(list[(at - 1 + list.length) % list.length] ?? -1));
    else if (e.key === "Home") (stop(), setActive(list[0] ?? -1));
    else if (e.key === "End") (stop(), setActive(list.at(-1) ?? -1));
    else if (e.key === "Enter" || e.key === " ") (stop(), active >= 0 && choose(active));
    else if (e.key === "ArrowRight") {
      stop();
      const entry = items[active];
      if (entry && entry !== "-" && entry.submenu) choose(active);
    } else if (e.key === "ArrowLeft" && onBack) (stop(), onBack());
    else if (e.key === "Escape") (stop(), onBack ? onBack() : onClose());
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      // Type-ahead: the next entry starting with that letter.
      const k = e.key.toLowerCase();
      const order = [...list.slice(at + 1), ...list.slice(0, at + 1)];
      const hit = order.find((i) => (items[i] as MenuEntry).label.toLowerCase().startsWith(k));
      if (hit !== undefined) (stop(), setActive(hit));
    }
  };
  const subEntry = sub ? (items[sub.index] as MenuEntry) : undefined;
  return (
    <>
      <div
        className="ctx-menu"
        role="menu"
        aria-label={label}
        data-testid={level === 0 ? "context-menu" : "context-submenu"}
        tabIndex={-1}
        ref={ref}
        style={{ left: pos.x, top: pos.y }}
        onKeyDown={onKey}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((entry, i) =>
          entry === "-" ? (
            <div key={`sep-${i}`} className="ctx-sep" role="separator" />
          ) : (
            <div
              key={entry.id}
              role={entry.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={entry.checked}
              aria-disabled={entry.disabled || undefined}
              aria-haspopup={entry.submenu ? "menu" : undefined}
              data-testid={`menu-${entry.id}`}
              className={`ctx-item ${i === active ? "active" : ""} ${entry.disabled ? "disabled" : ""} ${entry.danger ? "danger" : ""}`}
              onPointerMove={(e) => {
                // Only a pointer that really moves takes over: a menu opened from the keyboard can
                // appear under a resting pointer (the browser then sends moves without movement).
                const last = pointer.current;
                pointer.current = { x: e.clientX, y: e.clientY };
                if (!last || (last.x === e.clientX && last.y === e.clientY) || activeRef.current === i) return;
                setActive(entry.disabled ? -1 : i);
                if (entry.submenu && !entry.disabled) choose(i);
                else setSub(undefined);
              }}
              onClick={() => choose(i)}
            >
              <span className="ctx-check">{entry.checked && <Check />}</span>
              <span className="ctx-label">{entry.label}</span>
              {entry.shortcut && <span className="ctx-key">{entry.shortcut}</span>}
              {entry.submenu && <ChevronRight className="ctx-more" />}
            </div>
          ),
        )}
      </div>
      {sub && subEntry?.submenu && (
        <MenuList
          items={subEntry.submenu}
          x={sub.x}
          y={sub.y}
          label={subEntry.label}
          level={level + 1}
          onClose={onClose}
          onBack={() => {
            setSub(undefined);
            ref.current?.focus();
          }}
        />
      )}
    </>
  );
}
