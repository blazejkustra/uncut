// Issue #55: a busy preview doesn't glitch, on the packaged app (run invisibly and muted), DOM path
// (the GPU compositor stays off, as by default).
// The stress project: a main clip, 20 video overlay tracks in a 5×4 grid and 24 text tracks between
// them (texts fade, type, come in word by word or pulse all the time; 24 on screen at once):
// - A (0–8 s): 12 overlays, plain, half 1280×720 (shown through D222's untone filter), half 640×360;
// - B (8–16 s): the same 12 tracks cut to new clips of the same files at other in-points;
// - C (16–24 s): all 20 overlays with a look and sharpen (more effects canvases than Chromium has
//   WebGL contexts for a page).
// Runs, each sampled once per animation frame (test/helpers/preview-glitches.ts): 4.5 s of playback
// across the A→B cut, 4 s across B→C, then scrubbing (arrow steps and ruler clicks over all three).
// Asserted zero: layers that blank after showing (flash), layers not drawn 1.5 s after the playhead
// entered them (late), effects lost after they showed (look flash), videos more than 0.25 s from the
// playhead (stale) or presenting nothing for 0.5 s (frozen) while playing, layers stacked against their
// tracks (order), WebGL contexts lost, a second compositor made (a re-mount), and animation frames
// over 150 ms (a visible hitch; 25 and 50 ms counts are printed, not asserted, as they depend on the
// machine). Each run prints "# issue55 ..." with the counts, what each one was, and per-size video
// frame rates.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { countGlitches, startGlitchProbe, stopGlitchProbe, type GlitchCounts, type GlitchLayer, type GlitchSample } from "../helpers/preview-glitches.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 30;
const SEG = 8 * FPS;
const PLAIN = 12;
const OVERLAYS = 20;
const TEXT_TRACKS = 24;
const TEXT_LEN = 90;
const LONG_MS = 150;
let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const layers: Array<GlitchLayer> = [];
const small = new Set<string>();
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue55-")));
  dir = join(root, "Busy.uncut");
  mkdirSync(join(dir, "media"), { recursive: true });
  const seconds = String((3 * SEG) / FPS + 4);
  const make = (size: string, file: string) => execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${FPS}`, "-t", seconds, "-c:v", "libx264", "-preset", "veryfast", "-g", "30", "-bf", "0", "-pix_fmt", "yuv420p", join(root, file)]);
  make("1280x720", "Layer.mp4");
  make("640x360", "Small.mp4");
  const frames = 3 * SEG + 4 * FPS;
  const media = [
    { id: "m-layer", kind: "video", name: "Layer.mp4", path: join(root, "Layer.mp4"), probe: { frames, fps: FPS, width: 1280, height: 720, hasAudio: false } },
    { id: "m-small", kind: "video", name: "Small.mp4", path: join(root, "Small.mp4"), probe: { frames, fps: FPS, width: 640, height: 360, hasAudio: false } },
  ];
  const fx = [{ module: "effect.look", params: { look: "warm", intensity: 1 } }, { module: "effect.sharpen" }];
  const tracks: Array<Record<string, unknown>> = [];
  const moves = [
    { in: { module: "move.fade", duration: 15 }, out: { module: "move.fade", duration: 15 } },
    { in: { module: "move.typewriter", duration: 45 } },
    { in: { module: "move.word-by-word", duration: 40, params: { style: "rise" } }, out: { module: "move.fade", duration: 10 } },
    { loop: { module: "move.pulse", duration: 30 } },
  ];
  const textTrack = (k: number) => ({
    id: `tt${k}`,
    kind: "text",
    name: `Text ${k + 1}`,
    items: Array.from({ length: (3 * SEG) / TEXT_LEN }, (_, j) => ({
      id: `x${k}_${j}`,
      type: "text",
      start: j * TEXT_LEN,
      duration: TEXT_LEN,
      text: `Layer ${k + 1} title ${j + 1}`,
      transform: { x: 40 + (k % 4) * 470, y: 30 + Math.floor(k / 4) * 170 },
      style: { preset: "text.title", size: 44, weight: 700 },
      animation: moves[(k + j) % moves.length],
    })),
  });
  const box = (i: number) => ({ x: 12 + (i % 5) * 380, y: 12 + Math.floor(i / 5) * 268, w: 370, h: 258, fit: "cover", radius: 14, opacity: 0.95 });
  const overlay = (i: number) => {
    const m = i % 2 ? "m-small" : "m-layer";
    const items = [
      ...(i < PLAIN
        ? [
            { id: `a${i}`, type: "clip", media: m, start: 0, in: (i * 7) % 60, duration: SEG, transform: box(i) },
            { id: `b${i}`, type: "clip", media: m, start: SEG, in: SEG + ((i * 11) % 60), duration: SEG, transform: box(i) },
          ]
        : []),
      { id: `c${i}`, type: "clip", media: "m-layer", start: 2 * SEG, in: (i * 13) % 60, duration: SEG, transform: box(i), effects: fx },
    ];
    for (const it of items) if (it.media === "m-small") small.add(it.id);
    return { id: `ov${i}`, kind: "video", name: `Overlay ${i + 1}`, items };
  };
  // Tracks above Main come first: text and video tracks interleaved, so stacking is checked across both.
  for (let k = 0; k < TEXT_TRACKS; k++) {
    tracks.push(textTrack(k));
    if (k < OVERLAYS) tracks.push(overlay(k));
  }
  tracks.push({ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "main1", type: "clip", media: "m-layer", in: 0, duration: 3 * SEG }] });
  tracks.forEach((t, track) => {
    for (const it of t.items as Array<{ id: string; type: string; start?: number; duration: number; in?: number; effects?: unknown }>)
      layers.push({ id: it.id, kind: it.type === "text" ? "text" : "video", track, start: it.start ?? 0, duration: it.duration, ...(it.type === "clip" ? { in: it.in ?? 0 } : {}), ...(it.effects ? { fx: true } : {}) });
  });
  writeFileSync(join(dir, "project.json"), JSON.stringify({ format: "uncut/0", name: "Busy", canvas: { width: 1920, height: 1080, fps: FPS }, textLooks: 1, media, tracks }));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

async function clickAt(f: number) {
  const ruler = (await (await page.$("[data-testid=ruler]"))!.boundingBox())!;
  const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
  const scroll = await page.$eval(".bottom-body", (el) => el.scrollLeft);
  await page.mouse.click(ruler.x + 0.5 + f * ppf - scroll, ruler.y + ruler.height / 2);
}

const ready = () => page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => v.readyState >= 2 && !v.seeking), { timeout: 20000 });

/** Counts a run's glitches and prints them. */
function report(label: string, r: Awaited<ReturnType<typeof stopGlitchProbe>>, lateMs: number): GlitchCounts & { contextLost: number } {
  const c = countGlitches(r.samples, layers, { fps: FPS, lateMs, longMs: LONG_MS });
  const gaps = r.samples.slice(1).map((s, i) => s.t - r.samples[i]!.t);
  // Frames presented per second by each size of footage while playing (min over the layers on screen).
  const rate = (pick: (id: string) => boolean) => {
    const playing = r.samples.filter((s) => s.playing);
    if (playing.length < 2) return "-";
    const first = playing[0]!;
    const last = playing.at(-1)!;
    const s = (last.t - first.t) / 1000;
    const rates = layers.filter((l) => l.kind === "video" && pick(l.id) && first.layers[l.id]?.p !== undefined && last.layers[l.id]?.p !== undefined).map((l) => (last.layers[l.id]!.p! - first.layers[l.id]!.p!) / s);
    return rates.length ? `${Math.min(...rates).toFixed(1)}–${(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(1)} fps (min–mean of ${rates.length})` : "-";
  };
  console.log(
    `# issue55 ${label}: ${r.samples.length} samples; flash ${c.flash}, late ${c.late}, look flash ${c.lookFlash}, stale ${c.stale}, frozen ${c.frozen}, order ${c.order}, contexts lost ${r.contextLost}, frames > ${LONG_MS} ms ${c.longFrames} (worst ${c.worstFrameMs.toFixed(0)} ms; > 25 ms ${gaps.filter((g) => g > 25).length}, > 50 ms ${gaps.filter((g) => g > 50).length}); seeking events while playing ${r.playSeeks} (incl. each video's seek as playback starts; drift seeks are stats.playSeeks); videos presented: 1280×720 ${rate((id) => !small.has(id))}, 640×360 ${rate((id) => small.has(id))}; stats ${JSON.stringify(r.stats)}`,
  );
  if (c.details.length) console.log(`# issue55 ${label} details: ${c.details.slice(0, 60).join("; ")}`);
  return { ...c, contextLost: r.contextLost };
}

async function play(label: string, from: number, ms: number) {
  await clickAt(from);
  await ready();
  await sleep(500);
  await startGlitchProbe(page, layers.map((l) => l.id));
  await page.keyboard.press("Space");
  await sleep(ms);
  await page.keyboard.press("Space");
  await sleep(200);
  const r = await stopGlitchProbe(page);
  const counts = await page.evaluate(() => ({
    videos: document.querySelectorAll("video[data-item]").length,
    fxOwn: document.querySelectorAll("canvas[data-fx]:not([data-fx-shared])").length,
    fxShared: document.querySelectorAll("canvas[data-fx][data-fx-shared]").length,
    filtered: [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].filter((v) => v.style.filter.includes("url(")).length,
  }));
  console.log(`# issue55 ${label} elements: ${JSON.stringify(counts)}`);
  return report(label, r, 1000);
}

test("issue #55: 20 video overlays and ~20 animated texts play and scrub without glitches", { skip, timeout: 600000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  await page.click("[data-testid=bottom-timeline]");
  const gpuOn = await page.evaluate(() => {
    try {
      return localStorage.getItem("uncut.preview.gpu") === "true";
    } catch {
      return false;
    }
  });
  assert.equal(gpuOn, false, "the GPU compositor is off (the DOM path is under test)");

  const runs: Record<string, GlitchCounts & { contextLost: number }> = {};
  runs["play A→B"] = await play("play across the A→B cut (12 overlays)", SEG - 60, 4500);
  runs["play B→C"] = await play("play across B→C (20 overlays with effects)", 2 * SEG - 45, 4000);

  // Scrubbing: arrow steps in C (every effects layer), then ruler clicks over all three parts.
  await clickAt(2 * SEG + 60);
  await ready();
  await sleep(500);
  await startGlitchProbe(page, layers.map((l) => l.id));
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press(i < 20 ? "ArrowRight" : "ArrowLeft");
    await sleep(70);
  }
  const random = rng(55);
  for (let i = 0; i < 8; i++) {
    await clickAt(30 + Math.floor(random() * (3 * SEG - 60)));
    await sleep(900);
  }
  await sleep(1000);
  const scrub = await stopGlitchProbe(page);
  runs["scrub"] = report("scrub (30 arrow steps, 8 ruler clicks)", scrub, 1500);

  // Settled after the last click: every layer the playhead is in is drawn, at its frame.
  const last: GlitchSample = scrub.samples.at(-1)!;
  const inside = layers.filter((l) => last.frame >= l.start + 2 && last.frame < l.start + l.duration - 2);
  const missing = inside.filter((l) => !last.layers[l.id]?.d).map((l) => l.id);
  const off = inside.filter((l) => l.kind === "video" && last.layers[l.id]?.mt !== undefined && Math.abs(last.layers[l.id]!.mt! - ((l.in ?? 0) + last.frame - l.start) / FPS) > 1.5 / FPS).map((l) => `${l.id} ${last.layers[l.id]!.mt!.toFixed(3)}`);
  console.log(`# issue55 settled at frame ${last.frame}: ${inside.length} layers, not drawn [${missing.join(", ")}], off their frame [${off.join(", ")}]`);
  assert.deepEqual(missing, [], "every layer is drawn once the playhead rests");
  assert.deepEqual(off, [], "every video shows the playhead's frame once it rests");

  const stats = scrub.stats;
  console.log(`# issue55 results ${JSON.stringify(Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, { ...v, details: v.details.length }])))}`);
  assert.equal(stats?.compositors, 1, "the preview's compositor was made once (no re-mount)");
  for (const [name, c] of Object.entries(runs)) {
    assert.equal(c.flash, 0, `${name}: layers blanked after showing`);
    assert.equal(c.late, 0, `${name}: layers not drawn in time`);
    assert.equal(c.lookFlash, 0, `${name}: effects lost after showing`);
    assert.equal(c.stale, 0, `${name}: videos off the playhead while playing`);
    assert.equal(c.frozen, 0, `${name}: videos stopped presenting while playing`);
    assert.equal(c.order, 0, `${name}: layers stacked out of their tracks' order`);
    assert.equal(c.contextLost, 0, `${name}: WebGL contexts lost`);
    assert.equal(c.longFrames, 0, `${name}: animation frames over ${LONG_MS} ms`);
  }
  assert.deepEqual(app.errors, []);
});
