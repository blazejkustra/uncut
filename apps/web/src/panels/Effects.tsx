// The Effects tab (D136, feedback G2): Filters (colour looks) and Effects, each tile a thumbnail the
// preview's own renderer draws (preview/fx.ts, the same maths as the preview and the export) from
// the selected clip's picture at the playhead, or from a built-in sample picture when no clip is
// selected. Click a tile to put it on the selected clip, or drag it onto a clip in the timeline or
// on the canvas. Fine-tuning (intensity, Adjust, effect settings) is in the Inspector.
import { clipFx, EFFECTS, effectParams, fxOverlayInner, hasOverlay, LOOK, LOOKS, needsPicturePass, type ClipFx, type EffectInfo, type LookDef } from "@uncut/core/fx";
import type { ModuleUse } from "@uncut/core/types";
import { Ban, X } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";

import { FxRenderer } from "../preview/fx.ts";
import { usePlayback } from "../preview/playback.ts";
import { actions, useApp, type Project } from "../state/store.ts";
import { findItem } from "../timeline/edit.ts";
import { EFFECT_DRAG_TYPE, setDraggedEffect } from "../timeline/dnd.ts";

/** Thumbnails are drawn this size (px), the canvas's 1080 lines scaled to its height. */
const THUMB = { width: 192, height: 108 } as const;

/** The built-in sample picture: sky, sun, hills, water, a face's tones and colour swatches. */
let sample: HTMLCanvasElement | undefined;
function samplePicture(): HTMLCanvasElement {
  if (sample) return sample;
  const c = document.createElement("canvas");
  c.width = 384;
  c.height = 216;
  const g = c.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, 130);
  sky.addColorStop(0, "#3d6fb6");
  sky.addColorStop(0.65, "#f2a65a");
  sky.addColorStop(1, "#f7d38a");
  g.fillStyle = sky;
  g.fillRect(0, 0, 384, 140);
  g.fillStyle = "#fff4c4";
  g.beginPath();
  g.arc(250, 108, 26, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#3b5d3a";
  g.beginPath();
  g.moveTo(0, 140);
  g.lineTo(70, 92);
  g.lineTo(150, 128);
  g.lineTo(230, 84);
  g.lineTo(320, 126);
  g.lineTo(384, 100);
  g.lineTo(384, 150);
  g.lineTo(0, 150);
  g.fill();
  const sea = g.createLinearGradient(0, 140, 0, 216);
  sea.addColorStop(0, "#2f6f8f");
  sea.addColorStop(1, "#0f2c3d");
  g.fillStyle = sea;
  g.fillRect(0, 140, 384, 76);
  // A face's tones and a few strong colours, so looks that treat them differently show it.
  g.fillStyle = "#e0ac8a";
  g.beginPath();
  g.arc(70, 176, 22, 0, Math.PI * 2);
  g.fill();
  ["#e63946", "#f4d35e", "#2a9d8f", "#5b4bdb", "#ffffff", "#111111"].forEach((col, i) => {
    g.fillStyle = col;
    g.fillRect(150 + i * 36, 172, 30, 30);
  });
  sample = c;
  return c;
}

/** One shared renderer draws every tile (WebGL contexts are few), each copied into its tile. */
let shared: FxRenderer | undefined | null;
const renderer = () => {
  if (shared === undefined) {
    try {
      shared = new FxRenderer();
    } catch {
      shared = null;
    }
  }
  return shared;
};

/** The selected clip's picture element in the preview, when it has a frame to read. */
function clipPicture(id: string | undefined): HTMLVideoElement | HTMLImageElement | undefined {
  if (!id) return undefined;
  const el = document.querySelector<HTMLVideoElement | HTMLImageElement>(`.pv-box[data-item="${CSS.escape(id)}"] > video, .pv-box[data-item="${CSS.escape(id)}"] > img`);
  if (el instanceof HTMLVideoElement) return el.readyState >= 2 && el.videoWidth > 0 ? el : undefined;
  if (el instanceof HTMLImageElement) return el.complete && el.naturalWidth > 0 ? el : undefined;
  return undefined;
}

type Source = { el: TexImageSource; w: number; h: number; key: string };

/** A tile's thumbnail: its effect drawn on the source, overlays (vignette, grain, bars) on top. */
function FxThumb({ fx, source, testId }: { fx: ClipFx | undefined; source: Source; testId: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const k = THUMB.height / 1080;
  useEffect(() => {
    const canvas = ref.current;
    const r = renderer();
    if (!canvas) return;
    const g = canvas.getContext("2d")!;
    canvas.width = THUMB.width;
    canvas.height = THUMB.height;
    if (r && fx && needsPicturePass(fx) && r.render(source.el, fx, THUMB.width, THUMB.height, 0.2, k)) g.drawImage(r.canvas, 0, 0);
    else g.drawImage(source.el as CanvasImageSource, 0, 0, THUMB.width, THUMB.height);
    canvas.dataset.drawn = source.key;
  }, [fx, source, k]);
  // Overlays at a 1080-line size, scaled into the tile like the canvas is.
  const overlay = fx && hasOverlay(fx) ? fxOverlayInner(fx, { x: 0, y: 0, w: 1920, h: 1080 }, 0) : "";
  const box = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || !overlay) return;
    const fit = () => layer.current && (layer.current.style.transform = `scale(${el.clientWidth / 1920})`);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [overlay]);
  return (
    <div className="thumb fx-thumb" data-testid={testId} ref={box}>
      <canvas ref={ref} style={fx?.blur ? { filter: `blur(${(fx.blur * k).toFixed(2)}px)` } : undefined} />
      {overlay && <div className="fx-thumb-overlay" ref={layer} dangerouslySetInnerHTML={{ __html: overlay }} />}
    </div>
  );
}

/** A look as a clip's effects would carry it, compiled. */
const lookFx = (look: string, custom?: LookDef) => clipFx({ type: "clip", effects: [{ module: LOOK, params: { look, intensity: 1, ...(custom ? { custom } : {}) } }] });
/** An effect at its defaults, compiled (zoom pulse: a still at its widest). */
const effectFx = (e: EffectInfo): ClipFx | undefined => clipFx({ type: "clip", effects: [{ module: e.id, params: effectParams(e.id, {}) }] });

const matches = (query: string, ...texts: Array<string>) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => texts.join(" ").toLowerCase().includes(w));
};

export function EffectsLibrary({ project }: { project: Project }) {
  const { connection, contributions } = useApp();
  const online = connection === "connected";
  const selectedId = usePlayback((s) => s.selected);
  const playing = usePlayback((s) => s.playing);
  const frame = usePlayback((s) => Math.round(s.frame));
  const placed = findItem(project, selectedId);
  const media = placed?.item.media ? project.media.find((m) => m.id === placed.item.media) : undefined;
  const clip = placed && placed.item.type === "clip" && media && media.kind !== "audio" ? placed.item : undefined;
  const [query, setQuery] = useState("");
  // The thumbnails' source: the selected clip at the playhead (redrawn when it's paused somewhere new), else the sample.
  const [source, setSource] = useState<Source>(() => ({ el: samplePicture(), w: 384, h: 216, key: "sample" }));
  useEffect(() => {
    if (playing) return;
    let tries = 0;
    let timer = 0;
    const pick = () => {
      const el = clipPicture(clip?.id);
      if (el) {
        const w = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
        const h = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
        // A copy: the thumbnails keep this frame while the video moves on.
        const copy = document.createElement("canvas");
        const scale = Math.min(1, 480 / Math.max(1, w));
        copy.width = Math.max(1, Math.round(w * scale));
        copy.height = Math.max(1, Math.round(h * scale));
        copy.getContext("2d")!.drawImage(el, 0, 0, copy.width, copy.height);
        setSource({ el: copy, w: copy.width, h: copy.height, key: `${clip!.id}@${frame}` });
      } else if (clip && tries++ < 10) timer = window.setTimeout(pick, 200);
      else setSource((s) => (s.key === "sample" ? s : { el: samplePicture(), w: 384, h: 216, key: "sample" }));
    };
    timer = window.setTimeout(pick, 120);
    return () => clearTimeout(timer);
  }, [clip?.id, frame, playing]);

  const effects: ReadonlyArray<ModuleUse> = clip?.effects ?? [];
  const activeLook = (effects.find((e) => e.module === LOOK)?.params as { look?: string } | undefined)?.look;
  const has = new Set(effects.map((e) => e.module));
  const pluginFilters = contributions?.filters ?? [];
  const looks = useMemo(() => LOOKS.map((l) => ({ id: l.id, name: l.name, description: l.description, fx: lookFx(l.id) })), []);
  const plugins = useMemo(() => pluginFilters.map((f) => ({ id: f.id, name: f.name, description: f.description || `From ${f.pluginName}`, fx: lookFx(f.id, f.look as LookDef) })), [pluginFilters]);
  const fxs = useMemo(() => EFFECTS.map((e) => ({ info: e, fx: effectFx(e) })), []);
  const shownLooks = [...looks, ...plugins].filter((l) => matches(query, l.name, l.description));
  const shownFx = fxs.filter((e) => matches(query, e.info.name, e.info.description));

  const apply = (what: string, e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).blur();
    if (online) void actions.applyFx(what);
  };
  const tile = (what: string, name: string, title: string, active: boolean, thumb: React.ReactNode, testId: string, extra: Record<string, string>) => (
    <div
      key={what}
      className={`tile fx-tile${active ? " active" : ""}`}
      data-testid={testId}
      {...extra}
      data-active={active ? "true" : undefined}
      role="button"
      tabIndex={0}
      aria-disabled={!online}
      aria-pressed={active}
      draggable={online}
      title={title}
      onDragStart={(e) => {
        e.dataTransfer.setData(EFFECT_DRAG_TYPE, what);
        e.dataTransfer.effectAllowed = "copy";
        setDraggedEffect(what);
      }}
      onDragEnd={() => setDraggedEffect(undefined)}
      onClick={(e) => apply(what, e)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        apply(what, e);
      }}
    >
      {thumb}
      <div className="tile-name">{name}</div>
    </div>
  );

  return (
    <aside className="library" data-testid="effects-library" data-source={source.key}>
      <div className="lib-head">Effects</div>
      <div className="lib-section">
        <div className="music-filters">
          <div className="tr-search">
            <input className="field input" data-testid="effects-search" placeholder="Search filters and effects" value={query} spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
            {query && (
              <button className="icon-btn" data-testid="effects-search-clear" title="Clear" onClick={() => setQuery("")}>
                <X />
              </button>
            )}
          </div>
          <div className="muted small" data-testid="effects-target">
            {clip ? `On ${clip.name ?? media?.name ?? clip.id}` : "No clip selected"}
          </div>
        </div>
        {shownLooks.length > 0 && (
          <>
            <div className="lib-label">Filters</div>
            <div className="grid2 fx-grid" data-testid="filters-grid">
              {!query &&
                tile(
                  "look:",
                  "None",
                  "No filter",
                  !!clip && !activeLook,
                  <div className="thumb fx-thumb fx-none" data-testid="filter-thumb">
                    <Ban />
                  </div>,
                  "filter-tile",
                  { "data-look": "none" },
                )}
              {shownLooks.map((l) => tile(`look:${l.id}`, l.name, `${l.name}: ${l.description}`, activeLook === l.id, <FxThumb fx={l.fx} source={source} testId="filter-thumb" />, "filter-tile", { "data-look": l.id }))}
            </div>
          </>
        )}
        {shownFx.length > 0 && (
          <>
            <div className="lib-label">Effects</div>
            <div className="grid2 fx-grid" data-testid="effects-grid">
              {shownFx.map(({ info, fx }) => tile(`effect:${info.id}`, info.name, `${info.name}: ${info.description}`, has.has(info.id), <FxThumb fx={fx} source={source} testId="effect-thumb" />, "effect-tile", { "data-module": info.id }))}
            </div>
          </>
        )}
        {shownLooks.length === 0 && shownFx.length === 0 && (
          <div className="muted small" data-testid="effects-empty">
            Nothing matches
          </div>
        )}
      </div>
    </aside>
  );
}
