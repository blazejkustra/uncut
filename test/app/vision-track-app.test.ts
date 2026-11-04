import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { keyAt, type Item, type Project } from "../../packages/core/src/index.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { viewerPrefs } from "../helpers/viewer-prefs.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { NO_REAL_GPU, check } from "../helpers/capabilities.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const HELPER = resolve("dist/mac-arm64/Uncut.app/Contents/Resources/bin/uncut-vision");
const TRAIN = join(homedir(), "Movies/uncut-promo/_footage/steam-dorset.mp4");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(APP) || !existsSync(HELPER) ? `packaged app not built: run pnpm dist to create ${APP}` : hasFfmpeg ? false : "needs ffmpeg";

const W = 1280;
const H = 720;
const FPS = 30;
const SECONDS = 4;
let root = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);

const text = (over: Partial<Item>): Item => ({ id: "title", type: "text", text: "FOLLOW", start: 0, duration: SECONDS * FPS, style: { size: 60, color: "#ffffff" }, ...over } as Item);

function ballProject(media: string): Project {
  return {
    format: "uncut/0",
    name: "Track",
    canvas: { width: W, height: H, fps: FPS, background: "#000000" },
    media: [{ id: "m-ball", kind: "video", name: "Ball.mov", path: media, probe: { frames: SECONDS * FPS, fps: FPS, width: W, height: H, hasAudio: false } }],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [text({ transform: { x: 200, y: 120 } })] },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "ball", type: "clip", media: "m-ball", in: 0, duration: SECONDS * FPS } as Item] },
    ],
  };
}

function trainProject(): Project {
  return {
    format: "uncut/0",
    name: "Train",
    canvas: { width: 1920, height: 1080, fps: FPS, background: "#000000" },
    media: [{ id: "m-train", kind: "video", name: "steam-dorset.mp4", path: TRAIN, probe: { frames: 980, fps: 29.97, width: 1920, height: 1080, hasAudio: false } }],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [{ ...text({ duration: 660, text: "LOCOMOTIVE", style: { size: 72, color: "#ffffff", weight: 800 } }), transform: { x: 1040, y: 280 } } as Item] },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "train", type: "clip", media: "m-train", in: 300, duration: 660 } as Item] },
    ],
  };
}

const makeBall = (path: string) => {
  const ball = `color=c=0xe04020:s=240x240:r=${FPS}:d=${SECONDS},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-120,Y-120),112),255,0)'`;
  execFileSync("ffmpeg", [
    ...["-v", "error", "-threads", "4", "-f", "lavfi", "-i", `color=c=0x6080a0:s=${W}x${H}:r=${FPS}:d=${SECONDS}`, "-f", "lavfi", "-i", ball],
    ...["-filter_complex", "[0][1]overlay=x='150+t*150':y=300", "-c:v", "libx264", "-crf", "8", "-g", "10", "-pix_fmt", "yuv420p", "-threads", "4", "-y", path],
  ]);
};

const onDisk = (dir: string): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) =>
  page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r, { timeout: 30000 }, n);

async function goTo(frame: number) {
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(frame / FPS); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < frame % FPS; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, frame);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => v.style.opacity === "0" || (!v.seeking && v.readyState >= 2)), { timeout: 15000 });
  await sleep(400);
}

/** Drags a box on the preview, in canvas px. */
async function drawBox(box: { x: number; y: number; w: number; h: number }, canvas: { width: number; height: number }) {
  const frame = await (await page.$("[data-testid=preview-frame]"))!.boundingBox();
  const sx = frame!.width / canvas.width;
  const sy = frame!.height / canvas.height;
  await page.mouse.move(frame!.x + box.x * sx, frame!.y + box.y * sy);
  await page.mouse.down();
  await page.mouse.move(frame!.x + (box.x + box.w / 2) * sx, frame!.y + (box.y + box.h / 2) * sy, { steps: 4 });
  await page.mouse.move(frame!.x + (box.x + box.w) * sx, frame!.y + (box.y + box.h) * sy, { steps: 4 });
  await page.mouse.up();
}

async function openProject(dir: string, saveAs: string) {
  await app?.close();
  app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") },
  });
  page = app.page;
  await waitForWelcome(page);
  await viewerPrefs(page, { gpu: false });
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
}

async function selectTitle() {
  await page.waitForSelector("[data-testid=timeline-item][data-item=title]");
  await page.click("[data-testid=timeline-item][data-item=title]");
  await page.waitForSelector("[data-testid=insp-track-run]:not([disabled])");
}

const frameShot = (name: string) => page.$("[data-testid=preview-frame]").then((el) => el!.screenshot({ path: out(name) }));
const rgb = (file: string, w: number, h: number) =>
  execFileSync("ffmpeg", ["-v", "error", "-threads", "4", "-i", file, "-vf", `scale=${w}:${h}:flags=area,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: 64 << 20 });
function compare(a: string, b: string) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-threads", "4", "-i", a, "-i", b, "-lavfi", "[0]scale=640:360,format=gray[a];[1]scale=640:360,format=gray[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" });
  const pa = rgb(a, 64, 36);
  const pb = rgb(b, 64, 36);
  let d = 0;
  for (let i = 0; i < pa.length; i++) d += Math.abs(pa[i]! - pb[i]!);
  return { ssim: Number(/All:([\d.]+)/.exec(r.stderr)![1]), colour: d / pa.length };
}

/** The drawn text's left edge in the preview at the frame shown (canvas px). */
const textLeft = () => page.$eval(".pv-text[data-item=title]", (el) => (el as HTMLElement).offsetLeft);

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-track-app-")));
  mkdirSync(join(root, "media"), { recursive: true });
  mkdirSync(join(root, "out"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("D329: Track in the Inspector: a box on the preview ends in keys, one Undo, and preview and export agree", { skip, timeout: 600000 }, async () => {
  const media = join(root, "media", "Ball.mov");
  makeBall(media);
  const dir = writeProject(root, "Track", ballProject(media));
  const saveAs = join(root, "out", "Track.mp4");
  await openProject(dir, saveAs);
  await selectTitle();
  await goTo(0);
  await selectTitle();

  // Off the target: picking and then Esc changes nothing.
  const start = await revision();
  await page.click("[data-testid=insp-track-run]");
  await page.waitForSelector("[data-testid=track-catch]");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=track-catch]"));
  assert.equal(await revision(), start);

  await page.click("[data-testid=insp-track-run]");
  await page.waitForSelector("[data-testid=track-catch]");
  await drawBox({ x: 150, y: 300, w: 240, h: 240 }, { width: W, height: H });
  await waitRevision(start + 1);
  const keys = onDisk(dir).tracks[0]!.items[0]!.keys!;
  assert.ok(keys.length >= 2 && keys.length <= 30, `few keys: ${keys.length}`);
  assert.equal(keys[0]!.x, 200);
  assert.ok(Math.abs(keyAt(keys, "x", 90, FPS)! - (200 + 3 * 150)) < 16, `follows the ball: x ${keyAt(keys, "x", 90, FPS)}`);
  assert.equal(onDisk(dir).tracks[0]!.items[0]!.transform?.x, 200);

  await goTo(60);
  const drawn = await textLeft();
  assert.ok(Math.abs(drawn - (200 + 2 * 150)) < 16, `the preview draws it there: ${drawn}`);
  await selectTitle();
  assert.ok((await page.$("[data-testid=insp-keys]")) !== null, "a text's keys are in the Inspector");
  assert.ok(Math.abs(Number(await page.$eval("[data-testid=insp-x]", (el) => (el as HTMLInputElement).value)) - drawn) <= 1, "the Inspector's X is where it's drawn");

  // Export (Standard, loudness off) and compare at three times.
  const preview = new Map<number, string>();
  for (const frame of [15, 60, 105]) {
    const name = `track-ball-${frame}.png`;
    await page.click("[data-testid=timeline]");
    await page.keyboard.press("Escape");
    await goTo(frame);
    await frameShot(name);
    preview.set(frame, out(name));
  }
  await page.keyboard.down("Meta");
  await page.keyboard.press("e");
  await page.keyboard.up("Meta");
  await page.waitForSelector("[data-testid=export-form]");
  await page.click("[data-testid=quality-standard]");
  await page.click("[data-testid=loudness-off]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Track.mp4");
  await page.click("[data-testid=export-start]");
  await page.waitForSelector("[data-testid=export-job]");
  let phase = "";
  for (let i = 0; i < 3000 && phase !== "done" && phase !== "failed"; i++) {
    phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
    await sleep(100);
  }
  assert.equal(phase, "done", await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? ""));
  await page.keyboard.press("Escape");
  const low: Array<string> = [];
  for (const [frame, file] of preview) {
    const exported = out(`track-ball-${frame}-export.png`);
    execFileSync("ffmpeg", ["-v", "error", "-threads", "4", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", "-update", "1", exported]);
    const r = compare(file, exported);
    console.log(`  frame ${frame}: SSIM ${r.ssim.toFixed(4)} Δ${r.colour.toFixed(2)}`);
    if (!(r.ssim >= 0.96) || !(r.colour <= 4)) low.push(`frame ${frame}: SSIM ${r.ssim}, colour Δ ${r.colour.toFixed(2)}`);
  }
  check(NO_REAL_GPU, low.length === 0, `preview vs export: ${low.join("; ")}`);

  // One Undo takes the whole track back; Remove track is one edit too.
  const tracked = await revision();
  await page.click("[data-testid=timeline]");
  await page.keyboard.down("Meta");
  await page.keyboard.press("z");
  await page.keyboard.up("Meta");
  await waitRevision(tracked + 1);
  assert.equal(onDisk(dir).tracks[0]!.items[0]!.keys, undefined);
  await page.keyboard.down("Meta");
  await page.keyboard.down("Shift");
  await page.keyboard.press("z");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
  await waitRevision(tracked + 2);
  await selectTitle();
  await page.click("[data-testid=insp-track-remove]");
  await waitRevision(tracked + 3);
  assert.equal(onDisk(dir).tracks[0]!.items[0]!.keys, undefined);
  await app!.close();
  app = undefined;
});

test("D329: a real train: progress on the clip, Cancel, then a text following the locomotive", { skip: skip || (!existsSync(TRAIN) && "the train footage isn't on this Mac"), timeout: 600000 }, async () => {
  const dir = writeProject(root, "Train", trainProject());
  await openProject(dir, join(root, "out", "Train.mp4"));
  await selectTitle();
  await goTo(0);
  await selectTitle();
  const canvas = { width: 1920, height: 1080 };
  const LOCO = { x: 1160, y: 380, w: 220, h: 180 };

  const start = await revision();
  await page.click("[data-testid=insp-track-run]");
  await page.waitForSelector("[data-testid=track-catch]");
  await drawBox(LOCO, canvas);
  await page.waitForSelector("[data-testid=track-progress]", { timeout: 20000 });
  await page.waitForFunction(() => /Tracking \d+%/.test(document.querySelector("[data-testid=track-progress]")?.textContent ?? ""), { timeout: 20000, polling: 30 });
  await frameShot("track-progress.png");
  await (await page.$("[data-testid=insp-sec-track]"))!.screenshot({ path: out("track-inspector-progress.png") });
  assert.ok((await page.$("[data-testid=insp-track-status]")) !== null);
  await page.click("[data-testid=insp-track-cancel]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=track-progress]"), { timeout: 20000 });
  assert.equal(await revision(), start, "a cancel changes nothing");

  await page.click("[data-testid=insp-track-run]");
  await page.waitForSelector("[data-testid=track-catch]");
  await drawBox(LOCO, canvas);
  await waitRevision(start + 1);
  const keys = onDisk(dir).tracks[0]!.items[0]!.keys!;
  console.log(`  ${keys.length} keys over 660 frames; last at frame ${keys.at(-1)!.frame}`);
  assert.ok(keys.length < 120, `thinned: ${keys.length} keys`);
  const note = await page.$eval("[data-testid=insp-track-note]", (el) => el.textContent ?? "").catch(() => "");
  console.log(`  note: ${note || "none"}`);
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Escape");
  for (const frame of [0, 120, 300]) {
    await goTo(frame);
    await frameShot(`track-train-${frame}.png`);
  }
  await selectTitle();
  await (await page.$("[data-testid=insp-sec-track]"))!.screenshot({ path: out("track-inspector.png") });
});
