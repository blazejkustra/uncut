// One component param's control, generated from its schema (D76, rebuilt in D130): text (a
// textarea for multi-line), a colour (swatch, hex, opacity), a number with its unit (a slider too
// when the schema bounds it; the label scrubs), a choice (segmented when short, else a menu), a
// switch, an image picker. Each sits in a labelled row with a reset to the manifest's default.
// Typing and sliding preview live; each commit is one edit (planComponentProps, the whole props).
import { COMPONENT_IMAGE, componentDefaults, type ComponentInfo } from "@uncut/core/components";
import { STICKER_ART } from "@uncut/core/stickers";
import { FOLLOW_PLATFORM_NAMES } from "@uncut/core/elementsMore";
import type { Item } from "@uncut/core/types";
import { useEffect, useRef, useState } from "react";

import { type PreviewDraft } from "../../preview/playback.ts";
import type { ProjectModel } from "../../state/project.ts";
import { planComponentProps } from "../../preview/components.ts";
import { dropDraft, origin, send, showDraft, TYPING_PAUSE_MS } from "../fields.tsx";
import { NumInput, Prop, Segmented, SettledColorField, SliderNum, Toggle } from "../controls.tsx";
import { labelOf, withProp, type Schema } from "./schema.ts";

/**
 * A text field: typing shows in the preview at once (a local draft), saved after a pause, on blur
 * or Enter (⌘Enter when multi-line); Esc puts the saved value back.
 */
export function TextParam({ value, multiline, disabled, testId, onDraft, onCommit }: { value: string; multiline: boolean; disabled: boolean; testId: string; onDraft: (v: string) => PreviewDraft | undefined; onCommit: (v: string, draft: PreviewDraft | undefined, from: ReturnType<typeof origin>) => void }) {
  const [text, setText] = useState(value);
  const dirty = useRef(false);
  const from = useRef(origin());
  const draft = useRef<PreviewDraft | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(text);
  latest.current = text;
  // The saved value as of now (the unmount cleanup's commit must not compare with the first render's).
  const saved = useRef(value);
  saved.current = value;
  useEffect(() => {
    if (!dirty.current) setText(value);
  }, [value]);
  const commit = () => {
    clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    const d = draft.current;
    draft.current = undefined;
    if (latest.current === saved.current) return dropDraft(d);
    onCommit(latest.current, d, from.current);
  };
  // Leaving the item saves what was typed.
  useEffect(() => () => commit(), []);
  const change = (next: string) => {
    if (!dirty.current) from.current = origin();
    dirty.current = true;
    setText(next);
    latest.current = next;
    draft.current = onDraft(next) ?? draft.current;
    clearTimeout(timer.current);
    timer.current = setTimeout(commit, TYPING_PAUSE_MS);
  };
  const keys = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (!multiline || e.metaKey)) {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      clearTimeout(timer.current);
      dirty.current = false;
      dropDraft(draft.current);
      draft.current = undefined;
      setText(value);
      const el = e.currentTarget;
      requestAnimationFrame(() => el.blur());
    }
  };
  return multiline ? (
    <textarea className="field input text-area mono-area" data-testid={testId} value={text} rows={3} disabled={disabled} spellCheck={false} onChange={(e) => change(e.target.value)} onBlur={commit} onKeyDown={keys} />
  ) : (
    <input className="field input" data-testid={testId} value={text} disabled={disabled} spellCheck={false} onChange={(e) => change(e.target.value)} onBlur={commit} onKeyDown={keys} />
  );
}


const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One param's control in its row, from its schema. */
export function Param({ project, item, info, name, schema, disabled }: { project: ProjectModel; item: Item; info: ComponentInfo; name: string; schema: Schema; disabled: boolean }) {
  const props = (item.props ?? {}) as Record<string, unknown>;
  // D266: a sticker saved before `enter` with the older pop: false renders with no way in: show "none".
  const value = info.id === "component.sticker" && name === "enter" && props.enter === undefined && props.pop === false ? "none" : props[name];
  const noun = info.name.toLowerCase();
  const required = info.params.required?.includes(name) ?? false;
  const label = labelOf(name);
  const fallback = componentDefaults(info.id)[name];
  const draft = useRef<PreviewDraft | undefined>(undefined);
  const commit = (next: unknown, summary = `Change ${label.toLowerCase()} of ${noun}`, d?: PreviewDraft, from?: ReturnType<typeof origin>) => {
    const own = d ?? draft.current;
    draft.current = undefined;
    send((p) => planComponentProps(p, item.id, withProp(p, item.id, name, next), summary), own, from);
  };
  const preview = (next: unknown) => (draft.current = showDraft(project, planComponentProps(project, item.id, withProp(project, item.id, name, next), "")) ?? draft.current);
  // Reset: back to the manifest's default (or no value, when it has none and may be left out).
  const reset = value !== undefined && !same(value, fallback) && (fallback !== undefined || !required) ? () => commit(fallback, `Reset ${label.toLowerCase()} of ${noun}`) : undefined;
  const testId = `param-${name}`;
  const unit = schema["x-unit"];

  if (schema.enum) {
    const options = schema.enum.map((v) => String(v));
    const short = options.length <= 4 && options.every((o) => o.length <= 8);
    return (
      <Prop label={label} onReset={reset} testId={`${testId}-row`}>
        {short ? (
          <Segmented testId={testId} options={options.map((o) => [o, o[0]!.toUpperCase() + o.slice(1)] as const)} value={typeof value === "string" ? value : typeof fallback === "string" ? fallback : undefined} disabled={disabled} onChange={(v) => commit(v, `Set ${label.toLowerCase()} of ${noun} to ${v}`)} />
        ) : (
          <select className="pselect" data-testid={testId} value={typeof value === "string" ? value : typeof fallback === "string" ? fallback : ""} disabled={disabled} onChange={(e) => (e.target.value ? commit(e.target.value, `Set ${label.toLowerCase()} of ${noun} to ${e.target.value}`) : commit(undefined, `Clear ${label.toLowerCase()} of ${noun}`))}>
            {/* An optional choice without a default (a sticker's drawn art, D165) can be left unset. */}
            {!required && fallback === undefined && <option value="">None</option>}
            {options.map((o) => (
              <option key={o} value={o}>
                {/* A sticker's drawn art by its name ("Hand-drawn circle"), not its id (D263); a follow handle's platform by its brand name (D275). */}
                {(name === "art" ? STICKER_ART[o]?.name : name === "platform" ? FOLLOW_PLATFORM_NAMES[o] : undefined) ?? o[0]!.toUpperCase() + o.slice(1)}
              </option>
            ))}
          </select>
        )}
      </Prop>
    );
  }
  if (schema["x-control"] === "color") {
    return (
      <Prop label={label} onReset={reset} testId={`${testId}-row`}>
        <SettledColorField project={project} testId={testId} value={typeof value === "string" ? value : typeof fallback === "string" ? fallback : undefined} disabled={disabled} onPreview={preview} onCommit={(c) => commit(c)} />
      </Prop>
    );
  }
  if (schema.type === "string") {
    const multiline = schema["x-control"] === "multiline";
    const field = (
      <TextParam
        value={typeof value === "string" ? value : ""}
        multiline={multiline}
        disabled={disabled}
        testId={testId}
        onDraft={(text) => showDraft(project, planComponentProps(project, item.id, withProp(project, item.id, name, text === "" && !required ? undefined : text), ""))}
        onCommit={(text, d, from) => commit(text === "" && !required ? undefined : text, undefined, d, from)}
      />
    );
    return multiline ? (
      <div className="prop-stack" data-testid={`${testId}-row`}>
        <span className="prop-k">{label}</span>
        {field}
      </div>
    ) : (
      <Prop label={label} onReset={reset} testId={`${testId}-row`}>
        {field}
      </Prop>
    );
  }
  if (schema.type === "number" || schema.type === "integer") {
    const int = schema.type === "integer";
    const n = typeof value === "number" ? value : typeof fallback === "number" ? fallback : undefined;
    const bounded = schema.minimum !== undefined && schema.maximum !== undefined;
    const step = int ? 1 : bounded && schema.maximum! - schema.minimum! <= 5 ? 0.1 : 1;
    const round = (v: number) => (int ? Math.round(v) : v);
    return (
      <Prop label={label} onReset={reset} testId={`${testId}-row`}>
        {bounded ? (
          <SliderNum testId={testId} value={n ?? schema.minimum!} min={schema.minimum!} max={schema.maximum!} step={step} unit={unit} disabled={disabled} onPreview={(v) => preview(round(v))} onCommit={(v) => commit(round(v))} />
        ) : (
          <NumInput testId={testId} value={n} unit={unit} step={step} min={schema.minimum} max={schema.maximum} disabled={disabled} clearable={!required} onPreview={(v) => preview(round(v))} onCommit={(v) => commit(v === undefined ? undefined : round(v))} />
        )}
      </Prop>
    );
  }
  if (schema.type === "boolean") {
    const on = value === undefined ? fallback === true : value === true;
    return (
      <Prop label={label} onReset={reset} testId={`${testId}-row`}>
        <div className="prop-toggle">
          <Toggle testId={testId} label={label} value={on} disabled={disabled} onChange={(v) => commit(v ? true : fallback === true ? false : undefined, `${v ? "Turn on" : "Turn off"} ${label.toLowerCase()} of ${noun}`)} />
        </div>
      </Prop>
    );
  }
  // A media reference ({ media: id }): an image (a logo, a framed picture).
  if (schema.type === "object" && schema.properties?.media) {
    const id = value && typeof value === "object" ? (value as { media?: unknown }).media : undefined;
    // Only images the preview and export can draw in a component (no TIFF or HEIC).
    const images = project.media.filter((m) => m.kind === "image" && COMPONENT_IMAGE.test(m.path));
    return (
      <Prop label={label} onReset={value !== undefined && !required ? () => commit(undefined, `Remove ${label.toLowerCase()} of ${noun}`) : undefined} testId={`${testId}-row`}>
        <select
          className="pselect"
          data-testid={testId}
          value={typeof id === "string" ? id : ""}
          disabled={disabled}
          onChange={(e) => (e.target.value ? commit({ media: e.target.value }, `Set ${label.toLowerCase()} of ${noun}`) : commit(undefined, `Remove ${label.toLowerCase()} of ${noun}`))}
        >
          <option value="">{images.length ? "None" : "No images"}</option>
          {images.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </Prop>
    );
  }
  return null;
}
