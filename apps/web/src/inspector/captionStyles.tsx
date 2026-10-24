// Caption styles (F24, D166): the captions Inspector's gallery of CapCut-like presets (core
// CAPTION_STYLES, drawn by core textHtml so a tile looks like the caption), the speaking word's
// colour (the karaoke fill), fill mode and box, and the default style for new captions, remembered
// on this Mac (localStorage, like the panel sizes).
import { CAPTION_STYLES, captionMode, captionStyleSample, planCaptionHighlight, planCaptionStyle } from "@uncut/core/captions";
import { RENDER_CSS, textHtml } from "@uncut/core/render";
import type { Item } from "@uncut/core/types";
import { useLayoutEffect, useRef, useState } from "react";

import { type ProjectModel } from "../state/project.ts";
import { Prop, Segmented, SettledColorField, Toggle } from "./controls.tsx";
import { Group, send } from "./fields.tsx";
import { setDefaultCaptionStyle, useDefaultCaptionStyle } from "./captionStyle.ts";

/** Settings › App: the default caption style (D166). */
export function DefaultCaptionStyleRow() {
  const value = useDefaultCaptionStyle();
  return (
    <label className="kv-row">
      <span className="muted">Default caption style</span>
      <select className="field input" data-testid="settings-caption-style" value={value} onChange={(e) => setDefaultCaptionStyle(e.target.value)}>
        <option value="">None</option>
        {CAPTION_STYLES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---- the gallery ----

const SAMPLE_CANVAS = { width: 640, height: 200 } as const;
/** Core's text rules for the tiles' renamed copies (so the preview's .pv-text queries never find a tile's). */
const TILE_CSS = RENDER_CSS.split("\n")
  .filter((rule) => rule.startsWith(".pv-text"))
  .map((rule) => rule.replaceAll(".pv-text", ".cap-style-inner .cap-tt"))
  .join("\n");

function StyleTile({
  project,
  id,
  name,
  active,
  disabled,
  onPick,
}: {
  project: ProjectModel;
  id: string;
  name: string;
  active: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(0);
  const sample = captionStyleSample(id, SAMPLE_CANVAS, 960);
  const html = sample
    ? textHtml(sample, { canvas: SAMPLE_CANVAS, theme: project.theme, textLooks: 1 })
        .replace(/^<div class="pv-text/, '<div class="cap-tt')
        .replace(/ data-item="[^"]*"/, "")
    : "";
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setK(el.clientWidth / SAMPLE_CANVAS.width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <button
      className={`cap-style ${active ? "active" : ""}`}
      data-testid="cap-style"
      data-style={id}
      aria-pressed={active}
      disabled={disabled}
      onClick={onPick}
    >
      <div className="cap-style-thumb" ref={ref}>
        <div
          className="cap-style-inner"
          style={{ transform: `translateY(${((46 - SAMPLE_CANVAS.height * k) / 2).toFixed(1)}px) scale(${k})` }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
      <span className="cap-style-name">{name}</span>
    </button>
  );
}

/** The captions Style tab's top: the preset gallery, then the speaking word's highlight. */
export function CaptionStyleGallery({ project, item, disabled }: { project: ProjectModel; item: Item; disabled: boolean }) {
  const chosen = item.style?.captionStyle;
  const s = item.style ?? {};
  const accent = typeof s.accent === "string" ? s.accent : undefined;
  const box = typeof s.accentBox === "string" ? s.accentBox : undefined;
  const words = captionMode(item) !== "line";
  return (
    <>
      <style>{TILE_CSS}</style>
      <Group label="Caption style">
        <div className="cap-styles" data-testid="cap-styles">
          {CAPTION_STYLES.map((c) => (
            <StyleTile
              key={c.id}
              project={project}
              id={c.id}
              name={c.name}
              active={chosen === c.id}
              disabled={disabled}
              onPick={() => send((p) => planCaptionStyle(p, item.id, c.id))}
            />
          ))}
        </div>
      </Group>
      <Group label="Speaking word">
        <Prop label="Colour">
          <SettledColorField
            project={project}
            testId="cap-accent"
            value={accent ?? "accent"}
            noAlpha
            disabled={disabled || !words}
            onCommit={(color) => send((p) => planCaptionHighlight(p, item.id, { accent: color }))}
          />
        </Prop>
        <Prop label="Fill">
          <Segmented
            testId="cap-fill"
            options={[
              ["word", "Word"],
              ["karaoke", "Karaoke"],
            ]}
            value={s.karaoke === true ? "karaoke" : "word"}
            disabled={disabled || !words}
            onChange={(v) => send((p) => planCaptionHighlight(p, item.id, { karaoke: v === "karaoke" }))}
          />
        </Prop>
        <Prop label="Box">
          <Toggle
            testId="cap-box"
            value={!!box}
            disabled={disabled || !words}
            onChange={(on) => send((p) => planCaptionHighlight(p, item.id, { accentBox: on ? "#7C5CFF" : null }))}
          />
        </Prop>
        {box && (
          <Prop label="Box colour">
            <SettledColorField
              project={project}
              testId="cap-box-color"
              value={box}
              noAlpha
              disabled={disabled}
              onCommit={(color) => send((p) => planCaptionHighlight(p, item.id, { accentBox: color }))}
            />
          </Prop>
        )}
      </Group>
    </>
  );
}
