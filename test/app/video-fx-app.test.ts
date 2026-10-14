// Clip looks and effects on the packaged app (D136, feedback G2), one background launch.
// - Preview = export: 31 clips of Colours.mp4 (test/helpers/fx-fixture.ts, 1280×720, static and
//   colourful) on main, 30 frames each: none, the 16 looks, Adjust, the 13 effects. The preview at
//   each clip's frame 15 against a Standard export of the same frame: SSIM on luma (480×270) and
//   the mean colour difference per channel (see compare); screenshots converted from
//   Display P3 to sRGB when the screen is P3. Film grain is compared by its statistics (how much
//   it moves pixels against the clip without effects), not SSIM. Screenshots
//   test-output/effects-<name>.png (preview) and -export.png.
// - The Effects tab: 17 filter tiles (None + 16) and 13 effect tiles with thumbnails the preview's
//   renderer draws (the sample picture, then the selected clip's frame), each look's different;
//   a click puts a look on the selected clip (one edit), a drag onto a timeline clip adds an
//   effect there; the Inspector's filter intensity, Adjust and an effect's setting are one edit
//   each. Screenshots test-output/effects-panel.png, effects-inspector.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { EFFECTS, LOOKS } from "../../packages/core/src/index.ts";
import type { Item, Project } from "../../packages/core/src/timeline/types.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { makeColours } from "../helpers/fx-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the test clip") : `packaged app not built: run pnpm dist to create ${APP}`;

const CLIP = 30;
/** Each case: a clip's effects, the lowest per-channel SSIM it must reach, or "grain" (statistics). */
interface Case {
  readonly name: string;
  readonly effects?: Item["effects"];
  readonly min: number | "grain";
  /** Another media than the video (stills, a half-transparent PNG, an SVG), and a transform. */
  readonly media?: string;
  readonly transform?: Item["transform"];
  /** Drawn through the clip's WebGL canvas (default: when it has a picture effect). */
  readonly canvas?: boolean;
  /** The mean colour Δ allowed when not the default (3 through the canvas, 8 otherwise). */
  readonly colour?: number;
}
const SSIM_LOOKS = 0.97;
/** The effects' floors (D136): measured values are printed by the test and recorded in DECISIONS. */
const FLOORS: Readonly<Record<string, number>> = { "effect.pixelate": 0.95, "effect.sharpen": 0.95, "effect.glow": 0.95, "effect.rgb-split": 0.95, "effect.posterize": 0.93, "effect.shake": 0.95, "effect.blur": 0.97 };
const CASES: ReadonlyArray<Case> = [
  { name: "none", min: SSIM_LOOKS },
  ...LOOKS.map((l): Case => ({ name: `look-${l.id}`, effects: [{ module: "effect.look", params: { look: l.id, intensity: 1 } }], min: SSIM_LOOKS })),
  { name: "adjust", effects: [{ module: "effect.color", params: { exposure: 0.3, contrast: 0.2, saturation: 0.25, temperature: -0.3, tint: 0.2, highlights: -0.3, shadows: 0.4, vibrance: 0.3 } }], min: SSIM_LOOKS },
  ...EFFECTS.map((e): Case => ({ name: e.id.slice("effect.".length), effects: [{ module: e.id }], min: e.id === "effect.grain" ? "grain" : (FLOORS[e.id] ?? SSIM_LOOKS) })),
  // Stills (review fixes): a PNG and a JPEG, a half-transparent PNG (its alpha kept on both sides),
  // an SVG (looks and effects don't apply: drawn plain on both sides), and a picture zoomed to 0.5
  // (effects at its fit size on both sides, then zoomed).
  { name: "still-png-warm", media: "m-png", effects: [{ module: "effect.look", params: { look: "warm", intensity: 1 } }], min: SSIM_LOOKS },
  { name: "still-jpg-pixelate", media: "m-jpg", effects: [{ module: "effect.pixelate" }], min: 0.95 },
  // Half of it is the canvas grey, which (like a plain video) a P3 screen shows ~5 levels lighter than the export (measured +4.8, the same as "none").
  { name: "half-png-warm", media: "m-half", effects: [{ module: "effect.look", params: { look: "warm", intensity: 1 } }, { module: "effect.sharpen" }], min: SSIM_LOOKS, colour: 8 },
  { name: "svg-warm", media: "m-svg", effects: [{ module: "effect.look", params: { look: "warm", intensity: 1 } }], min: SSIM_LOOKS, canvas: false },
  { name: "scaled-pixelate", effects: [{ module: "effect.pixelate", params: { size: 24 } }, { module: "effect.rgb-split", params: { amount: 12 } }], transform: { scale: 0.5 }, min: 0.95 },
];
const PLAIN = ["effect.vignette", "effect.letterbox", "effect.zoom-pulse", "effect.blur", "effect.grain"];
const viaCanvas = (c: Case) => c.canvas ?? (!!c.effects && !PLAIN.includes(String(c.effects[0]!.module)));

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);

function project(media: string): Project {
  const items: Array<Item> = CASES.map((c, i) => ({ id: `c${i}`, type: "clip", media: c.media ?? "m-colours", ...(c.media ? {} : { in: 0 }), duration: CLIP, ...(c.effects ? { effects: c.effects } : {}), ...(c.transform ? { transform: c.transform } : {}) }));
  const still = (id: string, name: string) => ({ id, kind: "image" as const, name, path: join(media, name), probe: { width: 1280, height: 720 } });
  return {
    format: "uncut/0",
    name: "Fx",
    canvas: { width: 1280, height: 720, fps: 30, background: "#808080" },
    media: [{ id: "m-colours", kind: "video", name: "Colours.mp4", path: join(media, "Colours.mp4"), probe: { frames: 60, fps: 30, width: 1280, height: 720, hasAudio: false } }, still("m-png", "Colours.png"), still("m-jpg", "Colours.jpg"), still("m-half", "Half.png"), still("m-svg", "Logo.svg")],
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items }],
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
const box = async (selector: string) => (await (await page.$(selector))!.boundingBox())!;
/** Seek by keyboard (Home, ⇧→ for seconds, → for frames) and wait for the videos and effects to settle. */
async function goTo(frame: number) {
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(frame / 30); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < frame % 30; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, frame);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => v.style.opacity === "0" || (!v.seeking && v.readyState >= 2)), { timeout: 10000 });
  await sleep(400);
}
/**
 * SSIM on luma at 480×270 (as the other preview-vs-export tests) and the mean colour difference per
 * channel (0–255, at 48×27), which is what tells a warm look from a cool one: per-channel SSIM is
 * no use on this clip, whose channels sit flat at 0 or 255 over large areas (codec noise there
 * dominates SSIM: 0.78–0.90 even with no effects, where luma gives 0.989).
 */
function compare(a: string, b: string) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" });
  const ssim = Number(/All:([\d.]+)/.exec(r.stderr)![1]);
  const pa = rgb(a, 48, 27);
  const pb = rgb(b, 48, 27);
  let d = 0;
  for (let i = 0; i < pa.length; i++) d += Math.abs(pa[i]! - pb[i]!);
  return { ssim, colour: d / pa.length };
}
const rgb = (file: string, w: number, h: number) => execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${w}:${h}:flags=area,format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"]);
/** How much film grain moves pixels: the RMS of (frame − the clip without effects) at 480×270, and the mean shift. */
function grainStats(withGrain: string, without: string) {
  const a = rgb(withGrain, 480, 270);
  const b = rgb(without, 480, 270);
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    sum += d;
    sq += d * d;
  }
  const mean = sum / a.length;
  return { mean, rms: Math.sqrt(sq / a.length - mean * mean) };
}
async function screenshotSpace(): Promise<"srgb" | "p3"> {
  await page.evaluate(() => {
    const e = document.createElement("div");
    e.id = "red-probe";
    e.style.cssText = "position:fixed;left:0;top:0;width:40px;height:40px;background:#f00;z-index:99999";
    document.body.append(e);
  });
  const path = out("effects-red-probe.png");
  await (await page.$("#red-probe"))!.screenshot({ path });
  await page.evaluate(() => document.getElementById("red-probe")!.remove());
  const [r, g] = [...execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vf", "crop=8:8:16:16,scale=1:1,format=rgb24", "-f", "rawvideo", "-"])];
  return r! > 245 && g! < 10 ? "srgb" : "p3";
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-fx-app-")));
  mkdirSync(join(root, "media"), { recursive: true });
  makeColours(join(root, "media", "Colours.mp4"), 1280, 720, 2);
  const frame = (to: string, vf: string) => execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(root, "media", "Colours.mp4"), "-vf", vf, "-frames:v", "1", join(root, "media", to)]);
  frame("Colours.png", "scale=in_color_matrix=bt709:in_range=tv,format=rgb24");
  frame("Colours.jpg", "scale=in_color_matrix=bt709:in_range=tv,format=yuvj444p");
  frame("Half.png", "scale=in_color_matrix=bt709:in_range=tv,format=rgba,colorchannelmixer=aa=0.5");
  writeFileSync(join(root, "media", "Logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#1d3557"/><circle cx="640" cy="360" r="220" fill="#e63946"/><rect x="200" y="520" width="880" height="60" fill="#f1faee"/></svg>');
  dir = writeProject(root, "Fx", project(join(root, "media")));
  mkdirSync(join(root, "out"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("D136: every look and effect drawn in the preview matches the export; the Effects tab and the Inspector edit them", { skip, timeout: 1200000 }, async () => {
  const saveAs = join(root, "out", "Fx.mp4");
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.waitForSelector(`[data-testid=timeline-item][data-item=c${CASES.length - 1}]`);

  // The preview at frame 15 of each clip.
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Escape");
  const space = await screenshotSpace();
  const preview = new Map<string, string>();
  for (const [i, c] of CASES.entries()) {
    await goTo(CLIP * i + 15);
    if (viaCanvas(c)) {
      // A picture effect draws through the clip's WebGL canvas (its picture hidden under it), at the picture's fit size.
      await page.waitForFunction((id) => document.querySelector<HTMLCanvasElement>(`canvas[data-fx=${id}]`)?.style.visibility === "", { timeout: 10000 }, `c${i}`);
      assert.equal(await page.$eval(`canvas[data-fx=c${i}]`, (el) => (el as HTMLCanvasElement).width), 1280, c.name);
      assert.equal(await page.$eval(`.pv-box[data-item=c${i}] > :is(video, img)`, (el) => (el as HTMLElement).style.visibility), "hidden");
    } else if (c.media === "m-svg") assert.equal(await page.$(`canvas[data-fx=c${i}]`), null, "an SVG takes no effects");
    const path = out(`effects-${c.name}.png`);
    await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
    preview.set(c.name, space === "p3" ? toSrgb(path) : path);
  }

  // Export (Standard, loudness off) and compare.
  await meta("e");
  await page.waitForSelector("[data-testid=export-form]");
  await page.click("[data-testid=quality-standard]");
  await page.click("[data-testid=loudness-off]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Fx.mp4");
  await page.click("[data-testid=export-start]");
  await page.waitForSelector("[data-testid=export-job]");
  let phase = "";
  for (let i = 0; i < 9000 && phase !== "done" && phase !== "failed"; i++) {
    phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
    await sleep(100);
  }
  assert.equal(phase, "done", await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? ""));
  const exported = new Map<string, string>();
  for (const [i, c] of CASES.entries()) {
    const file = out(`effects-${c.name}-export.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${CLIP * i + 15})`, "-frames:v", "1", "-update", "1", file]);
    exported.set(c.name, file);
  }
  const scores: Array<string> = [];
  const low: Array<string> = [];
  for (const c of CASES) {
    if (c.min === "grain") {
      // Grain: both sides move pixels by a similar amount (Chromium draws the same noise at different sizes, so not pixel for pixel).
      const p = grainStats(preview.get(c.name)!, preview.get("none")!);
      const e = grainStats(exported.get(c.name)!, exported.get("none")!);
      scores.push(`${c.name} rms ${p.rms.toFixed(2)} vs ${e.rms.toFixed(2)}, mean ${p.mean.toFixed(2)} vs ${e.mean.toFixed(2)}`);
      // Measured: preview rms 11.4 / mean +10.3, export 5.9 / +6.7 (h264 at Standard smooths half the grain away).
      if (!(e.rms > 2 && p.rms > 2 && p.rms / e.rms > 0.4 && p.rms / e.rms < 2.5 && Math.abs(p.mean - e.mean) < 5)) low.push(`${c.name}: rms ${p.rms} / ${e.rms}, mean ${p.mean} / ${e.mean}`);
      continue;
    }
    const r = compare(preview.get(c.name)!, exported.get(c.name)!);
    scores.push(`${c.name} ${r.ssim.toFixed(4)} Δ${r.colour.toFixed(1)}`);
    // Through the clip's canvas the colours match to about a level; a plain <video> (no picture
    // effect) is Chromium's own drawing, a few levels off on a Display P3 screen (as before D136).
    const most = c.colour ?? (viaCanvas(c) ? 3 : 8);
    if (!(r.ssim >= c.min) || !(r.colour <= most)) low.push(`${c.name}: SSIM ${r.ssim} (≥ ${c.min}), colour Δ ${r.colour.toFixed(2)} (≤ ${most})`);
  }
  console.log(`  preview vs export, luma SSIM and mean colour Δ (screenshots in ${space}):\n    ${scores.join("\n    ")}`);
  assert.deepEqual(low, []);
  // The looks really change the picture: each differs from the clip without effects.
  for (const l of LOOKS) assert.ok(compare(exported.get(`look-${l.id}`)!, exported.get("none")!).colour > 2, `${l.id} changes the colours`);
  // The half-transparent still shows the grey canvas through it, in the export as in the preview.
  for (const m of [preview, exported]) assert.ok(compare(m.get("half-png-warm")!, m.get("still-png-warm")!).colour > 15, "alpha kept");
  await page.keyboard.press("Escape");

  // The Effects tab: tiles, thumbnails from the sample, then from the selected clip.
  await page.click("[data-testid=rail-effects]");
  await page.waitForSelector("[data-testid=effects-library]");
  assert.equal((await page.$$("[data-testid=filter-tile]")).length, LOOKS.length + 1);
  assert.deepEqual(await page.$$eval("[data-testid=effect-tile]", (els) => els.map((e) => (e as HTMLElement).dataset.module)), EFFECTS.map((e) => e.id));
  const thumbColours = () =>
    page.$$eval("[data-testid=filter-tile] canvas", (els) =>
      els.map((c) => {
        const g = (c as HTMLCanvasElement).getContext("2d")!;
        const d = g.getImageData(0, 0, (c as HTMLCanvasElement).width, (c as HTMLCanvasElement).height).data;
        let r = 0, gg = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) (r += d[i]!), (gg += d[i + 1]!), (b += d[i + 2]!);
        const n = d.length / 4;
        return `${Math.round(r / n)},${Math.round(gg / n)},${Math.round(b / n)}`;
      }),
    );
  await page.waitForFunction(() => document.querySelector("[data-testid=effects-library]")!.getAttribute("data-source") === "sample");
  const sampleThumbs = await thumbColours();
  assert.ok(new Set(sampleThumbs).size >= LOOKS.length - 2, `the looks' thumbnails differ: ${sampleThumbs.join(" | ")}`);
  await goTo(15);
  await page.click("[data-testid=timeline-item][data-item=c0]");
  await page.waitForFunction(() => /^c0@/.test(document.querySelector("[data-testid=effects-library]")!.getAttribute("data-source") ?? ""), { timeout: 10000 });
  await sleep(300);
  const clipThumbs = await thumbColours();
  assert.notDeepEqual(clipThumbs, sampleThumbs, "drawn from the clip's frame now");

  // A click puts Warm on the selected clip (one edit); its tile shows it's on.
  let r = await revision();
  await page.click("[data-testid=filter-tile][data-look=warm]");
  await waitRevision(r + 1);
  assert.deepEqual(effectsOf("c0"), [{ module: "effect.look", params: { look: "warm", intensity: 1 } }]);
  await page.waitForSelector("[data-testid=filter-tile][data-look=warm][data-active=true]");
  await page.screenshot({ path: out("effects-panel.png") });

  // The Inspector: intensity, Adjust, an effect's setting; one edit each.
  await page.click("[data-testid=tab-inspector]");
  await page.waitForSelector("[data-testid=insp-filter]");
  const setField = async (testId: string, value: string) => {
    const before = await revision();
    await page.click(`[data-testid=${testId}]`, { clickCount: 3 });
    await page.keyboard.type(value);
    await page.keyboard.press("Enter");
    await waitRevision(before + 1);
  };
  await setField("insp-filter-amount", "60");
  assert.deepEqual(effectsOf("c0"), [{ module: "effect.look", params: { look: "warm", intensity: 0.6 } }]);
  await setField("insp-adjust-exposure-value", "0.5");
  await setField("insp-adjust-vibrance-value", "-40");
  assert.deepEqual(effectsOf("c0")![1], { module: "effect.color", params: { exposure: 0.5, vibrance: -0.4 } });
  r = await revision();
  await page.click("[data-testid=effect-tile][data-module='effect.vignette']");
  await waitRevision(r + 1);
  await page.waitForSelector("[data-testid=insp-effect][data-module='effect.vignette']");
  await setField("insp-effect-amount-value", "0.8");
  assert.deepEqual(effectsOf("c0")![2], { module: "effect.vignette", params: { amount: 0.8, size: 0.5 } });
  // The preview shows it: the clip's canvas and its overlay.
  await page.waitForSelector("canvas[data-fx=c0]");
  await page.waitForSelector("[data-fx-overlay=c0] .pv-fx");
  await page.screenshot({ path: out("effects-inspector.png") });
  r = await revision();
  await page.click("[data-testid=insp-adjust-reset]");
  await waitRevision(r + 1);
  assert.ok(!effectsOf("c0")!.some((e) => e.module === "effect.color"));

  // A drag onto another clip in the timeline adds the effect there.
  await page.click("[data-testid=rail-effects]");
  await page.waitForSelector("[data-testid=effect-tile][data-module='effect.mirror']");
  await page.setDragInterception(true);
  const tile = await box("[data-testid=effect-tile][data-module='effect.mirror']");
  const target = await box("[data-testid=timeline-item][data-item=c1]");
  const at = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const data = await page.mouse.drag({ x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 }, at);
  await page.mouse.dragEnter(at, data);
  await page.mouse.dragOver(at, data);
  r = await revision();
  await page.mouse.drop(at, data);
  await page.setDragInterception(false);
  await page.mouse.up();
  await waitRevision(r + 1);
  assert.deepEqual(effectsOf("c1")!.at(-1), { module: "effect.mirror" });

  // A lost WebGL context: the plain picture shows until it's back, then the effects again.
  await goTo(45);
  await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>("canvas[data-fx=c1]")?.style.visibility === "");
  await page.evaluate(() => (window as unknown as { lose: WEBGL_lose_context }).lose = document.querySelector<HTMLCanvasElement>("canvas[data-fx=c1]")!.getContext("webgl2")!.getExtension("WEBGL_lose_context")!);
  await page.evaluate(() => (window as unknown as { lose: WEBGL_lose_context }).lose.loseContext());
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector<HTMLElement>(".pv-box[data-item=c1] > video")!.style.visibility === "" && document.querySelector<HTMLCanvasElement>("canvas[data-fx=c1]")!.style.visibility === "hidden", { timeout: 5000 });
  await page.evaluate(() => (window as unknown as { lose: WEBGL_lose_context }).lose.restoreContext());
  await page.waitForFunction(() => document.querySelector<HTMLElement>(".pv-box[data-item=c1] > video")!.style.visibility === "hidden" && document.querySelector<HTMLCanvasElement>("canvas[data-fx=c1]")!.style.visibility === "", { timeout: 5000 });
  assert.deepEqual(app.errors.filter((e) => !/WebGL|context/i.test(e)), []);
});
