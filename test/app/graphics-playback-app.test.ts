// D311: the preview keeps up with a short-form project full of HTML graphics, on the packaged app
// (run invisibly and muted). The project is shaped like a real promo: 9:16 720x1280 at 30 fps, a
// watermark graphic back to back over everything, label and overlay graphics (some under a second,
// a run of four back to back), a split-screen video under a split overlay that draws footage with
// uncut.frame, and a main track of 480x854 and 720x1280 H.264 clips interleaved with 2.8 s
// full-frame graphics (a 2D canvas, a ui.js stage, three.js, footage) and a section of very short cuts.
// It plays with the playback engine (the default), with "Decode frames ahead for playback" off,
// and with the engine while the ruler is clicked every 3 s, all on the GPU compositor. Each run is
// sampled once per animation frame (test/helpers/preview-glitches.ts: a graphic counts as drawn
// once its iframe has drawn a render(t)) and scored by test/helpers/playback-bench.ts; every graphic
// also draws a marker of its own colour, and the screen recorded over the run says whether it was
// really on screen (test/helpers/screen-markers.ts). Every run prints "# graphics ..." and the
// numbers go to test-output/graphics-bench.json. UNCUT_BENCH_CPU=<rate> slows the renderers down
// (CDP) and UNCUT_BENCH_TRACE=1 records a performance trace. The bounds need a real GPU and media engine.
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
import { markerHtml, scoreMarkers, startScreenRecord, stopScreenRecord, type MarkerSlot } from "../helpers/screen-markers.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 30;
const SOURCE_S = 20;
const s = (seconds: number) => Math.round(seconds * FPS);

const SOURCES = [
  { id: "m-a", file: "landing.mp4", size: "480x854", rate: 24, pattern: "testsrc2", sound: true },
  { id: "m-b", file: "dancer.mp4", size: "480x854", rate: 24, pattern: "smptehdbars", sound: false },
  { id: "m-c", file: "champions.mp4", size: "720x1280", rate: 30, pattern: "testsrc", sound: true },
  { id: "m-d", file: "slap.mp4", size: "720x1280", rate: 30, pattern: "rgbtestsrc", sound: false },
] as const;

const WATERMARK = `<style>
#w { position: absolute; left: 0; right: 0; top: 140px; display: flex; gap: 12px; align-items: center; justify-content: center; font: 600 30px 'DM Sans', sans-serif; color: #fff; filter: drop-shadow(0 2px 8px rgba(0,0,0,.5)); }
#w img { width: 44px; height: 44px; border-radius: 50%; }
#w span { opacity: .6; }
</style>
<div id="w"><img src="uncut:media/m-img">furmous<span>.ai</span></div>
<script>
const w = document.getElementById("w");
window.render = (t) => {
  const a = Math.min(1, t / 0.4);
  w.style.opacity = String(0.55 + 0.3 * a);
  w.style.transform = "translateY(" + (1 - a) * -10 + "px) scale(" + (1 + 0.02 * Math.sin(t * 2)) + ")";
};
</script>`;

const LABEL = `<script src="uncut:lib/spring.js"></script>
<style>
#pill { position: absolute; left: 50%; top: 210px; padding: 14px 28px; border-radius: 999px; background: rgba(255,138,31,.85); backdrop-filter: blur(14px); color: #1a0d00; font: 800 38px 'DM Sans', sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.35), 0 0 40px rgba(255,138,31,.6); white-space: nowrap; }
</style>
<div id="pill">MY CAT PEDRI</div>
<script>
const pill = document.getElementById("pill");
window.render = (t, info) => {
  const k = uncutSpring(t, "spring.bounce");
  const out = Math.max(0, Math.min(1, (info.duration / info.fps - t) / 0.2));
  pill.style.transform = "translateX(-50%) scale(" + k * out + ")";
  pill.style.opacity = String(Math.min(1, k) * out);
};
</script>`;

const STICKER = `<script src="uncut:lib/confetti.js"></script>
<canvas id="c" width="720" height="1280"></canvas>
<img id="paw" src="uncut:media/m-img" style="position:absolute;left:420px;top:780px;width:240px;height:240px;border-radius:24px;filter:drop-shadow(0 10px 20px rgba(0,0,0,.5))">
<script>
const ctx = document.getElementById("c").getContext("2d");
const paw = document.getElementById("paw");
window.render = (t) => {
  ctx.clearRect(0, 0, 720, 1280);
  uncutConfetti.draw(ctx, t, { seed: 7, count: 140, origin: { x: 0.5, y: 0.62 } });
  paw.style.transform = "rotate(" + Math.sin(t * 8) * 12 + "deg) scale(" + Math.min(1, t * 5) + ")";
};
</script>`;

const SPLIT = `<canvas id="c" width="720" height="1280"></canvas>
<style>
#bar { position: absolute; left: 0; right: 0; top: 632px; height: 16px; background: #ff8a1f; box-shadow: 0 0 24px rgba(255,138,31,.8); }
.tag { position: absolute; left: 32px; padding: 8px 18px; border-radius: 10px; background: rgba(0,0,0,.5); backdrop-filter: blur(8px); color: #fff; font: 700 30px 'DM Sans', sans-serif; }
</style>
<div id="bar"></div><div class="tag" id="a" style="top:560px">THEN</div><div class="tag" id="b" style="top:670px">NOW</div>
<script>
const ctx = document.getElementById("c").getContext("2d");
const bar = document.getElementById("bar");
window.render = async (t) => {
  const f = await uncut.frame("m-a", 1 + t, { width: 720 });
  ctx.clearRect(0, 0, 720, 1280);
  ctx.drawImage(f, 0, 0, f.width, f.height * 0.85, 0, 640, 720, 540);
  bar.style.transform = "scaleX(" + Math.min(1, t / 0.5) + ")";
  for (const id of ["a", "b"]) document.getElementById(id).style.opacity = String(Math.min(1, Math.max(0, (t - 0.3) / 0.3)));
};
</script>`;

const CARD = `<canvas id="c" width="720" height="1280"></canvas>
<script>
const ctx = document.getElementById("c").getContext("2d");
window.render = (t) => {
  const g = ctx.createLinearGradient(0, 0, 720, 1280);
  g.addColorStop(0, "#1b1035");
  g.addColorStop(1, "hsl(" + (20 + t * 40) + ", 90%, 55%)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 720, 1280);
  ctx.shadowColor = "rgba(255,170,80,.9)";
  ctx.shadowBlur = 24;
  for (let i = 0; i < 160; i++) {
    const a = i * 0.7 + t * 1.5;
    ctx.fillStyle = "rgba(255,255,255," + (0.3 + (i % 5) * 0.1) + ")";
    ctx.beginPath();
    ctx.arc(360 + Math.cos(a) * (80 + i * 5), 640 + Math.sin(a * 1.3) * (80 + i * 6), 6 + (i % 7), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  const k = Math.min(1, t / 0.5);
  ctx.save();
  ctx.translate(360, 640);
  ctx.scale(0.8 + 0.2 * k, 0.8 + 0.2 * k);
  ctx.globalAlpha = k;
  ctx.fillStyle = "#fff";
  ctx.font = "800 84px 'DM Sans', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("PEDRI", 0, -20);
  ctx.font = "600 40px 'DM Sans', sans-serif";
  ctx.fillText("vs the world", 0, 50);
  ctx.restore();
};
</script>`;

const CARD_3D = `<script src="uncut:lib/three.js"></script>
<canvas id="c" width="720" height="1280"></canvas>
<script>
const canvas = document.getElementById("c");
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(720, 1280, false);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 720 / 1280, 0.1, 100);
camera.position.z = 6;
const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(1.2, 0.38, 160, 24), new THREE.MeshStandardMaterial({ color: 0xff8a1f, roughness: 0.35, metalness: 0.4 }));
scene.add(knot, new THREE.AmbientLight(0xffffff, 0.5));
const light = new THREE.DirectionalLight(0xffffff, 2.2);
light.position.set(3, 4, 5);
scene.add(light);
window.render = (t) => {
  knot.rotation.set(t * 0.9, t * 1.3, 0);
  knot.scale.setScalar(Math.min(1, t / 0.4));
  renderer.render(scene, camera);
};
</script>`;

const CARD_FOOTAGE = `<canvas id="c" width="720" height="1280"></canvas>
<script>
const ctx = document.getElementById("c").getContext("2d");
window.render = async (t) => {
  const f = await uncut.frame("m-c", 2 + t, { width: 720 });
  ctx.drawImage(f, 0, 0, 720, 1280);
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.fillRect(0, 0, 720, 1280);
  ctx.fillStyle = "#fff";
  ctx.font = "800 72px 'DM Sans', sans-serif";
  ctx.textAlign = "center";
  ctx.globalAlpha = Math.min(1, t / 0.4);
  ctx.fillText("CHAMPIONS", 360, 660);
};
</script>`;

const CARD_UI = `<div id="stage" style="position:absolute;inset:0;background:#141414;overflow:hidden"><div id="cam" style="position:absolute;left:0;top:0;transform-origin:0 0"></div></div>
<script src="uncut:lib/ui.js"></script>
<script>
const cam = document.getElementById("cam");
window.render = (t) => {
  const ed = uncutUI.mount(cam, "editor", {
    width: 1440, height: 1000, time: t, blur: Math.max(0, 6 - t * 4), dim: 0.1,
    message: { text: "Cut the best moments of Pedri into a 30 s promo" },
    turn: { steps: ["Reading the footage", "Finding the best moments", "Cutting to the beat"], done: Math.min(3, Math.floor(t * 1.5)) },
    timeline: { clips: [
      { track: "Main", start: 0, duration: 1.2, name: "Landing", media: "m-a", in: 1 },
      { track: "Main", start: 1.2, duration: 1.6, name: "Champions", media: "m-c", in: 2 },
    ], playhead: t },
  });
  const r = uncutUI.rectIn(uncutUI.find(ed, "frame"), cam);
  const k = Math.min(720 / r.w, 1280 / r.h) * (0.6 + 0.1 * t);
  cam.style.transform = "translate(" + (360 - (r.x + r.w / 2) * k) + "px, " + (640 - (r.y + r.h / 2) * k) + "px) scale(" + k + ")";
};
</script>`;

type Kind = "watermark" | "label" | "overlay" | "split" | "card" | "clip";
type GraphicKind = Exclude<Kind, "clip">;

const SLOTS: Record<GraphicKind, MarkerSlot> = {
  watermark: { x: 20, y: 1200, rgb: [255, 0, 170] },
  label: { x: 100, y: 1200, rgb: [0, 170, 255] },
  overlay: { x: 180, y: 1200, rgb: [170, 255, 0] },
  split: { x: 260, y: 1200, rgb: [120, 0, 255] },
  card: { x: 340, y: 1200, rgb: [0, 255, 170] },
};

const GRAPHICS: Record<string, string> = {
  "watermark.html": WATERMARK + markerHtml(SLOTS.watermark),
  "label.html": LABEL + markerHtml(SLOTS.label),
  "sticker.html": STICKER + markerHtml(SLOTS.overlay),
  "split-overlay.html": SPLIT + markerHtml(SLOTS.split),
  "card.html": CARD + markerHtml(SLOTS.card),
  "card-3d.html": CARD_3D + markerHtml(SLOTS.card),
  "card-footage.html": CARD_FOOTAGE + markerHtml(SLOTS.card),
  "card-ui.html": CARD_UI + markerHtml(SLOTS.card),
};
interface Placed {
  readonly id: string;
  readonly kind: Kind;
  readonly track: number;
  readonly start: number;
  readonly duration: number;
  readonly in: number;
}

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
let projectFrames = 0;
const placed: Array<Placed> = [];
const results: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

function makeSource(src: (typeof SOURCES)[number]) {
  const audio = src.sound ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"] : [];
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `${src.pattern}=size=${src.size}:rate=${src.rate}`,
    ...audio,
    "-t",
    String(SOURCE_S),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-g",
    String(src.rate * 2),
    "-bf",
    "2",
    "-pix_fmt",
    "yuv420p",
    ...(src.sound ? ["-c:a", "aac", "-b:a", "128k"] : []),
    join(root, src.file),
  ]);
}

/** The main track: clips of 2.8 to 9.4 s with a 2.8 s graphic card between some, and a run of very short cuts. */
function mainTrack(random: () => number) {
  const items: Array<Record<string, unknown>> = [];
  const cards = ["card.html", "card-ui.html", "card-3d.html", "card-footage.html"];
  let cardAt = 0;
  const clip = (seconds: number) => {
    const source = SOURCES[Math.floor(random() * SOURCES.length)]!;
    const duration = s(seconds);
    const inPoint = Math.floor(random() * (SOURCE_S * source.rate - duration - 1));
    items.push({ id: `main${items.length}`, type: "clip", media: source.id, in: inPoint, duration });
  };
  const card = () => items.push({ id: `main${items.length}`, type: "graphic", src: `graphics/${cards[cardAt++ % cards.length]}`, duration: s(2.8) });
  for (const seconds of [9.4, 9.4]) clip(seconds);
  card();
  clip(3.7);
  clip(5.6);
  card();
  clip(9.4);
  card();
  for (let i = 0; i < 14; i++) clip(i % 3 === 0 ? 0.3 : 0.7);
  card();
  clip(4.4);
  clip(9.4);
  card();
  clip(9.4);
  card();
  clip(2.8);
  return items;
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-graphics-bench-")));
  dir = join(root, "Promo.uncut");
  mkdirSync(join(dir, "graphics"), { recursive: true });
  for (const [name, html] of Object.entries(GRAPHICS)) writeFileSync(join(dir, "graphics", name), html);
  for (const src of SOURCES) makeSource(src);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1024x1024", "-frames:v", "1", join(root, "pedri.png")]);
  const media = [
    ...SOURCES.map((src) => {
      const [w, h] = src.size.split("x").map(Number);
      return {
        id: src.id,
        kind: "video",
        name: src.file,
        path: join(root, src.file),
        probe: { frames: SOURCE_S * src.rate, fps: src.rate, width: w, height: h, hasAudio: src.sound },
      };
    }),
    { id: "m-img", kind: "image", name: "pedri.png", path: join(root, "pedri.png"), probe: { width: 1024, height: 1024 } },
  ];
  const main = mainTrack(rng(128));
  projectFrames = main.reduce((sum, it) => sum + (it.duration as number), 0);
  const graphic = (id: string, file: string, start: number, duration: number) => ({ id, type: "graphic", src: `graphics/${file}`, start, duration });
  const watermark: Array<Record<string, unknown>> = [];
  for (let at = 0, i = 0; at + s(9.4) <= projectFrames; i++) {
    watermark.push(graphic(`wm${i}`, "watermark.html", at, s(9.4)));
    at += s(9.4) + (i % 3 === 2 ? s(2) : 0);
  }
  const labels = [
    graphic("lb0", "label.html", s(19), s(3.7)),
    graphic("lb1", "label.html", s(22.8), s(5.6)),
    ...[0, 1, 2, 3].map((i) => graphic(`lb${2 + i}`, "label.html", s(41 + i * 0.5), s(0.5))),
    graphic("lb6", "label.html", s(43), s(4.4)),
  ];
  const overlays = [
    graphic("ov0", "sticker.html", s(21.2), s(0.8)),
    graphic("ov1", "sticker.html", s(30), s(0.9)),
    graphic("ov2", "split-overlay.html", s(50), s(9.4)),
    graphic("ov3", "sticker.html", s(62), s(9.4)),
  ];
  const split = [{ id: "sp0", type: "clip", media: "m-d", in: 30, duration: s(9.4), start: s(50), transform: { x: 0, y: 0, w: 720, h: 640, fit: "cover" } }];
  const tracks = [
    { id: "watermark", kind: "video", name: "Watermark", items: watermark },
    { id: "labels", kind: "video", name: "Labels", items: labels },
    { id: "overlays", kind: "video", name: "Overlays", items: overlays },
    { id: "split", kind: "video", name: "Split top", items: split },
    { id: "main", kind: "video", role: "main", name: "Main", items: main },
  ];
  tracks.forEach((track, index) => {
    let start = 0;
    for (const it of track.items as Array<{ id: string; type: string; start?: number; duration: number; in?: number; src?: string }>) {
      const at = it.start ?? start;
      const kind: Kind =
        it.type === "clip"
          ? "clip"
          : it.src?.includes("split")
            ? "split"
            : ({ watermark: "watermark", labels: "label", overlays: "overlay", main: "card" } as const)[track.id as "main"];
      placed.push({ id: it.id, kind, track: index, start: at, duration: it.duration, in: it.in ?? 0 });
      start = at + it.duration;
    }
  });
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({ format: "uncut/0", name: "Promo", canvas: { width: 720, height: 1280, fps: FPS }, textLooks: 1, media, tracks }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (Object.keys(results).length) writeFileSync("test-output/graphics-bench.json", JSON.stringify(results, null, 2));
  if (root) rmSync(root, { recursive: true, force: true });
});

/** In the page: graphic iframes alive (most at once, made in all), how long each took to draw its first frame, and the graphic routes' fetch times. */
async function startGraphicProbe() {
  await page.evaluate(() => {
    const frameEl = document.querySelector<HTMLElement>("[data-testid=preview-frame]")!;
    const made = new Map<Element, number>();
    const firstDrawMs: Array<number> = [];
    const probe = { maxFrames: 0, made: 0, firstDrawMs, fetches: [] as Array<{ kind: string; ms: number }>, stop: () => {} };
    (window as unknown as { __graphicProbe: typeof probe }).__graphicProbe = probe;
    const count = () => (probe.maxFrames = Math.max(probe.maxFrames, frameEl.querySelectorAll(".pv-graphic iframe").length));
    const mutations = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes)
          if (n instanceof HTMLElement && n.classList.contains("pv-graphic") && !made.has(n)) (made.set(n, performance.now()), probe.made++);
        if (r.type === "attributes" && r.attributeName === "data-frames" && r.target instanceof HTMLElement && made.has(r.target)) {
          firstDrawMs.push(performance.now() - made.get(r.target)!);
          made.delete(r.target);
        }
      }
      count();
    });
    mutations.observe(frameEl, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-frames"] });
    const resources = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const kind = e.name.includes("/media/graphic-media") ? "media" : e.name.includes("/media/graphic/") ? "document" : "";
        if (kind) probe.fetches.push({ kind, ms: e.duration });
      }
    });
    resources.observe({ type: "resource", buffered: false });
    probe.stop = () => (mutations.disconnect(), resources.disconnect());
  });
}

async function stopGraphicProbe() {
  return page.evaluate(() => {
    const p = (
      window as unknown as {
        __graphicProbe: { maxFrames: number; made: number; firstDrawMs: Array<number>; fetches: Array<{ kind: string; ms: number }>; stop: () => void };
      }
    ).__graphicProbe;
    p.stop();
    const sorted = (xs: Array<number>) => [...xs].sort((a, b) => a - b);
    const q = (xs: Array<number>, f: number) => (xs.length ? Math.round(sorted(xs)[Math.min(xs.length - 1, Math.floor(f * xs.length))]!) : 0);
    const of = (kind: string) => p.fetches.filter((f) => f.kind === kind).map((f) => f.ms);
    return {
      iframesMax: p.maxFrames,
      iframesMade: p.made,
      firstDrawMedianMs: q(p.firstDrawMs, 0.5),
      firstDrawMaxMs: q(p.firstDrawMs, 1),
      documentFetches: of("document").length,
      documentMedianMs: q(of("document"), 0.5),
      mediaFetches: of("media").length,
      mediaMedianMs: q(of("media"), 0.5),
      mediaP90Ms: q(of("media"), 0.9),
    };
  });
}

const engineStats = () =>
  page.evaluate(() => (globalThis as { __uncutPlay?: { stats: () => unknown } }).__uncutPlay?.stats?.() ?? "no D311 engine in this build");

const layersOf = (kinds: ReadonlyArray<Kind>): Array<GlitchLayer> =>
  placed.filter((p) => kinds.includes(p.kind)).map((p) => ({ id: p.id, kind: "video", track: p.track, start: p.start, duration: p.duration, in: p.in }));

/** While playing: a click on the ruler every 3 s, at random frames of the first two thirds (as a user jumps around). */
async function jumpAround(count: number) {
  const random = rng(7);
  const ruler = (await (await page.$("[data-testid=ruler]"))!.boundingBox())!;
  const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
  const scroll = await page.$eval(".bottom-body", (el) => el.scrollLeft);
  for (let i = 0; i < count; i++) {
    await sleep(3000);
    const f = Math.floor(random() * projectFrames * 0.66);
    await page.mouse.click(ruler.x + 0.5 + f * ppf - scroll, ruler.y + ruler.height / 2);
    await sleep(50);
    const playing = await page.$eval("[data-testid=preview-frame]", (el) => (el as HTMLElement).dataset.playing === "true");
    if (!playing) await page.keyboard.press("Space");
  }
  await page.mouse.move(ruler.x, ruler.y - 200);
}

async function playThrough(label: string, jumps = 0) {
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=preview-frame]")?.dataset.frame === "0", { timeout: 10000 });
  await sleep(2000);
  await startGlitchProbe(
    page,
    placed.map((p) => p.id),
  );
  await startGraphicProbe();
  const screen = await startScreenRecord(page);
  const trace = process.env.UNCUT_BENCH_TRACE === "1";
  if (trace) await page.tracing.start({ path: `test-output/graphics-${label}-trace.json`, screenshots: false });
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=preview-frame]")?.dataset.playing === "true", { timeout: 5000 });
  const shot = process.env.UNCUT_BENCH_SHOT === "1" ? sleep(41.2 * 1000).then(() => page.screenshot({ path: `test-output/graphics-${label}.png` })) : undefined;
  if (jumps) await jumpAround(jumps);
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=preview-frame]")?.dataset.playing === "false", {
    timeout: (projectFrames / FPS) * 1000 * 3 + 10000,
    polling: 100,
  });
  if (trace) await page.tracing.stop();
  await shot;
  await sleep(200);
  await stopScreenRecord(screen);
  const graphics = await stopGraphicProbe();
  const run = await stopGlitchProbe(page);
  const marked = placed.filter((p) => p.kind !== "clip").map((p) => ({ id: p.id, slot: SLOTS[p.kind as GraphicKind], start: p.start, duration: p.duration }));
  const onScreen = scoreMarkers(screen, run.samples, marked, { canvasWidth: 720 });
  if (process.env.UNCUT_BENCH_SAMPLES === "1") writeFileSync(`test-output/graphics-${label}-samples.json`, JSON.stringify({ placed, samples: run.samples }));
  const score = (kinds: ReadonlyArray<Kind>) => benchPlayback(run.samples, layersOf(kinds), { fps: FPS });
  const scores: Record<string, BenchResult> = {
    all: score(["watermark", "label", "overlay", "split", "card", "clip"]),
    clips: score(["clip"]),
    graphics: score(["watermark", "label", "overlay", "split", "card"]),
    watermark: score(["watermark"]),
    "labels and overlays": score(["label", "overlay", "split"]),
    "main-track cards": score(["card"]),
  };
  const { details, ...screenScore } = onScreen;
  results[label] = { ...scores, graphics: { ...scores.graphics, ...graphics }, onScreen: screenScore };
  for (const [name, r] of Object.entries(scores)) console.log(`# graphics ${label} ${name}: ${formatBench(r)}`);
  console.log(`# graphics ${label} graphic frames: ${JSON.stringify(graphics)}`);
  console.log(`# graphics ${label} on screen: ${JSON.stringify(screenScore)} ${details.slice(0, 30).join(", ")}`);
  console.log(`# graphics ${label} engine: ${JSON.stringify(await engineStats())}; preview stats ${JSON.stringify(run.stats)}`);
  return { all: scores.all!, graphics: scores.graphics!, onScreen };
}

/** UNCUT_BENCH_CPU=<rate>: the editor's and the graphics' renderers slowed down that many times (CDP), as on a slower Mac. */
async function throttleCpu() {
  const rate = Number(process.env.UNCUT_BENCH_CPU ?? 0);
  if (!(rate > 1) || !app) return;
  const slow = async (target: import("puppeteer-core").Target) => {
    if (target.type() !== "page" && target.type() !== "other" && !target.url().includes("/media/graphic/")) return;
    const session = await target.createCDPSession().catch(() => undefined);
    await session?.send("Emulation.setCPUThrottlingRate", { rate }).catch(() => {});
  };
  await (await page.createCDPSession()).send("Emulation.setCPUThrottlingRate", { rate });
  for (const target of app.browser.targets()) await slow(target);
  app.browser.on("targetcreated", (target) => void slow(target));
}

async function openProject(engine: boolean) {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, `data-${engine ? "engine" : "video"}`), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await viewerPrefs(page, { gpu: true, playEngine: engine });
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click("[data-testid=bottom-timeline]");
  await throttleCpu();
  await sleep(1500);
}

for (const [engine, jumps] of [
  [true, 0],
  [false, 0],
  [true, 12],
] as const) {
  const label = `${engine ? "engine" : "video"}${jumps ? " jumps" : ""}`;
  test(`a 9:16 promo with HTML graphics on every track plays without missing layers (${label})`, { skip, timeout: 400000 }, async () => {
    await openProject(engine);
    try {
      const { all, graphics, onScreen } = await playThrough(label, jumps);
      assert.ok(all.samples > 0, "the run was sampled");
      check(NO_REAL_GPU, onScreen.neverShown.length === 0, `${label}: never on screen: ${onScreen.neverShown.join(", ")}`);
      check(NO_REAL_GPU, graphics.neverOnTime === 0, `${label}: ${graphics.neverOnTime} graphics never drew their frame on time`);
      check(NO_REAL_GPU, graphics.missingMs < (jumps ? 2000 : 500), `${label}: graphics missing for ${graphics.missingMs.toFixed(0)} ms in all`);
      check(NO_REAL_GPU, all.latePct < 5, `${label}: ${all.latePct.toFixed(1)}% of samples off their frame`);
      if (!jumps) {
        check(NO_REAL_GPU, onScreen.missingMs < 500, `${label}: graphics missing on screen for ${onScreen.missingMs.toFixed(0)} ms in all`);
        check(NO_REAL_GPU, all.clockSlipMs < 300, `${label}: the playhead fell ${all.clockSlipMs.toFixed(0)} ms behind the wall clock`);
      }
      assert.deepEqual(app!.errors, []);
    } finally {
      await app?.close();
      app = undefined;
    }
  });
}
