// Lane heights (timeline v2 phase 1, D346): one size for every lane (small, medium, large), and a
// lane resized on its own by dragging its head's bottom edge or ⌥ + wheel over its head. Kept on
// this Mac, per project; the project file doesn't change.
import { useSyncExternalStore } from "react";

import type { Track } from "../state/project.ts";

export type LaneSize = "small" | "medium" | "large";

export const LANE_SIZES: ReadonlyArray<{ readonly id: LaneSize; readonly label: string; readonly short: string }> = [
  { id: "small", label: "Small tracks", short: "S" },
  { id: "medium", label: "Medium tracks", short: "M" },
  { id: "large", label: "Large tracks", short: "L" },
];

const BASE: Readonly<Record<LaneSize, { readonly picture: number; readonly main: number; readonly sound: number }>> = {
  small: { picture: 32, main: 40, sound: 40 },
  medium: { picture: 40, main: 52, sound: 64 },
  large: { picture: 64, main: 80, sound: 112 },
};

const MIN_LANE = 28;
const MAX_LANE = 240;

const SIZE_KEY = "uncut.laneSize";
const HEIGHTS_KEY = "uncut.laneHeights";

type Heights = Readonly<Record<string, Readonly<Record<string, number>>>>;
type Sizes = Readonly<Record<string, LaneSize>>;

function readSaved<T extends object>(key: string): T | Record<string, never> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    return saved && typeof saved === "object" ? (saved as T) : {};
  } catch {
    return {};
  }
}

let sizes = readSaved<Sizes>(SIZE_KEY);
let heights = readSaved<Heights>(HEIGHTS_KEY);
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version++;
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(sizes));
    localStorage.setItem(HEIGHTS_KEY, JSON.stringify(heights));
  } catch {}
  for (const l of listeners) l();
}

const clampLane = (px: number) => Math.round(Math.min(MAX_LANE, Math.max(MIN_LANE, px)));

export function laneSize(dir: string | undefined): LaneSize {
  const saved = dir === undefined ? undefined : sizes[dir];
  return LANE_SIZES.find((s) => s.id === saved)?.id ?? "medium";
}

/** A lane's height before a graphic's element rows: its own if it was resized, else the size's. */
export function laneHeight(dir: string | undefined, track: Track): number {
  const own = dir === undefined ? undefined : heights[dir]?.[track.id];
  if (typeof own === "number") return clampLane(own);
  const base = BASE[laneSize(dir)];
  return track.kind === "audio" ? base.sound : track.role === "main" ? base.main : base.picture;
}

/** Every lane of the project to `next`, forgetting the lanes it resized on their own. */
export function setLaneSize(dir: string | undefined, next: LaneSize) {
  if (dir === undefined) return;
  sizes = { ...sizes, [dir]: next };
  heights = Object.fromEntries(Object.entries(heights).filter(([d]) => d !== dir));
  changed();
}

export function setLaneHeight(dir: string | undefined, trackId: string, px: number) {
  if (dir === undefined) return;
  heights = { ...heights, [dir]: { ...heights[dir], [trackId]: clampLane(px) } };
  changed();
}

/** Redraws when a size or a height changes. */
export const useLaneHeights = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
