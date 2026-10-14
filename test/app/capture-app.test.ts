// Phase 7 chunk A (D98) on the packaged app, run invisibly and muted: the Capture tab lists Argent's
// devices (the fake argent via ARGENT_BIN, never the real CLI: it would start the shared
// tool-server), says why the ones it can't record aren't recordable, records the simulator with a
// running timer, Stop puts the take in the Library (Media) as a recording from the bundled Argent
// plugin, and one ⌘Z takes it out again. (This Mac's microphone, camera and screen: capture-this-mac-app.test.ts.)
// D143: This Mac comes first; a shut-down simulator has "Boot and record" (the fake counts one boot,
// only after the click) and records with the options (orientation, an app to open, show touches);
// a saved flow picked in the options plays while recording (no Stop; it ends with the flow).
// Screenshots: test-output/capture-tab.png, capture-recording.png, capture-booting.png,
// capture-options.png, capture-flow.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

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
    await waitForWelcome(page);
    await page.click("[data-testid=new-project]");
    await waitFor(page, "[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor(page, "[data-testid=editor]");

    // The Capture tab: This Mac first (D143), then Argent's devices (from the bundled plugin),
    // recordable first, then the ones it can boot.
    await page.click("[data-testid=rail-capture]");
    await waitFor(page, "[data-testid=capture-devices]", 30000);
    const order = await page.$$eval("[data-testid=capture-library] > .lib-section", (els) => els.map((e) => (e as HTMLElement).dataset.testid));
    assert.deepEqual(order, ["capture-this-mac", "capture-argent"], "This Mac above Argent");
    const rows = await page.$$eval("[data-testid=capture-device]", (els) => els.map((e) => ({ id: (e as HTMLElement).dataset.id, recordable: (e as HTMLElement).dataset.recordable, bootable: (e as HTMLElement).dataset.bootable, text: (e as HTMLElement).innerText })));
    assert.deepEqual(rows.slice(0, 2).map((r) => [r.id, r.recordable]), [["SIM-IPHONE-16", "true"], ["emulator-5554", "true"]]);
    assert.deepEqual(rows.slice(2, 4).map((r) => [r.id, r.bootable]), [["SIM-IPAD-OFF", "true"], ["avd:Pixel_Tablet_API_35", "true"]]);
    assert.match(rows[2]!.text, /Boot and record/);
    const tv = rows.find((r) => r.id === "SIM-APPLE-TV")!;
    assert.equal(tv.recordable, "false");
    assert.match(tv.text, /Not recordable yet/);
    assert.match(tv.text, /tvOS simulators can't be recorded yet/);
    assert.match(rows.find((r) => r.id === "chromium-cdp-9222")!.text, /Chromium apps can't be recorded yet/);
    // This Mac (D114) has its own test: capture-this-mac-app.test.ts. Screen is its first part.
    await waitFor(page, "[data-testid=capture-this-mac] [data-testid=capture-screen]");
    await waitFor(page, "[data-testid=capture-options]");
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

    const logNow = () => readFileSync(join(root, "argent.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    let log = logNow();
    assert.ok(!log.some((e) => e.forbidden), "never a server stop or a stop-all");
    assert.equal(log.filter((e) => e.boot).length, 0, "no boot before the click");
    assert.equal(log.filter((e) => e.argv[1] === "screen-recording-start").length, 1);
    assert.equal(log.filter((e) => e.argv[1] === "screen-recording-stop" && !e.completed).length, 1);

    // D143: options, then Boot and record on the shut-down iPad.
    await page.click("[data-testid=rail-capture]");
    await waitFor(page, "[data-testid=capture-options]");
    await page.select("[data-testid=capture-opt-orientation]", "LandscapeLeft");
    await page.type("[data-testid=capture-opt-app]", "com.example.app");
    await page.click("[data-testid=capture-opt-touches]");
    await page.$eval("[data-testid=capture-argent]", (el) => el.scrollIntoView());
    await page.screenshot({ path: "test-output/capture-options.png" });
    mkdirSync(join(root, "fake-argent-state"), { recursive: true });
    writeFileSync(join(root, "fake-argent-state", "boot-delay"), "1500");
    const ipad = "[data-testid=capture-device][data-id=SIM-IPAD-OFF]";
    await page.click(`${ipad} [data-testid=capture-boot-record]`);
    await waitFor(page, `${ipad} [data-testid=capture-booting]`, 5000);
    await page.screenshot({ path: "test-output/capture-booting.png" });
    await waitFor(page, `${ipad} [data-testid=capture-stop]`, 30000);
    await sleep(1200);
    await page.click(`${ipad} [data-testid=capture-stop]`);
    await page.waitForFunction(() => /iPad Air \d{8}-\d{6}\.mp4/.test(document.querySelector("[data-testid=capture-saved]")?.textContent ?? ""), { timeout: 30000 });
    log = logNow();
    assert.equal(log.filter((e) => e.boot).length, 1, "one boot, after the click");
    const runs = log.filter((e) => e.argv[0] === "run" && e.argv[1] !== "list-devices" && !e.completed);
    const fromBoot = runs.slice(runs.findIndex((e) => e.argv[1] === "boot-device"));
    assert.deepEqual(fromBoot.map((e) => e.argv[1]), ["boot-device", "rotate", "launch-app", "screen-recording-start", "screen-recording-stop"]);
    assert.deepEqual(JSON.parse(fromBoot[0].argv[3]), { udid: "SIM-IPAD-OFF" });
    assert.deepEqual(JSON.parse(fromBoot[1].argv[3]), { udid: "SIM-IPAD-OFF", orientation: "LandscapeLeft" });
    assert.deepEqual(JSON.parse(fromBoot[2].argv[3]), { udid: "SIM-IPAD-OFF", bundleId: "com.example.app" });
    assert.deepEqual(JSON.parse(fromBoot[3].argv[3]), { udid: "SIM-IPAD-OFF", timeLimitSeconds: 600, trimStatic: false, showTouches: true });
    // Now booted: an ordinary Record row.
    await waitFor(page, `${ipad} [data-testid=capture-record]`, 10000);

    // A saved flow picked in the options plays while recording: a timer, no Stop, then the take.
    mkdirSync(join(dir, "flows"), { recursive: true });
    writeFileSync(join(dir, "flows", "tour.yaml"), "# fake-seconds: 2.5\nsteps: []\n");
    await page.click("[data-testid=capture-refresh]");
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLOptionElement>("[data-testid=capture-opt-flow] option")].some((o) => o.value === "tour"), { timeout: 10000 });
    await page.select("[data-testid=capture-opt-flow]", "tour");
    assert.equal(await page.$eval("[data-testid=capture-opt-max]", (el) => (el as HTMLSelectElement).disabled), true, "a flow's take lasts as long as the flow");
    await page.click(`${iphone} [data-testid=capture-record]`);
    await waitFor(page, `${iphone} [data-testid=capture-timer]`, 10000);
    assert.match(await text(page, iphone), /Playing tour/);
    assert.equal(await page.$(`${iphone} [data-testid=capture-stop]`), null, "no Stop: it ends with the flow");
    await page.screenshot({ path: "test-output/capture-flow.png" });
    await page.waitForFunction(() => /iPhone 16 \d{8}-\d{6}(-\d)?\.mp4/.test(document.querySelector("[data-testid=capture-saved]")?.textContent ?? ""), { timeout: 30000 });
    const withFlow = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).media.find((m: any) => m.source?.flow);
    assert.deepEqual(withFlow.source, { module: "argent.capture", device: "SIM-IPHONE-16", flow: "flows/tour.yaml" });
    assert.ok(!logNow().some((e) => e.forbidden));
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: "test-output/capture-failure.png" }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});
