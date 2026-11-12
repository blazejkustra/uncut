// Ranges to chat on the packaged app (background window), through the UI, on three clips over a
// song:
// - a drag on the ruler marks In to Out (drawn while dragging); a click still moves the playhead and
//   the playhead's handle still scrubs;
// - right-click inside the range: Add range to chat puts a chip in the composer; a second range adds
//   a second chip; Export this range opens the dialog on In to Out; Clear range removes the marks.
// Screenshots: test-output/range-part-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";

const APP = resolve(process.env.UNCUT_TEST_APP ?? "dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 30;
let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (name: string) => resolve("test-output", `range-part-${name}.png`);
const data = (selector: string, key: string) => page.$eval(selector, (el, k) => (el as HTMLElement).dataset[k], key);
const playheadFrame = async () => Number(await data("[data-testid=playhead]", "frame"));
const marks = async () => {
  const el = await page.$("[data-testid=marks]");
  if (!el) return undefined;
  return { in: Number(await data("[data-testid=marks]", "in")), out: Number(await data("[data-testid=marks]", "out")) };
};
const near = (actual: number | undefined, expected: number, what: string) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= 2, `${what}: ${actual}, expected about ${expected}`);
const chips = () => page.$$eval("[data-testid=agent-chip]", (els) => els.map((e) => e.textContent ?? ""));
const draft = () => page.$eval("[data-testid=agent-input]", (el) => (el as HTMLTextAreaElement).value);

/** Screen x of timeline frame `f` on the ruler, and a y on its top band. */
async function rulerAt(f: number) {
  const r = (await (await page.$("[data-testid=ruler]"))!.boundingBox())!;
  const ppf = Number(await data("[data-testid=timeline]", "ppf"));
  const scroll = await page.$eval(".bottom-body", (el) => el.scrollLeft);
  return { x: r.x + f * ppf - scroll + 0.5, y: r.y + 10 };
}

/** Press on the ruler at `from`, drag to `to` in steps (⌘ held: no snapping), check while held, release. */
async function dragRuler(from: number, to: number, whileHeld?: () => Promise<void>) {
  const a = await rulerAt(from);
  const b = await rulerAt(to);
  await page.keyboard.down("Meta");
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await whileHeld?.();
  await page.mouse.up();
  await page.keyboard.up("Meta");
}

async function rightClickRuler(f: number, entry: string) {
  const { x, y } = await rulerAt(f);
  await page.mouse.click(x, y, { button: "right" });
  await page.waitForSelector(`[data-testid=menu-${entry}]`, { timeout: 5000 });
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-range-part-app-")));
  for (const [name, src] of [
    ["take-a.mp4", "testsrc2"],
    ["take-b.mp4", "smptebars"],
  ] as const) {
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-threads",
      "2",
      "-filter_threads",
      "2",
      "-f",
      "lavfi",
      "-i",
      `${src}=s=1280x720:r=${FPS}`,
      "-t",
      "20",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-g",
      "30",
      "-pix_fmt",
      "yuv420p",
      join(root, name),
    ]);
  }
  execFileSync("ffmpeg", ["-v", "error", "-y", "-threads", "2", "-f", "lavfi", "-i", "sine=f=220:beep_factor=4:d=20", "-c:a", "aac", join(root, "song.m4a")]);
  const probe = { frames: 20 * FPS, fps: FPS, width: 1280, height: 720, hasAudio: false };
  dir = writeProject(root, "Ranges", {
    format: "uncut/0",
    name: "Ranges",
    canvas: { width: 1920, height: 1080, fps: FPS },
    media: [
      { id: "m-a", kind: "video", name: "take-a.mp4", path: join(root, "take-a.mp4"), probe },
      { id: "m-b", kind: "video", name: "take-b.mp4", path: join(root, "take-b.mp4"), probe },
      { id: "m-song", kind: "audio", name: "song.m4a", path: join(root, "song.m4a"), probe: { frames: 20 * FPS, hasAudio: true } },
    ],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "c1", type: "clip", media: "m-a", in: 0, duration: 150 },
          { id: "c2", type: "clip", media: "m-b", in: 0, duration: 150, locked: true },
          { id: "c3", type: "clip", media: "m-a", in: 300, duration: 150 },
        ],
      },
      { id: "audio", kind: "audio", name: "Song", items: [{ id: "song", type: "audio", media: "m-song", in: 0, start: 0, duration: 450 }] },
    ],
  });
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: FAKE } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector('[data-testid=timeline-item][data-item="c3"]', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector("[data-testid=filmstrip][data-ready=true]"), { timeout: 60000 }).catch(() => {});
  await sleep(500);
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("a drag on the ruler marks In to Out; a click moves the playhead; the handle scrubs", { skip, timeout: 60000 }, async () => {
  assert.equal(await marks(), undefined);
  await dragRuler(60, 210, async () => {
    await page.waitForSelector("[data-testid=marks]", { timeout: 5000 });
    const live = await marks();
    near(live?.in, 60, "In while dragging");
    near(live?.out, 210, "Out while dragging");
  });
  const range = await marks();
  near(range?.in, 60, "In");
  near(range?.out, 210, "Out");
  near(await playheadFrame(), 60, "the playhead at the press");
  assert.ok(await page.$("[data-testid=range-band]"), "the range is shown over the lanes");

  const click = await rulerAt(300);
  await page.mouse.click(click.x, click.y);
  await page.waitForFunction(() => Math.abs(Number(document.querySelector<HTMLElement>("[data-testid=playhead]")!.dataset.frame) - 300) <= 2, { timeout: 5000 });
  assert.deepEqual(await marks(), range, "a click leaves the marks");

  const handle = (await (await page.$("[data-testid=playhead] .playhead-handle"))!.boundingBox())!;
  const to = await rulerAt(380);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, handle.y + handle.height / 2, { steps: 6 });
  await page.mouse.up();
  near(await playheadFrame(), 380, "the handle scrubbed");
  assert.deepEqual(await marks(), range, "scrubbing leaves the marks");

  // I and O still set the marks.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("o");
  await page.waitForFunction(() => Math.abs(Number(document.querySelector<HTMLElement>("[data-testid=marks]")?.dataset.out) - 380) <= 2, { timeout: 5000 });
});

test("right-click a range: Add range to chat, twice; Export this range; Clear range", { skip, timeout: 60000 }, async () => {
  await dragRuler(30, 120);
  await rightClickRuler(75, "add-range-to-chat");
  const entries = await page.$$eval("[data-testid=context-menu] [role=menuitem]", (els) => els.map((e) => (e as HTMLElement).dataset.testid));
  assert.deepEqual(entries.slice(0, 3), ["menu-add-range-to-chat", "menu-export-range", "menu-clear-range"], "the range's own entries come first");
  await page.screenshot({ path: shot("menu") });
  await page.click("[data-testid=menu-add-range-to-chat]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=agent-chip]").length === 1, { timeout: 5000 });

  await dragRuler(240, 390);
  await rightClickRuler(300, "add-range-to-chat");
  await page.click("[data-testid=menu-add-range-to-chat]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=agent-chip]").length === 2, { timeout: 5000 });
  const labels = await chips();
  assert.equal(labels.length, 2, `two range chips: ${labels.join(", ")}`);
  assert.ok(labels.every((l) => /\d+:\d\d(\.\d)?–\d+:\d\d(\.\d)?/.test(l)), `timecode ranges: ${labels.join(", ")}`);
  for (const l of labels) assert.ok((await draft()).includes(l), `${l} in the message`);
  await sleep(200);
  await page.screenshot({ path: shot("chips") });

  await rightClickRuler(300, "export-range");
  await page.click("[data-testid=menu-export-range]");
  await page.waitForSelector("[data-testid=export-modal]", { timeout: 5000 });
  assert.equal(await page.$eval("[data-testid=export-range-marks]", (el) => el.getAttribute("aria-checked")), "true", "In to Out chosen");
  const from = Number(await data("[data-testid=export-range-text]", "from"));
  near(from, 240, "the export starts at In");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=export-modal]"), { timeout: 5000 });

  await rightClickRuler(300, "clear-range");
  await page.click("[data-testid=menu-clear-range]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=marks]"), { timeout: 5000 });
  assert.equal(await page.$("[data-testid=range-band]"), null);
});
