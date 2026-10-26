// D311: the preview keeps up with fast cuts, on the packaged app (run invisibly and muted). The
// project plays originals (no proxies): 720p H.264 without B-frames (as proxies are), 1080p60 H.264
// with a 2 s GOP, 4K HEVC and 1440p H.264 with B-frames, two with sound; 48 main-track cuts of 0.2
// to 0.5 s at random in-points, then 6 s where three picture-in-picture tracks cut just as fast over
// the main track.
// The whole project plays once with the GPU compositor (the default) and once on the DOM path; each
// run is sampled once per animation frame (test/helpers/preview-glitches.ts) and scored by
// test/helpers/playback-bench.ts: late samples, frozen-picture time, cut latency, dropped frames and
// how far the playhead fell behind the wall clock. Every run prints "# fastcuts ..." and the numbers
// go to test-output/fast-cuts-bench.json. The bounds need a real GPU and media engine.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { viewerPrefs } from "../helpers/viewer-prefs.ts";
import { startGlitchProbe, stopGlitchProbe, type GlitchLayer } from "../helpers/preview-glitches.ts";
import { benchPlayback, formatBench, type BenchResult } from "../helpers/playback-bench.ts";
import { NO_REAL_GPU, check } from "../helpers/capabilities.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 30;
const SOURCE_S = 30;
const MAIN_CUTS = 48;
const STACK_S = 6;
const OVERLAYS = 3;

interface Source {
  readonly id: string;
  readonly file: string;
  readonly codec: "libx264" | "libx265";
  readonly size: string;
  readonly rate: number;
  readonly pattern: string;
  readonly gop: number;
  readonly bframes: number;
  readonly sound: boolean;
}

const SOURCES: ReadonlyArray<Source> = [
  { id: "m-a", file: "A.mp4", codec: "libx264", size: "1280x720", rate: 30, pattern: "testsrc2", gop: 30, bframes: 0, sound: true },
  { id: "m-b", file: "B.mp4", codec: "libx264", size: "1920x1080", rate: 60, pattern: "smptehdbars", gop: 120, bframes: 3, sound: false },
  { id: "m-c", file: "C.mp4", codec: "libx265", size: "3840x2160", rate: 30, pattern: "testsrc", gop: 60, bframes: 2, sound: true },
  { id: "m-d", file: "D.mp4", codec: "libx264", size: "2560x1440", rate: 30, pattern: "rgbtestsrc", gop: 90, bframes: 2, sound: false },
];

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
let projectFrames = 0;
const layers: Array<GlitchLayer> = [];
const results: Record<string, BenchResult> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

function makeSource(s: Source) {
  const [w, h] = s.size.split("x");
  const video = ["-f", "lavfi", "-i", `${s.pattern}=size=${w}x${h}:rate=${s.rate}`];
  const audio = s.sound ? ["-f", "lavfi", "-i", `sine=frequency=${s.id === "m-a" ? 440 : 660}:sample_rate=48000`] : [];
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    ...video,
    ...audio,
    "-t",
    String(SOURCE_S),
    "-c:v",
    s.codec,
    "-preset",
    "ultrafast",
    ...(s.codec === "libx265"
      ? ["-tag:v", "hvc1", "-x265-params", `keyint=${s.gop}:min-keyint=${s.gop}:bframes=${s.bframes}:log-level=error`]
      : ["-g", String(s.gop), "-bf", String(s.bframes)]),
    "-pix_fmt",
    "yuv420p",
    ...(s.sound ? ["-c:a", "aac", "-b:a", "128k"] : []),
    join(root, s.file),
  ]);
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-fastcuts-")));
  dir = join(root, "FastCuts.uncut");
  mkdirSync(join(dir, "media"), { recursive: true });
  for (const s of SOURCES) makeSource(s);
  const media = SOURCES.map((s) => {
    const [w, h] = s.size.split("x").map(Number);
    return {
      id: s.id,
      kind: "video",
      name: s.file,
      path: join(root, s.file),
      probe: { frames: SOURCE_S * s.rate, fps: s.rate, width: w, height: h, hasAudio: s.sound },
    };
  });
  const random = rng(311);
  const cut = (id: string, start?: number) => {
    const source = SOURCES[Math.floor(random() * SOURCES.length)]!;
    const duration = 6 + Math.floor(random() * 10);
    const inPoint = Math.floor(random() * (SOURCE_S - 2) * FPS);
    return { id, type: "clip", media: source.id, in: inPoint, duration, ...(start !== undefined ? { start } : {}) };
  };
  const main: Array<ReturnType<typeof cut>> = [];
  let at = 0;
  for (let i = 0; i < MAIN_CUTS; i++) {
    const c = cut(`main${i}`);
    main.push(c);
    at += c.duration;
  }
  const stackStart = at;
  while (at < stackStart + STACK_S * FPS) {
    const c = cut(`main${main.length}`);
    main.push(c);
    at += c.duration;
  }
  projectFrames = at;
  const box = (i: number) => ({ x: 60 + i * 610, y: 640, w: 560, h: 315, fit: "cover", radius: 12 });
  const overlays = Array.from({ length: OVERLAYS }, (_, i) => {
    const items: Array<Record<string, unknown>> = [];
    let t = stackStart;
    while (t < projectFrames - 6) {
      const c = cut(`ov${i}-${items.length}`, t);
      const duration = Math.min(c.duration, projectFrames - t);
      items.push({ ...c, duration, transform: box(i) });
      t += duration;
    }
    return { id: `ov${i}`, kind: "video", name: `PIP ${i + 1}`, items };
  });
  const tracks = [...overlays, { id: "main", kind: "video", role: "main", name: "Main", items: main }];
  tracks.forEach((track, index) => {
    let start = 0;
    for (const it of track.items as Array<{ id: string; start?: number; duration: number; in?: number }>) {
      const s = it.start ?? start;
      layers.push({ id: it.id, kind: "video", track: index, start: s, duration: it.duration, in: it.in ?? 0 });
      start = s + it.duration;
    }
  });
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({ format: "uncut/0", name: "Fast cuts", canvas: { width: 1920, height: 1080, fps: FPS }, textLooks: 1, media, tracks }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (Object.keys(results).length) writeFileSync("test-output/fast-cuts-bench.json", JSON.stringify(results, null, 2));
  if (root) rmSync(root, { recursive: true, force: true });
});

const engineStats = () =>
  page.evaluate(() => (globalThis as { __uncutPlay?: { stats: () => unknown } }).__uncutPlay?.stats?.() ?? "no D311 engine in this build");

async function playThrough(label: string) {
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=preview-frame]")?.dataset.frame === "0", { timeout: 10000 });
  await sleep(1500);
  await startGlitchProbe(
    page,
    layers.map((l) => l.id),
  );
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=preview-frame]")?.dataset.playing === "true", { timeout: 5000 });
  // UNCUT_BENCH_SHOT=1: a look at the stacked section while it plays (test-output/fast-cuts-<label>.png; it costs a frame or two).
  const shot =
    process.env.UNCUT_BENCH_SHOT === "1"
      ? sleep((projectFrames / FPS - 3) * 1000).then(() => page.screenshot({ path: `test-output/fast-cuts-${label}.png` }))
      : undefined;
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=preview-frame]")?.dataset.playing === "false", {
    timeout: (projectFrames / FPS) * 1000 * 3 + 10000,
    polling: 100,
  });
  await shot;
  await sleep(200);
  const run = await stopGlitchProbe(page);
  if (process.env.UNCUT_BENCH_SAMPLES === "1") writeFileSync(`test-output/fast-cuts-${label}-samples.json`, JSON.stringify({ layers, samples: run.samples }));
  const overall = benchPlayback(run.samples, layers, { fps: FPS });
  const mainOnly = benchPlayback(
    run.samples,
    layers.filter((l) => l.track === OVERLAYS),
    { fps: FPS },
  );
  const stacked = benchPlayback(
    run.samples,
    layers.filter((l) => l.track < OVERLAYS),
    { fps: FPS },
  );
  results[`${label} all`] = overall;
  results[`${label} main`] = mainOnly;
  results[`${label} pip`] = stacked;
  console.log(`# fastcuts ${label} all: ${formatBench(overall)}`);
  console.log(`# fastcuts ${label} main track: ${formatBench(mainOnly)}`);
  console.log(`# fastcuts ${label} picture-in-picture: ${formatBench(stacked)}`);
  console.log(`# fastcuts ${label} engine: ${JSON.stringify(await engineStats())}; preview stats ${JSON.stringify(run.stats)}`);
  return overall;
}

async function openProject(gpu: boolean) {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, `data-${gpu ? "gpu" : "dom"}`), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await viewerPrefs(page, { gpu });
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click("[data-testid=bottom-timeline]");
  await sleep(1500);
}

for (const gpu of [true, false]) {
  const label = gpu ? "gpu" : "dom";
  test(`D311: ${MAIN_CUTS} fast cuts and a stacked section play without falling behind (${label})`, { skip, timeout: 300000 }, async () => {
    await openProject(gpu);
    try {
      const r = await playThrough(label);
      assert.ok(r.samples > 0, "the run was sampled");
      check(NO_REAL_GPU, r.latePct < 5, `${label}: ${r.latePct.toFixed(1)}% of samples off their frame`);
      check(NO_REAL_GPU, r.frozenMs < 500, `${label}: ${r.frozenMs.toFixed(0)} ms of frozen pictures`);
      check(NO_REAL_GPU, r.cutP90Ms < 100, `${label}: 90% of cuts showed their frame within ${r.cutP90Ms.toFixed(0)} ms`);
      check(NO_REAL_GPU, r.clockSlipMs < 300, `${label}: the playhead fell ${r.clockSlipMs.toFixed(0)} ms behind the wall clock`);
      assert.deepEqual(app!.errors, []);
    } finally {
      await app?.close();
      app = undefined;
    }
  });
}
