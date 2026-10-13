// Phase 7 chunk A (D98) on the packaged app, run invisibly and muted: the Capture tab lists Argent's
// devices (the fake argent via ARGENT_BIN, never the real CLI: it would start the shared
// tool-server), says why the ones it can't record aren't recordable, records the simulator with a
// running timer, Stop puts the take in the Library (Media) as a recording from the bundled Argent
// plugin, and one ⌘Z takes it out again. Screen and Microphone say "Coming later".
// Screenshots: test-output/capture-tab.png, test-output/capture-recording.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE_ARGENT = resolve("test/helpers/fake-argent/argent");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const text = (page: Page, selector: string) => page.$eval(selector, (el) => ((el as HTMLElement).innerText ?? "").trim());
const mediaNames = (page: Page) => page.$$eval("[data-testid=media-tile]", (els) => els.map((e) => (e as HTMLElement).innerText.trim()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-capture-app-")));
  mkdirSync(join(root, "projects"));
  writeFileSync(join(root, "argent.jsonl"), "");
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the Capture tab records a simulator into the Library, and ⌘Z removes the take", { skip, timeout: 180000 }, async () => {
  const app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_PLUGINS_DIR: join(root, "no-user-plugins"),
      UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]),
      ARGENT_BIN: FAKE_ARGENT,
      FAKE_ARGENT_NODE: process.execPath,
      FAKE_ARGENT_LOG: join(root, "argent.jsonl"),
    },
  });
  apps.add(app);
  const { page } = app;
  try {
    await waitFor(page, "[data-testid=welcome]");
    await page.click("[data-testid=new-project]");
    await waitFor(page, "[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor(page, "[data-testid=editor]");

    // The Capture tab: Argent's devices (from the bundled plugin), recordable first.
    await page.click("[data-testid=rail-capture]");
    await waitFor(page, "[data-testid=capture-devices]", 30000);
    const rows = await page.$$eval("[data-testid=capture-device]", (els) => els.map((e) => ({ id: (e as HTMLElement).dataset.id, recordable: (e as HTMLElement).dataset.recordable, text: (e as HTMLElement).innerText })));
    assert.deepEqual(rows.slice(0, 2).map((r) => [r.id, r.recordable]), [["SIM-IPHONE-16", "true"], ["emulator-5554", "true"]]);
    const tv = rows.find((r) => r.id === "SIM-APPLE-TV")!;
    assert.equal(tv.recordable, "false");
    assert.match(tv.text, /Not recordable yet/);
    assert.match(tv.text, /tvOS simulators can't be recorded yet/);
    assert.match(rows.find((r) => r.id === "chromium-cdp-9222")!.text, /Chromium apps can't be recorded yet/);
    assert.match(await text(page, "[data-testid=capture-screen]"), /Coming later/);
    assert.match(await text(page, "[data-testid=capture-mic]"), /Coming later/);
    assert.ok(!/[·•∙⋅*]/.test(await text(page, "[data-testid=capture-library]")), "no dots or stars between words");
    await page.screenshot({ path: "test-output/capture-tab.png" });

    // Record: the row shows a running timer and Stop.
    const iphone = "[data-testid=capture-device][data-id=SIM-IPHONE-16]";
    await page.click(`${iphone} [data-testid=capture-record]`);
    await waitFor(page, `${iphone} [data-testid=capture-stop]`);
    await page.waitForFunction((row) => /0:0[1-9]/.test(document.querySelector(`${row} [data-testid=capture-timer]`)?.textContent ?? ""), { timeout: 10000 }, iphone);
    await sleep(600);
    await page.screenshot({ path: "test-output/capture-recording.png" });
    await page.click(`${iphone} [data-testid=capture-stop]`);
    await waitFor(page, "[data-testid=capture-saved]", 30000);
    assert.match(await text(page, "[data-testid=capture-saved]"), /iPhone 16 \d{8}-\d{6}\.mp4 \(\d+\.\d s\) is in Media/);
    await waitFor(page, `${iphone} [data-testid=capture-record]`);

    // The take is in the Library.
    await page.click("[data-testid=rail-media]");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=media-tile]").length === 1, { timeout: 15000 });
    assert.match((await mediaNames(page))[0]!, /iPhone 16 \d{8}-\d{6}/);
    const dir = join(root, "projects", readdirSync(join(root, "projects")).find((f) => f.endsWith(".uncut"))!);
    const projectFile = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
    assert.equal(projectFile.media.length, 1);
    assert.match(projectFile.media[0].path, /^media\/captures\/iPhone 16 \d{8}-\d{6}\.mp4$/);
    assert.deepEqual(projectFile.media[0].source, { module: "argent.capture", device: "SIM-IPHONE-16" });
    assert.ok(existsSync(join(dir, projectFile.media[0].path)));

    // One ⌘Z takes the recording out again (the file stays in media/captures).
    await page.keyboard.down("Meta");
    await page.keyboard.press("z");
    await page.keyboard.up("Meta");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=media-tile]").length === 0, { timeout: 10000 });

    const log = readFileSync(join(root, "argent.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(!log.some((e) => e.forbidden), "never a server stop, a stop-all or a boot");
    assert.equal(log.filter((e) => e.argv[1] === "screen-recording-start").length, 1);
    assert.equal(log.filter((e) => e.argv[1] === "screen-recording-stop" && !e.completed).length, 1);
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: "test-output/capture-failure.png" }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});
