// A graphic's elements in the Inspector (D316): the list (click selects, here, on the timeline and
// on the canvas), and the selected element's times and looks. Each change is one edit on the item.
import { elementSpan, itemFrameOf, planElementEdit, type ElementChange, type GraphicElement } from "@uncut/core/graphicElements";
import { graphicTime } from "@uncut/core/graphics";
import type { Item } from "@uncut/core/types";

import { playback, usePlayback } from "../preview/playback.ts";
import type { ProjectModel } from "../state/project.ts";
import { findItem } from "../timeline/edit.ts";
import { elementsOf, seekToElement, useElementsVersion } from "../timeline/graphicElements.ts";
import { resetOp } from "../timeline/ElementRows.tsx";
import { Prop, Section } from "./controls.tsx";
import { ColorPicker, NumberField, send } from "./fields.tsx";

const seconds = (frames: number, fps: number) => Math.round((frames / fps) * 100) / 100;

function ElementEditor({
  project,
  item,
  element,
  start,
  locked,
}: {
  project: ProjectModel;
  item: Item;
  element: GraphicElement;
  start: number;
  locked: boolean;
}) {
  const fps = project.canvas.fps;
  const edit = item.elements?.[element.key];
  const [a, b] = elementSpan(element, edit);
  const change = (next: ElementChange, summary = `Edited ${element.name}`) =>
    send((p) => {
      const now = findItem(p, item.id)?.item ?? item;
      return { ops: [planElementEdit(now, element, next)], summary };
    });
  const frameOn = (s: number) => graphicTime(item, Math.round(s * fps) - start);
  return (
    <Section title={element.name} testId="insp-element">
      <div className="insp-sub" data-testid="element-timing">
        {element.timing === "declared" ? "Times from the file" : "Times measured from what it draws"}
      </div>
      <Prop label="In">
        <NumberField
          label="s"
          testId="element-in"
          step={0.1}
          disabled={locked}
          value={seconds(start + itemFrameOf(item, a), fps)}
          onCommit={(v) => v !== undefined && change({ in: frameOn(v) })}
        />
      </Prop>
      <Prop label="Out">
        <NumberField
          label="s"
          testId="element-out"
          step={0.1}
          disabled={locked}
          value={seconds(start + itemFrameOf(item, b), fps)}
          onCommit={(v) => v !== undefined && change({ out: frameOn(v) })}
        />
      </Prop>
      {element.text && (
        <Prop label="Text">
          <textarea
            key={`${element.key}-${edit?.text ?? ""}`}
            className="input"
            data-testid="element-text"
            rows={2}
            disabled={locked}
            defaultValue={edit?.text ?? element.text}
            onBlur={(e) => {
              const text = e.target.value;
              if (text !== (edit?.text ?? element.text)) change({ text: text || null });
            }}
          />
        </Prop>
      )}
      {element.kind === "text" && (
        <Prop label="Color" {...(edit?.color ? { onReset: () => change({ color: null }) } : {})}>
          <ColorPicker
            project={project}
            value={edit?.color ?? "#ffffff"}
            testId="element-color"
            disabled={locked}
            onPick={(color, final) => final && change({ color })}
          />
        </Prop>
      )}
      <Prop label="Position">
        <NumberField label="X" testId="element-x" disabled={locked} value={edit?.x ?? 0} onCommit={(x) => change({ x: x || null })} />
        <NumberField label="Y" testId="element-y" disabled={locked} value={edit?.y ?? 0} onCommit={(y) => change({ y: y || null })} />
      </Prop>
      <Prop label="Scale">
        <NumberField
          label="%"
          testId="element-scale"
          min={1}
          max={2000}
          disabled={locked}
          value={Math.round((edit?.scale ?? 1) * 100)}
          onCommit={(v) => change({ scale: v === undefined || v === 100 ? null : v / 100 })}
        />
      </Prop>
      <Prop label="Opacity">
        <NumberField
          label="%"
          testId="element-opacity"
          min={0}
          max={100}
          disabled={locked}
          value={Math.round((edit?.opacity ?? 1) * 100)}
          onCommit={(v) => change({ opacity: v === undefined || v === 100 ? null : v / 100 })}
        />
      </Prop>
      <div className="insp-actions">
        <button
          className="btn"
          data-testid="element-delete"
          disabled={locked || edit?.hidden}
          onClick={() => change({ hidden: true }, `Deleted ${element.name}`)}
        >
          Delete element
        </button>
        <button
          className="btn"
          data-testid="element-reset"
          disabled={locked || !edit}
          onClick={() => send((p) => ({ ops: [resetOp(findItem(p, item.id)?.item ?? item, element)], summary: `Reset ${element.name}` }))}
        >
          Reset
        </button>
      </div>
    </Section>
  );
}

export function GraphicElementsEditor({ project, item, start, locked }: { project: ProjectModel; item: Item; start: number; locked: boolean }) {
  useElementsVersion();
  const selected = usePlayback((s) => s.element);
  const known = elementsOf(item.src);
  if (!known || known.status === "loading")
    return (
      <div className="insp-sub" data-testid="elements-reading">
        Reading the graphic's elements
      </div>
    );
  if (!known.elements.length)
    return (
      <div className="insp-sub" data-testid="elements-reason">
        {known.reason}
      </div>
    );
  const fps = project.canvas.fps;
  const element = known.elements.find((e) => e.key === selected);
  return (
    <>
      <Section title={`Elements (${known.elements.length})`} testId="insp-elements" remember="elements">
        <div className="el-list" data-testid="element-list">
          {known.elements.map((e) => {
            const edit = item.elements?.[e.key];
            const [a, b] = elementSpan(e, edit);
            return (
              <button
                key={e.key}
                className={`el-row ${e.key === selected ? "on" : ""} ${edit?.hidden ? "gone" : ""}`}
                data-testid="element-row"
                data-element={e.key}
                onClick={() => {
                  playback.selectElement(item.id, e.key);
                  if (!edit?.hidden) seekToElement(start, itemFrameOf(item, a), itemFrameOf(item, b));
                }}
              >
                <span className="el-row-name">{e.name}</span>
                <span className="el-row-time">{edit?.hidden ? "Deleted" : `${seconds(start + itemFrameOf(item, a), fps)} s`}</span>
              </button>
            );
          })}
        </div>
      </Section>
      {element && <ElementEditor project={project} item={item} element={element} start={start} locked={locked} />}
    </>
  );
}
