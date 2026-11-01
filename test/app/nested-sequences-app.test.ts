// Nested sequences on the packaged app: a clip nested from its menu stays one block on the timeline,
// the preview and the export show what's inside it, ⌘Z and Unnest give the clip back.
// Screenshot: test-output/nested-sequences-timeline.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Project } from "../../packages/core/src/index.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";

const APP = resolve(process.env.UNCUT_TEST_APP ?? "dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 30;
let root = "";
let dir = "";
let saveAs = "";
let app: LaunchedApp | undefined;
let page: Page;
const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const mainIds = () => onDisk().tracks[0]!.items.map((i) => i.id);
const item = (id: string) => `[data-testid=timeline-item][data-item="${id}"]`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function colourOf(path: string, seek?: number) {
  const input = seek === undefined ? ["-i", path] : ["-ss", String(seek), "-i", path];
  const args = ["-v", "error", ...input, "-frames:v", "1", "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", "-"];
  const [r, , b] = [...execFileSync("ffmpeg", args)];
  return r! > b! ? "red" : "blue";
}

async function menuOn(id: string, entry: string) {
  const box = (await (await page.$(item(id)))!.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await page.waitForSelector(`[data-testid=menu-${entry}]`, { timeout: 5000 });
  await page.click(`[data-testid=menu-${entry}]`);
}

async function previewAt(frame: number) {
  await page.mouse.move(5, 5);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < frame / FPS; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await sleep(800);
  const path = join(root, `preview-${frame}.png`);
  await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
  return colourOf(path);
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-nested-app-")));
  saveAs = join(root, "nested.mp4");
  for (const colour of ["red", "blue"])
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${colour}:s=640x360:r=${FPS}`,
      "-t",
      "10",
      "-pix_fmt",
      "yuv420p",
      join(root, `${colour}.mp4`),
    ]);
  const probe = { frames: 10 * FPS, fps: FPS, width: 640, height: 360 };
  dir = writeProject(root, "Nested", {
    format: "uncut/0",
    name: "Nested",
    canvas: { width: 1280, height: 720, fps: FPS },
    media: [
      { id: "m-red", kind: "video", name: "red.mp4", path: join(root, "red.mp4"), probe },
      { id: "m-blue", kind: "video", name: "blue.mp4", path: join(root, "blue.mp4"), probe },
    ],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "c1", type: "clip", media: "m-red", in: 0, duration: 60 },
          { id: "c2", type: "clip", media: "m-blue", in: 30, duration: 60 },
          { id: "c3", type: "clip", media: "m-red", in: 0, duration: 60 },
        ],
      },
    ],
  });
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector(item("c3"), { timeout: 30000 });
});

after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("nest a clip: the preview and the export play what's inside; undo and Unnest give it back", { skip, timeout: 120000 }, async () => {
  await menuOn("c2", "nest");
  await page.waitForFunction(() => document.querySelector('[data-testid=timeline-item][data-type="sequence"]'), { timeout: 8000 });
  assert.deepEqual(mainIds(), ["c1", "nested-1", "c3"]);
  assert.equal(onDisk().sequences![0]!.tracks[0]!.items[0]!.id, "c2");
  await (await page.$("[data-testid=timeline]"))!.screenshot({ path: resolve("test-output", "nested-sequences-timeline.png") });

  assert.equal(await previewAt(90), "blue", "the preview draws the sequence's clip");
  assert.equal(await previewAt(30), "red");

  await page.click("[data-testid=export-button]");
  await page.waitForSelector("[data-testid=export-form]", { timeout: 15000 });
  await page.click("[data-testid=export-change]");
  await page.waitForFunction((name) => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === name, { timeout: 5000 }, "nested.mp4");
  await page.click("[data-testid=export-start]");
  await page.waitForFunction(() => ["done", "failed"].includes(document.querySelector<HTMLElement>("[data-testid=export-job]")?.dataset.phase ?? ""), {
    timeout: 90000,
  });
  assert.equal(await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase), "done");
  assert.deepEqual([colourOf(saveAs, 1), colourOf(saveAs, 3), colourOf(saveAs, 5)], ["red", "blue", "red"]);
  await page.keyboard.press("Escape");
  await sleep(300);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=export-modal]"), { timeout: 5000 });

  await menuOn("nested-1", "unnest");
  await page.waitForSelector(item("c2"), { timeout: 8000 });
  assert.deepEqual(mainIds(), ["c1", "c2", "c3"]);
  assert.equal(onDisk().sequences, undefined);
  await page.keyboard.down("Meta");
  await page.keyboard.press("z");
  await page.keyboard.up("Meta");
  await page.waitForSelector(item("nested-1"), { timeout: 8000 });
});
