// Phase 4 chunk 6 on the packaged app (D34, D39, D55): the export dialog and what it makes.
// - ⌘E and the top bar's Export button open the dialog; quality cards, the file name and folder
//   (native save panel, answered by UNCUT_TEST_DIALOG), loudness with its hint; Export shows
//   progress, then the file is shown in Finder (logged in test mode) and can be shown again.
// - The exported frames match what the preview draws at the same frames (SSIM at 480×270 grey;
//   screenshots come in the display's colour space, so a Display P3 one is converted to sRGB first):
//   the title card fading in, a plain clip, the letterboxed overlay over a cut, the middle of
//   the crossfade, the lower third rising and settled.
// - An existing file is refused with a Replace button; Esc closes the dialog.
// - Without ffmpeg the dialog shows how to install it instead of the form.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { FPS, makeExportFixture, writeProject } from "../helpers/export-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the test media") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
const apps = new Set<LaunchedApp>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const meta = async (page: Page, key: "e") => {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key);
  await page.keyboard.up("Meta");
};
const frameNow = (page: Page) => page.$eval("[data-testid=preview-frame]", (el) => Number((el as HTMLElement).dataset.frame));
/** Seek by keyboard: Home, then ⇧→ for whole seconds and → for frames; then wait for the videos. */
async function goTo(page: Page, frame: number) {
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(frame / FPS); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < frame % FPS; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, frame);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => v.style.opacity === "0" || (!v.seeking && v.readyState >= 2)), { timeout: 10000 });
  await sleep(250);
}
const ssim = (a: string, b: string) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
};
/** The colour space the app's screenshots are in: a pure red square comes back as (255, 0, 0) in sRGB, about (234, 51, 35) in Display P3. */
async function screenshotSpace(page: Page): Promise<"srgb" | "p3"> {
  await page.evaluate(() => {
    const e = document.createElement("div");
    e.id = "red-probe";
    e.style.cssText = "position:fixed;left:0;top:0;width:40px;height:40px;background:#f00;z-index:99999";
    document.body.append(e);
  });
  const path = out("export-red-probe.png");
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
const logged = async (app: LaunchedApp, line: string) => {
  for (let i = 0; i < 50 && !app.output().includes(line); i++) await sleep(100);
  return app.output().includes(line);
};

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-export-app-")));
  dir = writeProject(root, "Export", makeExportFixture(join(root, "media")));
  mkdirSync(join(root, "out"));
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("export dialog: ⌘E, quality, file and folder, progress, shown in Finder; the export matches the preview", { skip, timeout: 240000 }, async () => {
  const saveAs = join(root, "out", "My export.mp4");
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") } });
  apps.add(app);
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor(page, "[data-testid=editor]");
  await page.click("[data-testid=timeline]");

  // What the preview draws, frame by frame.
  const space = await screenshotSpace(page);
  const frames = [5, 30, 60, 120, 150, 156, 200, 225];
  const preview = new Map<number, string>();
  for (const f of frames) {
    await goTo(page, f);
    const path = out(`export-preview-${f}.png`);
    await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
    preview.set(f, space === "p3" ? toSrgb(path) : path);
  }

  // ⌘E opens the dialog with Standard and Normal loudness picked; Esc closes it.
  await meta(page, "e");
  await waitFor(page, "[data-testid=export-form]");
  assert.equal(await page.$eval("[data-testid=quality-standard]", (el) => (el as HTMLElement).dataset.active), "true");
  assert.match(await page.$eval("[data-testid=quality-high]", (el) => el.textContent ?? ""), /1920×1080, 30 fps/);
  assert.match(await page.$eval("[data-testid=quality-draft]", (el) => el.textContent ?? ""), /1280×720/);
  assert.equal(await page.$eval("[data-testid=loudness-normal]", (el) => (el as HTMLElement).dataset.active), "true");
  assert.match(await page.$eval("[data-testid=loudness-hint]", (el) => el.textContent ?? ""), /YouTube/);
  assert.equal(await page.$eval("[data-testid=export-name]", (el) => (el as HTMLInputElement).value), "Export test.mp4");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=export-modal]"));
  const frameBefore = await frameNow(page);

  // The top bar's button opens it too. Pick Draft, then Standard; loudness as mixed; Change… → the save panel.
  await page.click("[data-testid=export-button]");
  await waitFor(page, "[data-testid=export-form]");
  await page.click("[data-testid=quality-draft]");
  assert.equal(await page.$eval("[data-testid=quality-draft]", (el) => (el as HTMLElement).dataset.active), "true");
  await page.click("[data-testid=quality-standard]");
  await page.click("[data-testid=loudness-off]");
  assert.match(await page.$eval("[data-testid=loudness-hint]", (el) => el.textContent ?? ""), /exactly as they sound/);
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "My export.mp4");
  assert.equal(await page.$eval("[data-testid=export-folder]", (el) => (el as HTMLElement).title), join(root, "out"));
  assert.match(await page.$eval("[data-testid=export-form]", (el) => el.textContent ?? ""), /Opens in Finder when it's done/);
  await page.screenshot({ path: out("export-dialog.png") });

  // Export: progress, then done and shown in Finder.
  const t0 = Date.now();
  await page.click("[data-testid=export-start]");
  await waitFor(page, "[data-testid=export-job]");
  const phases = new Set<string>();
  for (let i = 0; i < 600; i++) {
    const phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
    phases.add(phase);
    if (phase === "rendering" && !existsSync(out("export-progress.png"))) await page.screenshot({ path: out("export-progress.png") });
    if (phase === "done" || phase === "failed") break;
    await sleep(100);
  }
  const status = await page.$eval("[data-testid=export-status]", (el) => el.textContent ?? "");
  assert.ok(phases.has("done"), `${[...phases]}: ${status} ${await page.$eval("[data-testid=export-job]", (el) => el.textContent)}`);
  assert.ok(phases.has("preparing") || phases.has("rendering"), `progress was shown: ${[...phases]}`);
  console.log(`export from the dialog: ${((Date.now() - t0) / 1000).toFixed(1)} s, phases seen ${[...phases].join(" → ")}`);
  assert.match(status, /Saved/);
  assert.ok(existsSync(saveAs));
  assert.ok(await logged(app, `[test] showItemInFolder ${saveAs}`), "shown in Finder when done");
  const before = app.output().split(`[test] showItemInFolder ${saveAs}`).length;
  await page.click("[data-testid=export-reveal]");
  for (let i = 0; i < 30 && app.output().split(`[test] showItemInFolder ${saveAs}`).length === before; i++) await sleep(100);
  assert.equal(app.output().split(`[test] showItemInFolder ${saveAs}`).length, before + 1, "Show in Finder");
  await page.screenshot({ path: out("export-done.png") });

  // The export draws what the preview drew.
  for (const f of frames) {
    const frame = out(`export-frame-${f}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${f})`, "-frames:v", "1", "-update", "1", frame]);
    const score = ssim(preview.get(f)!, frame);
    console.log(`  frame ${f}: export vs preview SSIM ${score.toFixed(4)} (screenshots in ${space})`);
    // Text and backgrounds are the same HTML in the same Chromium: near identical. Footage goes
    // through Chromium's colour management in the preview (its BT.709 curve lifts mid-tones a few
    // levels) while the export keeps the code values, so video frames sit a little lower.
    // (Raised with D56: the preview lays out at canvas size, so text matches; measured 0.997 and 0.974–0.992.)
    assert.ok(score >= (f <= 30 ? 0.99 : 0.96), `frame ${f}: SSIM ${score}`);
  }
  // The title card's text (frame 30, fully faded in) in the same place, the same width (D56).
  const brightBox = (png: string) => {
    const [w, h] = [1920, 1080];
    const px = execFileSync("ffmpeg", ["-v", "error", "-i", png, "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 16 << 20 });
    const b = { x0: w, x1: -1, y0: h, y1: -1 };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[y * w + x]! > 200) Object.assign(b, { x0: Math.min(b.x0, x), x1: Math.max(b.x1, x), y0: Math.min(b.y0, y), y1: Math.max(b.y1, y) });
    return b;
  };
  const [tp, te] = [brightBox(preview.get(30)!), brightBox(out("export-frame-30.png"))];
  const ratio = (tp.x1 - tp.x0) / (te.x1 - te.x0);
  console.log(`  title text: preview ${JSON.stringify(tp)}, export ${JSON.stringify(te)}, width ratio ${ratio.toFixed(4)}`);
  for (const k of ["x0", "x1", "y0", "y1"] as const) assert.ok(Math.abs(tp[k] - te[k]) <= 2, `title ${k}: ${tp[k]} vs ${te[k]} (canvas px)`);
  assert.ok(Math.abs(ratio - 1) < 0.005, `title width ratio ${ratio}`);

  // Again to the same file, typed by hand (not confirmed by the save panel): refused, with Replace.
  await page.click("[data-testid=export-again]");
  await waitFor(page, "[data-testid=export-form]");
  await page.click("[data-testid=export-name]", { clickCount: 3 });
  await page.keyboard.type("My export.mp4");
  await page.click("[data-testid=export-start]");
  await waitFor(page, "[data-testid=export-refused][data-reason=exists]");
  assert.match(await page.$eval("[data-testid=export-refused]", (el) => el.textContent ?? ""), /My export\.mp4 already exists/);
  await waitFor(page, "[data-testid=export-replace]");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=export-modal]"));
  // The editor's keys work again (Home is the dialog's no more).
  await page.keyboard.press("End");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) !== f, {}, frameBefore);
  assert.deepEqual(app.errors, []);
  await app.close();
  apps.delete(app);
});

test("export dialog: without ffmpeg it shows how to install it", { skip, timeout: 120000 }, async () => {
  const app = await launchApp({
    command: APP,
    cleanEnv: true,
    env: {
      HOME: homedir(),
      USER: process.env.USER,
      TMPDIR: process.env.TMPDIR,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      UNCUT_SHELL_ENV: "off",
      UNCUT_DATA_DIR: join(root, "data-no-ffmpeg"),
      UNCUT_TEST_DIALOG: JSON.stringify([dir]),
    },
  });
  apps.add(app);
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor(page, "[data-testid=editor]");
  await page.click("[data-testid=timeline]");
  await meta(page, "e");
  await waitFor(page, "[data-testid=export-no-ffmpeg]", 20000);
  assert.equal(await page.$eval("[data-testid=check-ffmpeg]", (el) => (el as HTMLElement).dataset.status), "missing");
  assert.match(await page.$eval("[data-testid=export-no-ffmpeg]", (el) => el.textContent ?? ""), /brew install ffmpeg/);
  assert.equal(await page.$("[data-testid=export-form]"), null);
  await page.screenshot({ path: out("export-no-ffmpeg.png") });
  await page.click("[data-testid=copy-ffmpeg]");
  assert.ok(await logged(app, "[test] copied brew install ffmpeg"));
  await app.close();
  apps.delete(app);
});
