// The library panel on the left: the media in the project (import, drop, add to the timeline)
// the Text tab's presets and the Elements tab's components and backgrounds. Which one shows is
// the rail's choice.
import type { ImportJob } from "@uncut/contracts";
import { solidBackground } from "@uncut/core/render";
import { COMPONENTS, componentDefaults, componentHtml, naturalSize, screenRect, type ComponentInfo } from "@uncut/core/components";
import { defaultFrames, TRANSITIONS, type TransitionInfo } from "@uncut/core/transitions";
import { AudioLines, Blend, Film, Gauge, Image as ImageIcon, Layers, Music, Plus, RefreshCw, Type, Upload, X } from "lucide-react";
import React, { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { bridge } from "./bridge.ts";
import { timecode } from "./format.ts";
import { TEXT_PRESETS } from "./project.ts";
import { BACKGROUNDS } from "./text.ts";
import { actions, activeAnalyses, activeJobs, mediaUrl, thumbUrl, useApp, type MediaItem, type Project } from "./store.ts";
import { COMPONENT_DRAG_TYPE, setDraggedComponent } from "./components.ts";
import { MEDIA_DRAG_TYPE, setDraggedTransition, TRANSITION_DRAG_TYPE } from "./Timeline.tsx";
import { secondsLabel } from "./edit.ts";
import { usePlayback } from "./playback.ts";
import { analysisText } from "./analysisText.ts";

export type LibraryTab = "media" | "text" | "elements" | "audio" | "transitions";

export function Library({ project, tab }: { project: Project; tab: LibraryTab }) {
  return tab === "text" ? (
    <TextLibrary />
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
 * is made if there is none). The free CC0 library comes later.
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
      <div className="lib-soon" data-testid="audio-library-soon">
        <Music /> Free music and sound effects (CC0, searchable by mood and tempo) are coming in a later version.
      </div>
    </aside>
  );
}

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

/** Presets that add a 3 s text item at the playhead (on a free text track). */
function TextLibrary() {
  const { connection } = useApp();
  const online = connection === "connected";
  return (
    <aside className="library" data-testid="text-library">
      <div className="lib-head">Text</div>
      <div className="lib-section">
        <div className="lib-label">Add at the playhead</div>
        <div className="grid2">
          {TEXT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className="tile text-tile"
              data-testid="text-preset"
              data-preset={preset.id}
              disabled={!online}
              title={`Add ${preset.label.toLowerCase()} at the playhead`}
              onClick={(e) => {
                e.currentTarget.blur();
                void actions.addText(preset);
              }}
            >
              <div className={`thumb tp ${preset.id}`}>
                <span>{preset.label}</span>
              </div>
              <div className="tile-name">{preset.label}</div>
            </button>
          ))}
        </div>
      </div>
      <div className="lib-hint">
        <Type />
        Text lands on the first text track that's free at the playhead, 3 seconds long.
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
