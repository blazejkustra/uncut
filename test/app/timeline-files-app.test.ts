// FCPXML in the packaged app: the Export dialog saves the timeline and says what it left out.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { makeExportFixture, writeProject } from "../helpers/export-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
const apps = new Set<LaunchedApp>();

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-timeline-app-")));
  dir = writeProject(root, "Edit", makeExportFixture(join(root, "media")));
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("export dialog: Save timeline writes an FCPXML next to the video and lists what's left out", { skip, timeout: 120000 }, async () => {
  const app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([dir, join(root, "Edit export.mp4")]),
      UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts"),
    },
  });
  apps.add(app);
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click("[data-testid=export-button]");
  await page.waitForSelector("[data-testid=export-form]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Edit export.mp4");
  await page.click("[data-testid=export-timeline-save]");
  await page.waitForSelector("[data-testid=export-timeline-saved]", { timeout: 15000 });
  const said = await page.$eval("[data-testid=export-timeline-saved]", (el) => el.textContent ?? "");
  assert.match(said, /Saved Edit export\.fcpxml\./);
  assert.match(said, /left out/);
  await page.$eval("[data-testid=export-timeline-saved]", (el) => el.scrollIntoView());
  await page.screenshot({ path: resolve("test-output", "timeline-saved.png") });
  const text = readFileSync(join(root, "Edit export.fcpxml"), "utf8");
  assert.match(text, /<fcpxml version="1\.10">/);
  assert.match(text, /Cross Dissolve/);
});
