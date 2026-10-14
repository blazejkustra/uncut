// A brand kit's logos as pictures the agent can see (D198, issue #35): each drawn by the export
// rasteriser (an offscreen Chromium that loads nothing but data: URLs) on the background it is
// meant for (the light-background logo on white, the dark-background one on near-black, the mark
// on grey), as a PNG. That way an SVG, which the model can't read as text reliably, comes back as
// what it looks like, and a white logo isn't invisible on a transparent picture.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { rasterizerCommand, startRasterizer, type Rasterizer } from "../export/rasterizer.ts";

const MIME: Readonly<Record<string, string>> = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const BACKDROP: Readonly<Record<string, string>> = { light: "#ffffff", dark: "#111111", mark: "#808080" };
const MAX_BYTES = 5 * 1024 * 1024;
export const LOGO_PICTURE = { width: 640, height: 360 } as const;

export interface LogoPicture {
  readonly slot: string;
  readonly png?: Buffer;
  readonly problem?: string;
}

/** Each logo drawn on its slot's background as a PNG (one rasteriser for all of them), or why it couldn't be. */
export async function logoPictures(logos: ReadonlyArray<{ readonly slot: string; readonly path: string }>): Promise<Array<LogoPicture>> {
  if (!logos.length) return [];
  const command = rasterizerCommand();
  if ("problem" in command) return logos.map((l) => ({ slot: l.slot, problem: command.problem }));
  const temp = await mkdtemp(join(tmpdir(), "uncut-logos-"));
  let raster: Rasterizer | undefined;
  try {
    raster = await startRasterizer(command);
    const out: Array<LogoPicture> = [];
    for (const [i, l] of logos.entries()) {
      const mime = MIME[extname(l.path).toLowerCase()];
      const size = (await stat(l.path).catch(() => undefined))?.size ?? 0;
      if (!mime || !size || size > MAX_BYTES) {
        out.push({ slot: l.slot, problem: !mime ? "not a picture" : !size ? "the file is missing" : "over 5 MB" });
        continue;
      }
      const url = `data:${mime};base64,${(await readFile(l.path)).toString("base64")}`;
      const file = join(temp, `logo-${i}.png`);
      const html = `<div style="position:absolute;inset:0;background:${BACKDROP[l.slot] ?? "#808080"};display:flex;align-items:center;justify-content:center"><img src="${url}" style="width:80%;height:70%;object-fit:contain"></div>`;
      try {
        await raster.render({ width: LOGO_PICTURE.width, height: LOGO_PICTURE.height, css: "", html, out: file });
        out.push({ slot: l.slot, png: await readFile(file) });
      } catch (error) {
        out.push({ slot: l.slot, problem: (error as Error).message });
      }
    }
    return out;
  } catch (error) {
    return logos.map((l) => ({ slot: l.slot, problem: (error as Error).message }));
  } finally {
    await raster?.close().catch(() => {});
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
