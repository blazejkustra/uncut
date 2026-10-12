// The Inspector's editors for text and backgrounds (phase 4 chunk 4, D16/D53): CapCut-style text
// (content, then Style / Animation / Captions tabs) and a background's colours. Every change is
// one project.edit through actions.itemEdit (validated, one ⌘Z, in the agent's next note):
// typing is committed after a pause, on blur or ⌘Enter, so a burst is one undo step; a slider
// shows a local draft while it moves and commits once on release.
import { MAX_DB, SILENCE_DB, soundMedia } from "@uncut/core/audio";
import { resolveColor, TEXT_STYLES } from "@uncut/core/render";
import type { Item, Op } from "@uncut/core/types";
import { transitionInfo, transitionLimits, transitionName, TRANSITIONS } from "@uncut/core/transitions";
import { Activity, AlignCenter, AlignLeft, AlignRight, Blend, Crosshair, Diamond, Highlighter, RotateCcw, X } from "lucide-react";
import type { Fit, KeyProp } from "@uncut/core/box";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { draftOf, findItem } from "./edit.ts";
import { getPlayback, playback, usePlayback, type PreviewDraft } from "./playback.ts";
import { clipState, keyState, planClipBox, planLoop, planResetBox, planToggleKey, PROP_NAMES, type BoxPatch } from "./clip.ts";
import { itemLabel, type ProjectModel } from "./project.ts";
import { useBeats } from "./beats.ts";
import { analysisText } from "./analysisText.ts";
import { actions, activeAnalyses, getState, projectOf, useApp } from "./store.ts";
import { dbLabel, planFade, planGain } from "./sound.ts";
import { MOVES, planAnimation, planBackground, planCentre, planPreset, planStyle, planText, planTransform, swatches, textBox, toggleAccent, type AnimationSlot } from "./text.ts";

/** How long typing has to pause before it's saved (it's also saved on blur and ⌘Enter). */
export const TYPING_PAUSE_MS = 800;

type PlanResult = { readonly ops: ReadonlyArray<Op>; readonly summary: string } | { readonly problem: string };

/** Show a plan's result in the preview without sending it; returns the draft (to drop later). */
function showDraft(project: ProjectModel, plan: PlanResult): PreviewDraft | undefined {
  if (!("ops" in plan) || !plan.ops.length) return undefined;
  const result = draftOf(project, plan.ops);
  if (!("project" in result)) return undefined;
  const draft = { base: project, project: result.project };
  playback.setDraft(draft);
  return draft;
}
const dropDraft = (draft: PreviewDraft | undefined) => {
  if (draft && getPlayback().draft === draft) playback.setDraft(undefined);
};

/** The revision and folder an edit is planned against (see actions.itemEdit). */
const origin = () => ({ baseRevision: getState().snapshot?.revision, dir: getState().snapshot?.dir });

/** Send an edit planned against the newest project; the draft (if any) goes once it's applied. */
function send(make: (project: ProjectModel) => PlanResult, draft?: PreviewDraft, from = origin()) {
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
function ColorPicker({ project, value, onPick, testId, disabled }: { project: ProjectModel; value: string | undefined; onPick: (color: string, final: boolean) => void; testId: string; disabled?: boolean }) {
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
function useSettle(delay: number) {
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

function Tabs<T extends string>({ tabs, value, onChange }: { tabs: ReadonlyArray<readonly [T, string, boolean?]>; value: T; onChange: (t: T) => void }) {
  return (
    <div className="seg insp-tabs">
      {tabs.map(([id, label, disabled]) => (
        <button key={id} className={value === id ? "active" : ""} data-testid={`insp-tab-${id}`} disabled={disabled} title={disabled ? "Captions arrive with transcripts" : undefined} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

const Group = ({ label, children }: { label: string; children: ReactNode }) => (
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
function TextContent({ project, item, disabled }: { project: ProjectModel; item: Item; disabled: boolean }) {
  const saved = item.text ?? "";
  const [value, setValue] = useState(saved);
  const ref = useRef<HTMLTextAreaElement>(null);
  // The revision the text field shows: set when it last matched the saved text (mount, a change
  // to the item while nothing was pending, a finished save). A burst is planned against it, so an
  // agent edit the user hadn't seen yet makes the save conflict instead of being overwritten.
  const base = useRef(origin());
  // Typed but not saved yet.
  const dirty = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const draft = useRef<PreviewDraft | undefined>(undefined);
  const latest = useRef({ value, saved, id: item.id });
  latest.current = { value, saved, id: item.id };

  /** Show the saved text again and take the current revision as the new base. */
  const resync = (text: string) => {
    base.current = origin();
    latest.current = { ...latest.current, value: text };
    if (mounted.current) setValue(text);
  };
  // A change to the item from anywhere (the agent, undo, a save) shows up unless typing is pending.
  useEffect(() => {
    if (!dirty.current) resync(item.text ?? "");
  }, [item]);

  const commit = () => {
    clearTimeout(timer.current);
    const { value: text, saved: was, id } = latest.current;
    const from = base.current;
    const d = draft.current;
    draft.current = undefined;
    const pending = dirty.current;
    dirty.current = false;
    if (!pending || text === was) return dropDraft(d);
    void actions.itemEdit((p) => planText(p, id, text), from).finally(() => {
      dropDraft(d);
      // Saved or refused (a conflict shows in the banner): show what's saved now, unless the user
      // has typed on meanwhile.
      if (dirty.current) return;
      const snapshot = getState().snapshot;
      const now = snapshot ? findItem(projectOf(snapshot), id)?.item.text : undefined;
      if (now !== undefined) resync(now);
    });
  };
  // Leaving the item (another selection, the Inspector closing) saves what was typed.
  useEffect(
    () => () => {
      commit();
      mounted.current = false;
    },
    [],
  );

  const change = (text: string) => {
    setValue(text);
    latest.current = { ...latest.current, value: text };
    dirty.current = true;
    draft.current = showDraft(project, planText(project, item.id, text)) ?? draft.current;
    clearTimeout(timer.current);
    timer.current = setTimeout(commit, TYPING_PAUSE_MS);
  };

  const accent = () => {
    const el = ref.current;
    if (!el) return;
    const next = toggleAccent(value, el.selectionStart, el.selectionEnd);
    if (next.text === value) return;
    change(next.text);
    commit();
    requestAnimationFrame(() => el.setSelectionRange(next.from, next.to));
  };

  return (
    <div className="group">
      <div className="group-label row">
        <span>Text</span>
        <button className="btn ghost small-btn" data-testid="insp-accent" title="Accent the selected words ([[ ]] in the text)" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={accent}>
          <Highlighter />
          Accent
        </button>
      </div>
      <textarea
        ref={ref}
        className="field input text-area"
        data-testid="insp-text"
        value={value}
        rows={3}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => change(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey) {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            clearTimeout(timer.current);
            dirty.current = false;
            dropDraft(draft.current);
            draft.current = undefined;
            resync(saved);
            const el = e.currentTarget;
            requestAnimationFrame(() => el.blur());
          }
        }}
      />
      <div className="hint-line muted small">Saved as you pause. [[word]] accents, **bold**, `mono`.</div>
    </div>
  );
}

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
const WEIGHT_NAMES: Readonly<Record<number, string>> = { 100: "Thin", 200: "Extra light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Heavy", 900: "Black" };
const ALIGNS = [
  ["left", AlignLeft],
  ["center", AlignCenter],
  ["right", AlignRight],
] as const;

function TextStyleTab({ project, item, disabled }: { project: ProjectModel; item: Item; disabled: boolean }) {
  const box = textBox(item, project.canvas);
  const settle = useSettle(400);
  const colorDraft = useRef<PreviewDraft | undefined>(undefined);
  const maxSize = Math.round(project.canvas.height * 0.4);
  const sizeDraft = useRef<PreviewDraft | undefined>(undefined);
  return (
    <>
      <Group label="Style">
        <div className="presets">
          {Object.entries(TEXT_STYLES).map(([id, look]) => (
            <button key={id} className={`preset ${item.style?.preset === id ? "active" : ""}`} data-testid="insp-preset" data-preset={id} disabled={disabled} onClick={() => send((p) => planPreset(p, item.id, id))}>
              {look.name}
            </button>
          ))}
        </div>
      </Group>
      <Group label="Size and weight">
        <div className="slider-row">
          <Slider
            testId="insp-size"
            value={box.size}
            min={8}
            max={Math.max(maxSize, box.size)}
            disabled={disabled}
            onPreview={(v) => (sizeDraft.current = showDraft(project, planStyle(project, item.id, { size: v })) ?? sizeDraft.current)}
            onCommit={(v) => {
              const d = sizeDraft.current;
              sizeDraft.current = undefined;
              send((p) => planStyle(p, item.id, { size: v }, "Resize text"), d);
            }}
          />
          <NumberField label="px" testId="insp-size-num" value={box.size} min={1} disabled={disabled} onCommit={(v) => v !== undefined && send((p) => planStyle(p, item.id, { size: v }, "Resize text"))} />
        </div>
        <select className="field input" data-testid="insp-weight" value={box.weight} disabled={disabled} onChange={(e) => {
            const weight = Number(e.target.value);
            send((p) => planStyle(p, item.id, { weight }));
          }}>
          {WEIGHTS.map((w) => (
            <option key={w} value={w}>
              {w} {WEIGHT_NAMES[w]}
            </option>
          ))}
        </select>
      </Group>
      <Group label="Colour">
        <ColorPicker
          project={project}
          testId="insp-color"
          value={box.color}
          disabled={disabled}
          onPick={(color, final) => {
            if (final) return send((p) => planStyle(p, item.id, { color }, "Recolour text"));
            colorDraft.current = showDraft(project, planStyle(project, item.id, { color })) ?? colorDraft.current;
            settle(() => {
              const d = colorDraft.current;
              colorDraft.current = undefined;
              send((p) => planStyle(p, item.id, { color }, "Recolour text"), d);
            });
          }}
        />
      </Group>
      <Group label="Alignment and position">
        <div className="seg align" role="group">
          {ALIGNS.map(([align, Icon]) => (
            <button key={align} className={box.align === align ? "active" : ""} data-testid="insp-align" data-align={align} title={`Align ${align}`} disabled={disabled} onClick={() => send((p) => planStyle(p, item.id, { align }, `Align text ${align}`))}>
              <Icon />
            </button>
          ))}
          <button className="centre" data-testid="insp-centre" title="Centre on the canvas: the box spans the safe area and the lines are centred" disabled={disabled} onClick={() => send((p) => planCentre(p, item.id))}>
            <Crosshair />
            Centre
          </button>
        </div>
        <div className="field-row three">
          <NumberField label="X" testId="insp-x" value={box.x} disabled={disabled} onCommit={(v) => v !== undefined && send((p) => planTransform(p, item.id, { x: v }))} />
          <NumberField label="Y" testId="insp-y" value={box.y} disabled={disabled} onCommit={(v) => v !== undefined && send((p) => planTransform(p, item.id, { y: v }))} />
          <NumberField label="W" testId="insp-w" value={box.w} placeholder="auto" min={1} disabled={disabled} onCommit={(v) => send((p) => planTransform(p, item.id, { w: v ?? null }, v === undefined ? "Fit the text box to its text" : "Set the text box width"))} />
        </div>
        <div className="hint-line muted small">Drag the text in the preview to move it; it snaps to the centre and the safe margins (hold ⌘ to place it freely). W wraps the text; empty fits it.</div>
      </Group>
    </>
  );
}

function AnimationRow({ project, item, slot, disabled }: { project: ProjectModel; item: Item; slot: AnimationSlot; disabled: boolean }) {
  const fps = project.canvas.fps;
  const current = item.animation?.[slot];
  const module = current?.module ?? "";
  const frames = current?.duration ?? Math.min(item.duration, Math.round(fps / 3));
  const set = (next: string, duration: number) => send((p) => planAnimation(p, item.id, slot, next ? { module: next, duration } : null));
  return (
    <Group label={slot === "in" ? "In" : "Out"}>
      <div className="field-row">
        <select className="field input" data-testid={`insp-anim-${slot}`} value={module} disabled={disabled} onChange={(e) => set(e.target.value, frames)}>
          {MOVES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {module && !MOVES.some((m) => m.id === module) && <option value={module}>{module}</option>}
        </select>
        <NumberField
          label="s"
          testId={`insp-anim-${slot}-dur`}
          value={Number((frames / fps).toFixed(2))}
          step={0.1}
          min={0.04}
          disabled={disabled || !module}
          onCommit={(v) => v !== undefined && set(module, Math.round(v * fps))}
        />
      </div>
    </Group>
  );
}

/** The selected text item: content, then Style / Animation / Captions. */
export function TextEditor({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const [tab, setTab] = useState<"style" | "animation" | "captions">("style");
  return (
    <div data-testid="text-editor">
      <TextContent key={item.id} project={project} item={item} disabled={locked} />
      <div className="group tabs-group">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            ["style", "Style"],
            ["animation", "Animation"],
            ["captions", "Captions", true],
          ]}
        />
      </div>
      {tab === "style" && <TextStyleTab project={project} item={item} disabled={locked} />}
      {tab === "animation" && (
        <>
          <AnimationRow project={project} item={item} slot="in" disabled={locked} />
          <AnimationRow project={project} item={item} slot="out" disabled={locked} />
        </>
      )}
    </div>
  );
}

/** A background (component.solid): its colour, or a gradient between two. */
export function BackgroundEditor({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const props = (item.props ?? {}) as { color?: string; to?: string; angle?: number };
  const settle = useSettle(400);
  const drafts = useRef<PreviewDraft | undefined>(undefined);
  const pick = (patch: { color?: string; to?: string }, final: boolean) => {
    if (final) return send((p) => planBackground(p, item.id, patch));
    drafts.current = showDraft(project, planBackground(project, item.id, patch)) ?? drafts.current;
    settle(() => {
      const d = drafts.current;
      drafts.current = undefined;
      send((p) => planBackground(p, item.id, patch), d);
    });
  };
  const gradient = props.to !== undefined;
  return (
    <div data-testid="background-editor">
      <Group label={gradient ? "From" : "Colour"}>
        <ColorPicker project={project} testId="bg-color" value={props.color} disabled={locked} onPick={(color, final) => pick({ color }, final)} />
      </Group>
      <Group label="Gradient">
        <label className="check-row">
          <input
            type="checkbox"
            data-testid="bg-gradient"
            checked={gradient}
            disabled={locked}
            onChange={(e) => {
              // Read now: the plan runs later, when React has put the controlled box back.
              const patch = e.target.checked ? { to: "#3B1E54", angle: 160 } : { to: null };
              send((p) => planBackground(p, item.id, patch));
            }}
          />
          Fade to a second colour
        </label>
        {gradient && (
          <>
            <ColorPicker project={project} testId="bg-to" value={props.to} disabled={locked} onPick={(to, final) => pick({ to }, final)} />
            <div className="field-row">
              <NumberField label="Angle °" testId="bg-angle" value={props.angle ?? 180} disabled={locked} onCommit={(v) => v !== undefined && send((p) => planBackground(p, item.id, { angle: v }))} />
            </div>
          </>
        )}
      </Group>
    </div>
  );
}

/**
 * The sound of a clip or audio item (D54): volume in dB (a slider from −∞ to +12 and a number) and
 * fade in / fade out in seconds. The slider is heard while it moves (the playback mix plays the
 * local draft) and saved once on release; each change is one edit.
 */
export function AudioEditor({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const fps = project.canvas.fps;
  const db = item.gainDb ?? 0;
  const gainDraft = useRef<PreviewDraft | undefined>(undefined);
  const secs = (frames: number | undefined) => Number(((frames ?? 0) / fps).toFixed(2));
  return (
    <div data-testid="audio-editor">
      <Group label="Volume">
        <div className="slider-row">
          <Slider
            testId="insp-volume"
            value={db}
            min={SILENCE_DB}
            max={MAX_DB}
            step={0.5}
            title={`${dbLabel(db)} dB`}
            disabled={locked}
            onPreview={(v) => (gainDraft.current = showDraft(project, planGain(project, item.id, v)) ?? gainDraft.current)}
            onCommit={(v) => {
              const d = gainDraft.current;
              gainDraft.current = undefined;
              send((p) => planGain(p, item.id, v), d);
            }}
          />
          <NumberField label="dB" testId="insp-volume-num" value={db} step={0.5} min={SILENCE_DB} max={MAX_DB} disabled={locked} onCommit={(v) => send((p) => planGain(p, item.id, v ?? 0))} />
        </div>
        <div className="hint-line muted small" data-testid="insp-volume-label">
          {db <= SILENCE_DB ? "Silent (−∞ dB)" : db === 0 ? "As recorded (0 dB)" : `${dbLabel(db)} dB`}
        </div>
      </Group>
      <Group label="Fades">
        <div className="field-row">
          <NumberField label="In s" testId="insp-fade-in" value={secs(item.fadeIn)} step={0.1} min={0} disabled={locked} onCommit={(v) => send((p) => planFade(p, item.id, "in", Math.round((v ?? 0) * fps)))} />
          <NumberField label="Out s" testId="insp-fade-out" value={secs(item.fadeOut)} step={0.1} min={0} disabled={locked} onCommit={(v) => send((p) => planFade(p, item.id, "out", Math.round((v ?? 0) * fps)))} />
        </div>
        <div className="hint-line muted small">Or drag the small handles at the top corners of the item on the timeline.</div>
      </Group>
      <BeatsGroup project={project} item={item} />
    </div>
  );
}

/**
 * The beats of the item's sound (D70): Find beats runs the analysis job (on demand, D66) with its
 * progress and a stop button; once cached, the tempo and the beat count. The timeline draws the
 * beats as ticks and snaps to them.
 */
function BeatsGroup({ project, item }: { project: ProjectModel; item: Item }) {
  const app = useApp();
  const media = soundMedia(project, item);
  const entry = useBeats((s) => (media ? s.entries.get(media.id) : undefined));
  if (!media) return null;
  const online = app.connection === "connected";
  const job = activeAnalyses(app, media.id).find((j) => j.analyzer === "beats");
  return (
    <Group label="Beats">
      <div data-testid="insp-beats" data-state={job ? job.phase : entry === undefined ? "loading" : entry === null || entry === "failed" ? "none" : entry.bpm === null ? "no-beat" : "done"}>
        {job ? (
          <div className="beats-progress" title={analysisText(job)}>
            <Activity />
            <div className="bar">
              <span style={{ width: `${Math.round((job.phase === "running" ? job.progress : 0) * 100)}%` }} />
            </div>
            <button className="icon-btn" data-testid="insp-beats-cancel" title="Stop finding the beats" disabled={!online} onClick={() => void actions.cancelAnalysis(job.id)}>
              <X />
            </button>
          </div>
        ) : entry === null || entry === undefined || entry === "failed" ? (
          <button className="btn" data-testid="insp-find-beats" disabled={!online || entry === undefined} onClick={() => void actions.analyzeBeats(media.id)}>
            <Activity />
            Find beats
          </button>
        ) : entry.bpm === null ? (
          <div className="small" data-testid="insp-beats-summary">No steady beat found</div>
        ) : (
          <div className="small" data-testid="insp-beats-summary">
            {Math.round(entry.bpm)} BPM, {entry.beats.length} beats
          </div>
        )}
        <div className="hint-line muted small">
          {entry && entry !== "failed" && entry.bpm !== null ? "Ticks on the timeline. With snapping on, moves, trims and the playhead stick to them." : "Finds the tempo and the beats, to cut on the beat."}
        </div>
      </div>
    </Group>
  );
}

/**
 * A selected cut on the main track (D73): its transition's type (or none: a hard cut), length in
 * seconds and frames (the module's limits and the cut's: half the shorter clip, the footage past
 * the cut), and Remove (⌫ too). Each change is one edit through planSetTransition.
 */
export function TransitionInspector({ project, placed, online }: { project: ProjectModel; placed: NonNullable<ReturnType<typeof findItem>>; online: boolean }) {
  const fps = project.canvas.fps;
  const { item, index, track } = placed;
  const prev = track.items[index - 1]!;
  const tr = item.transitionIn;
  const locked = !online || track.locked === true || item.locked === true || prev.locked === true;
  const limits = tr ? transitionLimits(project, item.id, tr.module) : undefined;
  const range = limits && !("problem" in limits) ? limits : undefined;
  const set = (next: { module: string; duration?: number } | null) => void actions.setTransition(item.id, next);
  const secs = (frames: number) => Number((frames / fps).toFixed(2));
  return (
    <div data-testid="inspector-transition" data-item={item.id}>
      <div className="insp-title">
        <Blend />
        <span className="ellipsis">{tr ? transitionName(tr.module) : "Cut"}</span>
      </div>
      <div className="insp-sub">
        Between {itemLabel(project, prev)} and {itemLabel(project, item)} on {track.name}.{" "}
        {tr ? "Drag the marker's edges on the timeline to change its length; ⌫ removes it." : "A hard cut. Pick a transition here or click one in the Transitions panel."}
      </div>
      <Group label="Transition">
        <select className="field input" data-testid="insp-transition-type" value={tr?.module ?? ""} disabled={locked} onChange={(e) => set(e.target.value ? { module: e.target.value } : null)}>
          <option value="">None (cut)</option>
          {TRANSITIONS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
          {tr && !transitionInfo(tr.module) && <option value={tr.module}>{transitionName(tr.module)} (draws as a crossfade)</option>}
        </select>
        {tr && transitionInfo(tr.module) && <div className="hint-line muted small">{transitionInfo(tr.module)!.description}</div>}
      </Group>
      {tr && (
        <Group label="Duration">
          <div className="field-row">
            <NumberField
              label="s"
              testId="insp-transition-seconds"
              value={secs(tr.duration)}
              step={Number((1 / fps).toFixed(3))}
              min={0}
              disabled={locked}
              onCommit={(v) => v !== undefined && set({ module: tr.module, duration: Math.round(v * fps) })}
            />
            <NumberField label="frames" testId="insp-transition-frames" value={tr.duration} step={1} min={1} disabled={locked} onCommit={(v) => v !== undefined && set({ module: tr.module, duration: Math.round(v) })} />
          </div>
          <div className="hint-line muted small" data-testid="insp-transition-range">
            {range ? `${secs(range.min)}–${secs(range.max)} s (${range.min}–${range.max} frames) fit at this cut` : limits && "problem" in limits ? limits.problem : ""}
          </div>
        </Group>
      )}
      {tr && (
        <div className="group">
          <button className="btn" data-testid="insp-transition-remove" disabled={locked} onClick={() => set(null)}>
            <X />
            Remove transition
          </button>
        </div>
      )}
      <div className="hint muted small">Esc deselects.</div>
    </div>
  );
}

const FITS: ReadonlyArray<readonly [Fit, string, string]> = [
  ["contain", "Contain", "All of the picture inside the box"],
  ["cover", "Cover", "Fill the box; what doesn't fit is cut off"],
  ["fill", "Fill", "Stretch the picture to the box"],
];

/** A keyframe diamond (D75): filled with a key at the playhead, outlined when the property has keys elsewhere. */
function KeyButton({ project, item, prop, local, inside, disabled }: { project: ProjectModel; item: Item; prop: KeyProp; local: number; inside: boolean; disabled: boolean }) {
  const state = keyState(item, prop, local);
  const title = !inside ? "Move the playhead over the clip to add a key" : state === "on" ? `Remove the ${PROP_NAMES[prop]} key at the playhead` : `Add a ${PROP_NAMES[prop]} key at the playhead`;
  return (
    <button
      className={`icon-btn key-btn ${state}`}
      data-testid="insp-key"
      data-prop={prop}
      data-state={state}
      title={title}
      disabled={disabled || !inside}
      onClick={() => send((p) => planToggleKey(p, item.id, prop, getPlayback().frame))}
    >
      <Diamond />
    </button>
  );
}

/**
 * A clip's box (D75): position and size in canvas pixels, fit, scale (zoom inside the box),
 * opacity, corner radius, keys for x / y / scale / opacity at the playhead, loop, and Reset. Each
 * change is one edit; sliders show a local draft while they move and commit once on release.
 */
export function ClipBoxEditor({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const frame = usePlayback((s) => Math.round(s.frame));
  const state = clipState(project, item.id, frame);
  const scaleDraft = useRef<PreviewDraft | undefined>(undefined);
  const opacityDraft = useRef<PreviewDraft | undefined>(undefined);
  if (!state) return null;
  const { box, local, inside } = state;
  const media = item.media ? project.media.find((m) => m.id === item.media) : undefined;
  const edit = (patch: BoxPatch, summary?: string, d?: PreviewDraft) => send((p) => planClipBox(p, item.id, patch, getPlayback().frame, summary), d);
  const key = (prop: KeyProp) => <KeyButton project={project} item={item} prop={prop} local={local} inside={inside} disabled={locked} />;
  const radius = typeof item.transform?.radius === "number" ? item.transform.radius : 0;
  return (
    <div data-testid="clip-box-editor">
      <Group label="Position & size">
        <div className="field-row key-row">
          <NumberField label="X" testId="insp-box-x" value={Math.round(box.x)} disabled={locked} onCommit={(v) => v !== undefined && edit({ x: v })} />
          {key("x")}
          <NumberField label="Y" testId="insp-box-y" value={Math.round(box.y)} disabled={locked} onCommit={(v) => v !== undefined && edit({ y: v })} />
          {key("y")}
        </div>
        <div className="field-row">
          <NumberField label="W" testId="insp-box-w" value={Math.round(box.w)} min={1} disabled={locked} onCommit={(v) => v !== undefined && edit({ w: v })} />
          <NumberField label="H" testId="insp-box-h" value={Math.round(box.h)} min={1} disabled={locked} onCommit={(v) => v !== undefined && edit({ h: v })} />
        </div>
        <div className="seg fit" role="group">
          {FITS.map(([fit, label, title]) => (
            <button key={fit} className={box.fit === fit ? "active" : ""} data-testid="insp-fit" data-fit={fit} title={title} disabled={locked} onClick={() => edit({ fit })}>
              {label}
            </button>
          ))}
        </div>
      </Group>
      <Group label="Scale and opacity">
        <div className="slider-row key-row">
          <Slider
            testId="insp-scale"
            value={Math.round(box.scale * 100)}
            min={10}
            max={400}
            title="Zoom inside the box"
            disabled={locked}
            onPreview={(v) => (scaleDraft.current = showDraft(project, planClipBox(project, item.id, { scale: v / 100 }, frame)) ?? scaleDraft.current)}
            onCommit={(v) => {
              const d = scaleDraft.current;
              scaleDraft.current = undefined;
              edit({ scale: v / 100 }, undefined, d);
            }}
          />
          <NumberField label="Scale %" testId="insp-scale-num" value={Math.round(box.scale * 100)} min={5} max={2000} disabled={locked} onCommit={(v) => v !== undefined && edit({ scale: v / 100 })} />
          {key("scale")}
        </div>
        <div className="slider-row key-row">
          <Slider
            testId="insp-opacity"
            value={Math.round(box.opacity * 100)}
            min={0}
            max={100}
            disabled={locked}
            onPreview={(v) => (opacityDraft.current = showDraft(project, planClipBox(project, item.id, { opacity: v / 100 }, frame)) ?? opacityDraft.current)}
            onCommit={(v) => {
              const d = opacityDraft.current;
              opacityDraft.current = undefined;
              edit({ opacity: v / 100 }, undefined, d);
            }}
          />
          <NumberField label="Opacity %" testId="insp-opacity-num" value={Math.round(box.opacity * 100)} min={0} max={100} disabled={locked} onCommit={(v) => v !== undefined && edit({ opacity: v / 100 })} />
          {key("opacity")}
        </div>
        <div className="field-row">
          <NumberField label="Radius" testId="insp-radius" value={radius} min={0} disabled={locked} onCommit={(v) => edit({ radius: v ?? 0 })} />
        </div>
      </Group>
      <div className="group">
        {media?.kind === "video" && (
          <label className="check-row">
            <input type="checkbox" data-testid="insp-loop" checked={item.loop === true} disabled={locked} onChange={(e) => {
                const on = e.target.checked;
                send((p) => planLoop(p, item.id, on));
              }} />
            Loop the footage when the clip is longer
          </label>
        )}
        <button className="btn" data-testid="insp-box-reset" disabled={locked || (!item.transform && !item.keys)} onClick={() => send((p) => planResetBox(p, item.id))}>
          <RotateCcw />
          Reset position and size
        </button>
        <div className="hint-line muted small">Drag the selected clip in the preview to move it (it snaps to the centre and the margins; ⌘ places it freely), its corners to resize it (⇧ for any shape). ◆ keys a value at the playhead.</div>
      </div>
    </div>
  );
}
