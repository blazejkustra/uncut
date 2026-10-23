// Issue #118 (preview performance): a music video's edit on the packaged app, measured. A 4-minute
// song on an audio track, 40 cuts of three long takes (with their camera sound) and two
// minute-long takes on Main, overlays and 24 titles; the CPU slowed 4× (a busy or older Mac).
// Measured, and printed as "# issue118 ...", each with the main thread's script, layout and style
// time per step (Chromium's counters, which don't round to frames as the wall times do):
// - zoom: from a click on Zoom in until the frame after it is painted, 12 steps from Fit (median, max);
// - scroll: the zoomed-in timeline scrolled across in 40 steps, each step's frame time (median, max);
// - select: clicking items on the zoomed-in timeline, from the click until the frame after it is painted;
// - typing: 30 keys typed in the Agent tab's composer (each one is app state the whole editor hears), per key;
// - hover: the pointer moved across the lanes (skimming draws each frame), per move (median, max);
// - playback: 4 s of playing at Fit and zoomed in, animation frame intervals (median, p95, frames
//   over 50 ms), the compositor's draw time (median) and the main thread's time per second.
// UNCUT_TEST_APP runs it on another build (the numbers before a change); UNCUT_PROFILE=<file> saves a
// CPU profile of the run. Checks only loose ceilings: the numbers are what this file is for.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CDPSession, Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve(process.env.UNCUT_TEST_APP ?? "dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 30;
const SONG_S = 240;
let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
let cdp: CDPSession;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Record<string, unknown> = {};

const median = (xs: ReadonlyArray<number>) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};
const pct = (xs: ReadonlyArray<number>, p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : 0;
};
const round = (x: number) => Math.round(x * 10) / 10;

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue118-perf-")));
  // Three long takes (4 min each, 1280×720, a keyframe every 2 s) and the song.
  for (const [name, src] of [["take-a.mp4", "testsrc2"], ["take-b.mp4", "smptebars"], ["take-c.mp4", "rgbtestsrc"]] as const) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `${src}=s=1280x720:r=${FPS}`, "-f", "lavfi", "-i", `anoisesrc=a=0.1:d=${SONG_S}`, "-t", String(SONG_S), "-c:v", "libx264", "-preset", "ultrafast", "-g", "60", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(root, name)]);
  }
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=f=220:beep_factor=4:d=${SONG_S}`, "-c:a", "aac", join(root, "song.m4a")]);
  const probe = { frames: SONG_S * FPS, fps: FPS, width: 1280, height: 720, hasAudio: true };
  const takes = ["m-a", "m-b", "m-c"];
  // 40 cuts of 3 s on Main, each from a different moment of one of the takes, then two long takes (a minute each).
  const cuts = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: `cut-${i + 1}`, type: "clip", media: takes[i % 3], in: ((i * 137) % (SONG_S - 4)) * FPS, duration: 3 * FPS })),
    { id: "long-1", type: "clip", media: "m-a", in: 0, duration: 60 * FPS },
    { id: "long-2", type: "clip", media: "m-b", in: 0, duration: 60 * FPS },
  ];
  const overlays = Array.from({ length: 12 }, (_, i) => ({ id: `over-${i + 1}`, type: "clip", media: takes[(i + 1) % 3], in: i * 300, start: i * 600 + 60, duration: 150, transform: { x: 1280, y: 60, w: 560, fit: "cover" } }));
  const titles = Array.from({ length: 24 }, (_, i) => ({ id: `title-${i + 1}`, type: "text", start: i * 300, duration: 90, text: `Verse ${i + 1}`, transform: { x: 154, y: 410 }, style: { preset: "text.title", size: 110, weight: 700 } }));
  dir = join(root, "Music video.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Music video",
      canvas: { width: 1920, height: 1080, fps: FPS },
      media: [
        { id: "m-a", kind: "video", name: "take-a.mp4", path: join(root, "take-a.mp4"), probe },
        { id: "m-b", kind: "video", name: "take-b.mp4", path: join(root, "take-b.mp4"), probe },
        { id: "m-c", kind: "video", name: "take-c.mp4", path: join(root, "take-c.mp4"), probe },
        { id: "m-song", kind: "audio", name: "song.m4a", path: join(root, "song.m4a"), probe: { frames: SONG_S * FPS, hasAudio: true } },
      ],
      tracks: [
        { id: "text", kind: "text", name: "Text", items: titles },
        { id: "overlay", kind: "video", name: "Overlay", items: overlays },
        { id: "main", kind: "video", role: "main", name: "Main", items: cuts },
        { id: "audio", kind: "audio", name: "Song", items: [{ id: "song", type: "audio", media: "m-song", in: 0, start: 0, duration: SONG_S * FPS }] },
      ],
    }),
  );
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector('[data-testid=timeline-item][data-item="long-2"]', { timeout: 30000 });
  // Filmstrips and the song's waveform made and drawn before anything is measured.
  await page.waitForFunction(() => document.querySelector("[data-testid=waveform][data-ready=true]") && document.querySelector("[data-testid=filmstrip][data-ready=true]"), { timeout: 120000 }).catch(() => {});
  await sleep(1000);
  cdp = await page.createCDPSession();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Performance.enable");
  if (process.env.UNCUT_PROFILE) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  }
});
after(async () => {
  if (cdp && process.env.UNCUT_PROFILE) {
    const { profile } = await cdp.send("Profiler.stop");
    writeFileSync(process.env.UNCUT_PROFILE, JSON.stringify(profile));
  }
  console.log(`# issue118 ${JSON.stringify(results)}`);
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** The main thread's script, layout and style time so far (ms, Chromium's own counters). */
const busyNow = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = (name: string) => (metrics.find((x) => x.name === name)?.value ?? 0) * 1000;
  return { script: m("ScriptDuration"), layout: m("LayoutDuration"), style: m("RecalcStyleDuration") };
};
/** Runs `steps` and returns the main thread's script, layout and style time per step (ms). */
async function busy(steps: number, run: () => Promise<void>) {
  const a = await busyNow();
  await run();
  const b = await busyNow();
  return { script: round((b.script - a.script) / steps), layout: round((b.layout - a.layout) / steps), style: round((b.style - a.style) / steps) };
}

/** Runs `act` in the page and returns ms until the frame after it is painted (two animation frames). */
const paintAfter = (act: string) =>
  page.evaluate(async (code) => {
    const t0 = performance.now();
    new Function(code)();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.now() - t0;
  }, act);

test("zoom: Zoom in from Fit, 12 steps", { skip, timeout: 120000 }, async () => {
  await page.click("[data-testid=zoom-fit]");
  await sleep(300);
  const times: Array<number> = [];
  const cost = await busy(12, async () => {
    for (let i = 0; i < 12; i++) times.push(await paintAfter("document.querySelector('[data-testid=zoom-in]').click()"));
  });
  results.zoom = { median: round(median(times)), max: round(Math.max(...times)), ...cost };
  assert.ok(median(times) < 2000);
});

test("scroll: the zoomed-in timeline scrolled across", { skip, timeout: 120000 }, async () => {
  const times: Array<number> = [];
  const width = await page.$eval(".bottom-body", (el) => el.scrollWidth - el.clientWidth);
  const cost = await busy(40, async () => {
    for (let i = 1; i <= 40; i++) times.push(await paintAfter(`document.querySelector('.bottom-body').scrollLeft = ${Math.round((width * i) / 40)}`));
  });
  results.scroll = { median: round(median(times)), max: round(Math.max(...times)), ...cost };
});

test("select: items clicked on the zoomed-in timeline", { skip, timeout: 120000 }, async () => {
  await page.$eval(".bottom-body", (el) => (el.scrollLeft = el.scrollWidth));
  await sleep(300);
  const times: Array<number> = [];
  const cost = await busy(10, async () => {
    for (let i = 0; i < 10; i++) times.push(await paintAfter(`document.querySelector('[data-testid=timeline-item][data-item="long-${1 + (i % 2)}"]')?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 })); window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))`));
  });
  results.select = { median: round(median(times)), max: round(Math.max(...times)), ...cost };
  await page.keyboard.press("Escape");
  await page.click("[data-testid=zoom-fit]");
  await sleep(500);
});

test("typing: 30 keys in the Agent tab's composer", { skip, timeout: 120000 }, async () => {
  await page.click("[data-testid=tab-agent]");
  await page.waitForSelector("[data-testid=agent-input]");
  await page.click("[data-testid=agent-input]");
  const times: Array<number> = [];
  const cost = await busy(30, async () => {
    for (let i = 0; i < 30; i++) {
      const t0 = Date.now();
      await page.keyboard.type("abcdefghij"[i % 10]!);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      times.push(Date.now() - t0);
    }
  });
  results.typing = { median: round(median(times)), max: round(Math.max(...times)), ...cost };
  await page.$eval("[data-testid=agent-input]", (el) => (el as HTMLTextAreaElement).blur());
});

test("hover: the pointer moved across the lanes", { skip, timeout: 120000 }, async () => {
  const lane = (await (await page.$('[data-testid=lane][data-track="main"]'))!.boundingBox())!;
  const times: Array<number> = [];
  const cost = await busy(40, async () => {
    for (let i = 0; i < 40; i++) {
      const t0 = Date.now();
      await page.mouse.move(lane.x + 20 + ((lane.width - 40) * i) / 40, lane.y + lane.height / 2);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      times.push(Date.now() - t0);
    }
  });
  await page.mouse.move(5, 5);
  results.hover = { median: round(median(times)), max: round(Math.max(...times)), ...cost };
});

/** Plays 4 s from the start, at the timeline's zoom `zoomSteps` steps in from Fit: animation frame intervals and draw times. */
async function measurePlayback(zoomSteps: number) {
  await page.click("[data-testid=zoom-fit]");
  for (let i = 0; i < zoomSteps; i++) await page.click("[data-testid=zoom-in]");
  await page.keyboard.press("Home");
  await sleep(800);
  await page.evaluate(() => (globalThis as { __uncutPreview?: { renderMs: () => Array<number> } }).__uncutPreview?.renderMs());
  const before = await busyNow();
  await page.keyboard.press("Space");
  const intervals = await page.evaluate(
    () =>
      new Promise<Array<number>>((resolveIt) => {
        const out: Array<number> = [];
        let last = performance.now();
        const end = last + 4000;
        const tick = (now: number) => {
          out.push(now - last);
          last = now;
          if (now < end) requestAnimationFrame(tick);
          else resolveIt(out);
        };
        requestAnimationFrame(tick);
      }),
  );
  await page.keyboard.press("Space");
  const after = await busyNow();
  const draws = await page.evaluate(() => (globalThis as { __uncutPreview?: { renderMs: () => Array<number> } }).__uncutPreview?.renderMs() ?? []);
  // The main thread's script, layout and style time per second of playing.
  const perSecond = { script: round((after.script - before.script) / 4), layout: round((after.layout - before.layout) / 4), style: round((after.style - before.style) / 4) };
  return { ...perSecond, fps: round(1000 / (intervals.reduce((a, b) => a + b, 0) / intervals.length)), median: round(median(intervals)), p95: round(pct(intervals, 0.95)), over50: intervals.filter((x) => x > 50).length, drawMedian: round(median(draws)) };
}

test("playback: 4 s from the start, at Fit and zoomed in (the playhead pages the view)", { skip, timeout: 120000 }, async () => {
  results.playback = await measurePlayback(0);
  results.playbackZoomed = await measurePlayback(10);
  await page.click("[data-testid=zoom-fit]");
});
