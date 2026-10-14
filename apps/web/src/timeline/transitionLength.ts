// The length a transition gets when it's put on a cut from the Transitions panel or dropped on one
// (D133): each transition's own default, or one length for all, remembered on this Mac.
import { useSyncExternalStore } from "react";

/** The choices: undefined is each transition's default. */
export const TRANSITION_LENGTHS: ReadonlyArray<number | undefined> = [undefined, 0.25, 0.5, 1, 1.5];
const KEY = "uncut.transitionSeconds";
const listeners = new Set<() => void>();

const read = (): number | undefined => {
  try {
    const n = Number(localStorage.getItem(KEY));
    return TRANSITION_LENGTHS.includes(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
};
let current = read();

export const transitionSeconds = () => current;
export function setTransitionSeconds(seconds: number | undefined) {
  current = seconds;
  try {
    if (seconds === undefined) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(seconds));
  } catch {}
  for (const l of listeners) l();
}
export const useTransitionSeconds = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
