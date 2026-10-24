// Issue #71 (D251) on the packaged app (background window), through the UI only:
// - the Elements tab in sections (Titles & text, Social, Info, Shapes & media, Stickers) with
//   section chips (one section at a time) and one search over elements and stickers; stickers in
//   their own sections (Reactions, Arrows & marks, Shapes & bursts, Bubbles, Badges, Social, Emoji);
// - a hand-drawn circle dragged from the stickers onto the canvas (it lands where it's dropped, at
//   its own wide shape); a sale tag clicked in at the playhead, its words and its loop edited in the
//   Inspector; a social button added with +; each change one labelled edit;
// - the preview vs a Standard export at two frames: SSIM ≥ 0.97.
// Screenshots: test-output/issue71-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Item, Project } from "../../packages/core/src/index.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to read the export") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);

const project = (): Project => ({
  format: "uncut/0",
  name: "Stickers",
  canvas: { width: 1280, height: 720, fps: 30 },
  media: [],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [] },
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [{ id: "bg", type: "component", component: "component.solid", duration: 120, props: { color: "#1F3A5F", to: "#5F2F4A", angle: 135 } }],
    },
  ],
});

const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const items = () => onDisk().tracks.flatMap((t) => t.items);
const item = (id: string): Item | undefined => items().find((i) => i.id === id);
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) =>
  page.waitForFunction(
    (r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r,
    { timeout: 10000 },
    n,
  );
const meta = async (key: Parameters<Page["keyboard"]["press"]>[0]) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key);
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
  await page.evaluate(() => document.fonts.ready);
  await sleep(300);
}
const box = async (selector: string) => (await (await page.$(selector))!.boundingBox())!;
const categories = () => page.$$eval("[data-testid=elements-category]", (els) => els.map((e) => (e as HTMLElement).dataset.category));
const ssim = (a: string, b: string) => {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
};
async function screenshotSpace(): Promise<"srgb" | "p3"> {
  await page.evaluate(() => {
    const e = document.createElement("div");
    e.id = "red-probe";
    e.style.cssText = "position:fixed;left:0;top:0;width:40px;height:40px;background:#f00;z-index:99999";
    document.body.append(e);
  });
  const path = out("issue71-red-probe.png");
  await (await page.$("#red-probe"))!.screenshot({ path });
  await page.evaluate(() => document.getElementById("red-probe")!.remove());
  const [r, g, b] = [...execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vf", "crop=8:8:16:16,scale=1:1,format=rgb24", "-f", "rawvideo", "-"])];
  if (r! > 250 && g! < 5 && b! < 5) return "srgb";
  if (Math.abs(r! - 234) <= 3 && Math.abs(g! - 51) <= 3 && Math.abs(b! - 35) <= 3) return "p3";
  throw new Error(`screenshots are in neither sRGB nor Display P3: pure red came back as ${r},${g},${b}`);
}
function toSrgb(png: string) {
  const outPath = png.replace(/\.png$/, "-srgb.png");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    png,
    "-vf",
    "scale=out_color_matrix=bt709:out_range=pc,format=yuv444p,setparams=color_primaries=smpte432:color_trc=iec61966-2-1:colorspace=bt709:range=pc,colorspace=primaries=bt709:trc=iec61966-2-1:space=bt709:range=pc:format=yuv444p,scale=in_color_matrix=bt709:in_range=pc,format=rgb24",
    outPath,
  ]);
  return outPath;
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue71-app-")));
  dir = writeProject(root, "Stickers", project());
  mkdirSync(join(root, "out"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issue 71: Elements sections, chips and search; stickers dropped on the canvas and edited; preview = export", { skip, timeout: 300000 }, async () => {
  const saveAs = join(root, "out", "Stickers.mp4");
  app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") },
  });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });

  // The sections, in order, each with its tiles; the stickers' own sections.
  await page.click("[data-testid=rail-elements]");
  await page.waitForSelector("[data-testid=elements-category]");
  assert.deepEqual(await categories(), ["Titles & text", "Social", "Info", "Shapes & media", "Stickers"]);
  const inSection = (cat: string) =>
    page.$$eval(`[data-testid=elements-category][data-category="${cat}"] [data-testid=component-tile]`, (els) =>
      els.map((e) => (e as HTMLElement).dataset.component),
    );
  assert.deepEqual(await inSection("Social"), ["component.subscribe", "component.social-button", "component.follow", "component.follow-card"]);
  assert.ok(
    (await inSection("Info")).includes("component.price-tag") &&
      (await inSection("Info")).includes("component.map-pin") &&
      (await inSection("Info")).includes("component.checklist"),
  );
  assert.ok((await inSection("Titles & text")).includes("component.quote") && (await inSection("Titles & text")).includes("component.before-after"));
  const groups = await page.$$eval("[data-testid=sticker-group]", (els) => els.map((e) => (e as HTMLElement).dataset.group));
  assert.deepEqual(groups, ["Reactions", "Arrows & marks", "Shapes & bursts", "Bubbles", "Badges", "Social", "Emoji"]);
  // Every tile's thumbnail is its real HTML.
  assert.equal(
    await page.$$eval("[data-testid=component-tile]", (els) => els.filter((e) => !e.querySelector("[data-testid=component-thumb] .pv-comp")).length),
    0,
  );
  await (await page.$("[data-testid=elements-library]"))!.screenshot({ path: out("issue71-panel.png") });

  // #86 (D263): a tile's + names itself in the app's tooltip, not a native title.
  const add = "[data-testid=component-tile][data-component='component.lower-third'] [data-testid=component-add]";
  assert.equal(await page.$eval(add, (el) => el.getAttribute("title")), null, "no native title on +");
  await page.hover("[data-testid=component-tile][data-component='component.lower-third']");
  await page.hover(add);
  await page.waitForSelector("[data-testid=tooltip]", { timeout: 3000 });
  assert.match(await page.$eval("[data-testid=tooltip]", (el) => el.textContent ?? ""), /^Add lower third at the playhead$/);
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => !document.querySelector("[data-testid=tooltip]"), { timeout: 3000 });

  // The section select (no chips, D263) shows one section; All sections shows them all again.
  assert.equal(await page.$("[data-testid=elements-chip], .chip-btn"), null, "no chips");
  await page.select("[data-testid=elements-section]", "Social");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=elements-category]").length === 1);
  assert.deepEqual(await categories(), ["Social"]);
  await (await page.$("[data-testid=elements-library]"))!.screenshot({ path: out("issue71-social.png") });
  await page.select("[data-testid=elements-section]", "Stickers");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=elements-category]")?.dataset.category === "Stickers");
  await (await page.$("[data-testid=elements-library]"))!.screenshot({ path: out("issue71-stickers.png") });
  await page.select("[data-testid=elements-section]", "");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=elements-category]").length === 5);

  // One search over elements and stickers: "sale" finds the price tag and the sale stickers.
  await page.type("[data-testid=sticker-search]", "sale");
  await page.waitForFunction(() => !document.querySelector("[data-testid=elements-section]"));
  assert.deepEqual(await categories(), ["Info", "Stickers"]);
  assert.deepEqual(await inSection("Info"), ["component.price-tag"]);
  const found = await page.$$eval("[data-testid=sticker]", (els) => els.map((e) => (e as HTMLElement).dataset.key));
  assert.ok(found.includes("art:sale") && found.includes("art:seal"), JSON.stringify(found));
  await (await page.$("[data-testid=elements-library]"))!.screenshot({ path: out("issue71-search.png") });
  await page.click("[data-testid=elements-search-clear]");
  await page.waitForSelector("[data-testid=elements-section]");

  // Drag the hand-drawn circle onto the canvas at frame 15: it lands centred where it's dropped, wide.
  await goTo(15);
  const frame = await box("[data-testid=preview-frame]");
  const k = frame.width / 1280;
  await page.$eval('[data-testid=sticker][data-key="art:circle-hand"]', (el) => el.scrollIntoView({ block: "center" }));
  await sleep(200);
  const tile = await box('[data-testid=sticker][data-key="art:circle-hand"]');
  const drop = { x: frame.x + 400 * k, y: frame.y + 300 * k };
  await page.setDragInterception(true);
  const r0 = await revision();
  const data = await page.mouse.drag({ x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 }, drop);
  await page.mouse.dragEnter(drop, data);
  await page.mouse.dragOver(drop, data);
  await page.mouse.drop(drop, data);
  await page.setDragInterception(false);
  await page.mouse.up();
  await waitRevision(r0 + 1);
  const circle = items().find((i) => i.props?.art === "circle-hand")!;
  assert.ok(circle, "the circle is in the project");
  assert.equal(circle.component, "component.sticker");
  assert.equal(circle.props!.enter, "draw", "a mark draws on");
  assert.equal(circle.start, 15);
  const t = circle.transform!;
  assert.ok(Math.abs(t.w! / t.h! - 560 / 300) < 0.02, `its own wide shape: ${t.w}×${t.h}`);
  assert.ok(Math.abs(t.x! + t.w! / 2 - 400) <= 3 && Math.abs(t.y! + t.h! / 2 - 300) <= 3, `centred on the drop: ${JSON.stringify(t)}`);

  // Click the sale tag in at frame 30, then edit its words and give it a wiggle in the Inspector.
  await goTo(30);
  await page.click("[data-testid=rail-elements]");
  const r1 = await revision();
  await page.click('[data-testid=sticker][data-key="art:sale"]');
  await waitRevision(r1 + 1);
  const sale = items().find((i) => i.props?.art === "sale")!;
  assert.ok(sale);
  assert.equal(sale.start, 30);
  await page.waitForSelector(`[data-testid=inspector-item][data-item="${sale.id}"] [data-testid=param-text]`);
  const text = (await page.$("[data-testid=param-text]"))!;
  await text.click({ clickCount: 3 });
  await page.keyboard.type("-40%");
  await page.keyboard.press("Enter");
  await waitRevision(r1 + 2);
  assert.equal(item(sale.id)!.props!.text, "-40%");
  await page.waitForFunction((id) => document.querySelector(`.pv-comp[data-item="${id}"] text`)?.textContent === "-40%", {}, sale.id);
  await page.select("[data-testid=param-loop]", "wiggle");
  await waitRevision(r1 + 3);
  assert.equal(item(sale.id)!.props!.loop, "wiggle");
  // The older pop switch has no control (D251).
  assert.equal(await page.$("[data-testid=param-pop]"), null);

  // A social button with + at frame 0, its kind set to bell.
  await goTo(0);
  await page.click("[data-testid=rail-elements]");
  const r2 = await revision();
  await page.hover("[data-testid=component-tile][data-component='component.social-button']");
  await page.click("[data-testid=component-tile][data-component='component.social-button'] [data-testid=component-add]");
  await waitRevision(r2 + 1);
  const button = items().find((i) => i.component === "component.social-button")!;
  await page.waitForSelector(`[data-testid=inspector-item][data-item="${button.id}"] [data-testid=param-kind]`);
  await page.select("[data-testid=param-kind]", "bell");
  await waitRevision(r2 + 2);
  assert.equal(item(button.id)!.props!.kind, "bell");

  const labels = historyLabels();
  console.log(`  history: ${labels.join(" | ")}`);
  assert.deepEqual(labels, [
    "Add sticker hand-drawn circle",
    "Add sticker sale tag",
    "Change text of sticker",
    "Set loop of sticker to wiggle",
    "Add social button",
    "Set kind of social button to bell",
  ]);

  // The preview vs a Standard export at two frames (the circle drawn, the tag wiggling, the button pressed).
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Escape");
  const space = await screenshotSpace();
  const shots = new Map<number, string>();
  for (const f of [44, 70]) {
    await goTo(f);
    await page.waitForFunction((id) => !!document.querySelector(`.pv-comp[data-item="${id}"]`), {}, sale.id);
    const path = out(`issue71-preview-${f}.png`);
    await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
    shots.set(f, space === "p3" ? toSrgb(path) : path);
  }
  await meta("e");
  await page.waitForSelector("[data-testid=export-form]");
  await page.click("[data-testid=quality-standard]");
  await page.click("[data-testid=loudness-off]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Stickers.mp4");
  await page.click("[data-testid=export-start]");
  await page.waitForSelector("[data-testid=export-job]");
  let phase = "";
  for (let i = 0; i < 1800 && phase !== "done" && phase !== "failed"; i++) {
    phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
    await sleep(100);
  }
  assert.equal(phase, "done", await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? ""));
  for (const f of [44, 70]) {
    const exported = out(`issue71-export-${f}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${f})`, "-frames:v", "1", "-update", "1", exported]);
    const score = ssim(shots.get(f)!, exported);
    console.log(`  frame ${f}: export vs preview SSIM ${score.toFixed(4)} (screenshots in ${space})`);
    assert.ok(score >= 0.97, `frame ${f}: SSIM ${score}`);
  }
  assert.deepEqual(app.errors, []);
});
