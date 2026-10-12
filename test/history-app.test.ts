// D71 on the packaged app (background window): two edits by hand, quit, start the app again and
// reopen the project from Recents: ⌘Z still undoes the last edit (history.db). The History tab lists
// the revisions (the undone one struck through), clicking the first one previews it in the viewer,
// Restore brings it back as a new revision, and ⌘Z takes the restore back.
// Screenshots: test-output/history-tab.png, test-output/history-preview.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp } from "./helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = !existsSync(APP) ? `packaged app not built: run pnpm dist to create ${APP}` : false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const waitFor = (selector: string, timeout = 20000) => page.waitForSelector(selector, { timeout });
const texts = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).tracks.filter((t: { kind: string }) => t.kind === "text").flatMap((t: { items: Array<{ text: string }> }) => t.items.map((i) => i.text));
const until = async (check: () => boolean, what: string, timeout = 10000) => {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
const cmdZ = async (shift = false) => {
  await page.keyboard.down("Meta");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press("KeyZ");
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
};
const env = () => ({ UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) });

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-history-app-")));
  dir = join(root, "History.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "History",
      canvas: { width: 1920, height: 1080, fps: 30 },
      media: [],
      tracks: [
        { id: "text", kind: "text", name: "Text", items: [] },
        { id: "main", kind: "video", role: "main", name: "Main", items: [] },
        { id: "audio", kind: "audio", name: "Audio", items: [] },
      ],
    }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("⌘Z works after quitting and reopening; the History tab lists, previews and restores", { skip, timeout: 180000 }, async () => {
  app = await launchApp({ command: APP, env: env() });
  page = app.page;
  await waitFor("[data-testid=welcome]");
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  await page.click("[data-testid=rail-text]");
  await page.click('[data-testid=text-preset][data-preset="title"]');
  await until(() => texts().length === 1, "the title");
  await page.keyboard.press("End");
  await page.click('[data-testid=text-preset][data-preset="lower-third"]');
  await until(() => texts().length === 2, "the lower third");
  assert.deepEqual(texts(), ["Title", "Lower third"]);
  await app.close();
  app = undefined;

  // A new app process: Recents → the project → ⌘Z undoes the lower third added before the quit.
  app = await launchApp({ command: APP, env: env() });
  page = app.page;
  await waitFor("[data-testid=recent]");
  await page.click("[data-testid=recent]");
  await waitFor("[data-testid=editor]");
  await page.waitForFunction(() => !(document.querySelector("[data-testid=undo]") as HTMLButtonElement).disabled, { timeout: 10000 });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await cmdZ();
  await until(() => texts().length === 1, "⌘Z after reopening");
  assert.deepEqual(texts(), ["Title"]);

  await page.click("[data-testid=tab-history]");
  await waitFor("[data-testid=history-panel]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=history-entry]").length === 3, { timeout: 10000 });
  const rows = await page.$$eval("[data-testid=history-entry]", (els) => els.map((el) => [(el as HTMLElement).dataset.kind, (el as HTMLElement).dataset.author, (el as HTMLElement).dataset.current, el.querySelector(".history-what")?.textContent]));
  assert.deepEqual(rows, [
    ["edit", "user", "false", "Add lower third"],
    ["edit", "user", "true", "Add title"],
    ["initial", "import", "true", "Opened project.json: the history starts here"],
  ]);
  assert.equal(await page.$eval("[data-testid=history-count]", (el) => el.textContent), "3 changes");
  // The start of the history is the file's, not "You"; the undone edit says so in words too.
  assert.equal(await page.$eval('[data-testid=history-entry][data-revision="0"] .history-who', (el) => el.textContent), "project.json");
  assert.equal(await page.$$eval("[data-testid=history-not-current]", (els) => els.length), 1);
  assert.equal(await page.$("[data-testid=history-problem]"), null, "history.db is saved");
  await page.screenshot({ path: "test-output/history-tab.png" });

  // Preview the start: the viewer draws the empty project, nothing is saved.
  await page.click('[data-testid=history-entry][data-revision="0"] .history-row');
  await waitFor("[data-testid=history-previewing]");
  await page.waitForFunction(() => document.querySelectorAll(".pv-text").length === 0, { timeout: 5000 });
  assert.deepEqual(texts(), ["Title"], "a preview changes nothing");
  await page.screenshot({ path: "test-output/history-preview.png" });

  // Restore: a new revision (listed on top as a jump), and one ⌘Z takes it back.
  await page.click('[data-testid=history-entry][data-revision="0"] [data-testid=history-restore]');
  await until(() => texts().length === 0, "the restore");
  await page.waitForFunction(() => (document.querySelector("[data-testid=history-entry]") as HTMLElement)?.dataset.kind === "jump", { timeout: 10000 });
  assert.equal(await page.$("[data-testid=history-previewing]"), null, "the preview ended");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await cmdZ();
  await until(() => texts().length === 1, "⌘Z after the restore");
  assert.deepEqual(texts(), ["Title"]);
  assert.deepEqual(app.errors, []);
});
