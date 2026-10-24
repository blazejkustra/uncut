// Issue #72 (D242) on the packaged app: a selected text's corner handles resize it on the preview,
// like a clip's. Dragging the bottom-right corner out makes the font bigger (the top-left corner
// stays), the top-left corner in makes it smaller (the bottom-right stays); each drag is one edit,
// and ⌘Z puts the size back in one step. A press on the text itself still moves it.
// Screenshots: test-output/issue72-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Item, Project } from "../../packages/core/src/timeline/types.ts";
import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", `issue72-${name}.png`);

const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const item = (id: string): Item =>
  onDisk()
    .tracks.flatMap((t) => t.items)
    .find((i) => i.id === id)!;
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) =>
  page.waitForFunction(
    (r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) >= r,
    { timeout: 10000 },
    n,
  );
const boxOf = async (selector: string) => {
  const b = await (await page.$(selector))?.boundingBox();
  assert.ok(b, `no box for ${selector}`);
  return b;
};
async function drag(from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10, { steps: 2 });
  await sleep(80);
  await page.mouse.up();
}
/** The drawn text's box in canvas px (laid out at canvas size). */
const drawn = () =>
  page.$eval('[data-testid=preview-text] .pv-text[data-item="title"]', (el) => ({
    x: (el as HTMLElement).offsetLeft,
    y: (el as HTMLElement).offsetTop,
    w: (el as HTMLElement).offsetWidth,
    h: (el as HTMLElement).offsetHeight,
  }));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue72-")));
  dir = writeProject(root, "Texts", {
    format: "uncut/0",
    name: "Texts",
    canvas: { width: 1280, height: 720, fps: 30, background: "#202020" },
    media: [],
    tracks: [
      {
        id: "text",
        kind: "text",
        name: "Text",
        items: [
          {
            id: "title",
            type: "text",
            start: 0,
            duration: 90,
            text: "Resize me",
            transform: { x: 200, y: 200 },
            style: { preset: "text.title", size: 80, weight: 700 },
          },
        ],
      },
      { id: "main", kind: "video", role: "main", name: "Main", items: [] },
    ],
  } as Project);
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await page.setViewport({ width: 1280, height: 800 });
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.waitForSelector('[data-testid=preview-text] .pv-text[data-item="title"]', { timeout: 15000 });
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issue #72: a text's corner handles resize it (font size), one undoable edit each", { skip, timeout: 120000 }, async () => {
  const frame = await boxOf("[data-testid=preview-frame]");
  const k = frame.width / 1280;
  const at = (b: { x: number; y: number }) => ({ x: frame.x + b.x * k, y: frame.y + b.y * k });
  const start = await drawn();
  // A click on the text selects it; its corners now take presses.
  await page.mouse.click(at({ x: start.x + start.w / 2, y: start.y + start.h / 2 }).x, at({ x: start.x + start.w / 2, y: start.y + start.h / 2 }).y);
  await page.waitForSelector("[data-testid=text-handle][data-text-handle=se]");
  const events = await page.$eval("[data-testid=text-handle][data-text-handle=se]", (el) => getComputedStyle(el).pointerEvents);
  assert.equal(events, "auto", "the corner takes presses");
  await page.screenshot({ path: out("selected") });

  // The bottom-right corner, out by half the box's width: the font 1.5×, the top-left corner kept.
  const se = await boxOf("[data-testid=text-handle][data-text-handle=se]");
  let r = await revision();
  await drag({ x: se.x + se.width / 2, y: se.y + se.height / 2 }, (start.w / 2) * k, (start.h / 2) * k);
  await waitRevision(r + 1);
  await sleep(300);
  assert.equal(await revision(), r + 1, "one drag is one edit");
  let it = item("title");
  assert.ok(Math.abs(it.style!.size! - 120) <= 3, `size ${it.style!.size} (expected ~120)`);
  assert.deepEqual([it.transform!.x, it.transform!.y], [200, 200], "the top-left corner stays");
  assert.equal(it.style!.weight, 700);
  const bigger = await drawn();
  assert.ok(bigger.w > start.w * 1.35 && bigger.h > start.h * 1.35, `drawn bigger: ${JSON.stringify(start)} → ${JSON.stringify(bigger)}`);
  await page.screenshot({ path: out("bigger") });

  // The top-left corner in: smaller, the bottom-right corner kept (within a few px of text layout).
  await page.waitForSelector("[data-testid=text-handle][data-text-handle=nw]");
  const nw = await boxOf("[data-testid=text-handle][data-text-handle=nw]");
  r = await revision();
  await drag({ x: nw.x + nw.width / 2, y: nw.y + nw.height / 2 }, (bigger.w / 2) * k, (bigger.h / 2) * k);
  await waitRevision(r + 1);
  await sleep(300);
  it = item("title");
  const smaller = await drawn();
  assert.ok(it.style!.size! < 80, `size ${it.style!.size} (smaller than 80)`);
  assert.ok(
    Math.abs(smaller.x + smaller.w - (bigger.x + bigger.w)) <= 8 && Math.abs(smaller.y + smaller.h - (bigger.y + bigger.h)) <= 8,
    `the bottom-right corner stays: ${JSON.stringify(bigger)} → ${JSON.stringify(smaller)}`,
  );
  await page.screenshot({ path: out("smaller") });

  // ⌘Z: back to 120 in one step.
  r = await revision();
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyZ");
  await page.keyboard.up("Meta");
  await waitRevision(r + 1);
  await sleep(300);
  it = item("title");
  assert.ok(
    Math.abs(it.style!.size! - 120) <= 3 && it.transform!.x === 200 && it.transform!.y === 200,
    `undone to ${JSON.stringify({ style: it.style, transform: it.transform })}`,
  );

  // A press on the text itself still moves it (not a resize).
  const now = await drawn();
  r = await revision();
  await drag(at({ x: now.x + now.w / 2, y: now.y + now.h / 2 }), 40 * k, 0);
  await waitRevision(r + 1);
  it = item("title");
  assert.ok(Math.abs(it.style!.size! - 120) <= 3, `the size is kept by a move: ${it.style!.size}`);
  assert.ok(it.transform!.x !== 200, `moved: ${JSON.stringify(it.transform)}`);
  assert.deepEqual(app!.errors, []);
});
