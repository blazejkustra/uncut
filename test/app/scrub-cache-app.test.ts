// D221: the scrub frame cache on the packaged app (issue #12 item 3), run invisibly and muted.
// Footage: a synthetic 4K30 HEVC clip with a keyframe every 60 frames (D212's), with a barcode band
// along its top that spells each frame's index, so the frame on screen is read, not guessed. The
// server makes its 1280 px proxy as in D212.
// - Exactness: after every scrub step (ruler clicks, arrow steps, reverse and 4× shuttles) the
//   picture shown (the scrub canvas when it's up, else the <video>) is the playhead's frame.
// - Latency, cache off then on, on the original and the proxy: from the pointer/key to the first
//   presented frame that is the playhead's (a <video> frame by requestVideoFrameCallback; a scrub
//   canvas frame by the time it was drawn and shown, in the animation frame that presents it), median and p90; shuttles as the share
//   of animation frames showing the playhead's exact frame. Printed as "# D221 ...".
// - Parity: the canvas's picture and the <video>'s at the same frame are the same (SSIM ≥ 0.99 on
//   preview screenshots).
// - Memory: with a 40 MB budget the cache never holds more; proxies on/off swaps the source.
// Screenshots: test-output/scrub-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { ssim } from "../helpers/image-compare.ts";
import { NO_REAL_GPU } from "../helpers/capabilities.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const hasHevc = hasFfmpeg && /\bhevc_videotoolbox\b/.test(execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }));
const skip = existsSync(APP) ? (hasHevc ? false : "needs ffmpeg with hevc_videotoolbox to make 4K test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 30;
const SECONDS = 20;
const BITS = 10;
let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const out = (name: string) => resolve("test-output", `scrub-${name}.png`);
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-scrub-app-")));
  dir = join(root, "Scrub.uncut");
  mkdirSync(join(dir, "media"), { recursive: true });
  // testsrc2 at 4K with a band of BITS bars over its top fifth: bar i (from the left) is white when bit i of the frame index is set.
  const bars = `geq=lum='if(bitand(N\\,pow(2\\,floor(X/16)))\\,235\\,16)':cb=128:cr=128,scale=3840:432:flags=neighbor`;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=3840x2160:rate=${FPS}`, "-f", "lavfi", "-i", `color=black:size=${16 * BITS}x16:rate=${FPS}`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-filter_complex", `[1:v]format=yuv420p,${bars}[b];[0:v][b]overlay=0:0:shortest=1,format=yuv420p[v]`, "-map", "[v]", "-map", "2:a", "-t", String(SECONDS), "-c:v", "hevc_videotoolbox", "-b:v", "40M", "-g", "60", "-tag:v", "hvc1", "-c:a", "aac", "-shortest", join(root, "Drone4K.mp4")]);
  // Colour quadrants in H.264 that says nothing about its colours (BT.601 to <video> and ffmpeg, BT.709 to WebCodecs), SD and HD, and full range.
  const quads = (w: number, h: number) => ["red", "lime", "blue", "gray"].map((c, k) => `color=c=${c}:s=${w}x${h}:r=${FPS}:d=2[q${k}]`).join(";") + ";[q0][q1]hstack[t];[q2][q3]hstack[u];[t][u]vstack";
  execFileSync("ffmpeg", ["-v", "error", "-y", "-filter_complex", quads(160, 90), "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "Colours.mp4")]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-filter_complex", quads(640, 360), "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "ColoursHD.mp4")]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-filter_complex", quads(640, 360), "-c:v", "libx264", "-pix_fmt", "yuvj420p", "-color_range", "pc", join(root, "ColoursFull.mp4")]);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Scrub",
      canvas: { width: 1920, height: 1080, fps: FPS },
      textLooks: 1,
      media: [
        { id: "m-drone", kind: "video", name: "Drone4K.mp4", path: join(root, "Drone4K.mp4"), probe: { frames: SECONDS * FPS, fps: FPS, width: 3840, height: 2160, hasAudio: true } },
        ...["Colours", "ColoursHD", "ColoursFull"].map((n, k) => ({ id: `m-col${k}`, kind: "video", name: `${n}.mp4`, path: join(root, `${n}.mp4`), probe: { frames: 2 * FPS, fps: FPS, width: k ? 1280 : 320, height: k ? 720 : 180, hasAudio: false } })),
      ],
      tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "c1", type: "clip", media: "m-drone", in: 0, duration: SECONDS * FPS }, ...[0, 1, 2].map((k) => ({ id: `col${k}`, type: "clip", media: `m-col${k}`, in: 0, duration: 2 * FPS }))] }],
    }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

/**
 * In the page: a recorder of what the preview presents, as the frame on screen changes. Video frames
 * by rVFC (while the scrub canvas is hidden, else they're under it); canvas frames when it shows or
 * its data-sample changes (timed at the next animation frame, when it's painted); the <video>'s last
 * presented frame when the canvas hides (it's on screen from then, without a new rVFC: a frame the
 * <video> presented under the canvas); and what's on screen when `t0` is set by the next
 * pointerdown/keydown (a click on the frame already shown).
 */
async function installRecorder() {
  await page.evaluate((fps) => {
    type Ev = { at: number; late?: number; frame: number; kind: "video" | "canvas" };
    const w = window as unknown as { rec: { t0: number; events: Array<Ev> }; shownFrame: () => { frame: number; kind: string; bar: number } };
    w.rec = { t0: 0, events: [] };
    const canvas = () => document.querySelector<HTMLCanvasElement>("canvas[data-scrub=c1]");
    const isUp = (c: HTMLCanvasElement | null): c is HTMLCanvasElement => !!c && c.style.visibility !== "hidden";
    let watched: HTMLVideoElement | undefined;
    // The watched <video>'s last presented frame (by rVFC), whether or not the canvas covered it.
    let lastVideo: number | undefined;
    // `at`: when it was drawn (it's presented with the next rendering step); `late`: the next
    // animation frame after that, which overcounts by a frame when the draw ran in one already.
    const push = (frame: number, kind: Ev["kind"]) => {
      const ev: Ev = { at: performance.now(), late: 0, frame, kind };
      w.rec.events.push(ev);
      requestAnimationFrame(() => (ev.late = performance.now()));
    };
    const start = () => {
      w.rec = { t0: performance.now(), events: [] };
      const c = canvas();
      const now = isUp(c) ? Math.round(Number(c.dataset.time) * fps) : lastVideo;
      if (now !== undefined) w.rec.events.push({ at: w.rec.t0, late: w.rec.t0, frame: now, kind: isUp(c) ? "canvas" : "video" });
    };
    document.addEventListener("pointerdown", start, { capture: true });
    document.addEventListener("keydown", start, { capture: true });
    const watchVideo = (v: HTMLVideoElement) => {
      const loop = () =>
        v.requestVideoFrameCallback((now, meta) => {
          if (v !== watched) return;
          lastVideo = Math.round(meta.mediaTime * fps);
          if (!isUp(canvas())) w.rec.events.push({ at: now, frame: lastVideo, kind: "video" });
          loop();
        });
      loop();
    };
    // One observer over the document (a canvas made or replaced, e.g. by the proxy switch, is seen from its first draw).
    let wasUp = false;
    const observer = new MutationObserver((records) => {
      const c = canvas();
      if (!c || !records.some((r) => r.target === c)) return;
      const up = isUp(c);
      if (up) push(Math.round(Number(c.dataset.time) * fps), "canvas");
      else if (wasUp && lastVideo !== undefined) push(lastVideo, "video");
      wasUp = up;
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-sample", "style"] });
    const attach = () => {
      const v = document.querySelector<HTMLVideoElement>("video[data-item=c1]");
      if (v && v !== watched) {
        watched = v;
        lastVideo = undefined;
        watchVideo(v);
      }
      setTimeout(attach, 30);
    };
    attach();
    // What's on screen now: the canvas when it's up, else the video, read from its barcode.
    const probe = document.createElement("canvas");
    probe.width = 160;
    probe.height = 90;
    const ctx = probe.getContext("2d", { willReadFrequently: true })!;
    w.shownFrame = () => {
      const c = canvas();
      const v = document.querySelector<HTMLVideoElement>("video[data-item=c1]")!;
      const up = c && c.style.visibility !== "hidden";
      ctx.drawImage(up ? c : v, 0, 0, 160, 90);
      const row = ctx.getImageData(0, 8, 160, 1).data;
      let bar = 0;
      for (let i = 0; i < 10; i++) if (row[(8 + 16 * i) * 4]! > 128) bar |= 1 << i;
      return { frame: up ? Math.round(Number(c.dataset.time) * fps) : Math.round(v.currentTime * fps - 0.5), kind: up ? "canvas" : "video", bar };
    };
  }, FPS);
}

const playhead = () => page.$eval("[data-testid=preview-frame]", (el) => Number((el as HTMLElement).dataset.frame));

/** Waits until the shown picture is the playhead's frame (by its barcode), then the latency from t0 (ms). */
async function settle(label: string, timed = true) {
  const want = await playhead();
  const ok = await page
    .waitForFunction(
      (f) => {
        const w = window as unknown as { shownFrame: () => { bar: number }; rec: { events: Array<{ frame: number }> } };
        return w.shownFrame().bar === f.want && (!f.timed || w.rec.events.some((e) => e.frame === f.want));
      },
      { timeout: 8000, polling: 16 },
      { want, timed },
    )
    .then(
      () => true,
      () => false,
    );
  const r = await page.evaluate((f) => {
    const w = window as unknown as { rec: { t0: number; events: Array<{ at: number; late?: number; frame: number; kind: string }> }; shownFrame: () => { frame: number; kind: string; bar: number } };
    const first = w.rec.events.find((e) => e.frame === f);
    return { ms: first ? first.at - w.rec.t0 : NaN, late: first ? (first.late || first.at) - w.rec.t0 : NaN, via: first?.kind ?? "", shown: w.shownFrame() };
  }, want);
  assert.ok(ok, `${label}: the preview shows frame ${r.shown.bar} (${r.shown.kind}) for the playhead's ${want}`);
  assert.equal(r.shown.bar, want, `${label}: barcode`);
  return { ms: r.ms, late: r.late, via: r.via };
}

const stats = (times: Array<number>) => {
  const s = [...times].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { median: q(0.5), p90: q(0.9), max: s.at(-1)! };
};
const fmt = (t: { median: number; p90: number; max: number }) => `median ${t.median.toFixed(1)} ms, p90 ${t.p90.toFixed(1)} ms, max ${t.max.toFixed(1)} ms`;

/** Clicks the ruler at a frame. */
async function clickAt(f: number) {
  const ruler = (await (await page.$("[data-testid=ruler]"))!.boundingBox())!;
  const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
  const scroll = await page.$eval(".bottom-body", (el) => el.scrollLeft);
  await page.mouse.click(ruler.x + 0.5 + f * ppf - scroll, ruler.y + ruler.height / 2);
}

async function clicks(label: string) {
  const ruler = (await (await page.$("[data-testid=ruler]"))!.boundingBox())!;
  const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
  const scroll = await page.$eval(".bottom-body", (el) => el.scrollLeft);
  const visible = Math.min(SECONDS * FPS - 2, Math.floor((ruler.width - 4) / ppf));
  const next = rng(212);
  const times: Array<number> = [];
  const late: Array<number> = [];
  const via: Record<string, number> = {};
  for (let i = 0; i < 20; i++) {
    const f = 1 + Math.floor(next() * visible);
    await page.mouse.click(ruler.x + 0.5 + f * ppf - scroll, ruler.y + ruler.height / 2);
    const r = await settle(`${label} click ${f}`);
    times.push(r.ms);
    late.push(r.late);
    via[r.via] = (via[r.via] ?? 0) + 1;
    await sleep(150);
  }
  const t = stats(times);
  const misses = (await cacheStats()).misses.slice(-20);
  console.log(`# D221 ${label} random clicks: ${fmt(t)}; canvas one frame later: ${fmt(stats(late))} (${JSON.stringify(via)})${misses.length ? `; decode of a missed frame: ${fmt(stats(misses))}` : ""}`);
  return t;
}

/** 30 steps right then 30 left, a key press every ~33 ms after the last frame shows (held arrow keys). */
async function steps(label: string) {
  const times: Array<number> = [];
  const late: Array<number> = [];
  for (const k of ["ArrowRight", "ArrowLeft"] as const) {
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press(k);
      const r = await settle(`${label} ${k} ${i}`);
      times.push(r.ms);
      late.push(r.late);
      await sleep(33);
    }
  }
  const t = stats(times);
  console.log(`# D221 ${label} arrow steps: ${fmt(t)}; canvas one frame later: ${fmt(stats(late))}`);
  return t;
}

/** A shuttle for 3 s: the share of animation frames whose picture is the playhead's exact frame, and the median lag (frames). */
async function shuttle(label: string, keys: Array<string>, from: number) {
  await clickAt(from);
  await settle(`${label} before the shuttle`, false);
  for (const k of keys) await page.keyboard.press(k as "j");
  const r = await page.evaluate(
    (fps) =>
      new Promise<{ exact: number; lag: number; frames: number; distinct: number }>((done) => {
        const w = window as unknown as { shownFrame: () => { frame: number; bar: number } };
        const el = document.querySelector<HTMLElement>("[data-testid=preview-frame]")!;
        const lags: Array<number> = [];
        const seen = new Set<number>();
        const end = performance.now() + 3000;
        void fps;
        const tick = () => {
          const want = Number(el.dataset.frame);
          const shown = w.shownFrame().bar;
          seen.add(shown);
          lags.push(Math.abs(shown - want));
          if (performance.now() < end) requestAnimationFrame(tick);
          else {
            lags.sort((a, b) => a - b);
            done({ exact: lags.filter((l) => l === 0).length / lags.length, lag: lags[Math.floor(lags.length / 2)]!, frames: lags.length, distinct: seen.size });
          }
        };
        requestAnimationFrame(tick);
      }),
    FPS,
  );
  await page.keyboard.press("k");
  console.log(`# D221 ${label} shuttle ${keys.join("")}: ${(r.exact * 100).toFixed(0)}% of ${r.frames} animation frames exact, median lag ${r.lag} frames, ${r.distinct} distinct frames`);
  await settle(`${label} after the shuttle`, false);
  return r;
}

async function setCheck(testid: string, on: boolean) {
  await page.keyboard.down("Meta");
  await page.keyboard.press("Comma");
  await page.keyboard.up("Meta");
  await waitFor("[data-testid=settings]");
  await page.click("[data-testid=settings-nav-app]");
  await waitFor(`[data-testid=${testid}]`);
  const checked = await page.$eval(`[data-testid=${testid}]`, (el) => (el as HTMLInputElement).checked);
  if (checked !== on) await page.click(`[data-testid=${testid}]`);
  if (testid === "settings-scrub-cache" && on) await page.screenshot({ path: out("settings") });
  await page.click("[data-testid=settings-close]");
}
const setProxies = async (on: boolean) => {
  await setCheck("settings-proxies", on);
  await page.waitForFunction((want) => document.querySelector<HTMLVideoElement>("video[data-item=c1]")?.src.includes(want ? "/media/proxy/" : "/media/file/"), { timeout: 10000 }, on);
  await page.waitForFunction(() => (document.querySelector<HTMLVideoElement>("video[data-item=c1]")?.readyState ?? 0) >= 2, { timeout: 15000 });
};
const cacheStats = () => page.evaluate(() => (globalThis as unknown as { __uncutScrub: { stats: () => { bytes: number; budget: number; frames: number; misses: Array<number>; sources: Array<{ url: string; state: string; reason: string; colour: string; colourIn: string }> } } }).__uncutScrub.stats());

async function frameShot(name: string) {
  const el = (await page.$("[data-testid=preview-frame]"))!;
  await el.screenshot({ path: out(name) });
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", out(name)], { encoding: "utf8" }).trim().split(",").map(Number);
  return { file: out(name), w: w!, h: h! };
}

test("D221: scrubbing shows the exact frame, faster from the frame cache than <video> seeks; parity and the memory bound", { skip: skip || NO_REAL_GPU, timeout: 900000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_PROXIES: "on" } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  await page.click("[data-testid=bottom-timeline]");
  await page.$eval("[data-testid=rail-media]", (el) => (el as HTMLElement).click());
  await waitFor("[data-testid=media-tile][data-id=m-drone] [data-testid=media-proxy][data-phase=done]", 180000);
  await installRecorder();
  const results: Record<string, unknown> = {};
  for (const source of ["original", "proxy"] as const) {
    await setProxies(source === "proxy");
    for (const cache of [false, true]) {
      await setCheck("settings-scrub-cache", cache);
      const label = `${source} cache ${cache ? "on" : "off"}`;
      await page.keyboard.press("Home");
      await settle(`${label} home`, false);
      if (cache) {
        await page.waitForFunction(() => (globalThis as unknown as { __uncutScrub: { stats: () => { sources: Array<{ state: string }> } } }).__uncutScrub.stats().sources.some((s) => s.state === "ready"), { timeout: 10000 });
      }
      results[label] = { clicks: await clicks(label), steps: await steps(label), reverse: await shuttle(label, ["j"], 400), fast: await shuttle(label, ["l", "l", "l"], 60) };
    }
  }
  console.log(`# D221 results ${JSON.stringify(results)}`);
  const s = await cacheStats();
  console.log(`# D221 cache after the runs: ${(s.bytes / 2 ** 20).toFixed(1)} MB of ${(s.budget / 2 ** 20).toFixed(0)} MB, ${s.frames} frames, sources ${JSON.stringify(s.sources)}`);
  assert.ok(s.bytes <= s.budget);
  assert.ok(s.sources.some((x) => x.url.includes("/media/proxy/m-drone") && x.state === "ready"), "the proxy is decoded by the cache");
  assert.ok(!s.sources.some((x) => x.url.includes("/media/file/m-drone")), "the original's source went when the proxy took over");
  const r = results as Record<string, { clicks: { median: number }; steps: { median: number } }>;
  assert.ok(r["proxy cache on"]!.steps.median < r["proxy cache off"]!.steps.median, "arrow steps are faster from the cache (proxy)");
  assert.ok(r["original cache on"]!.steps.median < r["original cache off"]!.steps.median, "arrow steps are faster from the cache (original)");

  // Parity: the cache's canvas (kept up at rest for this) and the <video> at the same frames.
  await page.evaluate(() => (globalThis as unknown as { __uncutScrub: { keep: (on: boolean) => void } }).__uncutScrub.keep(true));
  for (const f of [37, 211, 488]) {
    await setCheck("settings-scrub-cache", true);
    await clickAt(f);
    await settle(`parity ${f} cache`);
    await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>("canvas[data-scrub=c1]")?.style.visibility !== "hidden", { timeout: 5000 });
    await sleep(400);
    const a = await frameShot(`parity-${f}-cache`);
    await setCheck("settings-scrub-cache", false);
    await settle(`parity ${f} video`, false);
    await sleep(400);
    const b = await frameShot(`parity-${f}-video`);
    const v = ssim(a.file, b.file, a.w, a.h);
    console.log(`# D221 parity frame ${f}: SSIM ${v.toFixed(4)} (cache canvas vs <video>)`);
    assert.ok(v >= 0.99, `frame ${f}: SSIM ${v}`);
  }

  // Colour: footage that says nothing (SD, HD) and full-range footage: the canvas frame has the <video>'s colours (read back in the page, no screenshot colour pipeline).
  await setCheck("settings-scrub-cache", true);
  for (const k of [0, 1, 2]) {
    const id = `col${k}`;
    await clickAt(SECONDS * FPS + k * 2 * FPS + 30);
    await page.waitForFunction((i) => document.querySelector<HTMLCanvasElement>(`canvas[data-scrub=${i}]`)?.style.visibility === "", { timeout: 10000 }, id);
    await page.waitForFunction((i) => {
      const v = document.querySelector<HTMLVideoElement>(`video[data-item=${i}]`);
      return !!v && !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - 1.0) < 0.02;
    }, { timeout: 10000 }, id);
    const colours = await page.evaluate((i) => {
      const read = (el: CanvasImageSource) => {
        const c = document.createElement("canvas");
        c.width = 320;
        c.height = 180;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(el, 0, 0, 320, 180);
        return [[80, 45], [240, 45], [80, 135], [240, 135]].map(([x, y]) => [...ctx.getImageData(x!, y!, 1, 1).data.slice(0, 3)]);
      };
      return { canvas: read(document.querySelector<HTMLCanvasElement>(`canvas[data-scrub=${i}]`)!), video: read(document.querySelector<HTMLVideoElement>(`video[data-item=${i}]`)!) };
    }, id);
    const src = (await cacheStats()).sources.find((x) => x.url.includes(`m-col${k}`));
    console.log(`# D221 colours ${["untagged SD", "untagged HD", "full range"][k]}: canvas ${JSON.stringify(colours.canvas)}, <video> ${JSON.stringify(colours.video)}; decoded as ${src?.colour} from ${src?.colourIn}`);
    for (let q = 0; q < 4; q++) for (let ch = 0; ch < 3; ch++) assert.ok(Math.abs(colours.canvas[q]![ch]! - colours.video[q]![ch]!) <= 3, `${id} quadrant ${q} channel ${ch}: ${colours.canvas[q]} vs ${colours.video[q]}`);
    // On screen: the canvas and the <video> (through the inverse of its lift when macOS lifts it, D222) show the grey quadrant alike.
    const onScreen = await frameShot(`tone-${k}-canvas`);
    await page.evaluate(() => (globalThis as unknown as { __uncutScrub: { keep: (on: boolean) => void } }).__uncutScrub.keep(false));
    await page.waitForFunction((i) => document.querySelector<HTMLCanvasElement>(`canvas[data-scrub=${i}]`)?.style.visibility === "hidden", { timeout: 5000 }, id);
    await sleep(300);
    const video = await frameShot(`tone-${k}-video`);
    await page.evaluate(() => (globalThis as unknown as { __uncutScrub: { keep: (on: boolean) => void } }).__uncutScrub.keep(true));
    const grey = (file: string, w: number, h: number) => execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `crop=${Math.round(w / 8)}:${Math.round(h / 8)}:${Math.round((w * 11) / 16)}:${Math.round((h * 11) / 16)},scale=1:1:flags=area,format=gray`, "-f", "rawvideo", "-"])[0]!;
    const g = [grey(onScreen.file, onScreen.w, onScreen.h), grey(video.file, video.w, video.h)];
    const v = ssim(onScreen.file, video.file, video.w, video.h);
    console.log(`# D221 on screen, ${["untagged SD", "untagged HD", "full range"][k]}: canvas vs <video> SSIM ${v.toFixed(4)}, grey quadrant ${g[0]} vs ${g[1]}`);
    assert.ok(Math.abs(g[0]! - g[1]!) <= 3, `grey quadrant on screen: canvas ${g[0]} vs <video> ${g[1]}`);
    // A 320×180 picture blown up to the canvas: the browser scales a <video> and a canvas with different filters (the colour edges), so only HD is held to SSIM.
    if (k > 0) assert.ok(v >= 0.99, `${id} on screen: SSIM ${v}`);
  }

  // At rest the <video> takes over once it's at the frame (what other tests and the fx path see, as before).
  await page.evaluate(() => (globalThis as unknown as { __uncutScrub: { keep: (on: boolean) => void } }).__uncutScrub.keep(false));
  await setCheck("settings-scrub-cache", true);
  await clickAt(100);
  await settle("back on the 4K clip", false);
  await page.keyboard.press("ArrowRight");
  // The step's frame came from the cache, then the <video> (the proxy's: it seeks along) took over.
  const step = await settle("at rest");
  assert.equal(step.via, "canvas");
  await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>("canvas[data-scrub=c1]")?.style.visibility === "hidden" && document.querySelector<HTMLVideoElement>("video[data-item=c1]")?.style.visibility === "", { timeout: 5000 });
  await settle("at rest, the <video>", false);

  // Memory bound: a 40 MB budget holds while scrubbing.
  await setCheck("settings-scrub-cache", true);
  await page.evaluate(() => (globalThis as unknown as { __uncutScrub: { setBudget: (b: number) => void } }).__uncutScrub.setBudget(40 * 2 ** 20));
  let peak = 0;
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press(i < 20 ? "ArrowRight" : "ArrowLeft");
    await settle(`budget step ${i}`);
    peak = Math.max(peak, (await cacheStats()).bytes);
  }
  console.log(`# D221 40 MB budget: peak ${(peak / 2 ** 20).toFixed(1)} MB`);
  assert.ok(peak <= 40 * 2 ** 20, `peak ${peak}`);
  assert.ok(peak > 0);
  await page.screenshot({ path: out("preview") });
});
