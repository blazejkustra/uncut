// The timeline: a ruler with the playhead (click or drag to scrub), every track in CapCut order
// (D28: visual tracks above Main, audio below), items at their resolved starts and lengths, and
// zoom. Media tiles and files from Finder can be dropped on any lane (T1, T9).
//
// Editing (chunk 3, D52; feedback round 1, D122–D128): click selects, ⇧-click selects a range,
// ⌘-click adds or removes one; dragging on empty timeline draws a marquee that selects what it
// touches (a click there moves the playhead). Dragging an item moves it (free tracks: in time and
// to another compatible track, landing on the nearest free spot; main: reorders; past the top or
// bottom lane: onto a new track); dragging one of several selected items moves them all, keeping
// their offsets. Edges trim. Moves and trims snap to the playhead, item edges, markers, 0 and
// cached beats (D70), with a snap line (⌘ held: no snapping). The drag is previewed locally from
// the planned ops (edit.ts) and sent as one edit on release. Right-click opens a menu on items,
// track heads and empty timeline (T7). ⌘ + wheel or a pinch zooms around the pointer (T2).
//
// Transitions (D73): each cut between two main-track clips can be clicked to select it; a
// transition on it shows as a marker straddling the cut (CutMarkers).
import { ChevronsLeftRight, Link2, Magnet, Scissors, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cutsOf } from "@uncut/core/transitions";
import { captionCards, captionExtent } from "@uncut/core/captions";

import { getBeats, useBeats } from "../audio/beats.ts";
import { useDuckCurves } from "../audio/ducking.ts";
import { draftOf, findItem, fitsTrack, lockOf, newTrackIndexOver, withGroups, withOverlayRipple, planGroupMove, planGroupTrim, planMove, planMoveToNewTrack, planSetTransition, planTrim, secondsLabel, SNAP_PX, snapPlayhead, snapTargets, trimSnapTargets, type NewTrackSide, type Plan } from "./edit.ts";
import { frameTimecode, rulerLabel } from "../state/format.ts";
import { getPlayback, playback, usePlayback } from "../preview/playback.ts";
import { displayTracks, layoutOf, type Item, type ProjectModel, type Track } from "../state/project.ts";
import { planFade } from "../audio/sound.ts";
import { bridge } from "../state/bridge.ts";
import { actions, getState, isRemote, projectOf, textPresets, useApp } from "../state/store.ts";
import { DRAG_PX, ItemBox } from "./ItemBox.tsx";
import { Playhead } from "./Playhead.tsx";
import { COMPONENT_DRAG_TYPE, draggedComponent, secondsFor, setDraggedComponent, setDraggedText, TEXT_DRAG_TYPE } from "../preview/components.ts";
import { BottomTabs } from "./BottomTabs.tsx";
import { CutMarkers } from "./CutMarkers.tsx";
import { CUT_DROP_PX, EFFECT_DRAG_TYPE, hasFiles, MEDIA_DRAG_TYPE, onTransitionDrop, setDraggedEffect, setDraggedTransition, TRANSITION_DRAG_TYPE, useDraggedTransition, useTilePointer } from "./dnd.ts";
import { openMenu } from "./ContextMenu.tsx";
import { emptyMenu, itemMenu, rulerMenu, trackMenu, type MenuUi } from "./menus.ts";
import { TrackHead } from "./TrackHead.tsx";
import { useTimelineWheel } from "./wheel.ts";

export { BottomTabs } from "./BottomTabs.tsx";
export { MEDIA_DRAG_TYPE, setDraggedTransition, TRANSITION_DRAG_TYPE } from "./dnd.ts";

const HEAD_WIDTH = 184;
// "Fit" shows the whole project, but never less than this, so an empty or short project has room.
const MIN_FIT_SECONDS = 10;
const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];

/** What the lanes draw while an item is dragged: the planned result, before it is sent. */
interface DragView {
  readonly itemId: string;
  readonly mode: "move" | "start" | "end" | "fade" | "transition" | "group";
  /** The project with the planned ops applied (or as it is, when they would be refused). */
  readonly view: ProjectModel;
  /** Drawn at this start and length instead of where the view puts it (a main clip's left trim). */
  readonly ghost?: { readonly start: number; readonly duration: number };
  /** A move: the item under the pointer, on this track. Its planned spot shows as the landing. */
  readonly float?: { readonly track: string; readonly start: number };
  /** A move past the top or bottom lane, or onto a lane that can't take it (F6): a new track appears there (y: the line, px in the lanes). */
  readonly newTrack?: { readonly side: NewTrackSide | "between"; readonly y: number };
  /** A group move: the items moving. */
  readonly group?: ReadonlyArray<string>;
  readonly snapAt?: number;
  /** The frame the tip points at, and what it says (the length while trimming, the start or slot while moving). */
  readonly tipAt: number;
  readonly tip: string;
  /** Why it can't be dropped here (the server would refuse it); releasing sends nothing. */
  readonly refused?: string;
}

/** A marquee in lane coordinates (px from the lanes' top-left). */
interface Marquee {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const selectionIds = () => {
  const { selected, also } = getPlayback();
  return selected === undefined ? [] : [selected, ...also];
};

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
  const beatMap = useBeats((s) => s.map);
  const [drag, setDrag] = useState<DragView | undefined>();
  const [marquee, setMarquee] = useState<Marquee | undefined>();
  const [renaming, setRenaming] = useState<string | undefined>();
  const [renamingTrack, setRenamingTrack] = useState<string | undefined>();
  // The beat the playhead stuck to while scrubbing (for the snap line).
  const [scrubSnap, setScrubSnap] = useState<number | undefined>();
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

  const laneEls = () => [...(lanesRef.current?.querySelectorAll<HTMLElement>("[data-testid=lane]") ?? [])];
  /** The lane under a y position: its track, or past the first / last lane. */
  const laneHit = (clientY: number): { track?: Track; side?: NewTrackSide } => {
    const lanes = laneEls();
    if (!lanes.length) return {};
    const first = lanes[0]!.getBoundingClientRect();
    const last = lanes.at(-1)!.getBoundingClientRect();
    if (clientY < first.top) return { side: "top" };
    if (clientY >= last.bottom) return { side: "bottom" };
    for (const lane of lanes) {
      const r = lane.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return { track: project.tracks.find((t) => t.id === lane.dataset.track) };
    }
    return {};
  };
  /** The track of the lane under a y position, if an item of this kind may go there. */
  const laneAt = (clientY: number, item: Item): string | undefined => {
    const { track } = laneHit(clientY);
    return track && fitsTrack(item, track) && !track.locked ? track.id : undefined;
  };
  const laneIndexAt = (clientY: number) => {
    const { track } = laneHit(clientY);
    return track ? laneOrder.indexOf(track.id) : -1;
  };

  const frameAt = (clientX: number) => {
    const rect = lanesRef.current!.getBoundingClientRect();
    return (clientX - rect.left) / ppf;
  };

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

  /**
   * Press on an item: select it (⇧: a range, ⌘: add or remove it). Moving past DRAG_PX starts a
   * move (or a trim, from an edge handle; a group move when it's one of several selected); each
   * pointer move re-plans against the project as it was at the press and redraws (once per
   * animation frame); the release sends the plan as one edit, based on that revision.
   */
  const onItemDown = (e: React.PointerEvent, item: Item, track: Track) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // ⌘-click adds or removes the item; ⌘ held while dragging only turns snapping off.
    const toggle = e.metaKey || e.ctrlKey;
    const toggleIt = () => {
      const ids = selectionIds();
      playback.selectMany(ids.includes(item.id) ? ids.filter((i) => i !== item.id) : [...ids, item.id]);
    };
    if (e.shiftKey) {
      const anchor = findItem(project, getPlayback().selected);
      const here = findItem(project, item.id);
      if (!anchor || !here) return playback.select(item.id);
      // A range: everything between the two in time, on the lanes between them.
      const from = Math.min(anchor.start, here.start);
      const to = Math.max(anchor.start + anchor.item.duration, here.start + here.item.duration);
      const [l0, l1] = [laneOrder.indexOf(anchor.track.id), laneOrder.indexOf(here.track.id)].sort((a, b) => a - b);
      const ids = [anchor.item.id];
      for (const t of tracks.slice(l0, l1 + 1))
        for (const i of t.items) {
          const s = starts.get(i.id) ?? 0;
          if (i.type !== "captions" && i.id !== anchor.item.id && s < to && s + i.duration > from) ids.push(i.id);
        }
      playback.selectMany(ids);
      return;
    }
    // D157: an item in a group brings its group along (selected, moved and trimmed together).
    const before = selectionIds();
    const mates = withGroups(project, [item.id]);
    const current = toggle ? before : before.includes(item.id) ? withGroups(project, before) : mates;
    const grouped = !toggle && current.length > 1 && current.includes(item.id);
    // Just its own group: its edges trim the whole group.
    const groupOnly = grouped && mates.length > 1 && current.length === mates.length && current.every((id) => mates.includes(id));
    if (!grouped && !toggle) playback.select(item.id);
    else if (grouped && (!before.includes(item.id) || current.length !== before.length)) playback.selectMany([item.id, ...current.filter((id) => id !== item.id)]);
    const found = findItem(project, item.id);
    const press = found && { ...found, base: project };
    const origin = { dir: snapshot?.dir, revision: snapshot?.revision };
    // Captions (D82) follow the speech on the main track: selected here, edited in the Inspector.
    if (!press || lockOf(press) || !online || item.type === "captions") {
      if (toggle) toggleIt();
      return;
    }
    e.preventDefault();
    const edge = grouped && !groupOnly ? undefined : ((e.target as HTMLElement).dataset.edge as "start" | "end" | undefined);
    // A fade handle (top corners of an item with sound): drag sets the fade's length.
    const fade = grouped ? undefined : ((e.target as HTMLElement).dataset.fade as "in" | "out" | undefined);
    const x0 = e.clientX;
    const lane0 = laneIndexAt(e.clientY);
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
      const beats = { beats: getBeats().map, ppf };
      if (grouped && !edge) {
        const lane = laneIndexAt(ev.clientY);
        const offset = lane === -1 || lane0 === -1 ? 0 : lane - lane0;
        const ids = current;
        const snap = snapOn ? { targets: snapTargets(base, getPlayback().frame, new Set(ids), beats), threshold } : undefined;
        const p = planGroupMove(base, ids, delta, offset, laneOrder, snap);
        const draft = "problem" in p ? p : draftOf(base, p.ops);
        if (!("problem" in draft) && !("problem" in p)) plan = p;
        const tipAt = Math.max(0, placed.start + ("problem" in p ? delta : p.delta));
        setDrag({
          itemId: item.id,
          mode: "group",
          group: ids,
          view: "problem" in draft ? base : draft.project,
          ...(!("problem" in p) && p.snapAt !== undefined ? { snapAt: p.snapAt } : {}),
          ...("problem" in draft ? { refused: draft.problem } : {}),
          tipAt,
          tip: "problem" in draft ? draft.problem : `${ids.length} items, ${frameTimecode(Math.round(tipAt), fps)}`,
        });
        return;
      }
      if (fade) {
        const x = (ev.clientX - (lanesRef.current?.getBoundingClientRect().left ?? 0)) / ppf;
        const frames = fade === "in" ? x - placed.start : placed.start + placed.item.duration - x;
        const p = planFade(base, item.id, fade, frames);
        if ("problem" in p) return;
        const draft = draftOf(base, p.ops);
        if (!("problem" in draft)) plan = p;
        const shownItem = ("project" in draft ? findItem(draft.project, item.id)?.item : undefined) ?? placed.item;
        const length = (fade === "in" ? shownItem.fadeIn : shownItem.fadeOut) ?? 0;
        setDrag({
          itemId: item.id,
          mode: "fade",
          view: "problem" in draft ? base : draft.project,
          ...("problem" in draft ? { refused: draft.problem } : {}),
          tipAt: fade === "in" ? placed.start + length : placed.start + placed.item.duration - length,
          tip: "problem" in draft ? draft.problem : `Fade ${fade} ${(length / fps).toFixed(1)}s`,
        });
        return;
      }
      if (edge) {
        // The edge goes where the pointer is, also when re-planned against a newer project.
        const own = edge === "end" ? placed.start + placed.item.duration : placed.start;
        const snap = snapOn ? { targets: trimSnapTargets(base, getPlayback().frame, item.id, edge, beats), threshold } : undefined;
        const trimmed = groupOnly ? planGroupTrim(base, item.id, edge, pressEdge + delta - own, snap) : planTrim(base, item.id, edge, pressEdge + delta - own, snap);
        if ("problem" in trimmed) return;
        // F11 (D156): overlays over a main clip follow its footage.
        const p = placed.track.role === "main" && getPlayback().linkOverlays ? withOverlayRipple(base, trimmed) : trimmed;
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
      const snap = snapOn ? { targets: snapTargets(base, getPlayback().frame, item.id, beats), threshold } : undefined;
      // Past the top or bottom lane: onto a new track there (D122). Onto a lane that can't take it
      // (a clip from Main onto a text track): a new track next to that lane (F6, D149).
      const hit = laneHit(ev.clientY);
      const side = hit.side;
      const between = !side && hit.track && hit.track.id !== placed.track.id ? newTrackIndexOver(base, placed.item, hit.track) : undefined;
      const lanesTop = lanesRef.current?.getBoundingClientRect().top ?? 0;
      const laneRect = (id: string) => laneEls().find((l) => l.dataset.track === id)?.getBoundingClientRect();
      const lineY = (): number => {
        const lanes = laneEls();
        if (side === "top") return (lanes[0]?.getBoundingClientRect().top ?? lanesTop) - lanesTop;
        if (side === "bottom") return (lanes.at(-1)?.getBoundingClientRect().bottom ?? lanesTop) - lanesTop - 2;
        const r = laneRect(hit.track!.id);
        return r ? (placed.item.type === "text" ? r.top : r.bottom) - lanesTop - 1 : 0;
      };
      const p = side ? planMoveToNewTrack(base, item.id, side, desired, snap) : between !== undefined ? planMoveToNewTrack(base, item.id, { index: between }, desired, snap) : planMove(base, item.id, laneAt(ev.clientY, item) ?? placed.track.id, desired, snap);
      const newTrack = side || between !== undefined ? { side: side ?? ("between" as const), y: lineY() } : undefined;
      if ("problem" in p) return setDrag({ itemId: item.id, mode: "move", view: base, refused: p.problem, tipAt: Math.max(0, desired), tip: p.problem });
      const draft = draftOf(base, p.ops);
      if (!("problem" in draft)) plan = p;
      setDrag({
        itemId: item.id,
        mode: "move",
        view: "problem" in draft ? base : draft.project,
        ...(newTrack ? { newTrack } : { float: { track: p.track, start: Math.max(0, desired) } }),
        ...(p.snapAt !== undefined ? { snapAt: p.snapAt } : {}),
        ...("problem" in draft ? { refused: draft.problem } : {}),
        tipAt: Math.max(0, desired),
        tip: "problem" in draft ? draft.problem : newTrack ? `New track, ${frameTimecode(p.start ?? 0, fps)}` : p.start !== undefined ? frameTimecode(p.start, fps) : `Position ${p.index! + 1}`,
      });
    };
    const move = (ev: PointerEvent) => {
      if (!active && Math.abs(ev.clientX - x0) < DRAG_PX && Math.abs(ev.clientY - e.clientY) < DRAG_PX) return;
      if (!active) {
        playback.pause();
        if (toggle) playback.select(item.id);
      }
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
      // A click on one of several selected items selects just it.
      if (!active) return toggle ? toggleIt() : grouped ? (mates.length > 1 ? playback.selectMany(mates) : playback.select(item.id)) : undefined;
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

  /**
   * Press on a transition marker: select its cut. From an edge, dragging changes its length,
   * centred on the cut (the edge follows the pointer, so the length is twice its distance from
   * the cut), clamped to what fits there; one edit on release ("Changed transition to 0.8 s").
   */
  const onTransitionDown = (e: React.PointerEvent, itemId: string, cutFrame: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    playback.selectCut(itemId);
    const edge = (e.target as HTMLElement).dataset.trEdge;
    const base = project;
    const placed = findItem(base, itemId);
    const tr = placed?.item.transitionIn;
    const origin = { dir: snapshot?.dir, revision: snapshot?.revision };
    if (!edge || !placed || !tr || lockOf(placed) || !online) return;
    e.preventDefault();
    const x0 = e.clientX;
    let active = false;
    let plan: Plan | undefined;
    const compute = (ev: PointerEvent, against: ProjectModel) => {
      plan = undefined;
      const now = findItem(against, itemId)?.item.transitionIn;
      if (!now) return;
      const wanted = Math.max(1, Math.round(2 * Math.abs(frameAt(ev.clientX) - cutFrame)));
      const p = planSetTransition(against, itemId, { module: now.module, duration: wanted });
      if ("problem" in p) return setDrag({ itemId: `tr:${itemId}`, mode: "transition", view: against, refused: p.problem, tipAt: cutFrame, tip: p.problem });
      const draft = draftOf(against, p.ops);
      if (!("problem" in draft)) plan = p;
      const shown = ("project" in draft ? findItem(draft.project, itemId)?.item.transitionIn?.duration : undefined) ?? now.duration;
      setDrag({
        itemId: `tr:${itemId}`,
        mode: "transition",
        view: "problem" in draft ? against : draft.project,
        ...("problem" in draft ? { refused: draft.problem } : {}),
        tipAt: cutFrame + shown / 2,
        tip: "problem" in draft ? draft.problem : `${secondsLabel(shown, fps)} (${shown} frames)`,
      });
    };
    const move = (ev: PointerEvent) => {
      if (!active && Math.abs(ev.clientX - x0) < DRAG_PX) return;
      if (!active) playback.pause();
      active = true;
      compute(ev, base);
    };
    const stop = () => {
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
      const now = getState().snapshot;
      if (!now || now.dir !== origin.dir) return setDrag(undefined);
      const fresh = now.revision !== origin.revision;
      compute(ev, fresh ? projectOf(now) : base);
      const sent = plan;
      if (!sent?.ops.length) return setDrag(undefined);
      void actions.timelineEdit(sent, { baseRevision: fresh ? now.revision : origin.revision, dir: now.dir }).finally(() => setDrag(undefined));
    };
    stopDrag.current?.();
    stopDrag.current = cancel;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  };

  /** Click or drag on the ruler or the playhead: move the playhead there (with snapping on, to a beat within reach, D70). */
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    playback.pause();
    const seek = (ev: { clientX: number; metaKey: boolean }) => {
      const frame = frameAt(ev.clientX);
      const snapped = getPlayback().snapping && !ev.metaKey ? snapPlayhead(project, frame, { beats: getBeats().map, ppf }, SNAP_PX / ppf) : { frame };
      setScrubSnap(snapped.snapAt);
      playback.seek(snapped.frame);
    };
    seek(e);
    const move = (ev: PointerEvent) => seek(ev);
    const up = () => {
      setScrubSnap(undefined);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  /**
   * Press on empty timeline (T8): a click moves the playhead there and clears the selection; a drag
   * draws a marquee and selects every item it touches (with ⇧ or ⌘, added to the selection).
   */
  const onEmptyDown = (e: React.PointerEvent, fromHeads = false) => {
    if (e.button !== 0) return;
    // From the track heads (F12): anywhere but their buttons, fields and sliders; the marquee starts at the lanes' visible left edge.
    if (fromHeads ? (e.target as HTMLElement).closest("button, input, select, textarea, .track-volume") : e.target !== e.currentTarget) return;
    e.preventDefault();
    const lanes = lanesRef.current;
    if (!lanes) return;
    const keep = e.shiftKey || e.metaKey ? selectionIds() : [];
    const r0 = lanes.getBoundingClientRect();
    const headsRight = (e.currentTarget as HTMLElement).getBoundingClientRect().right;
    const start = { x: fromHeads ? Math.max(0, headsRight - r0.left) : e.clientX - r0.left, y: e.clientY - r0.top };
    let active = false;
    if (!keep.length && !fromHeads) {
      playback.pause();
      playback.select(undefined);
      const frame = frameAt(e.clientX);
      const snapped = getPlayback().snapping && !e.metaKey ? snapPlayhead(project, frame, { beats: getBeats().map, ppf }, SNAP_PX / ppf) : { frame };
      playback.seek(snapped.frame);
    }
    const hit = (m: Marquee) => {
      const r = lanes.getBoundingClientRect();
      const box = { left: Math.min(m.x0, m.x1) + r.left, right: Math.max(m.x0, m.x1) + r.left, top: Math.min(m.y0, m.y1) + r.top, bottom: Math.max(m.y0, m.y1) + r.top };
      const ids = [...lanes.querySelectorAll<HTMLElement>("[data-testid=timeline-item]")]
        .filter((el) => el.dataset.type !== "captions")
        .filter((el) => {
          const b = el.getBoundingClientRect();
          return b.right > box.left && b.left < box.right && b.bottom > box.top && b.top < box.bottom;
        })
        .map((el) => el.dataset.item!);
      playback.selectMany([...new Set([...keep, ...ids])]);
    };
    const move = (ev: PointerEvent) => {
      const r = lanes.getBoundingClientRect();
      const at = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      if (!active && Math.abs(at.x - start.x) < DRAG_PX && Math.abs(at.y - start.y) < DRAG_PX) return;
      active = true;
      const m = { x0: start.x, y0: start.y, x1: Math.max(0, Math.min(r.width, at.x)), y1: Math.max(0, Math.min(r.height, at.y)) };
      setMarquee(m);
      hit(m);
    };
    const up = () => {
      setMarquee(undefined);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  /** The main cut nearest a pointer x, within CUT_DROP_PX. */
  const cutNear = (clientX: number) => {
    const f = frameAt(clientX);
    let best: (typeof cuts)[number] | undefined;
    for (const c of cuts) if (Math.abs(c.frame - f) * ppf <= CUT_DROP_PX && (!best || Math.abs(c.frame - f) < Math.abs(best.frame - f))) best = c;
    return best;
  };
  // A transition tile dragged with the pointer (F16, D154): the cut under it while it's over the
  // lanes, and on release over them, the transition goes there.
  const tilePointer = useTilePointer();
  const overLanes = (x: number, y: number) => {
    const r = lanesRef.current?.getBoundingClientRect();
    const body = bodyRef.current?.getBoundingClientRect();
    return !!r && !!body && x >= Math.max(r.left, body.left + HEAD_WIDTH) && x <= Math.min(r.right, body.right) && y >= body.top && y <= body.bottom;
  };
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
  /** The timeline item under a pointer (an Effects tile dropped there goes on it, D136). */
  const itemAt = (x: number, y: number) => document.elementsFromPoint(x, y).find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.testid === "timeline-item")?.dataset.item;
  const onDragOver = (e: React.DragEvent) => {
    const types = [...e.dataTransfer.types];
    if (online && types.includes(EFFECT_DRAG_TYPE)) {
      if (!itemAt(e.clientX, e.clientY)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      return;
    }
    if (online && types.includes(TRANSITION_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      const over = cutNear(e.clientX)?.item.id;
      if (over !== dropCut) setDropCut(over);
      return;
    }
    if (!online || ![MEDIA_DRAG_TYPE, COMPONENT_DRAG_TYPE, TEXT_DRAG_TYPE].some((t) => types.includes(t)) && !hasFiles(types)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropping(true);
    const lane = types.includes(MEDIA_DRAG_TYPE) || hasFiles(types) ? laneHit(e.clientY).track?.id : undefined;
    if (lane !== dropLane) setDropLane(lane);
    const tile = types.includes(TEXT_DRAG_TYPE) ? 3 : types.includes(COMPONENT_DRAG_TYPE) ? secondsFor(draggedComponent() ?? "") : undefined;
    const span = tile === undefined ? undefined : { frame: Math.max(0, Math.round(frameAt(e.clientX))), frames: tile * fps };
    if (span?.frame !== dropSpan?.frame || span?.frames !== dropSpan?.frames) setDropSpan(span);
  };
  const onDrop = (e: React.DragEvent) => {
    setDropping(false);
    setDropLane(undefined);
    setDropSpan(undefined);
    setDraggedText(undefined);
    const effect = e.dataTransfer.getData(EFFECT_DRAG_TYPE);
    if (effect) {
      e.preventDefault();
      setDraggedEffect(undefined);
      const id = itemAt(e.clientX, e.clientY);
      if (id) void actions.applyFx(effect, id);
      return;
    }
    const module = e.dataTransfer.getData(TRANSITION_DRAG_TYPE);
    if (module) {
      e.preventDefault();
      const cut = cutNear(e.clientX);
      setDropCut(undefined);
      setDraggedTransition(undefined);
      if (cut) void actions.applyTransition(module, { cut: cut.item.id });
      return;
    }
    const frame = Math.max(0, Math.round(frameAt(e.clientX)));
    // A Text tab preset (D80): added at the time it's dropped on.
    const preset = textPresets().find((p) => p.id === e.dataTransfer.getData(TEXT_DRAG_TYPE));
    if (preset) {
      e.preventDefault();
      void actions.addText(preset, { frame });
      return;
    }
    // A component from Elements (D76): added at the time it's dropped on.
    const component = e.dataTransfer.getData(COMPONENT_DRAG_TYPE) || ([...e.dataTransfer.types].includes(COMPONENT_DRAG_TYPE) ? draggedComponent() : undefined);
    if (component) {
      e.preventDefault();
      setDraggedComponent(undefined);
      void actions.addComponent(component, { frame });
      return;
    }
    const track = laneHit(e.clientY).track?.id;
    // A media tile (T1, D122): on the lane it's dropped on, at that frame.
    const id = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (id) {
      e.preventDefault();
      void actions.dropMedia(id, { frame, track });
      return;
    }
    // Files from Finder (T9, D128): imported (uploaded first when the project is remote) and put
    // there in the import's own edit.
    const files = [...e.dataTransfer.files];
    if (files.length) {
      e.preventDefault();
      if (isRemote()) void actions.uploadAndImport(files, { frame, track });
      else {
        const paths = files.map((f) => bridge.pathForFile(f)).filter((p) => p.startsWith("/"));
        void actions.importMedia(paths, { frame, track });
      }
    }
  };

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
        <button className="icon-btn" data-testid="split" title="Split at the playhead (S)" disabled={!online || empty} onClick={() => void actions.split()}>
          <Scissors />
        </button>
        <button
          className="icon-btn"
          data-testid="delete-item"
          title={selectedCut ? "Remove the selected transition (⌫)" : "Delete the selected item (⌫)"}
          disabled={!online || !(selected || (selectedCut && findItem(project, selectedCut)?.item.transitionIn))}
          onClick={() => void actions.deleteSelected()}
        >
          <Trash2 />
        </button>
        <button
          className={`icon-btn ${snapping ? "on" : ""}`}
          data-testid="snap-toggle"
          aria-pressed={snapping}
          title={snapping ? "Snapping on (hold ⌘ while dragging to skip)" : "Snapping off"}
          onClick={playback.toggleSnapping}
        >
          <Magnet />
        </button>
        <button
          className={`icon-btn ${linkOverlays ? "on" : ""}`}
          data-testid="link-overlays"
          aria-pressed={linkOverlays}
          title={linkOverlays ? "Overlays follow the footage under them when a main clip's speed or length changes" : "Overlays stay put when main clips change"}
          onClick={playback.toggleLinkOverlays}
        >
          <Link2 />
        </button>
        <div className="toolbar-sep" />
        <button className="icon-btn" data-testid="zoom-out" title="Zoom out (⌘−)" onClick={playback.zoomOut}>
          <ZoomOut />
        </button>
        <button className="icon-btn" data-testid="zoom-in" title="Zoom in (⌘+)" onClick={playback.zoomIn}>
          <ZoomIn />
        </button>
        <button className="icon-btn" data-testid="zoom-fit" title="Fit the project (⌘0)" onClick={playback.zoomFit}>
          <ChevronsLeftRight />
        </button>
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
            className={`tl-lanes ${dropping ? "dropping" : ""}`}
            data-testid="lanes"
            ref={lanesRef}
            style={{ width }}
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

/**
 * U6 (D185): the items an agent edit just added or changed, for a moment. An edit is the agent's
 * when the running turn lists its revision; the snapshot and the agent state come separately, in
 * either order, so each arrival checks the latest diff.
 */
function useAgentFlash(project: ProjectModel, revision: number | undefined, agent: ReturnType<typeof useApp>["agent"]): ReadonlySet<string> {
  const [flash, setFlash] = useState<ReadonlySet<string>>(() => new Set());
  const seen = useRef<Map<string, string> | undefined>(undefined);
  const diff = useRef<{ revision: number; ids: Array<string>; shown: boolean } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const turn = agent?.running ? agent.turns.find((t) => t.id === agent.running) : undefined;
  const revisions = turn ? turn.edits.map((e) => e.revision).join(",") : "";
  useEffect(() => {
    const now = new Map(project.tracks.flatMap((t) => t.items.map((i) => [i.id, JSON.stringify(i)] as const)));
    const before = seen.current;
    seen.current = now;
    if (before && revision !== undefined) diff.current = { revision, ids: [...now].filter(([id, json]) => before.get(id) !== json).map(([id]) => id), shown: false };
  }, [project, revision]);
  useEffect(() => {
    const d = diff.current;
    if (!d || d.shown || !d.ids.length || !revisions.split(",").includes(String(d.revision))) return;
    d.shown = true;
    setFlash(new Set(d.ids));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash(new Set()), 1800);
  }, [revisions, revision]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return flash;
}
