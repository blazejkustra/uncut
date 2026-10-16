import { Lock, Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  ACTIONS,
  actionDef,
  assignKey,
  bindingsOf,
  checkKey,
  choosePreset,
  clearAction,
  conflicts,
  isActionId,
  keymap,
  keyOf,
  presetBindings,
  PRESETS,
  removeKey,
  resetAction,
  setRecordingKey,
  useBindings,
  useKeymap,
  type ActionDef,
  type ActionId,
  type Check,
  type PresetId,
} from "../editor/keymap.ts";
import { actions } from "../state/store.ts";
import "./shortcuts.css";

const GROUPS = [...new Set(ACTIONS.map((a) => a.group))];
const does = (id: ActionId) => actionDef(id).does;

/** The shortcuts table (G3) for the sheet: every row with its current keys, grouped. */
export function ShortcutList() {
  const bindings = useBindings();
  return (
    <div className="shortcut-list" data-testid="shortcut-list">
      {GROUPS.map((g) => (
        <div key={g} className="shortcut-group">
          <div className="group-label">{g}</div>
          {ACTIONS.filter((a) => a.group === g).map((a) => {
            const keys = isActionId(a.id) ? bindings[a.id] : a.keys;
            return (
              <div key={a.id} className="shortcut-row" data-testid="shortcut-row" data-action={a.id}>
                <span className="shortcut-does">{a.does}</span>
                <span className="shortcut-keys">{keys.length ? keys.map((k) => <kbd key={k}>{k}</kbd>) : <span className="shortcut-none">None</span>}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Where a new key is going: in place of the key at `slot`, or one more. */
type Recording = { readonly action: ActionId; readonly slot?: number };
/** A key that ran into another action or the menu, waiting for the user's choice. */
type Pending = Recording & { readonly key: string; readonly check: Exclude<Check, { kind: "ok" } | { kind: "same" }> };

/**
 * Settings › Shortcuts (#78, D257): a preset, then every action with its keys. A key clicked (or
 * +) listens for a new one; Esc or a click elsewhere stops listening. A key another action has asks
 * to swap or replace; a menu key is refused. Each row clears or goes back to the preset's keys.
 */
export function ShortcutSettings() {
  const state = useKeymap();
  const bindings = bindingsOf(state);
  const base = presetBindings(state.preset);
  const [recording, setRecording] = useState<Recording | undefined>(undefined);
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const listening = useRef<HTMLDivElement>(null);
  const clashes = conflicts(bindings);
  const customised = Object.keys(state.overrides).length > 0;

  useEffect(() => {
    if (!recording) return;
    setRecordingKey(true);
    const onKey = (e: KeyboardEvent) => {
      // Every key is ours while listening: nothing else (the editor, the menu's keys, Settings' Esc) sees it.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (e.key === "Escape" && !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) return setRecording(undefined);
      const key = keyOf(e);
      if (!key) return;
      const now = keymap.get();
      const check = checkKey(bindingsOf(now), recording.action, key);
      setRecording(undefined);
      if (check.kind === "ok") keymap.set(assignKey(now, recording.action, key, recording.slot));
      else if (check.kind !== "same") setPending({ ...recording, key, check });
    };
    const onUp = (e: KeyboardEvent) => e.stopImmediatePropagation();
    const onDown = (e: PointerEvent) => {
      if (!listening.current?.contains(e.target as Node | null)) setRecording(undefined);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      setRecordingKey(false);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [recording]);

  const record = (action: ActionId, slot?: number) => (setPending(undefined), setRecording({ action, slot }));
  const resolve = (how: "swap" | "replace") => {
    if (!pending) return;
    keymap.set(assignKey(keymap.get(), pending.action, pending.key, pending.slot, how));
    setPending(undefined);
  };

  const row = (a: ActionDef) => {
    if (!isActionId(a.id)) {
      return (
        <div key={a.id} className="shortcut-row fixed" data-testid="shortcut-row" data-action={a.id}>
          <span className="shortcut-does">{a.does}</span>
          <span className="shortcut-keys">
            {a.keys.map((k) => (
              <kbd key={k}>{k}</kbd>
            ))}
            <span className="shortcut-lock" title={a.fixed === "menu" ? "Set by the menu: can't be changed" : a.fixed === "pointer" ? "A mouse or trackpad gesture" : "Only in the full-screen preview"}>
              <Lock />
            </span>
          </span>
        </div>
      );
    }
    const id = a.id;
    const keys = bindings[id];
    const live = recording?.action === id;
    const changed = state.overrides[id] !== undefined;
    const clash = clashes.some((c) => c.actions.includes(id));
    return (
      <div key={id} className={`shortcut-edit${live ? " live" : ""}`} data-testid="shortcut-row" data-action={id} ref={live ? listening : undefined}>
        <div className="shortcut-row">
          <span className="shortcut-does">
            {a.does}
            {changed && <span className="shortcut-changed" title={`Changed from ${base[id].join(", ") || "none"}`} />}
          </span>
          <span className="shortcut-keys">
            {keys.map((k, i) =>
              live && recording?.slot === i ? (
                <span key={k} className="shortcut-listening" data-testid="shortcut-recording">
                  Press a key…
                </span>
              ) : (
                <span key={k} className={`shortcut-chip${clash && clashes.some((c) => c.key === k) ? " clash" : ""}`}>
                  <button className="shortcut-key" data-testid="shortcut-key" data-key={k} title="Click, then press a new key" onClick={() => record(id, i)}>
                    {k}
                  </button>
                  <button className="shortcut-remove" data-testid="shortcut-remove" title={`Remove ${k}`} aria-label={`Remove ${k}`} onClick={() => (setPending(undefined), keymap.set(removeKey(keymap.get(), id, i)))}>
                    <X />
                  </button>
                </span>
              ),
            )}
            {live && recording?.slot === undefined ? (
              <span className="shortcut-listening" data-testid="shortcut-recording">
                Press a key…
              </span>
            ) : (
              <button className="icon-btn shortcut-add" data-testid="shortcut-add" title={keys.length ? "Add another key" : "Set a key"} aria-label="Add a key" onClick={() => record(id)}>
                <Plus />
              </button>
            )}
            <button className="link-btn shortcut-clear" data-testid="shortcut-clear" disabled={!keys.length} onClick={() => (setPending(undefined), keymap.set(clearAction(keymap.get(), id)))}>
              Clear
            </button>
            <button className="icon-btn shortcut-reset" data-testid="shortcut-reset" disabled={!changed} title={`Back to ${base[id].join(", ") || "no key"}`} aria-label="Reset" onClick={() => (setPending(undefined), keymap.set(resetAction(keymap.get(), id)))}>
              <RotateCcw />
            </button>
          </span>
        </div>
        {live && <div className="shortcut-hint">Press the new key (Esc cancels).</div>}
        {pending?.action === id && (
          <div className="shortcut-conflict" data-testid="shortcut-conflict" role="alert">
            {pending.check.kind === "reserved" ? (
              <>
                <span className="grow">
                  <kbd>{pending.key}</kbd> is {pending.check.by}, set by the menu. Pick another key.
                </span>
                <button className="btn" onClick={() => record(id, pending.slot)}>
                  Try again
                </button>
                <button className="btn" onClick={() => setPending(undefined)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span className="grow">
                  <kbd>{pending.key}</kbd> is already {does(pending.check.by)}.
                </span>
                {pending.slot !== undefined && keys[pending.slot] !== undefined && (
                  <button className="btn" data-testid="shortcut-swap" title={`${does(pending.check.by)} gets ${keys[pending.slot]}`} onClick={() => resolve("swap")}>
                    Swap
                  </button>
                )}
                <button className="btn primary" data-testid="shortcut-replace" title={`${does(pending.check.by)} loses ${pending.key}`} onClick={() => resolve("replace")}>
                  Replace
                </button>
                <button className="btn" data-testid="shortcut-cancel" onClick={() => setPending(undefined)}>
                  Cancel
                </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="shortcut-settings" data-testid="shortcut-settings">
      <div className="shortcut-head">
        <label className="shortcut-preset">
          Preset
          <select data-testid="shortcut-preset" value={state.preset} onChange={(e) => (setPending(undefined), setRecording(undefined), keymap.set(choosePreset(e.target.value as PresetId)))}>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {customised && <span className="muted small" data-testid="shortcut-customised">Customised</span>}
        <span className="grow" />
        <button className="btn" data-testid="shortcuts-reset-all" disabled={!customised} title="Drop your changes and use the preset's keys" onClick={() => (setPending(undefined), keymap.set(choosePreset(state.preset)))}>
          Reset all
        </button>
      </div>
      <p className="shortcut-lead">Choosing a preset replaces your changes. Actions the preset has no key for keep Uncut's. Keys set by the menu can't be changed.</p>
      {clashes.length > 0 && (
        <div className="shortcut-clashes" data-testid="shortcut-conflicts" role="status">
          {clashes.map((c) => (
            <div key={c.key}>
              <kbd>{c.key}</kbd> is used by {[...c.actions.map(does), ...(c.reserved ? [`${c.reserved} (menu)`] : [])].join(" and ")}.
            </div>
          ))}
        </div>
      )}
      <div className="shortcut-list" data-testid="shortcut-list">
        {GROUPS.map((g) => (
          <div key={g} className="shortcut-group">
            <div className="group-label">{g}</div>
            {ACTIONS.filter((a) => a.group === g).map(row)}
          </div>
        ))}
      </div>
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
