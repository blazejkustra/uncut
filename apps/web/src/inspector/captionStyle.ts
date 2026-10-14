// The default caption style for new captions (D166), remembered on this Mac (localStorage, like
// the panel sizes). Settings › App sets it; Make captions passes it to core planMakeCaptions.
import { CAPTION_STYLES } from "@uncut/core/captions";
import { useSyncExternalStore } from "react";

const KEY = "uncut.captions.style";
const readDefault = (): string => {
  try {
    const v = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    return v && CAPTION_STYLES.some((s) => s.id === v) ? v : "";
  } catch {
    return "";
  }
};
let current = readDefault();
const listeners = new Set<() => void>();
/** The caption style new captions get ("" = none: the look chosen when making them). */
export const defaultCaptionStyle = () => current;
export const setDefaultCaptionStyle = (id: string) => {
  current = CAPTION_STYLES.some((s) => s.id === id) ? id : "";
  try {
    if (current) localStorage.setItem(KEY, current);
    else localStorage.removeItem(KEY);
  } catch {}
  for (const l of listeners) l();
};
export const useDefaultCaptionStyle = () => useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), () => current);

