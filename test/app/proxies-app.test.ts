// D212: preview proxies on the packaged app (issue #12), run invisibly and muted.
// - A synthetic 4K HEVC long-GOP clip (keyframe every 2 s) on the main track: the server makes its
//   proxy in the background after the project opens; the Media tile shows "Proxy NN%", then "Proxy".
// - Scrub latency: 20 random frames clicked on the ruler, timed from the pointer to the first
//   presented video frame that is the one the preview settles on (requestVideoFrameCallback); median
//   with "Use proxies for preview" off (the original) and on (the proxy), both printed.
// - The setting swaps the clip's <video> between /media/file and /media/proxy.
// Screenshots: test-output/proxies-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const hasHevc = hasFfmpeg && /\bhevc_videotoolbox\b/.test(execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }));
const skip = existsSync(APP)
  ? hasHevc
    ? false
    : "needs ffmpeg with hevc_videotoolbox to make 4K test footage"
  : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 30;
const SECONDS = 20;
let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const out = (name: string) => resolve("test-output", `proxies-${name}.png`);
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const key = async (k: Parameters<Page["keyboard"]["press"]>[0], mod?: "Meta") => {
  if (mod) await page.keyboard.down(mod);
  await page.keyboard.press(k);
  if (mod) await page.keyboard.up(mod);
};
const src = () => page.$eval("video[data-item=c1]", (el) => (el as HTMLVideoElement).src);

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-proxies-app-")));
  dir = join(root, "Proxies.uncut");
  mkdirSync(join(dir, "media"), { recursive: true });
  // 4K HEVC, 30 fps, a keyframe every 60 frames, like phone and drone footage (heavier GOP than the DJI's 0.5 s).
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=3840x2160:rate=${FPS}`,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    String(SECONDS),
    "-c:v",
    "hevc_videotoolbox",
    "-b:v",
    "40M",
    "-g",
    "60",
    "-tag:v",
    "hvc1",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    join(root, "Drone4K.mp4"),
  ]);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Proxies",
      canvas: { width: 1920, height: 1080, fps: FPS },
      textLooks: 1,
      media: [
        {
          id: "m-drone",
          kind: "video",
          name: "Drone4K.mp4",
          path: join(root, "Drone4K.mp4"),
          probe: { frames: SECONDS * FPS, fps: FPS, width: 3840, height: 2160, hasAudio: true },
        },
      ],
      tracks: [
        { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "c1", type: "clip", media: "m-drone", in: 0, duration: SECONDS * FPS }] },
      ],
    }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** A seeded random number generator (the same 20 frames every run). */
const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

/**
 * Clicks the ruler at `frame` and times it: from the pointer to the first frame the clip's
 * <video> presents that is the frame it settles on (ms), and whether that is the playhead's frame.
 */
async function timedSeek(frame: number) {
  const ruler = (await (await page.$("[data-testid=ruler]"))!.boundingBox())!;
  const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
  const scroll = await page.$eval(".bottom-body", (el) => el.scrollLeft);
  await page.evaluate(() => {
    const w = window as unknown as { seekLog: { t0: number; frames: Array<{ at: number; time: number }> } };
    w.seekLog = { t0: 0, frames: [] };
    const v = document.querySelector<HTMLVideoElement>("video[data-item=c1]")!;
    document.addEventListener(
      "pointerdown",
      () => {
        w.seekLog.t0 = performance.now();
        const watch = () => v.requestVideoFrameCallback((now, meta) => (w.seekLog.frames.push({ at: now, time: meta.mediaTime }), watch()));
        watch();
      },
      { capture: true, once: true },
    );
  });
  await page.mouse.click(ruler.x + 0.5 + frame * ppf - scroll, ruler.y + ruler.height / 2);
  await page.waitForFunction(
    () => {
      const v = document.querySelector<HTMLVideoElement>("video[data-item=c1]");
      return !!v && !v.seeking && v.readyState >= 2;
    },
    { timeout: 15000 },
  );
  await new Promise((r) => setTimeout(r, 250));
  return page.evaluate((fps) => {
    const w = window as unknown as { seekLog: { t0: number; frames: Array<{ at: number; time: number }> } };
    const v = document.querySelector<HTMLVideoElement>("video[data-item=c1]")!;
    const playhead = Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame);
    const last = w.seekLog.frames.at(-1);
    const shown = last ? Math.round(last.time * fps) : Math.round(v.currentTime * fps);
    const first = w.seekLog.frames.find((f) => Math.round(f.time * fps) === shown);
    return { playhead, shown, ms: first ? first.at - w.seekLog.t0 : NaN };
  }, FPS);
}

async function scrubMedian(label: string) {
  const ruler = (await (await page.$("[data-testid=ruler]"))!.boundingBox())!;
  const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
  const visible = Math.min(SECONDS * FPS - 2, Math.floor((ruler.width - 4) / ppf));
  const next = rng(212);
  const times: Array<number> = [];
  for (let i = 0; i < 20; i++) {
    const f = 1 + Math.floor(next() * visible);
    const r = await timedSeek(f);
    assert.ok(Math.abs(r.shown - r.playhead) <= 1, `${label}: the video shows frame ${r.shown} for the playhead's ${r.playhead}`);
    assert.ok(Number.isFinite(r.ms), `${label}: no frame presented for ${f}`);
    times.push(r.ms);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const median = (sorted[9]! + sorted[10]!) / 2;
  console.log(
    `# D212 scrub ${label}: median ${median.toFixed(1)} ms, p90 ${sorted[17]!.toFixed(1)} ms, max ${sorted[19]!.toFixed(1)} ms (${times.map((t) => t.toFixed(0)).join(" ")})`,
  );
  return median;
}

async function setProxies(on: boolean) {
  await key("Comma", "Meta");
  await waitFor("[data-testid=settings]");
  await page.click("[data-testid=settings-nav-app]");
  await waitFor("[data-testid=settings-proxies]");
  const checked = await page.$eval("[data-testid=settings-proxies]", (el) => (el as HTMLInputElement).checked);
  if (checked !== on) await page.click("[data-testid=settings-proxies]");
  // This measures <video> seeks (D212's baseline); the scrub frame cache (D221) is measured in scrub-cache-app.
  if (await page.$eval("[data-testid=settings-scrub-cache]", (el) => (el as HTMLInputElement).checked)) await page.click("[data-testid=settings-scrub-cache]");
  await page.waitForFunction((want) => (localStorage.getItem("uncut.preview.proxies") !== "off") === want, {}, on);
  if (on) await page.screenshot({ path: out("settings") });
  await page.click("[data-testid=settings-close]");
  await page.waitForFunction(
    (want) => document.querySelector<HTMLVideoElement>("video[data-item=c1]")?.src.includes(want ? "/media/proxy/" : "/media/file/"),
    { timeout: 10000 },
    on,
  );
  await page.waitForFunction(() => (document.querySelector<HTMLVideoElement>("video[data-item=c1]")?.readyState ?? 0) >= 2, { timeout: 15000 });
}

test("D212: 4K footage gets a proxy in the background; the preview scrubs it; the setting swaps it for the original", { skip, timeout: 400000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_PROXIES: "on" } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  await page.click("[data-testid=bottom-timeline]");
  await page.$eval("[data-testid=rail-media]", (el) => (el as HTMLElement).click());
  // The tile's badge while the proxy is made, then when it's there.
  await waitFor("[data-testid=media-tile][data-id=m-drone] [data-testid=media-proxy]", 30000);
  const progress = await page
    .waitForFunction(() => /^Proxy \d+%$/.test(document.querySelector("[data-testid=media-proxy][data-phase=running]")?.textContent ?? ""), { timeout: 20000 })
    .then(() => page.$eval("[data-testid=media-proxy]", (el) => el.textContent))
    .catch(() => undefined);
  if (progress) await page.screenshot({ path: out("making") });
  await waitFor("[data-testid=media-tile][data-id=m-drone] [data-testid=media-proxy][data-phase=done]", 180000);
  assert.equal(await page.$eval("[data-testid=media-proxy]", (el) => el.textContent), "Proxy");
  await page.waitForFunction(() => document.querySelector<HTMLVideoElement>("video[data-item=c1]")?.src.includes("/media/proxy/"), { timeout: 10000 });
  await page.screenshot({ path: out("tile") });
  console.log(`# D212 proxy badge while made: ${progress ?? "(made before the first look)"}`);

  await setProxies(false);
  assert.match(await src(), /\/media\/file\/m-drone/);
  const original = await scrubMedian("original 4K HEVC");
  await setProxies(true);
  assert.match(await src(), /\/media\/proxy\/m-drone/);
  const proxy = await scrubMedian("proxy 1280 H.264");
  await page.screenshot({ path: out("preview") });
  console.log(`# D212 scrub median: original ${original.toFixed(1)} ms, proxy ${proxy.toFixed(1)} ms`);
  assert.ok(proxy <= original * 1.25 + 5, `the proxy scrubs no slower (${proxy.toFixed(1)} vs ${original.toFixed(1)} ms)`);
});
