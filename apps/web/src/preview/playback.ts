// The playhead, the playback clock and the timeline's view state (selection, zoom). Kept out of
// the app store on purpose: during playback the frame changes 60 times a second, and only the
// preview, the timecode and the playhead line should hear about it, not every panel.
//
// Frame f is the moment f / fps (D38). The wall clock drives playback, so a project with no
// media (titles only) plays too. While a video is on screen the clock follows it: if decoding
// starts late, the clock is re-anchored to the video instead of seeking the video (from the
// phase 2 spike).
import { useSyncExternalStore } from "react";

import type { ProjectModel } from "../state/project.ts";

/**
 * A local preview of an edit in progress (a canvas drag, a slider, typing): the project after
 * the planned ops, drawn instead of `base` until the edit is sent. Ignored once the open project
 * is no longer `base` (a newer snapshot arrived), so it can never show a stale project.
 */
export interface PreviewDraft {
  readonly base: ProjectModel;
  readonly project: ProjectModel;
}

export interface PlaybackState {
  /** Fractional while playing; whole frames when paused. */
  readonly frame: number;
  readonly playing: boolean;
  /** Frames of the project: playback runs over [0, frames - 1] and stops on the last frame. */
  readonly frames: number;
  /**
   * Where the last item ends (0 when empty). End and seeking can put the playhead here, one past
   * the last frame (nothing is drawn there), so whatever is added at the playhead goes after
   * everything: an end card after the last clip, not over its last frame.
   */
  readonly end: number;
  readonly fps: number;
  readonly selected: string | undefined;
  /**
   * A selected cut on the main track (D73): the id of the clip after it, whose transitionIn the
   * transition is. Exclusive with `selected`; the Inspector shows the cut's transition.
   */
  readonly cut: string | undefined;
  /** Timeline zoom as a multiple of "fit the whole project". */
  readonly zoom: number;
  /** Moves and trims snap to the playhead, item edges and 0 (hold ⌘ while dragging to skip). */
  readonly snapping: boolean;
  /** F11 (D156): overlays follow the footage under them when a main clip's speed or length changes. */
  readonly linkOverlays: boolean;
  readonly draft: PreviewDraft | undefined;
  /** What the bottom panel shows (D32): the timeline or the mixer (D83). */
  readonly bottom: "timeline" | "mixer";
  /** A selected volume key (D83) of the selected item: its index among the item's keys in frame order. ⌫ removes it. */
  readonly gainKey: number | undefined;
  /**
   * Playback speed and direction (J/K/L, G3): 1 is normal play; 2, 4, 8 faster; negative plays
   * backwards. At any rate but 1 the preview seeks its videos per frame and stays silent.
   */
  readonly rate: number;
  /** In and out points (I/O, G3), frames; drawn on the ruler. */
  readonly markIn: number | undefined;
  readonly markOut: number | undefined;
  /** More items selected along with `selected` (⌘A, G3): deleted, copied and duplicated together. */
  readonly also: ReadonlyArray<string>;
  /**
   * Issue #118 (skimming, as in iMovie): the frame under the pointer while it moves over the
   * timeline, drawn in the preview instead of the playhead's while paused; undefined when the
   * pointer leaves (the playhead's frame is drawn again). The playhead itself doesn't move.
   */
  readonly hover: number | undefined;
  /** Issue #118: a media tile's video skimmed in the preview (its seconds), while the pointer is on its thumbnail. */
  readonly hoverMedia: { readonly media: string; readonly seconds: number } | undefined;
  /** Issue #118: skimming on or off (the timeline toolbar's switch), remembered on this Mac. */
  readonly skimming: boolean;
}

const SNAP_KEY = "uncut.snapping";
const savedSnapping = () => {
  try {
    return globalThis.localStorage?.getItem(SNAP_KEY) !== "off";
  } catch {
    return true;
  }
};
const LINK_KEY = "uncut.linkOverlays";
const savedLink = () => {
  try {
    return globalThis.localStorage?.getItem(LINK_KEY) !== "off";
  } catch {
    return true;
  }
};
const SKIM_KEY = "uncut.skimming";
const savedSkimming = () => {
  try {
    return globalThis.localStorage?.getItem(SKIM_KEY) !== "off";
  } catch {
    return true;
  }
};
let state: PlaybackState = { frame: 0, playing: false, frames: 1, end: 0, fps: 30, selected: undefined, cut: undefined, zoom: 1, snapping: savedSnapping(), linkOverlays: savedLink(), draft: undefined, bottom: "timeline", gainKey: undefined, rate: 1, markIn: undefined, markOut: undefined, also: [], hover: undefined, hoverMedia: undefined, skimming: savedSkimming() };
const listeners = new Set<() => void>();
const set = (patch: Partial<PlaybackState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};
const subscribe = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener));

/** A slice of the playback state; re-renders only when the selected value changes. */
export const usePlayback = <T>(select: (s: PlaybackState) => T): T => useSyncExternalStore(subscribe, () => select(state));
export const getPlayback = () => state;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** The furthest the playhead can go: the end of the project (or its only frame when empty). */
const lastPosition = (s: { frames: number; end: number }) => Math.max(s.frames - 1, s.end);
const ZOOM_MIN = 1 / 8;
const ZOOM_MAX = 400;

// While playing: the frame at wall-clock time t0, and the video follower (registered by the
// preview) that tells where the top visible video actually is.
let clock = { f0: 0, t0: 0 };
let raf = 0;
let follower: ((frame: number) => number | undefined) | undefined;

function tick(now: number) {
  if (!state.playing) return;
  // A rAF timestamp is the frame's start, which can be a little before the performance.now()
  // taken in play(); never step back before where playback started.
  let f = clock.f0 + (Math.max(0, now - clock.t0) * state.fps * state.rate) / 1000;
  if (f <= 0 && state.rate < 0) {
    set({ frame: 0, playing: false, rate: 1 });
    return;
  }
  const videoFrame = state.rate === 1 ? follower?.(f) : undefined;
  if (videoFrame !== undefined && Math.abs(videoFrame - f) > 2) {
    clock = { f0: videoFrame, t0: now };
    f = videoFrame;
  }
  if (f >= state.frames - 1) {
    set({ frame: state.frames - 1, playing: false, rate: 1 });
    return;
  }
  set({ frame: f });
  raf = requestAnimationFrame(tick);
}

export const playback = {
  subscribe,

  /**
   * The open project changed: the playhead stays where it is unless the project got shorter than
   * that; then it goes to the new end (so deleting an end card at the end leaves the playhead
   * where the next one goes).
   */
  setProject(frames: number, fps: number, end: number) {
    if (frames === state.frames && fps === state.fps && end === state.end) return;
    const last = frames - 1;
    if (state.playing && state.frame >= last) {
      cancelAnimationFrame(raf);
      set({ frames, end, fps, frame: last, playing: false });
    } else set({ frames, end, fps, frame: clamp(state.frame, 0, lastPosition({ frames, end })) });
  },

  /** Another project opened: back to the start, nothing selected, fit zoom. */
  reset() {
    cancelAnimationFrame(raf);
    set({ frame: 0, playing: false, selected: undefined, cut: undefined, gainKey: undefined, zoom: 1, draft: undefined, rate: 1, markIn: undefined, markOut: undefined, also: [], hover: undefined, hoverMedia: undefined });
  },

  play(rate = 1) {
    if (state.playing && state.rate === rate) return;
    if (state.playing) {
      // A new speed (J/L pressed again): carry on from here.
      clock = { f0: state.frame, t0: performance.now() };
      return set({ rate });
    }
    // At the end, play starts over (backwards: from the end).
    const frame = rate > 0 && state.frame >= state.frames - 1 ? 0 : rate < 0 && state.frame <= 0 ? lastPosition(state) : state.frame;
    clock = { f0: frame, t0: performance.now() };
    set({ frame, playing: true, rate, hover: undefined, hoverMedia: undefined });
    raf = requestAnimationFrame(tick);
  },

  pause() {
    if (!state.playing) return;
    cancelAnimationFrame(raf);
    set({ playing: false, frame: Math.floor(state.frame), rate: 1 });
  },

  /** L: play forward, faster with each press (1, 2, 4, 8×); J the same backwards. K pauses. */
  shuttle(direction: 1 | -1) {
    const r = state.playing ? state.rate : 0;
    const next = Math.sign(r) === direction ? Math.min(8, Math.abs(r) * 2) * direction : direction;
    playback.play(next);
  },
  setMark(which: "in" | "out", frame: number | undefined) {
    set(which === "in" ? { markIn: frame } : { markOut: frame });
  },
  /** Select several items at once: the first is the one the Inspector shows. */
  selectMany(ids: ReadonlyArray<string>) {
    set({ selected: ids[0], also: ids.slice(1), cut: undefined, gainKey: undefined });
  },

  /** Issue #118: play from the skimmed frame (Space while the pointer is on the timeline) or the playhead. */
  toggle: () => (state.playing ? playback.pause() : state.hover !== undefined ? playback.playFrom(state.hover) : playback.play()),

  /** Issue #118: the playhead to `frame`, then play from there ("Play from here", Space while skimming). */
  playFrom(frame: number) {
    playback.pause();
    playback.seek(frame);
    // At the very end there's nothing left to play: from the start, as Play does.
    playback.play();
  },

  /** Move the playhead (whole frames). While playing, playback carries on from there. */
  seek(frame: number) {
    const f = clamp(Math.round(frame), 0, lastPosition(state));
    if (state.playing) clock = { f0: f, t0: performance.now() };
    set({ frame: f });
  },

  step(frames: number) {
    playback.pause();
    playback.seek(Math.floor(state.frame) + frames);
  },
  toStart() {
    playback.pause();
    playback.seek(0);
  },
  /** To the end of the project, after its last frame (where an end card goes). */
  toEnd() {
    playback.pause();
    playback.seek(state.end);
  },

  /** The preview's video follower; undefined unregisters. */
  setFollower(fn: ((frame: number) => number | undefined) | undefined) {
    follower = fn;
  },

  select: (id: string | undefined) => (id === state.selected && state.cut === undefined && state.gainKey === undefined && !state.also.length ? undefined : set({ selected: id, cut: undefined, gainKey: undefined, also: [] })),
  /** Select the cut before main item `id` (its transition, if it has one); undefined clears it. */
  selectCut: (id: string | undefined) => (id === state.cut && state.selected === undefined ? undefined : set({ cut: id, selected: undefined, gainKey: undefined, also: [] })),
  /** Select item `id` and its volume key `index` (in frame order), D83; undefined selects just the item. */
  selectGainKey: (id: string, index: number | undefined) => (id === state.selected && index === state.gainKey && state.cut === undefined ? undefined : set({ selected: id, cut: undefined, gainKey: index, also: [] })),

  zoomIn: () => set({ zoom: clamp(state.zoom * 1.5, ZOOM_MIN, ZOOM_MAX) }),
  zoomOut: () => set({ zoom: clamp(state.zoom / 1.5, ZOOM_MIN, ZOOM_MAX) }),
  zoomFit: () => set({ zoom: 1 }),
  /** T2: the timeline zoom as a value (⌘/pinch wheel), clamped. */
  setZoom: (zoom: number) => set({ zoom: clamp(zoom, ZOOM_MIN, ZOOM_MAX) }),
  /** Snapping on or off; remembered on this Mac (Settings › App shows the same switch, G8). */
  toggleSnapping: () => {
    set({ snapping: !state.snapping });
    try {
      globalThis.localStorage?.setItem(SNAP_KEY, state.snapping ? "on" : "off");
    } catch {}
  },
  /** Overlays follow main-track speed and trim changes, or not (F11, D156); remembered on this Mac. */
  toggleLinkOverlays: () => {
    set({ linkOverlays: !state.linkOverlays });
    try {
      globalThis.localStorage?.setItem(LINK_KEY, state.linkOverlays ? "on" : "off");
    } catch {}
  },
  setBottom: (bottom: PlaybackState["bottom"]) => (bottom === state.bottom ? undefined : set({ bottom })),
  /**
   * Issue #118: skim to `frame` (the pointer over the timeline), or with undefined stop skimming.
   * Ignored while playing or with skimming off; whole frames, within the project.
   */
  hover(frame: number | undefined) {
    const f = frame === undefined || state.playing || !state.skimming ? undefined : clamp(Math.round(frame), 0, lastPosition(state));
    if (f !== state.hover || state.hoverMedia) set({ hover: f, hoverMedia: undefined });
  },
  /** Issue #118: skim a media tile's video at `seconds`, or with undefined stop. */
  hoverMedia(media: string | undefined, seconds = 0) {
    const next = media === undefined || state.playing || !state.skimming ? undefined : { media, seconds };
    if (next?.media === state.hoverMedia?.media && next?.seconds === state.hoverMedia?.seconds) return;
    set({ hoverMedia: next, hover: undefined });
  },
  /** Skimming on or off (issue #118); remembered on this Mac. */
  toggleSkimming: () => {
    set({ skimming: !state.skimming, hover: undefined, hoverMedia: undefined });
    try {
      globalThis.localStorage?.setItem(SKIM_KEY, state.skimming ? "on" : "off");
    } catch {}
  },
  /** Show (or with undefined, stop showing) a local preview of an edit in progress. */
  setDraft: (draft: PreviewDraft | undefined) => (draft === state.draft ? undefined : set({ draft })),
};
