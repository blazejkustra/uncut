// F30 (D174): how long new things are, remembered on this Mac (localStorage, like snapping and the
// panel sizes): a photo, and a text (a background added past the footage, a title card's, too). The transition length is
// timeline/transitionLength.ts's (the Transitions panel's Length chips, the same setting).
import { useSyncExternalStore } from "react";

export type DefaultLength = "still" | "text";
export const DEFAULT_SECONDS: Readonly<Record<DefaultLength, number>> = { still: 5, text: 3 };
/** The range a default can be set to, seconds. */
export const DEFAULT_RANGE = { min: 0.5, max: 60 } as const;
const KEYS: Readonly<Record<DefaultLength, string>> = { still: "uncut.defaults.stillSeconds", text: "uncut.defaults.textSeconds" };

const read = (kind: DefaultLength): number => {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEYS[kind]);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= DEFAULT_RANGE.min && n <= DEFAULT_RANGE.max ? n : DEFAULT_SECONDS[kind];
  } catch {
    return DEFAULT_SECONDS[kind];
  }
};

let current: Readonly<Record<DefaultLength, number>> = { still: read("still"), text: read("text") };
const listeners = new Set<() => void>();

/** The default length in seconds (a photo or card, a text). */
export const defaultSeconds = (kind: DefaultLength) => current[kind];
/** The default length in frames at `fps` (at least one frame). */
export const defaultFrames = (kind: DefaultLength, fps: number) => Math.max(1, Math.round(current[kind] * fps));

export function setDefaultSeconds(kind: DefaultLength, seconds: number | undefined) {
  const value = seconds === undefined ? DEFAULT_SECONDS[kind] : Math.min(DEFAULT_RANGE.max, Math.max(DEFAULT_RANGE.min, seconds));
  current = { ...current, [kind]: value };
  try {
    if (seconds === undefined || value === DEFAULT_SECONDS[kind]) localStorage.removeItem(KEYS[kind]);
    else localStorage.setItem(KEYS[kind], String(value));
  } catch {}
  for (const l of listeners) l();
}

export const useDefaultSeconds = (kind: DefaultLength) =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => current[kind],
  );
