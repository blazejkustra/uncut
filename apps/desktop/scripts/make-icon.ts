// Draws Uncut's app icons (1024×1024 PNGs) and builds build/icon.icns and build/icon-nightly.icns
// with sips + iconutil. A dark rounded tile with a white "U" whose left arm has a clean diagonal
// cut: an edit. The nightly (electron-builder.nightly.yml) is the same U on a night-blue to violet
// tile with a crescent moon, so it's told apart from the release in the Dock and in Finder.
// Run: node apps/desktop/scripts/make-icon.ts (the outputs are committed; rerun to change).
import { encodePng, onU, rasterize, roundRect, U_WHITE, writeIcon, type Rgb } from "./icon-lib.ts";

const out = new URL("../build/", import.meta.url).pathname;

// macOS icon grid: an 824 px tile with ~185 px corners, centred.
const onTile = (x: number, y: number) => roundRect(x, y, 512, 512, 412, 412, 185) <= 0;

const png = encodePng(
  rasterize((x, y) => {
    if (!onTile(x, y)) return undefined;
    if (onU(x, y)) return U_WHITE;
    const shade = 30 - ((y - 100) / 824) * 16; // #1e → #0e, top to bottom
    return [shade, shade, shade + 1];
  }),
);
writeIcon(out, "icon", png);

// The crescent: a disc with an offset disc taken out, top right, clear of the U.
const MOON: Rgb = [255, 214, 120];
const onMoon = (x: number, y: number) => Math.hypot(x - 792, y - 222) <= 64 && Math.hypot(x - 822, y - 198) > 56;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const TOP: Rgb = [38, 34, 104]; // night blue
const BOTTOM: Rgb = [118, 52, 170]; // violet

const nightly = encodePng(
  rasterize((x, y) => {
    if (!onTile(x, y)) return undefined;
    if (onU(x, y)) return U_WHITE;
    if (onMoon(x, y)) return MOON;
    return mix(TOP, BOTTOM, Math.min(1, Math.max(0, (y - 100) / 824 + (x - 512) / 4120)));
  }),
);
writeIcon(out, "icon-nightly", nightly);
