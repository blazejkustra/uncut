// uncutUI.sequence with keys closer together than a morph (a step row added every half beat while the
// 0.9 s morph still runs): each key starts from where the shell is, never from the last key's rest.
// Round 7's steps card jumped by one frame at every new row (6.5, 7.0, 7.35 s in its export). The
// graphic walks the shell frame by frame through the overlapping keys and paints green when no frame
// moves the shell further than the morph's own speed allows, red otherwise.
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

const DOC = `<div id="host" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"></div>
<div id="out" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;z-index:9"></div>
<script src="uncut:lib/ui.js"></script>
<script>
const steps = ["Read the brand kit", "Placed the music", "Ranked the footage", "Wrote the brief", "Proposed a storyboard"];
const keys = steps.map((_, i) => ({ at: 0.5 * i, piece: "turn.steps", width: 480, type: 24, props: { steps: steps.slice(0, i + 1), done: i } }));
keys.push({ at: 2.35, piece: "turn.steps", width: 480, type: 24, props: { steps, done: steps.length } });
window.render = (t) => {
  const host = document.getElementById("host");
  let last = null, worst = 0, at = 0;
  for (let f = 0; f <= 200; f++) {
    const b = uncutUI.sequence(host, f / 60, keys);
    if (last) {
      const d = Math.max(Math.abs(b.h - last.h), Math.abs(b.y - last.y), Math.abs(b.w - last.w));
      if (d > worst) { worst = d; at = f; }
    }
    last = b;
  }
  uncutUI.sequence(host, t, keys);
  const out = document.getElementById("out");
  out.dataset.worst = worst.toFixed(1) + " at frame " + at;
  out.style.background = worst <= 4 ? "#0f0" : "#f00";
};
</script>`;

let root: string;
let raster: Rasterizer;
let doc: string;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-ui-seq-")));
  const dir = join(root, "Seq.uncut");
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "seq.html"), DOC);
  const project = { canvas, tracks: [{ items: [{ type: "graphic", src: "graphics/seq.html", duration: 200 }] }] } as unknown as Project;
  const graphics = await readGraphics(dir, project, await loadGraphicLibs(resolve("assets/graphic-libs")));
  doc = graphicDocument(graphics.get("graphics/seq.html")!, canvas);
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  raster = await startRasterizer(command);
});

after(async () => {
  if (skip) return;
  await raster?.close();
  rmSync(root, { recursive: true, force: true });
});

test("uncutUI.sequence: a key that starts mid-morph continues from the shell's place, no one-frame jump", { skip, timeout: 120000 }, async () => {
  const out = join(root, "f.png");
  await raster.render({ kind: "graphic", width: W, height: H, doc, t: 1, info: graphicInfo({ duration: 200, props: {} }, canvas, 60), out, name: "graphics/seq.html" });
  const px = rgbaOf(out);
  const [r, g] = [px[0]!, px[1]!];
  assert.ok(g > 200 && r < 60, `the shell jumped between two frames (pixel ${r},${g}: red means a jump)`);
});
