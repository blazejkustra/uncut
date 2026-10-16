// Issue #71 follow-up (D275) on the packaged app (background window), through the UI: follow
// handles draw each platform's own logo in its brand colour (Simple Icons), LinkedIn and the generic
// kinds draw Uncut's glyphs; the Inspector names the platforms ("Instagram", not "instagram") and
// switching one to Bluesky redraws it in Bluesky's blue as one labelled edit.
// Screenshots: test-output/issue71-brands-preview.png, issue71-brands-inspector.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Item, Project } from "../../packages/core/src/index.ts";
import { BRAND_ICONS } from "../../packages/core/src/visual/brandIcons.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);

const HANDLES: Array<[string, string]> = [
  ["youtube", "@uncut"],
  ["instagram", "@uncut.app"],
  ["tiktok", "@uncut"],
  ["x", "@uncutapp"],
  ["linkedin", "Uncut"],
  ["snapchat", "uncut"],
  ["github", "blazejkustra/uncut"],
  ["web", "uncut.app"],
];
const follow = (platform: string, handle: string, i: number): Item =>
  ({ id: `f-${platform}`, type: "component", component: "component.follow", start: 0, duration: 150, props: { handle, label: "Follow", platform, style: "pill" }, transform: { x: 40 + (i % 2) * 620, y: 60 + Math.floor(i / 2) * 160, w: 580, h: 120 } }) as Item;
const project = (): Project => ({
  format: "uncut/0",
  name: "Brands",
  canvas: { width: 1280, height: 720, fps: 30 },
  media: [],
  tracks: [
    ...HANDLES.map(([p, h], i) => ({ id: `t-${p}`, kind: "video" as const, name: p, items: [follow(p, h, i)] })),
    { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: 150, props: { color: "#1F3A5F", to: "#5F2F4A", angle: 135 } }] },
  ],
});
const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue71-brands-")));
  dir = writeProject(root, "Brands", project());
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("D275: follow handles with brand logos in their colours; the Inspector names the platforms", { skip, timeout: 180000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });

  // Frame 60: every handle has settled.
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === 60);
  await page.evaluate(() => document.fonts.ready);
  await sleep(400);
  const drawn = (id: string) => page.$eval(`.pv-comp[data-item="${id}"]`, (el) => el.innerHTML);
  for (const [platform] of HANDLES) {
    const html = await drawn(`f-${platform}`);
    const brand = BRAND_ICONS[platform];
    if (brand) {
      assert.ok(html.includes(brand.path), `${platform}: its own mark`);
      assert.ok(html.toLowerCase().includes(brand.hex.toLowerCase()), `${platform}: in ${brand.hex}`);
    } else assert.ok(!Object.values(BRAND_ICONS).some((b) => html.includes(b.path)), `${platform}: Uncut's own glyph`);
  }
  assert.ok((await drawn("f-linkedin")).toLowerCase().includes("#0a66c2"), "LinkedIn in its blue");
  await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path: out("issue71-brands-preview.png") });

  // Select the Instagram handle: the Inspector's platform select names the platforms.
  const b = (await (await page.$('.pv-comp[data-item="f-instagram"]'))!.boundingBox())!;
  await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.5);
  await page.waitForSelector('[data-testid=inspector-item][data-item="f-instagram"] [data-testid=param-platform]', { timeout: 10000 });
  const options = await page.$$eval("[data-testid=param-platform] option", (els) => els.map((e) => [(e as HTMLOptionElement).value, e.textContent]));
  const label = Object.fromEntries(options);
  assert.equal(label.instagram, "Instagram");
  assert.equal(label.applepodcasts, "Apple Podcasts");
  assert.equal(label.linkedin, "LinkedIn");
  assert.equal(label.web, "Website");
  assert.equal(await page.$eval("[data-testid=param-platform]", (el) => (el as HTMLSelectElement).value), "instagram");

  // Switch it to Bluesky: one edit, redrawn in Bluesky's blue with its mark.
  await page.select("[data-testid=param-platform]", "bluesky");
  await page.waitForFunction(() => document.querySelector('.pv-comp[data-item="f-instagram"]')?.innerHTML.toLowerCase().includes("#1185fe"), { timeout: 10000 });
  assert.ok((await drawn("f-instagram")).includes(BRAND_ICONS.bluesky!.path));
  await page.waitForFunction(() => /revision [1-9]/.test(document.querySelector<HTMLElement>("[data-testid=saved]")!.title), { timeout: 10000 });
  await sleep(500);
  assert.equal(onDisk().tracks.flatMap((t) => t.items).find((i) => i.id === "f-instagram")!.props!.platform, "bluesky");
  await sleep(200);
  await page.screenshot({ path: out("issue71-brands-inspector.png") });
});
