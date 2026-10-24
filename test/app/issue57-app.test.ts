// Issue #57 (D230) on the packaged app: timeline tools.
// - C picks the blade (button pressed, its own cursor); hovering a clip shows the cut line, a click
//   cuts there (one edit, one ⌘Z); the cut snaps to the playhead; a locked track refuses with a reason.
// - Holding H switches to the hand only while it's down; a tap keeps it, and dragging scrolls.
// - V and the picker's buttons go back to select.
// Screenshots: test-output/issue57-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test clips") : `packaged app not built: run pnpm dist to create ${APP}`;
const FPS = 30;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", `issue57-${name}.png`);

type Saved = { id: string; start?: number; gap?: number; duration: number; linkedTo?: string };
const onDisk = (): { tracks: Array<{ id: string; role?: string; items: Array<Saved> }> } => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const mainItems = () => onDisk().tracks.find((t) => t.role === "main")!.items;
const mainIds = () => mainItems().map((i) => i.id);
const saved = (id: string) => mainItems().find((i) => i.id === id);
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) =>
  page.waitForFunction(
    (r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r,
    { timeout: 10000 },
    n,
  );
const ppf = () => page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
const itemSel = (id: string) => `[data-testid=timeline-item][data-item="${id}"]`;
const box = async (selector: string) => {
  const b = await (await page.$(selector))?.boundingBox();
  assert.ok(b, `no box for ${selector}`);
  return b;
};
const withKeys = async (keys: ReadonlyArray<"Meta" | "Shift">, press: Parameters<Page["keyboard"]["press"]>[0]) => {
  for (const k of keys) await page.keyboard.down(k);
  await page.keyboard.press(press);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
};
const lanesBox = () => box("[data-testid=lanes]");
const toolOn = (id: string) => page.$eval(`[data-testid=tool-${id}]`, (el) => el.getAttribute("aria-pressed") === "true");
const waitTool = (id: string) =>
  page.waitForFunction((t) => document.querySelector("[data-testid=lanes]")?.getAttribute("data-tool") === t, { timeout: 5000 }, id);
/** The pointer over a lane's item at a (fractional) timeline frame. */
async function hover(id: string, frame: number) {
  const lanes = await lanesBox();
  const item = await box(itemSel(id));
  await page.mouse.move(lanes.x + frame * (await ppf()), item.y + item.height / 2, { steps: 3 });
}
const bladeLine = () =>
  page
    .$eval("[data-testid=blade-line]", (el) => ({
      frame: Number((el as HTMLElement).dataset.frame),
      item: (el as HTMLElement).dataset.item,
      snapped: (el as HTMLElement).dataset.snapped === "true",
      refused: (el as HTMLElement).dataset.refused === "true",
    }))
    .catch(() => undefined);
const items = (track: string) => onDisk().tracks.find((t) => t.id === track)!.items;

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue57-")));
  const clip = (name: string, colour: string) =>
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${colour}:s=320x180:r=30:d=4`,
      "-f",
      "lavfi",
      "-i",
      "sine=f=440:sample_rate=48000:d=4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      join(root, name),
    ]);
  clip("red.mp4", "red");
  clip("green.mp4", "green");
  const probe = { frames: 120, fps: 30, width: 320, height: 180, hasAudio: true };
  dir = join(root, "Tools.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Tools",
      canvas: { width: 1280, height: 720, fps: FPS },
      media: ["red", "green"].map((c) => ({ id: `m-${c}`, kind: "video", name: `${c}.mp4`, path: join(root, `${c}.mp4`), probe })),
      tracks: [
        { id: "text", kind: "text", name: "Text", items: [] },
        {
          id: "main",
          kind: "video",
          role: "main",
          name: "Main",
          items: ["red", "green"].map((c) => ({ id: c, type: "clip", media: `m-${c}`, in: 0, duration: 120 })),
        },
        { id: "music", kind: "audio", name: "Music", locked: true, items: [{ id: "tune", type: "audio", media: "m-red", in: 0, start: 0, duration: 120 }] },
      ],
    }),
  );
  writeFileSync(join(root, "plan.json"), "[]");
  app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: FAKE, FAKE_PLAN: join(root, "plan.json") },
  });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector(itemSel("green"), { timeout: 15000 });
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "issue #57: tool picker and keys; the blade cuts where its line shows (snapped), one ⌘Z, never on a locked track; a held key switches only while down; the hand scrolls",
  { skip, timeout: 120000 },
  async () => {
    try {
      // ---- Select is the tool to begin with; C picks the blade (button and cursor follow) ----
      assert.ok(await toolOn("select"));
      await page.keyboard.press("Escape");
      await page.keyboard.press("c");
      await waitTool("blade");
      assert.ok(await toolOn("blade"));
      assert.match(await page.$eval(itemSel("green"), (el) => getComputedStyle(el).cursor), /url\(/, "the blade's own cursor");

      // ---- Hover green at 6 s: the line shows where it will cut; a click cuts there, one edit ----
      await hover("green", 180.2);
      await page.waitForSelector("[data-testid=blade-line]");
      const line = (await bladeLine())!;
      assert.equal(line.item, "green");
      assert.ok(Math.abs(line.frame - 180) <= 1, `line at ${line.frame}`);
      await page.screenshot({ path: out("hover") });
      let r = await revision();
      await page.mouse.down();
      await page.mouse.up();
      await waitRevision(r + 1);
      assert.deepEqual(mainIds(), ["red", "green", "green-1"]);
      assert.equal(saved("green")!.duration, line.frame - 120);
      assert.equal(saved("green-1")!.duration, 240 - line.frame);
      await page.screenshot({ path: out("cut") });
      // ⌘Z: the cut is one step.
      await withKeys(["Meta"], "KeyZ");
      await waitRevision(r + 2);
      assert.deepEqual(mainIds(), ["red", "green"]);
      assert.equal(saved("green")!.duration, 120);

      // ---- Snapping: with the playhead at 5 s, a press just past it cuts on it ----
      await page.keyboard.press("Home");
      await page.keyboard.down("Shift");
      for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
      await page.keyboard.up("Shift");
      await hover("green", 150.6);
      await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=blade-line]")?.dataset.snapped === "true", { timeout: 3000 });
      assert.equal((await bladeLine())!.frame, 150);
      r = await revision();
      await page.mouse.down();
      await page.mouse.up();
      await waitRevision(r + 1);
      assert.equal(saved("green")!.duration, 30);
      await withKeys(["Meta"], "KeyZ");
      await waitRevision(r + 2);

      // ---- A locked track: the line says no, a click cuts nothing and says why ----
      await hover("tune", 60.3);
      await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=blade-line]")?.dataset.refused === "true", { timeout: 3000 });
      r = await revision();
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForFunction(() => /locked/.test(document.querySelector("[data-testid=editor-error]")?.textContent ?? ""), { timeout: 5000 });
      await sleep(300);
      assert.equal(await revision(), r, "nothing was sent");
      assert.equal(items("music").length, 1);

      // ---- Hold H: the hand only while it's down, then the blade again ----
      await page.keyboard.down("h");
      await waitTool("hand");
      await sleep(400);
      await page.keyboard.up("h");
      await waitTool("blade");

      // ---- Tap H: the hand stays; dragging scrolls the zoomed-in timeline and edits nothing ----
      await page.keyboard.press("h");
      await sleep(100);
      assert.ok(await toolOn("hand"));
      for (let i = 0; i < 4; i++) await page.keyboard.press("=");
      await page.$eval(".bottom-body", (el) => void (el.scrollLeft = 0));
      assert.equal(await page.$eval(itemSel("red"), (el) => getComputedStyle(el).cursor), "grab");
      const red = await box(itemSel("red"));
      r = await revision();
      await page.mouse.move(red.x + red.width / 2, red.y + red.height / 2);
      await page.mouse.down();
      await page.mouse.move(red.x + red.width / 2 - 200, red.y + red.height / 2, { steps: 8 });
      await page.mouse.up();
      const scrolled = await page.$eval(".bottom-body", (el) => el.scrollLeft);
      assert.ok(Math.abs(scrolled - 200) <= 2, `scrolled ${scrolled}`);
      await sleep(300);
      assert.equal(await revision(), r, "the hand edits nothing");

      // ---- V: back to select, from the button too ----
      await page.keyboard.press("v");
      await waitTool("select");
      await page.click("[data-testid=tool-blade]");
      await waitTool("blade");
      await page.click("[data-testid=tool-select]");
      await waitTool("select");
      assert.deepEqual(app!.errors, []);
    } catch (error) {
      await page.screenshot({ path: out("failure") }).catch(() => {});
      throw error;
    }
  },
);
