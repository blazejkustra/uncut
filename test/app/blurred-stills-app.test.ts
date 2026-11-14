// Stills with picture effects play as smoothly as stills without, on the packaged app: the pattern
// of a phone-photo slideshow on a landscape canvas, each 3024×4032 photo twice, blurred (40) and
// darkened (a colour effect) to cover the frame on the main track, and fitted over it on a track
// above, slowly zooming on keyframes. The first half of the timeline has the effects, the second
// the same stills without them; animation-frame gaps while playing are compared between the two,
// the music track under them must play through without a seek, and every still must have its
// picture from its first frame (each is a photo of its own, the first pass is the first time seen).
// UNCUT_BENCH_DOM=1 measures the DOM path instead of the GPU compositor; UNCUT_STILLS_FX=blur or
// colour keeps only that effect.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { viewerPrefs } from "../helpers/viewer-prefs.ts";
import { NO_REAL_GPU, check } from "../helpers/capabilities.ts";
import { until } from "../helpers/wait.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 60;
const STILLS = 6;
const STILL_FRAMES = 90;
const HALF = STILLS * STILL_FRAMES;
const GPU = process.env.UNCUT_BENCH_DOM !== "1";
/** UNCUT_STILLS_FX=blur or colour: only that effect on the first half's stills (both by default). */
const FX = process.env.UNCUT_STILLS_FX ?? "both";

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;

const ffmpeg = (args: ReadonlyArray<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

/** A detailed 3024×4032 JPEG (noise over a test pattern, so it decodes as heavily as a photo). */
function makeStill(i: number) {
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=3024x4032:rate=1,hue=h=${i * 50},noise=alls=40:allf=u`,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    join(root, `still${i}.jpg`),
  ]);
}

function project() {
  // A photo of its own per moment (the second half's are others), as a slideshow of photos is.
  const media = Array.from({ length: 2 * STILLS }, (_, i) => ({
    id: `m${i}`,
    kind: "image",
    name: `still${i}.jpg`,
    path: join(root, `still${i}.jpg`),
    probe: { width: 3024, height: 4032, hasAudio: false },
  }));
  media.push({ id: "m-music", kind: "audio", name: "Music.m4a", path: join(root, "Music.m4a"), probe: { frames: 2 * HALF + FPS, hasAudio: true } } as never);
  const effects = [
    ...(FX !== "colour" ? [{ module: "effect.blur", params: { amount: 40 } }] : []),
    ...(FX !== "blur" ? [{ module: "effect.color", params: { exposure: -0.6, saturation: -0.2 } }] : []),
  ];
  const main: Array<Record<string, unknown>> = [];
  const fg: Array<Record<string, unknown>> = [];
  for (const half of ["fx", "plain"] as const)
    for (let i = 0; i < STILLS; i++) {
      const start = (half === "fx" ? 0 : HALF) + i * STILL_FRAMES;
      main.push({
        id: `${half}-bg${i}`,
        type: "clip",
        media: `m${half === "fx" ? i : STILLS + i}`,
        in: 0,
        duration: STILL_FRAMES,
        transform: { fit: "cover" },
        ...(half === "fx" ? { effects } : {}),
      });
      fg.push({
        id: `${half}-fg${i}`,
        type: "clip",
        media: `m${half === "fx" ? i : STILLS + i}`,
        in: 0,
        start,
        duration: STILL_FRAMES,
        keys: [
          { frame: 0, scale: 1, ease: "linear" },
          { frame: STILL_FRAMES, scale: 1.04 },
        ],
      });
    }
  return {
    format: "uncut/0",
    name: "Blurred stills",
    canvas: { width: 1920, height: 1080, fps: FPS },
    textLooks: 1,
    media,
    tracks: [
      { id: "fg", kind: "video", name: "Foreground", items: fg },
      { id: "main", kind: "video", role: "main", name: "Main", items: main },
      { id: "music", kind: "audio", name: "Music", items: [{ id: "music-1", type: "audio", media: "m-music", start: 0, in: 0, duration: 2 * HALF }] },
    ],
  };
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-blurred-stills-")));
  dir = join(root, "Stills.uncut");
  mkdirSync(join(dir, "media"), { recursive: true });
  for (let i = 0; i < 2 * STILLS; i++) makeStill(i);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=220:sample_rate=48000:duration=${Math.ceil((2 * HALF) / FPS) + 2}`,
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    join(root, "Music.m4a"),
  ]);
  writeFileSync(join(dir, "project.json"), JSON.stringify(project()));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const frameEl = "[data-testid=preview-frame]";
/** Every still clip and its first frame. */
const clipStarts = (): Array<[string, number]> =>
  (["fx", "plain"] as const).flatMap((half) =>
    Array.from({ length: STILLS }, (_, i): Array<[string, number]> => {
      const start = (half === "fx" ? 0 : HALF) + i * STILL_FRAMES;
      return [
        [`${half}-bg${i}`, start],
        [`${half}-fg${i}`, start],
      ];
    }).flat(),
  );
const previewFrame = () => page.$eval(frameEl, (el) => Number((el as HTMLElement).dataset.frame));
const isPlaying = () => page.$eval(frameEl, (el) => (el as HTMLElement).dataset.playing === "true");

interface Half {
  frames: number;
  medianMs: number;
  p95Ms: number;
  over25: number;
  over50: number;
  worstMs: number;
  /** Timeline frames the playhead skipped (stepped more than one at a time). */
  skipped: number;
}

/** Plays the whole timeline from the start, sampling each animation frame's time and the preview's frame. */
async function playThrough() {
  await page.keyboard.press("Home");
  await until(async () => (await previewFrame()) === 0, "the playhead at 0");
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(
    (sel, clips: Array<[string, number]>, length: number) => {
      type Probe = {
        on: boolean;
        s: Array<[number, number, boolean]>;
        long: Array<[number, number]>;
        seeks: Array<[number, number, string, number, number]>;
        missing: Record<string, number>;
      };
      const g = globalThis as { __stillsProbe?: Probe; __stillsSeekHook?: boolean };
      const probe: Probe = { on: true, s: [], long: [], seeks: [], missing: {} };
      g.__stillsProbe = probe;
      const el = document.querySelector(sel) as HTMLElement;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (g.__stillsProbe?.on) g.__stillsProbe.long.push([Math.round(e.startTime), Math.round(e.duration)]);
      }).observe({ type: "longtask" });
      // Every seek of a media element while playing: when, the playhead's frame, which element, from and to.
      if (!g.__stillsSeekHook) {
        g.__stillsSeekHook = true;
        const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")!;
        Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
          get: d.get,
          set(this: HTMLMediaElement, v: number) {
            const p = g.__stillsProbe;
            if (p?.on && !this.paused) p.seeks.push([Math.round(performance.now()), Number(el.dataset.frame), this.tagName, d.get!.call(this) as number, v]);
            d.set!.call(this, v);
          },
        });
      }
      const tick = (t: number) => {
        if (!probe.on) return;
        const frame = Number(el.dataset.frame);
        probe.s.push([t, frame, el.dataset.playing === "true"]);
        // Each still the playhead is inside whose <img> has no picture yet (not there, or not loaded): it shows nothing.
        for (const [id, start] of clips)
          if (frame >= start && frame < start + length) {
            const img = document.querySelector(`img[data-item="${id}"]`) as HTMLImageElement | null;
            if (!img || !img.complete || !img.naturalWidth) probe.missing[id] = (probe.missing[id] ?? 0) + 1;
          }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    frameEl,
    clipStarts(),
    STILL_FRAMES,
  );
  await page.keyboard.press("Space");
  await until(isPlaying, "playback started");
  await until(async () => !(await isPlaying()), "playback reached the end", { timeout: ((2 * HALF) / FPS) * 1000 * 4 + 10000, interval: 250 });
  const {
    s: samples,
    long,
    seeks,
    missing,
  } = await page.evaluate(() => {
    const probe = (
      globalThis as {
        __stillsProbe?: {
          on: boolean;
          s: Array<[number, number, boolean]>;
          long: Array<[number, number]>;
          seeks: Array<[number, number, string, number, number]>;
          missing: Record<string, number>;
        };
      }
    ).__stillsProbe!;
    probe.on = false;
    return probe;
  });
  const half = (from: number, to: number): Half => {
    const gaps: Array<number> = [];
    let skipped = 0;
    for (let i = 1; i < samples.length; i++) {
      const [t, f, playing] = samples[i]!;
      const [t0, f0, playing0] = samples[i - 1]!;
      // Past the first half second of play (the start gate), inside this half and away from its edges.
      if (!playing || !playing0 || f0 < from + 30 || f > to - 2) continue;
      gaps.push(t - t0);
      if (f - f0 > 1) skipped += f - f0 - 1;
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    const q = (x: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(x * sorted.length))] ?? 0);
    return {
      frames: gaps.length,
      medianMs: q(0.5),
      p95Ms: q(0.95),
      over25: gaps.filter((g) => g > 25).length,
      over50: gaps.filter((g) => g > 50).length,
      worstMs: Math.round(Math.max(0, ...gaps)),
      skipped,
    };
  };
  return {
    fx: half(0, HALF),
    plain: half(HALF, 2 * HALF),
    /** Animation frames each still was on screen without a picture. */
    missing,
    longTasks: long.length,
    longestTaskMs: Math.max(0, ...long.map((l) => l[1])),
    soundSeeks: seeks.filter((x) => x[2] === "AUDIO").map(([t, f, , from, to]) => ({ t, frame: f, from: +from.toFixed(3), to: +to.toFixed(3) })),
    long,
  };
}

test("Stills with blur and colour effects play as smoothly as plain stills, and the music under them without a skip", { skip, timeout: 300000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await viewerPrefs(page, { gpu: GPU });
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click("[data-testid=bottom-timeline]");
  // The first pass decodes every still; the second has them decoded.
  const cold = await playThrough();
  console.log(`# stills cold: long tasks ${cold.longTasks} (longest ${cold.longestTaskMs} ms), sound seeks ${JSON.stringify(cold.soundSeeks)}`);
  console.log(`# stills cold long tasks: ${JSON.stringify(cold.long)}`);
  console.log(`# stills cold frames without a picture: ${JSON.stringify(cold.missing)}`);
  const r = await playThrough();
  console.log(`# stills warm: long tasks ${r.longTasks} (longest ${r.longestTaskMs} ms), sound seeks ${JSON.stringify(r.soundSeeks)}`);
  console.log(`# stills warm frames without a picture: ${JSON.stringify(r.missing)}`);
  console.log(`# stills ${GPU ? "gpu" : "dom"} with effects: ${JSON.stringify(r.fx)}`);
  console.log(`# stills ${GPU ? "gpu" : "dom"} plain:        ${JSON.stringify(r.plain)}`);
  writeFileSync(`test-output/blurred-stills-${GPU ? "gpu" : "dom"}.json`, JSON.stringify(r, null, 2));
  check(NO_REAL_GPU, r.fx.over25 <= Math.max(3, r.plain.over25 * 2), `with effects ${r.fx.over25} animation frames over 25 ms, plain ${r.plain.over25}`);
  check(NO_REAL_GPU, r.fx.skipped <= Math.max(5, r.plain.skipped * 2), `with effects the playhead skipped ${r.fx.skipped} frames, plain ${r.plain.skipped}`);
  // The music under them is never seeked while it plays: a still's first upload (100 ms and more)
  // took the music for drifted, seeked it back and on the next frame forward again.
  check(
    NO_REAL_GPU,
    cold.soundSeeks.length === 0 && r.soundSeeks.length === 0,
    `the music was seeked while playing: ${JSON.stringify([...cold.soundSeeks, ...r.soundSeeks])}`,
  );
  // Every still has its picture from its first frame, the first time it's played too: its <img> was
  // made at its cut, so each started with frames of nothing (black, or the photo missing, once the
  // GPU compositor stopped holding the last frame).
  check(
    NO_REAL_GPU,
    !Object.keys(cold.missing).length && !Object.keys(r.missing).length,
    `stills on screen without a picture (frames): ${JSON.stringify({ cold: cold.missing, warm: r.missing })}`,
  );
  // No still freezes the preview at its cut: uploading one from its <img> decoded the photo on the
  // main thread each time (~60 ms per upload, two per still with a blurred copy under it).
  const longest = Math.max(cold.longestTaskMs, r.longestTaskMs);
  check(NO_REAL_GPU, longest < 100, `a main-thread task of ${longest} ms while the stills played`);
  assert.deepEqual(app.errors, []);
});
