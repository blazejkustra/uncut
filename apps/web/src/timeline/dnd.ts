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
