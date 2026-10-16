// Issues #18 and #19 (D210, D211) on the packaged app, run invisibly and muted, with Chromium's fake
// camera and microphone, the stand-in screen and a stand-in tone for this Mac's sound (never the
// real loopback, desktopCapturer or a real device):
// - #18: "Mac sound" records this Mac's sound alone (an .m4a on a Mac sound track at the playhead);
//   with the microphone (a chip on Microphone) each is its own file and track, grouped and starting
//   together; with the screen (a chip on Screen) the same; the screen permission governs it; an
//   older macOS says what it needs.
// - D238: one recorder: these are source toggles now (Mac sound, plus Microphone, plus Screen),
//   and "Multi" is all four toggled on; the screen is picked in the modal.
// - #19: "Multi" records the screen, the camera, the microphone and this Mac's sound at once, with a
//   live composite picture and a layout preset: four files in media/captures/<take>/, one edit (one
//   ⌘Z), the camera a bubble over the screen, every part at the playhead with the earlier recorders
//   trimmed by their measured start offsets (±1 frame).
// Screenshots: test-output/issue18-*.png, issue19-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";
import { eventually } from "../helpers/wait.ts";
import { NO_REAL_GPU, check } from "../helpers/capabilities.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE_ARGENT = resolve("test/helpers/fake-argent/argent");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (page: Page, name: string) => page.screenshot({ path: resolve("test-output", `${name}.png`) });
const text = (page: Page, selector: string) => page.$eval(selector, (el) => ((el as HTMLElement).innerText ?? "").trim());
const disabled = (page: Page, selector: string) => page.$eval(selector, (el) => (el as HTMLInputElement).disabled);

type Item = { id: string; start: number; in: number; duration: number; media: string; group?: string; transform?: Record<string, unknown>; type: string };
type Track = { id: string; name: string; kind: string; role?: string; items: Array<Item> };

function project(dir: string, name: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "project.json"), JSON.stringify({ format: "uncut/0", name, canvas: { width: 1920, height: 1080, fps: 30 }, media: [], tracks: [{ id: "text", kind: "text", name: "Text", items: [] }, { id: "main", kind: "video", role: "main", name: "Main", items: [] }] }));
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue18-19-")));
  project(join(root, "Rec.uncut"), "Rec");
  project(join(root, "Denied.uncut"), "Denied");
  writeFileSync(join(root, "argent.jsonl"), "");
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const launch = async (dir: string, data: string, extra: Record<string, string> = {}) => {
  const app = await launchApp({
    command: APP,
    env: { ARGENT_BIN: FAKE_ARGENT, FAKE_ARGENT_NODE: process.execPath, FAKE_ARGENT_LOG: join(root, "argent.jsonl"), UNCUT_DATA_DIR: join(root, data), UNCUT_PLUGINS_DIR: join(root, "no-user-plugins"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), ...extra },
  });
  apps.add(app);
  await waitForWelcome(app.page);
  await app.page.click("[data-testid=open-project]");
  await app.page.waitForSelector("[data-testid=editor]");
  await app.page.click("[data-testid=rail-capture]");
  await app.page.waitForSelector("[data-testid=capture-this-mac]");
  return app;
};

/** D238: turn sources on or off to exactly `want`. */
async function sources(page: Page, want: ReadonlyArray<string>) {
  for (const k of ["screen", "voiceover", "camera", "system"]) {
    const on = (await page.$eval(`[data-testid=capture-src-${k}]`, (el) => (el as HTMLElement).dataset.on)) === "yes";
    if (on !== want.includes(k)) await page.click(`[data-testid=capture-src-${k}]`);
  }
  await page.waitForFunction((w: string) => document.querySelector<HTMLElement>("[data-testid=capture-this-mac]")?.dataset.parts === w, { timeout: 5000 }, ["screen", "camera", "voiceover", "system"].filter((k) => want.includes(k)).join(","));
}
async function pick(page: Page, id: string) {
  await page.click("[data-testid=capture-pick-source]");
  await page.click(`[data-testid=capture-source-picker] [data-testid=capture-source][data-id="${id}"]`);
  await page.waitForFunction(() => !document.querySelector("[data-testid=capture-source-picker]"));
}

/** Record → wait for the timer → `ms` → Stop → the saved message. */
async function take(page: Page, ms: number) {
  await page.click("[data-testid=capture-take-record]");
  await page.waitForSelector("[data-testid=capture-take-timer]", { timeout: 15000 });
  await sleep(ms);
  await page.click("[data-testid=capture-take-stop]");
  await page.waitForSelector("[data-testid=capture-take-saved], [data-testid=capture-take-error]", { timeout: 60000 });
  const error = await page.$("[data-testid=capture-take-error]");
  assert.equal(error ? await text(page, "[data-testid=capture-take-error]") : "", "", "the take was saved");
  return text(page, "[data-testid=capture-take-saved]");
}

test("issue 18 and 19: this Mac's sound alone, with the microphone and the screen; a four-source take start-aligned in one edit", { skip, timeout: 300000 }, async () => {
  const dir = join(root, "Rec.uncut");
  const app = await launch(dir, "data");
  const { page } = app;
  const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as { media: Array<{ id: string; kind: string; path: string; source?: Record<string, unknown> }>; tracks: Array<Track> };
  const where = (itemId: string) => {
    for (const t of onDisk().tracks) for (const i of t.items) if (i.id === itemId) return { ...i, track: t };
    throw new Error(`no item ${itemId}`);
  };
  const byMedia = (mediaId: string) => onDisk().tracks.flatMap((t) => t.items.map((i) => ({ ...i, track: t }))).find((i) => i.media === mediaId)!;
  try {
    // #18: Mac sound alone.
    await sources(page, ["system"]);
    await page.waitForSelector("[data-testid=capture-card-system]", { timeout: 15000 });
    assert.match(await text(page, "[data-testid=capture-card-system]"), /What this Mac plays/);
    assert.match(await text(page, "[data-testid=capture-take-record]"), /Record sound/);
    assert.ok(!/[·•∙⋅*]/.test(await text(page, "[data-testid=capture-this-mac]")), "no dots or stars between words");
    await page.$eval("[data-testid=capture-this-mac]", (el) => el.scrollIntoView());
    await shot(page, "issue18-sound");
    const alone = await take(page, 1600);
    assert.match(alone, /^Mac sound \d{8}-\d{6}\.m4a \(\d+\.\d s\) is in Media and on the timeline at 0:00\.$/);
    const sys1 = onDisk().media.find((m) => m.source?.module === "capture.system")!;
    assert.equal(sys1.kind, "audio");
    assert.match(sys1.path, /^media\/captures\/Mac sound \d{8}-\d{6}\.m4a$/);
    assert.ok(existsSync(join(dir, sys1.path)));
    const sysItem = byMedia(sys1.id);
    assert.equal(sysItem.track.name, "Mac sound");
    assert.equal(sysItem.type, "audio");
    assert.equal(sysItem.start, 0);

    // #18: with the microphone: two files, two tracks, grouped, together.
    await sources(page, ["voiceover", "system"]);
    await page.click("[data-testid=capture-play-timeline]");
    assert.match(await text(page, "[data-testid=capture-where]"), /Each source is its own file and track/);
    await page.$eval("[data-testid=capture-this-mac]", (el) => el.scrollIntoView());
    await shot(page, "issue18-mic-and-sound");
    const both = await take(page, 1600);
    assert.match(both, /^Take \d{8}-\d{6} \(\d+\.\d s, 2 files\) is in Media and on the timeline at 0:00\.$/);
    const takeName = both.split(" (")[0]!;
    assert.deepEqual(readdirSync(join(dir, "media", "captures", takeName)).sort(), ["mic.m4a", "system.m4a"]);
    const micMedia = onDisk().media.find((m) => m.source?.module === "capture.microphone" && m.source.take === takeName)!;
    const sysMedia = onDisk().media.find((m) => m.source?.module === "capture.system" && m.source.take === takeName)!;
    const micItem = byMedia(micMedia.id);
    const sysItem2 = byMedia(sysMedia.id);
    assert.equal(micItem.track.name, "Voiceover");
    assert.equal(sysItem2.track.name, "Mac sound 2", "the first take is in the way there");
    assert.equal(micItem.start, sysItem2.start);
    assert.ok(micItem.group && micItem.group === sysItem2.group, "linked: one group");
    assert.notEqual(sysItem2.track.id, sysItem.track.id, "the first Mac sound take is in the way: a second Mac sound track");

    // #18: with the screen: the take goes on the timeline.
    await sources(page, ["screen", "system"]);
    await pick(page, "standin:window:1");
    assert.equal(await page.$("[data-testid=capture-place]"), null, "a take of more than one source always goes on the timeline");
    const screenTake = await take(page, 1500);
    assert.match(screenTake, /^Test window \d{8}-\d{6} \(\d+\.\d s, 2 files\) is in Media/);
    const screenFolder = screenTake.split(" (")[0]!;
    assert.deepEqual(readdirSync(join(dir, "media", "captures", screenFolder)).sort(), ["screen.mp4", "system.m4a"]);

    // #19: all four sources, the bubble top left; a composite picture before and while recording.
    await sources(page, ["screen", "camera", "voiceover", "system"]);
    assert.equal(await text(page, "[data-testid=capture-take-record]"), "Record 4 sources");
    await pick(page, "standin:screen:1");
    await page.click('[data-testid=capture-layout] button[data-value="tl"]');
    await page.waitForSelector('[data-testid=capture-composite][data-layout="tl"]');
    await page.waitForFunction(() => {
      const v = document.querySelector<HTMLVideoElement>("[data-testid=capture-composite-camera] video");
      return !!v && v.videoWidth > 0;
    }, { timeout: 15000 });
    const bubble = await page.$eval("[data-testid=capture-composite-camera]", (el) => {
      const c = el.parentElement!.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      return { left: (b.left - c.left) / c.width, top: (b.top - c.top) / c.height, w: b.width / c.width };
    });
    assert.ok(bubble.left < 0.05 && bubble.top < 0.1 && bubble.w > 0.1 && bubble.w < 0.25, `the bubble is top left: ${JSON.stringify(bubble)}`);
    assert.ok(await page.$("[data-testid=capture-composite-screen] img"), "the screen's picture before recording");
    await shot(page, "issue19-multi");

    await page.click("[data-testid=capture-take-record]");
    await page.waitForSelector("[data-testid=capture-take-timer]", { timeout: 15000 });
    await page.waitForSelector('[data-testid=capture-composite][data-live="yes"]', { timeout: 10000 });
    await sleep(1200);
    await shot(page, "issue19-recording");
    await sleep(1000);
    await page.click("[data-testid=capture-take-stop]");
    await page.waitForSelector("[data-testid=capture-take-saved], [data-testid=capture-take-error]", { timeout: 90000 });
    assert.equal(await page.$("[data-testid=capture-take-error]"), null, (await page.$("[data-testid=capture-take-error]")) ? await text(page, "[data-testid=capture-take-error]") : "");
    const multi = await text(page, "[data-testid=capture-take-saved]");
    assert.match(multi, /^Test screen \d{8}-\d{6} \(\d+\.\d s, 4 files\) is in Media and on the timeline at 0:00\.$/);
    const folder = multi.split(" (")[0]!;
    assert.deepEqual(readdirSync(join(dir, "media", "captures", folder)).sort(), ["camera.mp4", "mic.m4a", "screen.mp4", "system.m4a"]);
    const offsets = JSON.parse((await page.$eval("[data-testid=capture-this-mac]", (el) => (el as HTMLElement).dataset.offsets)) ?? "{}") as Record<string, number>;
    assert.deepEqual(Object.keys(offsets).sort(), ["camera", "screen", "system", "voiceover"]);
    assert.equal(Math.min(...Object.values(offsets)), 0, `the first recorder starts the take: ${JSON.stringify(offsets)}`);
    check(NO_REAL_GPU, Math.max(...Object.values(offsets)) < 500, `the recorders started together: ${JSON.stringify(offsets)}`);
    const parts = onDisk().media.filter((m) => m.source?.take === folder);
    assert.equal(parts.length, 4);
    const kindOf: Record<string, string> = { "capture.screen": "screen", "capture.camera": "camera", "capture.microphone": "voiceover", "capture.system": "system" };
    const items = parts.map((m) => ({ kind: kindOf[m.source!.module as string]!, item: byMedia(m.id) }));
    const get = (k: string) => items.find((x) => x.kind === k)!.item;
    assert.equal(get("screen").track.name, "Screen 2", "the first Screen track is in the way");
    assert.equal(get("camera").track.name, "Camera");
    assert.match(get("voiceover").track.name, /^Voiceover/);
    assert.match(get("system").track.name, /^Mac sound/);
    const order = onDisk().tracks.map((t) => t.id);
    const at = (id: string) => order.indexOf(id);
    assert.ok(at(get("camera").track.id) < at(get("screen").track.id) && at(get("screen").track.id) < at("main"), onDisk().tracks.map((t) => t.name).join(", "));
    assert.deepEqual(get("camera").transform, { x: 43, y: 43, w: 324, h: 324, fit: "cover", radius: 162 });
    // Start-aligned: every part at the playhead, as long as the others, trimmed by its measured offset (±1 frame).
    const last = Math.max(...Object.values(offsets));
    for (const { kind, item } of items) {
      assert.equal(item.start, 0, kind);
      assert.equal(item.duration, get("screen").duration, kind);
      assert.ok(item.group && item.group === get("screen").group, `${kind} is in the take's group`);
      const expected = ((last - offsets[kind]!) * 30) / 1000;
      assert.ok(Math.abs(item.in - expected) <= 1, `${kind}: in ${item.in} frames, offset says ${expected.toFixed(2)}`);
    }
    await shot(page, "issue19-timeline");

    // One ⌘Z takes the whole take out (four media, four items, the new tracks).
    const before = onDisk().media.length;
    await page.keyboard.down("Meta");
    await page.keyboard.press("z");
    await page.keyboard.up("Meta");
    await eventually(() => onDisk().media.length === before - 4);
    assert.equal(onDisk().media.length, before - 4);
    assert.ok(!onDisk().tracks.some((t) => t.name === "Camera"), "the Camera track went with it");
    assert.ok(existsSync(join(dir, "media", "captures", folder, "camera.mp4")), "undo leaves the files, like captures");
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await shot(page, "issue18-19-failure").catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});

test("issue 18 and 19: permissions: the screen permission governs this Mac's sound; an older macOS says what it needs", { skip, timeout: 180000 }, async () => {
  const dir = join(root, "Denied.uncut");
  // Screen recording denied: Mac sound shows how to turn it on; Multi can't add the screen or the sound.
  const app = await launch(dir, "data-denied", { UNCUT_TEST_MEDIA_ACCESS: JSON.stringify({ screen: "denied" }) });
  try {
    await sources(app.page, ["system"]);
    await app.page.waitForSelector('[data-testid=capture-card-system] [data-testid=capture-access][data-kind="screen"][data-state="denied"]', { timeout: 15000 });
    assert.match(await text(app.page, "[data-testid=capture-card-system]"), /isn't allowed to record this Mac's sound: macOS lets it with screen recording\. Turn Uncut on in System Settings, Privacy & Security, Screen & System Audio Recording/);
    await app.page.click("[data-testid=capture-card-system] [data-testid=capture-open-settings-screen]");
    await eventually(() => /\[test\] open x-apple\.systempreferences:.*Privacy_ScreenCapture/.test(app.output()));
    assert.match(app.output(), /\[test\] open x-apple\.systempreferences:.*Privacy_ScreenCapture/);
    await app.page.$eval("[data-testid=capture-this-mac]", (el) => el.scrollIntoView());
    await shot(app.page, "issue18-denied");
    // No Record while a source that's on isn't allowed; the camera and microphone alone record.
    await sources(app.page, ["voiceover", "system"]);
    assert.equal(await disabled(app.page, "[data-testid=capture-take-record]"), true, "no Mac sound without the permission");
    await sources(app.page, ["screen", "camera", "voiceover"]);
    assert.equal(await disabled(app.page, "[data-testid=capture-take-record]"), true, "no screen without the permission");
    await app.page.waitForSelector('[data-testid=capture-card-screen] [data-testid=capture-access][data-state="denied"]');
    await shot(app.page, "issue19-denied");
    await sources(app.page, ["camera", "voiceover"]);
    await app.page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("[data-testid=capture-take-record]")!.disabled, { timeout: 10000 });
  } finally {
    await app.close();
    apps.delete(app);
  }

  // An older macOS (the test's stand-in says 12.7): the sound can't be recorded, and it says why.
  const old = await launch(dir, "data-old", { UNCUT_TEST_SYSTEM_AUDIO: "unsupported" });
  try {
    await sources(old.page, ["screen", "system"]);
    await old.page.waitForSelector("[data-testid=capture-system-unsupported]", { timeout: 15000 });
    assert.match(await text(old.page, "[data-testid=capture-card-system]"), /needs macOS 13 or later; this Mac has macOS 12\.7\. The microphone, camera and screen still work\./);
    assert.equal(await disabled(old.page, "[data-testid=capture-take-record]"), true, "no take with Mac sound on an older macOS");
    await shot(old.page, "issue18-old-macos");
    assert.deepEqual(old.errors, []);
  } finally {
    await old.close();
    apps.delete(old);
  }
});
