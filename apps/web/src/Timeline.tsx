// The timeline: a ruler with the playhead (click or drag to scrub), every track in CapCut order
// (D28: visual tracks above Main, audio below), items at their resolved starts and lengths, and
// zoom. Media tiles can be dropped on it to add them (same as the tile's + button).
//
// Editing (chunk 3, D52): click selects; dragging an item moves it (free tracks: in time and to
// another compatible track, landing on the nearest free spot; main: reorders), dragging an edge
// trims it, both snapping to the playhead, item edges and 0 (⌘ held: no snapping). The drag is
// previewed locally from the planned ops (edit.ts) and sent as one edit on release. Split,
// delete and the track buttons (hide, mute, lock) are edits too.
import { AudioLines, Eye, EyeOff, Film, Layers, Lock, LockOpen, Magnet, Maximize2, Scissors, Trash2, Type, Volume2, VolumeX, ZoomIn, ZoomOut } from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import { draftOf, findItem, fitsTrack, lockOf, planMove, planTrim, SNAP_PX, snapTargets, trackFlag, trimSnapTargets, type Plan } from "./edit.ts";
import { frameTimecode, rulerLabel } from "./format.ts";
import { getPlayback, playback, usePlayback } from "./playback.ts";
import { SOLID, solidBackground } from "@uncut/core/render";
import { displayTracks, itemLabel, layoutOf, type Item, type ProjectModel, type Track } from "./project.ts";
import { actions, getState, projectOf, thumbUrl, useApp } from "./store.ts";

/** The drag type a media tile carries when it's dragged onto the timeline. */
export const MEDIA_DRAG_TYPE = "application/x-uncut-media";

const HEAD_WIDTH = 148;
// "Fit" shows the whole project, but never less than this, so an empty or short project has room.
const MIN_FIT_SECONDS = 10;
const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
// A press has to move this far before it becomes a drag (a click only selects).
const DRAG_PX = 3;

/** What the lanes draw while an item is dragged: the planned result, before it is sent. */
interface DragView {
  readonly itemId: string;
  readonly mode: "move" | "start" | "end";
  /** The project with the planned ops applied (or as it is, when they would be refused). */
  readonly view: ProjectModel;
  /** Drawn at this start and length instead of where the view puts it (a main clip's left trim). */
  readonly ghost?: { readonly start: number; readonly duration: number };
  /** A move: the item under the pointer, on this track. Its planned spot shows as the landing. */
  readonly float?: { readonly track: string; readonly start: number };
  readonly snapAt?: number;
  /** The frame the tip points at, and what it says (the length while trimming, the start or slot while moving). */
  readonly tipAt: number;
  readonly tip: string;
  /** Why it can't be dropped here (the server would refuse it); releasing sends nothing. */
  readonly refused?: string;
}

export function Timeline({ project }: { project: ProjectModel }) {
  const { thumbIds, connection, snapshot } = useApp();
  const online = connection === "connected";
  const zoom = usePlayback((s) => s.zoom);
  const selected = usePlayback((s) => s.selected);
  const snapping = usePlayback((s) => s.snapping);
  const [drag, setDrag] = useState<DragView | undefined>();
  // The running drag's cancel: a new press or unmounting (another project) ends it.
  const stopDrag = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stopDrag.current?.(), []);
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
  // While dragging, the lanes draw the planned result; data-start/data-duration stay the server's.
  const view = drag?.view ?? project;
  const viewStarts = layoutOf(view).starts;

  /** The track of the lane under a y position, if an item of this kind may go there. */
  const laneAt = (clientY: number, item: Item): string | undefined => {
    for (const lane of lanesRef.current?.querySelectorAll<HTMLElement>("[data-testid=lane]") ?? []) {
      const r = lane.getBoundingClientRect();
      if (clientY < r.top || clientY >= r.bottom) continue;
      const track = project.tracks.find((t) => t.id === lane.dataset.track);
      return track && fitsTrack(item, track) && !track.locked ? track.id : undefined;
    }
    return undefined;
  };

  /**
   * Press on an item: select it. Moving past DRAG_PX starts a move (or a trim, from an edge
   * handle); each pointer move re-plans against the project as it was at the press and redraws
   * (once per animation frame); the release sends the plan as one edit, based on that revision.
   */
  const onItemDown = (e: React.PointerEvent, item: Item, track: Track) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    playback.select(item.id);
    const found = findItem(project, item.id);
    const press = found && { ...found, base: project };
    const origin = { dir: snapshot?.dir, revision: snapshot?.revision };
    if (!press || lockOf(press) || !online) return;
    e.preventDefault();
    const edge = (e.target as HTMLElement).dataset.edge as "start" | "end" | undefined;
    const x0 = e.clientX;
    const pressEdge = edge === "end" ? press.start + press.item.duration : press.start;
    let active = false;
    let plan: Plan | undefined;
    let raf = 0;
    let last: PointerEvent | undefined;
    /** Plan from the pointer against `base`, and draw it (or why it can't be dropped there). */
    const compute = (ev: PointerEvent, base: ProjectModel) => {
      plan = undefined;
      const placed = findItem(base, item.id);
      if (!placed) return;
      const delta = (ev.clientX - x0) / ppf;
      const snapOn = getPlayback().snapping && !ev.metaKey;
      const threshold = SNAP_PX / ppf;
      if (edge) {
        // The edge goes where the pointer is, also when re-planned against a newer project.
        const own = edge === "end" ? placed.start + placed.item.duration : placed.start;
        const snap = snapOn ? { targets: trimSnapTargets(base, getPlayback().frame, item.id, edge), threshold } : undefined;
        const p = planTrim(base, item.id, edge, pressEdge + delta - own, snap);
        if ("problem" in p) return;
        const draft = draftOf(base, p.ops);
        if (!("problem" in draft)) plan = p;
        // A main clip trimmed from the left keeps its start (the rest ripples on release); while
        // dragging, its left edge follows the pointer so the user sees what they cut.
        const mainLeft = edge === "start" && placed.track.role === "main";
        const shown = mainLeft ? { start: placed.start + placed.item.duration - p.duration, duration: p.duration } : undefined;
        setDrag({
          itemId: item.id,
          mode: edge,
          view: mainLeft || "problem" in draft ? base : draft.project,
          ...(shown ? { ghost: shown } : {}),
          ...(p.snapAt !== undefined ? { snapAt: p.snapAt } : {}),
          ...("problem" in draft ? { refused: draft.problem } : {}),
          tipAt: edge === "start" ? (shown?.start ?? p.start) : p.start + p.duration,
          tip: "problem" in draft ? draft.problem : `${(p.duration / fps).toFixed(2)}s`,
        });
        return;
      }
      const desired = press.start + delta;
      const snap = snapOn ? { targets: snapTargets(base, getPlayback().frame, item.id), threshold } : undefined;
      const p = planMove(base, item.id, laneAt(ev.clientY, item) ?? placed.track.id, desired, snap);
      if ("problem" in p) return;
      const draft = draftOf(base, p.ops);
      if (!("problem" in draft)) plan = p;
      setDrag({
        itemId: item.id,
        mode: "move",
        view: "problem" in draft ? base : draft.project,
        float: { track: p.track, start: Math.max(0, desired) },
        ...(p.snapAt !== undefined ? { snapAt: p.snapAt } : {}),
        ...("problem" in draft ? { refused: draft.problem } : {}),
        tipAt: Math.max(0, desired),
        tip: "problem" in draft ? draft.problem : p.start !== undefined ? frameTimecode(p.start, fps) : `Position ${p.index! + 1}`,
      });
    };
    const move = (ev: PointerEvent) => {
      if (!active && Math.abs(ev.clientX - x0) < DRAG_PX && Math.abs(ev.clientY - e.clientY) < DRAG_PX) return;
      if (!active) playback.pause();
      active = true;
      last = ev;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (last) compute(last, press.base);
        });
      }
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      if (stopDrag.current === cancel) stopDrag.current = undefined;
    };
    const cancel = () => {
      stop();
      setDrag(undefined);
    };
    const up = (ev: PointerEvent) => {
      stop();
      if (!active) return;
      // Another project opened meanwhile: the drag belonged to the old one.
      const now = getState().snapshot;
      if (!now || now.dir !== origin.dir) return setDrag(undefined);
      // The project changed during the drag (the agent edited it): plan the same gesture against
      // what is there now, so an index or a clamp isn't computed on a stale timeline.
      const fresh = now.revision !== origin.revision;
      compute(ev, fresh ? projectOf(now) : press.base);
      const sent = plan;
      if (!sent?.ops.length) return setDrag(undefined);
      // Keep drawing the planned result until the server has answered, so nothing jumps back.
      void actions.timelineEdit(sent, { baseRevision: fresh ? now.revision : origin.revision, dir: now.dir }).finally(() => setDrag(undefined));
    };
    stopDrag.current?.();
    stopDrag.current = cancel;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  };

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
        <button className="icon-btn" data-testid="split" title="Split at the playhead (S)" disabled={!online || empty} onClick={() => void actions.split()}>
          <Scissors />
        </button>
        <button className="icon-btn" data-testid="delete-item" title="Delete the selected item (⌫)" disabled={!online || !selected} onClick={() => void actions.deleteSelected()}>
          <Trash2 />
        </button>
        <button
          className={`icon-btn ${snapping ? "on" : ""}`}
          data-testid="snap-toggle"
          aria-pressed={snapping}
          title={snapping ? "Snapping on: moves and trims stick to the playhead and item edges (hold ⌘ while dragging to skip)" : "Snapping off"}
          onClick={playback.toggleSnapping}
        >
          <Magnet />
        </button>
        <div className="toolbar-sep" />
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
              const audio = track.kind === "audio";
              const hidden = trackFlag(track, "hidden");
              const muted = trackFlag(track, "mute");
              const locked = trackFlag(track, "locked");
              return (
                <div
                  key={track.id}
                  className={`tl-head ${main ? "main" : ""}`}
                  data-testid="track"
                  data-id={track.id}
                  data-kind={track.kind}
                  data-main={main ? "true" : undefined}
                  data-hidden={hidden ? "true" : undefined}
                  data-muted={muted ? "true" : undefined}
                  data-locked={locked ? "true" : undefined}
                >
                  <div className="name">
                    <Icon />
                    <span className="ellipsis">{track.name}</span>
                    {main && (
                      <span className="badge" title="Main track: clips play back to back">
                        <Magnet />
                      </span>
                    )}
                  </div>
                  {audio ? (
                    <button
                      className={`icon-btn ${muted ? "on" : ""}`}
                      data-testid="track-mute"
                      aria-pressed={muted}
                      disabled={!online}
                      title={muted ? "Unmute" : "Mute"}
                      onClick={() => void actions.toggleTrack(track.id, "mute")}
                    >
                      {muted ? <VolumeX /> : <Volume2 />}
                    </button>
                  ) : (
                    <button
                      className={`icon-btn ${hidden ? "on" : ""}`}
                      data-testid="track-hide"
                      aria-pressed={hidden}
                      disabled={!online}
                      title={hidden ? "Show in the preview" : "Hide from the preview"}
                      onClick={() => void actions.toggleTrack(track.id, "hidden")}
                    >
                      {hidden ? <EyeOff /> : <Eye />}
                    </button>
                  )}
                  <button
                    className={`icon-btn ${locked ? "on" : ""}`}
                    data-testid="track-lock"
                    aria-pressed={locked}
                    disabled={!online}
                    title={locked ? "Unlock" : "Lock: no edits by hand or by the agent"}
                    onClick={() => void actions.toggleTrack(track.id, "locked")}
                  >
                    {locked ? <Lock /> : <LockOpen />}
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
            {tracks.map((track) => {
              const items = (view.tracks.find((t) => t.id === track.id) ?? track).items;
              const editable = !track.locked && online;
              return (
                <div
                  key={track.id}
                  className={`tl-lane ${track.role === "main" ? "main" : ""} ${track.hidden ? "hidden" : ""} ${track.locked ? "locked" : ""}`}
                  data-testid="lane"
                  data-track={track.id}
                  onPointerDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    playback.select(undefined);
                    scrub(e);
                  }}
                >
                  {items.map((item) => {
                    const dragged = drag?.itemId === item.id;
                    const ghost = dragged ? drag.ghost : undefined;
                    const start = ghost?.start ?? viewStarts.get(item.id) ?? 0;
                    const duration = ghost?.duration ?? item.duration;
                    const server = findItem(project, item.id);
                    return (
                      <ItemBox
                        key={item.id}
                        project={view}
                        item={item}
                        start={start}
                        duration={duration}
                        ppf={ppf}
                        thumbIds={thumbIds}
                        className={`${item.id === selected ? "selected" : ""} ${dragged && drag.mode === "move" ? "landing" : ""} ${dragged && drag.mode !== "move" ? "trimming" : ""} ${dragged && drag.refused ? "refused" : ""}`}
                        data={{ "data-testid": "timeline-item", "data-item": item.id, "data-start": server?.start ?? start, "data-duration": server?.item.duration ?? duration }}
                        edges={editable}
                        onPointerDown={(e) => onItemDown(e, server?.item ?? item, track)}
                      />
                    );
                  })}
                  {drag?.float?.track === track.id &&
                    (() => {
                      const item = findItem(project, drag.itemId)?.item;
                      return item ? (
                        <ItemBox project={project} item={item} start={drag.float.start} duration={item.duration} ppf={ppf} thumbIds={thumbIds} className={`dragging ${drag.refused ? "refused" : ""}`} data={{ "data-testid": "drag-float" }} edges={false} />
                      ) : null;
                    })()}
                </div>
              );
            })}
            {drag?.snapAt !== undefined && <div className="snap-line" data-testid="snap-line" data-frame={drag.snapAt} style={{ left: drag.snapAt * ppf }} />}
            {drag && (
              <div className={`drag-tip ${drag.refused ? "refused" : ""}`} data-testid="drag-tip" data-refused={drag.refused ? "true" : undefined} style={{ left: drag.tipAt * ppf }}>
                {drag.tip}
              </div>
            )}
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

/** One item on a lane: its box, name, length and (when it can be edited) trim handles at both edges. */
function ItemBox({
  project,
  item,
  start,
  duration,
  ppf,
  thumbIds,
  className,
  data,
  edges,
  onPointerDown,
}: {
  project: ProjectModel;
  item: Item;
  start: number;
  duration: number;
  ppf: number;
  thumbIds: ReadonlySet<string>;
  className: string;
  data: Readonly<Record<string, string | number>>;
  edges: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  const media = item.media ? project.media.find((m) => m.id === item.media) : undefined;
  const poster = item.type === "clip" && media && thumbIds.has(media.id) ? thumbUrl(media.id, media.path) : undefined;
  const kind = item.type === "clip" ? "video" : item.type;
  const label = itemLabel(project, item);
  return (
    <div
      className={`clip ${kind} ${className}`}
      data-type={item.type}
      {...data}
      title={label}
      style={{ left: start * ppf, width: Math.max(4, duration * ppf - 2) }}
      onPointerDown={onPointerDown}
    >
      {poster && <div className="strip" style={{ backgroundImage: `url("${poster}")` }} />}
      {item.type === "component" && item.component === SOLID && <div className="strip solid-fill" data-testid="solid-fill" style={{ background: solidBackground(item, project) }} />}
      <span className="nm">{label}</span>
      <span className="meta">{(duration / project.canvas.fps).toFixed(1)}s</span>
      {edges && (
        <>
          <div className="edge start" data-edge="start" data-testid="trim-start" title="Drag to trim" />
          <div className="edge end" data-edge="end" data-testid="trim-end" title="Drag to trim" />
        </>
      )}
    </div>
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
