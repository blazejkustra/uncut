// Phase 3 chunk 5 on the packaged app: import the user's real clips through the dialog, drop a
// file onto the library (a real Chromium drag with a file path, via CDP), see tiles with
// thumbnails and the right metadata, and undo. Screenshots: test-output/library-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp } from "../helpers/app.ts";
import { DJI_CLIP, FIRST_FLIGHT, footageMissing } from "../helpers/footage.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const DJI = DJI_CLIP;
const FIRST = FIRST_FLIGHT;
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(APP)
  ? `packaged app not built: run pnpm dist to create ${APP}`
  : !existsSync(DJI) || !existsSync(FIRST)
    ? footageMissing(!existsSync(DJI) ? DJI : FIRST)
    : !hasFfmpeg
      ? "needs ffmpeg for thumbnails"
      : false;

let root: string, app: LaunchedApp;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = (page: Page, selector: string, timeout = 20000) => page.waitForSelector(selector, { timeout });
const shot = (name: string) => app.page.screenshot({ path: `test-output/library-${name}.png` });
const tiles = () => app.page.$$eval("[data-testid=media-tile]", (els) => (els as Array<HTMLElement>).map((e) => ({ id: e.dataset.id, name: e.querySelector("[data-testid=tile-name]")!.textContent, meta: e.querySelector("[data-testid=tile-meta]")!.textContent, dur: e.querySelector("[data-testid=duration]")?.textContent ?? null })));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-library-")));
  mkdirSync(join(root, "projects"));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1280x720", "-frames:v", "1", join(root, "dropped.png")]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=orange:size=320x240", "-frames:v", "1", join(root, "queued.png")]);
  mkdirSync(join(root, "a folder"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("import the drone clips, drop an image, see tiles with thumbnails, undo", { skip, timeout: 180000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects"), [DJI, FIRST]]) } });
  const { page } = app;
  await page.click("[data-testid=new-project]");
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction((dir: string) => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title === dir, {}, join(root, "projects"));
  await page.click("[data-testid=create]");
  await waitFor(page, "[data-testid=media-empty]");

  // Import… through the (test) dialog: both clips in one go. It runs as a server job; while
  // it's running the library shows progress.
  await page.click("[data-testid=import]");
  await waitFor(page, "[data-testid=import-progress]", 10000);
  await shot("importing");
  // A drop while that import runs is queued behind it, not refused.
  const dropBox = await page.$eval("[data-testid=library]", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const cdpEarly = await page.target().createCDPSession();
  const early = { items: [], files: [join(root, "queued.png")], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) await cdpEarly.send("Input.dispatchDragEvent", { type, x: dropBox.x, y: dropBox.y, data: early });
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=media-tile]").length === 3, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector("[data-testid=import-progress]"), { timeout: 60000 });
  await page.click("[data-testid=undo]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=media-tile]").length === 2, { timeout: 60000 });
  // The panel sorts newest first by default (F26); compare the tiles, not their order.
  assert.deepEqual((await tiles()).sort((a, b) => String(a.id).localeCompare(String(b.id))), [
    { id: "m-dji-0005", name: "DJI 0005", meta: "3840×2160, 59.94 fps", dur: "05:35" },
    { id: "m-first-flight", name: "first-flight.mp4", meta: "1920×1080, 30 fps", dur: "00:51" },
  ]);
  // Thumbnails load from the server (not file://) and are real images.
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>("[data-testid=thumb]")].filter((i) => i.complete && i.naturalWidth > 0).length === 2, { timeout: 60000 });
  const srcs = await page.$$eval("[data-testid=thumb]", (imgs) => (imgs as Array<HTMLImageElement>).map((i) => i.src));
  for (const src of srcs) assert.match(src, /^http:\/\/127\.0\.0\.1:\d+\/media\/thumb\/m-[a-z0-9-]+\?token=/);
  const dir = await page.$eval("[data-testid=project-title]", (el) => (el as HTMLElement).title);
  const media = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).media;
  assert.deepEqual(media.map((m: any) => [m.path, m.probe.frames, m.probe.width, m.probe.height]), [
    [DJI, Math.floor(335.6186166 * 30), 3840, 2160],
    [FIRST, 51 * 30, 1920, 1080],
  ]);
  await shot("imported");

  // Drop a file onto the library: a real drag through Chromium carrying a file path.
  const box = await page.$eval("[data-testid=library]", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const cdp = await page.target().createCDPSession();
  const data = { items: [], files: [join(root, "dropped.png")], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) await cdp.send("Input.dispatchDragEvent", { type, x: box.x, y: box.y, data });
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=media-tile]").length === 3, { timeout: 30000 });
  assert.deepEqual((await tiles()).find((t) => t.id === "m-dropped"), { id: "m-dropped", name: "dropped.png", meta: "1280×720", dur: null });
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>("[data-testid=thumb]")].filter((i) => i.complete && i.naturalWidth > 0).length === 3, { timeout: 30000 });
  await shot("dropped");

  // A dropped folder gets a plain answer.
  const folder = { items: [], files: [join(root, "a folder")], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) await cdp.send("Input.dispatchDragEvent", { type, x: box.x, y: box.y, data: folder });
  await waitFor(page, "[data-testid=import-report]");
  assert.match(await page.$eval("[data-testid=import-report]", (el) => el.textContent), /Folders can't be imported yet; drop the files inside\./);
  await shot("folder-dropped");

  // At the minimum window size the timeline hint stays inside the panel.
  await page.evaluate(() => window.resizeTo(800, 500));
  await sleep(500);
  const hint = await page.$eval("[data-testid=timeline-empty]", (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const t = range.getBoundingClientRect();
    return { right: t.right, left: t.left, width: innerWidth };
  });
  assert.ok(hint.right <= hint.width && hint.left >= 0, `hint ${JSON.stringify(hint)}`);
  await shot("min-size");

  // Undo takes the drop back, then the import; redo restores the import.
  await page.click("[data-testid=timeline]");
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyZ");
  await page.keyboard.up("Meta");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=media-tile]").length === 2);
  await page.click("[data-testid=undo]");
  await waitFor(page, "[data-testid=media-empty]");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).media, []);
  await page.click("[data-testid=redo]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=media-tile]").length === 2);
  assert.deepEqual(app.errors, []);
});
