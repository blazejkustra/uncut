// Issue #65 (D238) on the packaged app, run invisibly and muted, with Chromium's fake camera and
// microphone, the stand-in screen and the fake argent (24 devices from FAKE_ARGENT_DEVICES; never
// the real CLI, desktopCapturer, a real device or a macOS prompt):
// - one recorder: four source toggles (Screen, Microphone, Camera, Mac sound), no "Multi"; the
//   screen or window is chosen in a modal, never listed on the tab;
// - Argent's 24 devices take one row: a searchable picker (groups, Enter picks the first match)
//   with Record beside it; the options are a compact grid and checkboxes (no chips, D263);
// - screen, microphone and camera at once: one Record, three files, start-aligned at the playhead,
//   in one group and one edit (one ⌘Z), the camera a circle bubble over the screen.
// Screenshots: test-output/issue65-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";
import { eventually } from "../helpers/wait.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE_ARGENT = resolve("test/helpers/fake-argent/argent");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (page: Page, name: string) => page.screenshot({ path: resolve("test-output", `${name}.png`) });
const text = (page: Page, selector: string) => page.$eval(selector, (el) => ((el as HTMLElement).innerText ?? "").trim());
const height = (page: Page, selector: string) => page.$eval(selector, (el) => el.getBoundingClientRect().height);

const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-18-2";
// 12 booted iPhones, 10 shut-down iPads, 2 Apple TVs: 24 devices.
const DEVICES = [
  ...Array.from({ length: 12 }, (_, i) => ({
    platform: "ios",
    udid: `SIM-PHONE-${i + 1}`,
    name: `iPhone ${i + 1}`,
    state: "Booted",
    runtime: RUNTIME,
    runtimeKind: "mobile",
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    platform: "ios",
    udid: `SIM-PAD-${i + 1}`,
    name: `iPad ${i + 1}`,
    state: "Shutdown",
    runtime: RUNTIME,
    runtimeKind: "mobile",
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    platform: "ios",
    udid: `SIM-TV-${i + 1}`,
    name: `Apple TV ${i + 1}`,
    state: "Booted",
    runtime: "com.apple.CoreSimulator.SimRuntime.tvOS-18-2",
    runtimeKind: "tv",
  })),
];

type Item = { id: string; start: number; media: string; group?: string; transform?: Record<string, unknown> };
type Track = { id: string; name: string; items: Array<Item> };

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue65-")));
  const dir = join(root, "Rec.uncut");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Rec",
      canvas: { width: 1920, height: 1080, fps: 30 },
      media: [],
      tracks: [
        { id: "text", kind: "text", name: "Text", items: [] },
        { id: "main", kind: "video", role: "main", name: "Main", items: [] },
      ],
    }),
  );
  writeFileSync(join(root, "argent.jsonl"), "");
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "issue 65: one recorder with source toggles, a screen picker modal, a compact Argent device picker, a three-source take in one edit",
  { skip, timeout: 240000 },
  async () => {
    const dir = join(root, "Rec.uncut");
    const app = await launchApp({
      command: APP,
      env: {
        ARGENT_BIN: FAKE_ARGENT,
        FAKE_ARGENT_NODE: process.execPath,
        FAKE_ARGENT_LOG: join(root, "argent.jsonl"),
        FAKE_ARGENT_DEVICES: JSON.stringify(DEVICES),
        FAKE_ARGENT_AVDS: "[]",
        UNCUT_DATA_DIR: join(root, "data"),
        UNCUT_PLUGINS_DIR: join(root, "no-user-plugins"),
        UNCUT_TEST_DIALOG: JSON.stringify([dir]),
      },
    });
    apps.add(app);
    const { page } = app;
    const missing: Array<string> = [];
    page.on("response", (r) => void (r.status() === 404 && missing.push(r.url())));
    const onDisk = () =>
      JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as {
        media: Array<{ id: string; path: string; source?: Record<string, unknown> }>;
        tracks: Array<Track>;
      };
    const byMedia = (mediaId: string) =>
      onDisk()
        .tracks.flatMap((t) => t.items.map((i) => ({ ...i, track: t })))
        .find((i) => i.media === mediaId)!;
    try {
      await waitForWelcome(page);
      await page.click("[data-testid=open-project]");
      await page.waitForSelector("[data-testid=editor]");
      await page.click("[data-testid=rail-capture]");
      await page.waitForSelector("[data-testid=capture-this-mac]");
      // D263: no grey overlay scrollbar along the rail's edge while the pointer rests on it.
      await page.mouse.wheel({ deltaY: 40 });
      await sleep(150);
      const railBars = await page.evaluate(() => {
        const right = document.querySelector("[data-testid=rail]")!.getBoundingClientRect().right;
        return [...document.querySelectorAll<HTMLElement>("[data-testid=scrollbar][data-visible=true]")].filter((b) => b.getBoundingClientRect().left < right)
          .length;
      });
      assert.equal(railBars, 0, "no scrollbar drawn on the rail");

      // One recorder: four toggles, no Multi, no screens or windows listed on the tab.
      assert.deepEqual(await page.$$eval("[data-testid=capture-toggles] button", (els) => els.map((e) => (e as HTMLElement).innerText.trim())), [
        "Screen",
        "Microphone",
        "Camera",
        "Mac sound",
      ]);
      assert.ok(!/\bMulti\b/.test(await text(page, "[data-testid=capture-library]")), "Multi is gone");
      await page.waitForSelector('[data-testid=capture-pick-source][data-id="standin:screen:1"]', { timeout: 15000 });
      assert.equal(await page.$("[data-testid=capture-this-mac] [data-testid=capture-sources]"), null, "no source grid on the tab");

      // The screen picker modal: screens and windows grouped; a pick closes it and names the choice.
      await page.click("[data-testid=capture-pick-source]");
      await page.waitForSelector(
        '[data-testid=capture-source-picker] [role=dialog] [data-testid=capture-sources][data-kind="window"] [data-testid=capture-source][data-id="standin:window:1"]',
        { timeout: 15000 },
      );
      assert.ok(await page.$('[data-testid=capture-source-picker] [data-testid=capture-sources][data-kind="screen"]'));
      await shot(page, "issue65-source-picker");
      await page.click('[data-testid=capture-source-picker] [data-testid=capture-source][data-id="standin:window:1"]');
      await page.waitForFunction(() => !document.querySelector("[data-testid=capture-source-picker]"));
      assert.equal(await page.$eval("[data-testid=capture-pick-source]", (el) => (el as HTMLElement).dataset.id), "standin:window:1");
      assert.match(await text(page, "[data-testid=capture-pick-source]"), /Test window/);
      // Escape closes it without changing the choice.
      await page.click("[data-testid=capture-pick-source]");
      await page.waitForSelector("[data-testid=capture-source-picker]");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("[data-testid=capture-source-picker]"));
      assert.equal(await page.$eval("[data-testid=capture-pick-source]", (el) => (el as HTMLElement).dataset.id), "standin:window:1");

      // Argent: 24 devices, one row (the picker with Record beside it), a compact section.
      await page.waitForSelector("[data-testid=capture-devices]", { timeout: 30000 });
      assert.deepEqual(await page.$$eval("[data-testid=capture-device]", (els) => els.map((e) => (e as HTMLElement).dataset.id)), ["SIM-PHONE-1"]);
      assert.equal(await text(page, "[data-testid=capture-device-picker] .device-picker-count"), "24");
      assert.ok(await page.$("[data-testid=capture-device] [data-testid=capture-record]"));
      const argentHeight = await height(page, "[data-testid=capture-argent]");
      assert.ok(argentHeight < 320, `the Argent section stays compact with 24 devices: ${argentHeight}px`);
      // Tidy options: a two-column grid of selects, checkboxes no taller than a row.
      assert.equal(await page.$$eval("[data-testid=capture-options] .capture-options-grid .capture-opt", (els) => els.length), 4);
      for (const id of ["capture-opt-touches", "capture-opt-trim"]) {
        const h = await page.$eval(`[data-testid=${id}]`, (el) => el.parentElement!.getBoundingClientRect().height);
        assert.ok(h <= 28, `${id} option is ${h}px tall`);
      }
      await page.$eval("[data-testid=capture-argent]", (el) => el.scrollIntoView());
      await shot(page, "issue65-argent");

      // The picker: grouped, searchable, Enter picks the first match.
      await page.click("[data-testid=capture-device-picker]");
      await page.waitForSelector("[data-testid=capture-device-menu] [data-testid=capture-device-option]");
      assert.equal(await page.$$eval("[data-testid=capture-device-option]", (els) => els.length), 24);
      assert.deepEqual(await page.$$eval("[data-testid=capture-device-menu] .device-group-title", (els) => els.map((e) => (e.textContent ?? "").trim())), [
        "Ready",
        "Off, boots when you record",
        "Can't record yet",
      ]);
      const menuHeight = await height(page, "[data-testid=capture-device-menu]");
      const windowHeight = await page.evaluate(() => window.innerHeight);
      assert.ok(menuHeight <= windowHeight, `the menu fits the window: ${menuHeight}px of ${windowHeight}px`);
      // D263: the menu grows rightwards from the picker, so it never covers the rail in the narrow panel.
      const railRight = await page.$eval("[data-testid=rail]", (el) => el.getBoundingClientRect().right);
      const menuLeft = await page.$eval("[data-testid=capture-device-menu]", (el) => el.getBoundingClientRect().left);
      assert.ok(menuLeft >= railRight, `the menu (left ${menuLeft}px) stays off the rail (right ${railRight}px)`);
      await shot(page, "issue65-device-menu");
      await page.type("[data-testid=capture-device-search]", "ipad 7");
      await page.waitForFunction(() => document.querySelectorAll("[data-testid=capture-device-option]").length === 1);
      assert.equal(await page.$eval("[data-testid=capture-device-option]", (el) => (el as HTMLElement).dataset.id), "SIM-PAD-7");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector("[data-testid=capture-device-menu]"));
      assert.equal(await page.$eval("[data-testid=capture-device-picker]", (el) => (el as HTMLElement).dataset.id), "SIM-PAD-7");
      assert.ok(
        await page.$('[data-testid=capture-device][data-id="SIM-PAD-7"] [data-testid=capture-boot-record]'),
        "a shut-down simulator has Boot and record",
      );
      assert.equal(readFileSync(join(root, "argent.jsonl"), "utf8").includes("boot-device"), false, "choosing a device never boots it");

      // Screen, microphone and camera at once: the bubble over the screen, one Record.
      for (const k of ["voiceover", "camera"]) await page.click(`[data-testid=capture-src-${k}]`);
      await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=capture-this-mac]")?.dataset.parts === "screen,camera,voiceover");
      assert.equal(await text(page, "[data-testid=capture-take-record]"), "Record 3 sources");
      assert.match(await text(page, "[data-testid=capture-where]"), /Each source is its own file and track, starting together at the playhead/);
      await page.waitForFunction(() => (document.querySelector<HTMLVideoElement>("[data-testid=capture-composite-camera] video")?.videoWidth ?? 0) > 0, {
        timeout: 15000,
      });
      assert.equal(await page.$eval("[data-testid=capture-composite-camera]", (el) => (el as HTMLElement).style.borderRadius), "50%", "the circle camera");
      assert.ok(!/[·•∙⋅*]/.test(await text(page, "[data-testid=capture-library]")), "no dots or stars between words");
      await page.$eval("[data-testid=capture-this-mac]", (el) => el.scrollIntoView());
      await shot(page, "issue65-recorder");

      await page.click("[data-testid=capture-take-record]");
      await page.waitForSelector("[data-testid=capture-take-timer]", { timeout: 15000 });
      // Mid-take the toggles are locked and show what records.
      assert.equal(await page.$eval("[data-testid=capture-src-system]", (el) => (el as HTMLButtonElement).disabled), true);
      await sleep(2000);
      await shot(page, "issue65-recording");
      await page.click("[data-testid=capture-take-stop]");
      await page.waitForSelector("[data-testid=capture-take-saved], [data-testid=capture-take-error]", { timeout: 90000 });
      assert.equal(
        await page.$("[data-testid=capture-take-error]"),
        null,
        (await page.$("[data-testid=capture-take-error]")) ? await text(page, "[data-testid=capture-take-error]") : "",
      );
      const saved = await text(page, "[data-testid=capture-take-saved]");
      assert.match(saved, /^Test window \d{8}-\d{6} \(\d+\.\d s, 3 files\) is in Media and on the timeline at 0:00\.$/);
      const folder = saved.split(" (")[0]!;
      assert.deepEqual(readdirSync(join(dir, "media", "captures", folder)).sort(), ["camera.mp4", "mic.m4a", "screen.mp4"]);
      const parts = onDisk().media.filter((m) => m.source?.take === folder);
      assert.equal(parts.length, 3);
      const items = parts.map((m) => byMedia(m.id));
      assert.ok(
        items.every((i) => i.start === 0),
        "every part at the playhead",
      );
      assert.ok(items[0]!.group && items.every((i) => i.group === items[0]!.group), "one group");
      assert.equal(new Set(items.map((i) => i.track.id)).size, 3, "each its own track");
      const cam = items.find((i) => i.track.name === "Camera")!;
      assert.equal(cam.transform?.radius, (cam.transform?.w as number) / 2, "the camera is a circle bubble");

      // One ⌘Z takes the whole take out.
      const before = onDisk().media.length;
      await page.keyboard.down("Meta");
      await page.keyboard.press("z");
      await page.keyboard.up("Meta");
      await eventually(() => onDisk().media.length === before - 3);
      assert.equal(onDisk().media.length, before - 3);
      assert.deepEqual(app.errors, [], `404s: ${missing.join(", ")}`);
    } catch (error) {
      await shot(page, "issue65-failure").catch(() => {});
      throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
    }
  },
);
