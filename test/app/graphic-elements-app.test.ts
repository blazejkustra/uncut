// D316: a graphic's elements in the packaged editor. A graphic whose script times everything shows
// as blocks; a block selected on the timeline is selected in the Inspector and on the canvas, a
// press on the canvas selects the block; a drag retimes it as one saved, undoable edit, and the
// page follows; ⌫ deletes the element, not the graphic; a graphic on one canvas says why it's one block.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Project } from "../../packages/core/src/index.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : "packaged app not built: run pnpm dist";

const GRAPHIC = `<style>html,body{background:#141414}
.b{position:absolute;left:100px;top:100px;width:300px;height:200px}
#a{background:#e5534b}#b{left:600px;background:#2ea043}</style>
<div id="a" class="b"></div><div id="b" class="b"></div>
<script>
const show = (id, t, at, out) => { document.getElementById(id).style.visibility = t >= at && t < out ? "visible" : "hidden"; };
function render(t) { show("a", t, 1, 3); show("b", t, 4, 6); }
</script>`;
const CANVAS = `<canvas id="c" width="1280" height="720"></canvas><script>function render(t) { document.getElementById("c").getContext("2d").fillRect(0, 0, t * 10, 10); }</script>`;

const project = (): Project =>
  ({
    format: "uncut/0",
    name: "Elements",
    canvas: { width: 1280, height: 720, fps: 30 },
    media: [],
    tracks: [
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "g", type: "graphic", src: "graphics/scene.html", duration: 210 }] },
      { id: "over", kind: "video", name: "Over", items: [{ id: "c", type: "graphic", src: "graphics/flat.html", start: 0, duration: 60 }] },
    ],
  }) as Project;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const block = (key: string) => `[data-testid=element-block][data-element="${key}"]`;
const saved = () => (JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as Project).tracks[0]!.items[0]!;

async function until(what: string, check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await sleep(100);
  }
  assert.fail(`never: ${what}`);
}

before(async () => {
  if (skip) return;
  await lockApps();
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-elements-app-")));
  dir = writeProject(root, "Elements", project());
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "scene.html"), GRAPHIC);
  writeFileSync(join(dir, "graphics", "flat.html"), CANVAS);
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector(block("a"), { timeout: 60000 });
});

after(async () => {
  if (skip) return;
  await app?.close();
  unlockApps();
  rmSync(root, { recursive: true, force: true });
});

test("blocks at the script's own times; a canvas graphic says why it's one block", { skip }, async () => {
  const span = (key: string) => page.$eval(block(key), (e) => [Number((e as HTMLElement).dataset.from), Number((e as HTMLElement).dataset.to)]);
  const [from, to] = await span("a");
  assert.ok(Math.abs(from! - 30) <= 4 && Math.abs(to! - 90) <= 4, `a at ${from}-${to}`);
  const [bFrom] = await span("b");
  assert.ok(Math.abs(bFrom! - 120) <= 4, `b at ${bFrom}`);
  await page.waitForSelector("[data-testid=elements-none]", { timeout: 30000 });
  const why = await page.$eval("[data-testid=elements-none]", (e) => e.getAttribute("title"));
  assert.match(why!, /one canvas/);
});

test("selecting works from the timeline and from the canvas", { skip }, async () => {
  const selected = () =>
    page.evaluate(() => [
      document.querySelector(".el-block.selected")?.getAttribute("data-element"),
      document.querySelector(".el-row.on")?.getAttribute("data-element"),
    ]);
  await page.click(block("b"));
  await until("selected on the timeline", async () => (await selected()).join() === "b,b");
  await page.waitForSelector('[data-testid=element-selection][data-element="b"]', { timeout: 5000 });
  const box = (await (await page.$("[data-testid=element-selection]"))!.boundingBox())!;
  await page.keyboard.press("Escape");
  await until("nothing selected", async () => (await selected()).join() === ",");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await until("selected from the canvas", async () => (await selected()).join() === "b,b");
});

test("a canvas drag saves x and y as one edit and undo and redo follow; pressing an element leaves playback alone", { skip }, async () => {
  const history = () => page.$eval("[data-testid=undo]", (e) => (e as HTMLButtonElement).disabled);
  const playing = () => page.$eval("[data-testid=play]", (e) => e.innerHTML);
  const before = await playing();
  await page.click(block("b"));
  await page.waitForSelector('[data-testid=element-selection][data-element="b"]', { timeout: 5000 });
  const handle = await page.$("[data-testid=element-selection]");
  const box = (await handle!.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.click(x, y);
  await sleep(200);
  assert.equal(await playing(), before, "a press doesn't play or pause");
  assert.equal(await history(), true, "a press edits nothing");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y + 20, { steps: 6 });
  await page.mouse.up();
  await until("saved", () => saved().elements?.b?.x !== undefined);
  const edit = saved().elements!.b!;
  const units = 1280 / (await page.$eval(".pv-graphic iframe", (e) => e.getBoundingClientRect().width));
  assert.ok(Math.abs(edit.x! - 40 * units) <= 2 * units && Math.abs(edit.y! - 20 * units) <= 2 * units, `saved ${edit.x},${edit.y} at ${units} units a pixel`);
  await page.click("[data-testid=undo]");
  await until("undone", () => saved().elements === undefined);
  await page.click("[data-testid=redo]");
  await until("redone", () => saved().elements?.b?.x === edit.x);
  await page.click("[data-testid=undo]");
  await until("undone again", () => saved().elements === undefined);
});

test("a drag retimes as one edit, the page follows, undo takes it back, ⌫ deletes only the element", { skip }, async () => {
  const r = (await (await page.$(block("a")))!.boundingBox())!;
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + 60, r.y + r.height / 2, { steps: 6 });
  await page.mouse.up();
  await until("saved", () => saved().elements?.a?.in !== undefined);
  const edit = saved().elements!.a!;
  assert.ok(edit.in! > edit.from![0]!);
  assert.equal(edit.out! - edit.in!, edit.from![1]! - edit.from![0]!, "a move keeps its length");
  await page.click("[data-testid=undo]");
  await until("undone", () => saved().elements === undefined);
  await page.click(block("a"));
  await page.keyboard.press("Backspace");
  await until("deleted", () => saved().elements?.a?.hidden === true);
  assert.equal(saved().id, "g");
  await until("its block leaves the canvas", async () => (await page.$(block("a"))) === null);
});
