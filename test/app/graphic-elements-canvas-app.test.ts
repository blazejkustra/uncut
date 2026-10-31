// D316's canvas leftovers in the packaged editor: a drag and the X, Y fields follow the pointer on a
// graphic with a scaled wrapper, a line of about a pixel can be picked and grabbed, a huge element's box
// stops at the canvas, a graphic that never finishes a frame still shows, and a lengthened item is
// read again.
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

const SCENE = `<style>html,body{background:#141414;margin:0}
#w{position:absolute;left:0;top:0;width:2560px;height:1440px;transform:scale(.5);transform-origin:0 0}
#box{position:absolute;left:200px;top:200px;width:400px;height:300px;background:#e5534b}
#late{position:absolute;left:0;top:0;width:100px;height:100px;background:#2ea043}
#line{position:absolute;left:800px;top:700px;width:1000px;height:2.4px;background:#fff}
#wipe{position:absolute;left:300px;top:400px;width:200px;height:4px;background:#fff}
#huge{position:absolute;left:-10000000px;top:-10000000px;width:20000000px;height:20000000px;background:rgba(0,0,0,.2)}</style>
<div id="w"><div id="huge"></div><div id="box"></div><div id="wipe"></div><div id="line"></div><div id="late"></div></div>
<script>
const show = (id, t, at, out) => { document.getElementById(id).style.visibility = t >= at && t < out ? "visible" : "hidden"; };
function render(t) { show("box", t, 0.5, 3); show("wipe", t, 0.4, 3); document.getElementById("wipe").style.transform = t < 2 ? "scaleX(0)" : "none"; show("line", t, 0.4, 3); show("huge", t, 3.5, 4); show("late", t, 6, 7); }
</script>`;
const STUCK = `<div id="s">stuck</div><script>function render() { return new Promise(() => {}); }</script>`;

const project = (): Project =>
  ({
    format: "uncut/0",
    name: "Canvas",
    canvas: { width: 1280, height: 720, fps: 30 },
    media: [],
    tracks: [
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "g", type: "graphic", src: "graphics/scene.html", duration: 150 }] },
      { id: "under", kind: "video", name: "Under", items: [{ id: "s", type: "graphic", src: "graphics/stuck.html", start: 0, duration: 30 }] },
    ],
  }) as Project;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const block = (key: string) => `[data-testid=element-block][data-element="${key}"]`;
const selection = (key: string) => `[data-testid=element-selection][data-element="${key}"]`;
const saved = () => (JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as Project).tracks[0]!.items[0]!;
const frameRect = () => page.$eval('.pv-graphic[data-item="g"] iframe', (e) => (({ x, y, width }) => ({ x, y, width }))(e.getBoundingClientRect()));

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
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-elements-canvas-")));
  dir = writeProject(root, "Canvas", project());
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "scene.html"), SCENE);
  writeFileSync(join(dir, "graphics", "stuck.html"), STUCK);
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector(block("box"), { timeout: 60000 });
});

after(async () => {
  if (skip) return;
  await app?.close();
  unlockApps();
  rmSync(root, { recursive: true, force: true });
});

test("a graphic that never finishes a frame still shows after the cap", { skip }, async () => {
  await until("shown", () => page.$eval('.pv-graphic[data-item="s"] iframe', (e) => (e as HTMLElement).style.opacity !== "0"));
});

test("on a wrapper scaled by half a drag follows the pointer and X, Y read canvas px", { skip }, async () => {
  await page.click(block("box"));
  await page.waitForSelector(selection("box"), { timeout: 5000 });
  await page.screenshot({ path: "test-output/element-scaled-before.png" });
  const box = (await (await page.$(selection("box")))!.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y + 20, { steps: 6 });
  await page.mouse.up();
  await until("saved", () => saved().elements?.box?.x !== undefined);
  await until("the box followed", async () => {
    const moved = (await (await page.$(selection("box")))!.boundingBox())!;
    return Math.abs(moved.x - box.x - 40) <= 1 && Math.abs(moved.y - box.y - 20) <= 1;
  });
  await page.screenshot({ path: "test-output/element-scaled-after.png" });
  const units = 1280 / (await frameRect()).width;
  const edit = saved().elements!.box!;
  assert.ok(Math.abs(edit.x! - 80 * units) <= 2 * units, `own x ${edit.x}`);
  const field = await page.$eval("[data-testid=element-x] input, input[data-testid=element-x]", (e) => Number((e as HTMLInputElement).value));
  assert.ok(Math.abs(field - 40 * units) <= 2 * units, `the field reads ${field}`);
  await page.click("[data-testid=undo]");
  await until("undone", () => saved().elements === undefined);
});

test("a line of about a pixel is picked from beside it and its box can be grabbed", { skip }, async () => {
  await page.click(block("line"));
  await page.waitForSelector(selection("line"), { timeout: 5000 });
  await page.keyboard.press("Escape");
  await until("nothing selected", async () => (await page.$("[data-testid=element-selection]")) === null);
  const f = await frameRect();
  const units = 1280 / f.width;
  const lineY = f.y + 350 / units;
  await page.mouse.click(f.x + 600 / units, lineY + 4);
  await page.waitForSelector(selection("line"), { timeout: 5000 });
  const area = await page.$eval(selection("line"), (e) => Number(getComputedStyle(e, "::after").height.replace("px", "")));
  assert.ok(area / units >= 11, `the grab area is ${area / units} screen px`);
  await page.mouse.move(f.x + 600 / units, lineY + 4);
  await page.mouse.down();
  await page.mouse.move(f.x + 600 / units + 30, lineY + 4, { steps: 4 });
  await page.mouse.up();
  await until("moved", () => saved().elements?.line?.x !== undefined);
  await page.click("[data-testid=undo]");
  await until("undone", () => saved().elements === undefined);
});

test("a thin element drawn at no width doesn't win the press over what is under it", { skip }, async () => {
  await page.click(block("box"));
  await page.waitForSelector(selection("box"), { timeout: 5000 });
  await page.keyboard.press("Escape");
  await until("nothing selected", async () => (await page.$("[data-testid=element-selection]")) === null);
  const f = await frameRect();
  const units = 1280 / f.width;
  await page.mouse.click(f.x + 200 / units, f.y + 201 / units + 3);
  await page.waitForSelector(selection("box"), { timeout: 5000 });
  await page.keyboard.press("Escape");
});

test("a huge element's box stops at the canvas", { skip }, async () => {
  await page.click(block("huge"));
  await page.waitForSelector(selection("huge"), { timeout: 8000 });
  const box = await page.$eval(selection("huge"), (e) => (e as HTMLElement).style.width);
  assert.equal(box, "1280px");
  await page.keyboard.press("Escape");
});

test("a lengthened item reads its graphic again and the new element appears", { skip }, async () => {
  assert.equal(await page.$(block("late")), null);
  const edge = (await (await page.$('[data-item="g"] [data-testid=trim-end]'))!.boundingBox())!;
  const x = edge.x + edge.width / 2;
  const y = edge.y + edge.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 320, y, { steps: 8 });
  await page.mouse.up();
  await until("longer", () => saved().duration > 225);
  await page.waitForSelector(block("late"), { timeout: 30000 });
});
