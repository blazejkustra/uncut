// The bundled fonts (D77): DM Sans and DM Mono, inlined by Vite as data: URLs and declared with
// core's fontFaceCss, the same rules the export rasteriser's page uses, so text in either face
// measures the same in the preview and the export. Every face is loaded at start, so the first
// frame that uses one isn't drawn with the fallback.
import { fontFaceCss, FONT_FACES, type FontFile } from "@uncut/core/render";

import dmSans from "../../../../assets/fonts/DMSans-Variable.woff2?inline";
import dmMonoRegular from "../../../../assets/fonts/DMMono-Regular.woff2?inline";
import dmMonoMedium from "../../../../assets/fonts/DMMono-Medium.woff2?inline";

const URLS: Record<FontFile, string> = { "DMSans-Variable.woff2": dmSans, "DMMono-Regular.woff2": dmMonoRegular, "DMMono-Medium.woff2": dmMonoMedium };

/** Declare the bundled fonts and start loading them; resolves once they're ready. */
export function loadFonts(): Promise<unknown> {
  const style = document.createElement("style");
  style.dataset.fonts = "uncut";
  style.textContent = fontFaceCss((file) => URLS[file]);
  document.head.append(style);
  return Promise.all(FONT_FACES.map((f) => document.fonts.load(`${f.weight.split(" ")[0]} 16px "${f.family}"`).catch(() => [])));
}

// D198: the project's brand kit's font files, for texts and components in the preview (graphics
// get them inlined in their document by the server; the export's rasteriser in its CSS). Fetched
// from the token-protected /media/brand route and added as FontFace objects from their bytes (the
// page's CSP allows only data: font URLs; a FontFace made from bytes loads nothing).
const kitFaces = new Map<string, FontFace>();

/** Make the kit's font files the ones the page has: adds new ones, drops the ones no longer there. */
export async function syncKitFonts(wanted: ReadonlyArray<{ readonly key: string; readonly family: string; readonly weight?: number | undefined; readonly url: string }>): Promise<void> {
  const keys = new Set(wanted.map((w) => w.key));
  for (const [key, face] of kitFaces) {
    if (keys.has(key)) continue;
    document.fonts.delete(face);
    kitFaces.delete(key);
  }
  await Promise.all(
    wanted
      .filter((w) => !kitFaces.has(w.key))
      .map(async (w) => {
        try {
          const res = await fetch(w.url);
          if (!res.ok) return;
          const face = new FontFace(w.family, await res.arrayBuffer(), { weight: w.weight ? String(w.weight) : "100 1000" });
          await face.load();
          if (kitFaces.has(w.key)) return;
          kitFaces.set(w.key, face);
          document.fonts.add(face);
        } catch {}
      }),
  );
}
