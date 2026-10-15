// Shader effects (D213, issue #20) on the packaged app, run invisibly:
// - with WebGPU: a clip carrying the TypeGPU ripple draws through its WebGPU canvas (the picture
//   element hidden under it); the Effects tab's Shaders grid has the catalog's four effects (the
//   plugin in UNCUT_PLUGINS_DIR, allowed) with thumbnails drawn by WebGPU; a click puts CRT on the
//   other clip (one edit), the Inspector's Shader section changes a number, a switch and removes
//   nothing else; the export of the edit matches the preview at both clips' frames (luma SSIM
//   ≥ 0.98, 480×270). Screenshots test-output/issue20-preview.png, issue20-effects.png,
//   issue20-inspector.png.
// - without WebGPU (UNCUT_TEST_NO_GPU: Chromium without a GPU, in the editor and the export's
//   rasteriser): the clip shows plain with a badge that says why, the tiles say "No WebGPU", and the
//   export fails with a sentence naming the clip and the effect. Screenshot
//   test-output/issue20-no-webgpu.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { shaderEntry, type Project, type ShaderDef } from "../../packages/core/src/index.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { makeColours } from "../helpers/fx-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the test clip") : `packaged app not built: run pnpm dist to create ${APP}`;

const CLIP = 30;
let root = "";
let dir = "";
let plugins = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);
const manifest = JSON.parse(readFileSync("plugins/catalog/typegpu-effects/uncut.module.json", "utf8"));
const RIPPLE: ShaderDef = manifest.contributes.shaders[0];

function project(media: string): Project {
  return {
    format: "uncut/0",
    name: "Shaders",
    canvas: { width: 1280, height: 720, fps: 30, background: "#000000" },
    media: [{ id: "m-colours", kind: "video", name: "Colours.mp4", path: join(media, "Colours.mp4"), probe: { frames: 60, fps: 30, width: 1280, height: 720, hasAudio: false } }],
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "c0", type: "clip", media: "m-colours", in: 0, duration: CLIP, effects: [shaderEntry(RIPPLE, { amplitude: 0.02, speed: 8 })] }, { id: "c1", type: "clip", media: "m-colours", in: 0, duration: CLIP }] }],
  };
}
const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const effectsOf = (id: string) => onDisk().tracks[0]!.items.find((i) => i.id === id)!.effects;
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) => page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r, { timeout: 10000 }, n);
const meta = async (key: Parameters<Page["keyboard"]["press"]>[0]) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key);
  await page.keyboard.up("Meta");
};
async function goTo(frame: number) {
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(frame / 30); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < frame % 30; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, frame);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => v.style.opacity === "0" || (!v.seeking && v.readyState >= 2)), { timeout: 10000 });
  await sleep(500);
}
const rgb = (file: string, w: number, h: number) => execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${w}:${h}:flags=area,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"]);
/** Luma SSIM at 480×270 and the mean colour difference per channel (0–255, at 48×27), as video-fx-app. */
function compare(a: string, b: string) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" });
  const ssim = Number(/All:([\d.]+)/.exec(r.stderr)![1]);
  const pa = rgb(a, 48, 27);
  const pb = rgb(b, 48, 27);
  let d = 0;
  for (let i = 0; i < pa.length; i++) d += Math.abs(pa[i]! - pb[i]!);
  return { ssim, colour: d / pa.length };
}
async function screenshotSpace(): Promise<"srgb" | "p3"> {
  await page.evaluate(() => {
    const e = document.createElement("div");
    e.id = "red-probe";
    e.style.cssText = "position:fixed;left:0;top:0;width:40px;height:40px;background:#f00;z-index:99999";
    document.body.append(e);
  });
  const path = out("issue20-red-probe.png");
  await (await page.$("#red-probe"))!.screenshot({ path });
  await page.evaluate(() => document.getElementById("red-probe")!.remove());
  const [r, g, b] = [...execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vf", "crop=8:8:16:16,scale=1:1,format=rgb24", "-f", "rawvideo", "-"])];
  rmSync(path, { force: true });
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
async function exportTo(saveAs: string): Promise<{ phase: string; text: string }> {
  await meta("e");
  await page.waitForSelector("[data-testid=export-form]");
  await page.click("[data-testid=quality-standard]");
  await page.click("[data-testid=loudness-off]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction((n) => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === n, {}, saveAs.split("/").at(-1));
  await page.click("[data-testid=export-start]");
  await page.waitForSelector("[data-testid=export-job]");
  let phase = "";
  for (let i = 0; i < 9000 && phase !== "done" && phase !== "failed"; i++) {
    phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
    await sleep(100);
  }
  return { phase, text: await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? "") };
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue20-")));
  mkdirSync(join(root, "media"), { recursive: true });
  makeColours(join(root, "media", "Colours.mp4"), 1280, 720, 2);
  dir = writeProject(root, "Shaders", project(join(root, "media")));
  mkdirSync(join(root, "out"));
  // The catalog's TypeGPU effects as a plugin folder the user allowed (a data plugin: no command).
  plugins = join(root, "plugins");
  cpSync(resolve("plugins/catalog/typegpu-effects"), join(plugins, "typegpu-effects"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "settings.json"), JSON.stringify({ onboarded: true, pluginApprovals: { "typegpu.effects": { dir: join(plugins, "typegpu-effects"), version: manifest.version, command: "", args: [], capabilities: [], approvedAt: new Date().toISOString() } } }));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("D213: shader effects in the preview (WebGPU), the Effects tab and the Inspector, and the export matches", { skip, timeout: 600000 }, async () => {
  const saveAs = join(root, "out", "Shaders.mp4");
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_PLUGINS_DIR: plugins, UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.waitForSelector("[data-testid=timeline-item][data-item=c1]");
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Escape");
  const space = await screenshotSpace();

  // The ripple through its WebGPU canvas, at the picture's size, the video hidden under it.
  await goTo(15);
  await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>("canvas[data-shader=c0]")?.style.visibility === "", { timeout: 15000 }).catch(async (error) => {
    const state = await page.evaluate(async () => ({ canvas: document.querySelector<HTMLCanvasElement>("canvas[data-shader=c0]")?.outerHTML ?? null, frame: document.querySelector<HTMLElement>("[data-testid=preview-frame]")?.dataset.frame, badge: document.querySelector("[data-shader-badge]")?.textContent ?? null, gpu: !!navigator.gpu, adapter: !!(await navigator.gpu?.requestAdapter()), secure: isSecureContext, video: document.querySelector<HTMLVideoElement>(".pv-box[data-item=c0] > video")?.readyState }));
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  });
  assert.equal(await page.$eval("canvas[data-shader=c0]", (el) => (el as HTMLCanvasElement).width), 1280);
  assert.equal(await page.$eval(".pv-box[data-item=c0] > video", (el) => (el as HTMLElement).style.visibility), "hidden");
  assert.equal(await page.$("[data-shader-badge=c0]"), null);
  const p0 = out("issue20-preview.png");
  await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path: p0 });
  await page.screenshot({ path: out("issue20-editor.png") });

  // The Effects tab: the Shaders grid with the catalog's four, thumbnails drawn by WebGPU.
  await page.click("[data-testid=rail-effects]");
  await page.waitForSelector("[data-testid=shaders-grid]");
  assert.deepEqual(await page.$$eval("[data-testid=shader-tile]", (els) => els.map((e) => (e as HTMLElement).dataset.shader)), ["typegpu.effects.ripple", "typegpu.effects.rgb-shift", "typegpu.effects.halftone", "typegpu.effects.crt"]);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLCanvasElement>("[data-testid=shader-thumb] canvas")].every((c) => !!c.dataset.drawn), { timeout: 15000 });
  assert.equal(await page.$("[data-testid=shader-thumb-no-gpu]"), null);
  // Each thumbnail differs (four different effects on the same picture).
  const thumbs = await page.$$eval("[data-testid=shader-thumb] canvas", (els) =>
    els.map((c) => {
      const d = (c as HTMLCanvasElement).getContext("2d")!.getImageData(0, 0, (c as HTMLCanvasElement).width, (c as HTMLCanvasElement).height).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 97) s = (s * 31 + d[i]!) % 1000003;
      return s;
    }),
  );
  assert.equal(new Set(thumbs).size, 4, `four different thumbnails: ${thumbs}`);

  // A click puts CRT on the selected clip (one edit) with its defaults.
  await goTo(CLIP + 15);
  await page.click("[data-testid=timeline-item][data-item=c1]");
  let r = await revision();
  await page.click("[data-testid=shader-tile][data-shader='typegpu.effects.crt']");
  await waitRevision(r + 1);
  const crt = effectsOf("c1")!;
  assert.equal(crt.length, 1);
  assert.equal((crt[0]!.params as { shader: string }).shader, "typegpu.effects.crt");
  assert.deepEqual((crt[0]!.params as { values: unknown }).values, { lines: 240, strength: 0.35, curve: 0.3, flicker: 0.04, glow: "#3cff9a" });
  await page.waitForSelector("[data-testid=shader-tile][data-shader='typegpu.effects.crt'][data-active=true]");
  await page.screenshot({ path: out("issue20-effects.png") });

  // The Inspector: a number (one edit) and the switch on another clip's effect is not touched.
  await page.click("[data-testid=tab-inspector]");
  await page.waitForSelector("[data-testid=insp-shader]");
  assert.equal(await page.$eval("[data-testid=insp-shader-entry]", (el) => (el as HTMLElement).dataset.shader), "typegpu.effects.crt");
  r = await revision();
  await page.click("[data-testid=insp-shader-strength-value]", { clickCount: 3 });
  await page.keyboard.type("0.6");
  await page.keyboard.press("Enter");
  await waitRevision(r + 1);
  assert.equal(((effectsOf("c1")![0]!.params as { values: Record<string, unknown> }).values).strength, 0.6);
  await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>("canvas[data-shader=c1]")?.style.visibility === "", { timeout: 15000 });
  await sleep(400);
  await page.screenshot({ path: out("issue20-inspector.png") });
  // Nothing selected, so no selection outline over the picture.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await goTo(CLIP + 15);
  await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>("canvas[data-shader=c1]")?.style.visibility === "", { timeout: 15000 });
  const p1 = out("issue20-preview-crt.png");
  await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path: p1 });

  // The export matches the preview at both clips' frame 15.
  const done = await exportTo(saveAs);
  assert.equal(done.phase, "done", done.text);
  const scores: Array<string> = [];
  for (const [i, shot] of [p0, p1].entries()) {
    const file = out(`issue20-export-${i}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${CLIP * i + 15})`, "-frames:v", "1", "-update", "1", file]);
    const c = compare(space === "p3" ? toSrgb(shot) : shot, file);
    scores.push(`${i ? "crt" : "ripple"} SSIM ${c.ssim.toFixed(4)} Δ${c.colour.toFixed(1)}`);
    assert.ok(c.ssim >= 0.98, `${i ? "crt" : "ripple"}: preview vs export SSIM ${c.ssim}`);
  }
  console.log(`  preview vs export (screenshots in ${space}): ${scores.join(", ")}`);
  await app.close();
  app = undefined;
});

test("D213: without WebGPU the clip shows plain with a badge, the tiles say so, and the export refuses with why", { skip, timeout: 300000 }, async () => {
  await app?.close();
  app = undefined;
  const saveAs = join(root, "out", "NoGpu.mp4");
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_PLUGINS_DIR: plugins, UNCUT_TEST_NO_GPU: "1", UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Escape");
  await goTo(15);
  await page.waitForSelector("[data-shader-badge=c0]", { timeout: 15000 });
  assert.match(await page.$eval("[data-shader-badge=c0]", (el) => el.textContent ?? ""), /^Ripple isn't drawn here: .*(WebGPU|GPU).*\. The export needs WebGPU too\.$/);
  assert.equal(await page.$("canvas[data-shader=c0]"), null);
  assert.equal(await page.$eval(".pv-box[data-item=c0] > video", (el) => (el as HTMLElement).style.visibility), "", "the plain picture shows");
  await page.click("[data-testid=rail-effects]");
  await page.waitForSelector("[data-testid=shader-thumb-no-gpu]", { timeout: 15000 });
  assert.equal((await page.$$("[data-testid=shader-thumb-no-gpu]")).length, 4);
  await page.$eval("[data-testid=shaders-grid]", (el) => el.scrollIntoView({ block: "center" }));
  await sleep(200);
  await page.screenshot({ path: out("issue20-no-webgpu.png") });
  const failed = await exportTo(saveAs);
  assert.equal(failed.phase, "failed");
  assert.match(failed.text, /Can't export: the clip "c0" uses the shader effect Ripple, which needs WebGPU, and the export's renderer has none/);
  assert.ok(!existsSync(saveAs), "no video made");
});
