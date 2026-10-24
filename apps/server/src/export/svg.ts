// SVG images (D76): ffmpeg (brew's build has no librsvg) and the media core can't read them, so
// their size comes from the file itself: the root element's viewBox, else its width and height
// (plain numbers or px), else Chromium's default for an image without one (300×150). The preview
// draws them as <img>, the export has Chromium draw them at their box's size.
import { readFile, stat } from "node:fs/promises";

import type { ProbeOutcome } from "../media/mediaCore.ts";

/** The most of an SVG file that's read (bytes). */
const MAX_SVG_BYTES = 10 * 1024 * 1024;

const number = (v: string | undefined) => {
  if (!v) return undefined;
  const m = /^\s*([\d.]+)\s*(px)?\s*$/.exec(v);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** The picture size an SVG document declares (see the header), or undefined when it isn't an SVG. */
export function svgSize(text: string): { width: number; height: number } | undefined {
  const root = /<svg\b([^>]*)>/i.exec(text);
  if (!root) return undefined;
  const attr = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i")
      .exec(root[1]!)
      ?.slice(2)
      .find((v) => v !== undefined);
  const box = attr("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const w = number(attr("width"));
  const h = number(attr("height"));
  if (box && box.length === 4 && box[2]! > 0 && box[3]! > 0) {
    // A width or height alongside the viewBox sets the size; the other follows the viewBox's shape.
    if (w && h) return { width: Math.round(w), height: Math.round(h) };
    if (w) return { width: Math.round(w), height: Math.round((w * box[3]!) / box[2]!) };
    if (h) return { width: Math.round((h * box[2]!) / box[3]!), height: Math.round(h) };
    return { width: Math.round(box[2]!), height: Math.round(box[3]!) };
  }
  return { width: Math.round(w ?? 300), height: Math.round(h ?? 150) };
}

/** A probe of an SVG file as the import job wants it. */
export async function probeSvg(path: string): Promise<ProbeOutcome> {
  try {
    const s = await stat(path);
    if (s.size > MAX_SVG_BYTES) return { ok: false, code: "unreadable", message: "the SVG file is over 10 MB" };
    const size = svgSize(await readFile(path, "utf8"));
    if (!size) return { ok: false, code: "unreadable", message: "it isn't an SVG document" };
    return { ok: true, info: { kind: "image", container: "svg", width: size.width, height: size.height, hasAudio: false, via: "svg" } };
  } catch {
    return { ok: false, code: "not-found", message: "The file doesn't exist." };
  }
}
