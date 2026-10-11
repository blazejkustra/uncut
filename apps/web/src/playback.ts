// The playhead, the playback clock and the timeline's view state (selection, zoom). Kept out of
// the app store on purpose: during playback the frame changes 60 times a second, and only the
// preview, the timecode and the playhead line should hear about it, not every panel.
//
// Frame f is the moment f / fps (D38). The wall clock drives playback, so a project with no
// media (titles only) plays too. While a video is on screen the clock follows it: if decoding
// starts late, the clock is re-anchored to the video instead of seeking the video (from the
// phase 2 spike).
import { useSyncExternalStore } from "react";

export interface PlaybackState {
  /** Fractional while playing; whole frames when paused. */
  readonly frame: number;
  readonly playing: boolean;
  /** Frames the playhead can be on: [0, frames - 1]. */
  readonly frames: number;
  readonly fps: number;
  readonly selected: string | undefined;
  /** Timeline zoom as a multiple of "fit the whole project". */
  readonly zoom: number;
}

let state: PlaybackState = { frame: 0, playing: false, frames: 1, fps: 30, selected: undefined, zoom: 1 };
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
const ZOOM_MIN = 1 / 8;
const ZOOM_MAX = 400;

// While playing: the frame at wall-clock time t0, and the video follower (registered by the
// preview) that tells where the top visible video actually is.
let clock = { f0: 0, t0: 0 };
let raf = 0;
let follower: ((frame: number) => number | undefined) | undefined;

function tick(now: number) {
  if (!state.playing) return;
  let f = clock.f0 + ((now - clock.t0) * state.fps) / 1000;
  const videoFrame = follower?.(f);
  if (videoFrame !== undefined && Math.abs(videoFrame - f) > 2) {
    clock = { f0: videoFrame, t0: now };
    f = videoFrame;
  }
  if (f >= state.frames - 1) {
    set({ frame: state.frames - 1, playing: false });
    return;
  }
  set({ frame: f });
  raf = requestAnimationFrame(tick);
}

export const playback = {
  subscribe,

  /** The open project changed: the playhead stays where it is unless the project got shorter. */
  setProject(frames: number, fps: number) {
    if (frames === state.frames && fps === state.fps) return;
    const last = frames - 1;
    if (state.playing && state.frame >= last) {
      cancelAnimationFrame(raf);
      set({ frames, fps, frame: last, playing: false });
    } else set({ frames, fps, frame: clamp(state.frame, 0, last) });
  },

  /** Another project opened: back to the start, nothing selected, fit zoom. */
  reset() {
    cancelAnimationFrame(raf);
    set({ frame: 0, playing: false, selected: undefined, zoom: 1 });
  },

  play() {
    if (state.playing) return;
    // At the end, play starts over.
    const frame = state.frame >= state.frames - 1 ? 0 : state.frame;
    clock = { f0: frame, t0: performance.now() };
    set({ frame, playing: true });
    raf = requestAnimationFrame(tick);
  },

  pause() {
    if (!state.playing) return;
    cancelAnimationFrame(raf);
    set({ playing: false, frame: Math.floor(state.frame) });
  },

  toggle: () => (state.playing ? playback.pause() : playback.play()),

  /** Move the playhead (whole frames). While playing, playback carries on from there. */
  seek(frame: number) {
    const f = clamp(Math.round(frame), 0, state.frames - 1);
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
  toEnd() {
    playback.pause();
    playback.seek(state.frames - 1);
  },

  /** The preview's video follower; undefined unregisters. */
  setFollower(fn: ((frame: number) => number | undefined) | undefined) {
    follower = fn;
  },

  select: (id: string | undefined) => (id === state.selected ? undefined : set({ selected: id })),

  zoomIn: () => set({ zoom: clamp(state.zoom * 1.5, ZOOM_MIN, ZOOM_MAX) }),
  zoomOut: () => set({ zoom: clamp(state.zoom / 1.5, ZOOM_MIN, ZOOM_MAX) }),
  zoomFit: () => set({ zoom: 1 }),
};
