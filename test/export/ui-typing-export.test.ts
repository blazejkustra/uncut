// uncutUI typing (A1r8, A1r4: the typed prompt's card jumped a line taller at every wrap): a key's
// typing { at, dur, from } types props.text in and grows the shell over LINE_GROW s at each new line.
// The graphic walks a composer typed across several lines frame by frame and paints green when
// - the shell never grows by more than a third of a line between two frames, yet ends lines taller;
// - the Send button stays inside the shell on every frame (the toolbar rides the bottom edge);
// - the typed text at each frame is what the schedule says;
// - the same frames drawn in shuffled order give the same shell (pure in t);
// else a colour naming the check that failed.
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
const PROMPT = "Make a 28s launch film for Uncut, this app: one take on the beat, show me typing this prompt and the agent editing the video.";
const keys = [{ at: -1, piece: "composer", y: 320, width: 460, type: 26, props: { text: PROMPT, caret: true }, typing: { at: 0.05, dur: 3.4, from: 22 } }];
const count = (t) => Math.round(22 + (PROMPT.length - 22) * Math.max(0, Math.min(1, (t - 0.05) / 3.4)));
window.render = (t) => {
  const host = document.getElementById("host");
  const frames = Array.from({ length: 240 }, (_, f) => f);
  let fail = 0, last = null, worst = 0;
  const seen = new Map();
  for (const f of frames) {
    const b = uncutUI.sequence(host, f / 60, keys);
    seen.set(f, b.h);
    const line = b.type * 1.45;
    if (last && b.h - last.h > line / 3) fail = fail || 1;
    const send = uncutUI.rectIn(uncutUI.find(b.el, "send"), host);
    if (send.y + send.h > b.y + b.h / 2 + 0.5 || send.y < b.y - b.h / 2) fail = fail || 2;
    const typed = (b.el.querySelector(".composer-hl")?.textContent || "").replace(/\\u200b/g, "");
    if (typed !== PROMPT.slice(0, count(f / 60))) fail = fail || 3;
    if (!last) worst = b.h;
    last = b;
  }
  if (last.h - worst < 2 * last.type) fail = fail || 4;
  for (const f of [200, 7, 133, 61, 0, 239, 95, 96, 12]) if (Math.abs(uncutUI.sequence(host, f / 60, keys).h - seen.get(f)) > 0.01) fail = fail || 5;
  uncutUI.sequence(host, t, keys);
  document.getElementById("out").style.background = fail ? "rgb(" + (40 * fail) + ", 0, 0)" : "#0f0";
};
</script>`;

let root: string;
let raster: Rasterizer;
let doc: string;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-ui-typing-")));
  const dir = join(root, "Typing.uncut");
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "typing.html"), DOC);
  const project = { canvas, tracks: [{ items: [{ type: "graphic", src: "graphics/typing.html", duration: 240 }] }] } as unknown as Project;
  const graphics = await readGraphics(dir, project, await loadGraphicLibs(resolve("assets/graphic-libs")));
  doc = graphicDocument(graphics.get("graphics/typing.html")!, canvas);
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  raster = await startRasterizer(command);
});

after(async () => {
  if (skip) return;
  await raster?.close();
  rmSync(root, { recursive: true, force: true });
});

test("uncutUI typing: the typed composer grows smoothly at each wrap, its toolbar inside, pure in t", { skip, timeout: 120000 }, async () => {
  const out = join(root, "f.png");
  await raster.render({ kind: "graphic", width: W, height: H, doc, t: 1, info: graphicInfo({ duration: 240, props: {} }, canvas, 60), out, name: "graphics/typing.html" });
  const px = rgbaOf(out);
  const [r, g] = [px[0]!, px[1]!];
  const why = ["", "the shell jumped by over a third of a line in one frame", "Send left the shell", "the typed text is off the schedule", "it never grew by two lines", "shuffled frames differ"][Math.round(r / 40)] ?? `pixel ${r},${g}`;
  assert.ok(g > 200 && r < 30, why);
});
