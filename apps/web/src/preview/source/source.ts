// The source viewer (D311, as in Final Cut and Premiere): a library item opened in the preview on
// its own, with its own play head and In/Out marks, apart from the timeline. Space over a media tile
// opens it there and plays it (again: pause or play); a double click on the tile opens it. Esc, the
// back button, a press on the timeline or the timeline starting to play shows the timeline again.
// Space anywhere else is the timeline's, as before. Times here are seconds of the media file.
import { useSyncExternalStore } from "react";

import type { MediaRange } from "@uncut/core/arrange";
import type { ActionId } from "../../editor/keymap.ts";
import { getPlayback, playback } from "../playback.ts";

export interface SourceState {
  /** The media open in the viewer. */
  readonly media: string | undefined;
  readonly playing: boolean;
  readonly time: number;
  /** The file's length, once known (the element's, else the probe's). */
  readonly duration: number;
  readonly markIn: number | undefined;
  readonly markOut: number | undefined;
  /** Bumped by a seek the element must follow (a playing element's own time isn't one). */
  readonly seek: number;
  /** The media tile under the pointer. */
  readonly hovered: string | undefined;
  /** The pointer is over the viewer. */
  readonly over: boolean;
}

const CLOSED = { media: undefined, playing: false, time: 0, duration: 0, markIn: undefined, markOut: undefined } as const;
let state: SourceState = { ...CLOSED, seek: 0, hovered: undefined, over: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<SourceState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l();
};
const subscribe = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener));

export const getSource = () => state;
export const useSource = <T>(select: (s: SourceState) => T): T => useSyncExternalStore(subscribe, () => select(state));

/** Play at the end of the file starts it again (an element's ended time can be a hair short of its duration). */
const END_SLACK = 0.05;
const clampTime = (t: number) => Math.max(0, state.duration > 0 ? Math.min(state.duration, t) : t);

export const source = {
  subscribe,
  /** Opens `media` at its start (the timeline pauses); with `play`, plays it. */
  open(media: string, play = false) {
    if (getPlayback().playing) playback.pause();
    playback.hoverMedia(undefined);
    if (media !== state.media) set({ ...CLOSED, media, seek: state.seek + 1 });
    set({ playing: play });
  },
  close() {
    if (state.media !== undefined) set({ ...CLOSED, over: false });
  },
  play() {
    if (state.media === undefined) return;
    if (state.duration > 0 && state.time >= state.duration - END_SLACK) source.seek(0);
    set({ playing: true });
  },
  pause() {
    if (state.playing) set({ playing: false });
  },
  toggle: () => (state.playing ? source.pause() : source.play()),
  seek(t: number) {
    if (state.media !== undefined) set({ time: clampTime(t), seek: state.seek + 1 });
  },
  step: (seconds: number) => source.seek(state.time + seconds),
  /** Where the element is while it plays. */
  playedTo(t: number) {
    if (t !== state.time) set({ time: t });
  },
  ended() {
    set({ playing: false });
  },
  setDuration(d: number) {
    if (Number.isFinite(d) && d > 0 && d !== state.duration) set({ duration: d });
  },
  /** I or O: a mark at the play head; an In after the Out (or the other way round) drops the other. */
  mark(which: "in" | "out") {
    if (state.media === undefined) return;
    const t = state.time;
    if (which === "in") set({ markIn: t, markOut: state.markOut !== undefined && state.markOut <= t ? undefined : state.markOut });
    else set({ markOut: t, markIn: state.markIn !== undefined && state.markIn >= t ? undefined : state.markIn });
  },
  clearMarks() {
    set({ markIn: undefined, markOut: undefined });
  },
  hoverTile(media: string | undefined) {
    if (media !== state.hovered) set({ hovered: media });
  },
  pointerOver(over: boolean) {
    if (over !== state.over) set({ over });
  },
};

/** The timeline started playing (Space elsewhere, the menu, the agent): it's what the preview shows again. */
playback.subscribe(() => {
  if (getPlayback().playing && state.media !== undefined) source.close();
});

/**
 * In to Out (or the whole file around a single mark) in project frames, for the timeline; undefined
 * with no marks, or when nothing is left between them.
 */
export function markedRange(s: Pick<SourceState, "markIn" | "markOut" | "duration">, fps: number, frames: number | undefined): MediaRange | undefined {
  if (s.markIn === undefined && s.markOut === undefined) return undefined;
  const total = frames ?? Math.floor(s.duration * fps);
  const from = Math.min(total, Math.max(0, Math.round((s.markIn ?? 0) * fps)));
  const to = s.markOut === undefined ? total : Math.min(total, Math.round(s.markOut * fps));
  return to > from ? { in: from, duration: to - from } : undefined;
}

/**
 * A key the source viewer takes, run; false leaves it to the timeline. Space over a tile opens or
 * plays it, over the open viewer plays or pauses it; the rest only while a media is open.
 */
export function sourceKey(action: ActionId, fps: number): boolean {
  const { hovered, media, over } = state;
  if (action === "play") {
    if (hovered !== undefined && hovered !== media) source.open(hovered, true);
    else if (hovered !== undefined || (media !== undefined && over)) source.toggle();
    else return false;
    return true;
  }
  if (media === undefined) return false;
  switch (action) {
    case "pause":
      return (source.pause(), true);
    case "markIn":
      return (source.mark("in"), true);
    case "markOut":
      return (source.mark("out"), true);
    case "frameBack":
      return (source.pause(), source.step(-1 / fps), true);
    case "frameForward":
      return (source.pause(), source.step(1 / fps), true);
    case "toStart":
      return (source.seek(0), true);
    case "toEnd":
      return (source.seek(state.duration), true);
    case "deselect":
      return (source.close(), true);
    default:
      return false;
  }
}
