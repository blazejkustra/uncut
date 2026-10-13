import { X } from "lucide-react";
import { useEffect } from "react";

import { SHORTCUTS, type Shortcut } from "../editor/keys.ts";
import { actions } from "../state/store.ts";

/** The shortcuts table (G3): the same list as the keys do, grouped. */
export function ShortcutList() {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <div className="shortcut-list" data-testid="shortcut-list">
      {groups.map((g) => (
        <div key={g} className="shortcut-group">
          <div className="group-label">{g}</div>
          {SHORTCUTS.filter((s) => s.group === g).map((s: Shortcut) => (
            <div key={s.does} className="shortcut-row" data-testid="shortcut-row">
              <span className="shortcut-does">{s.does}</span>
              <span className="shortcut-keys">
                {s.keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The Keyboard shortcuts sheet: Help › Keyboard Shortcuts or ?; Esc or a click outside closes it. */
export function ShortcutsSheet() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      actions.closeShortcuts();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <div className="modal-layer" data-testid="shortcuts-sheet" onPointerDown={(e) => e.target === e.currentTarget && actions.closeShortcuts()}>
      <div className="modal sheet">
        <div className="sheet-head">
          <span className="grow">Keyboard shortcuts</span>
          <button className="icon-btn" title="Close (Esc)" data-testid="shortcuts-close" onClick={actions.closeShortcuts}>
            <X />
          </button>
        </div>
        <ShortcutList />
      </div>
    </div>
  );
}
