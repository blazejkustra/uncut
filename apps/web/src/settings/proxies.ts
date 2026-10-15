// D212: "Use proxies for preview", remembered on this Mac (localStorage, like the default lengths).
// On (the default): the preview plays a media item's proxy once the server has made it; export
// and render_frames always read the original whatever this says.
import { useSyncExternalStore } from "react";

const KEY = "uncut.preview.proxies";

const read = () => {
  try {
    return typeof localStorage === "undefined" || localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
};

let on = read();
const listeners = new Set<() => void>();

export const proxiesOn = () => on;

export function setProxiesOn(value: boolean) {
  on = value;
  try {
    if (value) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {}
  for (const l of listeners) l();
}

export const subscribeProxies = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

export const useProxiesOn = () => useSyncExternalStore(subscribeProxies, proxiesOn);
