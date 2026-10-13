// Phase 6 chunk 4 (D80, D81) on the packaged app (background window), through the UI only:
// - the Text tab's grid of looks, each tile a thumbnail drawn with core's textHtml;
// - a big title clicked in (its zoom-in comes along), a caption dragged onto the canvas (placed
//   where it lands), a highlight line (word by word) clicked in at a later frame;
// - the Style tab: outline on and its width, a shadow, a box and its padding, each one edit;
//   ⌘Z / ⇧⌘Z; Reset to preset; History labels;
// - the preview vs a Standard export at a word-by-word mid frame and a zoom mid frame (SSIM ≥ 0.97).
// Screenshots: test-output/text-{presets,style,words}.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { TEXT_PRESETS, type Item, type Project } from "../../packages/core/src/index.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);

const project = (): Project => ({
  format: "uncut/0",
  name: "Text looks",
  canvas: { width: 1280, height: 720, fps: 30 },
  media: [],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: 240, props: { color: "#203040", to: "#402838", angle: 135 } }] },
  ],
});

const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const item = (id: string): Item | undefined => onDisk().tracks.flatMap((t) => t.items).find((i) => i.id === id);
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
  await sleep(300);
}
async function select(id: string) {
  const b = (await (await page.$(`[data-testid=timeline-item][data-item="${id}"]`))!.boundingBox())!;
  await page.mouse.click(b.x + b.width - 12, b.y + b.height / 2);
  await page.waitForSelector(`[data-testid=inspector-item][data-item="${id}"] [data-testid=text-editor]`);
}
/** Type into a number field and commit with Enter. */
async function field(testId: string, value: string) {
  const el = (await page.$(`[data-testid=${testId}]`))!;
  await el.click({ clickCount: 3 });
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
}
const box = async (selector: string) => (await (await page.$(selector))!.boundingBox())!;
const ssim = (a: string, b: string) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
};

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-text-looks-app-")));
  dir = writeProject(root, "Text looks", project());
  mkdirSync(join(root, "out"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("text looks: the grid, click and drag in, the Style tab (outline, shadow, box), undo/redo, reset, history, preview = export for word by word and zoom", { skip, timeout: 360000 }, async () => {
  const saveAs = join(root, "out", "Text looks.mp4");
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") } });
  page = app.page;
  await page.waitForSelector("[data-testid=welcome]", { timeout: 15000 });
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });

  // The grid: every preset a tile with a real thumbnail (core textHtml, laid out and scaled in).
  await page.click("[data-testid=rail-text]");
  await page.waitForSelector("[data-testid=text-grid]");
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>("[data-testid=text-thumb] .text-thumb-inner")].every((el) => el.style.transform && !el.style.transform.includes("scale(0)")), { timeout: 5000 });
  const tiles = await page.$$eval("[data-testid=text-preset]", (els) =>
    els.map((e) => {
      const thumb = e.querySelector<HTMLElement>("[data-testid=text-thumb]")!.getBoundingClientRect();
      const texts = [...e.querySelectorAll<HTMLElement>(".tt-text")].map((t) => {
        const range = document.createRange();
        range.selectNodeContents(t);
        return range.getBoundingClientRect();
      });
      // The text is drawn inside its tile, at a readable size: glyphs over 6 px tall and about 5 px or more per
      // character (a flat 20 px failed the boxed label's 3-letter "New", 19.5 px wide in DM Sans at the tile's scale).
      const lengths = [...e.querySelectorAll<HTMLElement>(".tt-text")].map((t) => (t.textContent ?? "").trim().length);
      const inside = texts.length > 0 && texts.every((r, i) => r.width > Math.min(20, 5 * lengths[i]!) && r.height > 6 && r.left >= thumb.left - 1 && r.right <= thumb.right + 1);
      return [(e as HTMLElement).dataset.module, inside];
    }),
  );
  console.log("DEBUG", await page.$eval('[data-testid=text-preset][data-module="text.boxed-label"]', (e) => JSON.stringify({ thumb: e.querySelector("[data-testid=text-thumb]")!.getBoundingClientRect(), texts: [...e.querySelectorAll<HTMLElement>(".tt-text")].map((t) => { const r = document.createRange(); r.selectNodeContents(t); return [r.getBoundingClientRect(), t.textContent, getComputedStyle(t).fontSize, getComputedStyle(t).fontFamily]; }), inner: (e.querySelector(".text-thumb-inner") as HTMLElement).style.transform, win: [innerWidth, innerHeight] })));
  assert.deepEqual(tiles, TEXT_PRESETS.map((p) => [p.module, true]));
  assert.equal(await page.$$eval(".pv-text", (els) => els.length), 0, "tiles don't use the preview's text class");
  await page.screenshot({ path: out("text-presets.png") });

  // A big title clicked in at frame 0: the look's size, the safe-area box and its zoom-in.
  const r0 = await revision();
  await page.click("[data-testid=text-preset][data-preset=big-title]");
  await waitRevision(r0 + 1);
  assert.deepEqual(item("big-title-1"), { id: "big-title-1", type: "text", start: 0, duration: 90, text: "Your title", transform: { x: 48, y: 259, w: 1184 }, style: { preset: "text.big-title", size: 108, weight: 800 }, animation: { in: { module: "move.zoom", duration: 18, params: { scale: 0.85, ease: "out", fade: true } } } });

  // A caption dragged onto the canvas at frame 90: placed at the playhead, its line on the drop's height.
  await goTo(90);
  await page.click("[data-testid=rail-text]");
  const frame = await box("[data-testid=preview-frame]");
  const k = frame.width / 1280;
  await page.setDragInterception(true);
  const tile = await box("[data-testid=text-preset][data-preset=caption]");
  const target = { x: frame.x + frame.width / 2, y: frame.y + 200 * k };
  const r1 = await revision();
  const data = await page.mouse.drag({ x: tile.x + tile.width / 2, y: tile.y + tile.height / 3 }, target);
  await page.mouse.dragEnter(target, data);
  await page.mouse.dragOver(target, data);
  await page.mouse.drop(target, data);
  await page.setDragInterception(false);
  await page.mouse.up();
  await waitRevision(r1 + 1);
  const caption = item("caption-1")!;
  assert.equal(caption.start, 90);
  assert.ok(Math.abs(caption.transform!.y! + (32 * 1.4) / 2 - 200) <= 3, `dropped at y 200: ${caption.transform!.y}`);
  assert.equal(caption.transform!.x, 48, "a spanning look keeps its safe-area box");

  // A highlight line (word by word, 0.8 s) clicked in at frame 150.
  await goTo(150);
  await page.click("[data-testid=rail-text]");
  const r2 = await revision();
  await page.click("[data-testid=text-preset][data-preset=highlight]");
  await waitRevision(r2 + 1);
  assert.deepEqual(item("highlight-1")!.animation, { in: { module: "move.word-by-word", duration: 24, params: { style: "pop" } } });
  // Mid-reveal in the preview: the first words in, the later ones not yet.
  await goTo(160);
  const opacities = await page.$$eval('.pv-text[data-item="highlight-1"] .pv-w', (els) => els.map((e) => Number(getComputedStyle(e).opacity)));
  assert.equal(opacities.length, 4);
  assert.ok(opacities[0] === 1 && opacities[3] === 0, `words in turn: ${opacities}`);
  await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path: out("text-words.png") });

  // The Style tab on the big title: outline on, its width, a shadow, a box, its padding: one edit each.
  await goTo(40);
  await select("big-title-1");
  const r3 = await revision();
  await page.click("[data-testid=insp-stroke-on]");
  await waitRevision(r3 + 1);
  assert.deepEqual(item("big-title-1")!.style!.stroke, { width: 4, color: "#000000" });
  await field("insp-stroke-width", "6");
  await waitRevision(r3 + 2);
  await page.click("[data-testid=insp-shadow-on]");
  await waitRevision(r3 + 3);
  assert.deepEqual(item("big-title-1")!.style!.shadow, { x: 0, y: 4, blur: 16, color: "#000000", opacity: 0.6 });
  await page.click("[data-testid=insp-box][data-wrap=box]");
  await waitRevision(r3 + 4);
  await field("insp-box-padding", "30");
  await waitRevision(r3 + 5);
  assert.deepEqual(item("big-title-1")!.style, { preset: "text.big-title", size: 108, weight: 800, stroke: { width: 6, color: "#000000" }, shadow: { x: 0, y: 4, blur: 16, color: "#000000", opacity: 0.6 }, background: { color: "#000000", opacity: 0.7, padding: 30, radius: 19, wrap: "box" } });
  const css = await page.$eval('.pv-text[data-item="big-title-1"]', (el) => {
    const c = getComputedStyle(el);
    return [c.webkitTextStrokeWidth, c.webkitTextStrokeColor, c.paintOrder, c.textShadow, c.backgroundColor, c.paddingTop, c.paddingLeft, c.borderTopLeftRadius];
  });
  assert.deepEqual(css, ["6px", "rgb(0, 0, 0)", "stroke", "rgba(0, 0, 0, 0.6) 0px 4px 16px", "rgba(0, 0, 0, 0.7)", "15px", "30px", "19px"]);
  await page.screenshot({ path: out("text-style.png") });

  // ⌘Z twice: the padding, then the box go; ⇧⌘Z puts the box back.
  await page.click("[data-testid=timeline]");
  await meta("z");
  await waitRevision(r3 + 6);
  assert.equal((item("big-title-1")!.style!.background as { padding: number }).padding, 38, "⌘Z: the default padding");
  await meta("z");
  await waitRevision(r3 + 7);
  assert.equal(item("big-title-1")!.style!.background, undefined, "⌘Z: no box");
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.pv-text[data-item="big-title-1"]')!).backgroundColor === "rgba(0, 0, 0, 0)");
  await meta("z", true);
  await waitRevision(r3 + 8);
  assert.equal((item("big-title-1")!.style!.background as { padding: number }).padding, 38, "⇧⌘Z: the box again");

  // Reset to preset: the look's style again.
  await select("big-title-1");
  await page.click("[data-testid=insp-reset-look]");
  await waitRevision(r3 + 9);
  assert.deepEqual(item("big-title-1")!.style, { preset: "text.big-title", size: 108, weight: 800 });

  const labels = historyLabels();
  console.log(`  history: ${labels.join(" | ")}`);
  assert.deepEqual(labels, ["Add big title", "Add caption", "Add highlight word", "Outline text: 4 px", "Outline text: 6 px", "Add text shadow", "Put text on a box", "Change text box", "Undo", "Undo", "Redo", "Reset text to Big title"].filter((l) => l !== "Undo" && l !== "Redo"));

  // Give the title a stroke again so the export compares a stroked zoom; then the preview vs a
  // Standard export at the zoom's middle (frame 9) and word by word's (frame 160).
  await select("big-title-1");
  const r4 = await revision();
  await page.click("[data-testid=insp-stroke-on]");
  await waitRevision(r4 + 1);
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Escape");
  const shots = new Map<number, string>();
  for (const f of [9, 100, 160]) {
    await goTo(f);
    const path = out(`text-preview-${f}.png`);
    await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
    shots.set(f, path);
  }
  await meta("e");
  await page.waitForSelector("[data-testid=export-form]");
  await page.click("[data-testid=quality-standard]");
  await page.click("[data-testid=loudness-off]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Text looks.mp4");
  await page.click("[data-testid=export-start]");
  await page.waitForSelector("[data-testid=export-job]");
  let phase = "";
  for (let i = 0; i < 1800 && phase !== "done" && phase !== "failed"; i++) {
    phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
    await sleep(100);
  }
  assert.equal(phase, "done", await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? ""));
  for (const f of [9, 100, 160]) {
    const exported = out(`text-export-app-${f}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${f})`, "-frames:v", "1", "-update", "1", exported]);
    const score = ssim(shots.get(f)!, exported);
    console.log(`  frame ${f}: export vs preview SSIM ${score.toFixed(4)}`);
    assert.ok(score >= 0.97, `frame ${f}: SSIM ${score}`);
  }
  assert.deepEqual(app.errors, []);
});
