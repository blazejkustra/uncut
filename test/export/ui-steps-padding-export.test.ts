// uncutUI.sequence growing a list (turn.steps, a row per key, the A1r6 checklist): through the export
// rasteriser, the shell hugs the rows with the same inset and corner radius at every count (the inset
// once came from the slot's height, so 3 and 4 rows sat in a visibly fatter shell than 1 or 2), and
// while it grows the new row is revealed above a clear bottom inset (never cut at the shell's edge).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { graphicDocument, graphicInfo, type Project } from "../../packages/core/src/index.ts";
import { readGraphics } from "../../apps/server/src/export/exporter.ts";
import { loadGraphicLibs } from "../../apps/server/src/export/graphicLibs.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { rgbaOf } from "../helpers/image-compare.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";

const W = 540;
const H = 675;
const canvas = { width: W, height: H, fps: 30 };

// A row every second (each morph 0.3 s), at rest from at + 0.3.
const STEPS = `<div id="host" style="position:absolute;inset:0;background:#f1f0ed"></div>
<script src="uncut:lib/ui.js"></script>
<script>
// Each wraps to two lines with no descender, so every count's last line ends on the same baseline
// (a lone row's icon, or a "y", reaches lower than the words and would read as a different inset).
const STEPS = ["Read the brand kit and the music track", "Wrote the brief for the launch film", "Cut the shots on the beat of the track", "Added the title at the last beat"];
window.render = (t) => {
  const keys = [0, 1, 2, 3].map((i) => ({ at: i, piece: "turn.steps", props: { steps: STEPS.slice(0, i + 1), done: i }, shadow: false }));
  uncutUI.sequence(document.getElementById("host"), t, keys, { dur: 0.3 });
};
</script>`;

let root: string;
let doc: string;
let raster: Rasterizer;
const project = { canvas, tracks: [{ items: [{ type: "graphic", src: "graphics/steps.html", duration: 150 }] }] } as unknown as Project;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-ui-steps-")));
  const dir = join(root, "Steps.uncut");
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "steps.html"), STEPS);
  const graphics = await readGraphics(dir, project, await loadGraphicLibs(resolve("assets/graphic-libs")));
  doc = graphicDocument(graphics.get("graphics/steps.html")!, canvas);
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  raster = await startRasterizer(command);
});

after(async () => {
  if (skip) return;
  await raster?.close();
  if (process.env.UNCUT_KEEP_OUTPUT) console.log(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
});

/** The dark shell's box on the light page and the words' insets inside it (first and last light pixel). */
async function measure(t: number) {
  const out = join(root, `steps-${t}.png`);
  const local = Math.round(t * canvas.fps);
  await raster.render({ kind: "graphic", width: W, height: H, doc, t: local / canvas.fps, info: graphicInfo({ duration: 150, props: {} }, canvas, local), out, name: "graphics/steps.html" });
  const px = rgbaOf(out);
  const lum = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
  };
  const cx = W / 2;
  let y0 = 0;
  while (y0 < H && lum(cx, y0) > 40) y0++;
  let y1 = H - 1;
  while (y1 > 0 && lum(cx, y1) > 40) y1--;
  const cy = Math.round((y0 + y1) / 2);
  let x0 = 0;
  while (x0 < W && lum(x0, cy) > 40) x0++;
  let x1 = W - 1;
  while (x1 > 0 && lum(x1, cy) > 40) x1--;
  // Away from the rounded corners (their edge is mid-grey too).
  const m = 40;
  const lit = (x: number, y: number) => lum(x, y) > 70;
  const rows = (y: number) => Array.from({ length: x1 - x0 - 2 * m }, (_, k) => x0 + m + k).some((x) => lit(x, y));
  const cols = (x: number) => Array.from({ length: Math.max(0, y1 - y0 - 2 * m) }, (_, k) => y0 + m + k).some((y) => lit(x, y));
  let top = y0;
  while (top < y1 && !rows(top)) top++;
  let bottom = y1;
  while (bottom > y0 && !rows(bottom)) bottom--;
  let left = x0;
  while (left < x1 && !cols(left)) left++;
  // The corner: how far in from the shell's left edge its top row of pixels starts (the radius).
  let corner = x0;
  while (corner < x1 && lum(corner, y0) > 40) corner++;
  return { h: y1 - y0 + 1, top: top - y0, bottom: y1 - bottom, left: left - x0, corner: corner - x0 };
}

test("a growing list keeps one inset and radius at every row count, and grows above a clear bottom inset", { skip, timeout: 120000 }, async (t) => {
  const rest = [];
  for (const at of [0.9, 1.9, 2.9, 3.9]) rest.push(await measure(at));
  t.diagnostic(JSON.stringify(rest));
  for (let i = 1; i < rest.length; i++) assert.ok(rest[i]!.h > rest[i - 1]!.h, `the shell grows with each row: ${JSON.stringify(rest)}`);
  // Top, left and the corner are the same pixels; the last baseline lands at a fractional offset
  // (lines of 16.8 px at 2.7x) and is snapped, so the bottom moves by a few pixels at most (it once
  // grew by 20 px from 1 to 4 rows; the layout's own insets are equal, 27 px every side).
  for (const [k, tol] of [["top", 1], ["left", 1], ["corner", 1], ["bottom", 4]] as const) {
    const v = rest.map((r) => r[k]);
    assert.ok(Math.max(...v) - Math.min(...v) <= tol, `${k} inset the same at 1..4 rows: ${v.join(", ")}`);
  }
  // Mid-growth (the 4th row coming in): no words in the bottom inset while the shell is still short of them.
  const mid = await measure(3.1);
  t.diagnostic(JSON.stringify(mid));
  assert.ok(mid.h > rest[2]!.h && mid.h < rest[3]!.h, "mid-growth");
  assert.ok(mid.bottom >= rest[3]!.left * 0.5, `a clear bottom inset while growing: ${mid.bottom} px (rest inset ${rest[3]!.left})`);
});
