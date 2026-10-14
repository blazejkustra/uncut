// The Inspector's shared pieces (split out of panels/ItemEditors.tsx): number fields, sliders,
// colour pickers, tabs and groups, and how an edit is drafted in the preview and sent (one
// project.edit through actions.itemEdit: validated, one ⌘Z, in the agent's next note).
import { resolveColor } from "@uncut/core/render";
import type { Op } from "@uncut/core/types";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { draftOf } from "../timeline/edit.ts";
import { getPlayback, playback, type PreviewDraft } from "../preview/playback.ts";
import { type ProjectModel } from "../state/project.ts";
import { actions, getState } from "../state/store.ts";
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

/** A number field: typed freely, committed on Enter or blur, Esc puts the saved value back. */
export function NumberField({ label, value, onCommit, testId, placeholder, step = 1, min, max, disabled }: { label: string; value: number | undefined; onCommit: (v: number | undefined) => void; testId: string; placeholder?: string; step?: number; min?: number; max?: number; disabled?: boolean }) {
  const shown = value === undefined ? "" : String(value);
  const [text, setText] = useState(shown);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(shown);
  }, [shown]);
  const commit = () => {
    editing.current = false;
    const trimmed = text.trim();
    // A comma is a decimal point too (typed on a Polish keyboard, say); shown values always use ".".
    const n = trimmed === "" ? undefined : Number(trimmed.replace(",", "."));
    if (n !== undefined && (!Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max))) return setText(shown);
    if (n === value) return setText(shown);
    onCommit(n);
  };
  return (
    <label className="field num-field">
      <span className="k">{label}</span>
      <input
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
            const base = Number(text.trim().replace(",", "."));
            let next = (Number.isFinite(base) ? base : (value ?? 0)) + (e.key === "ArrowUp" ? step : -step);
            if (min !== undefined) next = Math.max(min, next);
            if (max !== undefined) next = Math.min(max, next);
            editing.current = true;
            setText(String(Math.round(next * 1e6) / 1e6));
          }
          if (e.key === "Escape") {
            editing.current = false;
            setText(shown);
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
