// Phase 3 chunk 3: the packaged app's welcome screen, create/open, and the empty editor
// shell, driven like a user would (native dialogs answered through UNCUT_TEST_DIALOG).
// Screenshots of each state go to test-output/app-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { KeyInput, Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;
const T = { skip, timeout: 90000 };

let root: string, data: string, projects: string, broken: string;
const apps = new Set<LaunchedApp>();
const launch = async (dialogs: Array<unknown> = []) => {
  // Every test shares one data dir, so one app at a time: an app a failed test left open would
  // hold the single-instance lock and make this launch quit at once (#89: one failure became three).
  for (const open of apps) await close(open);
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: data, UNCUT_TEST_DIALOG: JSON.stringify(dialogs) } });
  apps.add(app);
  return app;
};
const close = async (app: LaunchedApp) => {
  await app.close();
  apps.delete(app);
};
const shot = (app: LaunchedApp, name: string) => app.page.screenshot({ path: `test-output/app-${name}.png` });
const text = (page: Page, id: string) => page.$eval(`[data-testid=${id}]`, (el) => el.textContent.trim());
const waitFor = (page: Page, selector: string, timeout = 10000) => page.waitForSelector(selector, { timeout });
const onDisk = (name: string) => JSON.parse(readFileSync(join(projects, `${name}.uncut`, "project.json"), "utf8"));
const waitForDisk = async (name: string, check: (project: any) => boolean) => {
  for (let i = 0; i < 50; i++) {
    try {
      if (check(onDisk(name))) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`project.json of ${name} never matched`);
};
const meta = async (page: Page, key: KeyInput, shift = false) => {
  await page.keyboard.down("Meta");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
};
const typeInto = async (page: Page, selector: string, value: string) => {
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type(selector, value);
};
/** Creates a project through the welcome form; the dialog queue must hold `projects` next. */
async function createThroughForm(page: Page, name: string, preset?: string) {
  await page.click("[data-testid=new-project]");
  await waitFor(page, "[data-testid=new-project-form]");
  await typeInto(page, "[data-testid=project-name]", name);
  if (preset) await page.click(`[data-preset=${preset}]`);
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction((dir: string) => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title === dir, {}, projects);
}
const frameRatio = (page: Page) => page.$eval("[data-testid=preview-frame]", (el) => el.getBoundingClientRect().width / el.getBoundingClientRect().height);

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-welcome-")));
  data = join(root, "data");
  projects = join(root, "projects");
  broken = join(root, "Broken.uncut");
  mkdirSync(projects);
  mkdirSync(broken);
  writeFileSync(join(broken, "project.json"), JSON.stringify({ format: "uncut/0", name: "Broken", canvas: { width: 1920, height: 1080, fps: 30 }, media: [], tracks: [] }));
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("welcome → create → editor shell → rename/undo/redo → hand edit → close → recents → open errors → restart", T, async () => {
  let app = await launch([projects, projects, broken]);
  const { page } = app;

  // Welcome, nothing recent yet.
  await waitForWelcome(page);
  assert.equal(await page.title(), "Uncut");
  await waitFor(page, "[data-testid=no-recents]");
  await shot(app, "welcome-empty");

  // New project through the form.
  await createThroughForm(page, "First Cut");
  await shot(app, "new-project");
  await page.click("[data-testid=create]");
  await waitFor(page, "[data-testid=editor]");
  // A new project opens on the Agent tab (U14); the project's settings are in the Inspector.
  await page.click("[data-testid=tab-inspector]");
  const dir = join(projects, "First Cut.uncut");
  assert.ok(existsSync(join(dir, "project.json")));

  // The empty shell reflects the snapshot.
  assert.equal(await text(page, "project-title"), "First Cut");
  assert.equal(await page.title(), "First Cut");
  assert.equal(await text(page, "canvas-info"), "1920×1080, 30 fps");
  assert.equal(await text(page, "timecode"), "00:00:00:00 / 00:00:00:00");
  const tracks = await page.$$eval("[data-testid=track]", (els) => (els as Array<HTMLElement>).map((e) => [e.textContent.trim(), e.dataset.kind, e.dataset.main ?? null]));
  assert.deepEqual(tracks, [["Text", "text", null], ["Main", "video", "true"], ["Audio", "audio", null]]);
  await waitFor(page, "[data-testid=timeline-empty]");
  assert.match(await text(page, "media-empty"), /No media yet/);
  assert.equal(await page.$eval("[data-testid=import]", (b) => (b as HTMLButtonElement).disabled), false);
  assert.ok(Math.abs((await frameRatio(page)) - 16 / 9) < 0.02, `frame ratio ${await frameRatio(page)}`);
  assert.equal(await text(page, "saved"), "Saved");
  assert.deepEqual(await page.$$eval("[data-testid=undo],[data-testid=redo]", (b) => (b as Array<HTMLButtonElement>).map((x) => x.disabled)), [true, true]);
  await page.click("[data-testid=tab-agent]");
  assert.match(await text(page, "agent-empty"), /No media needed to start/);
  await page.click("[data-testid=tab-inspector]");
  await shot(app, "editor-16x9");

  // Rename in the inspector: saved on disk, title follows, undo becomes available.
  await typeInto(page, "[data-testid=inspector-name]", "Renamed");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.title === "Renamed");
  assert.equal(onDisk("First Cut").name, "Renamed");
  assert.deepEqual(await page.$$eval("[data-testid=undo],[data-testid=redo]", (b) => (b as Array<HTMLButtonElement>).map((x) => x.disabled)), [false, true]);

  // Undo/redo buttons change the file.
  await page.click("[data-testid=undo]");
  await waitForDisk("First Cut", (p) => p.name === "First Cut");
  await page.waitForFunction(() => document.title === "First Cut");
  assert.deepEqual(await page.$$eval("[data-testid=undo],[data-testid=redo]", (b) => (b as Array<HTMLButtonElement>).map((x) => x.disabled)), [true, false]);
  await page.click("[data-testid=redo]");
  await waitForDisk("First Cut", (p) => p.name === "Renamed");
  // ⌘Z outside a text field undoes the project change; ⇧⌘Z redoes it.
  await page.click("[data-testid=timeline]");
  await meta(page, "KeyZ");
  await waitForDisk("First Cut", (p) => p.name === "First Cut");
  await meta(page, "KeyZ", true);
  await waitForDisk("First Cut", (p) => p.name === "Renamed");
  // The field follows the file once the editor hears of the redo (a beat later on a slow machine).
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=inspector-name]")?.value === "Renamed", { timeout: 10000 });

  // Show in Finder (logged instead of opening Finder in test mode).
  await page.click("[data-testid=show-in-finder]");
  for (let i = 0; i < 20 && !app.output().includes(`[test] showItemInFolder ${dir}`); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(app.output().includes(`[test] showItemInFolder ${dir}`), app.output());

  // A hand edit to project.json: the next change is refused, the banner offers a reload.
  const hand = onDisk("First Cut");
  hand.name = "Edited By Hand";
  writeFileSync(join(dir, "project.json"), JSON.stringify(hand, null, 2));
  await typeInto(page, "[data-testid=inspector-name]", "Overwrite?");
  await page.keyboard.press("Enter");
  await waitFor(page, "[data-testid=changed-on-disk]");
  assert.equal(onDisk("First Cut").name, "Edited By Hand");
  await shot(app, "changed-on-disk");
  await page.click("[data-testid=reload]");
  await page.waitForFunction(() => document.title === "Edited By Hand");
  assert.equal(await page.$("[data-testid=changed-on-disk]"), null);

  // ⌘W: back to welcome, and the project is in the recents.
  await page.click("[data-testid=timeline]");
  await meta(page, "KeyW");
  await waitForWelcome(page);
  assert.equal(await page.title(), "Uncut");
  await waitFor(page, "[data-testid=recent]");
  assert.deepEqual(await page.$$eval("[data-testid=recent] .wiz-name", (e) => (e as Array<HTMLElement>).map((x) => x.textContent)), ["Edited By Hand"]);
  await shot(app, "welcome-recents");

  // Clicking the recent opens it again.
  await page.click("[data-testid=recent]");
  await waitFor(page, "[data-testid=editor]");
  assert.equal(await text(page, "project-title"), "Edited By Hand");
  await page.click("[data-testid=close-project]");
  await waitForWelcome(page);

  // A vertical project gets a 9:16 preview.
  await createThroughForm(page, "Tall", "vertical");
  await page.click("[data-testid=create]");
  await waitFor(page, "[data-testid=editor]");
  // A new project opens on the Agent tab (U14); the project's settings are in the Inspector.
  await page.click("[data-testid=tab-inspector]");
  assert.equal(await text(page, "canvas-info"), "1080×1920, 30 fps");
  assert.ok(Math.abs((await frameRatio(page)) - 9 / 16) < 0.02, `frame ratio ${await frameRatio(page)}`);
  await shot(app, "editor-9x16");
  await meta(page, "KeyW");
  await waitForWelcome(page);

  // Open… an invalid project: a readable error, and we stay on the welcome screen.
  await page.click("[data-testid=open-project]");
  await waitFor(page, "[data-testid=welcome-error]");
  const error = await text(page, "welcome-error");
  assert.match(error, /Couldn't open Broken\.uncut/);
  assert.match(error, /tracks/);
  assert.ok(await page.$("[data-testid=welcome]"));
  await shot(app, "open-error");
  assert.deepEqual(app.errors, []);
  await close(app);

  // After a restart the recents are still there, newest first.
  app = await launch();
  await waitFor(app.page, "[data-testid=recent]");
  assert.deepEqual(await app.page.$$eval("[data-testid=recent] .wiz-name", (e) => (e as Array<HTMLElement>).map((x) => x.textContent)), ["Tall", "Edited By Hand"]);
  await shot(app, "welcome-after-restart");
  await close(app);
});

test("the form shows the server's error inline when the folder already exists", T, async () => {
  mkdirSync(join(projects, "Taken.uncut"), { recursive: true });
  const app = await launch([projects]);
  await createThroughForm(app.page, "Taken");
  await app.page.click("[data-testid=create]");
  await waitFor(app.page, "[data-testid=form-error]");
  assert.match(await text(app.page, "form-error"), /already exists/);
  assert.ok(await app.page.$("[data-testid=new-project-form]"));
  await shot(app, "new-project-error");
  await close(app);
});

test("a stalled connection shows Reconnecting… and recovers with the project still open", T, async () => {
  const app = await launch();
  const { page } = app;
  await waitFor(page, "[data-testid=recent]");
  await page.click("[data-testid=recent]");
  await waitFor(page, "[data-testid=editor]");
  const name = await text(page, "project-title");
  const pid = Number(execFileSync("pgrep", ["-P", String(app.proc.pid), "-f", "server/server.mjs"], { encoding: "utf8" }).trim());
  // Freeze the server: its socket stays open but goes silent, so only the ping timeout notices.
  process.kill(pid, "SIGSTOP");
  try {
    await waitFor(page, "[data-testid=connection-banner][data-state=reconnecting]", 15000);
    assert.equal(await page.$eval("[data-testid=inspector-name]", (i) => (i as HTMLButtonElement).disabled), true);
    await shot(app, "reconnecting");
  } finally {
    process.kill(pid, "SIGCONT");
  }
  // Reconnect backoff is capped at 5 s, but a busy machine can take longer to answer again.
  await page.waitForFunction(() => !document.querySelector("[data-testid=connection-banner]"), { timeout: 45000 });
  assert.equal(await text(page, "project-title"), name);
  // And it really talks to the server again.
  await typeInto(page, "[data-testid=inspector-name]", "After Reconnect");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.title === "After Reconnect", { timeout: 5000 });
  assert.deepEqual(app.errors, []);
  await close(app);
});
