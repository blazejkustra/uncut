// A component param that is a list of rows (a chart's bars, a terminal's lines; D76): each row's
// fields, + adds one, − removes one; each change one edit. Split out of panels/ComponentEditor.tsx.
import type { ComponentInfo } from "@uncut/core/components";
import type { Item } from "@uncut/core/types";
import { Minus, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { findItem } from "../../timeline/edit.ts";
import type { ProjectModel } from "../../state/project.ts";
import { planComponentProps } from "../../preview/components.ts";
import { NumberField, send } from "../fields.tsx";
import { Section } from "../controls.tsx";
import { labelOf, rowWord, withProp, type Schema } from "./schema.ts";

/** A list of rows (a chart's bars, a terminal's lines): each row's fields, + adds one, − removes one. */
export function ListParam({ item, info, name, schema, disabled }: { project: ProjectModel; item: Item; info: ComponentInfo; name: string; schema: Schema; disabled: boolean }) {
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
    <Section title={labelOf(name)} testId={`param-sec-${name}`}>
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
    </Section>
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

