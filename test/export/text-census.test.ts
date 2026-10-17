// The text census (packages/core census.ts) through the export rasteriser: the keynote film T3 set
// its agent thread as a piece at type 54 on a 1350 px canvas (a 4 % font; its 12 px step rows at
// 12/13 of that), letters about 2.7 % tall, and nothing measured them. The census lists those words
// with their size; the steps as their own piece at the default size, and words under a blur or
// faded out, aren't listed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { censusOf, graphicDocument, graphicInfo, SMALL_TEXT, type Project } from "../../packages/core/src/index.ts";
import { readGraphics } from "../../apps/server/src/export/exporter.ts";
import { loadGraphicLibs } from "../../apps/server/src/export/graphicLibs.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { legibilityNote } from "../../apps/server/src/agent/agentLegibility.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";

const W = 1080;
const H = 1350;
const canvas = { width: W, height: H, fps: 30 };
const STEPS = ["Read the brand kit", "Found the song's beats, 120 BPM", "Ranked the 6 drone clips"];

// t < 1: T3's thread piece at type 54; t >= 1: the steps as their own piece at the default size, the
// T3 thread blurred behind them (the stage) and a faded caption.
const STAGE = `<div id="host" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;background:#0a0a0a"></div>
<div id="back" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;filter:blur(6px)"></div>
<div id="pics" style="display:none"><canvas width="540" height="400" style="position:absolute;left:0;top:0;width:1080px;height:800px"></canvas>
<svg viewBox="0 0 108 135" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"><text x="5" y="100" font-size="8" font-family="DM Sans">Big svg words</text><text x="5" y="120" font-size="3" font-family="DM Sans">Tiny svg words</text></svg></div>
<div id="fade" style="position:absolute;left:40px;top:1250px;font:20px 'DM Sans';color:#fff;opacity:0.2">Faded caption words</div>
<script src="uncut:lib/ui.js"></script>
<script>
const props = { message: { text: "Create a promo video for Uncut from this drone footage" }, turn: { steps: ${JSON.stringify(STEPS)}, done: 2 } };
window.render = (t) => {
  const host = document.getElementById("host");
  const back = document.getElementById("back");
  document.getElementById("pics").style.display = t >= 1.8 ? "block" : "none";
  if (t < 1) {
    back.replaceChildren();
    uncutUI.sequence(host, t, [{ at: 0, piece: "agent.thread", props, width: 960, type: 54 }]);
  } else {
    uncutUI.sequence(back, t, [{ at: 0, piece: "agent.thread", props, width: 960, type: 54 }]);
    uncutUI.sequence(host, t, [{ at: 0, piece: "turn.steps", props: { steps: ${JSON.stringify(STEPS)}, done: 2 } }]);
  }
};
</script>`;

let root: string;
let docs: Map<string, string>;
let raster: Rasterizer;
const project = { canvas, tracks: [{ items: [{ type: "graphic", src: "graphics/census.html", duration: 60 }] }] } as unknown as Project;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-census-")));
  const dir = join(root, "Census.uncut");
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "census.html"), STAGE);
  const graphics = await readGraphics(dir, project, await loadGraphicLibs(resolve("assets/graphic-libs")));
  docs = new Map([...graphics].map(([src, html]) => [src, graphicDocument(html, canvas)]));
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  raster = await startRasterizer(command);
});

after(async () => {
  if (skip) return;
  await raster?.close();
  rmSync(root, { recursive: true, force: true });
});

async function census(local: number) {
  const out = join(root, `f-${local}.png`);
  const info = graphicInfo({ duration: 60, props: {} }, canvas, local);
  const reply = await raster.render({ kind: "graphic", width: W, height: H, doc: docs.get("graphics/census.html")!, t: local / canvas.fps, info, out, census: SMALL_TEXT });
  const c = censusOf(reply ? reply.census : undefined);
  assert.ok(c, "a census came back");
  return c;
}

test("the census lists T3's thread words under 3 % and not the steps set as their own piece", { skip, timeout: 120000 }, async (t) => {
  const thread = await census(0);
  t.diagnostic(JSON.stringify(thread));
  for (const step of STEPS) {
    const run = thread.small.find((x) => x.text === step);
    assert.ok(run, `"${step}" listed`);
    assert.ok(run.share > 2 && run.share < 3, `"${step}" at ${run.share} %`);
  }
  const steps = await census(45);
  t.diagnostic(JSON.stringify(steps));
  assert.ok(steps.measured >= STEPS.length, "the steps were measured");
  assert.deepEqual(steps.small, [], "nothing under the floor: the blurred thread and the faded caption are texture");
  const note = legibilityNote([{ frame: 0, small: thread.small, measured: thread.measured }], H);
  assert.match(note ?? "", /frame 0: .*"Read the brand kit" 2\.\d %/);
  assert.match(note ?? "", /uncutUI\.frameText\(el, world/);
  assert.equal(legibilityNote([{ frame: 45, small: steps.small, measured: steps.measured }], H), undefined);
});

test("SVG text is sized through its viewBox, and a canvas on screen is reported as unseen, never as no small text", { skip, timeout: 120000 }, async (t) => {
  const c = await census(57);
  t.diagnostic(JSON.stringify(c));
  assert.equal(c.small.find((x) => x.text === "Big svg words"), undefined, "80 px in frame px: not small");
  const tiny = c.small.find((x) => x.text === "Tiny svg words");
  assert.ok(tiny && tiny.share > 1.4 && tiny.share < 1.8, `the viewBox's 10x counted: ${tiny?.share}`);
  assert.equal(c.unseen, 1, "the canvas");
  assert.equal((await census(45)).unseen, undefined);
  const note = legibilityNote([{ frame: 57, small: [], measured: c.measured, unseen: c.unseen }], H);
  assert.match(note ?? "", /frame 57, text drawn on a canvas.*isn't measured/);
});
