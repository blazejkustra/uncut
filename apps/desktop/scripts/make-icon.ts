// Draws Uncut's app icon (1024×1024 PNG) and builds build/icon.icns with sips + iconutil.
// A dark rounded tile with a white "U" whose left arm has a clean diagonal cut: an edit.
// Run: node apps/desktop/scripts/make-icon.ts (the outputs are committed; rerun to change).
import { encodePng, onU, rasterize, roundRect, U_WHITE, writeIcon } from "./icon-lib.ts";

const out = new URL("../build/", import.meta.url).pathname;

const png = encodePng(
  rasterize((x, y) => {
    // macOS icon grid: an 824 px tile with ~185 px corners, centred.
    if (roundRect(x, y, 512, 512, 412, 412, 185) > 0) return undefined;
    if (onU(x, y)) return U_WHITE;
    const shade = 30 - ((y - 100) / 824) * 16; // #1e → #0e, top to bottom
    return [shade, shade, shade + 1];
  }),
);
writeIcon(out, "icon", png);
