// D221: "Draw the preview on the GPU", remembered on this Mac (localStorage). On by default (D273):
// WebGL2 canvases draw every layer they can with its picture effects (preview/gpu.ts), in runs
// between the layers they can't, which stay on the DOM. Settings › App turns it off ("off" stored).
import { useSyncExternalStore } from "react";

const KEY = "uncut.preview.gpu";

const read = () => {
  try {
    return typeof localStorage === "undefined" || localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
};

let on = read();
const listeners = new Set<() => void>();

export const gpuCompositorOn = () => on;

export function setGpuCompositorOn(value: boolean) {
  on = value;
  try {
    if (value) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {}
  for (const l of listeners) l();
}

export const subscribeGpuCompositor = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

export const useGpuCompositorOn = () => useSyncExternalStore(subscribeGpuCompositor, gpuCompositorOn);
