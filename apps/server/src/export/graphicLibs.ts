// The bundled graphic libraries (D193): assets/graphic-libs (the packaged app: Resources/graphic-libs,
// ServerConfig graphicLibsDir), read once per folder and kept in memory. readGraphics resolves each
// graphic's uncut:lib/ markers with them (core resolveGraphicLibs), and the preview route, the export
// and render_frames all read graphics through it, so they inline the very same sources.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { GRAPHIC_LIBS } from "@uncut/core";

const cache = new Map<string, Promise<Readonly<Record<string, string>>>>();

/** The bundled libraries' sources by name (three.js, confetti.js, ...); one that can't be read is left out. */
export function loadGraphicLibs(dir: string): Promise<Readonly<Record<string, string>>> {
  let hit = cache.get(dir);
  if (!hit) {
    hit = (async () => {
      const out: Record<string, string> = {};
      for (const name of GRAPHIC_LIBS) {
        try {
          out[name] = await readFile(join(dir, name), "utf8");
        } catch {}
      }
      return out;
    })();
    cache.set(dir, hit);
  }
  return hit;
}
