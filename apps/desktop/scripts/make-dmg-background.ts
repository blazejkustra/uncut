// Draws the DMG window's background (D288): build/background.png (660×400) and background@2x.png
// (1320×800); electron-builder's dmg target joins them into one retina TIFF and sizes the window from
// it. Uncut's dark greyscale, a faint top light and a subtle arrow from the app (left) to the
// Applications link (right), at the icon positions in electron-builder.yml's `dmg.contents`.
// Finder draws icon labels black over a background picture, in dark mode too (no setting changes
// it), so each label sits on a small light-grey plate (4 pt corners); without them the names vanish into the dark.
// The window is 660×400 with its title bar, so the visible area is ~660×368: the icons sit centred
// in that, and the bottom of the picture only shows under a taller window.
// Run: node apps/desktop/scripts/make-dmg-background.ts (the outputs are committed; rerun to change).
import { writeFileSync } from "node:fs";

import { clamp, encodePng, rasterize, roundRect, segment, type Rgb } from "./icon-lib.ts";

export const DMG_WINDOW = { width: 660, height: 400 } as const;
/** Icon centres, in window points; electron-builder.yml's dmg.contents uses the same. */
export const DMG_ICONS = { app: { x: 180, y: 172 }, applications: { x: 480, y: 172 } } as const;
/** Where Finder centres a 13 pt label under a 128 pt icon, below the icon's centre (measured). */
const LABEL_DY = 83;

const out = new URL("../build/", import.meta.url).pathname;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const BG: Rgb = [14, 14, 15];
const LIGHT: Rgb = [30, 30, 32];
const ARROW: Rgb = [242, 241, 238];

// The arrow: a shaft between the icons with a two-stroke head, faint (it hints, the icons lead).
const y = DMG_ICONS.app.y;
const x0 = DMG_ICONS.app.x + 88, x1 = DMG_ICONS.applications.x - 88;
const HEAD = 11, HALF = 1.25;
const PLATE: Rgb = [206, 205, 202]; // light grey, not white: readable black text, quiet on the dark

function colour(px: number, py: number): Rgb {
  const { width: w, height: h } = DMG_WINDOW;
  // A soft light from above the centre, falling off to the edges.
  const glow = clamp(1 - Math.hypot((px - w / 2) / (w * 0.75), (py + h * 0.15) / (h * 1.05)), 0, 1);
  let c = mix(BG, LIGHT, glow ** 1.6);
  for (const icon of Object.values(DMG_ICONS)) {
    if (roundRect(px, py, icon.x, icon.y + LABEL_DY, 54, 12, 4) <= 0) return PLATE;
  }
  const d = Math.min(segment(px, py, x0, y, x1, y), segment(px, py, x1 - HEAD, y - HEAD, x1, y), segment(px, py, x1 - HEAD, y + HEAD, x1, y));
  const cover = d <= HALF ? 1 : 0; // the rasteriser supersamples the edge
  if (cover > 0) {
    // Fades in from the app's side, so it reads as a direction rather than a rule.
    const t = clamp((px - x0) / (x1 - x0), 0, 1);
    c = mix(c, ARROW, cover * (0.1 + 0.16 * t));
  }
  return c;
}

if (import.meta.main) {
  for (const scale of [1, 2]) {
    const w = DMG_WINDOW.width * scale, h = DMG_WINDOW.height * scale;
    const png = encodePng(rasterize((x, y) => colour(x / scale, y / scale), w, h), w, h);
    const file = `${out}background${scale === 2 ? "@2x" : ""}.png`;
    writeFileSync(file, png);
    console.log(`wrote ${file} (${w}×${h})`);
  }
}
