// D209 (issue #14): one window with two sizes. Welcome, New project and Recents show in a compact
// window about the start card's size; the editor gets the full one when a project opens. Each
// size is remembered on its own (<data dir>/window.json), the editor's position too.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export type WindowMode = "welcome" | "editor";

export interface WindowSize {
  readonly width: number;
  readonly height: number;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
}

export const WINDOW_MODES: Record<WindowMode, { readonly width: number; readonly height: number; readonly minWidth: number; readonly minHeight: number }> = {
  welcome: { width: 760, height: 720, minWidth: 600, minHeight: 520 },
  // Below this an editor has no useful preview; the layout is checked at exactly this size.
  editor: { width: 1280, height: 800, minWidth: 1024, minHeight: 640 },
};

const FILE = "window.json";

const size = (raw: unknown, mode: WindowMode): WindowSize | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const { minWidth, minHeight } = WINDOW_MODES[mode];
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);
  const width = n(r.width);
  const height = n(r.height);
  if (width === undefined || height === undefined) return undefined;
  const x = n(r.x);
  const y = n(r.y);
  return { width: Math.max(minWidth, Math.min(width, 10000)), height: Math.max(minHeight, Math.min(height, 10000)), ...(x !== undefined && y !== undefined ? { x, y } : {}) };
};

/** The remembered sizes (each falls back to its default). */
export function readWindowSizes(dir: string): Record<WindowMode, WindowSize> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(path.join(dir, FILE), "utf8")) as Record<string, unknown>;
  } catch {}
  const pick = (mode: WindowMode): WindowSize => size(raw[mode], mode) ?? { width: WINDOW_MODES[mode].width, height: WINDOW_MODES[mode].height };
  return { welcome: pick("welcome"), editor: pick("editor") };
}

export function writeWindowSizes(dir: string, sizes: Record<WindowMode, WindowSize>) {
  try {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, FILE);
    writeFileSync(`${file}.tmp`, JSON.stringify(sizes));
    renameSync(`${file}.tmp`, file);
  } catch {}
}
