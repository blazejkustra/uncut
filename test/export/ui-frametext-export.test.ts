// uncutUI.frameText (defect 2 of the keynote runs): every stage film framed the agent panel's whole
// width (zoom = frame width / the side panel's), so its 12 px steps were 1.5 to 2 % of the frame's
// height in a big dark column. frameText frames the steps' own words until they're 3.5 % of the
// height, whole inside the safe inset. Through the export rasteriser: the panel-wide framing gives
// lines about 2 % tall, frameText's 3.5 % or more, none cut at the frame's edge.
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

// t < 1: the panel's whole width (what the films did); t >= 1: frameText on the steps; t >= 2: on the first step alone. The result's
// fits and text are painted as a bar (width text * 10000 px, green when it fits) at the top left.
const STAGE = `<div id="stage" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;background:#0a0a0a;overflow:hidden"><div id="world" style="position:absolute;left:0;top:0;transform-origin:0 0"></div><div id="bar" style="position:absolute;left:0;top:0;height:4px"></div></div>
<script src="uncut:lib/ui.js"></script>
<script src="uncut:lib/motion.js"></script>
<script>
const world = document.getElementById("world");
const props = { width: 1440, height: 1000, time: 0, side: "agent", message: { text: "Cut the six drone clips to Electro Dreams" }, turn: { steps: ["Imported 7 files", "Wrote the brief", "Proposed a storyboard of 7 beats"], done: 2 } };
window.render = (t) => {
  world.style.transform = "none";
  const root = uncutUI.mount(world, "editor", props);
  const side = uncutUI.rectIn(uncutUI.find(root, "side"), world);
  const wide = { x: side.x + side.w / 2, y: side.y + ${H} / (${W} / (side.w + 16)) / 2, zoom: ${W} / (side.w + 16) };
  const steps = uncutUI.frameText(root.querySelector(".worklog"), world, { width: ${W}, height: ${H}, safe: 36 });
  const one = uncutUI.frameText(root.querySelector(".worklog .step"), world, { width: ${W}, height: ${H}, safe: 36 });
  const key = t < 2 ? steps : one;
  world.style.transform = uncutMotion.cameraCSS(t < 1 ? wide : key, ${W}, ${H});
  const bar = document.getElementById("bar");
  bar.style.width = Math.round(key.text * 10000) + "px";
  bar.style.background = key.fits ? "#00ff00" : "#ff0000";
};
</script>`;

let root: string;
let docs: Map<string, string>;
let raster: Rasterizer;
const project = { canvas, tracks: [{ items: [{ type: "graphic", src: "graphics/steps.html", duration: 60 }] }] } as unknown as Project;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-ui-frametext-")));
  const dir = join(root, "Steps.uncut");
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "steps.html"), STAGE);
  const graphics = await readGraphics(dir, project, await loadGraphicLibs(resolve("assets/graphic-libs")));
  docs = new Map([...graphics].map(([src, html]) => [src, graphicDocument(html, canvas)]));
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

async function frame(local: number) {
  const out = join(root, `f-${local}.png`);
  const info = graphicInfo({ duration: 60, props: {} }, canvas, local);
  await raster.render({
    kind: "graphic",
    width: W,
    height: H,
    doc: docs.get("graphics/steps.html")!,
    t: local / canvas.fps,
    info,
    out,
    name: "graphics/steps.html",
  });
  return rgbaOf(out);
}

/** The text lines below the bar: bands of rows with light ink (grey 100+), their heights and the ink's left and right edges. */
function lines(px: Uint8Array | Buffer) {
  const lum = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return (px[i]! + px[i + 1]! + px[i + 2]!) / 3;
  };
  const bands: Array<{ top: number; h: number }> = [];
  let left = W,
    right = -1,
    top = -1;
  for (let y = 8; y < H; y++) {
    let ink = false;
    for (let x = 0; x < W; x++)
      if (lum(x, y) > 100) {
        ink = true;
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    if (ink && top < 0) top = y;
    if (!ink && top >= 0) {
      bands.push({ top, h: y - top });
      top = -1;
    }
  }
  return { bands: bands.filter((b) => b.h >= 3), left, right };
}

test("frameText sets the agent's steps larger than the panel's width does, and says whether they fit whole", { skip, timeout: 120000 }, async (t) => {
  const wide = lines(await frame(0));
  const all = await frame(45);
  const solo = await frame(75);
  const near = lines(all);
  const alone = lines(solo);
  const median = (l: ReturnType<typeof lines>) => l.bands.map((b) => b.h).sort((a, b) => a - b)[l.bands.length >> 1]! / H;
  const msg = `lines (median, share of the height): the panel's width ${(median(wide) * 100).toFixed(1)} %, the steps ${(median(near) * 100).toFixed(1)} %, one step ${(median(alone) * 100).toFixed(1)} %`;
  t.diagnostic(msg);
  assert.ok(median(near) > median(wide) * 1.15 && median(near) >= 0.033, msg);
  assert.ok(median(alone) >= 0.04, msg);
  // The bar: green when frameText says the words fit whole at that size. The three steps at 4.8 % are
  // wider than the 540 px frame's safe inset (capped, red); one step fits (green) and stays inside it.
  const bar = (px: Uint8Array | Buffer) => [px[(2 * W + 10) * 4]!, px[(2 * W + 10) * 4 + 1]!];
  assert.ok(bar(all)[0]! > 200 && bar(all)[1]! < 80, "the whole list is capped: fits false");
  assert.ok(bar(solo)[1]! > 200 && bar(solo)[0]! < 80, "one step fits");
  assert.ok(alone.left >= 30, `one step inside the inset (ink from ${alone.left})`);
});
