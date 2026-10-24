// The text Inspector's Style tab (D129), laid out like a design tool's property panel: the look (one
// optional dropdown), Typography (font, weight, italic, size, spacing, line height, case,
// alignment), Fill, Stroke, Shadow, Background and Layout (align to the frame, position, width,
// rotation, opacity). Everything previews live and is one edit when committed (a slider or a
// scrubbed label once on release); several selected texts change together. What draws it is core
// textHtml, the export's path too, so the export matches.
import { TEXT_STYLES, textLook } from "@uncut/core/render";
import type { Item } from "@uncut/core/types";
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  Italic,
  Minus,
  Plus,
  RotateCcw,
} from "lucide-react";

import { type ProjectModel } from "../../state/project.ts";
import { measureText } from "../../preview/measure.ts";
import {
  caseOf,
  planCase,
  planFrameAlign,
  planPreset,
  planResetLook,
  planShadow,
  planStroke,
  planStyle,
  planTextBox,
  planTransform,
  textBox,
  textDecorOf,
  type FrameEdge,
  type TextCase,
} from "../../preview/text.ts";
import { NumInput, Prop, Section, Segmented, SettledColorField, SliderNum } from "../controls.tsx";
import { FontPicker } from "./fonts.tsx";
import { useTextEdit, type TextEdit } from "./edit.ts";

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
const WEIGHT_NAMES: Readonly<Record<number, string>> = {
  100: "Thin",
  200: "Extra light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Heavy",
  900: "Black",
};
const CASES: ReadonlyArray<readonly [TextCase, string, string]> = [
  ["none", "Aa", "As typed"],
  ["upper", "AA", "Capitals"],
  ["lower", "aa", "Lower case"],
  ["title", "Ab", "Title case"],
];
const ALIGNS = [
  ["left", <AlignLeft key="l" />, "Align left"],
  ["center", <AlignCenter key="c" />, "Align centre"],
  ["right", <AlignRight key="r" />, "Align right"],
] as const;
const EDGES: ReadonlyArray<readonly [FrameEdge, React.ReactNode, string]> = [
  ["left", <AlignStartVertical key="l" />, "Left of the frame"],
  ["hcenter", <AlignCenterVertical key="h" />, "Centre of the frame"],
  ["right", <AlignEndVertical key="r" />, "Right of the frame"],
  ["top", <AlignStartHorizontal key="t" />, "Top of the frame"],
  ["vcenter", <AlignCenterHorizontal key="v" />, "Middle of the frame"],
  ["bottom", <AlignEndHorizontal key="b" />, "Bottom of the frame"],
];

function LookPicker({ item, edit, disabled }: { item: Item; edit: TextEdit; disabled: boolean }) {
  const preset = item.style?.preset ?? "";
  const known = !!TEXT_STYLES[preset];
  return (
    <div className="look-row">
      <select
        className="pselect"
        data-testid="insp-preset"
        value={known ? preset : ""}
        disabled={disabled}
        onChange={(e) => {
          // Read now: the plan runs later, when React has put the controlled value back.
          const look = e.target.value;
          if (look) edit.commit((p, id) => planPreset(p, id, look));
        }}
      >
        {!known && <option value="">{preset ? textLook(preset).name || "Custom" : "No look"}</option>}
        {Object.entries(TEXT_STYLES).map(([id, look]) => (
          <option key={id} value={id}>
            {look.name}
          </option>
        ))}
      </select>
      <button
        className="icon-btn"
        data-testid="insp-reset-look"
        title="Reset to the look"
        aria-label="Reset to the look"
        disabled={disabled || !known}
        onClick={() => edit.commit((p, id) => planResetLook(p, id))}
      >
        <RotateCcw />
      </button>
    </div>
  );
}

function Typography({ project, item, edit, disabled }: { project: ProjectModel; item: Item; edit: TextEdit; disabled: boolean }) {
  const box = textBox(item, project);
  const d = textDecorOf(item, project);
  const s = item.style ?? {};
  const maxSize = Math.round(project.canvas.height * 0.4);
  const reset = (key: keyof NonNullable<Item["style"]>, label: string) =>
    s[key] !== undefined && TEXT_STYLES[s.preset ?? ""]
      ? () => edit.commit((p, id) => planStyle(p, id, { [key]: null }, `Use the look's ${label}`))
      : undefined;
  return (
    <Section title="Typography" testId="insp-sec-type">
      <Prop label="Font" onReset={reset("font", "font")} testId="insp-prop-font">
        <FontPicker
          testId="insp-font"
          value={s.font ?? ""}
          disabled={disabled}
          onPick={(font) => edit.commit((p, id) => planStyle(p, id, { font: font || null }, font ? `Set font to ${font}` : "Use the look's font"))}
        />
      </Prop>
      <Prop label="Weight" onReset={reset("weight", "weight")}>
        <div className="prop-pair">
          <select
            className="pselect"
            data-testid="insp-weight"
            value={box.weight}
            disabled={disabled}
            onChange={(e) => {
              const weight = Number(e.target.value);
              edit.commit((p, id) => planStyle(p, id, { weight }, `Set weight to ${WEIGHT_NAMES[weight] ?? weight}`));
            }}
          >
            {WEIGHTS.map((w) => (
              <option key={w} value={w}>
                {WEIGHT_NAMES[w]}
              </option>
            ))}
          </select>
          <button
            className={`icon-btn square ${s.italic ? "active" : ""}`}
            data-testid="insp-italic"
            title="Italic"
            aria-label="Italic"
            aria-pressed={!!s.italic}
            disabled={disabled}
            onClick={() => edit.commit((p, id) => planStyle(p, id, { italic: s.italic ? null : true }, s.italic ? "Set text upright" : "Set text in italic"))}
          >
            <Italic />
          </button>
        </div>
      </Prop>
      <Prop label="Size" onReset={reset("size", "size")}>
        <SliderNum
          testId="insp-size"
          value={box.size}
          min={1}
          max={2000}
          sliderMax={Math.max(maxSize, 8)}
          unit="px"
          disabled={disabled}
          onPreview={(v) => edit.preview((p, id) => planStyle(p, id, { size: v }))}
          onCommit={(v) => edit.commit((p, id) => planStyle(p, id, { size: v }, "Resize text"))}
        />
      </Prop>
      <div className="prop-grid">
        <NumInput
          testId="insp-tracking"
          label="Spacing"
          title="Letter spacing (em)"
          unit="em"
          value={Math.round(d.tracking * 1000) / 1000}
          step={0.01}
          min={-0.5}
          max={2}
          clearable
          disabled={disabled}
          onPreview={(v) => edit.preview((p, id) => planStyle(p, id, { tracking: v }))}
          onCommit={(v) =>
            edit.commit((p, id) =>
              planStyle(p, id, { tracking: v ?? null }, v === undefined ? "Use the look's letter spacing" : `Set letter spacing to ${v} em`),
            )
          }
        />
        <NumInput
          testId="insp-line-height"
          label="Line"
          title="Line height (× the size)"
          value={Math.round(d.lineHeight * 100) / 100}
          step={0.05}
          min={0.5}
          max={4}
          clearable
          disabled={disabled}
          onPreview={(v) => edit.preview((p, id) => planStyle(p, id, { lineHeight: v }))}
          onCommit={(v) =>
            edit.commit((p, id) => planStyle(p, id, { lineHeight: v ?? null }, v === undefined ? "Use the look's line height" : `Set line height to ${v}`))
          }
        />
      </div>
      <Prop label="Case">
        <Segmented
          testId="insp-case"
          attr="case"
          options={CASES.map(([v, l, t]) => [v, l, t] as const)}
          value={caseOf(item)}
          disabled={disabled}
          onChange={(c) => edit.commit((p, id) => planCase(p, id, c))}
        />
      </Prop>
      <Prop label="Align" onReset={reset("align", "alignment")}>
        <Segmented
          testId="insp-align"
          attr="align"
          options={ALIGNS}
          value={box.align}
          disabled={disabled}
          onChange={(align) => edit.commit((p, id) => planStyle(p, id, { align }, `Align text ${align}`))}
        />
      </Prop>
    </Section>
  );
}

function Fill({ project, item, edit, disabled }: { project: ProjectModel; item: Item; edit: TextEdit; disabled: boolean }) {
  const box = textBox(item, project);
  return (
    <Section title="Fill" testId="insp-sec-fill">
      <SettledColorField
        project={project}
        testId="insp-color"
        value={typeof box.color === "string" ? box.color : undefined}
        disabled={disabled}
        onPreview={(color) => edit.preview((p, id) => planStyle(p, id, { color }))}
        onCommit={(color) => edit.commit((p, id) => planStyle(p, id, { color }, "Recolour text"))}
      />
    </Section>
  );
}

/** A section's add (+) or remove (−) action. */
const AddRemove = ({
  on,
  testId,
  disabled,
  onAdd,
  onRemove,
  noun,
}: {
  on: boolean;
  testId: string;
  disabled: boolean;
  onAdd: () => void;
  onRemove: () => void;
  noun: string;
}) =>
  on ? (
    <button className="icon-btn" data-testid={`${testId}-none`} title={`Remove ${noun}`} aria-label={`Remove ${noun}`} disabled={disabled} onClick={onRemove}>
      <Minus />
    </button>
  ) : (
    <button className="icon-btn" data-testid={`${testId}-on`} title={`Add ${noun}`} aria-label={`Add ${noun}`} disabled={disabled} onClick={onAdd}>
      <Plus />
    </button>
  );

function Decor({ project, item, edit, disabled }: { project: ProjectModel; item: Item; edit: TextEdit; disabled: boolean }) {
  const d = textDecorOf(item, project);
  const wrap = d.background ? (d.background.wrap ?? "box") : "none";
  return (
    <>
      <Section
        title="Stroke"
        testId="insp-sec-stroke"
        action={
          <AddRemove
            on={!!d.stroke}
            testId="insp-stroke"
            noun="the stroke"
            disabled={disabled}
            onAdd={() => edit.commit((p, id) => planStroke(p, id, {}))}
            onRemove={() => edit.commit((p, id) => planStroke(p, id, false))}
          />
        }
      >
        {d.stroke && (
          <div className="prop-grid">
            <SettledColorField
              project={project}
              testId="insp-stroke-color"
              value={d.stroke.color ?? "#000000"}
              noAlpha
              disabled={disabled}
              onPreview={(color) => edit.preview((p, id) => planStroke(p, id, { color }))}
              onCommit={(color) => edit.commit((p, id) => planStroke(p, id, { color }))}
            />
            <NumInput
              testId="insp-stroke-width"
              label="Width"
              unit="px"
              value={d.stroke.width}
              step={1}
              min={0}
              max={200}
              disabled={disabled}
              onPreview={(v) => edit.preview((p, id) => planStroke(p, id, { width: v }))}
              onCommit={(v) => v !== undefined && edit.commit((p, id) => planStroke(p, id, { width: v }))}
            />
          </div>
        )}
      </Section>
      <Section
        title="Shadow"
        testId="insp-sec-shadow"
        action={
          <AddRemove
            on={!!d.shadow}
            testId="insp-shadow"
            noun="the shadow"
            disabled={disabled}
            onAdd={() => edit.commit((p, id) => planShadow(p, id, {}))}
            onRemove={() => edit.commit((p, id) => planShadow(p, id, false))}
          />
        }
      >
        {d.shadow && (
          <>
            <SettledColorField
              project={project}
              testId="insp-shadow-color"
              value={d.shadow.color ?? "#000000"}
              alpha={{ value: d.shadow.opacity ?? 1, onCommit: (v) => edit.commit((p, id) => planShadow(p, id, { opacity: v })) }}
              disabled={disabled}
              onPreview={(color) => edit.preview((p, id) => planShadow(p, id, { color }))}
              onCommit={(color) => edit.commit((p, id) => planShadow(p, id, { color }))}
            />
            <div className="prop-grid three">
              {(["x", "y", "blur"] as const).map((k) => (
                <NumInput
                  key={k}
                  testId={`insp-shadow-${k}`}
                  label={k === "blur" ? "Blur" : k.toUpperCase()}
                  value={d.shadow![k] ?? 0}
                  min={k === "blur" ? 0 : -500}
                  max={500}
                  disabled={disabled}
                  onPreview={(v) => edit.preview((p, id) => planShadow(p, id, { [k]: v }))}
                  onCommit={(v) => v !== undefined && edit.commit((p, id) => planShadow(p, id, { [k]: v }))}
                />
              ))}
            </div>
          </>
        )}
      </Section>
      <Section title="Background" testId="insp-sec-box">
        <Segmented
          testId="insp-box"
          attr="wrap"
          options={[
            ["none", "None"],
            ["box", "Box"],
            ["lines", "Per line"],
          ]}
          value={wrap}
          disabled={disabled}
          onChange={(w) => edit.commit((p, id) => planTextBox(p, id, w === "none" ? false : { wrap: w }))}
        />
        {d.background && (
          <>
            <SettledColorField
              project={project}
              testId="insp-box-color"
              value={d.background.color ?? "#000000"}
              alpha={{ value: d.background.opacity ?? 1, onCommit: (v) => edit.commit((p, id) => planTextBox(p, id, { opacity: v })) }}
              disabled={disabled}
              onPreview={(color) => edit.preview((p, id) => planTextBox(p, id, { color }))}
              onCommit={(color) => edit.commit((p, id) => planTextBox(p, id, { color }))}
            />
            <div className="prop-grid">
              <NumInput
                testId="insp-box-padding"
                label="Padding"
                unit="px"
                value={d.background.padding ?? 0}
                min={0}
                max={1000}
                disabled={disabled}
                onPreview={(v) => edit.preview((p, id) => planTextBox(p, id, { padding: v }))}
                onCommit={(v) => v !== undefined && edit.commit((p, id) => planTextBox(p, id, { padding: v }))}
              />
              <NumInput
                testId="insp-box-radius"
                label="Radius"
                unit="px"
                value={d.background.radius ?? 0}
                min={0}
                max={1000}
                disabled={disabled}
                onPreview={(v) => edit.preview((p, id) => planTextBox(p, id, { radius: v }))}
                onCommit={(v) => v !== undefined && edit.commit((p, id) => planTextBox(p, id, { radius: v }))}
              />
            </div>
          </>
        )}
      </Section>
    </>
  );
}

function Layout({ project, item, edit, disabled }: { project: ProjectModel; item: Item; edit: TextEdit; disabled: boolean }) {
  const box = textBox(item, project);
  const text = item.type === "text";
  const rotate = item.transform?.rotate ?? 0;
  const opacity = Math.round((item.transform?.opacity ?? 1) * 100);
  return (
    <Section title="Layout" testId="insp-sec-layout">
      {text && (
        <div className="frame-align" role="group" aria-label="Align to the frame">
          {EDGES.map(([edge, icon, title]) => (
            <button
              key={edge}
              className="icon-btn"
              data-testid="insp-frame-align"
              data-edge={edge}
              title={title}
              aria-label={title}
              disabled={disabled}
              onClick={() =>
                edit.commit((p, id) => planFrameAlign(p, id, edge, measureText(p.tracks.flatMap((t) => t.items).find((i) => i.id === id) ?? item, p)))
              }
            >
              {icon}
            </button>
          ))}
        </div>
      )}
      <div className="prop-grid">
        <NumInput
          testId="insp-x"
          label="X"
          unit="px"
          value={box.x}
          disabled={disabled}
          onPreview={(v) => edit.preview((p, id) => planTransform(p, id, { x: v }))}
          onCommit={(v) => v !== undefined && edit.commit((p, id) => planTransform(p, id, { x: v }))}
        />
        <NumInput
          testId="insp-y"
          label="Y"
          unit="px"
          value={box.y}
          disabled={disabled}
          onPreview={(v) => edit.preview((p, id) => planTransform(p, id, { y: v }))}
          onCommit={(v) => v !== undefined && edit.commit((p, id) => planTransform(p, id, { y: v }))}
        />
        <NumInput
          testId="insp-w"
          label="W"
          unit="px"
          value={box.w}
          placeholder="Auto"
          min={1}
          clearable
          disabled={disabled}
          onPreview={(v) => edit.preview((p, id) => planTransform(p, id, { w: v }))}
          onCommit={(v) =>
            edit.commit((p, id) => planTransform(p, id, { w: v ?? null }, v === undefined ? "Fit the text box to its text" : "Set the text box width"))
          }
        />
        {text && (
          <NumInput
            testId="insp-rotate"
            label="↻"
            title="Rotation"
            unit="°"
            value={rotate}
            step={1}
            min={-180}
            max={180}
            disabled={disabled}
            onPreview={(v) => edit.preview((p, id) => planTransform(p, id, { rotate: v }))}
            onCommit={(v) => v !== undefined && edit.commit((p, id) => planTransform(p, id, { rotate: v }, `Rotate text ${v}°`))}
          />
        )}
      </div>
      {text && (
        <Prop label="Opacity" onReset={opacity !== 100 ? () => edit.commit((p, id) => planTransform(p, id, { opacity: null }, "Make text opaque")) : undefined}>
          <SliderNum
            testId="insp-opacity"
            value={opacity}
            min={0}
            max={100}
            unit="%"
            disabled={disabled}
            onPreview={(v) => edit.preview((p, id) => planTransform(p, id, { opacity: v / 100 }))}
            onCommit={(v) => edit.commit((p, id) => planTransform(p, id, { opacity: v / 100 }, `Set text opacity to ${v}%`))}
          />
        </Prop>
      )}
    </Section>
  );
}

/** The Style tab of a text (and of captions, which share its look but not rotation, opacity or frame alignment). */
export function TextStyleTab({ project, item, disabled }: { project: ProjectModel; item: Item; disabled: boolean }) {
  const edit = useTextEdit(project, item);
  return (
    <div className="pstack" data-testid="text-style" data-targets={edit.ids.length}>
      <LookPicker item={item} edit={edit} disabled={disabled} />
      <Typography project={project} item={item} edit={edit} disabled={disabled} />
      <Fill project={project} item={item} edit={edit} disabled={disabled} />
      <Decor project={project} item={item} edit={edit} disabled={disabled} />
      <Layout project={project} item={item} edit={edit} disabled={disabled} />
    </div>
  );
}
