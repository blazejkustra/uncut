// The editor's panel sizes (G5, D116): the left panel's width, the inspector's width and the
// timeline's height, dragged by thin handles on their edges, remembered on this Mac (localStorage
// in the app's profile), double-click puts one back to its default. The grid's defaults live in
// styles.css; a remembered size is clamped there too, so a smaller window can't starve the preview.
import { useSyncExternalStore } from "react";

export type PanelSize = "lib" | "side" | "bottom";
type Sizes = Partial<Record<PanelSize, number>>;

const KEY = "uncut.layout";
/** What a dragged size may be, in CSS px (the CSS clamps again against the window). */
export const LIMITS: Readonly<Record<PanelSize, readonly [number, number]>> = { lib: [180, 560], side: [240, 560], bottom: [120, 900] };

const read = (): Sizes => {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const k of ["lib", "side", "bottom"] as const) if (typeof raw[k] === "number" && Number.isFinite(raw[k])) out[k] = raw[k] as number;
    return out;
  } catch {
    return {};
  }
};

let sizes: Sizes = read();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const clampSize = (panel: PanelSize, px: number) => Math.round(Math.min(LIMITS[panel][1], Math.max(LIMITS[panel][0], px)));

export const layout = {
  /** Shown while dragging; saved only when `save` is true (the release). */
  set(panel: PanelSize, px: number, save: boolean) {
    sizes = { ...sizes, [panel]: clampSize(panel, px) };
    if (save) localStorage.setItem(KEY, JSON.stringify(sizes));
    emit();
  },
  reset(panel: PanelSize) {
    const { [panel]: _gone, ...rest } = sizes;
    sizes = rest;
    localStorage.setItem(KEY, JSON.stringify(sizes));
    emit();
  },
};

export const useLayout = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => sizes,
  );

/** The grid's custom properties for the remembered sizes (absent: the CSS default). */
export function layoutStyle(s: Sizes): Record<string, string> {
  const style: Record<string, string> = {};
  if (s.lib !== undefined) style["--lib-col"] = `clamp(180px, ${s.lib}px, 40vw)`;
  if (s.side !== undefined) style["--side-col"] = `clamp(240px, ${s.side}px, 40vw)`;
  if (s.bottom !== undefined) style["--bottom-row"] = `clamp(120px, ${s.bottom}px, 70vh)`;
  return style;
}

// ---- the left rail's tab order (S2, D117) ----

export const RAIL_KEY = "uncut.rail";

/** The saved order, with tabs it doesn't name (new ones) at the end and unknown names dropped. */
export function railOrder<T extends string>(saved: unknown, ids: ReadonlyArray<T>): Array<T> {
  const list = Array.isArray(saved) ? saved.filter((x): x is T => typeof x === "string" && ids.includes(x as T)) : [];
  const unique = [...new Set(list)];
  return [...unique, ...ids.filter((id) => !unique.includes(id))];
}

export function loadRail<T extends string>(ids: ReadonlyArray<T>): Array<T> {
  try {
    return railOrder(JSON.parse(localStorage.getItem(RAIL_KEY) ?? "[]"), ids);
  } catch {
    return railOrder([], ids);
  }
}

// ---- the side panel's tab per project (U14, D180) ----

export type SideTab = "inspector" | "agent" | "history";
export const SIDE_TAB_KEY = "uncut.side.tab";
const SIDE_TABS: ReadonlyArray<SideTab> = ["inspector", "agent", "history"];
const MAX_REMEMBERED = 50;

const readSideTabs = (): Record<string, SideTab> => {
  try {
    const raw = JSON.parse(localStorage.getItem(SIDE_TAB_KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, SideTab] => SIDE_TABS.includes(e[1] as SideTab)));
  } catch {
    return {};
  }
};

/** The tab last shown for this project, if any. */
export const rememberedSideTab = (dir: string): SideTab | undefined => readSideTabs()[dir];

/** Remembers the tab for this project (the newest MAX_REMEMBERED projects are kept). */
export function rememberSideTab(dir: string, tab: SideTab) {
  try {
    const { [dir]: _old, ...rest } = readSideTabs();
    const entries = [...Object.entries(rest), [dir, tab] as const].slice(-MAX_REMEMBERED);
    localStorage.setItem(SIDE_TAB_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
  // The editor may already show the project (its snapshot can arrive before the call that made it).
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("uncut:side-tab", { detail: { dir, tab } }));
}
