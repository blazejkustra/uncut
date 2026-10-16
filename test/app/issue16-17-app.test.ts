// Issues #16 and #17 (D209) on the packaged app, run invisibly and muted, with Chromium's fake
// microphone and a stand-in screen (never desktopCapturer or a real device):
// - #16: a screen's picture (a data: URL, as desktopCapturer gives) shows under the app's CSP; a
//   window with none shows a placeholder (D238: in the screen picker modal).
// - #17: the recording bar (big record button, timer, Pause, Stop, Cancel), the level meter with a
//   peak mark and a dB scale, device pickers and option chips; a paused stretch isn't in the take
//   or its length; while the screen records, the floating mini recorder opens (its own window),
//   shows the timer and its Stop ends the take.
// Screenshots: test-output/issue16-sources.png, issue17-mic.png, issue17-paused.png,
// issue17-screen-recording.png, issue17-mini.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";
import { eventually } from "../helpers/wait.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE_ARGENT = resolve("test/helpers/fake-argent/argent");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (page: Page, name: string) => page.screenshot({ path: resolve("test-output", `${name}.png`) });
const text = (page: Page, selector: string) => page.$eval(selector, (el) => ((el as HTMLElement).innerText ?? "").trim());
const seconds = (file: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue16-17-")));
  const dir = join(root, "Rec.uncut");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "project.json"), JSON.stringify({ format: "uncut/0", name: "Rec", canvas: { width: 1920, height: 1080, fps: 30 }, media: [], tracks: [{ id: "text", kind: "text", name: "Text", items: [] }, { id: "main", kind: "video", role: "main", name: "Main", items: [] }] }));
  writeFileSync(join(root, "argent.jsonl"), "");
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issues 16, 17: source pictures, the recording bar with pause and a peak meter, the floating mini recorder", { skip, timeout: 240000 }, async () => {
  const dir = join(root, "Rec.uncut");
  const app = await launchApp({
    command: APP,
    env: { ARGENT_BIN: FAKE_ARGENT, FAKE_ARGENT_NODE: process.execPath, FAKE_ARGENT_LOG: join(root, "argent.jsonl"), UNCUT_DATA_DIR: join(root, "data"), UNCUT_PLUGINS_DIR: join(root, "no-user-plugins"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) },
  });
  apps.add(app);
  const { page, browser } = app;
  const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=open-project]");
    await page.waitForSelector("[data-testid=editor]");
    await page.click("[data-testid=rail-capture]");

    // #16: the screen's picture loads (a data: URL under the renderer's CSP); the window has none: a placeholder.
    const screenTile = '[data-testid=capture-source][data-id="standin:screen:1"]';
    const windowTile = '[data-testid=capture-source][data-id="standin:window:1"]';
    await page.waitForSelector("[data-testid=capture-pick-source]", { timeout: 15000 });
    await page.click("[data-testid=capture-pick-source]");
    await page.waitForSelector(`${screenTile} img`, { timeout: 15000 });
    await page.waitForFunction((sel) => {
      const img = document.querySelector<HTMLImageElement>(`${sel} img`);
      return !!img && img.complete && img.naturalWidth === 160 && img.src.startsWith("data:image/png");
    }, { timeout: 10000 }, screenTile);
    assert.equal(await page.$eval(screenTile, (el) => (el as HTMLElement).dataset.picture), "thumbnail");
    assert.equal(await page.$eval(windowTile, (el) => (el as HTMLElement).dataset.picture), "none");
    assert.ok(await page.$(`${windowTile} [data-testid=capture-source-placeholder]`));
    await shot(page, "issue16-sources");
    await page.click(screenTile);
    await page.waitForFunction(() => !document.querySelector("[data-testid=capture-source-picker]"));

    // #17: the microphone: a styled picker, the meter with a peak mark and a dB scale, option chips.
    await page.click("[data-testid=capture-src-screen]");
    await page.click("[data-testid=capture-src-voiceover]");
    await page.waitForFunction(() => (document.querySelector<HTMLSelectElement>("[data-testid=capture-mic-device]")?.options.length ?? 0) > 0, { timeout: 15000 });
    assert.ok(await page.$(".picker [data-testid=capture-mic-device]"), "the device list is the app's picker");
    await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=capture-mic-level]")?.dataset.peak ?? 0) > 0.05, { timeout: 15000 });
    const peak = await page.$eval("[data-testid=capture-mic-level]", (el) => ({ level: Number((el as HTMLElement).dataset.level), peak: Number((el as HTMLElement).dataset.peak) }));
    assert.ok(peak.peak >= peak.level, `the peak holds at or above the level: ${JSON.stringify(peak)}`);
    assert.ok(await page.$("[data-testid=capture-level-peak]"));
    assert.deepEqual(await page.$$eval("[data-testid=capture-level-scale] span", (els) => els.map((e) => e.textContent)), ["-60", "-40", "-20", "-12", "-6", "0"]);
    assert.match(await text(page, "[data-testid=capture-level-db]"), /^-?\d+ dB$|^-∞ dB$/);
    assert.equal(await page.$eval("[data-testid=capture-play-timeline]", (el) => (el as HTMLInputElement).checked), true);
    await page.click("[data-testid=capture-mute-timeline]");
    assert.equal(await page.$eval("[data-testid=capture-mute-timeline]", (el) => (el as HTMLInputElement).checked), false, "a chip toggles");
    await page.click("[data-testid=capture-mute-timeline]");
    assert.equal(await page.$$eval(".capture-this-mac input[type=checkbox]", (els) => els.every((e) => e.closest(".opt-chip"))), true, "options are chips, not a column of checkboxes");
    assert.ok(!/[·•∙⋅*]/.test(await text(page, "[data-testid=capture-this-mac]")), "no dots or stars between words");
    await page.$eval("[data-testid=capture-this-mac]", (el) => el.scrollIntoView());
    await shot(page, "issue17-mic");

    // A voiceover with a pause: 1.5 s, 2 s paused, 1.2 s: the take and its length leave the pause out.
    await page.click("[data-testid=capture-take-record]");
    await page.waitForSelector("[data-testid=capture-take-timer]", { timeout: 10000 });
    await sleep(1500);
    await page.click("[data-testid=capture-take-pause]");
    await page.waitForSelector("[data-testid=capture-record-bar][data-state=paused]");
    const pausedAt = await text(page, "[data-testid=capture-take-timer]");
    await shot(page, "issue17-paused");
    await sleep(2000);
    assert.equal(await text(page, "[data-testid=capture-take-timer]"), pausedAt, "the timer stops while paused");
    await page.click("[data-testid=capture-take-resume]");
    await sleep(1200);
    await page.click("[data-testid=capture-take-stop]");
    await page.waitForSelector("[data-testid=capture-take-saved]", { timeout: 30000 });
    const recordedMs = Number(await page.$eval("[data-testid=capture-this-mac]", (el) => (el as HTMLElement).dataset.recordedMs));
    assert.ok(recordedMs > 2300 && recordedMs < 3500, `about 2.7 s recorded, the pause left out: ${recordedMs} ms`);
    const voice = onDisk().media.find((m: { source?: { module: string } }) => m.source?.module === "capture.microphone");
    const fileSeconds = seconds(join(dir, voice.path));
    assert.ok(Math.abs(fileSeconds - recordedMs / 1000) <= 0.35, `the file is ${fileSeconds} s, recorded ${recordedMs} ms`);
    assert.ok(!/mini recorder/.test(app.output()), "no mini recorder for a voiceover");

    // The screen: the mini recorder opens over everything, shows the timer, and its Stop ends the take.
    await page.click("[data-testid=capture-src-voiceover]");
    await page.click("[data-testid=capture-src-screen]");
    await page.waitForSelector('[data-testid=capture-pick-source][data-id="standin:screen:1"]');
    await page.click("[data-testid=capture-take-record]");
    await page.waitForSelector("[data-testid=capture-take-timer]", { timeout: 10000 });
    await page.waitForFunction(() => true);
    let mini: Page | undefined;
    for (let i = 0; i < 100 && !mini; i++) {
      mini = (await browser.pages()).find((p) => p.url().includes("index.html?mini"));
      if (!mini) await sleep(100);
    }
    assert.ok(mini, `the mini recorder's window: ${(await browser.pages()).map((p) => p.url())}`);
    assert.match(app.output(), /\[test\] mini recorder opened: Test screen/);
    await mini.waitForSelector("[data-testid=mini-recorder][data-phase=recording]", { timeout: 10000 });
    await sleep(1300);
    assert.match(await text(mini, "[data-testid=mini-timer]"), /^0:0[1-2]$/);
    assert.ok(await mini.$("[data-testid=mini-pause]"));
    await page.$eval("[data-testid=capture-this-mac]", (el) => el.scrollIntoView());
    await shot(page, "issue17-screen-recording");
    await shot(mini, "issue17-mini");
    await mini.click("[data-testid=mini-stop]");
    await page.waitForFunction(() => /^Test screen \d{8}-\d{6}\.mp4/.test(document.querySelector("[data-testid=capture-take-saved]")?.textContent ?? ""), { timeout: 60000 });
    assert.match(app.output(), /\[test\] mini recorder stop/);
    await eventually(() => /\[test\] mini recorder closed/.test(app.output()));
    assert.match(app.output(), /\[test\] mini recorder closed/);
    assert.ok(onDisk().media.some((m: { source?: { module: string } }) => m.source?.module === "capture.screen"));
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await shot(page, "issue16-17-failure").catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});
