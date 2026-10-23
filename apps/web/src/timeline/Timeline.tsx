// The timeline: a ruler with the playhead (click or drag to scrub), every track in CapCut order
// (D28: visual tracks above Main, audio below), items at their resolved starts and lengths, and
// zoom. Media tiles and files from Finder can be dropped on any lane (T1, T9).
//
// Editing (chunk 3, D52; feedback round 1, D122–D128): click selects, ⇧-click selects a range,
// ⌘-click adds or removes one; dragging on empty timeline draws a marquee that selects what it
// touches (a click there moves the playhead). Dragging an item moves it (free tracks: in time and
// to another compatible track, landing on the nearest free spot; main: lands at the drop frame, in order, D224; past the top or
// bottom lane: onto a new track); dragging one of several selected items moves them all, keeping
// their offsets. Edges trim. Moves and trims snap to the playhead, item edges, markers, 0 and
// cached beats (D70), with a snap line (⌘ held: no snapping). The drag is previewed locally from
// the planned ops (edit.ts) and sent as one edit on release. Right-click opens a menu on items,
// track heads and empty timeline (T7). ⌘ + wheel or a pinch zooms around the pointer (T2).
//
// Transitions (D73): each cut between two main-track clips can be clicked to select it; a
// transition on it shows as a marker straddling the cut (CutMarkers).
//
// Tools (issue #57, D230): Select (V) works as above; Blade (C) cuts the item clicked at the
// snapped frame under the pointer, with a line where it would cut; Hand (H) drags the view.
//
// Skimming (issue #118, as in iMovie): with the pointer over the ruler or the lanes (no button
// held, not the Hand), the preview shows the frame under it and a faint line marks it; the
// playhead stays. A press, or the pointer leaving, shows the playhead's frame again.
import { ChevronsLeftRight, Hand, Link2, Magnet, MousePointer2, ScanLine, Scissors, Slice, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cutsOf } from "@uncut/core/transitions";
import { captionCards, captionExtent } from "@uncut/core/captions";

import { useBeats } from "../audio/beats.ts";
import { useDuckCurves } from "../audio/ducking.ts";
import { findItem } from "./edit.ts";
import { rulerLabel } from "../state/format.ts";
import { getPlayback, playback, usePlayback } from "../preview/playback.ts";
import { displayTracks, layoutOf, type Item, type ProjectModel, type Track } from "../state/project.ts";
import { actions, getState, projectOf, useApp } from "../state/store.ts";
import { ItemBox } from "./ItemBox.tsx";
import { Playhead, Skimmer } from "./Playhead.tsx";
import { BottomTabs } from "./BottomTabs.tsx";
import { CutMarkers } from "./CutMarkers.tsx";
import { onTransitionDrop, useDraggedTransition, useTilePointer } from "./dnd.ts";
import { openMenu } from "./ContextMenu.tsx";
import { emptyMenu, itemMenu, rulerMenu, trackMenu, type MenuUi } from "./menus.ts";
import { TrackHead } from "./TrackHead.tsx";
import { useTimelineWheel } from "./wheel.ts";
import { useAgentFlash } from "./useAgentFlash.ts";
import { type DragView, type Marquee, HEAD_WIDTH } from "./gestures/dragView.ts";
import { makeLaneGeometry } from "./gestures/lanes.ts";
import { makeItemDrag } from "./gestures/itemDrag.ts";
import { makeTransitionDrag } from "./gestures/transitionDrag.ts";
import { makeScrubMarquee } from "./gestures/scrubMarquee.ts";
import { makeLaneDrop } from "./gestures/laneDrop.ts";
import { type BladeHover, makeToolPress } from "./gestures/toolPress.ts";
import { setTool, TOOLS, useTool, type Tool } from "./tools.ts";
import { Tooltip } from "../ui/Tooltip.tsx";

const TOOL_ICONS: Readonly<Record<Tool, React.ComponentType>> = { select: MousePointer2, blade: Slice, hand: Hand };

export { BottomTabs } from "./BottomTabs.tsx";
export { MEDIA_DRAG_TYPE, setDraggedTransition, TRANSITION_DRAG_TYPE } from "./dnd.ts";

// "Fit" shows the whole project, but never less than this, so an empty or short project has room.
const MIN_FIT_SECONDS = 10;
const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];

export function Timeline({ project }: { project: ProjectModel }) {
  const { thumbIds, connection, snapshot, agent } = useApp();
  const online = connection === "connected";
  const flash = useAgentFlash(project, snapshot?.revision, agent);
  const zoom = usePlayback((s) => s.zoom);
  const selected = usePlayback((s) => s.selected);
  const also = usePlayback((s) => s.also);
  const markIn = usePlayback((s) => s.markIn);
  const markOut = usePlayback((s) => s.markOut);
  const selectedCut = usePlayback((s) => s.cut);
  const transitionDragged = useDraggedTransition();
  // The cut a dragged transition tile is over (the id of the clip after it).
  const [dropCut, setDropCut] = useState<string | undefined>();
  useEffect(() => {
    if (!transitionDragged) setDropCut(undefined);
  }, [transitionDragged]);
  const snapping = usePlayback((s) => s.snapping);
  const linkOverlays = usePlayback((s) => s.linkOverlays);
  const skimming = usePlayback((s) => s.skimming);
  const beatMap = useBeats((s) => s.map);
  const [drag, setDrag] = useState<DragView | undefined>();
  const [marquee, setMarquee] = useState<Marquee | undefined>();
  const [renaming, setRenaming] = useState<string | undefined>();
  const [renamingTrack, setRenamingTrack] = useState<string | undefined>();
  // The beat the playhead stuck to while scrubbing (for the snap line).
  const [scrubSnap, setScrubSnap] = useState<number | undefined>();
  const tool = useTool();
  const [blade, setBlade] = useState<BladeHover | undefined>();
  const [panning, setPanning] = useState(false);
  useEffect(() => {
    if (tool !== "blade") setBlade(undefined);
  }, [tool]);
  // The running drag's cancel: a new press or unmounting (another project) ends it.
  const stopDrag = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stopDrag.current?.(), []);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(800);
  const [viewHeight, setViewHeight] = useState(200);
  const [dropping, setDropping] = useState(false);
  // The lane a media tile or a file is over while dragging (T1, T9).
  const [dropLane, setDropLane] = useState<string | undefined>();
  // A text or element tile dragged over the lanes (X2, D132): where it would start and how long it lasts.
  const [dropSpan, setDropSpan] = useState<{ frame: number; frames: number } | undefined>();
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const update = () => {
      setVisible(el.clientWidth);
      setViewHeight(el.clientHeight);
    };
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
  useTimelineWheel(bodyRef, HEAD_WIDTH, ppf);
  const step = RULER_STEPS.find((s) => s * fps * ppf >= 64) ?? RULER_STEPS.at(-1)!;
  const ticks: Array<number> = [];
  for (let s = 0; s * fps * ppf <= width; s += step) ticks.push(s);
  const tracks = displayTracks(project);
  const laneOrder = tracks.map((t) => t.id);
  const empty = end === 0;
  // While dragging, the lanes draw the planned result; data-start/data-duration stay the server's.
  const view = drag?.view ?? project;
  // Ducked tracks' curves (D85), drawn on their items.
  const ducks = useDuckCurves(view);
  const viewStarts = layoutOf(view).starts;
  // The main track's cuts as drawn (a drag's planned result included).
  const cuts = cutsOf(view.tracks.find((t) => t.role === "main"));
  const selection = new Set(selected === undefined ? [] : [selected, ...also]);

  const { laneEls, laneHit, laneAt, laneIndexAt, frameAt } = makeLaneGeometry({ project, lanesRef, laneOrder, ppf });

  const menuUi: MenuUi = {
    renameItem: (id) => setRenaming(id),
    renameTrack: (id) => setRenamingTrack(id),
    customSpeed: (id) => {
      playback.select(id);
      actions.openPanel("inspector");
      setTimeout(() => document.querySelector<HTMLInputElement>("[data-testid=insp-speed-custom]")?.focus(), 80);
    },
  };

  // Shift+F10 or the menu key: the selected item's menu, at the item (T7, keyboard access).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) return;
      const id = getPlayback().selected;
      const el = id && document.querySelector<HTMLElement>(`[data-testid=timeline-item][data-item="${CSS.escape(id)}"]`);
      const now = getState().snapshot;
      if (!el || !now) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      openMenu(r.left + Math.min(24, r.width / 2), r.bottom - 4, itemMenu(projectOf(now), id, menuUi, getState().connection === "connected"), "Item");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const { onItemDown } = makeItemDrag({ project, fps, ppf, online, snapshot, starts, tracks, laneOrder, lanesRef, laneEls, laneHit, laneAt, laneIndexAt, setDrag, stopDrag });

  const { onTransitionDown } = makeTransitionDrag({ project, fps, online, snapshot, frameAt, setDrag, stopDrag });

  const toolPress = makeToolPress({ project, ppf, online, lanesRef, bodyRef, frameAt, setBlade, setPanning });

  const { scrub, onEmptyDown } = makeScrubMarquee({ project, ppf, lanesRef, frameAt, setScrubSnap, setMarquee });

  /** Issue #118: skim the frame under the pointer (no button held, not panning); past the project's end, stop. */
  const skim = (e: React.PointerEvent) => {
    if (e.buttons !== 0 || tool === "hand" || !lanesRef.current) return playback.hover(undefined);
    const frame = frameAt(e.clientX);
    playback.hover(frame >= 0 && frame <= end ? frame : undefined);
  };

  const { cutNear, overLanes, onDragOver, onDrop } = makeLaneDrop({ fps, ppf, online, cuts, lanesRef, bodyRef, frameAt, laneHit, dropCut, dropLane, dropSpan, setDropCut, setDropLane, setDropSpan, setDropping });
  // A transition tile dragged with the pointer (F16, D154): the cut under it while it's over the
  // lanes, and on release over them, the transition goes there.
  const tilePointer = useTilePointer();
  const pointerCut = transitionDragged && tilePointer && overLanes(tilePointer.x, tilePointer.y) ? cutNear(tilePointer.x)?.item.id : undefined;
  useEffect(() =>
    onTransitionDrop((module, x, y) => {
      if (!online || !overLanes(x, y)) return false;
      const cut = cutNear(x);
      if (!cut) return false;
      void actions.applyTransition(module, { cut: cut.item.id });
      return true;
    }),
  );

  const onItemMenu = (e: React.MouseEvent, item: Item) => {
    e.preventDefault();
    e.stopPropagation();
    const server = findItem(project, item.id)?.item ?? item;
    openMenu(e.clientX, e.clientY, itemMenu(project, server.id, menuUi, online), "Item");
  };
  const onEmptyMenu = (e: React.MouseEvent, track?: Track) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY, emptyMenu(project, Math.max(0, Math.round(frameAt(e.clientX))), track, online), "Timeline");
  };

  const newTrackY = drag?.newTrack?.y;

  return (
    <section className="bottom">
      <div className="bottom-toolbar">
        <BottomTabs />
        <span className="muted small">{project.tracks.length === 1 ? "1 track" : `${project.tracks.length} tracks`}</span>
        <div className="toolbar-spacer" />
        <div className="tool-picker" role="radiogroup" aria-label="Timeline tool" data-testid="tool-picker">
          {TOOLS.map((t) => {
            const Icon = TOOL_ICONS[t.id];
            return (
              <Tooltip key={t.id} label={t.label} shortcut={t.action}>
                <button className={`icon-btn ${tool === t.id ? "on" : ""}`} role="radio" aria-checked={tool === t.id} aria-pressed={tool === t.id} data-testid={`tool-${t.id}`} onClick={() => setTool(t.id)}>
                  <Icon />
                </button>
              </Tooltip>
            );
          })}
        </div>
        <div className="toolbar-sep" />
        {/* #86 (D239): each icon's tooltip names it and shows its key, read from the keymap. */}
        <Tooltip label="Split at the playhead" shortcut="split">
          <button className="icon-btn" data-testid="split" disabled={!online || empty} onClick={() => void actions.split()}>
            <Scissors />
          </button>
        </Tooltip>
        <Tooltip label={selectedCut ? "Remove the selected transition" : "Delete the selected item"} shortcut="delete">
          <button
            className="icon-btn"
            data-testid="delete-item"
            disabled={!online || !(selected || (selectedCut && findItem(project, selectedCut)?.item.transitionIn))}
            onClick={() => void actions.deleteSelected()}
          >
            <Trash2 />
          </button>
        </Tooltip>
        <Tooltip label={snapping ? "Snapping on (hold ⌘ while dragging to skip)" : "Snapping off"}>
          <button className={`icon-btn ${snapping ? "on" : ""}`} data-testid="snap-toggle" aria-pressed={snapping} onClick={playback.toggleSnapping}>
            <Magnet />
          </button>
        </Tooltip>
        <Tooltip label={skimming ? "Skimming on: the preview shows the frame under the pointer" : "Skimming off"}>
          <button className={`icon-btn ${skimming ? "on" : ""}`} data-testid="skim-toggle" aria-pressed={skimming} onClick={playback.toggleSkimming}>
            <ScanLine />
          </button>
        </Tooltip>
        <Tooltip label={linkOverlays ? "Linked: overlays follow the footage under them when a main clip's speed or length changes" : "Unlinked: overlays stay put when main clips change"}>
          <button className={`icon-btn ${linkOverlays ? "on" : ""}`} data-testid="link-overlays" aria-pressed={linkOverlays} onClick={playback.toggleLinkOverlays}>
            <Link2 />
          </button>
        </Tooltip>
        <div className="toolbar-sep" />
        <Tooltip label="Zoom out" shortcut="zoomOut">
          <button className="icon-btn" data-testid="zoom-out" onClick={playback.zoomOut}>
            <ZoomOut />
          </button>
        </Tooltip>
        <Tooltip label="Zoom in" shortcut="zoomIn">
          <button className="icon-btn" data-testid="zoom-in" onClick={playback.zoomIn}>
            <ZoomIn />
          </button>
        </Tooltip>
        <Tooltip label="Fit the project" shortcut="fit">
          <button className="icon-btn" data-testid="zoom-fit" onClick={playback.zoomFit}>
            <ChevronsLeftRight />
          </button>
        </Tooltip>
      </div>
      <div className="bottom-body" ref={bodyRef}>
        <div className="tl" data-testid="timeline" data-ppf={ppf} data-zoom={zoom} style={{ ["--tl-view-h" as string]: `${viewHeight}px` }}>
          <div className="tl-heads" data-testid="track-heads" onPointerDown={(e) => onEmptyDown(e, true)}>
            <div className="tl-corner" />
            {tracks.map((track) => (
              <TrackHead
                key={track.id}
                project={project}
                track={track}
                online={online}
                renaming={renamingTrack === track.id}
                onRename={() => setRenamingTrack(track.id)}
                onRenamed={() => setRenamingTrack(undefined)}
                onMenu={(e) => {
                  e.preventDefault();
                  openMenu(e.clientX, e.clientY, trackMenu(project, track, menuUi, online), "Track");
                }}
              />
            ))}
          </div>
          <div
            className={`tl-lanes ${dropping ? "dropping" : ""} tool-${tool} ${panning ? "panning" : ""}`}
            data-testid="lanes"
            data-tool={tool}
            ref={lanesRef}
            style={{ width }}
            onPointerDownCapture={(e) => {
              playback.hover(undefined);
              toolPress.onPointerDownCapture(e);
            }}
            onPointerMove={(e) => {
              skim(e);
              toolPress.onPointerMove(e);
            }}
            onPointerLeave={() => {
              playback.hover(undefined);
              toolPress.onPointerLeave();
            }}
            onDragOver={onDragOver}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setDropping(false);
              setDropLane(undefined);
              setDropCut(undefined);
              setDropSpan(undefined);
            }}
            onDrop={onDrop}
            onPointerDown={(e) => onEmptyDown(e)}
            onContextMenu={(e) => onEmptyMenu(e)}
          >
            <div
              className="tl-ruler"
              data-testid="ruler"
              onPointerDown={scrub}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // On the playhead: the playhead's frame; elsewhere on the ruler: the frame under the pointer.
                const onHead = (e.target as Element).closest?.(".playhead");
                const frame = onHead ? Math.floor(getPlayback().frame) : Math.max(0, Math.round(frameAt(e.clientX)));
                openMenu(e.clientX, e.clientY, rulerMenu(frame, { markIn, markOut, end }), "Ruler");
              }}
            >
              {ticks.map((s) => (
                <div key={s} className="tick" style={{ left: s * fps * ppf }}>
                  <span>{rulerLabel(s)}</span>
                </div>
              ))}
              {(markIn !== undefined || markOut !== undefined) && (
                <div
                  className="tl-marks"
                  data-testid="marks"
                  data-in={markIn}
                  data-out={markOut}
                  style={{ left: (markIn ?? 0) * ppf, width: Math.max(1, ((markOut ?? Math.max(end, (markIn ?? 0) + 1)) - (markIn ?? 0)) * ppf) }}
                >
                  {markIn !== undefined && <span className="mark in" />}
                  {markOut !== undefined && <span className="mark out" />}
                </div>
              )}
              <Playhead ppf={ppf} bodyRef={bodyRef} headWidth={HEAD_WIDTH} />
              <Skimmer ppf={ppf} />
            </div>
            {dropSpan && <div className="tl-drop-ghost" data-testid="timeline-drop-ghost" data-frame={dropSpan.frame} style={{ left: dropSpan.frame * ppf, width: Math.max(2, dropSpan.frames * ppf) }} />}
            {tracks.map((track) => {
              const items = (view.tracks.find((t) => t.id === track.id) ?? track).items;
              const editable = !track.locked && online;
              return (
                <div
                  key={track.id}
                  className={`tl-lane ${track.role === "main" ? "main" : ""} ${track.hidden ? "hidden" : ""} ${track.locked ? "locked" : ""} ${dropLane === track.id ? "drop-target" : ""}`}
                  data-testid="lane"
                  data-track={track.id}
                  onPointerDown={(e) => onEmptyDown(e)}
                  onContextMenu={(e) => onEmptyMenu(e, track)}
                >
                  {items.map((item) => {
                    const dragged = drag?.itemId === item.id || (drag?.mode === "group" && drag.group?.includes(item.id));
                    const ghost = drag?.itemId === item.id ? drag.ghost : undefined;
                    // Captions (D82) are drawn where their cards are, not over their whole window.
                    const extent = item.type === "captions" ? (captionExtent(view, item) ?? { from: viewStarts.get(item.id) ?? 0, to: (viewStarts.get(item.id) ?? 0) + 1 }) : undefined;
                    const start = ghost?.start ?? extent?.from ?? viewStarts.get(item.id) ?? 0;
                    const duration = ghost?.duration ?? (extent ? extent.to - extent.from : item.duration);
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
                        beats={item.media ? beatMap.get(item.media) : undefined}
                        className={`${selection.has(item.id) ? "selected" : ""} ${flash.has(item.id) ? "agent-flash" : ""} ${dragged && (drag.mode === "move" || drag.mode === "group") ? "landing" : ""} ${dragged && (drag.mode === "start" || drag.mode === "end") ? "trimming" : ""} ${dragged && drag.refused ? "refused" : ""}`}
                        data={{ "data-testid": "timeline-item", "data-item": item.id, "data-start": server?.start ?? start, "data-duration": server?.item.duration ?? duration }}
                        labelInset={track.role === "main" && item.transitionIn ? Math.max(14, item.transitionIn.duration * ppf) / 2 + 4 : 0}
                        edges={editable && item.type !== "captions"}
                        envelope={item.id === selected && !also.length && editable && !dragged ? "edit" : "show"}
                        duck={ducks.get(track.id)?.keys}
                        renaming={renaming === item.id}
                        onRenamed={() => setRenaming(undefined)}
                        {...(item.type === "captions" ? { cards: captionCards(view, item) } : {})}
                        onPointerDown={(e) => onItemDown(e, server?.item ?? item, track)}
                        onContextMenu={(e) => onItemMenu(e, item)}
                        onDoubleClick={() => online && editable && item.type !== "captions" && setRenaming(item.id)}
                      />
                    );
                  })}
                  {track.role === "main" && (
                    <CutMarkers
                      view={view}
                      cuts={cuts}
                      ppf={ppf}
                      fps={fps}
                      selectedCut={selectedCut}
                      transitionDragged={transitionDragged}
                      dropCut={dropCut ?? pointerCut}
                      resizing={drag?.mode === "transition" ? { id: drag.itemId.slice(3), refused: !!drag.refused } : undefined}
                      editable={editable}
                      onTransitionDown={onTransitionDown}
                    />
                  )}
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
            {newTrackY !== undefined && <div className="tl-newtrack" data-testid="new-track-line" data-side={drag?.newTrack?.side} style={{ top: newTrackY }} />}
            {marquee && (
              <div
                className="marquee"
                data-testid="marquee"
                style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }}
              />
            )}
            {blade && !drag && (
              <div
                className={`blade-line ${blade.refused ? "refused" : ""}`}
                data-testid="blade-line"
                data-frame={blade.frame}
                data-item={blade.item}
                data-snapped={blade.snapAt !== undefined ? "true" : undefined}
                data-refused={blade.refused ? "true" : undefined}
                title={blade.refused}
                style={{ left: blade.frame * ppf, top: blade.top, height: blade.height }}
              />
            )}
            {drag?.snapAt !== undefined && <div className="snap-line" data-testid="snap-line" data-frame={drag.snapAt} style={{ left: drag.snapAt * ppf }} />}
            {!drag && scrubSnap !== undefined && <div className="snap-line" data-testid="snap-line" data-frame={scrubSnap} style={{ left: scrubSnap * ppf }} />}
            {drag && (
              <div className={`drag-tip ${drag.refused ? "refused" : ""}`} data-testid="drag-tip" data-refused={drag.refused ? "true" : undefined} style={{ left: drag.tipAt * ppf }}>
                {drag.tip}
              </div>
            )}
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
