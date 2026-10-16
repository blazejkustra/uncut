// Phase 4 chunk 5 on the packaged app (D54), with ffmpeg-made tones of known level: a clip's own
// sound plays; a music file imported from the Audio tab lands on the audio track with its waveform
// drawn; while playing, the mix's output (an AnalyserNode the app exposes read-only as
// window.__uncutAudio) follows the volume, the fades and the track's volume and mute; paused is
// silent; every change is one undo step; and the agent's next prompt lists the changes in words.
// Levels are compared as ratios against the steady tone, sampled with the frame they were read at.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { viewerPrefs } from "../helpers/viewer-prefs.ts";
import { NO_REAL_AUDIO, check } from "../helpers/capabilities.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test tones") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const revision = (page: Page) => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const meta = async (page: Page, key: Parameters<Page["keyboard"]["press"]>[0]) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key);
  await page.keyboard.up("Meta");
};
/** Seek by keyboard: Home, then ⇧→ for whole seconds and → for frames. */
async function goTo(page: Page, frame: number, fps = 30) {
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(frame / fps); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < frame % fps; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, frame);
}

interface Sample {
  frame: number;
  rms: number;
  playing: boolean;
  gains: Record<string, number>;
}
/** The mix's output level and the playback frame, read in one go. */
const sample = (page: Page): Promise<Sample> =>
  page.evaluate(() => {
    const hook = (globalThis as unknown as { __uncutAudio: { level(): { rms: number }; state(): { items: Array<{ id: string; gain: number }> } } }).__uncutAudio;
    const frameEl = document.querySelector<HTMLElement>("[data-testid=preview-frame]")!;
    return {
      frame: Number(frameEl.dataset.frame),
      rms: hook.level().rms,
      playing: frameEl.dataset.playing === "true",
      gains: Object.fromEntries(hook.state().items.map((i) => [i.id, i.gain])),
    };
  });

/** Play from `frame`, wait for the sound to settle, take `n` samples ~80 ms apart, pause. */
async function listen(page: Page, frame: number, { settle = 500, n = 4 } = {}): Promise<Array<Sample>> {
  await goTo(page, frame);
  await page.keyboard.press("Space");
  await sleep(settle);
  const samples: Array<Sample> = [];
  for (let i = 0; i < n; i++) {
    samples.push(await sample(page));
    await sleep(80);
  }
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.playing === "false");
  return samples;
}
const median = (values: Array<number>) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

/** Wait until the saved revision passes `after`; returns the new one. */
async function savedAfter(page: Page, after: number) {
  await page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1] ?? -1) > r, { timeout: 10000 }, after);
  await sleep(150);
  return revision(page);
}

/** Type a value into a number field and commit it with Enter. */
async function setField(page: Page, testId: string, value: string) {
  await page.click(`[data-testid=${testId}]`, { clickCount: 3 });
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-audio-")));
  const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  // Music: 8 s of 440 Hz at half scale. A clip: 4 s of picture with 660 Hz at half scale.
  ff("-f", "lavfi", "-i", "aevalsrc=0.5*sin(2*PI*440*t):s=48000:d=8", "-c:a", "aac", "-b:a", "192k", join(root, "Music.m4a"));
  ff("-f", "lavfi", "-i", "aevalsrc=0.5*sin(2*PI*440*t):s=48000:d=1.5", "-c:a", "aac", "-b:a", "192k", join(root, "Beep.m4a"));
  ff("-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-f", "lavfi", "-i", "aevalsrc=0.5*sin(2*PI*660*t):s=48000", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", join(root, "Talk.mp4"));
  const dir = join(root, "Sound.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Sound",
      canvas: { width: 1920, height: 1080, fps: 30 },
      media: [{ id: "m-talk", kind: "video", name: "Talk.mp4", path: join(root, "Talk.mp4"), probe: { frames: 120, fps: 30, width: 320, height: 240, hasAudio: true } }],
      tracks: [
        { id: "text", kind: "text", name: "Text", items: [] },
        { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 120 }] },
        { id: "audio", kind: "audio", name: "Audio", items: [] },
      ],
    }),
  );
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(join(root, "plan.json"), JSON.stringify([[{ text: "Noted." }]]));
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("sound: a clip's audio plays, music from the Audio tab gets a waveform, and volume, fades and mute are audible, one undo step each", { skip, timeout: 240000 }, async () => {
  const dir = join(root, "Sound.uncut");
  const app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([dir, [join(root, "Music.m4a")]]),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: join(root, "plan.json"),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
    },
  });
  apps.add(app);
  const { page } = app;
  const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  const music = () => onDisk().tracks.find((t: { id: string }) => t.id === "audio").items[0];
  try {
    await waitForWelcome(page);
    // The mix as it is (D273 made At target the default): levels are measured against it.
    await viewerPrefs(page, { atTarget: false });
    await page.click("[data-testid=open-project]");
    await waitFor(page, "[data-testid=editor]");
    // The clip's own sound (660 Hz at half scale: RMS ≈ 0.354), drawn as a compact waveform.
    await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('[data-item="clip-1"] [data-testid=waveform]')?.dataset.ready === "true", { timeout: 20000 });
    await page.click("[data-testid=timeline]");
    const clip = await listen(page, 15);
    assert.ok(clip.every((s) => s.playing), "it played");
    const clipRms = median(clip.map((s) => s.rms));
    assert.ok(Math.abs(clipRms - 0.354) < 0.06, `the clip's sound plays: RMS ${clipRms.toFixed(3)} (${JSON.stringify(clip)})`);
    await sleep(200);
    assert.ok((await sample(page)).rms < 0.005, "paused is silent");

    // Audio tab (D249): import the music (it lands in Media); its tile's + puts it on the audio track at the playhead.
    await page.click("[data-testid=rail-audio]");
    await waitFor(page, "[data-testid=audio-library]");
    await waitFor(page, "[data-testid=library-source]");
    await page.click("[data-testid=audio-import]");
    await page.click("[data-testid=rail-media]");
    await waitFor(page, '[data-testid=media-tile][data-id="m-music"]', 20000);
    await page.click("[data-testid=timeline]");
    await page.keyboard.press("Home");
    let rev = await revision(page);
    await page.click('[data-testid=media-tile][data-id="m-music"] [data-testid=add-to-timeline]');
    rev = await savedAfter(page, rev);
    assert.deepEqual(music(), { id: "audio-1", type: "audio", media: "m-music", in: 0, duration: 240, start: 0 });
    await page.waitForFunction(() => {
      const c = document.querySelector<HTMLCanvasElement>('[data-item="audio-1"] [data-testid=waveform]');
      return c?.dataset.ready === "true" && Number(c.dataset.drawn) > 50;
    }, { timeout: 20000 });
    await (await page.$('[data-item="audio-1"]'))!.screenshot({ path: out("audio-waveform.png") });
    // The steady tone draws an even band: its middle row is lit across the item.
    const lit = await page.$eval('[data-item="audio-1"] [data-testid=waveform]', (c) => {
      const canvas = c as HTMLCanvasElement;
      const data = canvas.getContext("2d")!.getImageData(0, Math.floor(canvas.height / 2), canvas.width, 1).data;
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n++;
      return n / canvas.width;
    });
    assert.ok(lit > 0.9, `the waveform covers the item (${lit})`);

    // Mute the main track (its mute button is there because it holds a clip with sound): only the music.
    await page.click("[data-testid=track][data-id=main] [data-testid=track-mute]");
    rev = await savedAfter(page, rev);
    assert.equal(onDisk().tracks.find((t: { id: string }) => t.id === "main").mixer.mute, true);
    const steady = median((await listen(page, 150)).map((s) => s.rms));
    assert.ok(Math.abs(steady - 0.354) < 0.06, `the music alone: RMS ${steady.toFixed(3)}`);

    // −6 dB in the Inspector: about half the amplitude.
    await page.click('[data-testid=timeline-item][data-item="audio-1"]');
    await waitFor(page, "[data-testid=audio-editor]");
    await setField(page, "insp-volume-num", "-6");
    rev = await savedAfter(page, rev);
    assert.equal(music().gainDb, -6);
    const quieter = median((await listen(page, 150)).map((s) => s.rms));
    assert.ok(Math.abs(quieter / steady - 0.501) < 0.07, `−6 dB ≈ half: ${(quieter / steady).toFixed(3)}`);

    // Fades of 2 s at both ends: the level follows the ramp in, the steady middle and the ramp out.
    await page.click('[data-testid=timeline-item][data-item="audio-1"]');
    await setField(page, "insp-fade-in", "2");
    rev = await savedAfter(page, rev);
    await setField(page, "insp-fade-out", "2");
    rev = await savedAfter(page, rev);
    assert.equal(music().fadeIn, 60);
    assert.equal(music().fadeOut, 60);
    await page.waitForFunction(() => document.querySelectorAll('[data-item="audio-1"] [data-testid=fade-shape] path').length === 2);
    const fadeCheck = (samples: Array<Sample>, expected: (f: number) => number, what: string) => {
      for (const s of samples) {
        const want = expected(s.frame) * quieter;
        assert.ok(Math.abs(s.rms - want) < 0.05, `${what} at frame ${s.frame}: RMS ${s.rms.toFixed(3)}, expected ${want.toFixed(3)}`);
      }
    };
    const fadingIn = await listen(page, 6, { settle: 350, n: 5 });
    assert.ok(fadingIn.every((s) => s.frame < 60), "sampled inside the fade in");
    fadeCheck(fadingIn, (f) => Math.min(1, f / 60), "fade in");
    check(NO_REAL_AUDIO, fadingIn.at(-1)!.rms > fadingIn[0]!.rms + 0.02, `the fade in is rising: RMS ${fadingIn[0]!.rms.toFixed(3)} → ${fadingIn.at(-1)!.rms.toFixed(3)}`);
    fadeCheck(await listen(page, 100, { n: 3 }), () => 1, "steady");
    const fadingOut = await listen(page, 186, { settle: 350, n: 5 });
    assert.ok(fadingOut.every((s) => s.frame >= 180 && s.frame < 240), "sampled inside the fade out");
    fadeCheck(fadingOut, (f) => Math.max(0, (240 - f) / 60), "fade out");
    assert.ok(fadingOut.at(-1)!.rms < fadingOut[0]!.rms - 0.02, "falling");

    // The track's volume (header popover): another −6 dB on top.
    await page.click("[data-testid=track][data-id=audio] [data-testid=track-volume]");
    await waitFor(page, "[data-testid=track-volume-pop]");
    await setField(page, "track-volume-num", "-6");
    rev = await savedAfter(page, rev);
    assert.deepEqual(onDisk().tracks.find((t: { id: string }) => t.id === "audio").mixer, { gainDb: -6 });
    await page.mouse.click(5, 5);
    const both = median((await listen(page, 120)).map((s) => s.rms));
    assert.ok(Math.abs(both / steady - 0.251) < 0.05, `item −6 dB + track −6 dB ≈ a quarter: ${(both / steady).toFixed(3)}`);

    // Mute the audio track: silent while playing.
    await page.click("[data-testid=track][data-id=audio] [data-testid=track-mute]");
    rev = await savedAfter(page, rev);
    const muted = await listen(page, 120);
    assert.ok(muted.every((s) => s.playing && s.rms < 0.005), `muted is silent: ${JSON.stringify(muted.map((s) => s.rms))}`);

    // One undo step each: ⌘Z unmutes (and only that), the next takes the track volume back.
    await meta(page, "KeyZ");
    rev = await savedAfter(page, rev);
    assert.deepEqual(onDisk().tracks.find((t: { id: string }) => t.id === "audio").mixer, { gainDb: -6 });
    await meta(page, "KeyZ");
    rev = await savedAfter(page, rev);
    assert.equal(onDisk().tracks.find((t: { id: string }) => t.id === "audio").mixer, undefined);
    assert.equal(music().fadeOut, 60, "the fades are still there");
    await meta(page, "KeyZ");
    rev = await savedAfter(page, rev);
    assert.equal(music().fadeOut, undefined, "the next undo takes the fade out");
    assert.equal(music().fadeIn, 60);
    // Redo puts it back.
    await page.keyboard.down("Meta");
    await page.keyboard.down("Shift");
    await page.keyboard.press("KeyZ");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Meta");
    rev = await savedAfter(page, rev);
    assert.equal(music().fadeOut, 60);

    // A fade handle on the timeline: dragging the fade-in handle right lengthens the fade, one edit.
    await page.click('[data-testid=timeline-item][data-item="audio-1"]');
    const handle = (await (await page.$('[data-item="audio-1"] [data-testid=fade-in-handle]'))!.boundingBox())!;
    const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 30 * ppf, handle.y + handle.height / 2, { steps: 6 });
    await page.mouse.up();
    rev = await savedAfter(page, rev);
    assert.ok(Math.abs(music().fadeIn - 90) <= 3, `dragged to ~90 frames: ${music().fadeIn}`);
    assert.equal(music().start, 0, "the item didn't move");

    // The agent's next prompt lists the sound changes in words.
    await page.click("[data-testid=tab-agent]");
    await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"), { timeout: 30000 });
    await page.click("[data-testid=agent-input]");
    await page.keyboard.type("what did I change?");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=agent-turn]")?.dataset.status === "done", { timeout: 30000 });
    const prompt: string = JSON.parse(readFileSync(join(root, "prompts.jsonl"), "utf8").trim().split("\n")[0]!).prompt;
    assert.match(prompt, /Added audio audio-1 on track audio/);
    assert.match(prompt, /Muted track main/);
    assert.match(prompt, /Set volume of Music\.m4a \(audio-1\) to −6 dB/);
    assert.match(prompt, /Faded in Music\.m4a \(audio-1\) over 2\.0 s/);
    assert.match(prompt, /Faded out Music\.m4a \(audio-1\) over 2\.0 s/);
    assert.match(prompt, /Faded in Music\.m4a \(audio-1\) over 3\.0 s/);
    await page.screenshot({ path: out("audio-editor.png") });
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: out("audio-failure.png") }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-3000)}` });
  }
});

test("a hidden track's clip still sounds; muting is what silences it", { skip, timeout: 120000 }, async () => {
  const dir = join(root, "Hidden.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Hidden",
      canvas: { width: 1920, height: 1080, fps: 30 },
      media: [{ id: "m-talk", kind: "video", name: "Talk.mp4", path: join(root, "Talk.mp4"), probe: { frames: 120, fps: 30, width: 320, height: 240, hasAudio: true } }],
      tracks: [
        { id: "text", kind: "text", name: "Text", items: [] },
        { id: "main", kind: "video", role: "main", name: "Main", hidden: true, items: [{ id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 120, gainDb: -6 }] },
        { id: "audio", kind: "audio", name: "Audio", items: [] },
      ],
    }),
  );
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data-hidden"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  apps.add(app);
  const { page } = app;
  await waitForWelcome(page);
  // The mix as it is (D273 made At target the default): levels are measured against it.
  await viewerPrefs(page, { atTarget: false });
  await page.click("[data-testid=open-project]");
  await waitFor(page, "[data-testid=editor]");
  await page.click("[data-testid=timeline]");
  const hidden = await listen(page, 15);
  assert.equal(await page.$('video[data-item="clip-1"]'), null, "no picture");
  const rms = median(hidden.map((s) => s.rms));
  assert.ok(Math.abs(rms - 0.354 * 0.501) < 0.04, `heard at −6 dB: ${rms.toFixed(3)}`);
  await page.click("[data-testid=track][data-id=main] [data-testid=track-mute]");
  await page.waitForFunction(() => document.querySelector('[data-testid=track][data-id=main]')!.getAttribute("data-muted") === "true");
  const muted = await listen(page, 15);
  assert.ok(muted.every((s) => s.rms < 0.005), "muted");
  assert.deepEqual(app.errors, []);
});

/** Record the mix's level every animation frame until stop() (in the page), then read it back. */
const record = {
  start: (page: Page) =>
    page.evaluate(() => {
      const w = globalThis as unknown as { __rec: Array<{ frame: number; rms: number; t: number }>; __recOn: boolean; __uncutAudio: { level(): { rms: number } } };
      w.__rec = [];
      w.__recOn = true;
      const t0 = performance.now();
      const tick = () => {
        if (!w.__recOn) return;
        const frame = Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame);
        w.__rec.push({ frame, rms: w.__uncutAudio.level().rms, t: performance.now() - t0 });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  stop: (page: Page) =>
    page.evaluate(() => {
      const w = globalThis as unknown as { __rec: Array<{ frame: number; rms: number; t: number }>; __recOn: boolean };
      w.__recOn = false;
      return w.__rec;
    }),
};
const quietest = (rec: Array<{ rms: number; t: number }>, fromMs: number) => Math.min(...rec.filter((r) => r.t >= fromMs).map((r) => r.rms));

function writeProject(dir: string, tracks: Array<unknown>) {
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Mix",
      canvas: { width: 1920, height: 1080, fps: 30 },
      media: [
        { id: "m-talk", kind: "video", name: "Talk.mp4", path: join(root, "Talk.mp4"), probe: { frames: 120, fps: 30, width: 320, height: 240, hasAudio: true } },
        { id: "m-beep", kind: "audio", name: "Beep.m4a", path: join(root, "Beep.m4a"), probe: { frames: 45, hasAudio: true } },
      ],
      tracks,
    }),
  );
}

test("no dropouts: a hard cut between split clips, hiding and showing a track while playing and paused", { skip: skip || NO_REAL_AUDIO, timeout: 180000 }, async () => {
  const dir = join(root, "Cuts.uncut");
  writeProject(dir, [
    { id: "text", kind: "text", name: "Text", items: [] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 60 }, { id: "clip-2", type: "clip", media: "m-talk", in: 60, duration: 60 }] },
    { id: "audio", kind: "audio", name: "Audio", items: [] },
  ]);
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data-cuts"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  apps.add(app);
  const { page } = app;
  const steady = 0.354;
  try {
    await waitForWelcome(page);
    // The mix as it is (D273 made At target the default): levels are measured against it.
    await viewerPrefs(page, { atTarget: false });
    await page.click("[data-testid=open-project]");
    await waitFor(page, "[data-testid=editor]");
    await page.click("[data-testid=timeline]");
    await sleep(800);

    // The cut at frame 60 (the same file on both sides): the outgoing clip ramps out while the
    // incoming one, already running, ramps in. The level around the cut stays up.
    await goTo(page, 30);
    await record.start(page);
    await page.keyboard.press("Space");
    await sleep(1800);
    await page.keyboard.press("Space");
    const cut = await record.stop(page);
    const around = cut.filter((r) => r.frame >= 50 && r.frame <= 75);
    assert.ok(around.length > 10, `sampled around the cut (${around.length})`);
    const dip = Math.min(...around.map((r) => r.rms));
    assert.ok(dip > 0.5 * steady, `no dropout at the cut: lowest RMS ${dip.toFixed(3)} (${JSON.stringify(around.map((r) => [r.frame, Number(r.rms.toFixed(3))]))})`);

    // Hide main while playing, then show it again: the sound carries on (an <audio> takes over and
    // hands back), with no gap.
    await goTo(page, 0);
    await record.start(page);
    await page.keyboard.press("Space");
    await sleep(700);
    await page.click("[data-testid=track][data-id=main] [data-testid=track-hide]");
    await page.waitForFunction(() => document.querySelector("[data-testid=track][data-id=main]")!.getAttribute("data-hidden") === "true");
    await sleep(700);
    await page.click("[data-testid=track][data-id=main] [data-testid=track-hide]");
    await page.waitForFunction(() => document.querySelector("[data-testid=track][data-id=main]")!.getAttribute("data-hidden") === null);
    await sleep(700);
    await page.keyboard.press("Space");
    const toggled = await record.stop(page);
    const low = quietest(toggled, 400);
    assert.ok(low > 0.5 * steady, `hiding and showing mid-play doesn't drop the sound: lowest ${low.toFixed(3)} (${JSON.stringify(toggled.filter((r) => r.rms < 0.25).map((r) => [Math.round(r.t), r.frame, Number(r.rms.toFixed(3))]))})`);
    assert.deepEqual(app.errors, []);

    // Paused: hide, then play: heard (the hidden clip's sound comes from an <audio>), in time.
    await page.click("[data-testid=track][data-id=main] [data-testid=track-hide]");
    await page.waitForFunction(() => document.querySelector("[data-testid=track][data-id=main]")!.getAttribute("data-hidden") === "true");
    await page.click("[data-testid=timeline]");
    const hidden = await listen(page, 20);
    assert.ok(Math.abs(median(hidden.map((x) => x.rms)) - steady) < 0.06, `hidden while paused, then played: ${median(hidden.map((x) => x.rms)).toFixed(3)}`);
    assert.ok(hidden.every((x) => x.gains["clip-1"] === 1));
    // Show it again while paused: heard through the <video> again.
    await page.click("[data-testid=track][data-id=main] [data-testid=track-hide]");
    await page.waitForFunction(() => document.querySelector("[data-testid=track][data-id=main]")!.getAttribute("data-hidden") === null);
    await page.click("[data-testid=timeline]");
    const shown = await listen(page, 20);
    assert.ok(Math.abs(median(shown.map((x) => x.rms)) - steady) < 0.06, `shown again: ${median(shown.map((x) => x.rms)).toFixed(3)}`);
    const own = await page.evaluate(() => (globalThis as unknown as { __uncutAudio: { state(): { items: Array<{ id: string; own: boolean }> } } }).__uncutAudio.state().items);
    assert.deepEqual(own.filter((i) => i.id === "clip-1").map((i) => i.own), [false], "through the clip's own <video>");
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: out("audio-cuts-failure.png") }).catch(() => {});
    throw error;
  }
});

test("a clip at 2× speed plays its sound at that rate without re-seeking; a looped sound wraps without a gap", { skip: skip || NO_REAL_AUDIO, timeout: 120000 }, async () => {
  const dir = join(root, "Speed.uncut");
  writeProject(dir, [
    { id: "text", kind: "text", name: "Text", items: [] },
    { id: "main", kind: "video", role: "main", name: "Main", mixer: { mute: true }, items: [{ id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 60, speed: 2 }] },
    { id: "audio", kind: "audio", name: "Audio", items: [{ id: "loop-1", type: "audio", media: "m-beep", in: 0, start: 0, duration: 120, loop: true }] },
  ]);
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data-speed"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  apps.add(app);
  const { page } = app;
  const steady = 0.354;
  await waitForWelcome(page);
  // The mix as it is (D273 made At target the default): levels are measured against it.
  await viewerPrefs(page, { atTarget: false });
  await page.click("[data-testid=open-project]");
  await waitFor(page, "[data-testid=editor]");
  await page.click("[data-testid=timeline]");
  await sleep(800);

  // The loop (1.5 s of tone, 4 s long): through two wraps the level stays up.
  await goTo(page, 0);
  await record.start(page);
  await page.keyboard.press("Space");
  await sleep(3600);
  await page.keyboard.press("Space");
  const loop = await record.stop(page);
  assert.ok(loop.some((r) => r.frame > 95), "played past two wraps");
  const low = quietest(loop.filter((r) => r.frame < 115), 400);
  assert.ok(low > 0.5 * steady, `no gap where the loop wraps: lowest ${low.toFixed(3)} (${JSON.stringify(loop.filter((r) => r.rms < 0.2).map((r) => [r.frame, Number(r.rms.toFixed(3))]))})`);

  // The clip at 2×: unmute main, mute the loop. Its <video> runs at rate 2 and isn't re-seeked.
  await page.click("[data-testid=track][data-id=main] [data-testid=track-mute]");
  await page.waitForFunction(() => document.querySelector("[data-testid=track][data-id=main]")!.getAttribute("data-muted") === null);
  await page.click("[data-testid=track][data-id=audio] [data-testid=track-mute]");
  await page.waitForFunction(() => document.querySelector("[data-testid=track][data-id=audio]")!.getAttribute("data-muted") === "true");
  await page.click("[data-testid=timeline]");
  await goTo(page, 0);
  await page.keyboard.press("Space");
  await sleep(400);
  await page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('video[data-item="clip-1"]')!;
    (globalThis as unknown as { __seeks: number }).__seeks = 0;
    v.addEventListener("seeking", () => (globalThis as unknown as { __seeks: number }).__seeks++);
  });
  await record.start(page);
  await sleep(1000);
  const sped = await record.stop(page);
  const { rate, seeks } = await page.evaluate(() => ({ rate: document.querySelector<HTMLVideoElement>('video[data-item="clip-1"]')!.playbackRate, seeks: (globalThis as unknown as { __seeks: number }).__seeks }));
  await page.keyboard.press("Space");
  assert.equal(rate, 2);
  assert.ok(seeks <= 1, `re-seeked ${seeks} times in a second`);
  const spedLow = quietest(sped.filter((r) => r.frame < 55), 0);
  assert.ok(spedLow > 0.5 * steady, `steady at 2×: lowest ${spedLow.toFixed(3)}`);
  assert.deepEqual(app.errors, []);
});
