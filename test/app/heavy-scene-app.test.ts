// A heavy scene plays without stalling, on the packaged app (run invisibly and muted): about 75 s
// of 1 to 2 s main-track cuts from five sources (720p, 1080p60 long-GOP with B-frames, 1440p, 1080p
// HEVC and 4K HEVC, three with sound), a transition on every other cut, a few speed changes, three
// picture-in-picture tracks whose boxes move on keyframes, three tracks of texts with in, out and
// loop moves, two components and a music track.
// It plays through right after the project opens, while the proxies for the HEVC and 4K files are
// still being made (UNCUT_HEAVY_FULL=1: again once they're all there). Each run is sampled per animation frame
// (preview-glitches.ts) and scored by playback-bench.ts; the renderer's main-thread time
// (page.metrics) and the app's CPU and memory (ps over its processes) are logged with it. Then
// seeks onto cuts followed by play at once, with the proxies there: how long play waits for the
// pictures (the start gate) and whether they're on time once it runs.
// Every run prints "# heavy ..." and the numbers go to test-output/heavy-scene-bench.json. The
// bounds need a real GPU and media engine.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { viewerPrefs } from "../helpers/viewer-prefs.ts";
import { startGlitchProbe, stopGlitchProbe, type GlitchLayer, type GlitchSample } from "../helpers/preview-glitches.ts";
import { benchPlayback, formatBench, type BenchResult } from "../helpers/playback-bench.ts";
import { NO_REAL_GPU, check } from "../helpers/capabilities.ts";
import { settled, until } from "../helpers/wait.ts";
import { START_HOLD_MS } from "../../apps/web/src/preview/playback.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 30;
const SOURCE_S = 12;
const MAIN_CUTS = 48;
const PIP_TRACKS = 3;
const TEXT_TRACKS = 3;
const SEEKS = 8;
const TRANSITIONS = ["transition.crossfade", "transition.dip-to-black", "transition.wipe", "transition.push-left", "transition.zoom", "transition.iris"];
const SPEEDS = [0.5, 1.5, 2];

interface Source {
  readonly id: string;
  readonly file: string;
  readonly codec: "libx264" | "libx265";
  readonly size: string;
  readonly rate: number;
  readonly gop: number;
  readonly bframes: number;
  readonly sound?: number;
  readonly hdr?: boolean;
}

const SOURCES: ReadonlyArray<Source> = [
  { id: "m-a", file: "A.mp4", codec: "libx264", size: "1280x720", rate: 30, gop: 30, bframes: 0, sound: 440 },
  { id: "m-b", file: "B.mp4", codec: "libx264", size: "1920x1080", rate: 60, gop: 120, bframes: 3 },
  { id: "m-c", file: "C.mp4", codec: "libx265", size: "3840x2160", rate: 30, gop: 60, bframes: 2, sound: 660 },
  { id: "m-d", file: "D.mp4", codec: "libx264", size: "2560x1440", rate: 30, gop: 90, bframes: 2 },
  { id: "m-e", file: "E.mp4", codec: "libx265", size: "1920x1080", rate: 30, gop: 30, bframes: 2, sound: 550 },
  ...(process.env.UNCUT_HEAVY_HDR === "1"
    ? [{ id: "m-f", file: "F.mp4", codec: "libx265" as const, size: "1920x1080", rate: 30, gop: 30, bframes: 2, sound: 330, hdr: true }]
    : []),
];
/** UNCUT_HEAVY_ENGINE=off plays on the <video> path (as builds before D333 did); UNCUT_HEAVY_PROXIES=off plays the originals only. */
const ENGINE = process.env.UNCUT_HEAVY_ENGINE !== "off";
const PROXIES = process.env.UNCUT_HEAVY_PROXIES !== "off";

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
let projectFrames = 0;
const layers: Array<GlitchLayer> = [];
const cuts: Array<number> = [];
const results: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const ffmpeg = (args: ReadonlyArray<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", "-threads", "2", "-filter_threads", "2", ...args]);

function makeSource(s: Source) {
  const audio = s.sound ? ["-f", "lavfi", "-i", `sine=frequency=${s.sound}:sample_rate=48000`] : [];
  const codec =
    s.codec === "libx265"
      ? ["-tag:v", "hvc1", "-x265-params", `keyint=${s.gop}:min-keyint=${s.gop}:bframes=${s.bframes}:pools=2:frame-threads=1:log-level=error`]
      : ["-g", String(s.gop), "-bf", String(s.bframes)];
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${s.size}:rate=${s.rate}`,
    ...audio,
    "-t",
    String(SOURCE_S),
    "-c:v",
    s.codec,
    "-preset",
    "ultrafast",
    ...codec,
    ...(s.hdr ? ["-pix_fmt", "yuv420p10le", "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc"] : ["-pix_fmt", "yuv420p"]),
    ...(s.sound ? ["-c:a", "aac", "-b:a", "128k"] : []),
    join(root, s.file),
  ]);
}

function makeMusic(seconds: number) {
  ffmpeg(["-f", "lavfi", "-i", `sine=frequency=220:sample_rate=48000:duration=${seconds}`, "-c:a", "aac", "-b:a", "128k", join(root, "Music.m4a")]);
}

/** The heavy project, from a fixed seed; also fills `layers` (videos and texts, track 0 on top) and `cuts`. */
function heavyProject() {
  const random = rng(4242);
  const pick = <T>(list: ReadonlyArray<T>) => list[Math.floor(random() * list.length)]!;
  const clip = (id: string, duration: number, speed = 1) => {
    const source = pick(SOURCES);
    const room = SOURCE_S * FPS - 2 - Math.ceil(duration * speed) - 15;
    return { id, type: "clip", media: source.id, in: 15 + Math.floor(random() * room), duration, ...(speed !== 1 ? { speed } : {}) };
  };
  const main: Array<Record<string, unknown>> = [];
  let at = 0;
  for (let i = 0; i < MAIN_CUTS; i++) {
    const duration = 30 + Math.floor(random() * 31);
    const speed = i % 6 === 3 ? pick(SPEEDS) : 1;
    const item: Record<string, unknown> = clip(`main${i}`, duration, speed);
    if (i > 0 && i % 2 === 0) item.transitionIn = { module: TRANSITIONS[(i / 2) % TRANSITIONS.length], duration: 10 };
    main.push(item);
    if (i > 0) cuts.push(at);
    at += duration;
  }
  projectFrames = at;
  const pipBox = (i: number) => ({ x: 80 + i * 600, y: 620, w: 520, h: 292, fit: "cover" as const, radius: 16 });
  const pip = Array.from({ length: PIP_TRACKS }, (_, i) => {
    const items: Array<Record<string, unknown>> = [];
    let t = 15 * (i + 1);
    while (t < projectFrames - 60) {
      const duration = Math.min(60 + Math.floor(random() * 61), projectFrames - t);
      const box = pipBox(i);
      const keys = [
        { frame: 0, x: box.x, y: box.y, scale: 0.8, opacity: 0, ease: "out" },
        { frame: 12, x: box.x, y: box.y - 40, scale: 1, opacity: 1, ease: "spring" },
        { frame: duration - 1, x: box.x + 60, y: box.y - 80, scale: 1.1, opacity: 1 },
      ];
      items.push({ ...clip(`pip${i}-${items.length}`, duration), start: t, transform: box, keys });
      t += duration + 10 + Math.floor(random() * 30);
    }
    return { id: `pip${i}`, kind: "video", name: `PIP ${i + 1}`, items };
  });
  const moves = [
    { in: { module: "move.fade", duration: 12 }, out: { module: "move.fade", duration: 12 } },
    { in: { module: "move.typewriter", duration: 30 }, loop: { module: "move.pulse", duration: 30 } },
    { in: { module: "move.word-by-word", duration: 24, params: { style: "rise" } }, out: { module: "move.slide-left", duration: 12 } },
    { in: { module: "move.pop", duration: 12 }, loop: { module: "move.wiggle", duration: 20 }, out: { module: "move.blur", duration: 12 } },
  ];
  const texts = Array.from({ length: TEXT_TRACKS }, (_, k) => {
    const items: Array<Record<string, unknown>> = [];
    for (let t = 10 * k; t + 50 < projectFrames; t += 75) {
      items.push({
        id: `text${k}-${items.length}`,
        type: "text",
        start: t,
        duration: 60,
        text: `Heavy scene line ${k + 1}.${items.length + 1}`,
        transform: { x: 120, y: 80 + k * 140 },
        style: { preset: "text.title", size: 56, weight: 700 },
        animation: moves[(k + items.length) % moves.length],
      });
    }
    return { id: `tt${k}`, kind: "text", name: `Text ${k + 1}`, items };
  });
  const third = Math.floor(projectFrames / 3);
  const components = {
    id: "comps",
    kind: "video",
    name: "Components",
    items: [
      {
        id: "lower-third",
        type: "component",
        component: "component.lower-third",
        start: 30,
        duration: third,
        props: { name: "Heavy Scene", title: "Playback benchmark" },
        transform: { x: 96, y: 860, w: 900, h: 180 },
        animation: { in: { module: "move.slide-left", duration: 15 }, out: { module: "move.fade", duration: 15 } },
      },
      {
        id: "progress",
        type: "component",
        component: "component.progress-bar",
        start: third + 30,
        duration: projectFrames - third - 30,
        transform: { x: 0, y: 1060, w: 1920, h: 20 },
      },
    ],
  };
  const music = {
    id: "music",
    kind: "audio",
    name: "Music",
    items: [{ id: "music-1", type: "audio", media: "m-music", start: 0, in: 0, duration: projectFrames }],
  };
  const tracks = [...texts, components, ...pip, { id: "main", kind: "video", role: "main", name: "Main", items: main }, music];
  tracks.forEach((track, index) => {
    let start = 0;
    for (const it of track.items as Array<{ id: string; type: string; start?: number; duration: number; in?: number; speed?: number }>) {
      const s = it.start ?? start;
      start = s + it.duration;
      if (it.type === "clip" && track.kind === "video")
        layers.push({ id: it.id, kind: "video", track: index, start: s, duration: it.duration, in: it.in ?? 0, speed: it.speed ?? 1 });
      if (it.type === "text") layers.push({ id: it.id, kind: "text", track: index, start: s, duration: it.duration });
    }
  });
  const media = [
    ...SOURCES.map((s) => {
      const [w, h] = s.size.split("x").map(Number);
      return {
        id: s.id,
        kind: "video",
        name: s.file,
        path: join(root, s.file),
        probe: { frames: SOURCE_S * s.rate, fps: s.rate, width: w, height: h, hasAudio: !!s.sound },
      };
    }),
    { id: "m-music", kind: "audio", name: "Music.m4a", path: join(root, "Music.m4a"), probe: { frames: projectFrames + FPS, hasAudio: true } },
  ];
  return { format: "uncut/0", name: "Heavy scene", canvas: { width: 1920, height: 1080, fps: FPS }, textLooks: 1, media, tracks };
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-heavy-")));
  dir = join(root, "Heavy.uncut");
  mkdirSync(join(dir, "media"), { recursive: true });
  for (const s of SOURCES) makeSource(s);
  const project = heavyProject();
  makeMusic(Math.ceil(projectFrames / FPS) + 1);
  writeFileSync(join(dir, "project.json"), JSON.stringify(project));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (Object.keys(results).length) writeFileSync("test-output/heavy-scene-bench.json", JSON.stringify(results, null, 2));
  if (root && process.env.UNCUT_BENCH_KEEP !== "1") rmSync(root, { recursive: true, force: true });
  else if (root) console.log(`# heavy project kept at ${dir}`);
});

const frameEl = "[data-testid=preview-frame]";
const previewFrame = () => page.$eval(frameEl, (el) => Number((el as HTMLElement).dataset.frame));
const isPlaying = () => page.$eval(frameEl, (el) => (el as HTMLElement).dataset.playing === "true");
const engineStats = () => page.evaluate(() => (globalThis as { __uncutPlay?: { stats: () => unknown } }).__uncutPlay?.stats?.());
const queuedProxies = async () => {
  const phases = await proxyPhases();
  return phases.length ? phases : undefined;
};
const proxyPhases = () => page.$$eval("[data-testid=media-proxy]", (els) => els.map((el) => (el as HTMLElement).dataset.phase ?? ""));

interface Usage {
  cpuMedian: number;
  cpuMax: number;
  rssPeakMb: number;
  rendererRssPeakMb: number;
}

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly rss: number;
  readonly cpu: number;
  readonly command: string;
}

function processRows(): Array<ProcessRow> {
  return execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,pcpu=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), cpu: Number(m[4]), command: m[5]! }));
}

/** The process and all its descendants. */
function family(rows: ReadonlyArray<ProcessRow>, pid: number): Array<ProcessRow> {
  const ids = new Set([pid]);
  const queue = [pid];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const r of rows) {
      if (r.ppid !== parent || ids.has(r.pid)) continue;
      ids.add(r.pid);
      queue.push(r.pid);
    }
  }
  return rows.filter((r) => ids.has(r.pid));
}

/** The app's processes (its own and every descendant) sampled with ps every 500 ms until stopped: CPU % summed, RSS. */
function watchUsage(pid: number) {
  const cpu: Array<number> = [];
  let rssPeak = 0;
  let rendererPeak = 0;
  const sample = () => {
    const ours = family(processRows(), pid);
    cpu.push(ours.reduce((n, r) => n + r.cpu, 0));
    rssPeak = Math.max(
      rssPeak,
      ours.reduce((n, r) => n + r.rss, 0),
    );
    rendererPeak = Math.max(rendererPeak, ...ours.filter((r) => r.command.includes("--type=renderer")).map((r) => r.rss));
  };
  const timer = setInterval(sample, 500);
  return (): Usage => {
    clearInterval(timer);
    const sorted = [...cpu].sort((a, b) => a - b);
    return {
      cpuMedian: sorted[Math.floor(sorted.length / 2)] ?? 0,
      cpuMax: sorted.at(-1) ?? 0,
      rssPeakMb: rssPeak / 1024,
      rendererRssPeakMb: rendererPeak / 1024,
    };
  };
}

/** The renderer main thread's time (ms) spent in scripts, layout and style over a run (page.metrics deltas). */
async function mainThread<T>(run: () => Promise<T>) {
  const before = await page.metrics();
  const value = await run();
  const after = await page.metrics();
  const ms = (k: "TaskDuration" | "ScriptDuration" | "LayoutDuration" | "RecalcStyleDuration") => Math.round(((after[k] ?? 0) - (before[k] ?? 0)) * 1000);
  return { value, main: { task: ms("TaskDuration"), script: ms("ScriptDuration"), layout: ms("LayoutDuration"), style: ms("RecalcStyleDuration") } };
}

/** Animation-frame gaps while playing: the share over 25 and 50 ms, and the worst. */
function frameGaps(samples: ReadonlyArray<GlitchSample>) {
  const gaps: Array<number> = [];
  const playing = samples.filter((s) => s.playing);
  for (let i = 1; i < playing.length; i++) gaps.push(playing[i]!.t - playing[i - 1]!.t);
  return {
    frames: gaps.length,
    over25: gaps.filter((g) => g > 25).length,
    over50: gaps.filter((g) => g > 50).length,
    worstMs: Math.round(Math.max(0, ...gaps)),
  };
}

/**
 * Time (ms of wall clock) the playhead stood still once playback was under way (the start gate's wait
 * before its first move is play's start time, not a stall): per sample, the wall time minus the time
 * the playhead moved, summed where it fell more than a frame behind.
 */
function stalledMs(samples: ReadonlyArray<GlitchSample>) {
  const all = samples.filter((s) => s.playing);
  const playing = all.filter((s) => s.frame > all[0]!.frame);
  let stalled = 0;
  for (let i = 1; i < playing.length; i++) {
    const wall = playing[i]!.t - playing[i - 1]!.t;
    const moved = ((playing[i]!.frame - playing[i - 1]!.frame) / FPS) * 1000;
    if (wall - moved > 1000 / FPS) stalled += wall - moved;
  }
  return Math.round(stalled);
}

const videoLayers = () => layers.filter((l) => l.kind === "video");
const textIds = () => layers.filter((l) => l.kind === "text").map((l) => l.id);

async function playThrough(label: string) {
  await page.keyboard.press("Home");
  await until(async () => (await previewFrame()) === 0, "the playhead at 0");
  await sleep(1500);
  await startGlitchProbe(
    page,
    layers.map((l) => l.id),
  );
  const stopUsage = watchUsage(app!.proc.pid!);
  const { main } = await mainThread(async () => {
    await page.keyboard.press("Space");
    await until(isPlaying, "playback started");
    await until(async () => !(await isPlaying()), "playback reached the end", { timeout: (projectFrames / FPS) * 1000 * 3 + 10000, interval: 250 });
  });
  const usage = stopUsage();
  const run = await stopGlitchProbe(page);
  if (process.env.UNCUT_BENCH_SAMPLES === "1") writeFileSync(`test-output/heavy-scene-${label}-samples.json`, JSON.stringify({ layers, samples: run.samples }));
  const all = benchPlayback(run.samples, videoLayers(), { fps: FPS });
  const mainTrack = benchPlayback(
    run.samples,
    videoLayers().filter((l) => String(l.id).startsWith("main")),
    { fps: FPS },
  );
  const pip = benchPlayback(
    run.samples,
    videoLayers().filter((l) => String(l.id).startsWith("pip")),
    { fps: FPS },
  );
  const gaps = frameGaps(run.samples);
  const stalls = stalledMs(run.samples);
  const textMissing = textIds().filter((id) => run.samples.some((s) => s.playing && s.layers[id] && !s.layers[id]!.d)).length;
  const engine = await engineStats();
  results[label] = { all, mainTrack, pip, gaps, stalls, main, usage, engine, preview: run.stats };
  console.log(`# heavy ${label} all: ${formatBench(all)}`);
  console.log(`# heavy ${label} main track: ${formatBench(mainTrack)}`);
  console.log(`# heavy ${label} picture-in-picture: ${formatBench(pip)}`);
  console.log(
    `# heavy ${label} stalled ${stalls} ms; animation frames ${gaps.frames}, > 25 ms ${gaps.over25}, > 50 ms ${gaps.over50}, worst ${gaps.worstMs} ms; texts not drawn at some sample ${textMissing}`,
  );
  console.log(
    `# heavy ${label} renderer main thread ms: ${JSON.stringify(main)}; app CPU median ${usage.cpuMedian.toFixed(0)}% max ${usage.cpuMax.toFixed(0)}%, RSS peak ${usage.rssPeakMb.toFixed(0)} MB (renderer ${usage.rendererRssPeakMb.toFixed(0)} MB)`,
  );
  console.log(`# heavy ${label} engine: ${JSON.stringify(engine)}`);
  return { all, stalls, gaps };
}

/** Steps to the cut `k` edit points in (↓ from Home), back `back` frames, then plays at once for ~1.2 s. */
async function seekAndPlay(k: number, back: number) {
  await page.keyboard.press("Home");
  await until(async () => (await previewFrame()) === 0, "the playhead at 0");
  for (let i = 0; i < k; i++) await page.keyboard.press("ArrowDown");
  for (let i = 0; i < back; i++) await page.keyboard.press("ArrowLeft");
  const at = await settled(previewFrame, "the playhead on the cut");
  await startGlitchProbe(
    page,
    layers.map((l) => l.id),
  );
  const engineBefore = (await engineStats()) as { restarts?: number; lanes?: number } | undefined;
  const pressed = await page.evaluate(() => performance.now());
  await page.keyboard.press("Space");
  await until(async () => (await previewFrame()) >= at + 36, "1.2 s played", { timeout: 20000, interval: 30 });
  await page.keyboard.press("Space");
  const run = await stopGlitchProbe(page);
  const engineAfter = (await engineStats()) as { restarts?: number; lanes?: number } | undefined;
  const restarts = (engineAfter?.restarts ?? 0) - (engineBefore?.restarts ?? 0);
  const lanes = (engineAfter?.lanes ?? 0) - (engineBefore?.lanes ?? 0);
  if (process.env.UNCUT_BENCH_SAMPLES === "1") writeFileSync(`test-output/heavy-scene-seek-${at}.json`, JSON.stringify({ layers, samples: run.samples }));
  const playing = run.samples.filter((s) => s.playing);
  const moved = playing.find((s) => s.frame > at);
  const scored = benchPlayback(
    run.samples.filter((s) => s.frame > at),
    videoLayers(),
    { fps: FPS, settleMs: 0 },
  );
  return { at, startMs: moved ? moved.t - pressed : Infinity, cut: scored, restarts, lanes };
}

async function seeks(label: string) {
  if (process.env.UNCUT_HEAVY_SEEKS === "0") return { playStartMedianMs: 0, playStartMaxMs: 0, cutP90MedianMs: 0, cutP90MaxMs: 0, latePct: 0 };
  const starts: Array<number> = [];
  const cutLatencies: Array<number> = [];
  let late = 0;
  let samples = 0;
  for (let i = 0; i < SEEKS; i++) {
    const r = await seekAndPlay(4 + i * 5, 6);
    console.log(
      `# heavy ${label} seek ${i} at frame ${r.at}: moved after ${r.startMs.toFixed(0)} ms; lanes ${r.lanes}, restarts ${r.restarts}; ${formatBench(r.cut)}`,
    );
    starts.push(r.startMs);
    cutLatencies.push(r.cut.cutP90Ms);
    late += r.cut.late;
    samples += r.cut.samples;
  }
  const median = (xs: Array<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const out = {
    playStartMedianMs: Math.round(median(starts)),
    playStartMaxMs: Math.round(Math.max(...starts)),
    cutP90MedianMs: Math.round(median(cutLatencies)),
    cutP90MaxMs: Math.round(Math.max(...cutLatencies)),
    latePct: (100 * late) / Math.max(1, samples),
  };
  results[`${label} seeks`] = out;
  console.log(`# heavy ${label} seek-and-play x${SEEKS}: ${JSON.stringify(out)}`);
  return out;
}

async function openProject() {
  app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_PROXIES: PROXIES ? "on" : "off" },
  });
  page = app.page;
  await waitForWelcome(page);
  await viewerPrefs(page, { gpu: process.env.UNCUT_BENCH_DOM !== "1", playEngine: ENGINE });
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click("[data-testid=bottom-timeline]");
  await page.$eval("[data-testid=rail-media]", (el) => (el as HTMLElement).click());
  await until(async () => (await page.$$eval("[data-testid=media-tile]", (els) => els.length)) >= SOURCES.length, "the media tiles");
}

const assertBudget = (label: string, r: { all: BenchResult; stalls: number; gaps: { frames: number; over50: number } }) => {
  check(NO_REAL_GPU, r.stalls < 500, `${label}: the playhead stood still for ${r.stalls} ms`);
  check(NO_REAL_GPU, r.all.clockSlipMs < 400, `${label}: the playhead fell ${r.all.clockSlipMs.toFixed(0)} ms behind the wall clock`);
  check(NO_REAL_GPU, r.all.latePct < 5, `${label}: ${r.all.latePct.toFixed(1)}% of video samples off their frame`);
  check(NO_REAL_GPU, r.gaps.over50 < r.gaps.frames * 0.02, `${label}: ${r.gaps.over50} of ${r.gaps.frames} animation frames over 50 ms`);
  check(NO_REAL_GPU, r.all.frozenMs < 1000, `${label}: ${r.all.frozenMs.toFixed(0)} ms of frozen pictures`);
};

test(
  "A heavy scene (fast cuts, transitions, moving picture-in-picture, animated texts, components) plays without stalling, while proxies are made and once they're there",
  { skip, timeout: 900000 },
  async () => {
    await openProject();
    try {
      const making = PROXIES ? await until(queuedProxies, "proxies queued") : [];
      console.log(`# heavy proxies when playback started: ${JSON.stringify(making)}; engine ${ENGINE ? "on" : "off"}`);
      const first = await playThrough(PROXIES ? "proxies-making" : "originals");
      assertBudget(PROXIES ? "while proxies are made" : "originals", first);
      if (PROXIES) {
        await until(
          async () => {
            const phases = await proxyPhases();
            return phases.length > 0 && phases.every((p) => p === "done");
          },
          "every proxy made",
          { timeout: 600000, interval: 1000 },
        );
      }
      if (process.env.UNCUT_HEAVY_FULL === "1") assertBudget("with proxies", await playThrough("proxies-ready"));
      const seek = await seeks(PROXIES ? "proxies-ready" : "originals");
      check(NO_REAL_GPU, seek.playStartMaxMs < START_HOLD_MS + 150, `play after a seek moved the playhead after ${seek.playStartMaxMs} ms at worst`);
      check(NO_REAL_GPU, seek.latePct < 3, `play after a seek: ${seek.latePct.toFixed(1)}% of video samples off their frame`);
      check(NO_REAL_GPU, Number.isFinite(seek.cutP90MaxMs) && seek.cutP90MaxMs < 150, `play after a seek: a cut's p90 latency ${seek.cutP90MaxMs} ms`);
      assert.deepEqual(app!.errors, []);
    } finally {
      await app?.close();
      app = undefined;
    }
  },
);
