// A Mac with nothing installed: the packaged app finds its own ffmpeg and whisper-cli, says so in the
// setup checks, and exports with VideoToolbox. Needs pnpm tools:build before pnpm dist; ffmpeg on the
// test's PATH makes the media.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";
import { makeExportFixture, writeProject } from "../helpers/export-fixture.ts";

const CONTENTS = resolve("dist/mac-arm64/Uncut.app/Contents");
const APP = join(CONTENTS, "MacOS/Uncut");
const TOOLS = join(CONTENTS, "Resources/tools");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(join(TOOLS, "bin/ffmpeg"))
  ? "the packaged app has no bundled tools (pnpm tools:build, then pnpm dist)"
  : !hasFfmpeg
    ? "needs ffmpeg to make the test media"
    : false;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
const waitFor = (page: Page, selector: string, timeout = 30000) => page.waitForSelector(selector, { timeout });
const text = (page: Page, id: string) => page.$eval(`[data-testid=${id}]`, (el) => el.textContent ?? "");
const encodedCodec = (file: string) =>
  execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", file], { encoding: "utf8" }).trim();

async function exportAt(page: Page, quality: string) {
  await page.click("[data-testid=export-button]");
  await waitFor(page, "[data-testid=export-form]");
  await page.click(`[data-testid=quality-${quality}]`);
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Standard.mp4");
  await page.click("[data-testid=export-start]");
  await waitFor(page, "[data-testid=export-job][data-phase=done]", 180000);
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-bundled-tools-")));
  dir = writeProject(root, "Export", makeExportFixture(join(root, "media")));
  mkdirSync(join(root, "out"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("with nothing on PATH the app's own tools are ready, and an export works", { skip, timeout: 400000 }, async () => {
  const output = join(root, "out", "Standard.mp4");
  app = await launchApp({
    command: APP,
    cleanEnv: true,
    firstLaunch: true,
    env: {
      HOME: homedir(),
      PATH: "/usr/bin:/bin",
      UNCUT_SHELL_ENV: "off",
      UNCUT_TOOLS_DIR: TOOLS,
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([dir, output]),
    },
  });
  const { page } = app;
  await waitFor(page, "[data-testid=onboarding]");
  await page.click("[data-testid=wizard-continue]");
  await waitFor(page, "[data-testid=check-ffmpeg][data-status=ready]");
  await waitFor(page, "[data-testid=check-whisper][data-status=ready]");
  assert.match(await text(page, "check-ffmpeg"), /Included with Uncut/);
  assert.match(await text(page, "check-whisper"), /Included with Uncut/);
  await page.screenshot({ path: resolve("test-output/bundled-tools-setup.png") });
  await page.click("[data-testid=wizard-skip]");

  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor(page, "[data-testid=editor]");
  await exportAt(page, "standard");
  assert.equal(encodedCodec(output), "h264");
});
