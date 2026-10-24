// The agent's footage tools (D65), the parts that don't need a running server: which files a
// media_import call means (a folder's media files, not recursive) and what it must refuse, and
// how a contact sheet is laid out (which frames, the grid, its HTML for the rasteriser).
import { readdir, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, extname, isAbsolute, join, sep } from "node:path";

import { expandHome } from "../paths.ts";

/** media_import: at most this many files per call. */
export const MAX_IMPORT = 50;
/** contact_sheet: at most this many cells, the default when `every` isn't given, and the sheet's widest. */
export const MAX_CELLS = 60;
export const DEFAULT_CELLS = 24;
/** A sheet's longest side, either way (about what a model sees without downscaling). */
export const SHEET_MAX_EDGE = 1568;
/** Cells narrower than this make unreadable captions and pictures. */
export const MIN_CELL_WIDTH = 80;
/** Frames pulled from media for a sheet are about this wide (a cell is never wider). */
export const CELL_WIDTH = 320;
export const CAPTION_HEIGHT = 22;
export const GAP = 6;

const VIDEO_EXT = [".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mts", ".m2ts", ".mxf", ".3gp", ".insv", ".lrv"];
const AUDIO_EXT = [".wav", ".mp3", ".m4a", ".aac", ".aif", ".aiff", ".flac", ".ogg", ".opus", ".caf"];
const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".svg"];
/** What a folder import takes: files with these extensions (each is still probed). */
export const MEDIA_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT]);

export interface ImportPlan {
  /** Files to import, in order. */
  readonly files: ReadonlyArray<string>;
  /** Things in a folder that aren't imported, with why. */
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

const realOr = (path: string) => realpath(path).catch(() => path);
const inside = (path: string, folder: string) => path === folder || path.startsWith(folder + sep);
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** A refusal for a path macOS (or permissions) won't let Uncut read, else undefined. */
function readDenied(error: unknown, path: string): string | undefined {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EPERM" || code === "EACCES") {
    return `Uncut isn't allowed to read ${path}. macOS asks for access to folders like Documents, Desktop and Downloads: allow Uncut in System Settings → Privacy & Security → Files and Folders (or Full Disk Access), then try again.`;
  }
  if (code === "ENOENT") return `${path} doesn't exist.`;
  return undefined;
}

/**
 * At most `max` skipped entries, and when there are more, how many in all and per reason, so a
 * folder of a thousand sidecar files doesn't flood the reply.
 */
export function capSkipped<T extends { readonly reason: string }>(
  list: ReadonlyArray<T>,
  max = 20,
): { skipped: Array<T>; skippedTotal?: number; skippedByReason?: Record<string, number> } {
  if (list.length <= max) return { skipped: [...list] };
  const byReason: Record<string, number> = {};
  for (const s of list) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
  return { skipped: list.slice(0, max), skippedTotal: list.length, skippedByReason: byReason };
}

/**
 * Why `real` (a path with symlinks resolved) can't be imported into the project at `projectReal`,
 * or undefined. The project's own folder and anything in it are refused (its cache, its history,
 * project.json), except its media/ folder, which is there for footage (D12).
 */
export function refusal(real: string, projectReal: string, shown: string): string | undefined {
  if (inside(real, join(projectReal, ".cache"))) return `${shown} is in the project's cache (.cache), which holds Uncut's own files, not footage.`;
  if (real === projectReal) return `${shown} is the project's own folder. Import footage from the folder where it lives.`;
  if (inside(real, projectReal) && !inside(real, join(projectReal, "media")))
    return `${shown} is inside the project's folder, which holds Uncut's own files. Import footage from the folder where it lives.`;
  return undefined;
}

/**
 * The files a media_import call means: each path is a file (imported if it probes as media) or a
 * folder (the media files directly inside it, by extension; not recursive). Refuses the whole call
 * (a sentence, as `refused`) for a relative path, the project's own folder or cache, or more than
 * MAX_IMPORT files. A path that doesn't exist is passed on, so the import reports it as failed.
 */
export async function planImport(paths: ReadonlyArray<unknown>, projectDir: string, max = MAX_IMPORT): Promise<ImportPlan | { readonly refused: string }> {
  if (!paths.length) return { refused: "Pass path (a file or a folder) or paths." };
  const projectReal = await realOr(projectDir);
  const files: Array<string> = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const seen = new Set<string>();
  const add = (path: string, real: string) => {
    if (seen.has(real)) return;
    seen.add(real);
    files.push(path);
  };
  for (const raw of paths) {
    if (typeof raw !== "string" || !raw.trim()) return { refused: "Every path must be a non-empty string." };
    const path = expandHome(raw.trim());
    if (!isAbsolute(path)) return { refused: `"${raw}" isn't an absolute path. Pass the full path, like /Users/you/Movies/clip.mp4 (or ~/Movies/clip.mp4).` };
    const real = await realOr(path);
    const why = refusal(real, projectReal, path);
    if (why) return { refused: why };
    let info: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      info = await stat(path);
    } catch (error) {
      // Missing: passed on, so the import reports it per file ("The file doesn't exist.").
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return { refused: readDenied(error, path)! };
    }
    if (!info?.isDirectory()) {
      add(path, real);
      continue;
    }
    let listed: Array<string>;
    try {
      listed = await readdir(path);
    } catch (error) {
      return { refused: readDenied(error, path) ?? `Couldn't read the folder ${path}: ${(error as Error).message}` };
    }
    const names = listed.filter((n) => !n.startsWith(".")).sort(byName);
    for (const name of names) {
      const file = join(path, name);
      const s = await stat(file).catch(() => undefined);
      if (!s) continue;
      if (s.isDirectory()) {
        skipped.push({ path: file, reason: "A folder: only the files directly inside the folder you named are imported." });
        continue;
      }
      if (!s.isFile()) continue;
      if (!MEDIA_EXT.has(extname(name).toLowerCase())) {
        skipped.push({ path: file, reason: "Not a media file (by its extension)." });
        continue;
      }
      const fileReal = await realOr(file);
      const inner = refusal(fileReal, projectReal, file);
      if (inner) {
        skipped.push({ path: file, reason: inner });
        continue;
      }
      add(file, fileReal);
    }
  }
  if (files.length > max) {
    return {
      refused: `That's ${files.length} media files; media_import takes at most ${max} per call. Import them in smaller groups (pass paths with up to ${max} files).`,
    };
  }
  return { files, skipped };
}

// ---- contact sheets ----

/**
 * The frames a sheet shows, from [start, end): every `every` frames when given (refused, as a
 * sentence, when that makes more than `max` cells), else `max` frames spread evenly.
 */
export function sheetFrames(start: number, end: number, every: number | undefined, max: number): ReadonlyArray<number> | { readonly refused: string } {
  const length = end - start;
  if (length <= 0) return { refused: `The range is empty (${start} to ${end}).` };
  if (every !== undefined) {
    const count = Math.ceil(length / every);
    if (count > max) {
      const wider = Math.ceil(length / max);
      return {
        refused: `Every ${every} frames over ${length} frames is ${count} cells; a sheet holds at most ${max}. Use every ≥ ${wider}, or a shorter range.`,
      };
    }
    return Array.from({ length: count }, (_, i) => start + i * every);
  }
  const count = Math.min(max, length);
  return Array.from({ length: count }, (_, i) => start + Math.floor((i * length) / count));
}

export interface SheetLayout {
  readonly columns: number;
  readonly rows: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly width: number;
  readonly height: number;
}

/** The widest cell `columns` columns of `count` cells allow inside SHEET_MAX_EDGE both ways. */
function fit(count: number, aspect: number, columns: number): SheetLayout {
  const rows = Math.ceil(count / columns);
  const byWidth = Math.floor((SHEET_MAX_EDGE - GAP * (columns + 1)) / columns);
  const cellRoom = Math.floor((SHEET_MAX_EDGE - GAP * (rows + 1)) / rows) - CAPTION_HEIGHT;
  const byHeight = Math.floor(cellRoom * aspect);
  const cellWidth = Math.max(0, Math.min(CELL_WIDTH, byWidth, byHeight));
  const cellHeight = Math.max(1, Math.round(cellWidth / aspect));
  return {
    columns,
    rows,
    cellWidth,
    cellHeight,
    width: columns * cellWidth + GAP * (columns + 1),
    height: rows * (cellHeight + CAPTION_HEIGHT) + GAP * (rows + 1),
  };
}

/**
 * The grid for `count` cells of a picture `aspect` (width / height) wide, at most SHEET_MAX_EDGE
 * on its longest side: the column count that gives the biggest cells (ties: the one nearest a
 * landscape-friendly default), or `columns` when asked and its cells stay at least MIN_CELL_WIDTH
 * wide (else the best fit, which the caller reports).
 */
export function sheetLayout(count: number, aspect: number, columns?: number): SheetLayout {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  const n = Math.max(1, count);
  const most = Math.min(n, 10);
  if (columns !== undefined) {
    const asked = fit(n, a, Math.max(1, Math.min(most, Math.round(columns))));
    if (asked.cellWidth >= MIN_CELL_WIDTH) return asked;
  }
  const preferred = n <= 4 ? n : n <= 9 ? 3 : n <= 16 ? 4 : n <= 30 ? 5 : 6;
  let best: SheetLayout | undefined;
  for (let c = 1; c <= most; c++) {
    const l = fit(n, a, c);
    if (!best || l.cellWidth > best.cellWidth || (l.cellWidth === best.cellWidth && Math.abs(c - preferred) < Math.abs(best.columns - preferred))) best = l;
  }
  return best!;
}

/** 83.5 s → "1:23.50" (minutes, seconds and hundredths), "1:02:03.00" past an hour. */
export function clock(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = ((cs % 6000) / 100).toFixed(2).padStart(5, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The sheet as HTML for the rasteriser: the frames (JPEG data URLs) in a grid, a caption under each. */
export function sheetHtml(cells: ReadonlyArray<{ readonly jpeg: Buffer; readonly caption: string }>, layout: SheetLayout): string {
  const { columns, cellWidth: w, cellHeight: h } = layout;
  const size = w < 150 ? 11 : 13;
  const body = cells
    .map((cell, i) => {
      const x = GAP + (i % columns) * (w + GAP);
      const y = GAP + Math.floor(i / columns) * (h + CAPTION_HEIGHT + GAP);
      return (
        `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px">` +
        `<img src="data:image/jpeg;base64,${cell.jpeg.toString("base64")}" style="display:block;width:${w}px;height:${h}px;object-fit:contain;background:#000">` +
        `<div style="height:${CAPTION_HEIGHT}px;line-height:${CAPTION_HEIGHT}px;white-space:pre;overflow:hidden;text-overflow:ellipsis">${escapeHtml(cell.caption)}</div></div>`
      );
    })
    .join("");
  return `<div style="position:absolute;inset:0;background:#16161a;color:#e8e8ec;font:600 ${size}px -apple-system,'SF Pro Text','Helvetica Neue',sans-serif;font-variant-numeric:tabular-nums">${body}</div>`;
}

/** A short name for a path in a step label. */
export const shortName = (path: string) => basename(path.replace(/[/\\]+$/, "")) || path;

/** D198: what a folder the user named holds (not hidden entries), for the message and the turn card. */
export interface FolderListing {
  readonly files: number;
  readonly folders: number;
  readonly videos: number;
  readonly images: number;
  readonly sounds: number;
  /** Names in order (folders end in /), at most `max`. */
  readonly names: ReadonlyArray<string>;
}

/** The folder's own entries (not recursive, dot-files left out), or undefined when it can't be read. */
export async function listFolder(dir: string, max = 40): Promise<FolderListing | undefined> {
  let entries: Array<Dirent>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const shown = entries.filter((e) => !e.name.startsWith(".") && (e.isFile() || e.isDirectory() || e.isSymbolicLink()));
  const folders = shown
    .filter((e) => e.isDirectory())
    .map((e) => `${e.name}/`)
    .sort(byName);
  const files = shown
    .filter((e) => !e.isDirectory())
    .map((e) => e.name)
    .sort(byName);
  const ext = (n: string) => extname(n).toLowerCase();
  return {
    files: files.length,
    folders: folders.length,
    videos: files.filter((n) => VIDEO_EXT.includes(ext(n))).length,
    images: files.filter((n) => IMAGE_EXT.includes(ext(n))).length,
    sounds: files.filter((n) => AUDIO_EXT.includes(ext(n))).length,
    names: [...files, ...folders].slice(0, max),
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "12 files (3 videos, 8 images) and 2 folders": a listing in words. */
export function listingWords(l: FolderListing): string {
  const kinds = [l.videos ? plural(l.videos, "video") : "", l.images ? plural(l.images, "image") : "", l.sounds ? plural(l.sounds, "sound") : ""].filter(
    Boolean,
  );
  return `${plural(l.files, "file")}${kinds.length && l.files ? ` (${kinds.join(", ")})` : ""}${l.folders ? ` and ${plural(l.folders, "folder")}` : ""}`;
}
