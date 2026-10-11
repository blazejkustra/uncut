// The timeline: a ruler with the playhead (click or drag to scrub), every track in CapCut order
// (D28: visual tracks above Main, audio below), items at their resolved starts and lengths, and
// zoom. Media tiles can be dropped on it to add them (same as the tile's + button). Editing items
// (move, trim, split) comes in chunk 3; clicking one selects it.
import { AudioLines, Eye, Film, Layers, Lock, Magnet, Maximize2, Type, Volume2, ZoomIn, ZoomOut } from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import { rulerLabel } from "./format.ts";
import { getPlayback, playback, usePlayback } from "./playback.ts";
import { displayTracks, itemLabel, layoutOf, type ProjectModel } from "./project.ts";
import { actions, thumbUrl, useApp } from "./store.ts";

/** The drag type a media tile carries when it's dragged onto the timeline. */
export const MEDIA_DRAG_TYPE = "application/x-uncut-media";

const HEAD_WIDTH = 148;
// "Fit" shows the whole project, but never less than this, so an empty or short project has room.
const MIN_FIT_SECONDS = 10;
const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];

export function Timeline({ project }: { project: ProjectModel }) {
  const { thumbIds, connection } = useApp();
  const online = connection === "connected";
  const zoom = usePlayback((s) => s.zoom);
  const selected = usePlayback((s) => s.selected);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(800);
  const [dropping, setDropping] = useState(false);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const update = () => setVisible(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fps = project.canvas.fps;
  const { starts, end } = layoutOf(project);
  const lanesVisible = Math.max(100, visible - HEAD_WIDTH);
  const fitFrames = Math.max(end, MIN_FIT_SECONDS * fps);
  // Pixels per frame. Fit leaves a little room after the last item.
  const ppf = ((lanesVisible - 40) / fitFrames) * zoom;
  const width = Math.max(lanesVisible, end * ppf + 200);
  const step = RULER_STEPS.find((s) => s * fps * ppf >= 64) ?? RULER_STEPS.at(-1)!;
  const ticks: Array<number> = [];
  for (let s = 0; s * fps * ppf <= width; s += step) ticks.push(s);
  const tracks = displayTracks(project);
  const empty = end === 0;

  const frameAt = (clientX: number) => {
    const rect = lanesRef.current!.getBoundingClientRect();
    return (clientX - rect.left) / ppf;
  };
  /** Click or drag on the ruler, the playhead or an empty lane: move the playhead there. */
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    playback.pause();
    playback.seek(frameAt(e.clientX));
    const move = (ev: PointerEvent) => playback.seek(frameAt(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!online || ![...e.dataTransfer.types].includes(MEDIA_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropping(true);
  };
  const onDrop = (e: React.DragEvent) => {
    setDropping(false);
    const id = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (!id) return;
    e.preventDefault();
    void actions.addMedia(id);
  };

  return (
    <section className="bottom">
      <div className="bottom-toolbar">
        <div className="seg">
          <button className="active">Timeline</button>
          <button disabled title="Coming in a later phase">
            Transcript
          </button>
          <button disabled title="Coming in a later phase">
            Mixer
          </button>
        </div>
        <span className="muted small">{project.tracks.length} tracks</span>
        <div className="toolbar-spacer" />
        <button className="icon-btn" data-testid="zoom-out" title="Zoom out (⌘−)" onClick={playback.zoomOut}>
          <ZoomOut />
        </button>
        <button className="icon-btn" data-testid="zoom-in" title="Zoom in (⌘+)" onClick={playback.zoomIn}>
          <ZoomIn />
        </button>
        <button className="icon-btn" data-testid="zoom-fit" title="Fit the project (⌘0)" onClick={playback.zoomFit}>
          <Maximize2 />
        </button>
      </div>
      <div className="bottom-body" ref={bodyRef}>
        <div className="tl" data-testid="timeline" data-ppf={ppf}>
          <div className="tl-heads">
            <div className="tl-corner" />
            {tracks.map((track) => {
              const main = track.role === "main";
              const Icon = track.kind === "text" ? Type : track.kind === "audio" ? AudioLines : main ? Film : Layers;
              return (
                <div key={track.id} className={`tl-head ${main ? "main" : ""}`} data-testid="track" data-id={track.id} data-kind={track.kind} data-main={main ? "true" : undefined}>
                  <div className="name">
                    <Icon />
                    <span className="ellipsis">{track.name}</span>
                    {main && (
                      <span className="badge" title="Main track: clips play back to back">
                        <Magnet />
                      </span>
                    )}
                  </div>
                  <button className="icon-btn" disabled title={track.kind === "audio" ? "Mute" : "Hide"}>
                    {track.kind === "audio" ? <Volume2 /> : <Eye />}
                  </button>
                  <button className="icon-btn" disabled title="Lock">
                    <Lock />
                  </button>
                </div>
              );
            })}
          </div>
          <div
            className={`tl-lanes ${dropping ? "dropping" : ""}`}
            ref={lanesRef}
            style={{ width }}
            onDragOver={onDragOver}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
            }}
            onDrop={onDrop}
          >
            <div className="tl-ruler" data-testid="ruler" onPointerDown={scrub}>
              {ticks.map((s) => (
                <div key={s} className="tick" style={{ left: s * fps * ppf }}>
                  <span>{rulerLabel(s)}</span>
                </div>
              ))}
            </div>
            {tracks.map((track) => (
              <div
                key={track.id}
                className={`tl-lane ${track.role === "main" ? "main" : ""}`}
                data-testid="lane"
                data-track={track.id}
                onPointerDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  playback.select(undefined);
                  scrub(e);
                }}
              >
                {track.items.map((item) => {
                  const start = starts.get(item.id) ?? 0;
                  const media = item.media ? project.media.find((m) => m.id === item.media) : undefined;
                  const poster = item.type === "clip" && media && thumbIds.has(media.id) ? thumbUrl(media.id, media.path) : undefined;
                  const kind = item.type === "clip" ? "video" : item.type;
                  return (
                    <div
                      key={item.id}
                      className={`clip ${kind} ${item.id === selected ? "selected" : ""}`}
                      data-testid="timeline-item"
                      data-item={item.id}
                      data-type={item.type}
                      data-start={start}
                      data-duration={item.duration}
                      title={itemLabel(project, item)}
                      style={{ left: start * ppf, width: Math.max(4, item.duration * ppf - 2) }}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        playback.select(item.id);
                      }}
                    >
                      {poster && <div className="strip" style={{ backgroundImage: `url("${poster}")` }} />}
                      <span className="nm">{itemLabel(project, item)}</span>
                      <span className="meta">{(item.duration / fps).toFixed(1)}s</span>
                    </div>
                  );
                })}
              </div>
            ))}
            <Playhead ppf={ppf} bodyRef={bodyRef} onGrab={scrub} />
          </div>
        </div>
      </div>
      {empty && (
        <div className="tl-empty" data-testid="timeline-empty">
          {project.media.length ? "Drag a clip here, or use + on a tile. Titles are in the Text tab." : "Import media, or add a title from the Text tab."}
        </div>
      )}
    </section>
  );
}

/** The playhead line: its own component, so playback re-renders only this. Its handle drags. */
function Playhead({ ppf, bodyRef, onGrab }: { ppf: number; bodyRef: React.RefObject<HTMLDivElement | null>; onGrab: (e: React.PointerEvent) => void }) {
  const frame = usePlayback((s) => s.frame);
  const x = frame * ppf;
  // While playing, keep the playhead in view.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !getPlayback().playing) return;
    const view = body.clientWidth - HEAD_WIDTH;
    if (x < body.scrollLeft || x > body.scrollLeft + view - 24) body.scrollLeft = Math.max(0, x - 48);
  }, [x, bodyRef]);
  return (
    <div className="playhead" data-testid="playhead" data-frame={Math.floor(frame)} style={{ left: x }}>
      <div className="playhead-handle" onPointerDown={onGrab} />
    </div>
  );
}
