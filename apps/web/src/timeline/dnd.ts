// What can be dragged onto the timeline (split out of Timeline.tsx): media tiles, transition tiles
// (whose module is kept here too: drag data can't be read while dragging over) and, T9, files
// from Finder.
import { useSyncExternalStore } from "react";

/** The drag type a media tile carries when it's dragged onto the timeline. */
export const MEDIA_DRAG_TYPE = "application/x-uncut-media";
/** The drag type a transition tile carries (its module id); the data can't be read while dragging over, so the module is kept here too. */
export const TRANSITION_DRAG_TYPE = "application/x-uncut-transition";
let draggedTransition: string | undefined;
const draggedListeners = new Set<() => void>();
export function setDraggedTransition(module: string | undefined) {
  draggedTransition = module;
  for (const l of draggedListeners) l();
}
export const useDraggedTransition = () =>
  useSyncExternalStore(
    (l) => (draggedListeners.add(l), () => void draggedListeners.delete(l)),
    () => draggedTransition,
  );
/** Within this many pixels of a cut, a dropped transition goes on it. */
export const CUT_DROP_PX = 40;
/** Files dragged in from Finder (T9). */
export const hasFiles = (types: ReadonlyArray<string>) => types.includes("Files");

/**
 * The drag type an Effects tab tile carries (D136): "look:<id>" or "effect:<module>"; kept here too
 * (drag data can't be read while dragging over). Dropped on a clip (timeline or canvas), it goes on it.
 */
export const EFFECT_DRAG_TYPE = "application/x-uncut-effect";
let draggedEffect: string | undefined;
export const setDraggedEffect = (what: string | undefined) => void (draggedEffect = what);
export const getDraggedEffect = () => draggedEffect;

// ---- transition tiles dragged with the pointer (F16, D154) ----
// The tiles aren't HTML5-draggable: a press that moves becomes a pointer drag, so real (and
// synthetic) pointer events drive it the same way. While it runs the pointer is here (the timeline
// shows the cut it would land on and a ghost of the transition there); on release the timeline's
// drop handler puts it on that cut.
let tilePointer: { readonly x: number; readonly y: number } | undefined;
const pointerListeners = new Set<() => void>();
export function setTilePointer(at: { readonly x: number; readonly y: number } | undefined) {
  tilePointer = at;
  for (const l of pointerListeners) l();
}
export const useTilePointer = () =>
  useSyncExternalStore(
    (l) => (pointerListeners.add(l), () => void pointerListeners.delete(l)),
    () => tilePointer,
  );
let transitionDrop: ((module: string, x: number, y: number) => boolean) | undefined;
/** The timeline registers what a release over it does; returns the unregister. */
export function onTransitionDrop(handler: (module: string, x: number, y: number) => boolean) {
  transitionDrop = handler;
  return () => {
    if (transitionDrop === handler) transitionDrop = undefined;
  };
}
/** A tile released at (x, y): true when the timeline took it. */
export const dropTransition = (module: string, x: number, y: number) => transitionDrop?.(module, x, y) ?? false;
