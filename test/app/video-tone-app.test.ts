// D222 (issue #56): a clip looks the same with and without a no-op effect, and both show the file's
// values (what the export holds), on the packaged app.
// Footage: a grey ramp (16 bars, levels 0, 17, ..., 255) in H.264, untagged, BT.709- and
// BT.601-tagged, from 320×180 to HD: macOS lifts those of 360 lines and up (D222), the rest not. Each is on the timeline twice: plain, and with Pixelate at size 2 (a
// no-op on flat bars that still goes through the effects canvas, D136).
// - Plain (the <video> at rest) vs with the effect: every bar within 2 levels on screen.
// - Plain vs the file's own levels (ffmpeg's decode, what the export holds): within 3.
// - The scrub canvas (kept up) vs the file's levels: within 3.
// Levels are read from preview screenshots (sRGB profile pinned, D216). Screenshots test-output/tone-*.png.
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
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the grey ramps") : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 30;
const CLIP = 30;
const BARS = 16;
// Tags written into the stream (setparams; x264's -color_trc output options alone don't reach the SPS here).
const TAGS_709 = ",setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709";
const TAGS_601 = ",setparams=color_primaries=smpte170m:color_trc=smpte170m:colorspace=smpte170m";
// macOS lifts a <video> by its height (D222, measured): 360 lines and up, whatever the tags; below, not even tagged BT.709.
const CLIPS = [
  { id: "s180", name: "untagged 320×180 (not lifted)", w: 320, h: 180, tags: "" },
  { id: "s352", name: "untagged 640×352 (not lifted)", w: 640, h: 352, tags: "" },
  { id: "t709s180", name: "BT.709-tagged 320×180 (not lifted)", w: 320, h: 180, tags: TAGS_709 },
  { id: "sd", name: "untagged SD", w: 640, h: 360, tags: "" },
  { id: "hd", name: "untagged HD", w: 1280, h: 720, tags: "" },
  { id: "t709sd", name: "BT.709-tagged SD", w: 640, h: 360, tags: TAGS_709 },
  { id: "t709hd", name: "BT.709-tagged HD", w: 1280, h: 720, tags: TAGS_709 },
  { id: "t601hd", name: "BT.601-tagged HD", w: 1280, h: 720, tags: TAGS_601 },
] as const;
const NOOP = [{ module: "effect.pixelate", params: { size: 2 } }];

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", `tone-${name}.png`);
const file = (id: string) => join(root, `Ramp-${id}.mp4`);

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-tone-app-")));
  dir = join(root, "Tone.uncut");
  mkdirSync(join(dir, "media"), { recursive: true });
  for (const c of CLIPS) {
    // Grey is the same under either matrix, so only the transfer (and range) can move it.
    const ramp = `color=black:s=${c.w}x${c.h}:r=${FPS}:d=1,format=rgb24,geq=r='floor(X*${BARS}/W)*17':g='floor(X*${BARS}/W)*17':b='floor(X*${BARS}/W)*17',format=yuv420p${c.tags}`;
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", ramp, "-c:v", "libx264", "-crf", "4", "-pix_fmt", "yuv420p", file(c.id)]);
    const trc = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=color_transfer", "-of", "csv=p=0", file(c.id)], { encoding: "utf8" }).trim();
    assert.equal(trc, c.tags === TAGS_709 ? "bt709" : c.tags === TAGS_601 ? "smpte170m" : "unknown", `${c.name}: its transfer tag`);
  }
  const items = CLIPS.flatMap((c) => [
    { id: `${c.id}-plain`, type: "clip", media: `m-${c.id}`, in: 0, duration: CLIP },
    { id: `${c.id}-fx`, type: "clip", media: `m-${c.id}`, in: 0, duration: CLIP, effects: NOOP },
  ]);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Tone",
      canvas: { width: 1280, height: 720, fps: FPS, background: "#000000" },
      media: CLIPS.map((c) => ({ id: `m-${c.id}`, kind: "video", name: `Ramp-${c.id}.mp4`, path: file(c.id), probe: { frames: FPS, fps: FPS, width: c.w, height: c.h, hasAudio: false } })),
      tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items }],
    }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** The mean grey of each bar's middle (a patch in its centre) of a picture, 0–255. */
function barLevels(png: string): Array<number> {
  const [w, h] = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", png], { encoding: "utf8" }).trim().split(",").map(Number) as [number, number];
  const px = execFileSync("ffmpeg", ["-v", "error", "-i", png, "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "-"], { maxBuffer: 256 * 1024 * 1024 });
  const levels: Array<number> = [];
  for (let i = 0; i < BARS; i++) {
    const cx = Math.round(((i + 0.5) * w) / BARS);
    const half = Math.max(1, Math.round(w / BARS / 6));
    let sum = 0;
    let n = 0;
    for (let y = Math.round(h * 0.35); y < Math.round(h * 0.65); y++)
      for (let x = cx - half; x <= cx + half; x++) {
        sum += px[y * w + x]!;
        n++;
      }
    levels.push(sum / n);
  }
  return levels;
}

/** The file's own bar levels: ffmpeg's decode of its first frame to RGB (what the export reads). */
function fileLevels(id: string): Array<number> {
  const png = join(root, `${id}-decoded.png`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file(id), "-frames:v", "1", "-vf", "format=rgb24", png]);
  return barLevels(png);
}

async function shot(name: string) {
  const el = (await page.$("[data-testid=preview-frame]"))!;
  await el.screenshot({ path: out(name) });
  return barLevels(out(name));
}

/** Seek by keyboard (Home, ⇧→ for seconds, → for frames). */
async function goTo(frame: number) {
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(frame / FPS); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < frame % FPS; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, { timeout: 10000 }, frame);
}

const keep = (on: boolean) => page.evaluate((k) => (globalThis as unknown as { __uncutScrub: { keep: (on: boolean) => void } }).__uncutScrub.keep(k), on);
const worst = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => Math.max(...a.map((x, i) => Math.abs(x - b[i]!)));
const fmt = (l: ReadonlyArray<number>) => l.map((x) => x.toFixed(0)).join(" ");

test("D222: a no-op effect changes nothing visible, and the preview shows the file's levels (untagged SD/HD, tagged, lifted or not)", { skip, timeout: 300000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click("[data-testid=bottom-timeline]");
  await page.waitForFunction(() => !!(globalThis as unknown as { __uncutScrub?: unknown }).__uncutScrub, { timeout: 10000 });
  const problems: Array<string> = [];
  for (const [k, c] of CLIPS.entries()) {
    const expected = fileLevels(c.id);
    const plainId = `${c.id}-plain`;
    const fxId = `${c.id}-fx`;

    // The plain clip at rest: its <video> (the scrub canvas hands back once the <video> is at the frame).
    await keep(false);
    await goTo(2 * k * CLIP + 15);
    // Its colours are known from the file (the scrub cache's index read its tags).
    await page.waitForFunction((id) => (globalThis as unknown as { __uncutScrub: { stats: () => { sources: Array<{ url: string; state: string }> } } }).__uncutScrub.stats().sources.some((s) => s.url.includes(`m-${id}`) && s.state === "ready"), { timeout: 10000 }, c.id);
    await page.waitForFunction(
      (id) => {
        const v = document.querySelector<HTMLVideoElement>(`video[data-item="${id}"]`);
        const canvas = document.querySelector<HTMLCanvasElement>(`canvas[data-scrub="${id}"]`);
        return !!v && !v.seeking && v.readyState >= 2 && v.style.visibility !== "hidden" && (!canvas || canvas.style.visibility === "hidden");
      },
      { timeout: 10000 },
      plainId,
    );
    await sleep(400);
    const filter = await page.$eval(`video[data-item="${plainId}"]`, (v) => getComputedStyle(v).filter);
    const plain = await shot(`${c.id}-video`);

    // The same clip's scrub canvas, kept up at the same frame.
    await keep(true);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction((id) => document.querySelector<HTMLCanvasElement>(`canvas[data-scrub="${id}"]`)?.style.visibility === "", { timeout: 10000 }, plainId);
    await sleep(400);
    const canvas = await shot(`${c.id}-scrub`);
    await keep(false);

    // With the no-op effect: its effects canvas.
    await goTo((2 * k + 1) * CLIP + 15);
    await page.waitForFunction(
      (id) => {
        const v = document.querySelector<HTMLVideoElement>(`video[data-item="${id}"]`);
        const fx = document.querySelector<HTMLCanvasElement>(`canvas[data-fx="${id}"]`);
        return !!v && !v.seeking && v.readyState >= 2 && !!fx && fx.style.visibility === "";
      },
      { timeout: 10000 },
      fxId,
    );
    await sleep(400);
    const effect = await shot(`${c.id}-fx`);

    console.log(`# D222 ${c.name} (<video> filter ${filter}):\n#   file   ${fmt(expected)}\n#   video  ${fmt(plain)}\n#   scrub  ${fmt(canvas)}\n#   effect ${fmt(effect)}\n#   worst: effect vs video ${worst(effect, plain).toFixed(1)}, video vs file ${worst(plain, expected).toFixed(1)}, scrub vs file ${worst(canvas, expected).toFixed(1)}`);
    if (worst(effect, plain) > 2) problems.push(`${c.name}: with the no-op effect vs without, ${worst(effect, plain).toFixed(1)} levels apart`);
    if (worst(plain, expected) > 3) problems.push(`${c.name}: the <video> vs the file's levels, ${worst(plain, expected).toFixed(1)} apart`);
    if (worst(canvas, expected) > 3) problems.push(`${c.name}: the scrub canvas vs the file's levels, ${worst(canvas, expected).toFixed(1)} apart`);
  }
  assert.deepEqual(problems, []);
});
