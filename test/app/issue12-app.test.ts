// Issue #12 (D265): the GPU compositor draws plain video and image layers as the DOM path and the
// export do, on the packaged app (run invisibly and muted). Paused frames of five layouts, each
// drawn by the DOM path, by the GPU compositor, and exported (Standard):
// - image: 6 stills (testsrc2 frame, PNG) in boxes at fractional canvas positions, fits cover,
//   contain and fill, radius 0 and 18;
// - still video: the same boxes with a 1280×720 H.264 clip of one frame;
// - grid: D221's 12 moving 1280×720 overlays (radius 18, opacity 0.92) over a moving main clip;
// - 1080p grid: the same with 1920×1080 clips;
// - SD grid: the same with 640×360 clips (untagged, so BT.601).
// Asserted: DOM vs GPU luma SSIM ≥ 0.99 for each (testsrc2's pixel-sharp edges are the worst case),
// and against the export the GPU compositor is at least as close as the DOM path (luma SSIM at
// 480×270 and mean colour Δ at 48×27, as D136's preview-vs-export test). The SD grid checks colour:
// Chromium shows untagged SD with SMPTE 170M primaries converted to BT.709's (the export does the same,
// server untaggedFilter), which a WebGL upload of the <video> doesn't, so the compositor converts.
// Printed as "# issue12 ...".
// Screenshots: test-output/issue12-<layout>-{dom,gpu,export}.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { ssim } from "../helpers/image-compare.ts";
import { shaderEntry, type ShaderDef } from "../../packages/core/src/index.ts";
import { NO_REAL_GPU, check } from "../helpers/capabilities.ts";

/** A shader effect (D213): a horizontal smear over 8 texels, mixed in at `amount`. */
const SMEAR: ShaderDef = {
  id: "test.smear",
  name: "Smear",
  params: [{ key: "amount", label: "Amount", type: "number", min: 0, max: 1, default: 0.7 }],
  wgsl: `struct Params {
  amount: f32,
}

fn effect(uv: vec2f, t: f32, size: vec2f, p: Params) -> vec4f {
  var sum = vec3f(0.0);
  for (var i = 0; i < 8; i++) {
    sum += frame(uv + vec2f(f32(i) / size.x, 0.0)).rgb;
  }
  return vec4f(mix(frame(uv).rgb, sum / 8.0, p.amount), 1.0);
}`,
};

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 30;
const SEG = 30;
const LAYOUTS = [
  "image",
  "still-video",
  "grid",
  "grid-1080p",
  "grid-sd",
  "reveal",
  "blur-dissolve",
  "blur-effect",
  "shader",
  "text-between",
  "interleaved",
] as const;
/** Each layout's frame and how many layers the GPU compositor draws there. */
const AT: Record<(typeof LAYOUTS)[number], { frame: number; layers: number }> = {
  image: { frame: 15, layers: 7 },
  "still-video": { frame: 45, layers: 7 },
  grid: { frame: 75, layers: 13 },
  "grid-1080p": { frame: 105, layers: 13 },
  "grid-sd": { frame: 135, layers: 13 },
  // Main: c5 150–190, a diamond reveal into c6 at 190 (180–200), a blur dissolve into c7 at 230, c8 with a blur effect from 270.
  reveal: { frame: 191, layers: 2 },
  "blur-dissolve": { frame: 229, layers: 2 },
  "blur-effect": { frame: 285, layers: 1 },
  shader: { frame: 315, layers: 1 },
  // A video, a text over it, a video over the text (the text drawn by the DOM between two GPU runs).
  "text-between": { frame: 345, layers: 3 },
  // D221's 12 overlays with a text track between each two (12 GPU runs), 2 s, also played.
  interleaved: { frame: 375, layers: 13 },
};
let root = "";
let dir = "";
let saveAs = "";
let app: LaunchedApp | undefined;
let page: Page;
const out = (name: string) => resolve("test-output", `issue12-${name}.png`);
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Boxes at fractional canvas positions, each fit, square and rounded corners. */
const odd = Array.from({ length: 6 }, (_, i) => ({
  x: 16.3 + (i % 3) * 630.37,
  y: 40.6 + Math.floor(i / 3) * 520.25,
  w: 600.45 - i * 3.3,
  h: 451.7 + i * 2.1,
  fit: ["cover", "contain", "fill"][i % 3]!,
  radius: i < 3 ? 0 : 18,
}));
const grid = Array.from({ length: 12 }, (_, i) => ({
  x: 16 + (i % 4) * 476,
  y: 16 + Math.floor(i / 4) * 356,
  w: 460,
  h: 340,
  fit: "cover",
  radius: 18,
  opacity: 0.92,
}));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue12-")));
  dir = join(root, "Parity.uncut");
  saveAs = join(root, "out", "Parity.mp4");
  mkdirSync(join(dir, "media"), { recursive: true });
  mkdirSync(join(root, "out"));
  const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  const clip = (size: string, file: string, vf?: string) =>
    ff(
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${size}:rate=${FPS}`,
      ...(vf ? ["-vf", vf] : []),
      "-t",
      "4",
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
      join(root, file),
    );
  ff("-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=${FPS}`, "-frames:v", "1", join(root, "Frame.png"));
  clip("1280x720", "Still.mp4", "trim=end_frame=1,loop=200:1:0,setpts=N/30/TB");
  clip("1280x720", "Layer.mp4");
  clip("1920x1080", "Big.mp4");
  clip("640x360", "Small.mp4");
  const video = (id: string, file: string, width: number, height: number) => ({
    id,
    kind: "video",
    name: file,
    path: join(root, file),
    probe: { frames: 4 * FPS, fps: FPS, width, height, hasAudio: false },
  });
  const media = [
    { id: "m-img", kind: "image", name: "Frame.png", path: join(root, "Frame.png"), probe: { width: 1280, height: 720 } },
    video("m-still", "Still.mp4", 1280, 720),
    video("m-layer", "Layer.mp4", 1280, 720),
    video("m-big", "Big.mp4", 1920, 1080),
    video("m-small", "Small.mp4", 640, 360),
  ];
  const at = (k: number) => k * SEG;
  const overlays = Array.from({ length: 12 }, (_, i) => ({
    id: `t${i}`,
    kind: "video",
    name: `Layer ${i + 1}`,
    items: [
      ...(i < 6
        ? [
            { id: `i${i}`, type: "clip", media: "m-img", start: at(0), duration: SEG, transform: odd[i] },
            { id: `s${i}`, type: "clip", media: "m-still", start: at(1), in: 0, duration: SEG, transform: odd[i] },
          ]
        : []),
      ...["m-layer", "m-big", "m-small"].map((m, k) => ({
        id: `g${k}-${i}`,
        type: "clip",
        media: m,
        start: at(2 + k),
        in: (i * 7) % 60,
        duration: SEG,
        transform: grid[i],
      })),
    ],
  }));
  const main = [
    ...["m-img", "m-still", "m-layer", "m-big", "m-small"].map((m, k) => ({
      id: `c${k}`,
      type: "clip",
      media: m,
      ...(m === "m-img" ? {} : { in: 0 }),
      duration: SEG,
    })),
    { id: "c5", type: "clip", media: "m-layer", in: 0, duration: 40 },
    { id: "c6", type: "clip", media: "m-big", in: 30, duration: 40, transitionIn: { module: "transition.diamond", duration: 20 } },
    { id: "c7", type: "clip", media: "m-layer", in: 30, duration: 40, transitionIn: { module: "transition.blur", duration: 20 } },
    // A blur effect on a picture placed smaller than its file (its CSS blur is in the <video>'s own px, D265).
    {
      id: "c8",
      type: "clip",
      media: "m-big",
      in: 30,
      duration: 30,
      effects: [{ module: "effect.blur", params: { amount: 6 } }],
      transform: { x: 160, y: 90, w: 1280, h: 720, fit: "cover", radius: 24 },
    },
    // A shader, then a look after it, in a smaller box.
    {
      id: "c9",
      type: "clip",
      media: "m-layer",
      in: 30,
      duration: 30,
      effects: [shaderEntry(SMEAR, { amount: 0.7 }), { module: "effect.look", params: { look: "warm", intensity: 1 } }],
      transform: { x: 200, y: 120, w: 1200, h: 675, fit: "cover", radius: 12 },
    },
    { id: "c10", type: "clip", media: "m-layer", in: 0, duration: 30 },
    { id: "c11", type: "clip", media: "m-layer", in: 0, duration: 60 },
  ];
  // Top first: overlay 11, its text, overlay 10, its text, ... overlay 0, its text.
  const interleaved = grid
    .flatMap((transform, i) => [
      {
        id: `iv${i}`,
        kind: "video",
        name: `IV${i}`,
        items: [{ id: `ic${i}`, type: "clip", media: "m-layer", start: 360, in: (i * 5) % 50, duration: 60, transform }],
      },
      {
        id: `it${i}`,
        kind: "text",
        name: `IT${i}`,
        items: [
          {
            id: `ix${i}`,
            type: "text",
            start: 360,
            duration: 60,
            text: `Layer ${i + 1}`,
            transform: { x: transform.x + 40, y: transform.y + 260 },
            style: { preset: "text.title", size: 64, weight: 800 },
          },
        ],
      },
    ])
    .reverse();
  const between = [
    {
      id: "top",
      kind: "video",
      name: "Top",
      items: [
        { id: "vb", type: "clip", media: "m-layer", start: 330, in: 40, duration: 30, transform: { x: 900, y: 500, w: 700, h: 394, fit: "cover", radius: 16 } },
      ],
    },
    {
      id: "words",
      kind: "text",
      name: "Words",
      items: [
        {
          id: "x1",
          type: "text",
          start: 330,
          duration: 30,
          text: "Between the layers",
          transform: { x: 420, y: 520 },
          style: { preset: "text.title", size: 110, weight: 800 },
        },
      ],
    },
    {
      id: "under",
      kind: "video",
      name: "Under",
      items: [
        { id: "va", type: "clip", media: "m-big", start: 330, in: 20, duration: 30, transform: { x: 300, y: 260, w: 800, h: 450, fit: "cover", radius: 16 } },
      ],
    },
  ];
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Parity",
      canvas: { width: 1920, height: 1080, fps: FPS },
      textLooks: 1,
      media,
      tracks: [...interleaved, ...between, ...overlays.reverse(), { id: "main", kind: "video", role: "main", name: "Main", items: main }],
    }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const meta = async (key: Parameters<Page["keyboard"]["press"]>[0]) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key);
  await page.keyboard.up("Meta");
};

async function clickAt(f: number) {
  const ruler = (await (await page.$("[data-testid=ruler]"))!.boundingBox())!;
  const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
  const scroll = await page.$eval(".bottom-body", (el) => el.scrollLeft);
  await page.mouse.click(ruler.x + 0.5 + f * ppf - scroll, ruler.y + ruler.height / 2);
}

async function setGpu(on: boolean) {
  await meta("Comma");
  await waitFor("[data-testid=settings]");
  await page.click("[data-testid=settings-nav-app]");
  if ((await page.$eval("[data-testid=settings-gpu-compositor]", (el) => (el as HTMLInputElement).checked)) !== on)
    await page.click("[data-testid=settings-gpu-compositor]");
  await page.click("[data-testid=settings-close]");
}

/** The paused preview at frame f once every shown <video> is at its frame and no scrub canvas covers one. */
async function settle(f: number) {
  await clickAt(f);
  await page.waitForFunction(
    (frame) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === frame,
    { timeout: 10000 },
    f,
  );
  await page.waitForFunction(
    () => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => v.style.opacity === "0" || (!v.seeking && v.readyState >= 2)),
    { timeout: 15000 },
  );
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLCanvasElement>("canvas.pv-scrub")].every((c) => c.style.visibility === "hidden"), {
    timeout: 15000,
  });
  await sleep(600);
}

async function shot(name: string) {
  await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path: out(name) });
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", out(name)], { encoding: "utf8" })
    .trim()
    .split(",")
    .map(Number);
  return { file: out(name), w: w!, h: h! };
}

/** D136's preview-vs-export measure: luma SSIM at 480×270 and the mean colour Δ per channel (0–255) at 48×27. */
function compare(a: string, b: string) {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const value = Number(/All:([\d.]+)/.exec(r.stderr)![1]);
  const rgb = (file: string) =>
    execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", "scale=48:27:flags=area,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"]);
  const pa = rgb(a);
  const pb = rgb(b);
  let d = 0;
  for (let i = 0; i < pa.length; i++) d += Math.abs(pa[i]! - pb[i]!);
  return { ssim: value, colour: d / pa.length };
}

test("issue #12: the GPU compositor draws video and image layers as the DOM path and the export do", { skip, timeout: 900000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  await page.click("[data-testid=bottom-timeline]");

  const shots: Record<string, { dom: string; gpu: string; ssim: number }> = {};
  for (const layout of LAYOUTS) {
    const f = AT[layout].frame;
    await setGpu(false);
    await settle(f);
    const a = await shot(`${layout}-dom`);
    await setGpu(true);
    await settle(f);
    const layers = await page.$eval("[data-testid=preview-frame]", (el) => Number((el as HTMLElement).dataset.gpuLayers ?? 0));
    assert.equal(layers, AT[layout].layers, `${layout}: every layer on the GPU`);
    const b = await shot(`${layout}-gpu`);
    shots[layout] = { dom: a.file, gpu: b.file, ssim: ssim(a.file, b.file, a.w, a.h) };
    console.log(`# issue12 ${layout}: DOM vs GPU SSIM ${shots[layout]!.ssim.toFixed(4)}`);
  }
  // Playback with the GPU on through the interleaved layout: every overlay on the GPU, in 12 runs, at the display's rate.
  await setGpu(true);
  await clickAt(AT.interleaved.frame - 14);
  await page.waitForFunction(
    () => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => v.style.opacity === "0" || (!v.seeking && v.readyState >= 2)),
    { timeout: 15000 },
  );
  await sleep(500);
  await page.keyboard.press("Space");
  const played = await page.evaluate(
    () =>
      new Promise<{ raf: Array<number>; layers: number; runs: number }>((done) => {
        const raf: Array<number> = [];
        let last = 0;
        const end = performance.now() + 1500;
        const tick = (t: number) => {
          if (last) raf.push(t - last);
          last = t;
          if (performance.now() < end) return void requestAnimationFrame(tick);
          done({
            raf,
            layers: Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.gpuLayers ?? 0),
            runs: [...document.querySelectorAll<HTMLCanvasElement>("canvas[data-gpu-compositor]")].filter((c) => c.style.visibility !== "hidden").length,
          });
        };
        requestAnimationFrame(tick);
      }),
  );
  await page.keyboard.press("Space");
  const raf = [...played.raf].sort((a, b) => a - b);
  const median = raf[Math.floor(raf.length / 2)]!;
  console.log(
    `# issue12 interleaved playback: ${played.layers} layers on the GPU in ${played.runs} runs; rAF median ${median.toFixed(1)} ms, p90 ${raf[Math.floor(raf.length * 0.9)]!.toFixed(1)} ms, ${raf.filter((x) => x > 25).length} frames > 25 ms`,
  );
  assert.equal(played.layers, 13);
  assert.equal(played.runs, 12, "a run under each text (the main clip and overlay 0 share the first)");
  check(NO_REAL_GPU, median < 12, `animation frames every ${median} ms`);
  await setGpu(false);

  // Export (Standard, loudness off).
  await meta("e");
  await waitFor("[data-testid=export-form]");
  await page.click("[data-testid=quality-standard]");
  await page.click("[data-testid=loudness-off]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Parity.mp4");
  await page.click("[data-testid=export-start]");
  await waitFor("[data-testid=export-job]");
  let phase = "";
  for (let i = 0; i < 6000 && phase !== "done" && phase !== "failed"; i++) {
    phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
    await sleep(100);
  }
  assert.equal(phase, "done", await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? ""));

  const low: Array<string> = [];
  for (const layout of LAYOUTS) {
    const file = out(`${layout}-export`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${AT[layout].frame})`, "-frames:v", "1", "-update", "1", file]);
    const s = shots[layout]!;
    const dom = compare(s.dom, file);
    const gpu = compare(s.gpu, file);
    console.log(
      `# issue12 ${layout} vs export: DOM SSIM ${dom.ssim.toFixed(4)} Δ${dom.colour.toFixed(2)}, GPU SSIM ${gpu.ssim.toFixed(4)} Δ${gpu.colour.toFixed(2)}`,
    );
    // Interleaved with texts, the DOM path's own videos move off the export's place (measured: DOM vs
    // export 0.978 where the plain grid gives 0.987; GPU vs export 0.984): there the gate is the export.
    if (layout === "interleaved" ? !(s.ssim >= 0.96 && gpu.ssim >= dom.ssim) : !(s.ssim >= 0.99)) low.push(`${layout}: DOM vs GPU SSIM ${s.ssim}`);
    if (!(gpu.ssim >= dom.ssim - 0.003)) low.push(`${layout}: GPU vs export SSIM ${gpu.ssim} below the DOM path's ${dom.ssim}`);
    if (!(gpu.colour <= dom.colour + 0.5)) low.push(`${layout}: GPU vs export colour Δ ${gpu.colour} above the DOM path's ${dom.colour}`);
  }
  check(NO_REAL_GPU, low.length === 0, `GPU compositor vs DOM vs export: ${low.join("; ")}`);
  assert.deepEqual(app.errors, []);
});
