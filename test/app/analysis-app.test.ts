// Phase 5 chunk 2 (D66) on the packaged app: the Library's Analyze button and the per-tile progress
// with a stop button. ffmpeg is reached through a shell shim first on PATH that sleeps before the
// loudness run while told to, so the running state can be seen and stopped. A clip without sound
// has no Analyze button. Screenshot: test-output/analysis-running.png.
// Media is generated here with ffmpeg's lavfi sources.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const which = (name: string) => {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};
const FFMPEG = which("ffmpeg");
const FFPROBE = which("ffprobe");
const skip = !existsSync(APP) ? `packaged app not built: run pnpm dist to create ${APP}` : !FFMPEG || !FFPROBE ? "needs ffmpeg" : false;

let root = "";
let shimDir = "";
let app: LaunchedApp | undefined;
const waitFor = (page: Page, selector: string, timeout = 20000) => page.waitForSelector(selector, { timeout });
const ff = (...args: Array<string>) => execFileSync(FFMPEG!, ["-v", "error", "-y", ...args]);
const analysisFiles = (dir: string) => (existsSync(join(dir, ".cache", "analysis")) ? (readdirSync(join(dir, ".cache", "analysis"), { recursive: true }) as Array<string>) : []);

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-analysis-app-")));
  mkdirSync(join(root, "projects"));
  ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000,volume=2", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(root, "Talk.mp4"));
  ff("-f", "lavfi", "-i", "color=0x00A000:size=320x180:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "Still.mp4"));
  shimDir = join(root, "bin");
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, "ffmpeg"), `#!/bin/sh\ncase "$*" in *ebur128*) [ -f "${shimDir}/slow" ] && sleep 30; [ -f "${shimDir}/fail" ] && { sleep 1; echo "Invalid data found when processing input" >&2; exit 1; };; esac\nexec "${FFMPEG}" "$@"\n`);
  chmodSync(join(shimDir, "ffmpeg"), 0o755);
  symlinkSync(FFPROBE!, join(shimDir, "ffprobe"));
  writeFileSync(join(shimDir, "slow"), "");
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("Analyze on a media tile: progress while it runs, Stop leaves nothing in the cache, a second run finishes and caches", { skip, timeout: 180000 }, async () => {
  app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_SHELL_ENV: "off", PATH: `${shimDir}:${dirname(FFMPEG!)}:${process.env.PATH}`, UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects"), [join(root, "Talk.mp4"), join(root, "Still.mp4")]]) },
  });
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=new-project]");
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction((dir: string) => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title === dir, {}, join(root, "projects"));
  await page.click("[data-testid=create]");
  await waitFor(page, "[data-testid=media-empty]");
  await page.click("[data-testid=import]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=media-tile]").length === 2, { timeout: 60000 });
  const dir = await page.$eval("[data-testid=project-title]", (el) => (el as HTMLElement).title);

  assert.equal(await page.$("[data-testid=media-tile][data-id=m-still] [data-testid=analyze]"), null, "no Analyze for a clip without sound");
  await page.click("[data-testid=media-tile][data-id=m-talk] [data-testid=analyze]");
  await waitFor(page, "[data-testid=media-tile][data-id=m-talk] [data-testid=analysis-progress][data-phase=running]");
  assert.match(await page.$eval("[data-testid=analysis-progress]", (el) => (el as HTMLElement).title), /^Analysing the sound… \d+%$/);
  assert.equal(await page.$("[data-testid=media-tile][data-id=m-talk] [data-testid=analyze]"), null, "no second Analyze while it runs");
  await page.screenshot({ path: "test-output/analysis-running.png" });

  await page.click("[data-testid=analysis-cancel]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=analysis-progress]"), { timeout: 10000 });
  await waitFor(page, "[data-testid=media-tile][data-id=m-talk] [data-testid=analyze]");
  assert.deepEqual(analysisFiles(dir), [], "a stopped analysis leaves nothing in .cache/analysis");

  rmSync(join(shimDir, "slow"));
  // A run that fails (here: ffmpeg errors out) says why in the Library instead of quietly going back.
  writeFileSync(join(shimDir, "fail"), "");
  await page.click("[data-testid=media-tile][data-id=m-talk] [data-testid=analyze]");
  await waitFor(page, "[data-testid=analysis-error]", 15000);
  assert.match(await page.$eval("[data-testid=analysis-error]", (el) => el.textContent ?? ""), /Couldn't analyse Talk\.mp4: ffmpeg couldn't read the sound: .*Invalid data/);
  await page.screenshot({ path: "test-output/analysis-failed.png" });
  await page.click("[data-testid=analysis-error] .link-btn");
  rmSync(join(shimDir, "fail"));
  assert.deepEqual(analysisFiles(dir), [], "a failed analysis leaves nothing either");
  await page.click("[data-testid=media-tile][data-id=m-talk] [data-testid=analyze]");
  for (let i = 0; i < 100 && !analysisFiles(dir).some((f) => f.endsWith("loudness.json")); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(analysisFiles(dir).some((f) => /^[0-9a-f]{32}\/loudness\.json$/.test(f)), JSON.stringify(analysisFiles(dir)));
  await page.waitForFunction(() => !document.querySelector("[data-testid=analysis-progress]"), { timeout: 10000 });
  assert.equal(await page.$("[data-testid=analysis-error]"), null);
});
