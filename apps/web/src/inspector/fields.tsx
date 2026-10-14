// The Inspector's shared pieces (split out of panels/ItemEditors.tsx): number fields, sliders,
// colour pickers, tabs and groups, and how an edit is drafted in the preview and sent (one
// project.edit through actions.itemEdit: validated, one ⌘Z, in the agent's next note).
import { resolveColor } from "@uncut/core/render";
import type { Op } from "@uncut/core/types";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { draftOf } from "../timeline/edit.ts";
import { getPlayback, playback, type PreviewDraft } from "../preview/playback.ts";
import { type ProjectModel } from "../state/project.ts";
import { actions, endPreview, getState, previewEdits } from "../state/store.ts";
import { swatches } from "../preview/text.ts";


/** How long typing has to pause before it's saved (it's also saved on blur and ⌘Enter). */
export const TYPING_PAUSE_MS = 800;

export type PlanResult = { readonly ops: ReadonlyArray<Op>; readonly summary: string } | { readonly problem: string };

/** Show a plan's result in the preview without sending it; returns the draft (to drop later). */
export function showDraft(project: ProjectModel, plan: PlanResult): PreviewDraft | undefined {
  if (!("ops" in plan) || !plan.ops.length) return undefined;
  const result = draftOf(project, plan.ops);
  if (!("project" in result)) return undefined;
  const draft = { base: project, project: result.project };
  playback.setDraft(draft);
  return draft;
}
export const dropDraft = (draft: PreviewDraft | undefined) => {
  if (draft && getPlayback().draft === draft) playback.setDraft(undefined);
};

/** The revision and folder an edit is planned against (see actions.itemEdit). */
export const origin = () => ({ baseRevision: getState().snapshot?.revision, dir: getState().snapshot?.dir });

/** Send an edit planned against the newest project; the draft (if any) goes once it's applied. */
export function send(make: (project: ProjectModel) => PlanResult, draft?: PreviewDraft, from = origin()) {
  void actions.itemEdit(make, from).finally(() => dropDraft(draft));
}

/** Pixels the pointer moves before a press on a number field is a scrub, not a click. */
export const SCRUB_THRESHOLD = 3;

const clampTo = (v: number, min: number | undefined, max: number | undefined) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
/** Rounded to the step's decimals (and never more than 6). */
const roundTo = (v: number, step: number) => {
  const decimals = Math.min(6, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
  return Number(v.toFixed(decimals));
};

/**
 * A number field: typed freely, committed on Enter or blur, Esc puts the saved value back.
 * D209 (issue #21): press and drag left or right on the field or its label to scrub it (one step
 * a pixel, ⇧ ten, ⌥ a tenth; the pointer is locked so it never hits the screen's edge). While it
 * drags, the change shows in the preview (its edits are previewed, not sent: previewEdits); the
 * release commits once, one ⌘Z. A press that doesn't move is a click: it focuses for typing.
 * ↑ and ↓ step (⇧ ten) and preview; Enter or blur commits, Esc drops it.
 */
export function NumberField({ label, value, onCommit, testId, placeholder, step = 1, min, max, disabled }: { label: string; value: number | undefined; onCommit: (v: number | undefined) => void; testId: string; placeholder?: string; step?: number; min?: number; max?: number; disabled?: boolean }) {
  const shown = value === undefined ? "" : String(value);
  const [text, setText] = useState(shown);
  const [scrubbing, setScrubbing] = useState(false);
  const editing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // A scrub just ended: the label's click that follows mustn't focus the field.
  const dragged = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(shown);
  }, [shown]);
  const parse = (t: string) => {
    const trimmed = t.trim();
    // A comma is a decimal point too (typed on a Polish keyboard, say); shown values always use ".".
    return trimmed === "" ? undefined : Number(trimmed.replace(",", "."));
  };
  const valid = (n: number | undefined) => n === undefined || (Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max));
  const commit = () => {
    editing.current = false;
    const n = parse(text);
    if (!valid(n) || n === value) {
      endPreview(false);
      return setText(shown);
    }
    onCommit(n);
    endPreview(true);
  };
  /** Shows `n` in the field and its edit in the preview. */
  const preview = (n: number) => {
    setText(String(n));
    previewEdits(() => onCommit(n));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (disabled || e.button !== 0) return;
    const el = input.current;
    if (!el) return;
    // Already typing in it: the press places the caret / selects text as usual.
    if (document.activeElement === el && e.target === el) return;
    e.preventDefault();
    const start = parse(text) ?? value ?? 0;
    const x0 = e.clientX;
    let lastX = e.clientX;
    let travel = 0;
    let moved = false;
    let current = start;
    let locked = false;
    const target = e.currentTarget;
    const move = (ev: PointerEvent) => {
      // Locked, the pointer stays put and reports how far it moved; else follow it.
      if (!moved && Math.abs(ev.clientX - x0) < SCRUB_THRESHOLD) return;
      // The travel up to the threshold counts too (lastX is still where the press was).
      const dx = document.pointerLockElement === target ? ev.movementX : ev.clientX - lastX;
      lastX = ev.clientX;
      if (!moved) {
        moved = true;
        editing.current = true;
        setScrubbing(true);
        document.body.classList.add("scrubbing");
        try {
          const ask = target.requestPointerLock?.() as unknown;
          locked = true;
          if (ask && typeof (ask as Promise<void>).catch === "function") void (ask as Promise<void>).catch(() => (locked = false));
        } catch {
          locked = false;
        }
      }
      const factor = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      travel += dx * factor;
      const next = roundTo(clampTo(start + Math.round(travel) * step, min, max), ev.altKey ? step / 10 : step);
      if (next === current) return;
      current = next;
      preview(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (locked && document.pointerLockElement) document.exitPointerLock();
      document.body.classList.remove("scrubbing");
      if (!moved) {
        // A click: type in it.
        el.focus();
        el.select();
        return;
      }
      setScrubbing(false);
      editing.current = false;
      dragged.current = true;
      setTimeout(() => (dragged.current = false), 0);
      if (current === value) {
        endPreview(false);
        return setText(shown);
      }
      onCommit(current);
      endPreview(true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return (
    <label className={`field num-field ${scrubbing ? "scrubbing" : ""}`} data-scrub={testId}
      onPointerDown={onPointerDown}
      onClick={(e) => {
        if (dragged.current) e.preventDefault();
      }}
    >
      <span className="k" title="Drag left or right to change it (⇧ faster, ⌥ finer)">
        {label}
      </span>
      <input
        ref={input}
        className="v"
        data-testid={testId}
        // Text, not type="number": Chromium shows a number input in the system locale ("0,5"),
        // and the app writes numbers with "." everywhere else. ↑/↓ step like a number input.
        type="text"
        inputMode="decimal"
        spellCheck={false}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={() => (editing.current = true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const base = parse(text);
            const by = (e.shiftKey ? 10 : 1) * step;
            const next = roundTo(clampTo((base !== undefined && Number.isFinite(base) ? base : (value ?? 0)) + (e.key === "ArrowUp" ? by : -by), min, max), step);
            editing.current = true;
            preview(next);
          }
          if (e.key === "Escape") {
            editing.current = false;
            setText(shown);
            endPreview(false);
            const el = e.currentTarget;
            requestAnimationFrame(() => el.blur());
          }
        }}
      />
    </label>
  );
}

/** Colour swatches (theme tokens first) plus a custom colour. */
export function ColorPicker({ project, value, onPick, testId, disabled }: { project: ProjectModel; value: string | undefined; onPick: (color: string, final: boolean) => void; testId: string; disabled?: boolean }) {
  const css = resolveColor(project, value, "#ffffff");
  const hex = /^#[0-9a-f]{6}$/i.test(css) ? css : "#ffffff";
  return (
    <div className="swatches">
      {swatches(project).map((s) => (
        <button
          key={s.value}
          className={`swatch ${value === s.value ? "active" : ""}`}
          data-testid={testId}
          data-color={s.value}
          title={s.label}
          disabled={disabled}
          style={{ background: s.css }}
          onClick={() => onPick(s.value, true)}
        />
      ))}
      <label className="swatch custom" title="Custom colour">
        <input type="color" data-testid={`${testId}-custom`} value={hex} disabled={disabled} onChange={(e) => onPick(e.target.value.toUpperCase(), false)} />
      </label>
    </div>
  );
}

/** Debounces a value that streams in (a colour picker) into one edit after it settles. */
export function useSettle(delay: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<(() => void) | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      pending.current?.();
    },
    [],
  );
  return (run: () => void) => {
    clearTimeout(timer.current);
    pending.current = run;
    timer.current = setTimeout(() => {
      pending.current = undefined;
      run();
    }, delay);
  };
}

/** A range slider that previews locally while it moves and commits once when released. */
export function Slider({ value, min, max, step, onPreview, onCommit, testId, disabled, title }: { value: number; min: number; max: number; step?: number; onPreview: (v: number) => void; onCommit: (v: number) => void; testId: string; disabled?: boolean; title?: string }) {
  const [local, setLocal] = useState<number | undefined>(undefined);
  const commit = (el: HTMLInputElement) => {
    if (local === undefined) return;
    setLocal(undefined);
    if (local !== value) onCommit(local);
    // Off the slider, so Space and the arrows go back to the transport.
    el.blur();
  };
  return (
    <input
      type="range"
      className="slider"
      data-testid={testId}
      min={min}
      max={max}
      step={step}
      title={title}
      value={local ?? value}
      disabled={disabled}
      onChange={(e) => {
        const v = Number(e.target.value);
        setLocal(v);
        onPreview(v);
      }}
      onPointerUp={(e) => commit(e.currentTarget)}
      onKeyUp={(e) => commit(e.currentTarget)}
      onBlur={(e) => commit(e.currentTarget)}
    />
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: ReadonlyArray<readonly [T, string, boolean?]>; value: T; onChange: (t: T) => void }) {
  return (
    <div className="seg insp-tabs">
      {tabs.map(([id, label, disabled]) => (
        <button key={id} className={value === id ? "active" : ""} data-testid={`insp-tab-${id}`} disabled={disabled} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export const Group = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="group">
    <div className="group-label">{label}</div>
    {children}
  </div>
);

/**
 * The text's content. Typing shows in the preview at once (a local draft) and is saved after a
 * pause of TYPING_PAUSE_MS, on blur, or with ⌘Enter; Esc puts the saved text back. A burst is
 * planned against the revision it started at, so an agent change to the same item meanwhile is
 * refused rather than overwritten (D6).
 */
