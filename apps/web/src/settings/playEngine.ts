// D311: "Decode playback ahead", remembered on this Mac (localStorage, like "Use proxies for
// preview"). On (the default): while playing, the preview draws clips from frames decoded ahead with
// WebCodecs (preview/play/engine.ts); off, every clip plays on its <video>.
import { useSyncExternalStore } from "react";

const KEY = "uncut.preview.playEngine";

const read = () => {
  try {
    return typeof localStorage === "undefined" || localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
};

let on = read();
const listeners = new Set<() => void>();

export const playEngineOn = () => on;

export function setPlayEngineOn(value: boolean) {
  on = value;
  try {
    if (value) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {}
  for (const l of listeners) l();
}

export const subscribePlayEngine = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

export const usePlayEngineOn = () => useSyncExternalStore(subscribePlayEngine, playEngineOn);
