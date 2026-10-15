// D221: "Draw the preview on the GPU", remembered on this Mac (localStorage). Off (the default) until
// its parity tests cover every layer kind: on, one WebGL2 canvas draws the bottom run of video, image
// and plain-colour layers with their picture effects (preview/gpu.ts); the rest stays on the DOM.
import { useSyncExternalStore } from "react";

const KEY = "uncut.preview.gpu";

const read = () => {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
};

let on = read();
const listeners = new Set<() => void>();

export const gpuCompositorOn = () => on;

export function setGpuCompositorOn(value: boolean) {
  on = value;
  try {
    if (value) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {}
  for (const l of listeners) l();
}

export const subscribeGpuCompositor = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

export const useGpuCompositorOn = () => useSyncExternalStore(subscribeGpuCompositor, gpuCompositorOn);
