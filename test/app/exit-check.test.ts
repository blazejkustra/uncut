// Phase 4 exit check: "you can edit a real short promo by hand, without the agent". The packaged
// app, driven only through its UI with real mouse and keyboard input (no agent, no writes to
// project.json), makes a 14 s promo from the user's DJI clip (4K 59.94 fps HEVC, no sound) on a
// 1080p 30 fps canvas:
// - a new project from the welcome form; the clip imported by reference from the Media tab and
//   added to the main track, then cut down to three segments from different parts of the clip
//   with split (S) and delete (⌫), one ⌘Z / ⇧⌘Z, and a trim by dragging an edge;
// - a title over the opening (a Text preset switched to the Title style in the Inspector, recoloured,
//   rising in); an end card after the footage (a "Thanks for watching" text, then a gradient
//   background from the Elements tab, which spans the selected text);
// - a music bed (an ffmpeg-made chord) imported from the Audio tab, cut to the video's length
//   with a split, faded in and out and turned down;
// - exported with ⌘E (Standard) into a folder picked through the save panel.
// Then: ffprobe (size, fps, frames = the timeline, AAC, BT.709 tags), SSIM of exported frames
// against preview screenshots at the same frames, loudness and the fades in the sound, the
// footage untouched, no temp folders or ffmpeg processes left, and the project reopened from
// Recents after a restart showing the same timeline. Screenshots: test-output/exit-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, type LaunchedApp } from "../helpers/app.ts";
import { FOOTAGE, skipDemo } from "../helpers/demo.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(APP) ? `packaged app not built: run pnpm dist to create ${APP}` : !hasFfmpeg ? "needs ffmpeg to make the music and check the export" : skipDemo;

const FPS = 30;
const SEGMENT = 4 * FPS;
let root = "";
const apps = new Set<LaunchedApp>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", `exit-${name}`);

type Saved = { id: string; type: string; start?: number; duration: number; in?: number; media?: string; [k: string]: unknown };
type SavedTrack = { id: string; kind: string; role?: string; items: Array<Saved> };
type SavedProject = { name: string; canvas: { width: number; height: number; fps: number }; media: Array<{ id: string; path: string; probe: Record<string, unknown> }>; tracks: Array<SavedTrack> };

/** The UI driver for one app window. */
function driver(page: Page) {
  const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
  const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
  /** Wait until the saved revision passes `after`; returns the new one. */
  const savedAfter = async (after: number) => {
    // The title follows the snapshot the window shows, so once it's past `after` the edit has landed.
    await page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1] ?? -1) > r, { timeout: 15000 }, after);
    return revision();
  };
  const frameOf = () => page.$eval("[data-testid=preview-frame]", (el) => Number((el as HTMLElement).dataset.frame));
  const itemSel = (id: string) => `[data-testid=timeline-item][data-item="${id}"]`;
  /** The timeline as drawn: each track's items with their start and length. */
  type Drawn = Record<string, Array<{ id: string | undefined; start: number; duration: number }>>;
  const timeline = (): Promise<Drawn> =>
    page.$$eval("[data-testid=lane]", (lanes) =>
      Object.fromEntries(
        lanes.map((lane) => [
          (lane as HTMLElement).dataset.track,
          [...lane.querySelectorAll<HTMLElement>("[data-testid=timeline-item]")].map((e) => ({ id: e.dataset.item, start: Number(e.dataset.start), duration: Number(e.dataset.duration) })).sort((a, b) => a.start - b.start),
        ]),
      ),
    );
  const mainIds = async () => ((await timeline()).main ?? []).map((i) => i.id!);
  const meta = async (key: Parameters<Page["keyboard"]["press"]>[0], shift = false) => {
    await page.keyboard.down("Meta");
    if (shift) await page.keyboard.down("Shift");
    await page.keyboard.press(key);
    if (shift) await page.keyboard.up("Shift");
    await page.keyboard.up("Meta");
  };
  const selectAll = async () => {
    await page.keyboard.down("Meta");
    await page.keyboard.press("KeyA", { commands: ["SelectAll"] });
    await page.keyboard.up("Meta");
  };
  /** Put the playhead on `frame` with the keyboard: ⇧← / ⇧→ for whole seconds, ← / → for frames. */
  const goTo = async (frame: number) => {
    const now = await frameOf();
    const d = frame - now;
    const key = d > 0 ? "ArrowRight" : "ArrowLeft";
    if (Math.abs(d) >= FPS) {
      await page.keyboard.down("Shift");
      for (let i = 0; i < Math.floor(Math.abs(d) / FPS); i++) await page.keyboard.press(key);
      await page.keyboard.up("Shift");
    }
    for (let i = 0; i < Math.abs(d) % FPS; i++) await page.keyboard.press(key);
    await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, { timeout: 10000 }, frame);
  };
  /** Wait for the preview's videos to show the playhead's frame. */
  const settle = async () => {
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => v.style.opacity === "0" || (!v.seeking && v.readyState >= 2)), { timeout: 20000 });
    // Then two animation frames, so the seeked frame has been painted.
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  };
  const box = async (selector: string) => {
    const b = await (await page.$(selector))?.boundingBox();
    assert.ok(b, `no box for ${selector}`);
    return b;
  };
  /** Click the middle of a timeline item (selects it). */
  const select = async (id: string) => {
    const b = await box(itemSel(id));
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await waitFor(`[data-testid=inspector-item][data-item="${id}"]`);
  };
  /** Type a value into a number field and commit it with Enter. */
  const setField = async (testId: string, value: string) => {
    await page.click(`[data-testid=${testId}]`, { clickCount: 3 });
    await page.keyboard.type(value);
    await page.keyboard.press("Enter");
  };
  return { waitFor, revision, savedAfter, frameOf, itemSel, timeline, mainIds, meta, selectAll, goTo, settle, box, select, setField };
}

/** SSIM of two images at 480×270 grey (optionally after a light blur). 1 means identical. */
const ssim = (a: string, b: string, blur = false) => {
  const grey = `scale=480:270${blur ? ",gblur=sigma=1.5" : ""},format=gray`;
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", `[0]${grey}[a];[1]${grey}[b];[a][b]ssim`, "-f", "null", "-"], { encoding: "utf8" });
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
};
/** The box around the bright (text) pixels of an image, in canvas pixels (1920×1080). */
function brightBox(png: string) {
  const [w, h] = [1920, 1080];
  const px = execFileSync("ffmpeg", ["-v", "error", "-i", png, "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 16 << 20 });
  const b = { x0: w, x1: -1, y0: h, y1: -1 };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (px[y * w + x]! > 200) Object.assign(b, { x0: Math.min(b.x0, x), x1: Math.max(b.x1, x), y0: Math.min(b.y0, y), y1: Math.max(b.y1, y) });
  return b;
}
/** A box on the canvas, in canvas pixels (1920×1080). */
type Box = { x: number; y: number; w: number; h: number };
const canvasCrop = (box: Box) => `scale=1920:1080:flags=bicubic,crop=${box.w}:${box.h}:${box.x}:${box.y}`;
/** The pixels near the title's amber (#F5C26B, each channel within 45) in a box: their share and bounds (canvas px). */
function amberIn(png: string, box: Box) {
  const px = execFileSync("ffmpeg", ["-v", "error", "-i", png, "-vf", `${canvasCrop(box)},format=rgb24`, "-f", "rawvideo", "-"], { maxBuffer: 32 << 20 });
  const b = { share: 0, x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  let n = 0;
  for (let y = 0; y < box.h; y++)
    for (let x = 0; x < box.w; x++) {
      const i = (y * box.w + x) * 3;
      if (Math.abs(px[i]! - 0xf5) > 45 || Math.abs(px[i + 1]! - 0xc2) > 45 || Math.abs(px[i + 2]! - 0x6b) > 45) continue;
      n++;
      Object.assign(b, { x0: Math.min(b.x0, box.x + x), x1: Math.max(b.x1, box.x + x), y0: Math.min(b.y0, box.y + y), y1: Math.max(b.y1, box.y + y) });
    }
  b.share = n / (box.w * box.h);
  return b;
}
/** SSIM (grey, after a light blur: footage shows between the letters) of two images inside a canvas box. */
const ssimIn = (a: string, b: string, box: Box) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", `[0]${canvasCrop(box)},gblur=sigma=1.5,format=gray[a];[1]${canvasCrop(box)},gblur=sigma=1.5,format=gray[b];[a][b]ssim`, "-f", "null", "-"], { encoding: "utf8" });
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
};
/**
 * The title as the export drew it, against the preview: amber text covering its box in both, in
 * the same place (each edge within 2 canvas px), and alike inside the box.
 */
function titleProblems(previewPng: string, exportPng: string, box: Box, floor: number) {
  const [p, e] = [amberIn(previewPng, box), amberIn(exportPng, box)];
  const inBox = ssimIn(previewPng, exportPng, box);
  const problems: Array<string> = [];
  if (e.share < 0.12 || p.share < 0.12) problems.push(`amber text covers ${(e.share * 100).toFixed(1)} % of the title box in the export, ${(p.share * 100).toFixed(1)} % in the preview`);
  for (const k of ["x0", "x1", "y0", "y1"] as const) if (!(Math.abs(p[k] - e[k]) <= 2)) problems.push(`title ${k}: preview ${p[k]}, export ${e[k]}`);
  if (inBox < floor) problems.push(`SSIM in the title box ${inBox}`);
  return { problems, preview: p, exported: e, inBox };
}
/** The colour space the app's screenshots are in (export-app.test.ts): pure red is (255, 0, 0) in sRGB. */
async function screenshotSpace(page: Page): Promise<"srgb" | "p3"> {
  await page.evaluate(() => {
    const e = document.createElement("div");
    e.id = "red-probe";
    e.style.cssText = "position:fixed;left:0;top:0;width:40px;height:40px;background:#f00;z-index:99999";
    document.body.append(e);
  });
  const path = out("red-probe.png");
  await (await page.$("#red-probe"))!.screenshot({ path });
  await page.evaluate(() => document.getElementById("red-probe")!.remove());
  const [r, g] = [...execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vf", "crop=8:8:16:16,scale=1:1,format=rgb24", "-f", "rawvideo", "-"])];
  return r! > 245 && g! < 10 ? "srgb" : "p3";
}
/** A Display P3 screenshot as sRGB (what the export is), next to the original. */
function toSrgb(png: string) {
  const outPath = png.replace(/\.png$/, "-srgb.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", png, "-vf", "scale=out_color_matrix=bt709:out_range=pc,format=yuv444p,setparams=color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=pc,colorspace=primaries=bt709:trc=iec61966-2-1:space=bt709:range=pc:format=yuv444p,scale=in_color_matrix=bt709:in_range=pc,format=rgb24", outPath]);
  return outPath;
}
/** RMS level (dB) of the export's sound from `start` for `duration` seconds. */
function rmsDb(file: string, start: number, duration: number) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-map", "0:a", "-af", `atrim=start=${start}:duration=${duration},astats=measure_perchannel=none`, "-f", "null", "-"], { encoding: "utf8" });
  const m = /Overall[\s\S]*?RMS level dB:\s*(-?[\d.]+|-inf)/.exec(r.stderr);
  assert.ok(m, `no RMS for ${start}+${duration}: ${r.stderr.slice(-800)}`);
  return m[1] === "-inf" ? -Infinity : Number(m[1]);
}
/** Every process below `pid`, as "pid command". */
function descendants(pid: number) {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)!)
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3]! }));
  const found: Array<{ pid: number; comm: string }> = [];
  const walk = (p: number) => {
    for (const r of rows.filter((x) => x.ppid === p)) {
      found.push(r);
      walk(r.pid);
    }
  };
  walk(pid);
  return found;
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-exit-")));
  for (const d of ["projects", "out", "tmp", "music"]) mkdirSync(join(root, d));
  // A music bed: 20 s of an A minor chord with a slow swell, stereo AAC at 48 kHz.
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi",
    "-i", "aevalsrc=(0.2*sin(2*PI*220*t)+0.15*sin(2*PI*261.63*t)+0.15*sin(2*PI*329.63*t))*(0.85+0.15*sin(2*PI*0.5*t))|(0.2*sin(2*PI*220*t)+0.15*sin(2*PI*261.63*t)+0.15*sin(2*PI*329.63*t))*(0.85+0.15*sin(2*PI*0.5*t+1)):s=48000:d=20",
    "-c:a", "aac", "-b:a", "192k", join(root, "music", "Calm chords.m4a"),
  ]);
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("exit check: a 14 s promo from the DJI clip, made by hand and exported, matches its preview and reopens", { skip, timeout: 300000 }, async (t) => {
  const t0 = Date.now();
  const footageBefore = statSync(FOOTAGE);
  const music = join(root, "music", "Calm chords.m4a");
  const saveAs = join(root, "out", "Old town promo.mp4");
  const temp = join(root, "tmp");
  const env = { UNCUT_DATA_DIR: join(root, "data"), TMPDIR: temp, UNCUT_CLAUDE: FAKE };
  let app = await launchApp({ command: APP, env: { ...env, UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects"), [FOOTAGE], [music], saveAs]) } });
  apps.add(app);
  let page = app.page;
  let ui = driver(page);
  const fail = async (error: unknown) => {
    await page.screenshot({ path: out("failure.png") }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-3000)}` });
  };
  let dir = "";
  const onDisk = (): SavedProject => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  const saved = (id: string) => onDisk().tracks.flatMap((tr) => tr.items).find((i) => i.id === id);
  const mainOnDisk = () => onDisk().tracks.find((tr) => tr.role === "main")!.items;
  try {
    // ---- A new landscape project from the welcome form.
    await ui.waitFor("[data-testid=welcome]");
    await page.click("[data-testid=new-project]");
    await ui.waitFor("[data-testid=new-project-form]");
    await page.click("[data-testid=project-name]", { clickCount: 3 });
    await page.keyboard.type("Old town promo");
    await page.click("[data-preset=landscape]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await ui.waitFor("[data-testid=editor]");
    await page.click("[data-testid=tab-inspector]");
    dir = await page.$eval("[data-testid=project-title]", (el) => (el as HTMLElement).title);
    assert.equal(dir, join(root, "projects", "Old town promo.uncut"));
    assert.equal(await page.$eval("[data-testid=canvas-info]", (el) => el.textContent?.trim()), "1920×1080, 30 fps");

    // ---- Import the clip by reference (Media tab → Import…), then + puts it on main.
    await page.click("[data-testid=import]");
    await ui.waitFor("[data-testid=media-tile]", 30000);
    await page.waitForFunction(() => !document.querySelector("[data-testid=import-progress]"), { timeout: 30000 });
    // The DJI clip: 3840×2160 at 60000/1001 fps, 5:35.6, no sound.
    const src = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", FOOTAGE], { encoding: "utf8" }));
    const [num, den] = String(src.streams[0].r_frame_rate).split("/").map(Number);
    assert.equal(await page.$eval("[data-testid=tile-meta]", (el) => el.textContent), `${src.streams[0].width}×${src.streams[0].height}, ${Math.round((num! / den!) * 100) / 100} fps`);
    const media = onDisk().media[0]!;
    assert.equal(media.path, FOOTAGE, "referenced where it is, not copied");
    const clipFrames = media.probe.frames as number;
    assert.equal(clipFrames, Math.floor(Number(src.format.duration) * FPS), "its length in the canvas's frames");
    assert.ok(clipFrames > 190 * FPS, "long enough for the three segments");
    let rev = await ui.revision();
    await page.hover("[data-testid=media-tile]");
    await page.click("[data-testid=add-to-timeline]");
    rev = await ui.savedAfter(rev);
    const [first] = await ui.mainIds();
    assert.deepEqual(mainOnDisk(), [{ id: first, type: "clip", media: media.id, in: 0, duration: clipFrames }]);
    await page.click("[data-testid=timeline]");
    await ui.settle();
    await page.screenshot({ path: out("imported.png") });

    // ---- Cut it down to three 4 s segments: from 0:20, 1:32 and 3:02 in the clip.
    const split = async () => {
      const r = await ui.revision();
      await page.keyboard.press("s");
      rev = await ui.savedAfter(r);
    };
    const del = async () => {
      const r = await ui.revision();
      await page.keyboard.press("Backspace");
      rev = await ui.savedAfter(r);
    };
    // 0:00–0:20 goes: split at 0:20, select the part before, delete. The rest closes up.
    await ui.goTo(20 * FPS);
    await split();
    let ids = await ui.mainIds();
    assert.equal(ids.length, 2);
    await ui.select(ids[0]!);
    await del();
    ids = await ui.mainIds();
    assert.deepEqual(mainOnDisk().map((i) => [i.in, i.duration]), [[600, clipFrames - 600]]);
    // Keep 4 s, then cut away up to 1:32 (and again up to 3:02).
    for (const [keepEnd, sourceNext] of [[SEGMENT, 92 * FPS], [2 * SEGMENT, 182 * FPS]] as const) {
      await page.click("[data-testid=timeline]");
      await page.keyboard.press("Escape");
      await ui.goTo(keepEnd);
      await split();
      const cut = (await ui.mainIds()).at(-1)!;
      const cutIn = saved(cut)!.in!;
      await ui.goTo(keepEnd + (sourceNext - cutIn));
      await split();
      await ui.select(cut);
      await del();
    }
    // The tail after the third segment: split, and the selected part after the playhead goes.
    await page.keyboard.press("Escape");
    await ui.goTo(3 * SEGMENT);
    await split();
    const tail = (await ui.mainIds()).at(-1)!;
    assert.ok(await page.$eval(ui.itemSel(tail), (e) => e.classList.contains("selected")), "the part after the cut is selected");
    await del();
    // Undo puts the tail back; redo takes it away again.
    await page.click("[data-testid=timeline]");
    const r0 = await ui.revision();
    await ui.meta("KeyZ");
    rev = await ui.savedAfter(r0);
    assert.equal(mainOnDisk().length, 4, "⌘Z brought the tail back");
    await ui.meta("KeyZ", true);
    rev = await ui.savedAfter(rev);
    const segments = mainOnDisk();
    assert.deepEqual(segments.map((i) => [i.in, i.duration]), [[600, SEGMENT], [92 * FPS, SEGMENT], [182 * FPS, SEGMENT]]);
    // Zoom to fit, then trim the middle segment's end by 1 s (⌘ held: no snapping).
    await page.click("[data-testid=zoom-fit]");
    const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
    const edge = await ui.box(`${ui.itemSel(segments[1]!.id)} [data-edge=end]`);
    const from = { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 };
    await page.keyboard.down("Meta");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - 10 * ppf, from.y, { steps: 4 });
    await page.mouse.move(from.x - FPS * ppf, from.y, { steps: 8 });
    await sleep(120);
    await page.mouse.up();
    await page.keyboard.up("Meta");
    rev = await ui.savedAfter(rev);
    assert.deepEqual(mainOnDisk().map((i) => [i.in, i.duration]), [[600, SEGMENT], [92 * FPS, SEGMENT - FPS], [182 * FPS, SEGMENT]]);
    const videoEnd = 3 * SEGMENT - FPS; // 330: 11 s of footage

    // ---- The title over the opening: a Text preset, switched to the Title style, amber, rising in.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Home");
    await page.click("[data-testid=rail-text]");
    await page.click("[data-testid=text-preset][data-preset=text]");
    rev = await ui.savedAfter(rev);
    await ui.waitFor("[data-testid=text-editor]");
    const titleId = (await ui.timeline()).text![0]!.id!;
    await page.click("[data-testid=insp-text]");
    await ui.selectAll();
    await page.keyboard.type("Above the old town", { delay: 10 });
    await page.keyboard.press("Tab");
    rev = await ui.savedAfter(rev);
    await page.select("[data-testid=insp-preset]", "text.title");
    rev = await ui.savedAfter(rev);
    await page.click("[data-testid=insp-color-swatch]");
    await page.click('[data-testid=insp-color][data-color="#F5C26B"]');
    rev = await ui.savedAfter(rev);
    await page.keyboard.press("Escape");
    await page.click("[data-testid=insp-tab-animation]");
    await page.select("[data-testid=insp-anim-in]", "move.rise");
    rev = await ui.savedAfter(rev);
    await ui.setField("insp-anim-in-dur", "0.6");
    rev = await ui.savedAfter(rev);
    const title = saved(titleId)!;
    assert.equal(title.text, "Above the old town");
    assert.equal(title.start, 0);
    assert.equal(title.duration, 3 * FPS);
    assert.deepEqual(title.style, { preset: "text.title", size: 130, weight: 700, color: "#F5C26B" });
    assert.deepEqual(title.animation, { in: { module: "move.rise", duration: 18 } });

    // ---- The end card: at the end (End), a text right after the footage, then a background
    // from the Elements tab, which spans the selected text and goes on main after the clips.
    await page.click("[data-testid=timeline]");
    await page.keyboard.press("Escape");
    await page.keyboard.press("End");
    await page.click("[data-testid=rail-text]");
    await page.click("[data-testid=text-preset][data-preset=title]");
    rev = await ui.savedAfter(rev);
    await ui.waitFor("[data-testid=text-editor]");
    const thanksId = (await ui.timeline()).text!.at(-1)!.id!;
    assert.notEqual(thanksId, titleId);
    await page.click("[data-testid=insp-text]");
    await ui.selectAll();
    await page.keyboard.type("Thanks for watching", { delay: 10 });
    await page.keyboard.press("Tab");
    rev = await ui.savedAfter(rev);
    assert.equal(saved(thanksId)!.start, videoEnd, "the end card's text starts where the footage ends");
    await page.click("[data-testid=rail-elements]");
    await page.hover("[data-testid=background-tile]");
    await page.click("[data-testid=background-add]");
    // With a text selected + asks (D220): behind it, a card on main as before.
    await ui.waitFor("[data-testid=menu-background-behind]");
    await page.click("[data-testid=menu-background-behind]");
    rev = await ui.savedAfter(rev);
    // One Background element (D131): made a gradient in its Inspector.
    await ui.waitFor("[data-testid=background-editor]");
    await page.click("[data-testid=bg-fill][data-value=linear]");
    rev = await ui.savedAfter(rev);
    const card = mainOnDisk().at(-1)!;
    assert.deepEqual(card, { id: card.id, type: "component", component: "component.solid", duration: 3 * FPS, props: { color: "#0B1D3A", to: "#3B1E54", angle: 160 } }, "the card is on main, after the clips");
    const total = videoEnd + 3 * FPS; // 420: 14 s

    // ---- Music: imported from the Audio tab, added at the start, cut at the end of the video
    // (select it, split at the playhead, delete the rest), faded in and out, turned down.
    await page.click("[data-testid=rail-audio]");
    await page.click("[data-testid=audio-import]");
    // The row shows once the import's add_media edit is in the snapshot: that edit has its own
    // revision, so read it again before waiting for the next one.
    await ui.waitFor("[data-testid=audio-row]", 30000);
    rev = await ui.revision();
    await page.click("[data-testid=timeline]");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Home");
    await page.click("[data-testid=audio-row] [data-testid=audio-add]");
    rev = await ui.savedAfter(rev);
    await page.waitForFunction(() => document.querySelector('[data-testid=lane][data-track="audio"] [data-testid=timeline-item]'), { timeout: 10000 });
    const bedId = (await ui.timeline()).audio![0]!.id!;
    assert.equal(saved(bedId)!.duration, 20 * FPS);
    await ui.select(bedId);
    await ui.goTo(total);
    await split();
    const rest = (await ui.timeline()).audio!.at(-1)!.id!;
    assert.notEqual(rest, bedId);
    await del();
    assert.equal(saved(bedId)!.duration, total);
    await ui.select(bedId);
    await ui.waitFor("[data-testid=audio-editor]");
    await ui.setField("insp-volume-num", "-4");
    rev = await ui.savedAfter(rev);
    await ui.setField("insp-fade-in", "1");
    rev = await ui.savedAfter(rev);
    await ui.setField("insp-fade-out", "1.5");
    rev = await ui.savedAfter(rev);
    assert.deepEqual(saved(bedId), { id: bedId, type: "audio", media: onDisk().media[1]!.id, in: 0, start: 0, duration: total, gainDb: -4, fadeIn: FPS, fadeOut: 45 });
    await page.click("[data-testid=timeline]");
    await page.keyboard.press("Escape");
    await page.click("[data-testid=zoom-fit]");
    await page.screenshot({ path: out("editor.png") });
    assert.match(await page.$eval("[data-testid=timecode]", (el) => el.textContent ?? ""), /\/ 00:00:14:00$/, "the timeline is 14 s");

    // ---- What the preview draws: the title rising and settled over the first segment, a frame
    // of each segment, the end card.
    const space = await screenshotSpace(page);
    const frames = [9, 45, 100, 170, 280, 390];
    const preview = new Map<number, string>();
    let titleBox: Box | undefined;
    for (const f of frames) {
      await page.keyboard.press("Home");
      await ui.goTo(f);
      await ui.settle();
      const path = out(`preview-${f}.png`);
      await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
      preview.set(f, space === "p3" ? toSrgb(path) : path);
      // The settled title's box, from its layout (in canvas pixels: the preview lays out at canvas size).
      if (f === 45) titleBox = await page.$eval(`.pv-text[data-item="${titleId}"]`, (el) => { const e = el as HTMLElement; return { x: e.offsetLeft, y: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight }; });
      // The clip on screen is asked for its source time at this frame (D38): (in + f − start) / fps.
      if (f < videoEnd) {
        const shown = await page.$$eval("video[data-item]", (els) => (els as Array<HTMLVideoElement>).filter((e) => e.style.opacity === "1").map((e) => ({ id: e.dataset.item!, time: e.currentTime })));
        let start = 0;
        const clip = mainOnDisk().find((i) => (start += i.duration) > f)!;
        const source = (clip.in! + f - (start - clip.duration)) / FPS;
        assert.equal(shown.length, 1, `one video on screen at ${f}: ${JSON.stringify(shown)}`);
        assert.equal(shown[0]!.id, clip.id);
        assert.ok(Math.abs(shown[0]!.time - source) < 0.5 / FPS, `frame ${f}: the video is at ${shown[0]!.time}, expected ${source}`);
      }
    }
    const editTime = (Date.now() - t0) / 1000;

    // ---- Export: ⌘E, Standard, the folder from the save panel.
    await ui.meta("KeyE");
    await ui.waitFor("[data-testid=export-form]");
    assert.equal(await page.$eval("[data-testid=quality-standard]", (el) => (el as HTMLElement).dataset.active), "true");
    assert.equal(await page.$eval("[data-testid=loudness-normal]", (el) => (el as HTMLElement).dataset.active), "true");
    await page.click("[data-testid=export-change]");
    await page.waitForFunction((folder) => document.querySelector<HTMLElement>("[data-testid=export-folder]")!.title === folder, {}, join(root, "out"));
    assert.equal(await page.$eval("[data-testid=export-name]", (el) => (el as HTMLInputElement).value), "Old town promo.mp4");
    const e0 = Date.now();
    await page.click("[data-testid=export-start]");
    await ui.waitFor("[data-testid=export-job]");
    // The export's temp folder shows up in our TMPDIR while it runs (so the check below means something).
    let sawTemp = false;
    for (let i = 0; i < 1800; i++) {
      sawTemp ||= readdirSync(temp).some((n) => n.startsWith("uncut-export-"));
      const phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
      if (phase === "done" || phase === "failed") break;
      await sleep(100);
    }
    assert.ok(sawTemp, "the export worked in the app's TMPDIR");
    const status = await page.$eval("[data-testid=export-status]", (el) => el.textContent ?? "");
    assert.equal(await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase), "done", status);
    const exportTime = (Date.now() - e0) / 1000;
    assert.ok(existsSync(saveAs));
    await page.screenshot({ path: out("export-done.png") });

    // ---- The file: 1920×1080 at 30 fps, exactly the timeline's 420 frames, AAC, BT.709.
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames,color_space,color_primaries,color_transfer,color_range,duration:format=duration", "-of", "json", saveAs], { encoding: "utf8" })) as {
      streams: Array<Record<string, string>>;
      format: { duration: string };
    };
    const v = probe.streams.find((s) => s.codec_type === "video")!;
    const a = probe.streams.find((s) => s.codec_type === "audio");
    assert.deepEqual([Number(v.width), Number(v.height), v.r_frame_rate, Number(v.nb_read_frames)], [1920, 1080, "30/1", total]);
    assert.deepEqual([v.color_range, v.color_space, v.color_primaries, v.color_transfer], ["tv", "bt709", "bt709", "bt709"], "tagged BT.709");
    assert.equal(a?.codec_name, "aac");
    assert.ok(Math.abs(Number(probe.format.duration) - total / FPS) < 0.05, `duration ${probe.format.duration} s`);

    // ---- The picture: each exported frame is what the preview drew there.
    // Compared at 480×270 grey after a light blur: the preview is the 4K footage scaled by
    // Chromium, the export by ffmpeg, and on drone footage full of fine detail (grass, gravel) the
    // two resamplers alone cost a few points of plain SSIM. Unblurred scores are printed too.
    const extract = (f: number) => {
      const frame = out(`export-${f}.png`);
      if (!existsSync(frame)) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${f})`, "-frames:v", "1", "-update", "1", frame]);
      return frame;
    };
    for (const f of frames) for (const g of [f - 1, f, f + 1]) rmSync(out(`export-${g}.png`), { force: true });
    const scores: Record<number, { blurred: number; plain: number; neighbours?: number }> = {};
    for (const f of frames) scores[f] = { blurred: ssim(preview.get(f)!, extract(f), true), plain: ssim(preview.get(f)!, extract(f)) };
    // Footage frames show the same moment of the 59.94 fps source: where the shot moves fast
    // enough to tell neighbouring frames apart (frame 170 is mid-pan), the preview matches the
    // exported frame far better than the frames either side of it (two source frames away).
    const moving = frames.filter((f) => f < videoEnd && Math.max(ssim(extract(f), extract(f - 1)), ssim(extract(f), extract(f + 1))) < 0.8);
    assert.ok(moving.includes(170), `frame 170 is in a moving shot (${moving})`);
    for (const f of moving) scores[f]!.neighbours = Math.max(ssim(preview.get(f)!, extract(f - 1)), ssim(preview.get(f)!, extract(f + 1)));
    console.log(`SSIM export vs preview (screenshots in ${space}): ${JSON.stringify(scores)}`);
    for (const f of frames) {
      const s = scores[f]!;
      // Text and backgrounds are the same HTML laid out at canvas size in both (D56): near identical.
      const floor = f >= videoEnd ? 0.99 : 0.97;
      assert.ok(s.blurred >= floor, `frame ${f}: SSIM ${s.blurred} (blurred)`);
      if (s.neighbours !== undefined) assert.ok(s.plain > s.neighbours + 0.1, `frame ${f}: the export's frame matches the preview (${s.plain}) clearly better than its neighbours (${s.neighbours})`);
    }
    // And they're not all alike: the three segments are different shots.
    assert.ok(ssim(extract(100), extract(280)) < 0.8, "segments 1 and 3 are different parts of the clip");
    // The end card: the text in the same place (each edge within 2 canvas px, its width within
    // 0.5 %) and the gradient's colours alike in its top-left and bottom-right corners.
    const cardPreview = brightBox(preview.get(390)!);
    const cardExport = brightBox(extract(390));
    const widthRatio = (cardPreview.x1 - cardPreview.x0) / (cardExport.x1 - cardExport.x0);
    console.log(`end card text: preview ${JSON.stringify(cardPreview)}, export ${JSON.stringify(cardExport)}, width ratio ${widthRatio.toFixed(4)}`);
    for (const k of ["x0", "x1", "y0", "y1"] as const) assert.ok(Math.abs(cardPreview[k] - cardExport[k]) <= 2, `end card text ${k}: ${cardPreview[k]} vs ${cardExport[k]} (canvas px)`);
    assert.ok(Math.abs(widthRatio - 1) < 0.005, `end card text width ratio ${widthRatio}`);
    for (const corner of ["crop=96:54:0:0", "crop=96:54:iw-96:ih-54"]) {
      const [p, e] = [preview.get(390)!, extract(390)].map((png) => [...execFileSync("ffmpeg", ["-v", "error", "-i", png, "-vf", `scale=960:540,${corner},scale=1:1:flags=area,format=rgb24`, "-f", "rawvideo", "-"])]);
      assert.ok(p!.every((c, i) => Math.abs(c - e![i]!) <= 8), `gradient corner ${corner}: preview ${p} vs export ${e}`);
    }

    // The title, settled at frame 45: amber, where the preview has it, alike inside its box.
    assert.ok(titleBox && titleBox.w > 400 && titleBox.h > 80, `title box ${JSON.stringify(titleBox)}`);
    const title45 = titleProblems(preview.get(45)!, extract(45), titleBox, 0.95);
    console.log(`title at 45: SSIM in its box ${title45.inBox}, amber preview ${JSON.stringify(title45.preview)}, export ${JSON.stringify(title45.exported)}`);
    assert.deepEqual(title45.problems, []);
    // The footage's colours: the frame's mean colour within a few levels (the preview applies the
    // BT.709 curve to video, D55, so mid-tones sit a little higher there).
    const meanRgb = (png: string) => [...execFileSync("ffmpeg", ["-v", "error", "-i", png, "-vf", "scale=64:36,scale=1:1:flags=area,format=rgb24", "-f", "rawvideo", "-"])];
    const [footP, footE] = [meanRgb(preview.get(170)!), meanRgb(extract(170))];
    console.log(`footage mean colour at 170: preview ${footP}, export ${footE}`);
    assert.ok(footP.every((c, i) => Math.abs(c - footE[i]!) <= 12), `footage colour at 170: preview ${footP}, export ${footE}`);

    // ---- The sound: normal loudness (−14 LUFS), silent at the very start and end, half way up
    // in the middle of each fade.
    const r = spawnSync("ffmpeg", ["-hide_banner", "-i", saveAs, "-map", "0:a", "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" });
    const lufs = Number(/I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/.exec(r.stderr)?.[1]);
    assert.ok(Math.abs(lufs - -14) <= 1, `loudness ${lufs} LUFS`);
    const steady = rmsDb(saveAs, 4, 4);
    // The sound's own length (AAC priming can make it a few ms off the picture's).
    const soundEnd = Number(a!.duration);
    assert.ok(Math.abs(soundEnd - total / FPS) < 0.05, `sound ${soundEnd} s`);
    const levels = { start: rmsDb(saveAs, 0, 0.03) - steady, fadeInMid: rmsDb(saveAs, 0.45, 0.1) - steady, fadeOutMid: rmsDb(saveAs, soundEnd - 0.8, 0.1) - steady, end: rmsDb(saveAs, soundEnd - 0.04, 0.03) - steady };
    assert.ok(levels.start < -25, `the first frame is near silent: ${levels.start.toFixed(1)} dB`);
    assert.ok(Math.abs(levels.fadeInMid - -6) < 2.5, `half way into the fade in ≈ −6 dB: ${levels.fadeInMid.toFixed(1)} dB`);
    assert.ok(Math.abs(levels.fadeOutMid - -6) < 2.5, `half way through the fade out ≈ −6 dB: ${levels.fadeOutMid.toFixed(1)} dB`);
    assert.ok(levels.end < -25, `the last frame is near silent: ${levels.end.toFixed(1)} dB`);

    // ---- Nothing left behind: the footage untouched, no temp folders, no ffmpeg running.
    const footageAfter = statSync(FOOTAGE);
    assert.deepEqual([footageAfter.size, footageAfter.mtimeMs], [footageBefore.size, footageBefore.mtimeMs], "the footage wasn't touched");
    assert.deepEqual(readdirSync(temp).filter((n) => n.startsWith("uncut-")), [], "no temp folders left");
    const running = descendants(app.proc.pid!).filter((p) => /ffmpeg|ffprobe/.test(p.comm));
    assert.deepEqual(running, [], "no ffmpeg left running");
    assert.deepEqual(app.errors, []);
    t.diagnostic(`SSIM ${JSON.stringify(scores)}; ${lufs} LUFS; levels vs steady ${JSON.stringify(Object.fromEntries(Object.entries(levels).map(([k, x]) => [k, Number(x.toFixed(1))])))}`);
    t.diagnostic(`editing ${editTime.toFixed(1)} s, export ${exportTime.toFixed(1)} s`);
    console.log(`exit check: SSIM ${JSON.stringify(scores)}; ${lufs} LUFS; editing ${editTime.toFixed(1)} s, export ${exportTime.toFixed(1)} s`);

    // ---- Reopen: close the project, quit, start again, open it from Recents: the same timeline.
    const timelineBefore = await ui.timeline();
    const fileBefore = readFileSync(join(dir, "project.json"), "utf8");
    const revBefore = await ui.revision();
    await page.click("[data-testid=timeline]");
    await ui.meta("KeyW");
    await ui.waitFor("[data-testid=welcome]");
    await app.close();
    apps.delete(app);
    app = await launchApp({ command: APP, env });
    apps.add(app);
    page = app.page;
    ui = driver(page);
    await ui.waitFor("[data-testid=recent]");
    assert.deepEqual(await page.$$eval("[data-testid=recent] .wiz-name", (e) => e.map((x) => x.textContent)), ["Old town promo"]);
    await page.click("[data-testid=recent]");
    await ui.waitFor("[data-testid=editor]");
    await ui.waitFor(ui.itemSel(bedId));
    assert.deepEqual(await ui.timeline(), timelineBefore, "the same timeline");
    assert.equal(readFileSync(join(dir, "project.json"), "utf8"), fileBefore, "opening doesn't rewrite the project");
    // Revisions are the server's counter (not stored in project.json), so a restarted app starts
    // them again: persistence is the unchanged file and the same timeline, not an equal revision.
    const revAfter = await ui.revision();
    assert.ok(revAfter >= 0, `a revision is shown (${revAfter})`);
    t.diagnostic(`revision before closing ${revBefore}, after reopening ${revAfter}`);
    // End goes after the end card (D56).
    await page.click("[data-testid=timeline]");
    await page.keyboard.press("End");
    await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, { timeout: 5000 }, total);
    await page.screenshot({ path: out("reopened.png") });
    assert.deepEqual(app.errors, []);
    t.diagnostic(`total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } catch (error) {
    await fail(error);
  }
});
