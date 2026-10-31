// D316: element edits through the real rasteriser and a real scan. The script times everything
// itself (as argent-100s does) and knows nothing of edits. Measured: the scan reads its elements;
// no edits draw exactly as a document without them; a moved element at frame f is the file's
// element at f - shift, pixel for pixel; a stretched one keeps its entrance and exit; a deleted
// one is gone though the script keeps drawing it; canvases and motion-blur sub-frames follow.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  GRAPHIC_SCAN,
  graphicDocument,
  graphicElementsFrom,
  graphicInfo,
  planElementEdit,
  scanTimes,
  type Item,
  type Project,
  type ScannedElement,
} from "../../packages/core/src/index.ts";
import { graphicElementsOf } from "../../apps/server/src/export/graphicElements.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../../apps/server/src/export/rasterizer.ts";

const DESKTOP = process.env.UNCUT_TEST_DESKTOP ?? resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";

const canvas = { width: 320, height: 180, fps: 30 };
const HTML = `<style>html,body{background:#141414}
#wrap{position:absolute;inset:0}
.b{position:absolute;width:80px;height:60px;top:60px}
#a{left:20px;background:#e5534b}#b{left:120px;background:#2ea043}#c{left:220px;top:60px;width:80px;height:60px;position:absolute}
#t{position:absolute;left:20px;top:140px;font:600 24px 'DM Sans',sans-serif;color:#fff}</style>
<div id="wrap"><div id="a" class="b"></div><div id="b" class="b"></div><canvas id="c" width="80" height="60"></canvas><div id="t"></div></div>
<script>
const $ = (id) => document.getElementById(id);
const show = (el, t, at, out) => { const on = t >= at && t < out; el.style.visibility = on ? "visible" : "hidden"; el.style.transform = on ? "translateY(" + Math.round(Math.max(0, 20 - (t - at) * 60)) + "px)" : "none"; };
function render(t) {
  show($("a"), t, 1, 3);
  show($("b"), t, 4, 6);
  show($("c"), t, 2, 5);
  const ctx = $("c").getContext("2d"); ctx.clearRect(0, 0, 80, 60); ctx.fillStyle = "#99daff"; ctx.fillRect(0, 0, 80, Math.min(60, (t - 2) * 30));
  const words = "Hello"; show($("t"), t, 0.5, 6); $("t").textContent = words.slice(0, Math.max(0, Math.round((t - 0.5) * 5)));
}
</script>`;

let root: string;
let raster: Rasterizer;
const doc = graphicDocument(HTML, canvas);

before(async () => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), "uncut-elements-"));
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  raster = await startRasterizer(command);
});

after(async () => {
  if (skip) return;
  await raster?.close();
  rmSync(root, { recursive: true, force: true });
});

const pixels = (file: string) => execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 26 });
let n = 0;
async function frame(item: Partial<Item>, f: number, document = doc, ts?: ReadonlyArray<number>): Promise<Buffer> {
  const out = join(root, `f${n++}.png`);
  await raster.render({
    kind: "graphic",
    width: canvas.width,
    height: canvas.height,
    doc: document,
    t: f / canvas.fps,
    ...(ts ? { ts } : {}),
    info: graphicInfo({ duration: 200, ...item }, canvas, f),
    out,
  });
  return pixels(out);
}
const same = (a: Buffer, b: Buffer, why: string) => assert.equal(Buffer.compare(a, b), 0, why);
const differ = (a: Buffer, b: Buffer, why: string) => assert.notEqual(Buffer.compare(a, b), 0, why);
const at = (px: Buffer, x: number, y: number) => [...px.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 3)];
const RED = [229, 83, 75];

test("a scan reads a script's buried timing", { skip }, async () => {
  const ts = scanTimes(200 / 30, 6000);
  const reply = await raster.render({
    kind: "graphic-scan",
    width: canvas.width,
    height: canvas.height,
    doc,
    info: graphicInfo({ duration: 200 }, canvas, 0) as never,
    ts,
  });
  const found = graphicElementsFrom((reply as { scan: ReadonlyArray<ScannedElement> }).scan, ts, 30, 200);
  const span = (key: string) => found.elements.find((e) => e.key === key)!.from;
  for (const [key, a, b] of [
    ["a", 30, 90],
    ["b", 120, 180],
    ["c", 60, 150],
  ] as const) {
    assert.ok(Math.abs(span(key)[0] - a) <= 4, `${key} starts ${span(key)}`);
    assert.ok(Math.abs(span(key)[1] - b) <= 4, `${key} ends ${span(key)}`);
  }
  assert.equal(found.elements.find((e) => e.key === "t")!.text, "Hello");
  assert.equal(
    found.elements.some((e) => e.key === "wrap"),
    false,
  );
});

test("no edits draw exactly what a document without the element code draws", { skip }, async () => {
  const bare = doc.replace(
    /<script>\(\(\) => \{\n\s*\/\/ The first and last moments[\s\S]*?window\.__uncutElements = [^\n]*\n\}\)\(\);<\/script>/,
    "<script>window.__uncutElements = { restore() {}, clear() {} };</script>",
  );
  assert.notEqual(bare, doc);
  for (const f of [0, 40, 100, 130]) same(await frame({}, f), await frame({}, f, bare), `frame ${f}`);
});

test("a moved element is the file's element, later, on its own", { skip }, async () => {
  const elements = { a: { from: [30, 90] as const, in: 60, out: 120 } };
  const before = await frame({}, 40);
  assert.deepEqual(at(before, 60, 90), RED);
  const moved = await frame({ elements }, 70);
  const plain = await frame({}, 40);
  for (let x = 20; x < 100; x++) for (let y = 40; y < 125; y++) assert.deepEqual(at(moved, x, y), at(plain, x, y), `${x},${y}`);
  assert.notDeepEqual(at(await frame({ elements }, 40), 60, 90), RED, "not there before its new start");
  assert.notDeepEqual(at(await frame({ elements }, 125), 60, 90), RED, "gone after its new end");
  assert.deepEqual(at(await frame({ elements }, 100), 60, 90), RED, "there past the file's end");
});

test("a stretched element keeps its entrance and exit; a shorter one too", { skip }, async () => {
  const longer = { a: { from: [30, 90] as const, in: 30, out: 150 } };
  const entrance = await frame({}, 32);
  same(await frame({ elements: longer }, 32), entrance, "entrance at the file's pace");
  assert.deepEqual(at(await frame({ elements: longer }, 120), 60, 90), RED, "held through the longer middle");
  const shorter = { a: { from: [30, 90] as const, in: 30, out: 45 } };
  assert.notDeepEqual(at(await frame({ elements: shorter }, 46), 60, 90), RED, "gone at its new end");
  assert.deepEqual(at(await frame({ elements: shorter }, 44), 60, 90), RED);
});

test("a deleted element stays gone though the script draws it; moved and styled ones keep their script", { skip }, async () => {
  const px = await frame({ elements: { a: { hidden: true } } }, 40);
  assert.notDeepEqual(at(px, 60, 90), RED);
  const shifted = await frame({ elements: { a: { x: 100, y: -20 } } }, 60);
  assert.deepEqual(at(shifted, 160, 70), RED, "x and y add to the script's own transform");
  assert.notDeepEqual(at(shifted, 60, 90), RED);
});

test("taking an edit away restores the page in the same document (the preview's case)", { skip }, async () => {
  const plain = await frame({}, 40);
  await frame({ elements: { a: { hidden: true }, t: { text: "Changed", sourceLength: 5 }, b: { from: [120, 180], in: 30, out: 90 } } }, 40);
  same(await frame({}, 40), plain, "nothing of the edits left");
});

test("a retimed canvas keeps its pixels, a new text types as the old one did", { skip }, async () => {
  const canvasMoved = await frame({ elements: { c: { from: [60, 150] as const, in: 90, out: 180 } } }, 110);
  same(canvasMoved.subarray(0, 4), canvasMoved.subarray(0, 4), "sanity");
  assert.deepEqual(at(canvasMoved, 240, 65), [153, 218, 255], "the canvas as it was 30 frames earlier");
  const typedHalf = await frame({ elements: { t: { text: "Goodbye you", sourceLength: 5 } } }, 45);
  const typedAll = await frame({ elements: { t: { text: "Goodbye you", sourceLength: 5 } } }, 120);
  differ(typedHalf, typedAll, "still typing at 1.5 s");
});

test("a text with a line break keeps all of its new text", { skip }, async () => {
  const html = `<style>html,body{background:#000}#h{position:absolute;left:0;top:0;margin:0;font:20px sans-serif;color:#fff;white-space:nowrap}</style><h1 id="h">Lines<br>so</h1><script>function render() {}</script>`;
  const document = graphicDocument(html, canvas);
  const reply = await raster.render({
    kind: "graphic-scan",
    width: 320,
    height: 180,
    doc: document,
    info: graphicInfo({ duration: 200 }, canvas, 0) as never,
    ts: [0, 1],
  });
  const scanned = (reply as { scan: ReadonlyArray<ScannedElement> }).scan[0]!;
  assert.equal(scanned.plain, true);
  const op = planElementEdit({ id: "g" }, { key: "h", from: [0, 200], text: scanned.text.replace(/\s+/g, " ") }, { text: "MMMMMMMMMM" }) as unknown as {
    set: { elements: Item["elements"] };
  };
  const whole = await frame({ elements: { h: { text: "MMMMMMMMMM" } } }, 10, document);
  same(await frame({ elements: op.set.elements! }, 10, document), whole, "nothing cut off");
});

test("markup with blocks, ids or drawings inside isn't plain text", { skip }, async () => {
  const html = `<div id="scene"><h2>Title</h2><p>Body</p></div><h1 id="head">Hi <span>you</span></h1><h1 id="named">Hi <span id="n">you</span></h1><script>function render() {}</script>`;
  const reply = await raster.render({
    kind: "graphic-scan",
    width: 320,
    height: 180,
    doc: graphicDocument(html, canvas),
    info: graphicInfo({ duration: 200 }, canvas, 0) as never,
    ts: [0],
  });
  const plain = Object.fromEntries((reply as { scan: ReadonlyArray<ScannedElement> }).scan.map((e) => [e.key, e.plain]));
  assert.deepEqual([plain.scene, plain.head, plain.named], [false, true, false]);
});

test("a retimed element waits for what its script holds the frame for", { skip }, async () => {
  const html = `<style>html,body{background:#000}#c{position:absolute;left:0;top:0}</style><canvas id="c" width="100" height="100"></canvas>
<script>function render(t) { const x = document.getElementById("c").getContext("2d"); window.__uncutMedia.hold(new Promise((r) => setTimeout(r, 30)).then(() => { x.fillStyle = t < 1 ? "#ff0000" : "#0000ff"; x.fillRect(0, 0, 100, 100); })); }</script>`;
  const document = graphicDocument(html, canvas);
  const moved = await frame({ elements: { c: { from: [0, 30], in: 45, out: 75 } } }, 50, document);
  assert.deepEqual(at(moved, 50, 50), [255, 0, 0], "its own moment's picture");
});

test("motion blur's sub-frames each go through the edit", { skip }, async () => {
  const elements = { a: { from: [30, 90] as const, in: 60, out: 120 } };
  const ts = [70 / 30, 70.25 / 30, 70.5 / 30, 70.75 / 30];
  const moved = await frame({ elements }, 70, doc, ts);
  const plain = await frame(
    {},
    40,
    doc,
    ts.map((t) => t - 1),
  );
  assert.deepEqual(at(moved, 60, 90), at(plain, 60, 90));
});

test("the graphic-scan request is the page function's", () => {
  assert.match(readFileSync("apps/desktop/src/render.ts", "utf8"), /GRAPHIC_SCAN/);
  assert.match(GRAPHIC_SCAN, /__uncutRender/);
});

test("two items of one file with different props get their own scan; a slow scan is kept for a day", { skip }, async () => {
  const html = `<style>div{position:absolute;width:40px;height:40px;background:#fff}</style><div id="a"></div><div id="b"></div><script>
function render(t, info) {
  const late = info?.props?.late ? 4 : 1;
  document.getElementById("a").style.visibility = t >= late && t < late + 1 ? "visible" : "hidden";
  document.getElementById("b").style.visibility = t >= 3 && t < 3.5 ? "visible" : "hidden";
}
</script>`;
  const dir = join(root, "props.uncut");
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "p.html"), html);
  process.env.UNCUT_RENDER_ENTRY = DESKTOP;
  const item = (id: string, props?: unknown) => ({ id, type: "graphic", src: "graphics/p.html", duration: 180, ...(props ? { props } : {}) });
  const project = {
    format: "uncut/0",
    name: "P",
    canvas,
    media: [],
    tracks: [{ id: "v", kind: "video", role: "main", name: "Main", items: [item("one"), item("two", { late: true })] }],
  } as unknown as Project;
  const paths = { graphicLibsDir: resolve("assets/graphic-libs"), fontsDir: resolve("assets/fonts"), dataDir: join(root, "data") };
  const startOf = async (id?: string) =>
    (await graphicElementsOf(paths, "ffmpeg", dir, project, "graphics/p.html", id)).elements.find((e) => e.key === "a")?.from[0];
  const early = await startOf("one");
  const late = await startOf("two");
  assert.ok(early !== undefined && late !== undefined && late - early > 60, `a at ${early} and ${late}`);

  const folder = join(dir, ".cache", "graphic-elements");
  const [one, two] = readdirSync(folder);
  const slow = { elements: [], reason: "Uncut couldn't read this graphic's elements (too long). It stays one block: edit it as a whole." };
  for (const file of [one!, two!]) writeFileSync(join(folder, file), JSON.stringify({ length: 180, result: slow, slowAt: Date.now() }));
  assert.equal((await graphicElementsOf(paths, "ffmpeg", dir, project, "graphics/p.html", "one")).reason, slow.reason, "kept, no new scan");
  const dayOld = Date.now() - 25 * 3600_000;
  for (const file of [one!, two!]) writeFileSync(join(folder, file), JSON.stringify({ length: 180, result: slow, slowAt: dayOld }));
  assert.equal(await startOf("one"), early, "a day later it is tried again");
});
