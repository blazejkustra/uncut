// The bundled fonts (D77): DM Sans and DM Mono, inlined by Vite as data: URLs and declared with
// core's fontFaceCss, the same rules the export rasteriser's page uses, so text in either face
// measures the same in the preview and the export. Every face is loaded at start, so the first
// frame that uses one isn't drawn with the fallback.
import { fontFaceCss, FONT_FACES, type FontFile } from "@uncut/core/render";

import dmSans from "../../../assets/fonts/DMSans-Variable.woff2?inline";
import dmMonoRegular from "../../../assets/fonts/DMMono-Regular.woff2?inline";
import dmMonoMedium from "../../../assets/fonts/DMMono-Medium.woff2?inline";

const URLS: Record<FontFile, string> = { "DMSans-Variable.woff2": dmSans, "DMMono-Regular.woff2": dmMonoRegular, "DMMono-Medium.woff2": dmMonoMedium };

/** Declare the bundled fonts and start loading them; resolves once they're ready. */
export function loadFonts(): Promise<unknown> {
  const style = document.createElement("style");
  style.dataset.fonts = "uncut";
  style.textContent = fontFaceCss((file) => URLS[file]);
  document.head.append(style);
  return Promise.all(FONT_FACES.map((f) => document.fonts.load(`${f.weight.split(" ")[0]} 16px "${f.family}"`).catch(() => [])));
}
