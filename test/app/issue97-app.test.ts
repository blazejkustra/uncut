// Issue #97 (D268) on the packaged app, run invisibly: the Generate tab's Picture models no longer
// include "Title card by Claude" (titles are text items the agent makes). Claude's own model and
// the keyed ones stay. Screenshot: test-output/issue97-generate.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let app: LaunchedApp | undefined;

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue97-")));
  const dir = join(root, "Issue97.uncut");
  mkdirSync(dir);
  writeFileSync(join(dir, "project.json"), JSON.stringify({ format: "uncut/0", name: "Issue97", canvas: { width: 1920, height: 1080, fps: 30 }, textLooks: 1, media: [], tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [] }] }));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issue #97: no 'Title card by Claude' in the Generate tab", { skip, timeout: 120000 }, async () => {
  app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_PLUGINS_DIR: join(root, "no-user-plugins"),
      UNCUT_TEST_DIALOG: JSON.stringify([join(root, "Issue97.uncut")]),
      UNCUT_CLAUDE: FAKE,
      UNCUT_OPENAI_BASE: "http://127.0.0.1:9",
      UNCUT_GOOGLE_BASE: "http://127.0.0.1:9",
      UNCUT_ELEVENLABS_BASE: "http://127.0.0.1:9",
    },
  });
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click("[data-testid=rail-generate]");
  await page.waitForSelector("[data-testid=generator][data-id='generate.gpt-image']", { timeout: 15000 });
  const ids = await page.$$eval("[data-testid=generator][data-soon=false]", (els) => els.map((e) => (e as HTMLElement).dataset.id));
  assert.deepEqual(ids, ["generate.svg", "generate.gpt-image"]);
  const panel = await page.$eval("[data-testid=generate-library]", (el) => (el as HTMLElement).innerText);
  assert.doesNotMatch(panel, /title card/i);
  assert.match(panel, /SVG drawing/);
  assert.doesNotMatch(panel, /by Claude|Anthropic/, "D277: no Claude or Anthropic in a feature name");
  await page.screenshot({ path: resolve("test-output", "issue97-generate.png") });
  assert.deepEqual(app.errors, []);
});
