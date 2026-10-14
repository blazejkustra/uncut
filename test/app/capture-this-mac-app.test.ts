// D114 on the packaged app, run invisibly and muted, with Chromium's fake microphone and camera
// (UNCUT_TEST_MEDIA=fake from launchApp: no real device, no prompt) and a stand-in screen (never
// desktopCapturer, so no Screen Recording prompt):
// - Microphone: the level meter moves, Record counts 3-2-1, the timeline plays while recording,
//   Stop puts the voiceover on a Voiceover track at the playhead as long as the recorder measured
//   (±0.2 s); one ⌘Z takes media, item and track out, ⌘⇧Z puts them back. A take under a second
//   is discarded; Cancel keeps nothing.
// - Camera: preview, 720p, a take with picture and sound (ffprobe) into Media and at the playhead.
// - Screen: the stand-in source, a take into Media (picture only).
// - Permissions from the test: denied says how to fix it and opens System Settings (logged, not
//   opened), not asked yet offers to ask.
// - D143/D144: Screen is the first part (screens and windows grouped, "Record screen").
// - D144: the agent's screen_record (scripted claude): the card in the Agent tab preselects the
//   window it named, Record runs the stand-in take for its seconds with the 3-2-1 and a status
//   line, and the take lands in Media as an edit of the turn.
// Screenshots: test-output/capture-mic.png, capture-recording-mic.png, capture-camera.png,
// capture-screen.png, capture-denied.png, capture-agent-card.png, capture-agent-recording.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
// The Capture tab also asks Argent for its devices: always the fake (the real CLI would start the shared tool-server).
const FAKE_ARGENT = resolve("test/helpers/fake-argent/argent");
const FAKE_CLAUDE = resolve("test/helpers/fake-claude.ts");
const argentEnv = () => ({ ARGENT_BIN: FAKE_ARGENT, FAKE_ARGENT_NODE: process.execPath, FAKE_ARGENT_LOG: join(root, "argent.jsonl") });
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const text = (page: Page, selector: string) => page.$eval(selector, (el) => ((el as HTMLElement).innerText ?? "").trim());
const keys = async (page: Page, key: "z", shift = false) => {
  await page.keyboard.down("Meta");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
};
async function goTo(page: Page, frame: number, fps = 30) {
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(frame / fps); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < frame % fps; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, frame);
}
const streams = (file: string) => (JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", file], { encoding: "utf8" })) as { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }> }).streams;

function writeProject(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Takes",
      canvas: { width: 1920, height: 1080, fps: 30 },
      media: [{ id: "m-talk", kind: "video", name: "Talk.mp4", path: join(root, "Talk.mp4"), probe: { frames: 180, fps: 30, width: 320, height: 240, hasAudio: true } }],
      tracks: [
        { id: "text", kind: "text", name: "Text", items: [] },
        { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 180 }] },
      ],
    }),
  );
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-this-mac-")));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-f", "lavfi", "-i", "aevalsrc=0.3*sin(2*PI*660*t):s=48000", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(root, "Talk.mp4")]);
  writeProject(join(root, "Takes.uncut"));
  writeProject(join(root, "Denied.uncut"));
  writeProject(join(root, "Agent.uncut"));
  writeFileSync(join(root, "argent.jsonl"), "");
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("This Mac: a voiceover lands on a Voiceover track at the playhead (one undo), short takes and Cancel keep nothing, camera and screen takes go into Media", { skip, timeout: 240000 }, async () => {
  const dir = join(root, "Takes.uncut");
  const app = await launchApp({ command: APP, env: { ...argentEnv(), UNCUT_DATA_DIR: join(root, "data"), UNCUT_PLUGINS_DIR: join(root, "no-user-plugins"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  apps.add(app);
  const { page } = app;
  const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=open-project]");
    await waitFor(page, "[data-testid=editor]");
    await page.click("[data-testid=timeline]");
    await goTo(page, 30);

    await page.click("[data-testid=rail-capture]");
    // Screen is the first part (D144), grouped into screens and windows, with "Record screen".
    await waitFor(page, "[data-testid=capture-this-mac] [data-testid=capture-screen]");
    assert.deepEqual(await page.$$eval(".capture-modes button", (els) => els.map((e) => (e as HTMLElement).innerText.trim())), ["Screen", "Microphone", "Camera"]);
    await waitFor(page, '[data-testid=capture-sources][data-kind="window"] [data-testid=capture-source][data-id="standin:window:1"]');
    assert.equal(await text(page, "[data-testid=capture-screen] [data-testid=capture-take-record]"), "Record screen");
    await page.click("[data-testid=capture-mode-voiceover]");
    await waitFor(page, "[data-testid=capture-this-mac] [data-testid=capture-mic]");
    // Chromium's fake microphones are listed and the meter moves (the fake input beeps).
    await page.waitForFunction(() => (document.querySelector<HTMLSelectElement>("[data-testid=capture-mic-device]")?.options.length ?? 0) > 0, { timeout: 15000 });
    await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=capture-mic-level]")?.dataset.level ?? 0) > 0.05, { timeout: 15000 });
    assert.match(await text(page, "[data-testid=capture-mic]"), /Voiceover track at the playhead \(0:01\)/);
    assert.ok(!/[·•∙⋅*]/.test(await text(page, "[data-testid=capture-library]")), "no dots or stars between words");
    await page.$eval("[data-testid=capture-this-mac]", (el) => el.scrollIntoView());
    await page.screenshot({ path: "test-output/capture-mic.png" });

    // Record: 3-2-1, then the timer; the timeline plays from the playhead meanwhile.
    await page.click("[data-testid=capture-take-record]");
    await waitFor(page, "[data-testid=capture-countdown]");
    assert.equal(await text(page, "[data-testid=capture-countdown]"), "3");
    await waitFor(page, "[data-testid=capture-take-timer]", 10000);
    await sleep(800);
    assert.equal(await page.$eval("[data-testid=preview-frame]", (el) => (el as HTMLElement).dataset.playing), "true", "the timeline plays while recording");
    await page.screenshot({ path: "test-output/capture-recording-mic.png" });
    await sleep(1700);
    await page.click("[data-testid=capture-take-stop]");
    await waitFor(page, "[data-testid=capture-take-saved]", 30000);
    assert.match(await text(page, "[data-testid=capture-take-saved]"), /^Voiceover \d{8}-\d{6}\.m4a \(\d+\.\d s\) is in Media and on the timeline at 0:01\.$/);
    const recordedMs = Number(await page.$eval("[data-testid=capture-this-mac]", (el) => (el as HTMLElement).dataset.recordedMs));
    assert.ok(recordedMs > 2000 && recordedMs < 4000, `${recordedMs} ms`);
    let project = onDisk();
    const voice = project.media.find((m: { source?: { module: string } }) => m.source?.module === "capture.microphone");
    assert.ok(voice, JSON.stringify(project.media));
    assert.match(voice.path, /^media\/captures\/Voiceover \d{8}-\d{6}\.m4a$/);
    assert.equal(voice.kind, "audio");
    const track = project.tracks.find((t: { name: string }) => t.name === "Voiceover");
    assert.equal(track.kind, "audio");
    assert.equal(track.items.length, 1);
    const item = track.items[0];
    assert.equal(item.start, 30, "at the playhead");
    assert.equal(item.media, voice.id);
    assert.ok(Math.abs(item.duration / 30 - recordedMs / 1000) <= 0.2, `${item.duration / 30} s on the timeline vs ${recordedMs / 1000} s recorded`);
    assert.deepEqual(streams(join(dir, voice.path)).map((s) => s.codec_type), ["audio"]);
    assert.deepEqual(readdirSync(join(dir, "media", "uploads")), [], "the upload is gone");

    // One ⌘Z takes the media, the item and the track out; ⌘⇧Z puts them back.
    await page.click("[data-testid=timeline]");
    await keys(page, "z");
    await sleep(500);
    project = onDisk();
    assert.equal(project.media.length, 1);
    assert.ok(!project.tracks.some((t: { name: string }) => t.name === "Voiceover"));
    await keys(page, "z", true);
    await sleep(500);
    project = onDisk();
    assert.equal(project.media.length, 2);
    assert.equal(project.tracks.find((t: { name: string }) => t.name === "Voiceover").items[0].id, item.id);

    // A take under a second is discarded; Cancel during the countdown keeps nothing.
    await page.click("[data-testid=capture-take-record]");
    await waitFor(page, "[data-testid=capture-take-stop]", 10000);
    await page.click("[data-testid=capture-take-stop]");
    await waitFor(page, "[data-testid=capture-take-discarded]", 10000);
    assert.match(await text(page, "[data-testid=capture-take-discarded]"), /under a second, so it was discarded/);
    await page.click("[data-testid=capture-take-record]");
    await waitFor(page, "[data-testid=capture-countdown]");
    await page.click("[data-testid=capture-take-cancel]");
    await page.waitForFunction(() => /Cancelled/.test(document.querySelector("[data-testid=capture-take-discarded]")?.textContent ?? ""), { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=capture-this-mac]")!.dataset.phase === "idle");
    await sleep(1500);
    assert.equal(onDisk().media.length, 2, "nothing new");

    // Record, Cancel and Record again in one go: the first take's late end never touches the second.
    // (In the page, as fast as React renders, so the first take's devices are usually still opening.)
    await page.evaluate(async () => {
      const ready = async (id: string) => {
        for (let i = 0; i < 500; i++) {
          const el = document.querySelector<HTMLButtonElement>(`[data-testid=${id}]`);
          if (el && !el.disabled) return el;
          await new Promise((r) => setTimeout(r, 0));
        }
        throw new Error(`no ${id}`);
      };
      (await ready("capture-take-record")).click();
      (await ready("capture-take-cancel")).click();
      (await ready("capture-take-record")).click();
    });
    await waitFor(page, "[data-testid=capture-take-timer]", 10000);
    await sleep(800);
    assert.equal(await page.$eval("[data-testid=capture-this-mac]", (el) => (el as HTMLElement).dataset.phase), "recording", "the second take kept going");
    await page.click("[data-testid=capture-take-cancel]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=capture-this-mac]")!.dataset.phase === "idle", { timeout: 5000 });
    assert.equal(onDisk().media.length, 2, "nothing new");

    // Camera: preview, 720p, picture and sound, also on the timeline at the playhead.
    await page.click("[data-testid=capture-mode-camera]");
    await waitFor(page, "[data-testid=capture-camera]");
    await page.waitForFunction(() => (document.querySelector<HTMLVideoElement>("[data-testid=capture-camera-preview]")?.videoWidth ?? 0) > 0, { timeout: 15000 });
    await page.click('[data-testid=capture-camera-resolution] [data-value="720p"]');
    await page.waitForFunction(() => (document.querySelector<HTMLVideoElement>("[data-testid=capture-camera-preview]")?.videoHeight ?? 0) === 720, { timeout: 15000 });
    await page.click("[data-testid=capture-place]");
    await page.screenshot({ path: "test-output/capture-camera.png" });
    await page.click("[data-testid=capture-take-record]");
    await waitFor(page, "[data-testid=capture-take-timer]", 10000);
    await sleep(1000);
    // Leaving the tab mid-take closes the preview but never the take's own stream; back on the
    // tab, the Camera part (with Stop) shows again.
    await page.click("[data-testid=rail-media]");
    await sleep(500);
    await page.click("[data-testid=rail-capture]");
    await waitFor(page, "[data-testid=capture-camera] [data-testid=capture-take-stop]");
    await sleep(1000);
    await page.click("[data-testid=capture-take-stop]");
    await page.waitForFunction(() => /^Camera \d{8}-\d{6}\.mp4 .* and on the timeline at 0:01\.$/.test(document.querySelector("[data-testid=capture-take-saved]")?.textContent ?? ""), { timeout: 60000 });
    project = onDisk();
    const camera = project.media.find((m: { source?: { module: string } }) => m.source?.module === "capture.camera");
    assert.ok(camera, JSON.stringify(project.media));
    assert.equal(camera.kind, "video");
    const camStreams = streams(join(dir, camera.path));
    assert.deepEqual(camStreams.map((s) => `${s.codec_type}:${s.codec_name}`).sort(), ["audio:aac", "video:h264"]);
    assert.equal(camStreams.find((s) => s.codec_type === "video")!.height, 720);
    const camMs = Number(await page.$eval("[data-testid=capture-this-mac]", (el) => (el as HTMLElement).dataset.recordedMs));
    assert.ok(camMs > 2300, `${camMs} ms`);
    const camSeconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(dir, camera.path)], { encoding: "utf8" }));
    assert.ok(Math.abs(camSeconds - camMs / 1000) <= 0.3, `the take wasn't cut short: ${camSeconds} s in the file, ${camMs} ms recorded`);
    const placed = project.tracks.flatMap((t: { name: string; items: Array<{ media?: string; start?: number }> }) => t.items.map((i) => ({ ...i, track: t.name }))).find((i: { media?: string }) => i.media === camera.id);
    assert.equal(placed.track, "Recordings");
    assert.equal(placed.start, 30);

    // Screen: the stand-in source (tests never list the real screens), picture only, into Media.
    await page.click("[data-testid=capture-mode-screen]");
    await waitFor(page, '[data-testid=capture-source][data-id="standin:screen:1"]');
    await page.click('[data-testid=capture-source][data-id="standin:screen:1"]');
    await page.screenshot({ path: "test-output/capture-screen.png" });
    await page.click("[data-testid=capture-take-record]");
    await waitFor(page, "[data-testid=capture-take-timer]", 10000);
    await sleep(1800);
    await page.click("[data-testid=capture-take-stop]");
    await page.waitForFunction(() => /^Test screen \d{8}-\d{6}\.mp4/.test(document.querySelector("[data-testid=capture-take-saved]")?.textContent ?? ""), { timeout: 60000 });
    project = onDisk();
    const screen = project.media.find((m: { source?: { module: string } }) => m.source?.module === "capture.screen");
    assert.ok(screen);
    assert.deepEqual(streams(join(dir, screen.path)).map((s) => s.codec_type), ["video"]);
    assert.equal(project.tracks.flatMap((t: { items: Array<{ media?: string }> }) => t.items).some((i: { media?: string }) => i.media === screen.id), false, "Media only");
    const log = readFileSync(join(root, "argent.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(!log.some((e) => e.forbidden), "the fake Argent saw no server stop, stop-all or boot");
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: "test-output/capture-this-mac-failure.png" }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});

test("This Mac: permissions macOS refused say how to fix them and open System Settings; not asked yet offers to ask", { skip, timeout: 120000 }, async () => {
  const dir = join(root, "Denied.uncut");
  const app = await launchApp({
    command: APP,
    env: {
      ...argentEnv(),
      UNCUT_DATA_DIR: join(root, "data-denied"),
      UNCUT_PLUGINS_DIR: join(root, "no-user-plugins"),
      UNCUT_TEST_DIALOG: JSON.stringify([dir]),
      UNCUT_TEST_MEDIA_ACCESS: JSON.stringify({ microphone: "denied", camera: "not-determined", screen: "denied" }),
    },
  });
  apps.add(app);
  const { page } = app;
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=open-project]");
    await waitFor(page, "[data-testid=editor]");
    await page.click("[data-testid=rail-capture]");
    await page.click("[data-testid=capture-mode-voiceover]");
    await waitFor(page, '[data-testid=capture-access][data-kind="microphone"][data-state="denied"]');
    assert.match(await text(page, "[data-testid=capture-mic]"), /isn't allowed to use the microphone\. Turn Uncut on in System Settings, Privacy & Security, Microphone/);
    assert.equal(await page.$("[data-testid=capture-take-record]"), null, "no Record while it's off");
    await page.$eval("[data-testid=capture-this-mac]", (el) => el.scrollIntoView());
    await page.screenshot({ path: "test-output/capture-denied.png" });
    await page.click("[data-testid=capture-open-settings-microphone]");
    await sleep(300);
    assert.match(app.output(), /\[test\] open x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_Microphone/);

    await page.click("[data-testid=capture-mode-camera]");
    await waitFor(page, '[data-testid=capture-access][data-kind="camera"][data-state="not-determined"]');
    assert.match(await text(page, "[data-testid=capture-camera]"), /Uncut needs the camera/);
    await waitFor(page, "[data-testid=capture-allow-camera]");

    await page.click("[data-testid=capture-mode-screen]");
    await waitFor(page, '[data-testid=capture-access][data-kind="screen"][data-state="denied"]');
    await page.click("[data-testid=capture-open-settings-screen]");
    await sleep(300);
    assert.match(app.output(), /Privacy_ScreenCapture/);
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: "test-output/capture-denied-failure.png" }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});

test("D144: the agent's screen_record asks on a card, the user picks Record, and the take is an edit of its turn", { skip, timeout: 180000 }, async () => {
  const dir = join(root, "Agent.uncut");
  const plan = join(root, "agent-plan.json");
  writeFileSync(
    plan,
    JSON.stringify([
      [{ tool: "screen_record", args: { source: "test window", seconds: 1.5 } }, { text: "Recorded the window." }],
      [{ tool: "screen_record", args: { source: "test window", seconds: 30 } }, { text: "Stopped." }],
      [{ tool: "screen_record", args: { source: "test window", seconds: 4 } }, { text: "Closed." }],
    ]),
  );
  const app = await launchApp({
    command: APP,
    env: { ...argentEnv(), UNCUT_DATA_DIR: join(root, "data-agent"), UNCUT_PLUGINS_DIR: join(root, "no-user-plugins"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: FAKE_CLAUDE, FAKE_PLAN: plan, ANTHROPIC_API_KEY: "sk-ant-test-not-a-key" },
  });
  apps.add(app);
  const { page } = app;
  const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=open-project]");
    await waitFor(page, "[data-testid=editor]");
    await page.click("[data-testid=tab-agent]");
    await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"), { timeout: 15000 });
    await page.click("[data-testid=agent-input]");
    await page.type("[data-testid=agent-input]", "record the test window for a second and a half");
    await page.keyboard.press("Enter");
    // The card: what the agent asked for, the window it named preselected, Don't and Record.
    await waitFor(page, '[data-testid=agent-approval][data-kind="screen"]', 30000);
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("[data-testid=agent-screen-source]")?.value === "standin:window:1", { timeout: 10000 });
    assert.match(await text(page, "[data-testid=agent-approval]"), /^Record "test window" for 1\.5 s\?/);
    assert.ok(!/[·•∙⋅*$]/.test(await text(page, "[data-testid=agent-approval]")), "no price, no dots between words");
    assert.equal(onDisk().media.length, 1, "nothing recorded before Record");
    await page.screenshot({ path: "test-output/capture-agent-card.png" });
    await page.click("[data-testid=agent-allow]");
    await waitFor(page, "[data-testid=agent-screen-take]", 10000);
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=agent-screen-take]")?.dataset.phase === "recording", { timeout: 10000 });
    await page.screenshot({ path: "test-output/capture-agent-recording.png" });
    // It stops by itself after 1.5 s; the turn finishes with the take in Media.
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=agent-turn]")?.dataset.status === "done", { timeout: 60000 });
    const project = onDisk();
    const screen = project.media.find((m: { source?: { module: string } }) => m.source?.module === "capture.screen");
    assert.ok(screen, JSON.stringify(project.media));
    assert.deepEqual(screen.source, { module: "capture.screen", device: "Test window" });
    assert.match(screen.path, /^media\/captures\/Test window \d{8}-\d{6}\.mp4$/);
    const secs = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(dir, screen.path)], { encoding: "utf8" }));
    assert.ok(secs > 1.1 && secs < 2.4, `about 1.5 s: ${secs}`);
    assert.match(await text(page, "[data-testid=agent-turn]"), /Recorded/);
    assert.equal(await page.$("[data-testid=agent-screen-take]"), null);

    // Stop during the agent's take: the take is cancelled (streams stopped, nothing kept).
    const takesOnDisk = () => [...readdirSync(join(dir, "media", "captures")), ...(existsSync(join(dir, "media", "uploads")) ? readdirSync(join(dir, "media", "uploads")) : [])].sort();
    const before = takesOnDisk();
    const mediaBefore = onDisk().media.length;
    const ask = async (prompt: string) => {
      await page.waitForFunction(() => !document.querySelector("[data-testid=agent-stop]"), { timeout: 15000 });
      await page.click("[data-testid=agent-input]");
      await page.type("[data-testid=agent-input]", prompt);
      await page.keyboard.press("Enter");
      await waitFor(page, '[data-testid=agent-approval][data-kind="screen"]', 30000);
      await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("[data-testid=agent-screen-source]")?.value === "standin:window:1", { timeout: 10000 });
      await page.click("[data-testid=agent-allow]");
      await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=agent-screen-take]")?.dataset.phase === "recording", { timeout: 10000 });
    };
    await ask("record the window for half a minute");
    assert.ok(await page.$("[data-testid=agent-screen-cancel]"), "Cancel shows while the agent's take runs");
    await page.click("[data-testid=agent-stop]");
    await page.waitForFunction(() => !document.querySelector("[data-testid=agent-screen-take]"), { timeout: 10000 });
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>("[data-testid=agent-turn]")].every((t) => t.dataset.status !== "running"), { timeout: 15000 });
    await sleep(1500);
    assert.equal(onDisk().media.length, mediaBefore, "nothing imported");
    assert.deepEqual(takesOnDisk(), before, "no take kept or left in uploads");

    // Closing the project mid-take cancels it too; nothing lands anywhere after the take's 4 s.
    await ask("record the window for four seconds");
    await page.click("[data-testid=close-project]");
    await waitForWelcome(page);
    await sleep(6000);
    assert.deepEqual(takesOnDisk(), before, "no take kept or left in uploads after closing");
    assert.equal(onDisk().media.length, mediaBefore);
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: "test-output/capture-agent-failure.png" }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});
