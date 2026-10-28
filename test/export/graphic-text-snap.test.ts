// Handoff 13: text in graphics shook by a pixel (argent-100s "Claude Code", "~/stride"): a card
// popping in on spring.settle moved by translate() with a fraction; Chromium drew the card's edges at
// that fraction but the text on whole pixels, so the words jumped a pixel up and back inside a card
// that barely moved. The document's bootstrap (core graphicDocument) now puts an element within a
// pixel of its place exactly there after render(t), and leaves real moves fractional. Through the
// real rasteriser:
// - the pop's frames: once the card is within a pixel of its place the text keeps its place in it,
//   and the shake check (motionJitter findShakes) finds nothing, with or without a scale-in; the
//   same move under a scale the bootstrap leaves alone (one that sizes the card 2 px bigger) still
//   shakes, so the check would see it;
// - a slow drift (0.3 px a frame) keeps its sub-pixel steps: the card's edge moves 0.3 px every frame;
// - a pop whose dy is rounded to whole pixels (argent100-v4-6's own patch) overshoots to exactly
//   1 px: that settles too, so the card and its text don't go up a pixel and back;
// - which transforms are put in place: a translate of at most 1 px, with a scale under a pixel of the
//   element's size; not a longer translate, not one inside a scaled parent, not a real scale.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { graphicDocument, graphicInfo, resolveGraphicLibs } from "../../packages/core/src/index.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { loadGraphicLibs } from "../../apps/server/src/export/graphicLibs.ts";
import { findShakes } from "../../apps/server/src/agent/motionJitter.ts";

const DESKTOP = process.env.UNCUT_TEST_DESKTOP ?? resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";

const canvas = { width: 640, height: 360, fps: 30 };
const CARD_TOP = 40;

// argent-100s' pop: a card rising 30 px on spring.settle (0.7 px past its place, then back).
const pop = (extra: string) => `<style>html,body{background:#141414}
#c{position:absolute;left:40px;top:${CARD_TOP}px;width:560px;height:200px;background:#24292e;border-radius:22px;font-family:'DM Mono',monospace;color:#fff;font-size:44px;line-height:1.3}
#c span{position:absolute;left:40px;top:30px}</style>
<div id="c"><span>Claude Code v2.1<br>~/stride</span></div>
<script src="uncut:lib/spring.js"></script>
<script>window.render = (t) => { const dy = 30 * (1 - uncutSpring(t, "spring.settle")); document.getElementById("c").style.transform = "translate(0px," + dy.toFixed(2) + "px)${extra}"; };</script>`;

let root: string;
let raster: Rasterizer;
let libs: Readonly<Record<string, string>>;

before(async () => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), "uncut-text-snap-"));
  libs = await loadGraphicLibs(resolve("assets/graphic-libs"));
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  raster = await startRasterizer(command);
});

after(async () => {
  if (skip) return;
  await raster?.close();
  rmSync(root, { recursive: true, force: true });
});

async function grayAt(html: string, f: number, name: string): Promise<Uint8Array> {
  const out = join(root, `${name}-${f}.png`);
  const doc = graphicDocument(resolveGraphicLibs(html, libs), canvas);
  await raster.render({
    kind: "graphic",
    width: canvas.width,
    height: canvas.height,
    doc,
    t: f / canvas.fps,
    info: graphicInfo({ duration: 60, props: {} }, canvas, f),
    out,
    name,
  });
  return new Uint8Array(
    execFileSync("ffmpeg", ["-v", "error", "-i", out, "-vf", "format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 16 << 20 }),
  );
}

/** The text's row centroid (bright pixels in the card's text area) and the card's top edge (its coverage in one column), in px. */
function measure(gray: Uint8Array) {
  const { width } = canvas;
  let s = 0;
  let sy = 0;
  for (let y = CARD_TOP; y < CARD_TOP + 190; y++)
    for (let x = 80; x < 500; x++) {
      const v = Math.max(0, gray[y * width + x]! - 80);
      s += v;
      sy += v * y;
    }
  const bg = gray[5 * width + 560]!;
  const card = gray[(CARD_TOP + 60) * width + 560]!;
  let cover = 0;
  for (let y = 5; y < CARD_TOP + 60; y++) cover += (gray[y * width + 560]! - bg) / (card - bg);
  return { text: sy / s, edge: CARD_TOP + 60 - cover };
}

const FRAMES = Array.from({ length: 30 }, (_, i) => i + 3);

test("a card popping in on a spring: once within a pixel of its place its text stays put in it, and nothing shakes", { skip, timeout: 120_000 }, async () => {
  const frames = [];
  for (const f of FRAMES) frames.push({ frame: f, gray: await grayAt(pop(""), f, "pop") });
  const gaps = frames
    .map((x) => measure(x.gray))
    .filter((m) => Math.abs(m.edge - CARD_TOP) < 1)
    .map((m) => m.text - m.edge);
  console.log(`  text minus card edge, settled frames: ${gaps.map((g) => g.toFixed(2)).join(" ")}`);
  assert.ok(gaps.length >= 15, `${gaps.length} settled frames`);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) < 0.05, `the text moves inside its card by ${(Math.max(...gaps) - Math.min(...gaps)).toFixed(2)} px`);
  assert.deepEqual(findShakes(frames, canvas.width, canvas.height), []);
});

test("a card scaling in on a spring (pop with s 0.96, as argent-100s' agent card) settles without a shake", { skip, timeout: 120_000 }, async () => {
  const grow = pop("").replace(
    '"translate(0px," + dy.toFixed(2) + "px)"',
    '"translate(0px," + dy.toFixed(2) + "px) scale(" + (0.96 + 0.04 * uncutSpring(t, "spring.settle")).toFixed(4) + ")"',
  );
  const frames = [];
  for (const f of FRAMES) frames.push({ frame: f, gray: await grayAt(grow, f, "grow") });
  assert.deepEqual(findShakes(frames, canvas.width, canvas.height), []);
});

test("a pop rounded to whole pixels, overshooting by exactly 1 px, settles without a shake", { skip, timeout: 120_000 }, async () => {
  const rounded = pop("").replace("dy.toFixed(2)", "Math.round(dy)");
  const frames = [];
  for (const f of FRAMES) frames.push({ frame: f, gray: await grayAt(rounded, f, "rounded") });
  assert.ok(
    frames.some((x) => Math.abs(measure(x.gray).edge - CARD_TOP) < 0.5),
    "the card reaches its place",
  );
  assert.deepEqual(findShakes(frames, canvas.width, canvas.height), []);
});

test("the same move under a scale left as it is shakes, and the check sees it", { skip, timeout: 120_000 }, async () => {
  const frames = [];
  for (const f of FRAMES) frames.push({ frame: f, gray: await grayAt(pop(" scale(1.004)"), f, "scaled") });
  const gaps = frames.map((x) => measure(x.gray)).map((m) => m.text - m.edge);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) > 0.5, "the text slides inside the card");
  assert.ok(findShakes(frames, canvas.width, canvas.height).length >= 1, "a shake found");
});

test("a slow drift keeps its sub-pixel steps", { skip, timeout: 120_000 }, async () => {
  const drift = pop("").replace('const dy = 30 * (1 - uncutSpring(t, "spring.settle"));', "const dy = 20 - 9 * t;");
  const edges: Array<number> = [];
  for (const f of Array.from({ length: 20 }, (_, i) => i)) edges.push(measure(await grayAt(drift, f, "drift")).edge);
  const steps = edges.slice(1).map((e, i) => e - edges[i]!);
  assert.ok(
    steps.every((d) => Math.abs(d + 0.3) < 0.05),
    `the card's edge moves 0.3 px a frame: ${steps.map((d) => d.toFixed(2)).join(" ")}`,
  );
});

// The second frame reads what the bootstrap left after the first (graphics are drawn in order in one page): green when each is as expected.
const RULES = `<div id="a" style="position:absolute"></div><div id="p" style="position:absolute;transform:scale(2)"><div id="b" style="position:absolute"></div></div>
<div id="s" style="position:absolute"></div><div id="z" style="position:absolute;width:200px;height:20px"></div><div id="n" style="position:absolute"></div><div id="w" style="position:absolute"></div><div id="y" style="position:absolute;width:200px;height:20px"></div><div id="r" style="position:absolute"></div>
<canvas id="out" width="640" height="360"></canvas>
<script>
const $ = (id) => document.getElementById(id);
window.render = (t) => {
  if (t === 0) {
    $("a").style.transform = "translate(3.7px, -2.6px)";
    $("b").style.transform = "translate(0.4px, 0px)";
    $("s").style.transform = "translate(3.7px, 0px) scale(1.5)";
    $("n").style.transform = "translate(4px, 5px)";
    $("w").style.transform = "translateY(0.4px)";
    $("z").style.transform = "translate(2.5px, 0px) scale(1.001)";
    $("y").style.transform = "translate(0.6px, -0.3px) scale(1.001)";
    $("r").style.transform = "translate(0px, -1px) scale(1.0000)";
    return;
  }
  const want = { a: "translate(3.7px, -2.6px)", b: "translate(0.4px, 0px)", s: "translate(3.7px, 0px) scale(1.5)", n: "translate(4px, 5px)", w: "translate(0px, 0px)", z: "translate(2.5px, 0px) scale(1.001)", y: "translate(0px, 0px)", r: "translate(0px, 0px)" };
  const wrong = Object.keys(want).filter((id) => $(id).style.transform !== want[id]);
  const g = $("out").getContext("2d");
  g.fillStyle = wrong.length ? "rgb(255,0,0)" : "rgb(0,255,0)";
  g.fillRect(0, 0, 640, 360);
};
</script>`;

test("only an element within a pixel of its place, outside any scale, is put exactly there", { skip, timeout: 60_000 }, async () => {
  await grayAt(RULES, 0, "rules");
  const out = join(root, "rules-check.png");
  await raster.render({
    kind: "graphic",
    width: canvas.width,
    height: canvas.height,
    doc: graphicDocument(RULES, canvas),
    t: 1 / canvas.fps,
    info: graphicInfo({ duration: 60, props: {} }, canvas, 1),
    out,
    name: "rules",
  });
  const px = execFileSync("ffmpeg", ["-v", "error", "-i", out, "-vf", "crop=1:1:10:10,format=rgb24", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  assert.deepEqual([...px], [0, 255, 0], "every transform as expected (red: one wasn't)");
});
