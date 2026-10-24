// Draws the .uncut project icon (D252): a document page with a folded corner and the app icon's
// dark tile and cut U on it, so a project reads as "an Uncut document" next to the app in Finder.
// Writes build/project.png and build/project.icns (Info.plist's CFBundleTypeIconFile and
// UTTypeIconFile; electron-builder.yml copies it into Contents/Resources).
// Run: node apps/desktop/scripts/make-project-icon.ts (the outputs are committed; rerun to change).
import { encodePng, onU, rasterize, roundRect, U_WHITE, writeIcon, type Rgb } from "./icon-lib.ts";

const out = new URL("../build/", import.meta.url).pathname;

// The page: macOS document proportions on the 1024 grid, a folded top-right corner.
const PX = 512,
  PY = 512,
  PHW = 304,
  PHH = 404,
  PR = 34,
  FOLD = 172,
  EDGE = 5;
const RIGHT = PX + PHW,
  TOP = PY - PHH;
// The tile: the app icon, scaled down, a little below the page's centre.
const S = 0.44,
  TX = 512,
  TY = 548;

const page = (x: number, y: number) => roundRect(x, y, PX, PY, PHW, PHH, PR);
// Above the fold's diagonal, in the corner square: cut away.
const cutAway = (x: number, y: number) => x > RIGHT - FOLD && y < TOP + FOLD && x - (RIGHT - FOLD) > y - TOP;
const inFlap = (x: number, y: number) => x > RIGHT - FOLD && y < TOP + FOLD && !cutAway(x, y);

const png = encodePng(
  rasterize((x, y): Rgb | undefined => {
    if (page(x, y) > 0 || cutAway(x, y)) return undefined;
    // The tile and the U, mapped back to the app icon's grid.
    const ux = 512 + (x - TX) / S,
      uy = 512 + (y - TY) / S;
    if (roundRect(ux, uy, 512, 512, 412, 412, 185) <= 0) {
      if (onU(ux, uy)) return U_WHITE;
      const shade = 30 - ((uy - 100) / 824) * 16;
      return [shade, shade, shade + 1];
    }
    if (inFlap(x, y)) {
      // The folded-over corner: darker toward the crease, with an edge along the diagonal.
      const toCrease = (x - (RIGHT - FOLD) - (y - TOP)) / Math.SQRT2;
      if (toCrease < EDGE) return [196, 194, 189];
      const t = Math.min(1, toCrease / (FOLD / Math.SQRT2));
      const v = 226 - t * 18;
      return [v, v - 1, v - 4];
    }
    // The page's outline, along its edge and the fold's diagonal.
    const nearDiagonal = x > RIGHT - FOLD - EDGE && y < TOP + FOLD + EDGE && Math.abs(x - (RIGHT - FOLD) - (y - TOP)) / Math.SQRT2 < EDGE;
    if (page(x, y) > -EDGE || nearDiagonal) return [206, 204, 199];
    const v = 249 - ((y - TOP) / (2 * PHH)) * 12; // a faint top-to-bottom shade
    return [v, v - 1, v - 4];
  }),
);
writeIcon(out, "project", png);
