// The library panel on the left: the media in the project (import, drop, add to the timeline)
// the Text tab's presets and the Elements tab's components and backgrounds. Which one shows is
// the rail's choice.
import type { ImportJob } from "@uncut/contracts";
import { RENDER_CSS, SOLID, textHtml } from "@uncut/core/render";
import { planInsertText } from "@uncut/core/textPlan";
import type { Item } from "@uncut/core/types";
import { COMPONENTS, componentDefaults, componentHtml, naturalSize, screenRect, type ComponentInfo } from "@uncut/core/components";
import { defaultFrames, TRANSITIONS, type TransitionInfo } from "@uncut/core/transitions";
import { filterMusic, MUSIC_MOODS, MUSIC_TEMPOS, MUSIC_TRACKS, musicInProject, musicTempo, type MusicTempo, type MusicTrack } from "@uncut/core/music";
import { AudioLines, Blend, Blocks, ChevronDown, ChevronRight, Eye, EyeOff, Film, Gauge, Image as ImageIcon, Layers, Music, Play, Plus, RefreshCw, Square, Type, Upload, X } from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { bridge } from "../state/bridge.ts";
import { timecode } from "../state/format.ts";
import { TEXT_PRESETS, type TextPreset } from "../state/project.ts";
import { actions, activeAnalyses, activeJobs, getState, isRemote, mediaUrl, musicUrl, textPresets, thumbUrl, useApp, type MediaItem, type Project } from "../state/store.ts";
import { COMPONENT_DRAG_TYPE, setDraggedComponent, setDraggedText, TEXT_DRAG_TYPE } from "../preview/components.ts";
import { setDragChip } from "./dragChip.ts";
import { hideElement, showElement, useHiddenElements } from "./elementsGrid.ts";
import { MEDIA_DRAG_TYPE, setDraggedTransition, TRANSITION_DRAG_TYPE } from "../timeline/dnd.ts";
import { openMenu } from "../timeline/ContextMenu.tsx";
import { RenameField } from "../timeline/RenameField.tsx";
import { secondsLabel } from "../timeline/edit.ts";
import { usePlayback } from "../preview/playback.ts";
import { analysisText } from "../state/analysisText.ts";
import { CaptureLibrary } from "./Capture.tsx";
import { GeneratedSection, generatedMedia, GenerateLibrary } from "./Generate.tsx";

export type LibraryTab = "media" | "text" | "elements" | "audio" | "transitions" | "capture" | "generate";

export function Library({ project, tab, onTab }: { project: Project; tab: LibraryTab; onTab?: (tab: LibraryTab) => void }) {
  return tab === "text" ? (
    <TextLibrary project={project} />
  ) : tab === "elements" ? (
    <ElementsLibrary project={project} />
  ) : tab === "audio" ? (
    <AudioLibrary project={project} />
  ) : tab === "transitions" ? (
    <TransitionsLibrary project={project} />
  ) : tab === "capture" ? (
    <CaptureLibrary />
  ) : tab === "generate" ? (
    <GenerateLibrary project={project} />
  ) : (
    <MediaLibrary project={project} onEdit={() => onTab?.("generate")} />
  );
}

/** The CSS look of a transition's tile preview (styles.css .tr-thumb.<look>). */
const TILE_LOOK: Readonly<Record<string, string>> = { "transition.crossfade": "crossfade", "transition.dip-to-black": "dip", "transition.wipe": "wipe", "transition.iris": "iris", "transition.push-left": "push", "transition.zoom": "zoom" };

/**
 * The Transitions tab (D73): the transitions the preview and export draw (core TRANSITIONS), each a
 * tile with a looping preview (still with reduced motion), its name and default length. Drag one
 * onto a cut between two main-track clips; or select a cut and click the tile; or + puts it on the
 * cut nearest the playhead.
 */
function TransitionsLibrary({ project }: { project: Project }) {
  const { connection } = useApp();
  const online = connection === "connected";
  const cut = usePlayback((s) => s.cut);
  const fps = project.canvas.fps;
  const apply = (t: TransitionInfo, e: React.MouseEvent, nearest: boolean) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).blur();
    if (online) void actions.applyTransition(t.id, { nearest });
  };
  return (
    <aside className="library" data-testid="transitions-library">
      <div className="lib-head">Transitions</div>
      <div className="lib-section">
        <div className="lib-label">{cut ? "Click one to put it on the selected cut" : "Drag one onto a cut between two clips"}</div>
        <div className="grid2">
          {TRANSITIONS.map((t) => (
            <div
              key={t.id}
              className="tile tr-tile"
              data-testid="transition-tile"
              data-module={t.id}
              role="button"
              tabIndex={0}
              aria-disabled={!online}
              draggable={online}
              title={`${t.name}: ${t.description}`}
              onDragStart={(e) => {
                e.dataTransfer.setData(TRANSITION_DRAG_TYPE, t.id);
                e.dataTransfer.effectAllowed = "copy";
                setDraggedTransition(t.id);
              }}
              onDragEnd={() => setDraggedTransition(undefined)}
              onClick={(e) => apply(t, e, false)}
              onKeyDown={(e) => {
                // Keys on the + belong to it (its click), not to the tile as well.
                if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                e.preventDefault();
                if (online) void actions.applyTransition(t.id);
              }}
            >
              <div className={`thumb tr-thumb ${TILE_LOOK[t.id] ?? "crossfade"}`}>
                {/* Two shots, A then B, and (for the dip) the black between them. */}
                <span className="tr-a" aria-hidden="true">
                  <i />
                </span>
                <span className="tr-b" aria-hidden="true">
                  <i />
                </span>
                <span className="tr-k" aria-hidden="true" />
                <button className="tile-add" data-testid="transition-add" disabled={!online} title={`Put a ${t.name.toLowerCase()} on the cut nearest the playhead`} onClick={(e) => apply(t, e, true)}>
                  <Plus />
                </button>
              </div>
              <div className="tile-name">{t.name}</div>
              <div className="tile-sub" data-testid="transition-default">
                {secondsLabel(defaultFrames(t, fps), fps)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

/**
 * The Audio tab (D33, D54): the project's sound files (music, voiceover, effects) with + to put one
 * on the first audio track, at the playhead if it's free there, else after the last sound (a track
 * is made if there is none), and the bundled CC0 music library (D91).
 */
function AudioLibrary({ project }: { project: Project }) {
  const app = useApp();
  const online = app.connection === "connected";
  const importing = activeJobs(app).length > 0;
  const fps = project.canvas.fps;
  const sounds = project.media.filter((m) => m.kind === "audio");
  return (
    <aside className="library" data-testid="audio-library">
      <div className="lib-head">
        Audio
        <button className="icon-btn" data-testid="audio-import" disabled={!online} title="Import music or sound" onClick={() => void actions.importMedia()}>
          {importing ? <RefreshCw className="spin" /> : <Plus />}
        </button>
      </div>
      <div className="lib-section">
        <div className="lib-label">In this project</div>
        {sounds.length === 0 ? (
          <div className="muted small" data-testid="audio-empty">
            No music or sound yet
          </div>
        ) : (
          <div data-testid="audio-list">
            {sounds.map((m) => (
              <div key={m.id} className="audio-row" data-testid="audio-row" data-id={m.id} title={m.path}>
                <AudioLines />
                <span className="audio-name">{m.name}</span>
                {m.probe?.frames !== undefined && <span className="audio-dur">{timecode(m.probe.frames, fps).replace(/^00:/, "")}</span>}
                <button
                  className="icon-btn"
                  data-testid="audio-add"
                  disabled={!online}
                  title="Add to the audio track at the playhead (or after the last sound)"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    void actions.addMedia(m.id);
                  }}
                >
                  <Plus />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <MusicLibrary project={project} online={online} />
    </aside>
  );
}

const TEMPO_NAMES: Readonly<Record<MusicTempo, string>> = { slow: "Slow", medium: "Medium", fast: "Fast", free: "Free tempo" };

/**
 * The bundled music library (D91): cozy CC0 tracks (core MUSIC_TRACKS) with a search, mood and
 * tempo filters, a play button to listen (one at a time, from the server's library route) and +
 * to put a track on the timeline: copied into the project's media/ folder, then placed like any
 * sound (D50 revised), as long as the video at most, with fades.
 */
function MusicLibrary({ project, online }: { project: Project; online: boolean }) {
  const [query, setQuery] = useState("");
  const [mood, setMood] = useState<string | undefined>();
  const [tempo, setTempo] = useState<MusicTempo | undefined>();
  const [playing, setPlaying] = useState<string | undefined>();
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  const tracks = filterMusic({ query, mood, tempo });
  const toggle = (track: MusicTrack) => {
    if (playing === track.id) {
      audio.current?.pause();
      return setPlaying(undefined);
    }
    const url = musicUrl(track.file);
    if (!url) return;
    audio.current?.pause();
    const el = new Audio(url);
    el.onended = () => setPlaying((p) => (p === track.id ? undefined : p));
    audio.current = el;
    setPlaying(track.id);
    el.play().catch(() => setPlaying((p) => (p === track.id ? undefined : p)));
  };
  const tempos = MUSIC_TEMPOS.filter((t) => MUSIC_TRACKS.some((m) => musicTempo(m.bpm) === t));
  return (
    <div className="lib-section" data-testid="music-library">
      <div className="lib-label">Music library</div>
      <div className="music-filters">
        <input className="field input" data-testid="music-search" placeholder="Search music" value={query} spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        <div className="music-chips" data-testid="music-moods">
          {MUSIC_MOODS.map((m) => (
            <button key={m} className={`music-chip${mood === m ? " active" : ""}`} data-testid="music-mood" data-mood={m} aria-pressed={mood === m} onClick={() => setMood(mood === m ? undefined : m)}>
              {m}
            </button>
          ))}
        </div>
        <div className="music-chips" data-testid="music-tempos">
          {tempos.map((t) => (
            <button key={t} className={`music-chip${tempo === t ? " active" : ""}`} data-testid="music-tempo" data-tempo={t} aria-pressed={tempo === t} onClick={() => setTempo(tempo === t ? undefined : t)}>
              {TEMPO_NAMES[t]}
            </button>
          ))}
        </div>
      </div>
      <div data-testid="music-list">
        {tracks.length === 0 && (
          <div className="muted small" data-testid="music-empty">
            No track matches. Clear a filter to see more.
          </div>
        )}
        {tracks.map((t) => {
          const added = musicInProject(project, t);
          return (
            <div key={t.id} className="music-row" data-testid="music-row" data-id={t.id} title={`${t.title} by ${t.author} (${t.moods.join(", ")}), CC0: ${t.source}`}>
              <button className={`icon-btn${playing === t.id ? " playing" : ""}`} data-testid="music-play" data-playing={playing === t.id} title={playing === t.id ? "Stop" : "Listen"} onClick={() => toggle(t)}>
                {playing === t.id ? <Square /> : <Play />}
              </button>
              <span className="music-text">
                <span className="music-title">{t.title}</span>
                <span className="music-meta">
                  {[t.bpm ? `${t.bpm} bpm` : TEMPO_NAMES.free.toLowerCase(), clockOf(t.seconds), ...(added ? ["in the project"] : [])].join(", ")}
                </span>
              </span>
              <button
                className="icon-btn"
                data-testid="music-add"
                disabled={!online}
                title="Add to the audio track at the playhead (as long as the video, with fades)"
                onClick={(e) => {
                  e.currentTarget.blur();
                  void actions.addMusic(t.id);
                }}
              >
                <Plus />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 115.8 → "1:56". */
const clockOf = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

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
  const media = project.media.filter((m) => !generated.has(m.id));
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
          <div className="lib-label">In this project</div>
          <div className="grid2" data-testid="media-grid">
            {media.map((m) => (
              <MediaTile key={m.id} item={m} fps={project.canvas.fps} online={online} />
            ))}
          </div>
        </div>
      ) : null}
      <GeneratedSection project={project} {...(onEdit ? { onEdit } : {})} />
      {dragging && <div className="drop-hint">Drop to import</div>}
    </aside>
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

function MediaTile({ item, fps, online }: { item: MediaItem; fps: number; online: boolean }) {
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
  return (
    <div
      className={`tile ${flash ? "flash" : ""}`}
      data-testid="media-tile"
      data-id={item.id}
      title={item.path}
      ref={tileRef}
      onContextMenu={menu}
      draggable={online && !renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(MEDIA_DRAG_TYPE, item.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      <div className="thumb">
        {src && !broken ? <img key={src} src={src} alt="" draggable={false} onError={() => setBroken(true)} data-testid="thumb" /> : <Icon />}
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
      <div className="tile-name" data-testid="tile-name" onDoubleClick={() => online && setRenaming(true)}>
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
