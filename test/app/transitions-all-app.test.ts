// Every transition D133 added, on the packaged app (background window). 23 clips on main,
// 1280×720 with a grey canvas, alternating the testsrc2 pattern and the 4:3 red/blue split clip
// (test/helpers/clip-fixture.ts; the blur's two are both the split clip), 30 frames each, each cut carrying one of the 22 new transitions
// (12 frames; cuts at 30, 60, … 660).
// - The preview mid-way through each (on the cut: share 0.5; a dip or flash 3 frames before, its colour at
//   half, as a flash's) vs a Standard export (⌘E) of the same frame: SSIM ≥ 0.97 (screenshots converted from
//   Display P3 to sRGB when the screen is P3), as transitions-moves-app does for D79's.
//   Screenshots test-output/transitions-all-<name>.png.
// - The Transitions panel: all 28 tiles, thumbnails still until hovered and animating while hovered
//   (their shots' styles change over time; D240), the search narrowing the tiles, no kind filters or
//   length chips (D240), a click on a tile putting it on the selected cut at its default length (one
//   labelled edit). Screenshot test-output/transitions-panel.png (search "wipe").
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { TRANSITIONS } from "../../packages/core/src/index.ts";
import type { Item, Project } from "../../packages/core/src/timeline/types.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { makeClipMedia, PATTERN_PROBE, SPLIT_PROBE } from "../helpers/clip-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the test clips") : `packaged app not built: run pnpm dist to create ${APP}`;

const NEW = TRANSITIONS.slice(6);
const CLIP = 30;
const LENGTH = 12;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);

function project(media: string): Project {
  const items: Array<Item> = Array.from({ length: NEW.length + 1 }, (_, i) => ({
    id: `c${i}`,
    type: "clip",
    // Alternating, except that the blur (cut 90) is split to split: its colour blocks hold still,
    // where the pattern's moving lines, blurred, leave too little structure for SSIM to see past a
    // video frame's timing (the export measured against a Gaussian of the same frames: 0.988).
    media: i % 2 || i === 2 ? "m-split" : "m-pattern",
    in: 20 + ((i * 37) % 200),
    duration: CLIP,
    ...(i > 0 ? { transitionIn: { module: NEW[i - 1]!.id, duration: LENGTH } } : {}),
  }));
  return {
    format: "uncut/0",
    name: "All",
    canvas: { width: 1280, height: 720, fps: 30, background: "#808080" },
    media: [
      { id: "m-pattern", kind: "video", name: "Pattern.mp4", path: join(media, "Pattern.mp4"), probe: PATTERN_PROBE },
      { id: "m-split", kind: "video", name: "Split.mp4", path: join(media, "Split.mp4"), probe: SPLIT_PROBE },
    ],
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items }],
  };
}

const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) => page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r, { timeout: 10000 }, n);
const meta = async (key: Parameters<Page["keyboard"]["press"]>[0]) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key);
  await page.keyboard.up("Meta");
};
/** Seek by keyboard (Home, ⇧→ for seconds, → for frames) and wait for the videos to settle. */
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
  const path = out("transitions-all-red-probe.png");
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-all-transitions-app-")));
  makeClipMedia(join(root, "media"));
  dir = writeProject(root, "All", project(join(root, "media")));
  mkdirSync(join(root, "out"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("D133: every new transition drawn in the preview mid-way matches the export (SSIM ≥ 0.97); the panel's search, kinds, length and animated thumbnails", { skip, timeout: 900000 }, async () => {
  const saveAs = join(root, "out", "All.mp4");
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  for (const [i, t] of NEW.entries()) await page.waitForSelector(`[data-testid=transition-marker][data-item="c${i + 1}"][data-module="${t.id}"]`);

  // The preview mid-way through each.
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Escape");
  const space = await screenshotSpace();
  const checks = NEW.map((t, i) => ({ t, frame: CLIP * (i + 1) - (t.color ? 3 : 0) }));
  const preview = new Map<number, string>();
  for (const { t, frame } of checks) {
    await goTo(frame);
    const path = out(`transitions-all-${t.id.slice("transition.".length)}.png`);
    await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
    preview.set(frame, space === "p3" ? toSrgb(path) : path);
  }

  // Export (Standard, loudness as mixed) and compare.
  await meta("e");
  await page.waitForSelector("[data-testid=export-form]");
  await page.click("[data-testid=quality-standard]");
  await page.click("[data-testid=loudness-off]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "All.mp4");
  await page.click("[data-testid=export-start]");
  await page.waitForSelector("[data-testid=export-job]");
  let phase = "";
  for (let i = 0; i < 6000 && phase !== "done" && phase !== "failed"; i++) {
    phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
    await sleep(100);
  }
  assert.equal(phase, "done", await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? ""));
  const scores: Array<string> = [];
  const low: Array<string> = [];
  for (const { t, frame } of checks) {
    const exported = out(`transitions-all-${t.id.slice("transition.".length)}-export.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", "-update", "1", exported]);
    const score = ssim(preview.get(frame)!, exported);
    scores.push(`${t.id} ${score.toFixed(4)}`);
    if (!(score >= 0.97)) low.push(`${t.id} at ${frame}: ${score}`);
  }
  console.log(`  export vs preview SSIM (screenshots in ${space}):\n    ${scores.join("\n    ")}`);
  assert.deepEqual(low, []);
  await page.keyboard.press("Escape");

  // The panel: all tiles, thumbnails still until hovered (D240).
  await page.click("[data-testid=rail-transitions]");
  await page.waitForSelector("[data-testid=transitions-library]");
  const tiles = await page.$$eval("[data-testid=transition-tile]", (els) => els.map((e) => (e as HTMLElement).dataset.module));
  assert.deepEqual(tiles, TRANSITIONS.map((t) => t.id));
  const styleNow = () => page.$eval("[data-testid=transition-tile][data-module='transition.clock'] .tr-b", (el) => (el as HTMLElement).style.clipPath + (el as HTMLElement).style.visibility);
  await page.mouse.move(5, 5);
  const still = [await styleNow()];
  for (let i = 0; i < 2; i++) {
    await sleep(370);
    still.push(await styleNow());
  }
  assert.equal(new Set(still).size, 1, `the clock thumbnail holds still unhovered: ${still.join(" | ")}`);
  assert.equal(await page.$("[data-testid=transition-thumb][data-playing]"), null);
  await page.hover("[data-testid=transition-tile][data-module='transition.clock'] .tile-name");
  await page.waitForSelector("[data-testid=transition-tile][data-module='transition.clock'] [data-testid=transition-thumb][data-playing=true]");
  const s1 = await styleNow();
  await sleep(370);
  const s2 = await styleNow();
  await sleep(370);
  const s3 = await styleNow();
  assert.ok(s1 !== s2 || s2 !== s3, `the clock thumbnail animates while hovered: ${s1} | ${s2} | ${s3}`);
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => !document.querySelector("[data-testid=transition-thumb][data-playing]"));
  // No kind filters or length chips; the search stays.
  assert.equal(await page.$("[data-testid=transition-kind]"), null);
  assert.equal(await page.$("[data-testid=transition-length]"), null);
  await page.type("[data-testid=transition-search]", "wipe");
  const wipes = await page.$$eval("[data-testid=transition-tile]", (els) => els.map((e) => (e as HTMLElement).dataset.module));
  assert.deepEqual(wipes, ["transition.wipe", "transition.wipe-left", "transition.wipe-up", "transition.wipe-down", "transition.clock"]);
  await sleep(600);
  await page.screenshot({ path: out("transitions-panel.png") });
  await page.click("[data-testid=transition-search-clear]");
  await page.click("[data-testid=transition-search]");
  await page.type("[data-testid=transition-search]", "nothing like this");
  await page.waitForSelector("[data-testid=transition-empty]", { timeout: 5000 }).catch(async (e) => {
    throw new Error(`${(e as Error).message}; search value ${JSON.stringify(await page.$eval("[data-testid=transition-search]", (el) => (el as HTMLInputElement).value))}, active ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))}`);
  });
  await page.click("[data-testid=transition-search-clear]");

  // A click on a tile puts it on the selected cut; the cut's length (12 frames) is kept on a change of type.
  await page.click('[data-testid=transition-marker][data-item="c1"]');
  await page.waitForSelector("[data-testid=inspector-transition][data-item=c1]");
  const rev = await revision();
  await page.click("[data-testid=transition-tile][data-module='transition.wipe-up']");
  await waitRevision(rev + 1);
  assert.deepEqual(onDisk().tracks[0]!.items[1]!.transitionIn, { module: "transition.wipe-up", duration: LENGTH });
  assert.deepEqual(app.errors, []);
});
