// The Inspector for components (D76), built from the component manifest's params JSON Schema:
// text fields (a textarea for multi-line ones), numbers, colours (x-control "color"), choices
// (enum), switches (boolean), a media picker ({ media } references) and lists of rows (arrays of
// objects, e.g. a chart's bars or a terminal's lines). Every change is one edit (planComponentProps:
// the whole props object, since update_item replaces nested objects) with a History label such as
// "Change title of end card"; typing shows in the preview at once and is saved after a pause, on
// blur or with Enter (⌘Enter in a multi-line field). A device frame also gets its footage picker.
import { COMPONENT_IMAGE, componentInfo, DEVICES, type ComponentInfo, type Device } from "@uncut/core/components";
import type { Item } from "@uncut/core/types";
import { Minus, Plus, Smartphone } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { findItem } from "../timeline/edit.ts";
import { ColorPicker, dropDraft, Group, NumberField, origin, send, showDraft, TYPING_PAUSE_MS } from "./ItemEditors.tsx";
import { type PreviewDraft } from "../preview/playback.ts";
import type { ProjectModel } from "../state/project.ts";
import { planAlignScreen, planComponentProps, planDevice, planScreenFootage, screenClipOf } from "../preview/components.ts";

type Schema = {
  readonly type?: string;
  readonly enum?: ReadonlyArray<unknown>;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: ReadonlyArray<string>;
  readonly items?: Schema;
  readonly maxItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly "x-control"?: string;
};

const WORDS: Readonly<Record<string, string>> = { url: "URL", typeFrom: "Type from (frame)", speed: "Speed (characters/s)", max: "Full bar at", at: "At frame", code: "Code", kind: "Kind" };
/** A param's label: "typeFrom" → "Type from (frame)", "title" → "Title". */
const labelOf = (key: string) => WORDS[key] ?? `${key[0]!.toUpperCase()}${key.slice(1).replace(/([A-Z])/g, " $1").toLowerCase()}`;
/** A list's row in words: "bars" → "bar", "lines" → "line". */
const rowWord = (key: string) => key.replace(/s$/, "");

/** The props as they are in `p` (the newest project), with `key` set (undefined removes it). */
const withProp = (p: ProjectModel, id: string, key: string, value: unknown) => {
  const props: Record<string, unknown> = { ...((findItem(p, id)?.item.props ?? {}) as Record<string, unknown>) };
  if (value === undefined) delete props[key];
  else props[key] = value;
  return props;
};

/**
 * A text field: typing shows in the preview at once (a local draft), saved after a pause, on blur
 * or Enter (⌘Enter when multi-line); Esc puts the saved value back.
 */
function TextParam({ value, multiline, disabled, testId, onDraft, onCommit }: { value: string; multiline: boolean; disabled: boolean; testId: string; onDraft: (v: string) => PreviewDraft | undefined; onCommit: (v: string, draft: PreviewDraft | undefined, from: ReturnType<typeof origin>) => void }) {
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

/** One param's control, from its schema. */
function Param({ project, item, info, name, schema, disabled }: { project: ProjectModel; item: Item; info: ComponentInfo; name: string; schema: Schema; disabled: boolean }) {
  const props = (item.props ?? {}) as Record<string, unknown>;
  const value = props[name];
  const noun = info.name.toLowerCase();
  const required = info.params.required?.includes(name) ?? false;
  const label = labelOf(name);
  const commit = (next: unknown, summary = `Change ${label.toLowerCase()} of ${noun}`, draft?: PreviewDraft, from?: ReturnType<typeof origin>) =>
    send((p) => planComponentProps(p, item.id, withProp(p, item.id, name, next), summary), draft, from);
  const testId = `param-${name}`;

  // A device frame's device also reshapes the frame and moves its footage (planDevice).
  if (info.id === "component.device-frame" && name === "device") {
    return (
      <Group label="Device">
        <div className="seg" role="group">
          {DEVICES.map((d) => (
            <button key={d} className={(value ?? "phone") === d ? "active" : ""} data-testid={testId} data-value={d} disabled={disabled} onClick={() => send((p) => planDevice(p, item.id, d as Device))}>
              {d === "phone" ? "Phone" : d === "android" ? "Android" : "Browser"}
            </button>
          ))}
        </div>
      </Group>
    );
  }
  if (schema.enum) {
    return (
      <Group label={label}>
        <div className="seg" role="group">
          {schema.enum.map((v) => (
            <button key={String(v)} className={value === v ? "active" : ""} data-testid={testId} data-value={String(v)} disabled={disabled} onClick={() => commit(v, `Set ${label.toLowerCase()} of ${noun} to ${String(v)}`)}>
              {String(v)}
            </button>
          ))}
        </div>
      </Group>
    );
  }
  if (schema["x-control"] === "color") {
    return (
      <Group label={label}>
        <ColorPicker project={project} testId={testId} value={typeof value === "string" ? value : undefined} disabled={disabled} onPick={(color, final) => final && commit(color)} />
        {!required && value !== undefined && (
          <button className="link-btn small" data-testid={`${testId}-clear`} disabled={disabled} onClick={() => commit(undefined, `Remove ${label.toLowerCase()} of ${noun}`)}>
            None
          </button>
        )}
      </Group>
    );
  }
  if (schema.type === "string") {
    const multiline = schema["x-control"] === "multiline";
    return (
      <Group label={label}>
        <TextParam
          value={typeof value === "string" ? value : ""}
          multiline={multiline}
          disabled={disabled}
          testId={testId}
          onDraft={(text) => showDraft(project, planComponentProps(project, item.id, withProp(project, item.id, name, text === "" && !required ? undefined : text), ""))}
          onCommit={(text, draft, from) => commit(text === "" && !required ? undefined : text, undefined, draft, from)}
        />
      </Group>
    );
  }
  if (schema.type === "number" || schema.type === "integer") {
    return (
      <div className="field-row">
        <NumberField label={label} testId={testId} value={typeof value === "number" ? value : undefined} min={schema.minimum} max={schema.maximum} disabled={disabled} onCommit={(v) => commit(v === undefined ? undefined : schema.type === "integer" ? Math.round(v) : v)} />
      </div>
    );
  }
  if (schema.type === "boolean") {
    return (
      <label className="check-row">
        <input type="checkbox" data-testid={testId} checked={value === true} disabled={disabled} onChange={(e) => commit(e.target.checked ? true : undefined)} />
        {label}
      </label>
    );
  }
  // A media reference ({ media: id }): an image for a logo.
  if (schema.type === "object" && schema.properties?.media) {
    const id = value && typeof value === "object" ? (value as { media?: unknown }).media : undefined;
    // Only images the preview and export can draw in a component (no TIFF or HEIC).
    const images = project.media.filter((m) => m.kind === "image" && COMPONENT_IMAGE.test(m.path));
    return (
      <Group label={label}>
        <select
          className="field input"
          data-testid={testId}
          value={typeof id === "string" ? id : ""}
          disabled={disabled}
          onChange={(e) => (e.target.value ? commit({ media: e.target.value }, `Set ${label.toLowerCase()} of ${noun}`) : commit(undefined, `Remove ${label.toLowerCase()} of ${noun}`))}
        >
          <option value="">None</option>
          {images.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        {!images.length && <div className="hint-line muted small">Import an image (PNG, JPEG, WebP, GIF, BMP or SVG) in the Media tab to use it here.</div>}
      </Group>
    );
  }
  if (schema.type === "array" && schema.items?.properties) return <ListParam project={project} item={item} info={info} name={name} schema={schema} disabled={disabled} />;
  return null;
}

/** A list of rows (a chart's bars, a terminal's lines): each row's fields, + adds one, − removes one. */
function ListParam({ item, info, name, schema, disabled }: { project: ProjectModel; item: Item; info: ComponentInfo; name: string; schema: Schema; disabled: boolean }) {
  const rows = Array.isArray(item.props?.[name]) ? (item.props![name] as ReadonlyArray<Record<string, unknown>>) : [];
  const fields = Object.entries(schema.items!.properties!);
  const required = schema.items!.required ?? [];
  const noun = info.name.toLowerCase();
  const word = rowWord(name);
  const save = (make: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>, summary: string) =>
    send((p) => {
      const now = findItem(p, item.id)?.item.props?.[name];
      return planComponentProps(p, item.id, withProp(p, item.id, name, make(Array.isArray(now) ? (now as Array<Record<string, unknown>>).map((r) => ({ ...r })) : [])), summary);
    });
  const setField = (i: number, key: string, v: unknown) =>
    save((list) => {
      if (!list[i]) return list;
      if (v === undefined) delete list[i]![key];
      else list[i]![key] = v;
      return list;
    }, `Change ${word} ${i + 1} of ${noun}`);
  const blank = () => Object.fromEntries(required.map((k) => [k, schema.items!.properties![k]?.type === "number" ? 0 : schema.items!.properties![k]?.type === "string" ? "" : false]));
  return (
    <Group label={labelOf(name)}>
      <div className="param-list" data-testid={`param-${name}`}>
        {rows.map((row, i) => (
          <div key={i} className="param-row" data-testid="param-row">
            {fields.map(([key, f]) =>
              f.enum ? (
                <select key={key} className="field input" data-testid={`param-${name}-${key}`} value={typeof row[key] === "string" ? (row[key] as string) : ""} disabled={disabled} title={labelOf(key)} onChange={(e) => setField(i, key, e.target.value || undefined)}>
                  {!required.includes(key) && <option value="">{labelOf(key)}…</option>}
                  {f.enum.map((v) => (
                    <option key={String(v)} value={String(v)}>
                      {String(v)}
                    </option>
                  ))}
                </select>
              ) : f.type === "boolean" ? (
                <label key={key} className="check-row" title={labelOf(key)}>
                  <input type="checkbox" data-testid={`param-${name}-${key}`} checked={row[key] === true} disabled={disabled} onChange={(e) => setField(i, key, e.target.checked ? true : undefined)} />
                  {labelOf(key)}
                </label>
              ) : f.type === "number" || f.type === "integer" ? (
                <NumberField key={key} label={labelOf(key)} testId={`param-${name}-${key}`} value={typeof row[key] === "number" ? (row[key] as number) : undefined} min={f.minimum} disabled={disabled} onCommit={(v) => setField(i, key, v === undefined ? (required.includes(key) ? 0 : undefined) : f.type === "integer" ? Math.round(v) : v)} />
              ) : (
                <RowText key={key} value={typeof row[key] === "string" ? (row[key] as string) : ""} placeholder={labelOf(key)} testId={`param-${name}-${key}`} disabled={disabled} onCommit={(v) => setField(i, key, v === "" && !required.includes(key) ? undefined : v)} />
              ),
            )}
            <button className="icon-btn" data-testid="param-row-remove" title={`Remove this ${word}`} disabled={disabled} onClick={() => save((list) => list.filter((_, k) => k !== i), `Remove a ${word} from ${noun}`)}>
              <Minus />
            </button>
          </div>
        ))}
        <button className="btn small-btn" data-testid="param-row-add" disabled={disabled || (schema.maxItems !== undefined && rows.length >= schema.maxItems)} onClick={() => save((list) => [...list, blank()], `Add a ${word} to ${noun}`)}>
          <Plus />
          Add {word}
        </button>
      </div>
    </Group>
  );
}

/** A row's text field: saved on blur or Enter, Esc puts it back. */
function RowText({ value, placeholder, testId, disabled, onCommit }: { value: string; placeholder: string; testId: string; disabled: boolean; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className="field input"
      data-testid={testId}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setText(value);
          const el = e.currentTarget;
          requestAnimationFrame(() => el.blur());
        }
      }}
    />
  );
}

/** A device frame's footage (D76): a clip under it on its screen. Pick one, change it, take it out, or fit it back to the screen. */
function ScreenFootage({ project, item, disabled }: { project: ProjectModel; item: Item; disabled: boolean }) {
  const clip = screenClipOf(project, item.id);
  const footage = project.media.filter((m) => m.kind === "video" || m.kind === "image");
  return (
    <Group label="Screen">
      <select
        className="field input"
        data-testid="device-footage"
        value={clip?.item.media ?? ""}
        disabled={disabled}
        onChange={(e) => {
          const id = e.target.value || null;
          send((p) => planScreenFootage(p, item.id, id));
        }}
      >
        <option value="">Empty (shows what's under it)</option>
        {footage.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      {clip && (
        <button className="btn" data-testid="device-align" disabled={disabled} onClick={() => send((p) => planAlignScreen(p, item.id))}>
          <Smartphone />
          Fit footage to the screen
        </button>
      )}
      <div className="hint-line muted small">The footage is a clip under the frame ({clip ? clip.item.id : "none yet"}). After moving or resizing the frame, fit it to the screen again.</div>
    </Group>
  );
}

/** A component's params (D76), built from its manifest. */
export function ComponentEditor({ project, item, locked }: { project: ProjectModel; item: Item; locked: boolean }) {
  const info = componentInfo(item.component);
  if (!info) return null;
  const params = Object.entries(info.params.properties ?? {}) as Array<[string, Schema]>;
  return (
    <div data-testid="component-editor" data-component={info.id}>
      {params.map(([name, schema]) => (
        <Param key={name} project={project} item={item} info={info} name={name} schema={schema} disabled={locked} />
      ))}
      {info.id === "component.device-frame" && <ScreenFootage project={project} item={item} disabled={locked} />}
    </div>
  );
}
