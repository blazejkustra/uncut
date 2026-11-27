// D348: Follow agent (off by default, not remembered): the timeline scrolls to the cursor that moved last.
import { useSyncExternalStore } from "react";

let following = false;
const listeners = new Set<() => void>();

export const followAgent = {
  get: () => following,
  toggle() {
    following = !following;
    for (const l of listeners) l();
  },
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useFollowAgent = () => useSyncExternalStore(subscribe, followAgent.get);
