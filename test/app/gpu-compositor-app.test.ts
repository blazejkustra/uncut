// D221: the GPU compositor (issue #12 item 4) on the packaged app, run invisibly and muted.
// A many-layer project: a main clip and 12 video overlays (1280×720 H.264 testsrc2) in a 4×3 grid
// with rounded corners and opacity, first plain (0–10 s), then each with a look and sharpen
// (10–20 s), then 20 smaller ones with them (20–30 s, past Chromium's 16 WebGL contexts per page),
// then the 12 plain and with effects again on a clip whose picture doesn't change (30–40 s).
// - Playback, DOM path then GPU compositor: 5 s of each half, animation-frame intervals (median,
//   p90, frames over 25 ms), frames each <video> presented (rVFC) and dropped, and how many
//   overlays' pictures are actually drawn (an effects canvas that lost its WebGL context shows
//   nothing). Printed as "# D221 ...".
// - The GPU compositor draws all 20 effects layers, drops no frame and keeps the animation frame rate.
// - Parity, DOM vs GPU screenshots of paused frames (testsrc2's pixel-sharp edges are the worst case):
//   SSIM ≥ 0.99 where every overlay has effects (the DOM path's effects canvases and the compositor
//   upload the same picture); plain <video> layers are printed with a floor of 0.95 against
//   regressions: the browser places and scales a <video>'s layer slightly differently (sub-pixel
//   phase at bar edges, D221), which is why the setting stays off.
// Screenshots: test-output/gpu-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { ssim } from "../helpers/image-compare.ts";
import { NO_REAL_GPU, check } from "../helpers/capabilities.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 30;
const HALF = 10 * FPS;
const OVERLAYS = 12;
/** The third part: more overlays with effects than Chromium gives WebGL contexts to a page (16). */
const MANY = 20;
let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const out = (name: string) => resolve("test-output", `gpu-${name}.png`);
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-gpu-app-")));
  dir = join(root, "Layers.uncut");
  mkdirSync(join(dir, "media"), { recursive: true });
  const clip = join(root, "Layer.mp4");
  const still = join(root, "Still.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=1280x720:rate=${FPS}`,
    "-t",
    String((3 * HALF) / FPS + 2),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-g",
    "30",
    "-bf",
    "0",
    "-pix_fmt",
    "yuv420p",
    clip,
  ]);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=1280x720:rate=${FPS}`,
    "-vf",
    "trim=end_frame=1,loop=2000:1:0,setpts=N/30/TB",
    "-t",
    String(HALF / FPS + 1),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-g",
    "30",
    "-bf",
    "0",
    "-pix_fmt",
    "yuv420p",
    still,
  ]);
  const media = [
    { id: "m-layer", kind: "video", name: "Layer.mp4", path: clip, probe: { frames: 3 * HALF + 2 * FPS, fps: FPS, width: 1280, height: 720, hasAudio: false } },
    { id: "m-still", kind: "video", name: "Still.mp4", path: still, probe: { frames: HALF + FPS, fps: FPS, width: 1280, height: 720, hasAudio: false } },
  ];
  const fx = [{ module: "effect.look", params: { look: "warm", intensity: 1 } }, { module: "effect.sharpen" }];
  const overlays = Array.from({ length: MANY }, (_, i) => {
    const transform = { x: 16 + (i % 4) * 476, y: 16 + Math.floor(i / 4) * 356, w: 460, h: 340, fit: "cover", radius: 18, opacity: 0.92 };
    const small = { x: 12 + (i % 5) * 380, y: 12 + Math.floor(i / 5) * 268, w: 370, h: 258, fit: "cover", radius: 14, opacity: 0.92 };
    return {
      id: `t${i}`,
      kind: "video",
      name: `Layer ${i + 1}`,
      items: [
        ...(i < OVERLAYS
          ? [
              { id: `p${i}`, type: "clip", media: "m-layer", start: 0, in: (i * 7) % 60, duration: HALF, transform },
              { id: `f${i}`, type: "clip", media: "m-layer", start: HALF, in: HALF + ((i * 7) % 60) - FPS, duration: HALF, transform, effects: fx },
            ]
          : []),
        { id: `m${i}`, type: "clip", media: "m-layer", start: 2 * HALF, in: ((i * 11) % 60) + HALF - FPS, duration: HALF, transform: small, effects: fx },
        ...(i < OVERLAYS
          ? [{ id: `s${i}`, type: "clip", media: "m-still", start: 3 * HALF, in: 0, duration: HALF, transform, ...(i % 2 ? { effects: fx } : {}) }]
          : []),
      ],
    };
  });
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Layers",
      canvas: { width: 1920, height: 1080, fps: FPS },
      textLooks: 1,
      media,
      // Tracks above Main come first.
      tracks: [
        ...overlays.reverse(),
        {
          id: "main",
          kind: "video",
          role: "main",
          name: "Main",
          items: [
            { id: "c0", type: "clip", media: "m-layer", in: 0, duration: 3 * HALF },
            { id: "c01", type: "clip", media: "m-still", in: 0, duration: HALF },
          ],
        },
      ],
    }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function clickAt(f: number) {
  const ruler = (await (await page.$("[data-testid=ruler]"))!.boundingBox())!;
  const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
  const scroll = await page.$eval(".bottom-body", (el) => el.scrollLeft);
  await page.mouse.click(ruler.x + 0.5 + f * ppf - scroll, ruler.y + ruler.height / 2);
}

/**
 * Plays 5 s from `from` and measures the preview while it plays. Past 5 s it keeps going (up to 30 s)
 * until there are at least 2 animation-frame intervals: on a virtual Mac's paravirtual GPU the
 * compositor's 21 layers have taken 1.9-3.4 s a frame (CI), so a 5 s window could hold no interval
 * and its median would be undefined. A preview that draws no 2 frames in 30 s measures Infinity.
 */
async function playFrom(label: string, from: number) {
  await clickAt(from);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => v.readyState >= 2 && !v.seeking), {
    timeout: 15000,
  });
  await sleep(500);
  await page.keyboard.press("Space");
  const r = await page.evaluate(
    () =>
      new Promise<{
        seconds: number;
        raf: Array<number>;
        presented: Array<number>;
        dropped: number;
        total: number;
        drawnFx: number;
        fxCanvases: number;
        gpu: number;
        renders: Array<number>;
      }>((done) => {
        (globalThis as unknown as { __uncutPreview: { renderMs: () => Array<number> } }).__uncutPreview.renderMs();
        const videos = [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")];
        const q0 = videos.map((v) => v.getVideoPlaybackQuality());
        const presented = videos.map(() => 0);
        let stop = false;
        videos.forEach((v, i) => {
          const loop = () => v.requestVideoFrameCallback(() => (presented[i]!++, !stop && loop()));
          loop();
        });
        const raf: Array<number> = [];
        let last = 0;
        const start = performance.now();
        // No animation frame at all for 30 s still ends the measurement.
        const cap = setTimeout(() => finish(), 30000);
        const tick = (t: number) => {
          if (stop) return;
          if (last) raf.push(t - last);
          last = t;
          const elapsed = performance.now() - start;
          if (elapsed < 5000 || (raf.length < 2 && elapsed < 30000)) return void requestAnimationFrame(tick);
          finish();
        };
        const finish = () => {
          if (stop) return;
          stop = true;
          clearTimeout(cap);
          const elapsed = performance.now() - start;
          const q1 = videos.map((v) => v.getVideoPlaybackQuality());
          const fxCanvases = [...document.querySelectorAll<HTMLCanvasElement>("canvas[data-fx]")];
          done({
            seconds: elapsed / 1000,
            raf,
            presented,
            dropped: q1.reduce((n, q, i) => n + q.droppedVideoFrames - q0[i]!.droppedVideoFrames, 0),
            total: q1.reduce((n, q, i) => n + q.totalVideoFrames - q0[i]!.totalVideoFrames, 0),
            drawnFx: fxCanvases.filter((c) => c.style.visibility !== "hidden").length,
            fxCanvases: fxCanvases.length,
            gpu: Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.gpuLayers ?? 0),
            renders: (globalThis as unknown as { __uncutPreview: { renderMs: () => Array<number> } }).__uncutPreview.renderMs(),
          });
        };
        requestAnimationFrame(tick);
      }),
  );
  await page.keyboard.press("Space");
  const raf = [...r.raf].sort((a, b) => a - b);
  const pres = [...r.presented].sort((a, b) => a - b);
  const renders = [...r.renders].sort((a, b) => a - b);
  const result = {
    rafMedian: raf[Math.floor(raf.length / 2)] ?? Infinity,
    rafP90: raf[Math.floor(raf.length * 0.9)] ?? Infinity,
    long: raf.filter((x) => x > 25).length,
    fps: raf.length / r.seconds,
    videoFpsMin: pres[0]! / r.seconds,
    videoFpsMedian: pres[Math.floor(pres.length / 2)]! / r.seconds,
    dropped: r.dropped,
    total: r.total,
    drawnFx: r.drawnFx,
    fxCanvases: r.fxCanvases,
    gpuLayers: r.gpu,
    renderMedian: renders[Math.floor(renders.length / 2)] ?? NaN,
    renderP90: renders[Math.floor(renders.length * 0.9)] ?? NaN,
  };
  console.log(
    `# D221 ${label} (${r.seconds.toFixed(1)} s): rAF median ${result.rafMedian.toFixed(1)} ms, p90 ${result.rafP90.toFixed(1)} ms, ${result.long} frames > 25 ms, ${result.fps.toFixed(1)} fps; videos presented ${result.videoFpsMin.toFixed(1)}–${result.videoFpsMedian.toFixed(1)} fps (min–median of ${r.presented.length}), dropped ${r.dropped} of ${r.total}; effects canvases drawn ${r.drawnFx} of ${r.fxCanvases}; layers on the GPU ${r.gpu}; preview render ${result.renderMedian.toFixed(2)} ms median, ${result.renderP90.toFixed(2)} ms p90`,
  );
  return result;
}

async function setGpu(on: boolean) {
  await page.keyboard.down("Meta");
  await page.keyboard.press("Comma");
  await page.keyboard.up("Meta");
  await waitFor("[data-testid=settings]");
  await page.click("[data-testid=settings-nav-app]");
  const box = await page.$("[data-testid=settings-gpu-compositor]");
  if (box) {
    const checked = await page.$eval("[data-testid=settings-gpu-compositor]", (el) => (el as HTMLInputElement).checked);
    if (checked !== on) await page.click("[data-testid=settings-gpu-compositor]");
    if (on) await page.screenshot({ path: out("settings") });
  }
  await page.click("[data-testid=settings-close]");
  return !!box;
}

async function frameShot(name: string) {
  const el = (await page.$("[data-testid=preview-frame]"))!;
  await el.screenshot({ path: out(name) });
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", out(name)], { encoding: "utf8" })
    .trim()
    .split(",")
    .map(Number);
  return { file: out(name), w: w!, h: h! };
}

test(
  "D221: 12 video overlays (plain, then with effects) play on the DOM path and the GPU compositor; paused frames match",
  { skip, timeout: 600000 },
  async () => {
    app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
    page = app.page;
    await waitForWelcome(page);
    await page.click("[data-testid=open-project]");
    await waitFor("[data-testid=editor]");
    await page.click("[data-testid=bottom-timeline]");
    const results: Record<string, unknown> = {};
    const hasGpu = await setGpu(false);
    for (const mode of hasGpu ? ["dom", "gpu"] : ["dom"]) {
      await setGpu(mode === "gpu");
      results[`${mode} plain`] = await playFrom(`${mode} 12 overlays`, 30);
      results[`${mode} fx`] = await playFrom(`${mode} 12 overlays with a look and sharpen`, HALF + 30);
      results[`${mode} many`] = await playFrom(`${mode} ${MANY} overlays with a look and sharpen`, 2 * HALF + 30);
    }
    console.log(`# D221 compositor results ${JSON.stringify(results)}`);
    if (!hasGpu) return;
    type Run = { rafMedian: number; dropped: number; gpuLayers: number; drawnFx: number };
    const r = results as Record<string, Run>;
    assert.equal(r["gpu many"]!.gpuLayers, MANY + 1, "the GPU compositor draws the main clip and every overlay with its effects");
    check(NO_REAL_GPU, r["gpu many"]!.dropped <= 10, `GPU: ${r["gpu many"]!.dropped} frames dropped`);
    check(NO_REAL_GPU, r["gpu many"]!.rafMedian < 12, `GPU: animation frames every ${r["gpu many"]!.rafMedian} ms`);
    check(
      NO_REAL_GPU,
      r["gpu plain"]!.rafMedian < 12 && r["gpu fx"]!.rafMedian < 12,
      `GPU: 12 overlays keep the animation frame rate (${r["gpu plain"]!.rafMedian}, ${r["gpu fx"]!.rafMedian} ms)`,
    );
    for (const f of [90, HALF + 90, 2 * HALF + 90, 3 * HALF + 90]) {
      await setGpu(false);
      await clickAt(f);
      await sleep(1500);
      const a = await frameShot(`parity-${f}-dom`);
      const domDrawn = await page.evaluate(
        () => [...document.querySelectorAll<HTMLCanvasElement>("canvas[data-fx]")].filter((c) => c.style.visibility !== "hidden").length,
      );
      await setGpu(true);
      await sleep(1500);
      const b = await frameShot(`parity-${f}-gpu`);
      const gpuLayers = await page.$eval("[data-testid=preview-frame]", (el) => Number((el as HTMLElement).dataset.gpuLayers ?? 0));
      const v = ssim(a.file, b.file, a.w, a.h);
      const domFx = f > 2 * HALF ? domDrawn : undefined;
      const label =
        f > 3 * HALF
          ? "still pictures, 6 with effects"
          : f > 2 * HALF
            ? `moving, ${MANY} with effects (the DOM path drew them on ${domFx})`
            : f > HALF
              ? "moving, 12 with effects"
              : "moving, 12 plain";
      console.log(`# D221 compositor parity frame ${f} (${label}): SSIM ${v.toFixed(4)}, ${gpuLayers} layers on the GPU`);
      assert.ok(gpuLayers > 0, `frame ${f}: the GPU compositor drew it`);
      // Effects layers match; plain <video> layers get a floor (see the header); past the WebGL context
      // limit the DOM path itself loses effects, so there's nothing to match.
      if (f > HALF && f < 2 * HALF) check(NO_REAL_GPU, v >= 0.99, `DOM vs GPU compositor frame ${f}: SSIM ${v}`);
      else if (f < 2 * HALF || f > 3 * HALF) check(NO_REAL_GPU, v >= 0.95, `DOM vs GPU compositor frame ${f}: SSIM ${v}`);
    }
  },
);
