// Phase 6 chunk 2 (D76, D77) on the packaged app (background window), through the UI only:
// - the Elements tab's Components grid, each tile a thumbnail drawn from the component's real HTML;
// - the end card dragged from Elements onto the canvas (it lands at the playhead), its title typed
//   and its logo (an SVG) picked in the Inspector built from the manifest, ⌘Z / ⇧⌘Z;
// - a device frame added with +, footage put in it from its Inspector (a clip under it, on its
//   screen); a chart added with +, a bar's value changed in its list;
// - every change one edit with its History label;
// - DM Sans text measures the same in the preview and in the export's rasteriser (within 0.2 %);
// - the preview vs a Standard export: the end card at SSIM ≥ 0.99, the device frame ≥ 0.97.
// Screenshots: test-output/components-{panel,device,endcard,chart}.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { RENDER_CSS, textHtml, type Item, type Project } from "../../packages/core/src/index.ts";
import { rasterizerCommand, startRasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { NO_REAL_GPU, check } from "../helpers/capabilities.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the test media") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><rect width="200" height="60" rx="12" fill="#ff8800"/><circle cx="30" cy="30" r="16" fill="#fff"/></svg>`;
const GRAPHIC = `<div id="sq" style="position:absolute;top:100px;left:0;width:200px;height:200px;background:#00ff00"></div>
<script>window.render = (t) => { document.getElementById("sq").style.left = Math.round(t * 600) + "px"; };</script>`;
const DM_TEXT: Item = { id: "dm", type: "text", start: 0, duration: 60, text: "Typeset in DM Sans, measured twice", transform: { x: 60, y: 560 }, style: { font: "DM Sans", size: 64, weight: 600, color: "fg" } };

function project(media: string): Project {
  return {
    format: "uncut/0",
    name: "Components",
    canvas: { width: 1280, height: 720, fps: 30 },
    media: [
      { id: "m-screen", kind: "video", name: "Screen.mp4", path: join(media, "Screen.mp4"), probe: { frames: 150, fps: 30, width: 540, height: 960, hasAudio: false } },
      { id: "m-logo", kind: "image", name: "Logo.svg", path: join(media, "Logo.svg"), probe: { width: 200, height: 60 } },
    ],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [DM_TEXT] },
      { id: "gfx", kind: "video", name: "Graphic", items: [{ id: "move", type: "graphic", src: "graphics/move.html", start: 240, duration: 30 }] },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: 300, props: { color: "#203040", to: "#402838", angle: 135 } }] },
    ],
  };
}

const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const items = () => onDisk().tracks.flatMap((t) => t.items);
const item = (id: string): Item | undefined => items().find((i) => i.id === id);
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
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(frame / 30); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < frame % 30; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, frame);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => v.style.opacity === "0" || (!v.seeking && v.readyState >= 2)), { timeout: 10000 });
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
  await sleep(300);
}
async function select(id: string) {
  const b = (await (await page.$(`[data-testid=timeline-item][data-item="${id}"]`))!.boundingBox())!;
  await page.mouse.click(b.x + b.width - 12, b.y + b.height / 2);
  await page.waitForSelector(`[data-testid=inspector-item][data-item="${id}"] [data-testid=component-editor]`);
}
const box = async (selector: string) => (await (await page.$(selector))!.boundingBox())!;
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
  const path = out("components-red-probe.png");
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-components-app-")));
  const media = join(root, "media");
  mkdirSync(media);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=540x960:r=30", "-t", "5", "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-c:v", "libx264", "-crf", "16", join(media, "Screen.mp4")]);
  writeFileSync(join(media, "Logo.svg"), LOGO_SVG);
  dir = writeProject(root, "Components", project(media));
  mkdirSync(join(dir, "graphics"));
  writeFileSync(join(dir, "graphics", "move.html"), GRAPHIC);
  mkdirSync(join(root, "out"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("components: the Elements grid, drag onto the canvas, the params Inspector, undo/redo, device frame footage, a chart, DM Sans widths, preview = export", { skip, timeout: 360000 }, async () => {
  const saveAs = join(root, "out", "Components.mp4");
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });

  // The Elements grid (D130, sections D251): the general elements, the end card and the chart, each with its real
  // HTML as the thumbnail; the dev-promo components start hidden (listed under the grid).
  await page.click("[data-testid=rail-elements]");
  await page.waitForSelector("[data-testid=components-grid]");
  const tiles = await page.$$eval("[data-testid=component-tile]", (els) => els.map((e) => [(e as HTMLElement).dataset.component, !!e.querySelector("[data-testid=component-thumb] .pv-comp")]));
  // In their sections (D251): titles, social, info, shapes and media, stickers.
  assert.deepEqual(tiles, ["lower-third", "callout", "quote", "before-after", "end-card", "subscribe", "social-button", "follow", "follow-card", "progress-bar", "countdown", "checklist", "steps", "rating", "price-tag", "map-pin", "chart", "shape", "image-frame", "sticker"].map((id) => [`component.${id}`, true]));
  await page.screenshot({ path: out("components-panel.png") });

  // Drag the end card onto the canvas at frame 90: it lands there (full frame), 3 s, on a free video track.
  await goTo(90);
  await page.click("[data-testid=rail-elements]");
  const frame = await box("[data-testid=preview-frame]");
  const k = frame.width / 1280;
  await page.setDragInterception(true);
  const tile = await box("[data-testid=component-tile][data-component='component.end-card']");
  const target = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  const r0 = await revision();
  const data = await page.mouse.drag({ x: tile.x + tile.width / 2, y: tile.y + tile.height / 3 }, target);
  await page.mouse.dragEnter(target, data);
  await page.mouse.dragOver(target, data);
  await page.mouse.drop(target, data);
  await page.setDragInterception(false);
  await page.mouse.up();
  await waitRevision(r0 + 1);
  const card = items().find((i) => i.component === "component.end-card")!;
  assert.ok(card, "the end card is in the project");
  assert.deepEqual([card.start, card.duration, card.transform], [90, 90, undefined]);
  await page.waitForSelector(`[data-testid=inspector-item][data-item="${card.id}"] [data-testid=component-editor]`);

  // Its title, typed (Enter saves), and its logo picked: two edits; ⌘Z takes the logo back, ⇧⌘Z puts it back.
  const title = (await page.$("[data-testid=param-title]"))!;
  await title.click({ clickCount: 3 });
  await page.keyboard.type("Argent [[for agents]]");
  const r1 = await revision();
  await page.keyboard.press("Enter");
  await waitRevision(r1 + 1);
  assert.equal(item(card.id)!.props!.title, "Argent [[for agents]]");
  await page.select("[data-testid=param-logo]", "m-logo");
  await waitRevision(r1 + 2);
  assert.deepEqual(item(card.id)!.props!.logo, { media: "m-logo" });
  await page.waitForSelector(`.pv-comp[data-item="${card.id}"] img`);
  await page.click("[data-testid=timeline]");
  await meta("z");
  await waitRevision(r1 + 3);
  assert.equal(item(card.id)!.props!.logo, undefined, "⌘Z: no logo");
  await page.waitForFunction((id) => !document.querySelector(`.pv-comp[data-item="${id}"] img`), {}, card.id);
  await meta("z", true);
  await waitRevision(r1 + 4);
  assert.deepEqual(item(card.id)!.props!.logo, { media: "m-logo" }, "⇧⌘Z: the logo again");
  await goTo(120);
  await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path: out("components-endcard.png") });

  // A device frame with + at frame 0, then footage from its Inspector: a clip under it on its screen.
  await goTo(0);
  await page.click("[data-testid=rail-elements]");
  const r2 = await revision();
  // Hidden by default (D130): shown again from the hidden list first.
  await page.click("[data-testid=hidden-elements-toggle]");
  await page.click("[data-testid=hidden-element-tile][data-component='component.device-frame'] [data-testid=element-show]");
  await page.waitForSelector("[data-testid=component-tile][data-component='component.device-frame']");
  await page.hover("[data-testid=component-tile][data-component='component.device-frame']");
  await page.click("[data-testid=component-tile][data-component='component.device-frame'] [data-testid=component-add]");
  await waitRevision(r2 + 1);
  const device = items().find((i) => i.component === "component.device-frame")!;
  await page.waitForSelector(`[data-testid=inspector-item][data-item="${device.id}"] [data-testid=device-footage]`);
  await page.select("[data-testid=device-footage]", "m-screen");
  await waitRevision(r2 + 2);
  const screen = items().find((i) => i.type === "clip" && i.media === "m-screen")!;
  assert.ok(screen, "a clip of the footage");
  assert.equal(screen.transform!.fit, "cover");
  const devTrack = onDisk().tracks.findIndex((t) => t.items.some((i) => i.id === device.id));
  const clipTrack = onDisk().tracks.findIndex((t) => t.items.some((i) => i.id === screen.id));
  assert.ok(devTrack < clipTrack, "the clip is under the frame");
  // In the preview, the clip's box sits on the frame's screen.
  await goTo(30);
  const devEl = await box(`.pv-comp[data-item="${device.id}"]`);
  const clipEl = await box(`.pv-box[data-item="${screen.id}"]`);
  assert.ok(clipEl.x > devEl.x && clipEl.x + clipEl.width < devEl.x + devEl.width && clipEl.y > devEl.y && clipEl.y + clipEl.height < devEl.y + devEl.height, "the footage inside the frame");
  await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path: out("components-device.png") });

  // A chart with + at frame 200, its first bar's value changed in the list.
  await goTo(200);
  await page.click("[data-testid=rail-elements]");
  const r3 = await revision();
  await page.hover("[data-testid=component-tile][data-component='component.chart']");
  await page.click("[data-testid=component-tile][data-component='component.chart'] [data-testid=component-add]");
  await waitRevision(r3 + 1);
  const chart = items().find((i) => i.component === "component.chart")!;
  await page.waitForSelector(`[data-testid=inspector-item][data-item="${chart.id}"] [data-testid=param-bars]`);
  const value = (await page.$("[data-testid=param-row] [data-testid=param-bars-value]"))!;
  await value.click({ clickCount: 3 });
  await page.keyboard.type("30");
  await page.keyboard.press("Enter");
  await waitRevision(r3 + 2);
  assert.equal((item(chart.id)!.props!.bars as Array<{ value: number }>)[0]!.value, 30);
  await goTo(210);
  await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path: out("components-chart.png") });

  // One labelled edit per change.
  const labels = historyLabels();
  console.log(`  history: ${labels.join(" | ")}`);
  assert.deepEqual(labels, ["Add end card", "Change title of end card", "Set logo of end card", "Add device frame", "Put footage in the device frame", "Add chart", "Change bar 1 of chart"]);

  // DM Sans: the preview's layout width of the text vs the export rasteriser's, within 0.2 %.
  await goTo(10);
  const previewWidth = await page.$eval('.pv-text[data-item="dm"]', (el) => {
    const canvas = el.closest<HTMLElement>(".pv-canvas")!;
    return (el.getBoundingClientRect().width * canvas.offsetWidth) / canvas.getBoundingClientRect().width;
  });
  const loaded = await page.evaluate(() => document.fonts.check('600 64px "DM Sans"'));
  assert.ok(loaded, "DM Sans is loaded in the preview");
  const r = rasterizerCommand();
  assert.ok(!("problem" in r));
  const raster = await startRasterizer(r);
  const png = join(root, "dm-width.png");
  try {
    await raster.render({ width: 1280, height: 720, css: `${RENDER_CSS}\n.pv-text{background:#ff0000;text-shadow:none}`, html: textHtml(DM_TEXT, project(join(root, "media"))), out: png });
  } finally {
    await raster.close();
  }
  const row = execFileSync("ffmpeg", ["-v", "error", "-i", png, "-vf", "crop=1280:1:0:580,format=rgb24", "-f", "rawvideo", "-"]);
  let x0 = -1;
  let x1 = -1;
  for (let x = 0; x < 1280; x++) {
    const red = row[x * 3]! > 200 && row[x * 3 + 1]! < 60 && row[x * 3 + 2]! < 60;
    if (red && x0 < 0) x0 = x;
    if (red) x1 = x + 1;
  }
  const exportWidth = x1 - x0;
  const spread = Math.abs(exportWidth - previewWidth) / previewWidth;
  console.log(`  DM Sans width: preview ${previewWidth.toFixed(2)} px, export ${exportWidth} px (${(spread * 100).toFixed(3)} %)`);
  assert.ok(previewWidth > 800, `the text is wide enough to measure (${previewWidth})`);
  assert.ok(spread <= 0.002, `within 0.2 %: ${(spread * 100).toFixed(3)} %`);

  // The preview vs a Standard export at the end card (frame 120) and the device frame (frame 30).
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Escape");
  const space = await screenshotSpace();
  const shots = new Map<number, string>();
  let logoToken: string | null = null;
  for (const f of [30, 120, 255]) {
    await goTo(f);
    // The graphic (D78): its sandboxed document in the preview, render(0.5) put the square at x 300.
    if (f === 255) {
      await page.waitForSelector('.pv-graphic[data-item="move"] iframe');
      await sleep(500);
      // Its URL carries the graphic-only secret, not the server token the logo's URL carries (review).
      const frameToken = await page.$eval('.pv-graphic[data-item="move"] iframe', (el) => new URL((el as HTMLIFrameElement).src).searchParams.get("token"));
      assert.ok(frameToken && frameToken !== logoToken, "the graphic's iframe doesn't get the server token");
    }
    if (f === 120) {
      logoToken = await page.$eval(`.pv-comp[data-item="${card.id}"] img`, (el) => new URL((el as HTMLImageElement).src).searchParams.get("token"));
      // Shortly before the graphic starts, its document is loaded ahead, out of sight (review).
      await goTo(225);
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.pv-graphic[data-item="move"]')?.style.visibility === "hidden", { timeout: 5000 });
      await goTo(120);
    }
    const path = out(`components-preview-${f}.png`);
    await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
    shots.set(f, space === "p3" ? toSrgb(path) : path);
  }
  await meta("e");
  await page.waitForSelector("[data-testid=export-form]");
  await page.click("[data-testid=quality-standard]");
  await page.click("[data-testid=loudness-off]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Components.mp4");
  await page.click("[data-testid=export-start]");
  await page.waitForSelector("[data-testid=export-job]");
  let phase = "";
  for (let i = 0; i < 1800 && phase !== "done" && phase !== "failed"; i++) {
    phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
    await sleep(100);
  }
  assert.equal(phase, "done", await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? ""));
  for (const [f, min] of [[120, 0.99], [30, 0.97], [255, 0.98]] as const) {
    const exported = out(`components-export-${f}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${f})`, "-frames:v", "1", "-update", "1", exported]);
    const score = ssim(shots.get(f)!, exported);
    console.log(`  frame ${f}: export vs preview SSIM ${score.toFixed(4)} (screenshots in ${space})`);
    check(NO_REAL_GPU, score >= min, `frame ${f}: SSIM ${score}`);
  }
  assert.deepEqual(app.errors, []);
});
