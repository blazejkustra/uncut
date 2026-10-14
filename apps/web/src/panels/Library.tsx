// The library panel on the left: the media in the project (import, drop, add to the timeline)
// the Text tab's presets and the Elements tab's components and backgrounds. Which one shows is
// the rail's choice.
import type { ImportJob } from "@uncut/contracts";
import { RENDER_CSS, SOLID, textHtml } from "@uncut/core/render";
import { planInsertText } from "@uncut/core/textPlan";
import type { Item } from "@uncut/core/types";
import { COMPONENTS, componentDefaults, componentHtml, naturalSize, screenRect, type ComponentInfo } from "@uncut/core/components";
import { AudioLines, Blocks, ChevronDown, ChevronRight, Eye, EyeOff, Film, Gauge, Image as ImageIcon, Layers, LayoutGrid, List, Plus, RefreshCw, Type, Upload, X } from "lucide-react";
import { mediaUses, usedMediaIds } from "@uncut/core/mediaPlan";
import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { bridge } from "../state/bridge.ts";
import { timecode } from "../state/format.ts";
import { TEXT_PRESETS, type TextPreset } from "../state/project.ts";
import { actions, activeAnalyses, activeJobs, getState, isRemote, mediaUrl, textPresets, thumbUrl, useApp, type MediaItem, type Project } from "../state/store.ts";
import { COMPONENT_DRAG_TYPE, setDraggedComponent, setDraggedText, TEXT_DRAG_TYPE } from "../preview/components.ts";
import { setDragChip } from "./dragChip.ts";
import { hideElement, showElement, useHiddenElements } from "./elementsGrid.ts";
import { MEDIA_SORTS, setMediaMode, setMediaSort, sortMedia, useMediaView, type MediaSort } from "./mediaView.ts";
import { MEDIA_DRAG_TYPE } from "../timeline/dnd.ts";
import { openMenu } from "../timeline/ContextMenu.tsx";
import { RenameField } from "../timeline/RenameField.tsx";
import { analysisText } from "../state/analysisText.ts";
import { CaptureLibrary } from "./Capture.tsx";
import { AudioLibrary, SfxLibrary } from "./Audio.tsx";
import { TransitionsLibrary } from "./Transitions.tsx";
import { EffectsLibrary } from "./Effects.tsx";
import { StickerPicker } from "./Stickers.tsx";
import { GeneratedSection, generatedMedia, GenerateLibrary } from "./Generate.tsx";
import { TranscriptPanel } from "./Transcript.tsx";
import { BrandLibrary } from "./Brand.tsx";

export type LibraryTab = "media" | "transcript" | "text" | "elements" | "audio" | "sfx" | "transitions" | "effects" | "capture" | "generate" | "brand";

export function Library({ project, dir, tab, onTab }: { project: Project; dir: string; tab: LibraryTab; onTab?: (tab: LibraryTab) => void }) {
  return tab === "brand" ? (
    <BrandLibrary />
  ) : tab === "transcript" ? (
    <TranscriptPanel project={project} dir={dir} />
  ) : tab === "text" ? (
    <TextLibrary project={project} />
  ) : tab === "elements" ? (
    <ElementsLibrary project={project} />
  ) : tab === "audio" ? (
    <AudioLibrary project={project} />
  ) : tab === "sfx" ? (
    <SfxLibrary project={project} />
  ) : tab === "transitions" ? (
    <TransitionsLibrary project={project} />
  ) : tab === "effects" ? (
    <EffectsLibrary project={project} />
  ) : tab === "capture" ? (
    <CaptureLibrary />
  ) : tab === "generate" ? (
    <GenerateLibrary project={project} />
  ) : (
    <MediaLibrary project={project} onEdit={() => onTab?.("generate")} />
  );
}


/** The frame a component's thumbnail shows (a terminal mid-way, its line typed). */
const THUMB_FRAME: Readonly<Record<string, number>> = { "component.terminal": 45, "component.agent-log": 150, "component.compare-table": 75, "component.lower-third": 45, "component.sticker": 30, "component.progress-bar": 200, "component.subscribe": 20 };

/**
 * A component's thumbnail (D76): its real HTML (core componentHtml with its default props) laid out
 * at its default size on a 1080p canvas and scaled into the tile, like the preview's canvas. A
 * device frame gets a gradient on its screen, standing in for footage.
 */
function ComponentThumb({ info, project }: { info: ComponentInfo; project: Project }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const canvas = { width: 1920, height: 1080 };
  const props = componentDefaults(info.id);
  const size = naturalSize({ component: info.id, props }, canvas);
  const item = { id: `thumb-${info.id}`, type: "component" as const, component: info.id, duration: 300, props, transform: { x: 0, y: 0, w: size.width, h: size.height } };
  const html = componentHtml(item, { canvas, theme: project.theme }, THUMB_FRAME[info.id] ?? 0, { fps: 30 });
  const k = box.w && box.h ? Math.min((box.w * 0.86) / size.width, (box.h * 0.86) / size.height) : 0;
  const screen = info.id === "component.device-frame" ? screenRect("phone", size.width, size.height) : undefined;
  return (
    <div className="thumb comp-thumb" ref={ref} data-testid="component-thumb">
      <div className="comp-thumb-inner" style={{ width: size.width, height: size.height, transform: `translate(-50%, -50%) scale(${k})` }}>
        {screen && <div className="comp-thumb-screen" style={{ left: screen.x, top: screen.y, width: screen.w, height: screen.h, borderRadius: screen.radius }} />}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}

/** The Background tile's element (E3, D131): one background, its colours and gradient set in the Inspector. */
const BACKGROUND_PROPS = { color: "#0B1D3A" } as const;
const BACKGROUND_THUMB = "linear-gradient(160deg, #0B1D3A, #3B1E54)";

/** A grid tile's hide / show button (E2, D130). */
const HideButton = ({ id, name, hidden }: { id: string; name: string; hidden: boolean }) => (
  <button
    className="tile-hide"
    data-testid={hidden ? "element-show" : "element-hide"}
    title={hidden ? `Show ${name}` : `Hide ${name}`}
    aria-label={hidden ? `Show ${name}` : `Hide ${name}`}
    onClick={(e) => {
      e.stopPropagation();
      e.currentTarget.blur();
      if (hidden) showElement(id);
      else hideElement(id);
    }}
  >
    {hidden ? <Eye /> : <EyeOff />}
  </button>
);

/**
 * The Elements tab (D76, E2/E3 in D130/D131): one grid of elements, general ones first, then a
 * Background (a colour or gradient under the text) and a plugin's components (D103). Drag one onto
 * the canvas (it lands there, at the playhead) or the timeline (at that time), or + adds it at the
 * playhead. Any tile can be hidden (its eye, or right-click); hidden ones (the dev-promo components
 * start that way) are listed below the grid, and can be shown again. Remembered on this Mac.
 */
function ElementsLibrary({ project }: { project: Project }) {
  const { connection, contributions } = useApp();
  const online = connection === "connected";
  const hidden = useHiddenElements();
  const [showHidden, setShowHidden] = useState(false);
  const menu = (e: React.MouseEvent, id: string, name: string, isHidden: boolean) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [isHidden ? { id: "element-show", label: "Show in the grid", run: () => showElement(id) } : { id: "element-hide", label: "Hide from the grid", run: () => hideElement(id) }], name);
  };
  const componentTile = (c: ComponentInfo, isHidden: boolean) => (
    <div
      key={c.id}
      className={`tile comp-tile ${isHidden ? "hidden-tile" : ""}`}
      data-testid={isHidden ? "hidden-element-tile" : "component-tile"}
      data-component={c.id}
      title={c.name}
      draggable={online && !isHidden}
      onContextMenu={(e) => menu(e, c.id, c.name, isHidden)}
      onDragStart={(e) => {
        e.dataTransfer.setData(COMPONENT_DRAG_TYPE, c.id);
        e.dataTransfer.effectAllowed = "copy";
        setDragChip(e, c.name);
        setDraggedComponent(c.id);
      }}
      onDragEnd={() => setDraggedComponent(undefined)}
    >
      <ComponentThumb info={c} project={project} />
      {!isHidden && (
        <button
          className="tile-add"
          data-testid="component-add"
          disabled={!online}
          title={`Add ${c.name.toLowerCase()} at the playhead`}
          aria-label={`Add ${c.name.toLowerCase()}`}
          onClick={(e) => {
            e.stopPropagation();
            e.currentTarget.blur();
            void actions.addComponent(c.id);
          }}
        >
          <Plus />
        </button>
      )}
      <HideButton id={c.id} name={c.name} hidden={isHidden} />
      <div className="tile-name">{c.name}</div>
    </div>
  );
  const pluginTile = (c: NonNullable<typeof contributions>["components"][number], isHidden: boolean) => (
    <div key={c.id} className={`tile comp-tile plugin-comp-tile ${isHidden ? "hidden-tile" : ""}`} data-testid={isHidden ? "hidden-element-tile" : "plugin-component-tile"} data-component={c.id} title={c.name} onContextMenu={(e) => menu(e, c.id, c.name, isHidden)}>
      <div className="thumb plugin-comp-thumb">
        <Blocks />
      </div>
      {!isHidden && (
        <button
          className="tile-add"
          data-testid="plugin-component-add"
          disabled={!online}
          title={`Add ${c.name.toLowerCase()} at the playhead`}
          aria-label={`Add ${c.name.toLowerCase()}`}
          onClick={(e) => {
            e.stopPropagation();
            e.currentTarget.blur();
            void actions.addPluginComponent(c.id);
          }}
        >
          <Plus />
        </button>
      )}
      <HideButton id={c.id} name={c.name} hidden={isHidden} />
      <div className="tile-name">{c.name}</div>
      <div className="source-label" data-testid="component-source" title={`From the plugin ${c.pluginName}`}>
        {c.pluginName}
      </div>
    </div>
  );
  const backgroundHidden = hidden.includes(SOLID);
  const backgroundTile = (isHidden: boolean) => (
    <div key={SOLID} className={`tile comp-tile ${isHidden ? "hidden-tile" : ""}`} data-testid={isHidden ? "hidden-element-tile" : "background-tile"} data-component={SOLID} title="Background" onContextMenu={(e) => menu(e, SOLID, "Background", isHidden)}>
      <div className="thumb bg-thumb" style={{ background: BACKGROUND_THUMB }} />
      {!isHidden && (
        <button
          className="tile-add"
          data-testid="background-add"
          disabled={!online}
          title="Add a background at the playhead"
          aria-label="Add a background"
          onClick={(e) => {
            e.stopPropagation();
            e.currentTarget.blur();
            void actions.addBackground(BACKGROUND_PROPS);
          }}
        >
          <Plus />
        </button>
      )}
      <HideButton id={SOLID} name="Background" hidden={isHidden} />
      <div className="tile-name">Background</div>
    </div>
  );
  const plugins = contributions?.components ?? [];
  const hiddenCount = COMPONENTS.filter((c) => hidden.includes(c.id)).length + plugins.filter((c) => hidden.includes(c.id)).length + (backgroundHidden ? 1 : 0);
  return (
    <aside className="library" data-testid="elements-library">
      <div className="lib-head">Elements</div>
      <div className="lib-section">
        <div className="grid2" data-testid="components-grid">
          {COMPONENTS.filter((c) => !hidden.includes(c.id)).map((c) => componentTile(c, false))}
          {!backgroundHidden && backgroundTile(false)}
          {/* A plugin's components (D103): a named tile, never its template here (it only runs in the graphics sandbox once added). */}
          {plugins.filter((c) => !hidden.includes(c.id)).map((c) => pluginTile(c, false))}
        </div>
      </div>
      <StickerPicker />
      {hiddenCount > 0 && (
        <div className="lib-section">
          <button className="lib-label hidden-toggle" data-testid="hidden-elements-toggle" aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? <ChevronDown /> : <ChevronRight />}
            Hidden ({hiddenCount})
          </button>
          {showHidden && (
            <div className="grid2" data-testid="hidden-elements">
              {COMPONENTS.filter((c) => hidden.includes(c.id)).map((c) => componentTile(c, true))}
              {backgroundHidden && backgroundTile(true)}
              {plugins.filter((c) => hidden.includes(c.id)).map((c) => pluginTile(c, true))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

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
  const plan = planInsertText(empty, { look: preset.module, text: preset.text, start: 0, duration: 90, animation: null }, preset.look ? { [preset.module]: preset.look } : {});
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
        return { l: (r.left - origin.left) / scale - padX, t: (r.top - origin.top) / scale - padY, r: (r.right - origin.left) / scale + padX, b: (r.bottom - origin.top) / scale + padY };
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
function TextLibrary({ project }: { project: Project }) {
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

function MediaLibrary({ project, onEdit }: { project: Project; onEdit?: () => void }) {
  const app = useApp();
  const { importReport, connection, uploading } = app;
  const running = activeJobs(app);
  const importing = running.length > 0 || uploading !== undefined;
  const [dragging, setDragging] = useState(false);
  const online = connection === "connected";
  // Generated media (D99) are listed under Generated, with their prompts.
  const generated = new Set(generatedMedia(project).map((m) => m.id));
  const view = useMediaView();
  const media = sortMedia(
    project.media.filter((m) => !generated.has(m.id)),
    view.sort,
  );
  // F26 (D168): which media the timeline uses; F8 (D167): the selected tile (⌫ removes it) and the confirm.
  const used = usedMediaIds(project);
  const [selected, setSelected] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<{ readonly id: string; readonly name: string; readonly count: number } | undefined>();
  const remove = (m: MediaItem) => {
    if (!online) return;
    const count = mediaUses(project, m.id).length;
    if (count === 0) void actions.removeMedia(m.id);
    else setConfirm({ id: m.id, name: m.name, count });
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    // Only files from disk have a path; anything else (a dragged link, text) is ignored. A drop
    // while an import runs is queued behind it on the server.
    // On a remote environment this Mac's paths mean nothing to the server: the files go up instead (D108).
    if (isRemote()) {
      if (online && e.dataTransfer.files.length) void actions.uploadAndImport([...e.dataTransfer.files]);
      return;
    }
    const paths = [...e.dataTransfer.files].map((f) => bridge.pathForFile(f)).filter((p) => p.startsWith("/"));
    if (paths.length && online) void actions.importMedia(paths);
  };
  return (
    <aside
      className={`library ${dragging ? "dragging" : ""}`}
      data-testid="library"
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="lib-head">
        Media
        <button className="icon-btn" data-testid="import-plus" disabled={!online} title="Import media" onClick={() => void actions.importMedia()}>
          {importing ? <RefreshCw className="spin" /> : <Plus />}
        </button>
      </div>
      {uploading && (
        <div className="import-progress" data-testid="upload-progress">
          <RefreshCw className="spin" />
          <span>
            Uploading {uploading.name}
            {uploading.total > 1 ? ` (${uploading.done + 1} of ${uploading.total})` : ""}…
          </span>
        </div>
      )}
      {running.map((job) => (
        <div key={job.id} className="import-progress" data-testid="import-progress">
          <RefreshCw className="spin" />
          <span>{progressText(job)}</span>
          <div className="bar">
            <span style={{ width: `${Math.round(progressFraction(job) * 100)}%` }} />
          </div>
        </div>
      ))}
      {app.analysisError && (
        <div className="import-report" data-testid="analysis-error">
          <div className="import-line error">
            <span>{app.analysisError}</span>
          </div>
          <button className="link-btn" onClick={actions.dismissAnalysisError}>
            Dismiss
          </button>
        </div>
      )}
      {importReport && (
        <div className="import-report" data-testid="import-report">
          {importReport.failed.map((f) => (
            <div key={`f-${f.path}`} className="import-line error">
              <span className="ellipsis" title={f.path}>
                {f.path.split("/").pop()}
              </span>
              <span>{f.message}</span>
            </div>
          ))}
          {importReport.skipped.map((s) => (
            <div key={`s-${s.path}`} className="import-line">
              <span className="ellipsis" title={s.path}>
                {s.path.split("/").pop()}
              </span>
              <span>{s.reason}</span>
            </div>
          ))}
          <button className="link-btn" onClick={actions.dismissImportReport}>
            Dismiss
          </button>
        </div>
      )}
      {media.length === 0 && generated.size === 0 ? (
        <Empty icon={<Film />} title="No media yet" testId="media-empty">
          <button className="btn" data-testid="import" disabled={!online} onClick={() => void actions.importMedia()}>
            <Upload />
            Import…
          </button>
        </Empty>
      ) : media.length > 0 ? (
        <div className="lib-section">
          <div className="lib-label media-bar">
            <span>In this project</span>
            <span className="media-bar-tools">
              <select className="media-sort" data-testid="media-sort" value={view.sort} title="Sort by" aria-label="Sort by" onChange={(e) => setMediaSort(e.target.value as MediaSort)}>
                {MEDIA_SORTS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button className={`icon-btn${view.mode === "grid" ? " active" : ""}`} data-testid="media-view-grid" aria-pressed={view.mode === "grid"} title="Grid" onClick={() => setMediaMode("grid")}>
                <LayoutGrid />
              </button>
              <button className={`icon-btn${view.mode === "list" ? " active" : ""}`} data-testid="media-view-list" aria-pressed={view.mode === "list"} title="List" onClick={() => setMediaMode("list")}>
                <List />
              </button>
            </span>
          </div>
          <div className={view.mode === "list" ? "media-list" : "grid2"} data-testid="media-grid" data-view={view.mode} data-sort={view.sort}>
            {media.map((m) => (
              <MediaTile key={m.id} item={m} fps={project.canvas.fps} online={online} used={used.has(m.id)} selected={selected === m.id} onSelect={() => setSelected(m.id)} onRemove={() => remove(m)} />
            ))}
          </div>
        </div>
      ) : null}
      <GeneratedSection project={project} {...(onEdit ? { onEdit } : {})} />
      {dragging && <div className="drop-hint">Drop to import</div>}
      {confirm && (
        <RemoveMediaConfirm
          name={confirm.name}
          count={confirm.count}
          onCancel={() => setConfirm(undefined)}
          onRemove={() => {
            setConfirm(undefined);
            void actions.removeMedia(confirm.id);
          }}
        />
      )}
    </aside>
  );
}

/** F8 (D167): in the app, not a system dialog; Esc or a click outside cancels. Keys stay here (⌫ never reaches the timeline). */
function RemoveMediaConfirm({ name, count, onCancel, onRemove }: { name: string; count: number; onCancel: () => void; onRemove: () => void }) {
  return (
    <div
      className="modal-layer"
      data-testid="remove-media-confirm"
      onPointerDown={(e) => e.target === e.currentTarget && onCancel()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="modal confirm-modal" role="alertdialog" aria-label={`Remove ${name}`}>
        <div className="confirm-title">Remove {name} from the project?</div>
        <div className="confirm-text" data-testid="remove-media-count">
          {count === 1 ? "1 item on the timeline uses it and goes too." : `${count} items on the timeline use it and go too.`}
        </div>
        <div className="confirm-actions">
          <button className="btn" data-testid="remove-media-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn danger" data-testid="remove-media-ok" autoFocus onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Importing 37 of 200…" and friends. */
function progressText(job: ImportJob) {
  switch (job.phase) {
    case "queued":
      return `Waiting to import ${job.total} file${job.total === 1 ? "" : "s"}…`;
    case "probing":
      return `Importing ${Math.min(job.probed + 1, job.total)} of ${job.total}…`;
    case "adding":
      return `Adding ${job.total} file${job.total === 1 ? "" : "s"}…`;
    default:
      return `Making thumbnails, ${job.postersDone} of ${job.postersTotal}…`;
  }
}
const progressFraction = (job: ImportJob) =>
  job.phase === "posters" ? 0.8 + 0.2 * (job.postersTotal ? job.postersDone / job.postersTotal : 1) : job.phase === "probing" ? 0.75 * (job.probed / Math.max(1, job.total)) : job.phase === "adding" ? 0.78 : 0;

/** "59.94", "30", "23.98" */
const fpsLabel = (fps: number) => String(Math.round(fps * 100) / 100);

/** "3840×2160, 59.94 fps" for video, "4096×3072" for images, "Audio" for sound. */
export function mediaMeta(m: MediaItem) {
  const size = m.probe?.width && m.probe?.height ? `${m.probe.width}×${m.probe.height}` : undefined;
  if (m.kind === "audio") return "Audio";
  if (m.kind === "image") return size ?? "Image";
  return [size, m.probe?.fps ? `${fpsLabel(m.probe.fps)} fps` : undefined].filter(Boolean).join(", ");
}

/** "Analysing the sound… 42%" (or the picture, for the agent's video analysis, D67; "Transcribing…", D68), or why it waits. */

function MediaTile({ item, fps, online, used, selected, onSelect, onRemove }: { item: MediaItem; fps: number; online: boolean; used: boolean; selected: boolean; onSelect: () => void; onRemove: () => void }) {
  const app = useApp();
  const { thumbIds } = app;
  // G4: renamed in place (double-click the name, or Rename in its menu).
  const [renaming, setRenaming] = useState(false);
  const tileRef = useRef<HTMLDivElement>(null);
  // "Show in Media" (T7): scrolled into view and flashed.
  const focusSeq = app.mediaFocus?.id === item.id ? app.mediaFocus.seq : undefined;
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (focusSeq === undefined) return;
    tileRef.current?.scrollIntoView({ block: "nearest" });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1200);
    return () => clearTimeout(t);
  }, [focusSeq]);
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    const local = !isRemote();
    openMenu(e.clientX, e.clientY, [
      { id: "media-add", label: "Add to timeline", disabled: !online, run: () => void actions.addMedia(item.id) },
      { id: "media-rename", label: "Rename", disabled: !online, run: () => setRenaming(true) },
      ...(local ? [{ id: "media-reveal", label: "Reveal in Finder", run: () => void actions.showInFolder(item.path.startsWith("/") ? item.path : `${getState().snapshot?.dir ?? ""}/${item.path}`) }] : []),
      "-",
      { id: "media-remove", label: "Remove from project", shortcut: "⌫", danger: true, disabled: !online, run: onRemove },
    ], "Media");
  };
  // Analysis (D66) runs on demand: the Analyze button, or the agent's media_analyze.
  const analysis = activeAnalyses(app, item.id)[0];
  const hasSound = item.kind === "audio" || (item.kind === "video" && item.probe?.hasAudio !== false);
  const [broken, setBroken] = useState(false);
  const Icon = item.kind === "audio" ? AudioLines : item.kind === "image" ? ImageIcon : Film;
  // An SVG has no poster (ffmpeg can't read it): the tile shows the file itself (D76).
  const src = thumbIds.has(item.id) ? thumbUrl(item.id, item.path) : item.kind === "image" && /\.svg$/i.test(item.path) ? mediaUrl(item.id, item.path) : undefined;
  const seconds = item.probe?.frames ? item.probe.frames / fps : undefined;
  // F26 (D168): hovering a video's thumbnail scrubs through it (one muted video, only while hovered).
  const [scrub, setScrub] = useState<number | undefined>(undefined);
  const scrubRef = useRef<HTMLVideoElement>(null);
  const canScrub = item.kind === "video" && !!seconds && !renaming;
  useEffect(() => {
    const v = scrubRef.current;
    if (!v || scrub === undefined || !seconds) return;
    const t = Math.min(seconds - 0.05, Math.max(0, scrub * seconds));
    if (v.readyState >= 1) v.currentTime = t;
    else v.onloadedmetadata = () => (v.currentTime = t);
  }, [scrub, seconds]);
  return (
    <div
      className={`tile ${flash ? "flash" : ""} ${selected ? "selected" : ""}`}
      data-testid="media-tile"
      data-id={item.id}
      data-used={used ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      title={item.path}
      ref={tileRef}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        // ⌫ / Delete on the selected tile (not while its name is edited): Remove from project, never the timeline's selection.
        if (e.target !== e.currentTarget || (e.key !== "Backspace" && e.key !== "Delete")) return;
        e.preventDefault();
        e.stopPropagation();
        onRemove();
      }}
      onContextMenu={(e) => {
        onSelect();
        menu(e);
      }}
      draggable={online && !renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(MEDIA_DRAG_TYPE, item.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      <div
        className="thumb"
        onPointerMove={(e) => {
          if (!canScrub) return;
          const r = e.currentTarget.getBoundingClientRect();
          setScrub(Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))));
        }}
        onPointerLeave={() => setScrub(undefined)}
      >
        {src && !broken ? <img key={src} src={src} alt="" draggable={false} onError={() => setBroken(true)} data-testid="thumb" /> : <Icon />}
        {canScrub && scrub !== undefined && (
          <>
            <video ref={scrubRef} className="thumb-scrub" data-testid="thumb-scrub" src={mediaUrl(item.id, item.path)} muted playsInline preload="auto" />
            <span className="thumb-scrub-bar" style={{ left: `${scrub * 100}%` }} />
          </>
        )}
        {used && (
          <span className="tile-used" data-testid="media-used" title="On the timeline">
            Used
          </span>
        )}
        {seconds !== undefined && !analysis && (
          <span className="dur" data-testid="duration">
            {timecode(Math.round(seconds * fps), fps).replace(/^00:/, "")}
          </span>
        )}
        <button
          className="tile-add"
          data-testid="add-to-timeline"
          title={item.kind === "audio" ? "Add to the audio track" : "Add to the end of the main track"}
          disabled={!online}
          onClick={(e) => {
            e.currentTarget.blur();
            void actions.addMedia(item.id);
          }}
        >
          <Plus />
        </button>
        {hasSound && !analysis && (
          <button
            className="tile-analyze"
            data-testid="analyze"
            title="Analyse the sound: loudness and silences"
            disabled={!online}
            onClick={(e) => {
              e.currentTarget.blur();
              void actions.analyzeMedia(item.id);
            }}
          >
            <Gauge />
          </button>
        )}
        {analysis && (
          <div className="tile-analysis" data-testid="analysis-progress" data-phase={analysis.phase} data-analyzer={analysis.analyzer} title={analysisText(analysis)}>
            <Gauge />
            <div className="bar">
              <span style={{ width: `${Math.round((analysis.phase === "running" ? analysis.progress : 0) * 100)}%` }} />
            </div>
            <button className="tile-analysis-cancel" data-testid="analysis-cancel" title="Stop the analysis" disabled={!online} onClick={() => void actions.cancelAnalysis(analysis.id)}>
              <X />
            </button>
          </div>
        )}
      </div>
      <div className="tile-name" data-testid="tile-name" title={item.name} onDoubleClick={() => online && setRenaming(true)}>
        {renaming ? <RenameField testId="media-rename" value={item.name} onDone={(name) => (name !== undefined && name.trim() && name !== item.name && void actions.renameMedia(item.id, name), setRenaming(false))} /> : item.name}
      </div>
      <div className="tile-sub" data-testid="tile-meta">
        {mediaMeta(item)}
      </div>
    </div>
  );
}

export function Empty({ icon, title, children, testId }: { icon: ReactNode; title: string; children?: ReactNode; testId?: string }) {
  return (
    <div className="empty" data-testid={testId}>
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      <div className="empty-sub">{children}</div>
    </div>
  );
}
