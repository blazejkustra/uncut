// D221: "Frame cache for scrubbing", remembered on this Mac (localStorage, like "Use proxies for
// preview"). On (the default): while paused or shuttling, the preview draws exact frames decoded
// ahead of time (preview/scrub.ts); off, every scrub step seeks the clip's <video> as before.
import { useSyncExternalStore } from "react";

const KEY = "uncut.preview.scrubCache";

const read = () => {
  try {
    return typeof localStorage === "undefined" || localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
};

let on = read();
const listeners = new Set<() => void>();

export const scrubCacheOn = () => on;

export function setScrubCacheOn(value: boolean) {
  on = value;
  try {
    if (value) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {}
  for (const l of listeners) l();
}

export const subscribeScrubCache = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

export const useScrubCacheOn = () => useSyncExternalStore(subscribeScrubCache, scrubCacheOn);
