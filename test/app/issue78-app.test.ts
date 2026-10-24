// Issue #78 (D257) on the packaged app, run invisibly: customisable shortcuts with presets.
// - Settings › Shortcuts: split's S is rebound to X by clicking it and pressing X; a key another
//   action has (J) asks to swap or replace; Esc while listening cancels without closing Settings.
// - In the editor X splits, S no longer does.
// - The Premiere Pro preset: it asks first, the user having changed a key (D273; Esc cancels, no
//   dialog without changes; Reset all asks too); split is ⌘K (and works), the toolbar's tooltip shows ⌘K.
// - The keymap is remembered (localStorage).
// Screenshots: test-output/issue78-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", `issue78-${name}.png`);
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const rect = (selector: string) => page.$eval(selector, (el) => el.getBoundingClientRect().toJSON() as DOMRect);
const mainCount = () =>
  (JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as { tracks: Array<{ role?: string; items: Array<unknown> }> }).tracks.find(
    (t) => t.role === "main",
  )!.items.length;
const waitMain = (n: number) =>
  page
    .waitForFunction((count) => document.querySelectorAll("[data-testid=timeline-item]").length === count, { timeout: 10000 }, n)
    .then(async () => {
      for (let i = 0; i < 40 && mainCount() !== n; i++) await sleep(100);
      assert.equal(mainCount(), n, "items on disk");
    });
const rowKeys = (action: string) =>
  page.$$eval(`[data-testid=shortcut-row][data-action=${action}] [data-testid=shortcut-key]`, (els) => els.map((e) => e.textContent ?? ""));
const meta = async (key: Parameters<Page["keyboard"]["press"]>[0]) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key);
  await page.keyboard.up("Meta");
};
/** A click on a Settings control, scrolled to the middle first (the sticky head never covers it). */
async function press(selector: string) {
  await page.$eval(selector, (el) => el.scrollIntoView({ block: "center" }));
  await page.click(selector);
}
/** The playhead to a frame (a click on the ruler). */
async function seek(frame: number) {
  const ruler = await rect("[data-testid=ruler]");
  const lanes = await rect("[data-testid=lanes]");
  const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
  await page.mouse.click(lanes.left + frame * ppf, ruler.top + ruler.height - 6);
  await page.waitForFunction(
    (f) => Math.abs(Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) - f) < 3,
    { timeout: 5000 },
    frame,
  );
}
async function openShortcuts() {
  await meta(",");
  await waitFor("[data-testid=settings]");
  await page.click("[data-testid=settings-nav-shortcuts]");
  await waitFor("[data-testid=shortcut-settings]");
}
async function closeSettings() {
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=settings]"), { timeout: 3000 });
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue78-")));
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=640x360:rate=30",
    "-t",
    "10",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    join(root, "Shot.mp4"),
  ]);
  dir = join(root, "Keys.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Keys",
      canvas: { width: 1920, height: 1080, fps: 30 },
      media: [
        {
          id: "m-shot",
          kind: "video",
          name: "Shot.mp4",
          path: join(root, "Shot.mp4"),
          probe: { frames: 300, fps: 30, width: 640, height: 360, hasAudio: false },
        },
      ],
      tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "a", type: "clip", media: "m-shot", in: 0, duration: 300 }] }],
    }),
  );
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  await waitFor("[data-testid=timeline-item]");
  await page.click("[data-testid=bottom-timeline]");
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issue #78: rebind split, use the new key, switch to Premiere Pro, tooltip shows the new key", { skip, timeout: 180000 }, async (t) => {
  t.after(async () => void (await page.screenshot({ path: out("last") }).catch(() => {})));
  await openShortcuts();
  assert.deepEqual(await rowKeys("split"), ["S", "⌘B"]);
  assert.equal(await page.$eval("[data-testid=shortcut-preset]", (el) => (el as HTMLSelectElement).value), "uncut");

  // Click S, press X: split is X and ⌘B.
  await press("[data-testid=shortcut-row][data-action=split] [data-testid=shortcut-key][data-key=S]");
  await waitFor("[data-testid=shortcut-row][data-action=split] [data-testid=shortcut-recording]");
  await page.screenshot({ path: out("recording") });
  await page.keyboard.press("x");
  await page.waitForFunction(() => !document.querySelector("[data-testid=shortcut-recording]"), { timeout: 3000 });
  assert.deepEqual(await rowKeys("split"), ["X", "⌘B"]);

  // Esc while listening cancels; Settings stays open.
  await press("[data-testid=shortcut-row][data-action=split] [data-testid=shortcut-add]");
  await waitFor("[data-testid=shortcut-recording]");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=shortcut-recording]"), { timeout: 3000 });
  assert.ok(await page.$("[data-testid=settings]"), "Settings still open");
  assert.deepEqual(await rowKeys("split"), ["X", "⌘B"]);

  // J is Play backwards: a conflict, with Replace (and Swap, when a key is being replaced).
  await press("[data-testid=shortcut-row][data-action=split] [data-testid=shortcut-key][data-key=X]");
  await waitFor("[data-testid=shortcut-recording]");
  await page.keyboard.press("j");
  await waitFor("[data-testid=shortcut-row][data-action=split] [data-testid=shortcut-conflict]");
  assert.match(await page.$eval("[data-testid=shortcut-conflict]", (el) => el.textContent ?? ""), /J.*already Play backwards/);
  assert.ok(await page.$("[data-testid=shortcut-swap]"));
  await page.screenshot({ path: out("conflict") });
  await press("[data-testid=shortcut-cancel]");
  assert.deepEqual(await rowKeys("split"), ["X", "⌘B"]);
  assert.deepEqual(await rowKeys("shuttleBack"), ["J"]);
  await page.screenshot({ path: out("settings-rebound") });
  await closeSettings();

  // In the editor: X splits, S doesn't.
  await waitMain(1);
  await seek(100);
  await page.keyboard.press("s");
  await sleep(600);
  assert.equal(mainCount(), 1, "S no longer splits");
  await page.keyboard.press("x");
  await waitMain(2);

  // The keymap is remembered on this Mac.
  const saved = JSON.parse((await page.evaluate(() => localStorage.getItem("uncut.keymap"))) ?? "{}") as { overrides?: { split?: Array<string> } };
  assert.deepEqual(saved.overrides?.split, ["X", "⌘B"]);

  // Premiere Pro: split is ⌘K.
  await openShortcuts();
  // D273: the user's own change would go, so the preset asks first; Esc keeps everything (and Settings).
  await page.select("[data-testid=shortcut-preset]", "premiere");
  await waitFor("[data-testid=shortcut-preset-confirm] [role=alertdialog]", 3000);
  assert.match(
    await page.$eval("[data-testid=shortcut-preset-confirm]", (el) => el.textContent ?? ""),
    /Switch to Premiere Pro\?.*replace the 1 shortcut you changed/,
  );
  await page.screenshot({ path: out("preset-confirm") });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=shortcut-preset-confirm]"), { timeout: 3000 });
  assert.ok(await page.$("[data-testid=settings]"), "Settings still open after Esc in the dialog");
  assert.equal(await page.$eval("[data-testid=shortcut-preset]", (el) => (el as HTMLSelectElement).value), "uncut", "Cancel keeps the preset");
  assert.deepEqual(await rowKeys("split"), ["X", "⌘B"], "Cancel keeps the user's keys");
  await page.select("[data-testid=shortcut-preset]", "premiere");
  await waitFor("[data-testid=shortcut-preset-ok]", 3000);
  await page.click("[data-testid=shortcut-preset-ok]");
  await page.waitForFunction(() => document.querySelector("[data-testid=shortcut-row][data-action=split] [data-testid=shortcut-key]")?.textContent === "⌘K", {
    timeout: 3000,
  });
  assert.deepEqual(await rowKeys("split"), ["⌘K"]);
  assert.deepEqual(await rowKeys("fit"), ["\\"]);
  assert.deepEqual(await rowKeys("toolBlade"), ["C"]);
  assert.equal(await page.$("[data-testid=shortcut-conflicts]"), null, "no conflicts in the preset");
  await page.screenshot({ path: out("premiere") });
  await closeSettings();

  await seek(200);
  await page.keyboard.press("x");
  await sleep(600);
  assert.equal(mainCount(), 2, "X is gone with the preset");
  await meta("k");
  await waitMain(3);

  // The toolbar's Split tooltip shows ⌘K.
  await page.mouse.move(5, 300);
  await sleep(700);
  const split = await rect("[data-testid=split]");
  await page.mouse.move(split.left + split.width / 2, split.top + split.height / 2);
  await waitFor("[data-testid=tooltip]", 3000);
  const keys = await page.$$eval("[data-testid=tooltip] kbd", (els) => els.map((e) => e.textContent ?? ""));
  assert.deepEqual(keys, ["⌘K"]);
  await sleep(250);
  await page.screenshot({ path: out("tooltip-premiere") });

  // The ? sheet lists the preset's keys too.
  await page.mouse.move(5, 300);
  await page.keyboard.press("?");
  await waitFor("[data-testid=shortcuts-sheet]");
  const sheetSplit = await page.$$eval("[data-testid=shortcuts-sheet] [data-testid=shortcut-row][data-action=split] kbd", (els) =>
    els.map((e) => e.textContent ?? ""),
  );
  assert.deepEqual(sheetSplit, ["⌘K"]);
  // D256: the View menu's layout keys are on the sheet too, fixed.
  const viewKeys = await page.$$eval("[data-testid=shortcuts-sheet] [data-testid=shortcut-row]", (rows) =>
    rows
      .filter((r) => ["toggleLeft", "toggleRight", "toggleTimeline", "focusMode"].includes(r.getAttribute("data-action") ?? ""))
      .map((r) => [...r.querySelectorAll("kbd")].map((k) => k.textContent).join(" ")),
  );
  assert.deepEqual(viewKeys, ["⇧⌘L", "⇧⌘I", "⇧⌘T", "⇧⌘F"]);
  await page.$eval("[data-testid=shortcuts-sheet] [data-testid=shortcut-row][data-action=focusMode]", (el) => el.scrollIntoView({ block: "center" }));
  await sleep(200);
  await page.screenshot({ path: out("sheet-view-keys") });
  await page.keyboard.press("Escape");
  // ...and in Settings › Shortcuts with a lock, nothing to record.
  await openShortcuts();
  for (const id of ["toggleLeft", "toggleRight", "toggleTimeline", "focusMode"]) {
    const row = `[data-testid=shortcut-row][data-action=${id}]`;
    assert.ok(await page.$(`${row}.fixed .shortcut-lock`), `${id}: locked`);
    assert.equal(await page.$(`${row} [data-testid=shortcut-add]`), null, `${id}: no + to record`);
  }
  await page.$eval("[data-testid=shortcut-row][data-action=focusMode]", (el) => el.scrollIntoView({ block: "center" }));
  await sleep(200);
  await page.screenshot({ path: out("view-keys-locked") });

  // D273: with no changes of the user's, a preset applies at once (nothing to lose, no dialog).
  await page.select("[data-testid=shortcut-preset]", "uncut");
  await page.waitForFunction(() => document.querySelector("[data-testid=shortcut-row][data-action=split] [data-testid=shortcut-key]")?.textContent === "S", {
    timeout: 3000,
  });
  assert.equal(await page.$("[data-testid=shortcut-preset-confirm]"), null, "no dialog without changes");
  assert.deepEqual(await rowKeys("split"), ["S", "⌘B"]);
  // Reset all asks too; Reset all in the dialog drops the change.
  await press("[data-testid=shortcut-row][data-action=split] [data-testid=shortcut-remove]");
  assert.deepEqual(await rowKeys("split"), ["⌘B"]);
  await press("[data-testid=shortcuts-reset-all]");
  await waitFor("[data-testid=shortcut-preset-confirm]", 3000);
  assert.match(
    await page.$eval("[data-testid=shortcut-preset-confirm]", (el) => el.textContent ?? ""),
    /Reset all shortcuts\?.*Uncut's keys replace the 1 shortcut you changed/,
  );
  await page.screenshot({ path: out("reset-all-confirm") });
  await page.click("[data-testid=shortcut-preset-ok]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=shortcut-preset-confirm]"), { timeout: 3000 });
  assert.deepEqual(await rowKeys("split"), ["S", "⌘B"]);
  assert.equal(await page.$("[data-testid=shortcut-customised]"), null);
  await closeSettings();
  assert.deepEqual(app!.errors, []);
});
