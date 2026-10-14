// D202: the agent never takes the playhead from someone watching. A ui_show (D65, D185) moves the
// playhead and selects only when "Follow agent" is on and the user is idle: not playing, not
// holding the pointer down on the preview or timeline (scrubbing, dragging) and no input there
// (or a transport key) for IDLE_MS. Otherwise it becomes a pill ("Agent changed 0:12–0:18") the user can click to jump.
// "Follow agent" is remembered on this Mac once the user flips it; until then it is on unless
// playback runs (which the idle rule already honours).

/** How long after the user's last input on the preview or timeline the agent may steer again. */
export const IDLE_MS = 3000;
const FOLLOW_KEY = "uncut.agent.follow";

/** The saved choice: true, false, or undefined (never flipped: on unless playing). */
export function savedFollow(): boolean | undefined {
  try {
    const v = globalThis.localStorage?.getItem(FOLLOW_KEY);
    return v === "on" ? true : v === "off" ? false : undefined;
  } catch {
    return undefined;
  }
}
export function saveFollow(on: boolean) {
  try {
    globalThis.localStorage?.setItem(FOLLOW_KEY, on ? "on" : "off");
  } catch {}
}

/** What the toggle shows: the saved choice, else on unless playing. */
export const followShown = (saved: boolean | undefined, playing: boolean) => saved ?? !playing;

/** Whether a ui_show may move the playhead and select now. */
export function mayFollow(input: { readonly saved: boolean | undefined; readonly playing: boolean; readonly pointerDown: boolean; readonly sinceInput: number }): boolean {
  if (!followShown(input.saved, input.playing)) return false;
  return !input.playing && !input.pointerDown && input.sinceInput >= IDLE_MS;
}

interface TimedItem {
  readonly id: string;
  readonly start: number;
  readonly duration: number;
}

/**
 * The stretch an agent ui_show points at, in frames: the selected item's span; else the items that
 * start at its frame (a scene, D185), to the latest end among them; else just the frame.
 */
export function changeRange(tracks: ReadonlyArray<{ readonly items: ReadonlyArray<TimedItem> }>, ui: { readonly frame?: number | undefined; readonly select?: string | undefined }): { from: number; to: number } | undefined {
  const items = tracks.flatMap((t) => t.items);
  const picked = ui.select !== undefined ? items.find((i) => i.id === ui.select) : undefined;
  if (picked) return { from: ui.frame ?? picked.start, to: Math.max(picked.start + picked.duration, ui.frame ?? 0) };
  if (ui.frame === undefined) return undefined;
  const starting = items.filter((i) => i.start === ui.frame);
  return { from: ui.frame, to: starting.length ? Math.max(...starting.map((i) => i.start + i.duration)) : ui.frame };
}

/** m:ss of a frame (whole seconds). */
const clockOf = (frame: number, fps: number) => {
  const s = Math.floor(Math.max(0, frame) / fps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
/** The pill's words: "Agent changed 0:12–0:18", or "Agent changed 0:12" for one moment. */
export function changeLabel(range: { from: number; to: number }, fps: number): string {
  const a = clockOf(range.from, fps);
  const b = clockOf(range.to, fps);
  return a === b ? `Agent changed ${a}` : `Agent changed ${a}–${b}`;
}

// The user's last input on the preview or the timeline (or a transport key), and whether a
// pointer is held down there now (scrubbing, dragging). Clicks elsewhere (the Agent tab, the rail,
// the Inspector) aren't watching.
let lastInput = -Infinity;
let pointerDown = false;
const WATCHING = ".stage, section.bottom";
const TRANSPORT_KEYS = new Set([" ", "ArrowLeft", "ArrowRight", "Home", "End", "j", "k", "l", "J", "K", "L"]);
const onWatched = (e: Event) => e.target instanceof Element && !!e.target.closest(WATCHING);
const typing = (e: Event) => e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));

/** Watches the user's input (once, at start). */
export function watchInput() {
  window.addEventListener("pointerdown", (e) => {
    if (!onWatched(e)) return;
    pointerDown = true;
    lastInput = performance.now();
  }, true);
  const up = () => {
    if (pointerDown) lastInput = performance.now();
    pointerDown = false;
  };
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  window.addEventListener("wheel", (e) => void (onWatched(e) && (lastInput = performance.now())), { capture: true, passive: true });
  window.addEventListener("keydown", (e) => void (!typing(e) && !e.metaKey && !e.ctrlKey && TRANSPORT_KEYS.has(e.key) && (lastInput = performance.now())), true);
}
export const inputNow = () => ({ pointerDown, sinceInput: performance.now() - lastInput });
