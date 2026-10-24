// Issue #96 (D267) on the packaged app, run invisibly and muted, with the stand-in screen and
// Chromium's fake microphone (never desktopCapturer, a real device or a macOS prompt):
// - the Capture tab's Record button is at the top, above the "what to record" toggles, stands
//   alone (no box around it) and isn't a pill;
// - Record starts at once: the timer, never a 3-2-1; Stop saves the take into Media.
// Screenshots: test-output/issue96-idle.png, issue96-recording.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue96-")));
  const dir = join(root, "Rec.uncut");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Rec",
      canvas: { width: 1920, height: 1080, fps: 30 },
      media: [],
      tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [] }],
    }),
  );
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issue 96: Record at the top, alone and square-ish; a take starts with no countdown", { skip, timeout: 120000 }, async () => {
  const dir = join(root, "Rec.uncut");
  const app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_PLUGINS_DIR: join(root, "no-user-plugins"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) },
  });
  apps.add(app);
  const { page } = app;
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=open-project]");
    await page.waitForSelector("[data-testid=editor]");
    await page.click("[data-testid=rail-capture]");
    await page.waitForSelector("[data-testid=capture-this-mac]");
    // Screen alone (the default), on the stand-in screen.
    await page.waitForSelector('[data-testid=capture-pick-source][data-id="standin:screen:1"]', { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("[data-testid=capture-take-record]")?.disabled, { timeout: 15000 });

    const layout = await page.$eval("[data-testid=capture-this-mac]", (section) => {
      const rec = section.querySelector<HTMLElement>("[data-testid=capture-take-record]")!;
      const toggles = section.querySelector<HTMLElement>("[data-testid=capture-toggles]")!;
      const r = rec.getBoundingClientRect();
      const style = getComputedStyle(rec);
      return {
        above: r.bottom <= toggles.getBoundingClientRect().top,
        // Its parent is the section itself, and nothing between draws a box around it.
        parent: rec.parentElement === section,
        radius: parseFloat(style.borderTopLeftRadius),
        height: r.height,
        width: r.width,
        sectionWidth: section.getBoundingClientRect().width,
        label: rec.innerText.trim(),
      };
    });
    assert.ok(layout.above, "Record is above the toggles");
    assert.ok(layout.parent, "Record isn't inside an extra container");
    assert.ok(layout.radius <= 8, `not a pill: radius ${layout.radius}px on a ${layout.height}px button`);
    assert.ok(layout.width > layout.sectionWidth * 0.6, `Record spans the panel (${layout.width} of ${layout.sectionWidth})`);
    assert.equal(layout.label, "Record screen");
    await page.screenshot({ path: "test-output/issue96-idle.png" });

    // Record: the timer straight away, never a 3-2-1.
    const seen: Array<string> = [];
    await page.evaluate(() => {
      const w = window as unknown as { __seen96: Array<string> };
      w.__seen96 = [];
      new MutationObserver(() => {
        if (document.querySelector("[data-testid=capture-countdown]")) w.__seen96.push("countdown");
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    const clicked = Date.now();
    await page.click("[data-testid=capture-take-record]");
    await page.waitForSelector("[data-testid=capture-take-timer]", { timeout: 10000 });
    const startedIn = Date.now() - clicked;
    assert.ok(startedIn < 2000, `recording started in ${startedIn} ms`);
    seen.push(...(await page.evaluate(() => (window as unknown as { __seen96: Array<string> }).__seen96)));
    assert.deepEqual(seen, [], "no 3-2-1 was shown");
    // Mid-take the timer and controls are where Record was, above the toggles.
    assert.ok(
      await page.$eval(
        "[data-testid=capture-this-mac]",
        (s) =>
          s.querySelector("[data-testid=capture-take-timer]")!.getBoundingClientRect().bottom <=
          s.querySelector("[data-testid=capture-toggles]")!.getBoundingClientRect().top,
      ),
    );
    await sleep(1500);
    await page.screenshot({ path: "test-output/issue96-recording.png" });
    await page.click("[data-testid=capture-take-stop]");
    await page.waitForFunction(() => /^Test screen \d{8}-\d{6}\.mp4/.test(document.querySelector("[data-testid=capture-take-saved]")?.textContent ?? ""), {
      timeout: 60000,
    });
    const recordedMs = Number(await page.$eval("[data-testid=capture-this-mac]", (el) => (el as HTMLElement).dataset.recordedMs));
    assert.ok(recordedMs > 1200 && recordedMs < 4000, `${recordedMs} ms`);
    const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as { media: Array<{ source?: { module: string } }> };
    assert.ok(
      project.media.some((m) => m.source?.module === "capture.screen"),
      "the take is in Media",
    );
  } catch (error) {
    await page.screenshot({ path: "test-output/issue96-failure.png" }).catch(() => {});
    throw error;
  }
});
