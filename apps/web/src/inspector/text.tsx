// The Inspector's text editor (phase 4 chunk 4, D16/D53/D80): content, then Style / Animation tabs.
import { TEXT_STYLES } from "@uncut/core/render";
import type { Item } from "@uncut/core/types";
import { AlignCenter, AlignLeft, AlignRight, Crosshair, Highlighter, RotateCcw, X } from "lucide-react";
import type { Fit } from "@uncut/core/box";
import { useEffect, useRef, useState } from "react";

import { findItem } from "../timeline/edit.ts";
import { type PreviewDraft } from "../preview/playback.ts";
import { type ProjectModel } from "../state/project.ts";
import { actions, getState, projectOf } from "../state/store.ts";
import { MOVES, planAnimation, planCentre, planPreset, planResetLook, planShadow, planStroke, planStyle, planText, planTextBox, planTransform, textBox, textDecorOf, toggleAccent, type AnimationSlot } from "../preview/text.ts";
import { WORD_STYLES, ZOOM_DEFAULTS } from "@uncut/core/looks";
import { TYPING_PAUSE_MS, showDraft, dropDraft, origin, send, NumberField, ColorPicker, useSettle, Slider, Tabs, Group } from "./fields.tsx";

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
    </div>
  );
}

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
/** Fonts the Style tab offers: the preset's (system), the system mono, and the bundled DM Sans / DM Mono (D77). */
const FONTS: ReadonlyArray<readonly [string, string]> = [
  ["", "Preset font (system)"],
  ["mono", "System mono"],
  ["DM Sans", "DM Sans"],
  ["DM Mono", "DM Mono"],
];
const WEIGHT_NAMES: Readonly<Record<number, string>> = { 100: "Thin", 200: "Extra light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Heavy", 900: "Black" };
const ALIGNS = [
  ["left", AlignLeft],
  ["center", AlignCenter],
  ["right", AlignRight],
] as const;

export function TextStyleTab({ project, item, disabled }: { project: ProjectModel; item: Item; disabled: boolean }) {
  const box = textBox(item, project);
  const settle = useSettle(400);
  const colorDraft = useRef<PreviewDraft | undefined>(undefined);
  const maxSize = Math.round(project.canvas.height * 0.4);
  const sizeDraft = useRef<PreviewDraft | undefined>(undefined);
  return (
    <>
      <Group label="Style">
        <div className="presets">
          {Object.entries(TEXT_STYLES).map(([id, look]) => (
            <button key={id} className={`preset ${item.style?.preset === id ? "active" : ""}`} data-testid="insp-preset" data-preset={id} title={look.description || `Apply ${look.name}`} disabled={disabled} onClick={() => send((p) => planPreset(p, item.id, id))}>
              {look.name}
            </button>
          ))}
        </div>
        <button className="link-btn small" data-testid="insp-reset-look" disabled={disabled || !TEXT_STYLES[item.style?.preset ?? ""]} title="Put the preset's whole look back: size, weight, font, outline, shadow, box and position" onClick={() => send((p) => planResetLook(p, item.id))}>
          <RotateCcw /> Reset to preset
        </button>
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
        <select
          className="field input"
          data-testid="insp-font"
          value={FONTS.some(([v]) => v === (item.style?.font ?? "")) ? (item.style?.font ?? "") : ""}
          disabled={disabled}
          title="Font: the system's, or the bundled DM Sans and DM Mono (the same in the preview and the export)"
          onChange={(e) => {
            const font = e.target.value || null;
            send((p) => planStyle(p, item.id, { font }, font ? `Set font to ${font}` : "Use the preset's font"));
          }}
        >
          {FONTS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
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
      <TextDecorGroups project={project} item={item} disabled={disabled} />
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
      </Group>
    </>
  );
}

/** A colour that commits on a swatch at once and on the custom picker once it settles (like the text colour). */
function SettledColor({ project, value, testId, disabled, onCommit }: { project: ProjectModel; value: string | undefined; testId: string; disabled: boolean; onCommit: (color: string) => void }) {
  const settle = useSettle(400);
  return <ColorPicker project={project} testId={testId} value={value} disabled={disabled} onPick={(color, final) => (final ? onCommit(color) : settle(() => onCommit(color)))} />;
}

/**
 * Spacing, outline, shadow and box (D80): what the text draws now (its look's where it sets
 * none), each change one edit (planStroke / planShadow / planTextBox). None writes false, so a
 * look's outline, shadow or box goes too.
 */
function TextDecorGroups({ project, item, disabled }: { project: ProjectModel; item: Item; disabled: boolean }) {
  const d = textDecorOf(item, project);
  const pct = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 100));
  const wrap = d.background ? (d.background.wrap ?? "box") : "none";
  return (
    <>
      <Group label="Spacing and case">
        <div className="field-row three">
          <NumberField label="Tracking em" testId="insp-tracking" value={Math.round(d.tracking * 1000) / 1000} step={0.01} min={-0.5} max={2} disabled={disabled} onCommit={(v) => send((p) => planStyle(p, item.id, { tracking: v ?? null }, v === undefined ? "Use the preset's letter spacing" : `Set letter spacing to ${v} em`))} />
          <NumberField label="Line" testId="insp-line-height" value={Math.round(d.lineHeight * 100) / 100} step={0.05} min={0.5} max={4} disabled={disabled} onCommit={(v) => send((p) => planStyle(p, item.id, { lineHeight: v ?? null }, v === undefined ? "Use the preset's line height" : `Set line height to ${v}`))} />
          <button className={`btn small-btn ${d.uppercase ? "active" : ""}`} data-testid="insp-uppercase" aria-pressed={d.uppercase} title="Capital letters" disabled={disabled} onClick={() => send((p) => planStyle(p, item.id, { uppercase: !d.uppercase }, d.uppercase ? "Use normal case" : "Set text in capitals"))}>
            AA
          </button>
        </div>
      </Group>
      <Group label="Outline">
        <div className="seg" role="group">
          <button className={!d.stroke ? "active" : ""} data-testid="insp-stroke-none" disabled={disabled} onClick={() => d.stroke && send((p) => planStroke(p, item.id, false))}>
            None
          </button>
          <button className={d.stroke ? "active" : ""} data-testid="insp-stroke-on" disabled={disabled} onClick={() => !d.stroke && send((p) => planStroke(p, item.id, {}))}>
            Outline
          </button>
        </div>
        {d.stroke && (
          <>
            <NumberField label="Width" testId="insp-stroke-width" value={d.stroke.width} step={1} min={0} max={200} disabled={disabled} onCommit={(v) => v !== undefined && send((p) => planStroke(p, item.id, { width: v }))} />
            <SettledColor project={project} testId="insp-stroke-color" value={d.stroke.color ?? "#000000"} disabled={disabled} onCommit={(color) => send((p) => planStroke(p, item.id, { color }))} />
          </>
        )}
      </Group>
      <Group label="Shadow">
        <div className="seg" role="group">
          <button className={!d.shadow ? "active" : ""} data-testid="insp-shadow-none" disabled={disabled} onClick={() => d.shadow && send((p) => planShadow(p, item.id, false))}>
            None
          </button>
          <button className={d.shadow ? "active" : ""} data-testid="insp-shadow-on" disabled={disabled} onClick={() => !d.shadow && send((p) => planShadow(p, item.id, {}))}>
            Shadow
          </button>
        </div>
        {d.shadow && (
          <>
            <div className="field-row three">
              <NumberField label="X" testId="insp-shadow-x" value={d.shadow.x ?? 0} disabled={disabled} onCommit={(v) => v !== undefined && send((p) => planShadow(p, item.id, { x: v }))} />
              <NumberField label="Y" testId="insp-shadow-y" value={d.shadow.y ?? 0} disabled={disabled} onCommit={(v) => v !== undefined && send((p) => planShadow(p, item.id, { y: v }))} />
              <NumberField label="Blur" testId="insp-shadow-blur" value={d.shadow.blur ?? 0} min={0} disabled={disabled} onCommit={(v) => v !== undefined && send((p) => planShadow(p, item.id, { blur: v }))} />
            </div>
            <NumberField label="Opacity" testId="insp-shadow-opacity" value={pct(d.shadow.opacity ?? 1)} min={0} max={100} disabled={disabled} onCommit={(v) => v !== undefined && send((p) => planShadow(p, item.id, { opacity: v / 100 }))} />
            <SettledColor project={project} testId="insp-shadow-color" value={d.shadow.color ?? "#000000"} disabled={disabled} onCommit={(color) => send((p) => planShadow(p, item.id, { color }))} />
          </>
        )}
      </Group>
      <Group label="Box">
        <div className="seg" role="group">
          {(
            [
              ["none", "None"],
              ["box", "Box"],
              ["lines", "Per line"],
            ] as const
          ).map(([w, label]) => (
            <button key={w} className={wrap === w ? "active" : ""} data-testid="insp-box" data-wrap={w} disabled={disabled} onClick={() => wrap !== w && send((p) => planTextBox(p, item.id, w === "none" ? false : { wrap: w }))}>
              {label}
            </button>
          ))}
        </div>
        {d.background && (
          <>
            <div className="field-row three">
              <NumberField label="Padding" testId="insp-box-padding" value={d.background.padding ?? 0} min={0} disabled={disabled} onCommit={(v) => v !== undefined && send((p) => planTextBox(p, item.id, { padding: v }))} />
              <NumberField label="Radius" testId="insp-box-radius" value={d.background.radius ?? 0} min={0} disabled={disabled} onCommit={(v) => v !== undefined && send((p) => planTextBox(p, item.id, { radius: v }))} />
              <NumberField label="Opacity" testId="insp-box-opacity" value={pct(d.background.opacity ?? 1)} min={0} max={100} disabled={disabled} onCommit={(v) => v !== undefined && send((p) => planTextBox(p, item.id, { opacity: v / 100 }))} />
            </div>
            <SettledColor project={project} testId="insp-box-color" value={d.background.color ?? "#000000"} disabled={disabled} onCommit={(color) => send((p) => planTextBox(p, item.id, { color }))} />
          </>
        )}
      </Group>
    </>
  );
}

const EASE_NAMES = [
  ["linear", "Linear"],
  ["out", "Ease out"],
  ["in", "Ease in"],
  ["inOut", "Ease in and out"],
] as const;

function AnimationRow({ project, item, slot, disabled }: { project: ProjectModel; item: Item; slot: AnimationSlot; disabled: boolean }) {
  const fps = project.canvas.fps;
  const current = item.animation?.[slot];
  const module = current?.module ?? "";
  const frames = current?.duration ?? Math.min(item.duration, Math.round(fps / 3));
  const params = current?.params ?? {};
  const set = (next: string, duration: number, nextParams: { readonly [key: string]: unknown } = next === module ? params : {}) =>
    send((p) => planAnimation(p, item.id, slot, next ? { module: next, duration, params: nextParams } : null));
  const setParam = (key: string, value: unknown) => set(module, frames, { ...params, [key]: value });
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
      {module === "move.word-by-word" && (
        <div className="seg" role="group" data-testid={`insp-anim-${slot}-words`}>
          {WORD_STYLES.map((w) => (
            <button key={w} className={(params.style ?? "pop") === w ? "active" : ""} data-testid={`insp-anim-${slot}-word-style`} data-style={w} disabled={disabled} onClick={() => setParam("style", w)}>
              {w[0]!.toUpperCase() + w.slice(1)}
            </button>
          ))}
        </div>
      )}
      {module === "move.zoom" && (
        <div className="field-row">
          <NumberField
            label={slot === "in" ? "From %" : "To %"}
            testId={`insp-anim-${slot}-zoom-scale`}
            value={Math.round((typeof params.scale === "number" ? params.scale : ZOOM_DEFAULTS.scale) * 100)}
            min={5}
            max={400}
            step={5}
            disabled={disabled}
            onCommit={(v) => v !== undefined && setParam("scale", v / 100)}
          />
          <select className="field input" data-testid={`insp-anim-${slot}-zoom-ease`} value={typeof params.ease === "string" ? params.ease : ZOOM_DEFAULTS.ease} disabled={disabled} onChange={(e) => setParam("ease", e.target.value)}>
            {EASE_NAMES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </div>
      )}
    </Group>
  );
}

/** The selected text item: content, then Style / Animation. */
export function TextEditor({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const [tab, setTab] = useState<"style" | "animation">("style");
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

/**
 * The selected captions (D82): how they show (line by line, word by word, one word at a time), how
 * words are grouped into cards, fillers, the card under the playhead with each word editable (a
 * fix, "" hides it) and a "new card here" toggle per word, a list of every card (click goes there),
 * then the Style tab text items have. Each change is one edit.
 */
