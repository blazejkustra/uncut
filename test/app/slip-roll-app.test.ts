// Slip and roll on the packaged app: the tools' keys under two keymaps' defaults, a drag with each
// tool as one undoable edit, and nothing else on the timeline moving. The slip view: a double click
// on a clip opens its whole media with the clip's part as a window; ← / →, ⌘Z and a click on the
// strip move it without touching the project, Esc leaves it, Done slips once (one ⌘Z).
// Screenshots: test-output/slip-roll-timeline.png, test-output/slip-view.png.
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
let app: LaunchedApp | undefined;
let page: Page;
const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const clip = (id: string) => onDisk().tracks[0]!.items.find((i) => i.id === id)!;
const selector = (id: string) => `[data-testid=timeline-item][data-item="${id}"]`;
const pressed = (tool: string) => page.waitForSelector(`[data-testid=tool-${tool}][aria-checked=true]`, { timeout: 5000 });
const until = (done: () => boolean) =>
  new Promise<void>((ok, fail) => {
    const start = Date.now();
    const look = () => (done() ? ok() : Date.now() - start > 8000 ? fail(new Error("timed out")) : setTimeout(look, 50));
    look();
  });

async function dragOn(id: string, side: number, dx: number) {
  const box = (await (await page.$(selector(id)))!.boundingBox())!;
  const x = box.x + box.width * side;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await new Promise((r) => setTimeout(r, 100));
  await page.mouse.up();
}

const undo = async () => {
  await page.keyboard.down("Meta");
  await page.keyboard.press("z");
  await page.keyboard.up("Meta");
};

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-slip-roll-app-")));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=640x360:r=${FPS}`, "-t", "20", "-pix_fmt", "yuv420p", join(root, "take.mp4")]);
  dir = writeProject(root, "Trim", {
    format: "uncut/0",
    name: "Trim",
    canvas: { width: 1280, height: 720, fps: FPS },
    media: [{ id: "m-a", kind: "video", name: "take.mp4", path: join(root, "take.mp4"), probe: { frames: 20 * FPS, fps: FPS, width: 640, height: 360 } }],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "c1", type: "clip", media: "m-a", in: 100, duration: 150 },
          { id: "c2", type: "clip", media: "m-a", in: 300, duration: 150 },
          { id: "c3", type: "clip", media: "m-a", in: 100, duration: 150 },
        ],
      },
    ],
  });
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector(selector("c3"), { timeout: 30000 });
});

after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("Y slips and N rolls by dragging on the timeline, one undo each", { skip, timeout: 60000 }, async () => {
  await page.keyboard.press("y");
  await pressed("slip");
  await dragOn("c2", 0.5, 40);
  await until(() => clip("c2").in! < 300);
  assert.equal(clip("c2").duration, 150);
  assert.equal(clip("c1").duration, 150);
  await undo();
  await until(() => clip("c2").in === 300);

  await page.keyboard.press("n");
  await pressed("roll");
  await dragOn("c2", 0.8, 40);
  await until(() => clip("c2").duration > 150);
  const moved = clip("c2").duration - 150;
  assert.equal(clip("c3").duration, 150 - moved);
  assert.equal(clip("c3").in, 100 + moved);
  await (await page.$("[data-testid=timeline]"))!.screenshot({ path: resolve("test-output", "slip-roll-timeline.png") });
  await undo();
  await until(() => clip("c2").duration === 150);

  await dragOn("c2", 0.2, 40);
  await until(() => clip("c1").duration > 150);
  assert.equal(clip("c2").in! - 300, clip("c1").duration - 150);
  await page.keyboard.press("v");
  await pressed("select");
});

test("a double click opens the slip view: moves are its own until Done, which is one undo", { skip, timeout: 90000 }, async () => {
  const windowAt = () => page.$eval("[data-testid=slip-window]", (el) => Number((el as HTMLElement).dataset.offset));
  const offsetIs = (n: number) =>
    page.waitForFunction((want) => document.querySelector<HTMLElement>("[data-testid=slip-window]")?.dataset.offset === String(want), { timeout: 5000 }, n);
  const open = async () => {
    const box = (await (await page.$(selector("c2")))!.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount: 2 });
    await page.waitForSelector("[data-testid=slip-modal]", { timeout: 5000 });
  };
  // The test before leaves the cut before c2 rolled: c2 starts where it left it.
  const from = clip("c2").in!;
  const others = [clip("c1").in, clip("c1").duration, clip("c2").duration, clip("c3").in];
  await open();
  assert.equal(await page.$("[data-testid=item-rename]"), null, "a double click on a clip slips it, not renames it");
  assert.equal(await page.$eval("[data-testid=slip-window]", (el) => (el as HTMLElement).dataset.start), String(from));
  await page.waitForSelector("[data-testid=slip-strip] [data-testid=filmstrip][data-ready=true]", { timeout: 30000 });
  await page.waitForSelector("[data-testid=slip-video]", { timeout: 5000 });

  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await offsetIs(3);
  await undo();
  await offsetIs(2);
  await page.keyboard.down("Meta");
  await page.keyboard.down("Shift");
  await page.keyboard.press("z");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
  await offsetIs(3);
  assert.equal(clip("c2").in, from, "nothing changes until Done");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=slip-modal]"), { timeout: 5000 });
  assert.equal(clip("c2").in, from, "Esc leaves the clip as it was");

  // A click on the strip, left of the window: the window jumps there.
  await open();
  const strip = (await (await page.$("[data-testid=slip-strip]"))!.boundingBox())!;
  await page.mouse.click(strip.x + strip.width * 0.1, strip.y + strip.height / 2);
  await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=slip-window]")?.dataset.offset) < -100, { timeout: 5000 });
  const slipped = await windowAt();
  // The picture above is the window's first frame.
  await page.waitForFunction(
    (fps) => {
      const v = document.querySelector<HTMLVideoElement>("[data-testid=slip-video]");
      return !!v && !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - (Number(v.dataset.frame) + 0.5) / fps) < 0.01;
    },
    { timeout: 5000 },
    FPS,
  );
  await page.mouse.move(5, 5);
  await page.screenshot({ path: resolve("test-output", "slip-view.png") });
  await page.click("[data-testid=slip-done]");
  await until(() => clip("c2").in === from + slipped);
  await page.waitForFunction(() => !document.querySelector("[data-testid=slip-modal]"), { timeout: 5000 });
  assert.deepEqual([clip("c1").in, clip("c1").duration, clip("c2").duration, clip("c3").in], others, "nothing else moves");
  await undo();
  await until(() => clip("c2").in === from);
});
