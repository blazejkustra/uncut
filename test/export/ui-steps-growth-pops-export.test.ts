// uncutUI.sequence growing a list in a slot of the author's size (T7's steps card: a row every half
// second, each key a width and a height of its own that the rows don't fill exactly). Through the
// export rasteriser at 60 fps, frame to frame: no single-frame pop while the rows are added. The morph
// placed the content top-anchored at the width's scale while the key at rest fitted it centred in its
// box, so every morph's first and last frame jumped (T7: 9 pops at 6.4 to 8.3 s, d 2 to 9 of 255).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { graphicDocument, graphicInfo, type Project } from "../../packages/core/src/index.ts";
import { readGraphics } from "../../apps/server/src/export/exporter.ts";
import { loadGraphicLibs } from "../../apps/server/src/export/graphicLibs.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { rgbaOf } from "../helpers/image-compare.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : false;
const W = 540;
const H = 675;
const canvas = { width: W, height: H, fps: 60 };

// T7's keys at half size: slot heights the author guessed (SH), a short first morph from a free piece.
const DOC = `<div id="host" style="position:absolute;inset:0;background:#0a0a0a"></div>
<script src="uncut:lib/ui.js"></script>
<script>
const STEPS = ["Read the brand kit", "Analysed the song: 120 BPM", "Ranked 6 takes by how clean they are", "Wrote the brief", "Proposed a storyboard of 7 beats"];
const EDIT = "Cut the promo: 6 shots and the song";
const AT = [0, 1.5, 2.0, 2.5, 3.0];
const SH = [100, 140, 225, 265, 350, 435];
const K = { piece: "turn.steps", x: 270, width: 500, type: 28 };
const keys = [{ at: 0, ...K, y: 345, width: 210, height: 150, props: { steps: [STEPS[0]], done: 0 } }];
AT.forEach((a, i) => keys.push({ at: a + (i ? 0 : 0.1), ...K, y: 220 + SH[i] / 2, height: SH[i], props: { steps: STEPS.slice(0, i + 1), done: i }, dur: i ? 0.4 : 0.9 }));
keys.push({ at: 3.5, ...K, y: 220 + SH[5] / 2, height: SH[5], props: { steps: [...STEPS, EDIT], done: 5 }, dur: 0.3 });
window.render = (t) => uncutUI.sequence(document.getElementById("host"), t, keys);
</script>`;

let root: string;
let raster: Rasterizer;
let doc: string;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-ui-grow-")));
  const dir = join(root, "Grow.uncut");
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "grow.html"), DOC);
  const project = { canvas, tracks: [{ items: [{ type: "graphic", src: "graphics/grow.html", duration: 300 }] }] } as unknown as Project;
  const graphics = await readGraphics(dir, project, await loadGraphicLibs(resolve("assets/graphic-libs")));
  doc = graphicDocument(graphics.get("graphics/grow.html")!, canvas);
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

async function grey(f: number): Promise<Float32Array> {
  const out = join(root, `f${String(f).padStart(4, "0")}.png`);
  await raster.render({
    kind: "graphic",
    width: W,
    height: H,
    doc,
    t: f / canvas.fps,
    info: graphicInfo({ duration: 300, props: {} }, canvas, f),
    out,
    name: "graphics/grow.html",
  });
  const px = rgbaOf(out);
  const g = new Float32Array(W * H);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * px[i * 4]! + 0.587 * px[i * 4 + 1]! + 0.114 * px[i * 4 + 2]!;
  return g;
}

const diff = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
};

test("uncutUI.sequence: a list growing in slots of the author's size has no frame-to-frame pop", { skip, timeout: 300000 }, async (t) => {
  // 1.4 s to 4.0 s: every row added, each morph's first and last frame.
  const frames: Array<Float32Array> = [];
  for (let f = 84; f <= 240; f++) frames.push(await grey(f));
  const d = frames.slice(1).map((g, i) => diff(frames[i]!, g));
  const pops: Array<string> = [];
  for (let i = 0; i < d.length; i++) {
    const near = Math.max(d[i - 1] ?? 0, d[i + 1] ?? 0);
    // A pop: a step of at least 1 of 255 that is 3x both its neighbours (T7's were 2 to 9; the
    // promo measure counts 2 and up, the critic 0.03 of 1). Below that: a line of text snapping to the
    // next pixel row as an ease settles (about 0.6), which any slow text move does.
    if (d[i]! >= 1 && d[i]! >= 3 * near) pops.push(`f ${85 + i} (${((85 + i) / 60).toFixed(2)} s): ${d[i]!.toFixed(2)} vs ${near.toFixed(2)}`);
  }
  t.diagnostic(`biggest step ${Math.max(...d).toFixed(2)} of 255`);
  assert.deepEqual(pops, [], `single-frame pops while the rows are added: ${pops.join("; ")}`);
});
