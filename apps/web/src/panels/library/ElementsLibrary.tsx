import { SOLID } from "@uncut/core/render";
import { type ComponentInfo, componentDefaults, naturalSize, componentHtml, screenRect, COMPONENTS } from "@uncut/core/components";
import { Eye, EyeOff, Plus, Blocks, ChevronDown, ChevronRight } from "lucide-react";
import React, { useRef, useState, useLayoutEffect } from "react";
import { type Project, useApp, actions } from "../../state/store.ts";
import { COMPONENT_DRAG_TYPE, setDraggedComponent } from "../../preview/components.ts";
import { setDragChip } from "../dragChip.ts";
import { showElement, hideElement, useHiddenElements } from "../elementsGrid.ts";
import { openMenu } from "../../timeline/ContextMenu.tsx";
import { canGoBehind } from "../../preview/text.ts";
import { getPlayback } from "../../preview/playback.ts";
import { StickerPicker } from "../Stickers.tsx";

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
export function ElementsLibrary({ project }: { project: Project }) {
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
            // D220: with a picture or text selected, behind it or over the whole edit.
            if (!canGoBehind(project, getPlayback().selected)) return void actions.addBackground(BACKGROUND_PROPS);
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.left, r.bottom + 4, [
              { id: "background-behind", label: "Behind this", run: () => void actions.addBackground(BACKGROUND_PROPS, true) },
              { id: "background-whole", label: "Whole edit", run: () => void actions.addBackground(BACKGROUND_PROPS) },
            ], "Add a background");
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
