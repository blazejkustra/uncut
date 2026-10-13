// Phase 3 chunk 3 review fixes, on the packaged app: the UI never shows a state the server
// doesn't have (frozen server, in-flight rename), errors show once and clear, drafts don't
// leak across projects, reload failures are explained, the layout holds at the minimum
// window size, and the New project form behaves. Screenshots: test-output/shell-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { KeyInput, Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root: string, data: string, projects: string, broken: string;
const apps = new Set<LaunchedApp>();
const launch = async (dialogs: Array<unknown> = []) => {
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: data, UNCUT_TEST_DIALOG: JSON.stringify(dialogs) } });
  apps.add(app);
  return app;
};
const close = async (app: LaunchedApp) => {
  await app.close();
  apps.delete(app);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (app: LaunchedApp, name: string) => app.page.screenshot({ path: `test-output/shell-${name}.png` });
const text = (page: Page, id: string) => page.$eval(`[data-testid=${id}]`, (el) => el.textContent.trim());
const exists = async (page: Page, id: string) => (await page.$(`[data-testid=${id}]`)) !== null;
const waitFor = (page: Page, selector: string, timeout = 10000) => page.waitForSelector(selector, { timeout });
const dirOf = (name: string) => join(projects, `${name}.uncut`);
const onDisk = (name: string) => JSON.parse(readFileSync(join(dirOf(name), "project.json"), "utf8"));
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
  if (value) await page.type(selector, value);
};
async function createThroughForm(page: Page, name: string) {
  await page.click("[data-testid=new-project]");
  await waitFor(page, "[data-testid=new-project-form]");
  await typeInto(page, "[data-testid=project-name]", name);
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction((dir: string) => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title === dir, {}, projects);
  await page.click("[data-testid=create]");
  await page.waitForFunction((n: string) => document.title === n, {}, name);
}
const rect = (page: Page, selector: string) => page.$eval(selector, (el) => el.getBoundingClientRect().toJSON());
const serverPid = (app: LaunchedApp) => Number(execFileSync("pgrep", ["-P", String(app.proc.pid), "-f", "server/server.mjs"], { encoding: "utf8" }).trim());

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-shell-")));
  data = join(root, "data");
  projects = join(root, "projects");
  broken = join(root, "Broken.uncut");
  mkdirSync(projects);
  mkdirSync(broken);
  writeFileSync(join(broken, "project.json"), "{ not json");
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("errors, drafts, the New project form, reload failures and the minimum window size", { skip, timeout: 120000 }, async () => {
  const app = await launch([projects, projects, dirOf("Alpha"), broken, projects]);
  const { page } = app;
  await waitFor(page, "[data-testid=welcome]");

  // Escape cancels the New project form.
  await page.click("[data-testid=new-project]");
  await waitFor(page, "[data-testid=new-project-form]");
  await page.keyboard.press("Escape");
  await waitFor(page, "[data-testid=open-project]");
  assert.equal(await exists(page, "new-project-form"), false);

  await createThroughForm(page, "Alpha");
  await meta(page, "KeyW");
  await waitFor(page, "[data-testid=welcome]");
  await createThroughForm(page, "Beta");

  // A half-typed name in Beta must not land on Alpha when Alpha opens (⌘O, focus still in the field).
  await page.click("[data-testid=inspector-name]", { clickCount: 3 });
  await page.type("[data-testid=inspector-name]", "Draft");
  await meta(page, "KeyO");
  await page.waitForFunction(() => document.title === "Alpha");
  await page.click("[data-testid=timeline]");
  await sleep(300);
  assert.equal(onDisk("Alpha").name, "Alpha");
  assert.equal(onDisk("Beta").name, "Beta");
  assert.equal(await page.$eval("[data-testid=inspector-name]", (i) => (i as HTMLInputElement).value), "Alpha");

  // A failed open from inside the editor shows in the editor, not later on the welcome screen.
  await page.click("[data-testid=timeline]");
  await meta(page, "KeyO");
  await waitFor(page, "[data-testid=editor-error]");
  assert.equal(await text(page, "editor-error"), "Couldn't open Broken.uncut. project.json can't be read: it isn't valid JSON.");
  assert.equal(await page.title(), "Alpha");
  // Any success clears it.
  await typeInto(page, "[data-testid=inspector-name]", "Alpha 2");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.title === "Alpha 2");
  assert.equal(await exists(page, "editor-error"), false);

  // A blank name is refused here, in plain words, once (no banner); names are capped at 100.
  await typeInto(page, "[data-testid=inspector-name]", "   ");
  await page.keyboard.press("Enter");
  await waitFor(page, "[data-testid=inspector-error]");
  assert.equal(await text(page, "inspector-error"), "A project needs a name.");
  assert.equal(await exists(page, "editor-error"), false);
  assert.equal(await page.$eval("[data-testid=inspector-name]", (i) => (i as HTMLInputElement).value), "Alpha 2");
  await typeInto(page, "[data-testid=inspector-name]", "x".repeat(120));
  assert.equal((await page.$eval("[data-testid=inspector-name]", (i) => (i as HTMLInputElement).value)).length, 100);
  await page.keyboard.press("Escape");
  assert.equal(onDisk("Alpha").name, "Alpha 2");

  // ⌘N opens the form over the editor; the project stays open until a new one is created.
  await page.click("[data-testid=timeline]");
  await meta(page, "KeyN");
  await waitFor(page, "[data-testid=new-project-modal]");
  assert.ok(await exists(page, "editor"));
  await shot(app, "new-project-over-editor");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=new-project-modal]"));
  assert.equal(await page.title(), "Alpha 2");
  await meta(page, "KeyN");
  await waitFor(page, "[data-testid=new-project-modal]");
  await typeInto(page, "[data-testid=project-name]", "Gamma");
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction((dir: string) => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title === dir, {}, projects);
  await page.click("[data-testid=create]");
  await page.waitForFunction(() => document.title === "Gamma");
  assert.equal(await exists(page, "new-project-modal"), false);

  // The minimum window size: nothing spills out of its panel, with and without a banner.
  // Ask for less than the minimum: the window must stop at 1024×640.
  await page.evaluate(() => window.resizeTo(800, 500));
  await sleep(600);
  const viewport = await page.evaluate(() => [innerWidth, innerHeight]);
  assert.deepEqual(viewport, [1024, 640], `viewport ${viewport}`);
  const checkLayout = async () => {
    const stage = await rect(page, ".stage");
    const transport = await rect(page, ".transport");
    const side = await rect(page, ".side");
    const canvasInfo = await rect(page, "[data-testid=canvas-info]");
    assert.ok(transport.right <= side.left + 1, `transport ${transport.right} spills into the side panel at ${side.left}`);
    assert.ok(canvasInfo.right <= stage.right + 1, "canvas info stays in the stage");
    const frame = await rect(page, "[data-testid=preview-frame]");
    assert.ok(frame.width > 100 && frame.height > 50, `preview ${frame.width}×${frame.height}`);
    // The Inspector scrolls inside its own panel instead of pushing past the window.
    assert.ok((await rect(page, ".side-body")).bottom <= viewport[1] + 1);
  };
  await checkLayout();
  await shot(app, "min-size");

  // A hand edit, then the reload fails (broken file, then a missing folder), explained in the banner.
  const hand = onDisk("Gamma");
  hand.name = "Gamma by hand";
  writeFileSync(join(dirOf("Gamma"), "project.json"), JSON.stringify(hand));
  await typeInto(page, "[data-testid=inspector-name]", "Gamma 2");
  await page.keyboard.press("Enter");
  await waitFor(page, "[data-testid=changed-on-disk]");
  assert.equal(await text(page, "saved"), "Not saved");
  // The refused draft doesn't linger in the field.
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=inspector-name]")!.value === "Gamma");
  await checkLayout();
  await shot(app, "min-size-banner");

  writeFileSync(join(dirOf("Gamma"), "project.json"), "{ broken");
  await page.click("[data-testid=reload]");
  await page.waitForFunction(() => document.querySelector("[data-testid=changed-on-disk-text]")!.textContent!.startsWith("Can't reload"));
  assert.equal(await text(page, "changed-on-disk-text"), "Can't reload. project.json can't be read: it isn't valid JSON.");
  assert.equal(await text(page, "reload"), "Reload again");
  assert.equal(await text(page, "saved"), "Not saved");
  await shot(app, "reload-failed");
  writeFileSync(join(dirOf("Gamma"), "project.json"), JSON.stringify(hand));
  await page.click("[data-testid=reload]");
  await page.waitForFunction(() => document.title === "Gamma by hand");
  assert.equal(await exists(page, "changed-on-disk"), false);
  assert.equal(await text(page, "saved"), "Saved");

  // Folder gone: reload says so, and Close project gets back to a clean welcome screen.
  writeFileSync(join(dirOf("Gamma"), "project.json"), JSON.stringify({ ...hand, name: "again" }));
  await typeInto(page, "[data-testid=inspector-name]", "Gamma 3");
  await page.keyboard.press("Enter");
  await waitFor(page, "[data-testid=changed-on-disk]");
  rmSync(dirOf("Gamma"), { recursive: true });
  await page.click("[data-testid=reload]");
  await page.waitForFunction(() => /folder is gone/.test(document.querySelector("[data-testid=changed-on-disk-text]")!.textContent!));
  await page.click("[data-testid=banner-close-project]");
  await waitFor(page, "[data-testid=welcome]");
  assert.equal(await exists(page, "welcome-error"), false, "no stale error from the editor");
  assert.deepEqual(app.errors, []);
  await close(app);
});

test("a rename sent while the server is frozen ends up exactly as the server has it", { skip, timeout: 120000 }, async () => {
  const app = await launch();
  const { page } = app;
  await waitFor(page, "[data-testid=recent]");
  await page.click("[data-testid=recent]"); // Alpha 2, the newest still on disk
  await waitFor(page, "[data-testid=editor]");
  const name = await page.title();
  const dir = await page.$eval("[data-testid=project-dir]", (el) => (el as HTMLElement).title);
  const pid = serverPid(app);
  await page.click("[data-testid=inspector-name]", { clickCount: 3 });
  await page.type("[data-testid=inspector-name]", "InFlight");
  process.kill(pid, "SIGSTOP");
  try {
    await page.keyboard.press("Enter"); // sent to a server that can't answer
    await waitFor(page, "[data-testid=connection-banner][data-state=reconnecting]", 15000);
    // Offline: every control that needs the server is disabled.
    const disabled = await page.$$eval("[data-testid=close-project],[data-testid=undo],[data-testid=redo],[data-testid=inspector-name]", (els) => (els as Array<HTMLButtonElement>).map((e) => e.disabled));
    assert.deepEqual(disabled, [true, true, true, true]);
    await shot(app, "frozen");
    // Hold past the 15 s call timeout, so the rename's outcome is unknown to the window.
    await sleep(17000);
  } finally {
    process.kill(pid, "SIGCONT");
  }
  await page.waitForFunction(() => !document.querySelector("[data-testid=connection-banner]"), { timeout: 20000 });
  // Whatever the server did, the window must agree with project.json once it settles.
  let disk;
  for (let i = 0; i < 30; i++) {
    disk = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).name;
    if ((await page.title()) === disk && (await page.$eval("[data-testid=inspector-name]", (i) => (i as HTMLInputElement).value)) === disk) break;
    await sleep(200);
  }
  assert.equal(await page.title(), disk);
  assert.equal(await page.$eval("[data-testid=inspector-name]", (i) => (i as HTMLInputElement).value), disk);
  assert.equal(await page.$eval("[data-testid=undo]", (b) => (b as HTMLButtonElement).disabled), disk === name, "Undo matches whether the rename happened");
  assert.equal(await exists(page, "editor-error"), false, "no stale connection error after reconnecting");
  assert.equal(await exists(page, "inspector-error"), false);
  console.log(`# in-flight rename: server ${disk === "InFlight" ? "applied" : "dropped"} it`);
  assert.deepEqual(app.errors, []);
  await close(app);
});
