// The library panel on the left: the media in the project (import, drop, add to the timeline)
// the Text tab's presets and the Elements tab's components and backgrounds. Which one shows is
// the rail's choice.
import type { ImportJob } from "@uncut/contracts";
import { RENDER_CSS, solidBackground, textHtml } from "@uncut/core/render";
import { planInsertText } from "@uncut/core/textPlan";
import type { Item } from "@uncut/core/types";
import { COMPONENTS, componentDefaults, componentHtml, naturalSize, screenRect, type ComponentInfo } from "@uncut/core/components";
import { defaultFrames, TRANSITIONS, type TransitionInfo } from "@uncut/core/transitions";
import { filterMusic, MUSIC_MOODS, MUSIC_TEMPOS, MUSIC_TRACKS, musicInProject, musicTempo, type MusicTempo, type MusicTrack } from "@uncut/core/music";
import { AudioLines, Blend, Film, Gauge, Image as ImageIcon, Layers, Music, Play, Plus, RefreshCw, Square, Type, Upload, X } from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { bridge } from "./bridge.ts";
import { timecode } from "./format.ts";
import { TEXT_PRESETS, type TextPreset } from "./project.ts";
import { BACKGROUNDS } from "./text.ts";
import { actions, activeAnalyses, activeJobs, mediaUrl, musicUrl, thumbUrl, useApp, type MediaItem, type Project } from "./store.ts";
import { COMPONENT_DRAG_TYPE, setDraggedComponent, TEXT_DRAG_TYPE } from "./components.ts";
import { MEDIA_DRAG_TYPE, setDraggedTransition, TRANSITION_DRAG_TYPE } from "./Timeline.tsx";
import { secondsLabel } from "./edit.ts";
import { usePlayback } from "./playback.ts";
import { analysisText } from "./analysisText.ts";

export type LibraryTab = "media" | "text" | "elements" | "audio" | "transitions";

export function Library({ project, tab }: { project: Project; tab: LibraryTab }) {
  return tab === "text" ? (
    <TextLibrary project={project} />
  ) : tab === "elements" ? (
    <ElementsLibrary project={project} />
  ) : tab === "audio" ? (
    <AudioLibrary project={project} />
  ) : tab === "transitions" ? (
    <TransitionsLibrary project={project} />
  ) : (
    <MediaLibrary project={project} />
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
      <div className="lib-hint">
        <Blend />
        A transition sits on the cut between two clips on the main track. Click its marker on the timeline to change its length or type, ⌫ removes it. Every transition but dip to black needs a little footage past the cut on both clips.
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
            No music or sound yet. Import an audio file (or drop it on the Media tab); it shows up here.
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
      <div className="music-licence">
        <Music /> Every track is CC0 (public domain): use it anywhere, no credit needed. Adding one copies it into the project's media folder.
      </div>
    </div>
  );
}

/** 115.8 → "1:56". */
const clockOf = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

/** The frame a component's thumbnail shows (a terminal mid-way, its line typed). */
const THUMB_FRAME: Readonly<Record<string, number>> = { "component.terminal": 45 };

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

/**
 * Components (D76) and backgrounds (component.solid, D53). A component: drag it onto the canvas
 * (it lands there, at the playhead) or the timeline (at that time), or + adds it at the playhead.
 * A background is a full-frame colour or gradient under the text: with a text item selected it
 * spans that text (a title card); otherwise 3 s at the playhead.
 */
function ElementsLibrary({ project }: { project: Project }) {
  const { connection } = useApp();
  const online = connection === "connected";
  const [custom, setCustom] = useState("#1E3A5F");
  return (
    <aside className="library" data-testid="elements-library">
      <div className="lib-head">Elements</div>
      <div className="lib-section">
        <div className="lib-label">Components</div>
        <div className="grid2" data-testid="components-grid">
          {COMPONENTS.map((c) => (
            <div
              key={c.id}
              className="tile comp-tile"
              data-testid="component-tile"
              data-component={c.id}
              title={`${c.name}: ${c.description}`}
              draggable={online}
              onDragStart={(e) => {
                e.dataTransfer.setData(COMPONENT_DRAG_TYPE, c.id);
                e.dataTransfer.effectAllowed = "copy";
                setDraggedComponent(c.id);
              }}
              onDragEnd={() => setDraggedComponent(undefined)}
            >
              <ComponentThumb info={c} project={project} />
              <button
                className="tile-add"
                data-testid="component-add"
                disabled={!online}
                title={`Add a ${c.name.toLowerCase()} at the playhead`}
                onClick={(e) => {
                  e.stopPropagation();
                  e.currentTarget.blur();
                  void actions.addComponent(c.id);
                }}
              >
                <Plus />
              </button>
              <div className="tile-name">{c.name}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="lib-section">
        <div className="lib-label">Backgrounds</div>
        <div className="grid2">
          {BACKGROUNDS.map((bg) => (
            <button
              key={bg.id}
              className="tile text-tile"
              data-testid="background-preset"
              data-background={bg.id}
              disabled={!online}
              title={`Add a ${bg.label.toLowerCase()} background`}
              onClick={(e) => {
                e.currentTarget.blur();
                void actions.addBackground(bg.props);
              }}
            >
              <div className="thumb bg-thumb" style={{ background: solidBackground({ id: bg.id, type: "component", duration: 1, props: bg.props }, project) }} />
              <div className="tile-name">{bg.label}</div>
            </button>
          ))}
          <div className="tile text-tile custom-bg">
            <label className="thumb bg-thumb" style={{ background: custom }} title="Pick a colour">
              <input type="color" data-testid="background-custom-color" value={custom} onChange={(e) => setCustom(e.target.value.toUpperCase())} />
            </label>
            <button className="tile-name link-btn" data-testid="background-custom" disabled={!online} onClick={(e) => (e.currentTarget.blur(), void actions.addBackground({ color: custom }))}>
              Add {custom}
            </button>
          </div>
        </div>
      </div>
      <div className="lib-hint">
        <Layers />
        Drag a component onto the preview or the timeline, or + adds it at the playhead; the Inspector edits it. A background fills the frame under the text: select a title first to make it a title card.
      </div>
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
  const plan = planInsertText(empty, { look: preset.module, text: preset.text, start: 0, duration: 90, animation: null });
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
  const { connection } = useApp();
  const online = connection === "connected";
  return (
    <aside className="library" data-testid="text-library">
      <style>{THUMB_CSS}</style>
      <div className="lib-head">Text</div>
      <div className="lib-section">
        <div className="lib-label">Click to add at the playhead, or drag</div>
        <div className="grid2" data-testid="text-grid">
          {TEXT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className="tile text-tile"
              data-testid="text-preset"
              data-preset={preset.id}
              data-module={preset.module}
              disabled={!online}
              draggable={online}
              title={`Add ${preset.label.toLowerCase()} at the playhead`}
              onDragStart={(e) => {
                e.dataTransfer.setData(TEXT_DRAG_TYPE, preset.id);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={(e) => {
                e.currentTarget.blur();
                void actions.addText(preset);
              }}
            >
              <TextThumb preset={preset} project={project} />
              <div className="tile-name">{preset.label}</div>
            </button>
          ))}
        </div>
      </div>
      <div className="lib-hint">
        <Type />
        Text lands on the first text track that's free at the playhead, 3 seconds long. The Inspector's Style tab changes its look; Reset to preset puts it back.
      </div>
    </aside>
  );
}

function MediaLibrary({ project }: { project: Project }) {
  const app = useApp();
  const { importReport, connection } = app;
  const running = activeJobs(app);
  const importing = running.length > 0;
  const [dragging, setDragging] = useState(false);
  const online = connection === "connected";
  const media = project.media;
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    // Only files from disk have a path; anything else (a dragged link, text) is ignored. A drop
    // while an import runs is queued behind it on the server.
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
      {media.length === 0 ? (
        <Empty icon={<Film />} title="No media yet" testId="media-empty">
          Drop files here, or import them. Footage stays where it is; the project references it.
          <button className="btn" data-testid="import" disabled={!online} onClick={() => void actions.importMedia()}>
            <Upload />
            Import…
          </button>
        </Empty>
      ) : (
        <div className="lib-section">
          <div className="lib-label">In this project</div>
          <div className="grid2" data-testid="media-grid">
            {media.map((m) => (
              <MediaTile key={m.id} item={m} fps={project.canvas.fps} online={online} />
            ))}
          </div>
        </div>
      )}
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
      className="tile"
      data-testid="media-tile"
      data-id={item.id}
      title={item.path}
      draggable={online}
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
      <div className="tile-name" data-testid="tile-name">
        {item.name}
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
