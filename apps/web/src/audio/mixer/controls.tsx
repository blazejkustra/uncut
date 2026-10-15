import { useState, useRef, useEffect } from "react";
import { MAX_DB, SILENCE_DB, gainToDb } from "@uncut/core/audio";
import type { StereoLevel } from "../audio.ts";
import { type Plan, draftOf } from "../../timeline/edit.ts";
import { type PreviewDraft, getPlayback, playback } from "../../preview/playback.ts";
import { yLevel, levelY, dbLabel, panWords, panShort } from "../sound.ts";
import type { ProjectModel } from "../../state/project.ts";
import { getState, actions, projectOf } from "../../state/store.ts";

type Problem = { readonly problem: string };

/** Send a plan made against the project as it is now (an agent edit may have landed meanwhile), then drop the drag's draft. */
export function commit(make: (project: ProjectModel) => Plan | Problem, draft?: PreviewDraft) {
  const snapshot = getState().snapshot;
  if (!snapshot) return;
  void actions.timelineEdit(make(projectOf(snapshot)), { baseRevision: snapshot.revision, dir: snapshot.dir }).finally(() => {
    if (draft && getPlayback().draft === draft) playback.setDraft(undefined);
  });
}

/** Show a planned change in the preview (and the mix) while a control is dragged. */
export function preview(project: ProjectModel, plan: Plan | Problem): PreviewDraft | undefined {
  if ("problem" in plan || !plan.ops.length) return undefined;
  const result = draftOf(project, plan.ops);
  if (!("project" in result)) return undefined;
  const draft = { base: project, project: result.project };
  playback.setDraft(draft);
  return draft;
}

/**
 * A relative drag (no jump on press): the value moves by the pointer's travel, `toValue` maps a
 * start value and the travel in pixels to the new value. Commits on release only if it changed.
 */
function useDrag<T>({ value, toValue, onPreview, onCommit, disabled }: { value: T; toValue: (start: T, dx: number, dy: number) => T; onPreview: (v: T) => void; onCommit: (v: T) => void; disabled: boolean }) {
  const [local, setLocal] = useState<T | undefined>(undefined);
  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const start = value;
    let last: T = value;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 2 && Math.abs(ev.clientY - y0) < 2) return;
      moved = true;
      last = toValue(start, ev.clientX - x0, ev.clientY - y0);
      setLocal(last);
      onPreview(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setLocal(undefined);
      if (moved && last !== start) onCommit(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  return { shown: local ?? value, dragging: local !== undefined, onPointerDown };
}

/** A vertical fader in dB on the shared level scale (levelY): drag the thumb, double-click for 0 dB. */
export function Fader({ value, onPreview, onCommit, disabled, testId, label }: { value: number; onPreview: (db: number) => void; onCommit: (db: number) => void; disabled: boolean; testId: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { shown, onPointerDown } = useDrag({
    value,
    disabled,
    toValue: (start, _dx, dy) => {
      const h = ref.current?.clientHeight || 100;
      const db = yLevel(levelY(start) + dy / h);
      return Math.round(Math.min(MAX_DB, Math.max(SILENCE_DB, db)) * 2) / 2;
    },
    onPreview,
    onCommit,
  });
  return (
    <div
      className={`fader ${disabled ? "disabled" : ""}`}
      ref={ref}
      data-testid={testId}
      data-db={shown}
      role="slider"
      aria-label={label}
      aria-valuemin={SILENCE_DB}
      aria-valuemax={MAX_DB}
      aria-valuenow={shown}
      title={`${label}: ${dbLabel(shown)} dB (drag; double-click for 0 dB)`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => !disabled && value !== 0 && onCommit(0)}
    >
      <div className="fader-track" />
      <div className="fader-zero" style={{ top: `${levelY(0) * 100}%` }} />
      <div className="fader-thumb" data-testid={`${testId}-thumb`} style={{ top: `${levelY(shown) * 100}%` }} />
    </div>
  );
}

/** A horizontal pan slider, −1 (left) … 1 (right): drag, double-click to centre. */
export function PanSlider({ value, onPreview, onCommit, disabled, name }: { value: number; onPreview: (p: number) => void; onCommit: (p: number) => void; disabled: boolean; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { shown, onPointerDown } = useDrag({
    value,
    disabled,
    toValue: (start, dx) => {
      const w = ref.current?.clientWidth || 60;
      const p = Math.min(1, Math.max(-1, start + (2 * dx) / w));
      return Math.abs(p) < 0.025 ? 0 : Math.round(p * 100) / 100;
    },
    onPreview,
    onCommit,
  });
  const x = ((shown + 1) / 2) * 100;
  return (
    <div className="pan-row">
      <div
        className={`pan ${disabled ? "disabled" : ""}`}
        ref={ref}
        data-testid="mixer-pan"
        data-pan={shown}
        role="slider"
        aria-label={`${name} pan`}
        aria-valuemin={-1}
        aria-valuemax={1}
        aria-valuenow={shown}
        title={`Pan ${panWords(shown)} (drag; double-click to centre)`}
        onPointerDown={onPointerDown}
        onDoubleClick={() => !disabled && value !== 0 && onCommit(0)}
      >
        <div className="pan-fill" style={{ left: `${Math.min(50, x)}%`, width: `${Math.abs(x - 50)}%` }} />
        <div className="pan-centre" />
        <div className="pan-thumb" style={{ left: `${x}%` }} />
      </div>
      <span className="pan-label mono" data-testid="mixer-pan-label">
        {panShort(shown)}
      </span>
    </div>
  );
}

/** A stereo meter: RMS as the bar, peak as a line, on the faders' scale. The panel's loop writes into it. */
export function Meter({ id }: { id: string }) {
  return (
    <div className="meter" data-testid="mixer-meter" data-meter={id} data-peak="-Infinity" data-rms="-Infinity" data-over="false" title="Level after the fader and pan: RMS bar, peak line; the top lights red when the peak reaches full scale">
      {(["l", "r"] as const).map((c) => (
        <div key={c} className="meter-ch">
          <div className="meter-rms" data-ch={c} />
          <div className="meter-peak" data-ch={c} />
        </div>
      ))}
    </div>
  );
}

/** How long a meter's over (clip) light stays on after a peak at or above full scale. */
const OVER_HOLD_MS = 1500;
export interface MeterEl {
  readonly el: HTMLElement;
  readonly rms: ReadonlyArray<HTMLElement>;
  readonly peak: ReadonlyArray<HTMLElement>;
  /** What was last written, to skip unchanged writes. */
  last: string;
  overUntil: number;
}
/**
 * Fill a meter from a level reading (and say it in data-peak / data-rms, dBFS of the louder
 * channel, for the tests); a peak at full scale lights the meter's over light for a moment.
 * Returns whether the meter shows anything (false once it rests at the floor).
 */
export function drawMeter(m: MeterEl, level: StereoLevel, now: number): boolean {
  const chans = [level.left, level.right];
  if (chans.some((c) => c.peak >= 1)) m.overUntil = now + OVER_HOLD_MS;
  const over = now < m.overUntil;
  const ys = chans.map((c) => [levelY(gainToDb(c.rms)), levelY(gainToDb(c.peak))] as const);
  const key = `${ys.map(([r, p]) => `${r.toFixed(3)},${p.toFixed(3)}`).join(";")}${over ? "!" : ""}`;
  if (key === m.last) return key !== FLOOR_KEY;
  m.last = key;
  ys.forEach(([r, p], i) => {
    m.rms[i]!.style.clipPath = `inset(${r * 100}% 0 0 0)`;
    m.peak[i]!.style.bottom = `${(1 - p) * 100}%`;
  });
  m.el.classList.toggle("over", over);
  m.el.dataset.over = over ? "true" : "false";
  m.el.dataset.peak = String(Math.round(gainToDb(Math.max(level.left.peak, level.right.peak)) * 10) / 10);
  m.el.dataset.rms = String(Math.round(gainToDb(Math.max(level.left.rms, level.right.rms)) * 10) / 10);
  return key !== FLOOR_KEY;
}
const FLOOR_KEY = "1.000,1.000;1.000,1.000";


// ---- effects, ducking, the limiter and the loudness target (D84–D88) ----

/** Fill a gain-reduction light from a reading (dB ≤ 0): its bar grows down from the top over 0…−12 dB. Returns whether it shows anything. */
export function drawReduction(el: HTMLElement, gr: number): boolean {
  const v = Math.max(0, Math.min(12, -gr));
  const key = v.toFixed(1);
  if (el.dataset.last === key) return v > 0.05;
  el.dataset.last = key;
  el.dataset.value = String(Math.round(gr * 10) / 10);
  const bar = el.firstElementChild as HTMLElement | null;
  if (bar) bar.style.height = `${(v / 12) * 100}%`;
  return v > 0.05;
}

/** A small popover over the panel, opened from an anchor (fixed, so the panel's scroll doesn't clip it). Escape or a click outside closes it. */
export function Popover({ anchor, onClose, children, testId, wide = false }: { anchor: HTMLElement; onClose: () => void; children: React.ReactNode; testId: string; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - (wide ? 318 : 268), r.left));
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);
  return (
    <div className={`fx-popover ${wide ? "wide" : ""}`} data-testid={testId} ref={ref} style={{ left, bottom: Math.max(8, window.innerHeight - r.top + 6) }} onPointerDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}
