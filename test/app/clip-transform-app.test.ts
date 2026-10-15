// Phase 6 chunk 1 (D75) on the packaged app (background window): the clip box model by hand.
// Two clips on a 1280×720 canvas, both full frame at first: "left" (testsrc2, main) and "right"
// (the split red/blue clip, a video track above). Then, through the UI only:
// - the Inspector's Position & size: left gets W 640 (H, X and Y written with it) and Cover;
//   right gets W 640, then is dragged on the canvas to the right half (⌘: no snapping) and its X
//   typed to 640 exactly, Cover, corners 24;
// - a scale key on left at frame 0 (the diamond), then 130 % at frame 89, which changes a key there;
// - ⌘Z takes the key edit back, ⇧⌘Z puts it back; every edit is one entry in history.db, labelled;
// - a corner handle resizes right (one edit) and ⌘Z undoes it;
// - the preview vs a Standard export (⌘E) at 4 frames: SSIM ≥ 0.97 (screenshots converted from
//   Display P3 to sRGB when the screen is P3).
// Screenshots: test-output/clip-two-up.png (frame 0) and clip-cover-zoom.png (frame 89), plus
// clip-inspector.png and clip-*-export.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Item, Project } from "../../packages/core/src/timeline/types.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { makeClipMedia, PATTERN_PROBE, SPLIT_PROBE } from "../helpers/clip-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the test clips") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);

function project(media: string): Project {
  return {
    format: "uncut/0",
    name: "Boxes",
    canvas: { width: 1280, height: 720, fps: 30, background: "#808080" },
    media: [
      { id: "m-pattern", kind: "video", name: "Pattern.mp4", path: join(media, "Pattern.mp4"), probe: PATTERN_PROBE },
      { id: "m-split", kind: "video", name: "Split.mp4", path: join(media, "Split.mp4"), probe: SPLIT_PROBE },
    ],
    tracks: [
      { id: "top", kind: "video", name: "Top", items: [{ id: "right", type: "clip", media: "m-split", in: 0, start: 0, duration: 90 }] },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "left", type: "clip", media: "m-pattern", in: 30, duration: 90 }] },
    ],
  };
}

const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const item = (id: string): Item => onDisk().tracks.flatMap((t) => t.items).find((i) => i.id === id)!;
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) => page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r, { timeout: 10000 }, n);
const meta = async (key: Parameters<Page["keyboard"]["press"]>[0], shift = false) => {
  await page.keyboard.down("Meta");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
};
const historyLabels = () => {
  const db = new DatabaseSync(join(dir, "history.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT label FROM revisions WHERE kind = 'edit' ORDER BY revision").all() as Array<{ label: string }>).map((r) => r.label);
  } finally {
    db.close();
  }
};
async function goTo(frame: number) {
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(frame / 30); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < frame % 30; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, frame);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => v.style.opacity === "0" || (!v.seeking && v.readyState >= 2)), { timeout: 10000 });
  await sleep(250);
}
/** Select an item by clicking it on the timeline (off the playhead's way: near its end). */
async function select(id: string) {
  const b = (await (await page.$(`[data-testid=timeline-item][data-item="${id}"]`))!.boundingBox())!;
  await page.mouse.click(b.x + b.width - 12, b.y + b.height / 2);
  await page.waitForSelector(`[data-testid=inspector-item][data-item="${id}"] [data-testid=clip-box-editor]`);
}
/** Type a value into an Inspector number field and commit it (Enter); waits for the edit. */
async function field(testId: string, value: string) {
  const rev = await revision();
  const input = (await page.$(`[data-testid=${testId}]`))!;
  await input.click({ clickCount: 3 });
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
  await waitRevision(rev + 1);
}
async function click(selector: string) {
  const rev = await revision();
  await page.click(selector);
  await waitRevision(rev + 1);
}
const ssim = (a: string, b: string) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
};
async function screenshotSpace(): Promise<"srgb" | "p3"> {
  await page.evaluate(() => {
    const e = document.createElement("div");
    e.id = "red-probe";
    e.style.cssText = "position:fixed;left:0;top:0;width:40px;height:40px;background:#f00;z-index:99999";
    document.body.append(e);
  });
  const path = out("clip-red-probe.png");
  await (await page.$("#red-probe"))!.screenshot({ path });
  await page.evaluate(() => document.getElementById("red-probe")!.remove());
  const [r, g, b] = [...execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vf", "crop=8:8:16:16,scale=1:1,format=rgb24", "-f", "rawvideo", "-"])];
  // D216: tests pin the renderer to sRGB, so pure red is (255, 0, 0); Display P3 would be (234, 51, 35).
  // Anything else is a display profile toSrgb can't undo: fail rather than mis-convert.
  if (r! > 250 && g! < 5 && b! < 5) return "srgb";
  if (Math.abs(r! - 234) <= 3 && Math.abs(g! - 51) <= 3 && Math.abs(b! - 35) <= 3) return "p3";
  throw new Error(`screenshots are in neither sRGB nor Display P3: pure red came back as ${r},${g},${b}`);
}
function toSrgb(png: string) {
  const outPath = png.replace(/\.png$/, "-srgb.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", png, "-vf", "scale=out_color_matrix=bt709:out_range=pc,format=yuv444p,setparams=color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=pc,colorspace=primaries=bt709:trc=iec61966-2-1:space=bt709:range=pc:format=yuv444p,scale=in_color_matrix=bt709:in_range=pc,format=rgb24", outPath]);
  return outPath;
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-clip-app-")));
  makeClipMedia(join(root, "media"));
  dir = writeProject(root, "Boxes", project(join(root, "media")));
  mkdirSync(join(root, "out"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("clip boxes: Inspector position and size, canvas drag and corner, a scale key, undo/redo, history labels, preview = export", { skip, timeout: 300000 }, async () => {
  const saveAs = join(root, "out", "Boxes.mp4");
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await goTo(0);

  // Left: W 640 (the box it shows is written whole), then Cover.
  await select("left");
  assert.equal(await page.$eval("[data-testid=insp-box-w]", (el) => (el as HTMLInputElement).value), "1280");
  await field("insp-box-w", "640");
  assert.deepEqual(item("left").transform, { x: 0, y: 0, w: 640, h: 720 });
  await click("[data-testid=insp-fit][data-fit=cover]");
  assert.equal(item("left").transform?.fit, "cover");

  // Right: W 640, then dragged on the canvas by half the canvas (⌘ for no snapping).
  await select("right");
  await field("insp-box-w", "640");
  const frame = (await (await page.$("[data-testid=preview-frame]"))!.boundingBox())!;
  const k = frame.width / 1280;
  const rev = await revision();
  const from = { x: frame.x + 320 * k, y: frame.y + 360 * k };
  await page.keyboard.down("Meta");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (640 * k * i) / 10, from.y, { steps: 2 });
  await page.mouse.up();
  await page.keyboard.up("Meta");
  await waitRevision(rev + 1);
  const dragged = item("right").transform!;
  assert.ok(Math.abs(dragged.x! - 640) <= 3 && dragged.y === 0 && dragged.w === 640 && dragged.h === 720, `dragged to ${JSON.stringify(dragged)}`);
  // Exactly on the half (a drag lands within a pixel or two at this preview size).
  const retyped = dragged.x !== 640;
  if (retyped) await field("insp-box-x", "640");
  await click("[data-testid=insp-fit][data-fit=cover]");
  await field("insp-radius", "24");
  assert.deepEqual(item("right").transform, { x: 640, y: 0, w: 640, h: 720, fit: "cover", radius: 24 });
  // The selection outline sits on the box.
  const sel = (await (await page.$("[data-testid=clip-selection]"))!.boundingBox())!;
  assert.ok(Math.abs(sel.x - (frame.x + 640 * k)) < 2 && Math.abs(sel.width - 640 * k) < 2, `outline ${JSON.stringify(sel)}`);

  // A corner handle: dragging right's bottom-left corner in by 64 canvas px keeps its shape; ⌘Z undoes it.
  const handle = (await (await page.$("[data-testid=clip-handle][data-handle=sw]"))!.boundingBox())!;
  const r2 = await revision();
  // The handle straddles the frame's bottom edge (the frame clips its lower half): press its upper half.
  const hy = handle.y + handle.height / 2 - 2;
  await page.mouse.move(handle.x + handle.width / 2, hy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(handle.x + handle.width / 2 + (64 * k * i) / 8, hy, { steps: 2 });
  await page.mouse.up();
  await waitRevision(r2 + 1);
  const resized = item("right").transform!;
  assert.ok(Math.abs(resized.w! - 576) <= 3 && Math.abs(resized.h! - 648) <= 4 && Math.abs(resized.x! - 704) <= 3 && resized.y === 0, `resized to ${JSON.stringify(resized)}`);
  await meta("z");
  await waitRevision(r2 + 2);
  assert.deepEqual(item("right").transform, { x: 640, y: 0, w: 640, h: 720, fit: "cover", radius: 24 });

  // A scale key on left at frame 0 (the diamond), then 130 % at frame 89: a second key there.
  await select("left");
  await click("[data-testid=insp-key][data-prop=scale]");
  assert.deepEqual(item("left").keys, [{ frame: 0, scale: 1 }]);
  assert.equal(await page.$eval("[data-testid=insp-key][data-prop=scale]", (el) => (el as HTMLElement).dataset.state), "on");
  await goTo(89);
  assert.equal(await page.$eval("[data-testid=insp-key][data-prop=scale]", (el) => (el as HTMLElement).dataset.state), "keyed");
  await field("insp-scale-num", "130");
  assert.deepEqual(item("left").keys, [{ frame: 0, scale: 1 }, { frame: 89, scale: 1.3 }]);
  assert.equal(await page.$eval("[data-testid=insp-key][data-prop=scale]", (el) => (el as HTMLElement).dataset.state), "on");
  await page.screenshot({ path: out("clip-inspector.png") });

  // ⌘Z / ⇧⌘Z step over the key edit.
  const r3 = await revision();
  await meta("z");
  await waitRevision(r3 + 1);
  assert.deepEqual(item("left").keys, [{ frame: 0, scale: 1 }]);
  await meta("z", true);
  await waitRevision(r3 + 2);
  assert.deepEqual(item("left").keys, [{ frame: 0, scale: 1 }, { frame: 89, scale: 1.3 }]);

  // One labelled edit per change (undo/redo are their own entries, not edits).
  const labels = historyLabels();
  console.log(`  history: ${labels.join(" | ")}`);
  assert.deepEqual(labels, [
    "Resize clip",
    "Fit clip: cover",
    "Resize clip",
    "Move clip",
    ...(retyped ? ["Move clip"] : []),
    "Fit clip: cover",
    "Round clip corners (24 px)",
    "Resize clip",
    "Add scale key at 0.0 s",
    "Zoom clip to 130% (key at 3.0 s)",
  ]);

  // The preview at 4 frames; the two screenshots asked for.
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Escape");
  const space = await screenshotSpace();
  const frames = [0, 30, 60, 89];
  const preview = new Map<number, string>();
  for (const f of frames) {
    await goTo(f);
    const path = out(f === 0 ? "clip-two-up.png" : f === 89 ? "clip-cover-zoom.png" : `clip-preview-${f}.png`);
    await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
    preview.set(f, space === "p3" ? toSrgb(path) : path);
  }

  // Export (Standard, loudness as mixed) and compare.
  await meta("e");
  await page.waitForSelector("[data-testid=export-form]");
  await page.click("[data-testid=quality-standard]");
  await page.click("[data-testid=loudness-off]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Boxes.mp4");
  await page.click("[data-testid=export-start]");
  await page.waitForSelector("[data-testid=export-job]");
  let phase = "";
  for (let i = 0; i < 1200 && phase !== "done" && phase !== "failed"; i++) {
    phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
    await sleep(100);
  }
  assert.equal(phase, "done", await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? ""));
  for (const f of frames) {
    const exported = out(`clip-${f}-export.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${f})`, "-frames:v", "1", "-update", "1", exported]);
    const score = ssim(preview.get(f)!, exported);
    console.log(`  frame ${f}: export vs preview SSIM ${score.toFixed(4)} (screenshots in ${space})`);
    assert.ok(score >= 0.97, `frame ${f}: SSIM ${score}`);
  }
  assert.deepEqual(app.errors, []);
});
