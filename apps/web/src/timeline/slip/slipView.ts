// The slip view: a double click on a clip or a sound opens its whole media as a strip, with the part
// the item plays as a window of fixed length on it. Dragging the window, a click elsewhere on the
// strip (the window jumps there, centred) or ← / → (one frame, held: repeats) pick other frames for
// the same place on the timeline. It is one session: ⌘Z / ⇧⌘Z step through its moves, Esc or
// Cancel leaves the item as it was, Done (↩) sends one slip_item, so ⌘Z on the timeline undoes it
// whole. The limits are the Slip tool's (slipRoll.ts slipLimits): when the item can't slip (locked,
// offline, it already plays all its media) the view still opens, read only, and says why.
// Frames here are project frames; "media frames" are frames of the file from its start.
import { inShift, localForSource, sourceSpan } from "@uncut/core/speedRamp";
import { useSyncExternalStore } from "react";

import type { Item, MediaItem, ProjectModel } from "../../state/project.ts";
import { findItem } from "../edit/base.ts";
import { slipLimits } from "../edit/slipRoll.ts";

export interface SlipSubject {
  readonly item: Item;
  readonly media: MediaItem;
  /** The media's length. */
  readonly total: number;
  /** The media frame the item starts at now. */
  readonly from: number;
  /** Media frames the item plays: the window's length on the strip. */
  readonly span: number;
  /** How far the item can slip, in its own frames (lo ≤ 0 ≤ hi), kept to windows that start inside the media. */
  readonly lo: number;
  readonly hi: number;
  /** Why it can't slip: the view shows the window but nothing moves it. */
  readonly readOnly?: string;
}

/** What the slip view shows for `itemId`, or undefined when a double click on it isn't the slip view's (a still, a graphic, unknown length). */
export function slipSubject(project: ProjectModel, itemId: string, online: boolean): SlipSubject | undefined {
  const placed = findItem(project, itemId);
  if (!placed) return undefined;
  const { item } = placed;
  if ((item.type !== "clip" && item.type !== "audio") || !item.media) return undefined;
  const media = project.media.find((m) => m.id === item.media);
  const total = media?.probe?.frames;
  if (!media || (media.kind !== "video" && media.kind !== "audio") || !total) return undefined;
  const from = item.in ?? 0;
  const span = sourceSpan(item);
  const limits = slipLimits(project, itemId);
  // A looping or held item has no end to run out of: its window still starts inside the media.
  const inside = Math.floor(localForSource(item, total - 1 - from));
  const lo = "problem" in limits ? 0 : limits.lo;
  const hi = "problem" in limits ? 0 : Math.max(0, Math.min(limits.hi, inside));
  const readOnly = !online ? "Uncut isn't connected: slipping needs it." : "problem" in limits ? limits.problem : undefined;
  return { item, media, total, from, span, lo, hi, ...(readOnly ? { readOnly } : {}) };
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** The media frame the window starts at after slipping `offset` of the item's frames. */
export const windowStart = (s: SlipSubject, offset: number) => s.from + inShift(s.item, offset);

/** ← / →: the window a frame (of the item's) earlier or later, within its limits. */
export const nudged = (s: SlipSubject, offset: number, by: number) => clamp(offset + by, s.lo, s.hi);

/** The slip (the item's frames, within its limits) that starts the window nearest media frame `start`. */
export const offsetFor = (s: SlipSubject, start: number) => clamp(Math.round(localForSource(s.item, start - s.from)), s.lo, s.hi);

// ---- The strip: `visible` media frames across its `width` px, scrolled natively. ----

/** The strip opens showing this many times the window's length (all of the media when it's shorter). */
export const OPEN_SPAN = 20;
/** Zoomed in, at least this many frames show (or the window and a bit either side). */
const MIN_FRAMES = 10;
/** The strip's content never gets wider than this (a browser draws nothing past ~16M px). */
const MAX_STRIP_PX = 4_000_000;

/** The fewest media frames the strip shows across `width` px. */
export const minVisible = (s: SlipSubject, width: number) => Math.min(s.total, Math.max(MIN_FRAMES, s.span * 1.25, (s.total * width) / MAX_STRIP_PX));

export const clampVisible = (s: SlipSubject, visible: number, width: number) => clamp(visible, minVisible(s, width), s.total);

/** How much of the media the strip shows when it opens. */
export const openVisible = (s: SlipSubject, width: number) => clampVisible(s, s.span * OPEN_SPAN, width);

/** The scroll (px) that puts media frame `frame` at `x` px from the strip's left edge. */
export const scrollFor = (s: SlipSubject, frame: number, x: number, visible: number, width: number) =>
  clamp(frame * (width / visible) - x, 0, Math.max(0, s.total * (width / visible) - width));

/** The scroll that centres the window starting at media frame `start`. */
export const centredScroll = (s: SlipSubject, start: number, visible: number, width: number) => scrollFor(s, start + s.span / 2, width / 2, visible, width);

/** The scroll that keeps the window from `left` to `right` px in view (with a margin), or `scroll` when it is. */
export function keepInView(scroll: number, left: number, right: number, width: number, margin = 24): number {
  if (right - left > width - 2 * margin) return Math.max(0, left - margin);
  if (left < scroll + margin) return Math.max(0, left - margin);
  if (right > scroll + width - margin) return right - width + margin;
  return scroll;
}

/** Where a press at media frame `at` puts the window: grabbed where it was pressed, or (outside it) jumped there, centred. */
export function pressOn(s: SlipSubject, offset: number, at: number): { readonly offset: number; readonly grab: number } {
  const start = windowStart(s, offset);
  if (at >= start && at <= start + s.span) return { offset, grab: at - start };
  const jumped = offsetFor(s, at - s.span / 2);
  return { offset: jumped, grab: at - windowStart(s, jumped) };
}

// ---- The session: the item, where its window is, and the moves made since it opened. ----

export interface SlipSession {
  readonly itemId: string | undefined;
  /** The slip so far, in the item's frames (0: as it is on the timeline). */
  readonly offset: number;
  readonly past: ReadonlyArray<number>;
  readonly future: ReadonlyArray<number>;
  /** The project's revision and folder when it opened: Done is refused if the agent changed it since. */
  readonly baseRevision: number | undefined;
  readonly dir: string | undefined;
  /** A drag in progress began at this offset (one step of ⌘Z, however far it went). */
  readonly gesture: number | undefined;
}

const CLOSED: SlipSession = { itemId: undefined, offset: 0, past: [], future: [], baseRevision: undefined, dir: undefined, gesture: undefined };
let state = CLOSED;
const listeners = new Set<() => void>();
const set = (next: SlipSession) => {
  state = next;
  for (const l of listeners) l();
};
const subscribe = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener));

export const getSlip = () => state;
export const slipOpen = () => state.itemId !== undefined;
export const useSlip = <T>(select: (s: SlipSession) => T): T => useSyncExternalStore(subscribe, () => select(state));

export const slip = {
  subscribe,
  open(itemId: string, origin: { readonly baseRevision?: number | undefined; readonly dir?: string | undefined } = {}) {
    set({ ...CLOSED, itemId, baseRevision: origin.baseRevision, dir: origin.dir });
  },
  close() {
    if (state.itemId !== undefined) set(CLOSED);
  },
  /** Moves the window to `offset` as one step of ⌘Z (or, during a drag, as part of the drag's step). */
  move(offset: number) {
    if (state.itemId === undefined || offset === state.offset) return;
    if (state.gesture !== undefined) return set({ ...state, offset });
    set({ ...state, offset, past: [...state.past, state.offset], future: [] });
  },
  /** A drag starts: its moves undo together. */
  begin() {
    if (state.itemId !== undefined) set({ ...state, gesture: state.offset });
  },
  /** The drag ends: one step back to where it began, unless it ended there. */
  end() {
    const from = state.gesture;
    if (from === undefined) return;
    set({ ...state, gesture: undefined, ...(from !== state.offset ? { past: [...state.past, from], future: [] } : {}) });
  },
  undo() {
    const back = state.past.at(-1);
    if (back === undefined || state.gesture !== undefined) return;
    set({ ...state, offset: back, past: state.past.slice(0, -1), future: [...state.future, state.offset] });
  },
  redo() {
    const ahead = state.future.at(-1);
    if (ahead === undefined || state.gesture !== undefined) return;
    set({ ...state, offset: ahead, future: state.future.slice(0, -1), past: [...state.past, state.offset] });
  },
};
