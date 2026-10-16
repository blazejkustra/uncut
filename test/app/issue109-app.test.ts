// Issue #109 (D287) on the packaged app (background window), through the UI:
// - the Elements tab offers the Follow card (Social) and Steps (Info), each tile its real drawing;
// - a follow card with the user's logo draws it with the platform's badge; its handle typed and its
//   platform switched to Instagram in the Inspector redraw it (Instagram's mark, its colour);
// - Steps added with +, its first step retyped and a step added in the Inspector, each one edit;
// - the preview vs a Standard export at two frames (mid-motion and settled): SSIM ≥ 0.97.
// Screenshots: test-output/issue109-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Item, Project } from "../../packages/core/src/index.ts";
import { BRAND_ICONS } from "../../packages/core/src/visual/brandIcons.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { NO_REAL_GPU, check } from "../helpers/capabilities.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to read the export") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="#1F3A5F"/><path d="M26 66l15-30 10 18 8-10 15 22z" fill="#FFC531"/></svg>`;

const project = (media: string): Project => ({
  format: "uncut/0",
  name: "Cards",
  canvas: { width: 1280, height: 720, fps: 30 },
  media: [{ id: "m-logo", kind: "image", name: "Logo.svg", path: join(media, "Logo.svg"), probe: { width: 100, height: 100 } }],
  tracks: [
    { id: "cards", kind: "video", name: "Cards", items: [{ id: "card", type: "component", component: "component.follow-card", start: 0, duration: 120, props: { handle: "@blazejkustra", title: "Follow for more", button: "Follow", platform: "youtube", logo: { media: "m-logo" } }, transform: { x: 40, y: 440, w: 640, h: 185 } } as Item] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: 120, props: { color: "#1F3A5F", to: "#5F2F4A", angle: 135 } }] },
  ],
});

const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const items = () => onDisk().tracks.flatMap((t) => t.items);
const item = (id: string): Item | undefined => items().find((i) => i.id === id);
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) => page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r, { timeout: 10000 }, n);
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
  const path = out("issue109-red-probe.png");
  await (await page.$("#red-probe"))!.screenshot({ path });
  await page.evaluate(() => document.getElementById("red-probe")!.remove());
  const [r, g, b] = [...execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vf", "crop=8:8:16:16,scale=1:1,format=rgb24", "-f", "rawvideo", "-"])];
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue109-app-")));
  const media = join(root, "media");
  mkdirSync(media);
  writeFileSync(join(media, "Logo.svg"), LOGO_SVG);
  dir = writeProject(root, "Cards", project(media));
  mkdirSync(join(root, "out"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issue 109: Follow card and Steps in Elements, drawn, edited in the Inspector; preview = export", { skip, timeout: 300000 }, async () => {
  const saveAs = join(root, "out", "Cards.mp4");
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });

  // The Elements tab: the follow card under Social, the steps under Info, both drawn as their tiles.
  await page.click("[data-testid=rail-elements]");
  await page.waitForSelector("[data-testid=elements-category]");
  const inSection = (cat: string) => page.$$eval(`[data-testid=elements-category][data-category="${cat}"] [data-testid=component-tile]`, (els) => els.map((e) => (e as HTMLElement).dataset.component));
  assert.ok((await inSection("Social")).includes("component.follow-card"));
  assert.ok((await inSection("Info")).includes("component.steps"));
  for (const id of ["component.follow-card", "component.steps"]) assert.ok(await page.$(`[data-testid=component-tile][data-component="${id}"] [data-testid=component-thumb] .pv-comp`), `${id}: its real drawing`);
  await page.select("[data-testid=elements-section]", "Social");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=elements-category]").length === 1);
  await (await page.$("[data-testid=elements-library]"))!.screenshot({ path: out("issue109-social.png") });
  await page.select("[data-testid=elements-section]", "");
  // Search finds the steps by what people call them.
  await page.type("[data-testid=sticker-search]", "tutorial");
  await page.waitForFunction(() => !!document.querySelector('[data-testid=component-tile][data-component="component.steps"]'));
  await page.click("[data-testid=elements-search-clear]");
  await page.waitForSelector("[data-testid=elements-section]");

  // The follow card with the user's logo: the image, YouTube's badge and button.
  await goTo(60);
  const drawn = (id: string) => page.$eval(`.pv-comp[data-item="${id}"]`, (el) => el.innerHTML);
  let card = await drawn("card");
  assert.match(card, /<img src="[^"]+"/, "the logo");
  assert.match(card, /data-badge="youtube"/);
  assert.ok(card.includes(BRAND_ICONS.youtube!.path));
  assert.match(card, />@blazejkustra</);

  // Steps with + at frame 0.
  await goTo(0);
  await page.click("[data-testid=rail-elements]");
  const r0 = await revision();
  await page.hover("[data-testid=component-tile][data-component='component.steps']");
  await page.click("[data-testid=component-tile][data-component='component.steps'] [data-testid=component-add]");
  await waitRevision(r0 + 1);
  const steps = items().find((i) => i.component === "component.steps")!;
  assert.ok(steps, "the steps are in the project");
  assert.equal(steps.start, 0);
  // Its first step retyped, then a fourth step added.
  await page.waitForSelector(`[data-testid=inspector-item][data-item="${steps.id}"] [data-testid=param-steps-text]`);
  const first = (await page.$$("[data-testid=param-steps-text]"))[0]!;
  await first.click({ clickCount: 3 });
  await page.keyboard.type("Charge the batteries");
  await page.keyboard.press("Enter");
  await waitRevision(r0 + 2);
  assert.equal((item(steps.id)!.props!.steps as Array<{ text: string }>)[0]!.text, "Charge the batteries");
  await page.click("[data-testid=param-sec-steps] [data-testid=param-row-add]");
  await waitRevision(r0 + 3);
  assert.equal((item(steps.id)!.props!.steps as Array<unknown>).length, 4);
  const added = (await page.$$("[data-testid=param-steps-text]"))[3]!;
  await added.click();
  await page.keyboard.type("Share it");
  await page.keyboard.press("Enter");
  await waitRevision(r0 + 4);
  await sleep(200);
  await page.screenshot({ path: out("issue109-steps-inspector.png") });

  // The follow card: handle typed, platform switched to Instagram.
  await goTo(60);
  const b = (await (await page.$('.pv-comp[data-item="card"]'))!.boundingBox())!;
  await page.mouse.click(b.x + b.width * 0.3, b.y + b.height * 0.5);
  await page.waitForSelector('[data-testid=inspector-item][data-item="card"] [data-testid=param-platform]', { timeout: 10000 });
  const r1 = await revision();
  const handle = (await page.$("[data-testid=param-handle]"))!;
  await handle.click({ clickCount: 3 });
  await page.keyboard.type("@uncut.app");
  await page.keyboard.press("Enter");
  await waitRevision(r1 + 1);
  await page.select("[data-testid=param-platform]", "instagram");
  await waitRevision(r1 + 2);
  await page.waitForFunction(() => document.querySelector('.pv-comp[data-item="card"]')?.innerHTML.includes('data-badge="instagram"'), { timeout: 10000 });
  card = await drawn("card");
  assert.ok(card.includes(BRAND_ICONS.instagram!.path), "Instagram's mark");
  assert.ok(card.toLowerCase().includes(BRAND_ICONS.instagram!.hex.toLowerCase()), "in its colour");
  assert.match(card, />@uncut\.app</);
  assert.deepEqual(item("card")!.props, { handle: "@uncut.app", title: "Follow for more", button: "Follow", platform: "instagram", logo: { media: "m-logo" } });
  await sleep(200);
  await page.screenshot({ path: out("issue109-card-inspector.png") });

  const labels = historyLabels();
  console.log(`  history: ${labels.join(" | ")}`);
  assert.equal(labels.length, 6);
  assert.equal(labels[0], "Add steps");

  // The preview vs a Standard export: frame 20 (the card and the first step coming in) and 100 (settled).
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Escape");
  const space = await screenshotSpace();
  const shots = new Map<number, string>();
  for (const f of [20, 100]) {
    await goTo(f);
    const path = out(`issue109-preview-${f}.png`);
    await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
    shots.set(f, space === "p3" ? toSrgb(path) : path);
  }
  await meta("e");
  await page.waitForSelector("[data-testid=export-form]");
  await page.click("[data-testid=quality-standard]");
  await page.click("[data-testid=loudness-off]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Cards.mp4");
  await page.click("[data-testid=export-start]");
  await page.waitForSelector("[data-testid=export-job]");
  let phase = "";
  for (let i = 0; i < 1800 && phase !== "done" && phase !== "failed"; i++) {
    phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
    await sleep(100);
  }
  assert.equal(phase, "done", await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? ""));
  for (const f of [20, 100]) {
    const exported = out(`issue109-export-${f}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${f})`, "-frames:v", "1", "-update", "1", exported]);
    const score = ssim(shots.get(f)!, exported);
    console.log(`  frame ${f}: export vs preview SSIM ${score.toFixed(4)} (screenshots in ${space})`);
    check(NO_REAL_GPU, score >= 0.97, `frame ${f}: SSIM ${score}`);
  }
  assert.deepEqual(app.errors, []);
});
