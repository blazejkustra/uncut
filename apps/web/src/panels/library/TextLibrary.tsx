import { textHtml, RENDER_CSS } from "@uncut/core/render";
import { planInsertText } from "@uncut/core/textPlan";
import type { Item } from "@uncut/core/types";
import { useRef, useState, useLayoutEffect } from "react";
import { type TextPreset, TEXT_PRESETS } from "../../state/project.ts";
import { type Project, useApp, textPresets, actions } from "../../state/store.ts";
import { TEXT_DRAG_TYPE, setDraggedText } from "../../preview/components.ts";
import { setDragChip } from "../dragChip.ts";

/** The canvas a text tile lays its look out on (as the preview does, at canvas size in CSS px). */
const THUMB_CANVAS = { width: 1920, height: 1080, fps: 30 } as const;

/**
 * A text preset's thumbnail (D80): the items it adds (core planInsertText on an empty 1080p
 * project, its look and the looks it comes with) drawn with core textHtml at canvas size in a
 * size container, then cropped to the text and scaled into the tile, so a small caption is as
 * readable as a big title. No motion: the look it lands in.
 */
function TextThumb({ preset, project }: { preset: TextPreset; project: Project }) {
  const ref = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ k: number; x: number; y: number } | undefined>(undefined);
  // Tiles show text as new projects draw it (D80: no soft shadow by default).
  const target = { canvas: THUMB_CANVAS, theme: project.theme, textLooks: 1 };
  const empty = { canvas: THUMB_CANVAS, theme: project.theme, media: [], tracks: [] };
  const plan = planInsertText(
    empty,
    { look: preset.module, text: preset.text, start: 0, duration: 90, animation: null },
    preset.look ? { [preset.module]: preset.look } : {},
  );
  const items = "ops" in plan ? plan.ops.flatMap((op) => (op.op === "insert_item" ? [op.item as Item] : [])) : [];
  // Renamed (class tt-text, no data-item) so the preview's text queries never find a tile's.
  const html = items.map((item) => textHtml(item, target).replace(/^<div class="pv-text" data-item="[^"]*"/, '<div class="tt-text"')).join("");
  useLayoutEffect(() => {
    const el = ref.current;
    const box = inner.current;
    if (!el || !box) return;
    const update = () => {
      const texts = [...box.querySelectorAll<HTMLElement>(".tt-text")];
      if (!texts.length || !el.clientWidth) return;
      // The text's own extent (a look that spans the safe area has a canvas-wide box): its content's
      // rect, plus a box's padding, in canvas px (screen rects divided by the current scale).
      const origin = box.getBoundingClientRect();
      const scale = origin.width / THUMB_CANVAS.width || 1;
      const rects = texts.map((t) => {
        const range = document.createRange();
        range.selectNodeContents(t);
        const r = range.getBoundingClientRect();
        const cs = getComputedStyle(t);
        const padX = cs.backgroundColor !== "rgba(0, 0, 0, 0)" ? parseFloat(cs.paddingLeft) || 0 : 0;
        const padY = cs.backgroundColor !== "rgba(0, 0, 0, 0)" ? parseFloat(cs.paddingTop) || 0 : 0;
        return {
          l: (r.left - origin.left) / scale - padX,
          t: (r.top - origin.top) / scale - padY,
          r: (r.right - origin.left) / scale + padX,
          b: (r.bottom - origin.top) / scale + padY,
        };
      });
      const left = Math.min(...rects.map((r) => r.l));
      const top = Math.min(...rects.map((r) => r.t));
      const right = Math.max(...rects.map((r) => r.r));
      const bottom = Math.max(...rects.map((r) => r.b));
      const w = Math.max(1, right - left);
      const h = Math.max(1, bottom - top);
      const k = Math.min((el.clientWidth * 0.84) / w, (el.clientHeight * 0.62) / h, el.clientWidth / 500);
      setFit({ k, x: el.clientWidth / 2 - (left + w / 2) * k, y: el.clientHeight / 2 - (top + h / 2) * k });
    };
    update();
    void document.fonts?.ready.then(update);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [html]);
  return (
    <div className="thumb text-thumb" ref={ref} data-testid="text-thumb">
      <div
        ref={inner}
        className="text-thumb-inner"
        style={{ width: THUMB_CANVAS.width, height: THUMB_CANVAS.height, transform: fit ? `translate(${fit.x}px, ${fit.y}px) scale(${fit.k})` : "scale(0)" }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/** Core's text rules (RENDER_CSS) for the tiles' renamed copies. */
const THUMB_CSS = RENDER_CSS.split("\n")
  .filter((rule) => rule.startsWith(".pv-text"))
  .map((rule) => rule.replaceAll(".pv-text", ".text-thumb-inner .tt-text"))
  .join("\n");

/**
 * The Text tab (D80): a grid of looks (core TEXT_PRESETS, from the text-style manifests), each tile
 * a real thumbnail. Click (or +) adds it at the playhead, 3 s long, on a free text track; drag it
 * onto the preview (placed where it lands) or the timeline (at that time).
 */
export function TextLibrary({ project }: { project: Project }) {
  // Subscribed to contributions: an allowed plugin's looks follow the built-ins (D103).
  const { connection, contributions } = useApp();
  const presets: ReadonlyArray<TextPreset> = contributions ? textPresets() : TEXT_PRESETS;
  const online = connection === "connected";
  return (
    <aside className="library" data-testid="text-library">
      <style>{THUMB_CSS}</style>
      <div className="lib-head">Text</div>
      <div className="lib-section">
        <div className="grid2" data-testid="text-grid">
          {presets.map((preset) => (
            <button
              key={preset.id}
              className="tile text-tile"
              data-testid="text-preset"
              data-preset={preset.id}
              data-module={preset.module}
              {...(preset.source ? { "data-plugin": preset.source } : {})}
              disabled={!online}
              draggable={online}
              title={`Add ${preset.label.toLowerCase()} at the playhead`}
              onDragStart={(e) => {
                e.dataTransfer.setData(TEXT_DRAG_TYPE, preset.id);
                e.dataTransfer.effectAllowed = "copy";
                setDragChip(e, preset.label);
                setDraggedText(preset.id);
              }}
              onDragEnd={() => setDraggedText(undefined)}
              onClick={(e) => {
                e.currentTarget.blur();
                void actions.addText(preset);
              }}
            >
              <TextThumb preset={preset} project={project} />
              <div className="tile-name">{preset.label}</div>
              {preset.source && (
                <div className="source-label" data-testid="text-preset-source" title={`From the plugin ${preset.source}`}>
                  {preset.source}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
