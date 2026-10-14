// The Inspector's property controls (D129): the pieces the text and element inspectors are built
// from, in the manner of a design tool's property panel. A section (collapsible, with an optional
// action on its header), a labelled row with a reset, a number you can type or scrub (drag its
// label), a slider with its number, a colour (swatch, hex, opacity), a segmented choice, a toggle
// and a popover. Every control previews while it moves (onPreview: a local draft) and commits once
// (onCommit: one project.edit, one ⌘Z): scrubbing a slider or a label is one edit.
import { resolveColor } from "@uncut/core/render";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { type ProjectModel } from "../state/project.ts";
import { swatches } from "../preview/text.ts";
import { useSettle } from "./fields.tsx";

/** A titled block of properties; the header can collapse it and hold an action (add, remove). */
export function Section({ title, testId, action, children, open: initial = true }: { title: string; testId?: string; action?: ReactNode; children?: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <section className="psec" data-testid={testId}>
      <div className="psec-head">
        <button className="psec-title" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown /> : <ChevronRight />}
          {title}
        </button>
        {action}
      </div>
      {open && children && <div className="psec-body">{children}</div>}
    </section>
  );
}

/** One property: its label, its control, and a reset when it differs from its default. */
export function Prop({ label, children, onReset, testId }: { label: string; children: ReactNode; onReset?: (() => void) | undefined; testId?: string }) {
  return (
    <div className="prop" data-testid={testId}>
      <span className="prop-k">{label}</span>
      <div className="prop-v">{children}</div>
      {onReset ? (
        <button className="prop-reset" title="Reset" aria-label={`Reset ${label}`} data-testid={testId ? `${testId}-reset` : undefined} onClick={onReset}>
          <RotateCcw />
        </button>
      ) : (
        <span className="prop-reset-gap" />
      )}
    </div>
  );
}

const clampTo = (v: number, min?: number, max?: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
const roundTo = (v: number, step: number) => {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  return Number((Math.round(v / step) * step).toFixed(decimals));
};

/**
 * A number: typed (Enter or blur commits, Esc puts it back, ↑/↓ step, ⇧ ten steps) or scrubbed by
 * dragging its label left and right (previewed while dragging, one commit on release). `unit`
 * shows after the value. An empty field commits undefined (the default) when `clearable`.
 */
export function NumInput({ value, onCommit, onPreview, testId, label, unit, step = 1, min, max, placeholder, disabled, clearable, title }: { value: number | undefined; onCommit: (v: number | undefined) => void; onPreview?: (v: number) => void; testId: string; label?: ReactNode; unit?: string; step?: number; min?: number; max?: number; placeholder?: string; disabled?: boolean; clearable?: boolean; title?: string }) {
  const shown = value === undefined ? "" : String(Math.round(value * 1000) / 1000);
  const [text, setText] = useState(shown);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(shown);
  }, [shown]);
  const commit = () => {
    editing.current = false;
    const trimmed = text.trim();
    const n = trimmed === "" ? undefined : Number(trimmed.replace(",", "."));
    if (n === undefined && !clearable) return setText(shown);
    if (n !== undefined && !Number.isFinite(n)) return setText(shown);
    const next = n === undefined ? undefined : clampTo(n, min, max);
    if (next === value) return setText(shown);
    onCommit(next);
  };
  // Scrubbing the label: 1 step per 2 px (⇧ ten), from the value when the drag began.
  const scrub = useRef<{ x: number; from: number; last: number; moved: boolean } | undefined>(undefined);
  const down = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    scrub.current = { x: e.clientX, from: value ?? 0, last: value ?? 0, moved: false };
  };
  const move = (e: React.PointerEvent<HTMLSpanElement>) => {
    const s = scrub.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    if (!s.moved && Math.abs(dx) < 2) return;
    s.moved = true;
    const next = clampTo(roundTo(s.from + Math.round(dx / 2) * step * (e.shiftKey ? 10 : 1), step), min, max);
    if (next === s.last) return;
    s.last = next;
    setText(String(next));
    onPreview?.(next);
  };
  const up = () => {
    const s = scrub.current;
    scrub.current = undefined;
    if (s?.moved && s.last !== value) onCommit(s.last);
  };
  return (
    <label className={`nfield ${disabled ? "disabled" : ""}`} title={title}>
      {label !== undefined && (
        <span className="nfield-k" data-testid={`${testId}-scrub`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          {label}
        </span>
      )}
      <input
        data-testid={testId}
        type="text"
        inputMode="decimal"
        spellCheck={false}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={(e) => {
          editing.current = true;
          e.currentTarget.select();
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const base = Number(text.trim().replace(",", "."));
            const by = step * (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
            editing.current = true;
            setText(String(clampTo(roundTo((Number.isFinite(base) ? base : (value ?? 0)) + by, step), min, max)));
          }
          if (e.key === "Escape") {
            editing.current = false;
            setText(shown);
            const el = e.currentTarget;
            requestAnimationFrame(() => el.blur());
          }
        }}
      />
      {unit && <span className="nfield-u">{unit}</span>}
    </label>
  );
}

/** A slider with its number: the slider previews while it moves and commits once on release. */
export function SliderNum({ value, min, max, step = 1, unit, testId, disabled, onPreview, onCommit, sliderMax }: { value: number; min: number; max: number; step?: number; unit?: string; testId: string; disabled?: boolean; onPreview: (v: number) => void; onCommit: (v: number) => void; sliderMax?: number }) {
  const [local, setLocal] = useState<number | undefined>(undefined);
  const top = sliderMax ?? max;
  const finish = (el: HTMLInputElement) => {
    if (local === undefined) return;
    setLocal(undefined);
    if (local !== value) onCommit(local);
    el.blur();
  };
  return (
    <div className="slider-num">
      <input
        type="range"
        className="slider"
        data-testid={`${testId}-slider`}
        min={min}
        max={Math.max(top, value)}
        step={step}
        value={local ?? value}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          setLocal(v);
          onPreview(v);
        }}
        onPointerUp={(e) => finish(e.currentTarget)}
        onKeyUp={(e) => finish(e.currentTarget)}
        onBlur={(e) => finish(e.currentTarget)}
      />
      <NumInput testId={testId} value={local ?? value} unit={unit} step={step} min={min} max={max} disabled={disabled} onPreview={onPreview} onCommit={(v) => v !== undefined && onCommit(v)} />
    </div>
  );
}

/** A segmented choice: icons or short words, one active. */
export function Segmented<T extends string>({ options, value, onChange, testId, disabled, attr = "value" }: { options: ReadonlyArray<readonly [T, ReactNode, string?]>; value: T | undefined; onChange: (v: T) => void; testId: string; disabled?: boolean; attr?: string }) {
  return (
    <div className="pseg" role="group">
      {options.map(([v, content, title]) => (
        <button key={v} className={value === v ? "active" : ""} data-testid={testId} {...{ [`data-${attr}`]: v }} title={title} aria-label={title} aria-pressed={value === v} disabled={disabled} onClick={() => value !== v && onChange(v)}>
          {content}
        </button>
      ))}
    </div>
  );
}

/** A popover anchored under an element, drawn over everything (the Inspector scrolls and would clip it). Outside click or Esc closes it. */
export function Popover({ anchor, onClose, children, testId, width = 240 }: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; testId?: string; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | undefined>(undefined);
  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width));
    const below = r.bottom + 6;
    setAt({ left, top: below + h > window.innerHeight - 8 ? Math.max(8, r.top - 6 - h) : below });
  }, [anchor, width]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} className="ppop" data-testid={testId} style={{ width, left: at?.left ?? -9999, top: at?.top ?? -9999 }}>
      {children}
    </div>,
    document.body,
  );
}

const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX8 = /^#[0-9a-f]{8}$/i;

/**
 * A colour value split into what the field shows: its base (a theme token or #RRGGBB) and the
 * alpha an #RRGGBBAA carries (1 otherwise).
 */
export function splitColor(value: string | undefined): { base: string | undefined; alpha: number } {
  if (value && HEX8.test(value)) return { base: value.slice(0, 7).toUpperCase(), alpha: Math.round((parseInt(value.slice(7), 16) / 255) * 100) / 100 };
  return { base: value, alpha: 1 };
}
/** A base colour at an alpha, as saved: the base alone at 1, else #RRGGBBAA (a token resolved to its hex first). */
export function joinColor(project: ProjectModel, base: string, alpha: number): string {
  if (alpha >= 1) return base;
  const hex = resolveColor(project, base, "#FFFFFF");
  const six = HEX6.test(hex) ? hex : "#FFFFFF";
  return `${six}${Math.round(Math.max(0, alpha) * 255).toString(16).padStart(2, "0")}`.toUpperCase();
}

/**
 * A colour: a swatch (opens the theme colours, a few plain ones and the system picker), the hex (or
 * theme token) to type, and an opacity in %. The opacity is either the colour's own alpha
 * (#RRGGBBAA, `alpha` absent) or a separate field (`alpha` given: a shadow's or a box's opacity).
 * onPick(color, final): final false while the system picker streams (the caller drafts it and
 * commits once it settles); a swatch, the hex and the opacity commit at once.
 */
export function ColorField({ project, value, fallback = "#FFFFFF", onPick, testId, disabled, alpha, noAlpha }: { project: ProjectModel; value: string | undefined; fallback?: string; onPick: (color: string, final: boolean) => void; testId: string; disabled?: boolean; alpha?: { value: number; onCommit: (v: number) => void }; noAlpha?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const own = splitColor(value);
  const base = own.base ?? fallback;
  const a = alpha ? alpha.value : own.alpha;
  const css = resolveColor(project, base, fallback);
  const hex = HEX6.test(css) ? css.toUpperCase() : fallback;
  const pickBase = (next: string, final: boolean) => onPick(alpha ? next : joinColor(project, next, own.alpha), final);
  const [text, setText] = useState(base);
  useEffect(() => setText(base), [base]);
  const commitText = () => {
    const t = text.trim();
    const token = Object.prototype.hasOwnProperty.call(project.theme?.colors ?? {}, t) || ["fg", "bg", "mute", "accent"].includes(t);
    const norm = /^#?[0-9a-f]{6}$/i.test(t) ? `#${t.replace("#", "").toUpperCase()}` : /^#?[0-9a-f]{3}$/i.test(t) ? `#${[...t.replace("#", "")].map((c) => c + c).join("").toUpperCase()}` : token ? t : undefined;
    if (!norm) return setText(base);
    if (norm !== base) pickBase(norm, true);
  };
  return (
    <div className="cfield">
      <button ref={anchor} className="cfield-swatch" data-testid={`${testId}-swatch`} title={base} disabled={disabled} style={{ ["--c" as string]: css, ["--a" as string]: String(a) }} onClick={() => setOpen(!open)} />
      <input
        className="cfield-hex"
        data-testid={`${testId}-hex`}
        value={text}
        disabled={disabled}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setText(base);
            const el = e.currentTarget;
            requestAnimationFrame(() => el.blur());
          }
        }}
      />
      {!noAlpha && (
        <NumInput
          testId={`${testId}-opacity`}
          value={Math.round(a * 100)}
          unit="%"
          min={0}
          max={100}
          disabled={disabled}
          onCommit={(v) => {
            if (v === undefined) return;
            if (alpha) alpha.onCommit(v / 100);
            else onPick(joinColor(project, base, v / 100), true);
          }}
        />
      )}
      {open && (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)} testId={`${testId}-popover`} width={224}>
          <div className="ppop-swatches">
            {swatches(project).map((s) => (
              <button key={s.value} className={`swatch ${base === s.value ? "active" : ""}`} data-testid={testId} data-color={s.value} title={s.label} disabled={disabled} style={{ background: s.css }} onClick={() => pickBase(s.value, true)} />
            ))}
            <label className="swatch custom" title="Custom colour">
              <input type="color" data-testid={`${testId}-custom`} value={hex} disabled={disabled} onChange={(e) => pickBase(e.target.value.toUpperCase(), false)} />
            </label>
          </div>
        </Popover>
      )}
    </div>
  );
}

/** A ColorField that commits a streaming system-picker colour once it settles (the caller just commits). */
export function SettledColorField(props: Omit<Parameters<typeof ColorField>[0], "onPick"> & { onPreview?: (color: string) => void; onCommit: (color: string) => void }) {
  const settle = useSettle(400);
  const { onPreview, onCommit, ...rest } = props;
  return (
    <ColorField
      {...rest}
      onPick={(color, final) => {
        if (final) return onCommit(color);
        onPreview?.(color);
        settle(() => onCommit(color));
      }}
    />
  );
}

/** An on/off switch. */
export function Toggle({ value, onChange, testId, disabled, label }: { value: boolean; onChange: (v: boolean) => void; testId: string; disabled?: boolean; label?: string }) {
  return (
    <button className={`ptoggle ${value ? "on" : ""}`} role="switch" aria-checked={value} aria-label={label} data-testid={testId} disabled={disabled} onClick={() => onChange(!value)}>
      <span />
    </button>
  );
}
