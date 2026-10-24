// Feedback round 1, inspectors and elements (planning/FEEDBACK.md X2, X3, E1–E4; D129–D132), on
// the packaged app, run invisibly and muted:
// - X3: the text Inspector is a property panel (sections, no row of look buttons): font from the
//   picker, italic, title case, the fill's opacity, rotation, align to the frame, a scrubbed label
//   and a slider are one edit each; two selected texts change together in one edit.
// - E4: an element's params as typed controls in sections (Content / Style / Motion), a colour by
//   hex, a slider, and a reset to the manifest's default.
// - E1: the + on an element tile sits centred in its circle, 4 px from the tile's corner.
// - E2: the grid shows general elements, the dev-promo ones start hidden; hiding one is remembered
//   after a restart, and it comes back from the hidden list.
// - E3: one Background tile; its Inspector makes a radial gradient with grain (preview draws it).
// - X2: dragging a tile sets a small chip as the drag image, and dragging over the canvas and the
//   timeline shows where it lands (a faint ghost of the element, a span on the lanes).
// Screenshots: test-output/inspector-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Item, Project } from "../../packages/core/src/index.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", `inspector-${name}.png`);
const T1: Item = {
  id: "t1",
  type: "text",
  start: 0,
  duration: 150,
  text: "Inspector",
  transform: { x: 200, y: 300 },
  style: { preset: "text.title", size: 120, weight: 700 },
};
const T2: Item = {
  id: "t2",
  type: "text",
  start: 0,
  duration: 150,
  text: "Second line",
  transform: { x: 200, y: 700 },
  style: { preset: "text.header", size: 64, weight: 500 },
};
const PROJECT: Project = {
  format: "uncut/0",
  name: "Inspector",
  canvas: { width: 1920, height: 1080, fps: 30 },
  textLooks: 1,
  media: [],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [T1] },
    { id: "text-2", kind: "text", name: "Text 2", items: [T2] },
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [{ id: "base", type: "component", component: "component.solid", duration: 300, props: { color: "#202830" } }],
    },
  ],
};

const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const item = (id: string): Item | undefined =>
  onDisk()
    .tracks.flatMap((t) => t.items)
    .find((i) => i.id === id);
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) =>
  page.waitForFunction(
    (r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) >= r,
    { timeout: 10000 },
    n,
  );
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const box = async (selector: string) => {
  const el = (await page.$(selector))!;
  await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
  return (await el.boundingBox())!;
};
const historyLabels = () => {
  const db = new DatabaseSync(join(dir, "history.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT label FROM revisions WHERE kind = 'edit' ORDER BY revision").all() as Array<{ label: string }>).map((r) => r.label);
  } finally {
    db.close();
  }
};
/** Type into a field and commit with Enter; resolves once that edit is saved. */
async function setField(testId: string, value: string) {
  const r = await revision();
  await page.click(`[data-testid=${testId}]`, { clickCount: 3 });
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
  await waitRevision(r + 1);
}
/** Click and wait for exactly one saved edit. */
async function clickEdit(selector: string) {
  const r = await revision();
  await page.click(selector);
  await waitRevision(r + 1);
}
async function selectItem(id: string, meta = false) {
  const b = await box(`[data-testid=timeline-item][data-item="${id}"]`);
  if (meta) await page.keyboard.down("Meta");
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  if (meta) await page.keyboard.up("Meta");
}
async function launch() {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-inspector-")));
  dir = join(root, "Inspector.uncut");
  mkdirSync(dir);
  writeFileSync(join(dir, "project.json"), JSON.stringify(PROJECT, null, 2));
  await launch();
});

after(async () => {
  await app?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  unlockApps();
});

test("X3: the text Inspector is a property panel; every control is one edit and draws live", { skip, timeout: 180000 }, async () => {
  await selectItem("t1");
  await waitFor('[data-testid=inspector-item][data-item="t1"] [data-testid=text-style]');
  for (const sec of ["type", "fill", "stroke", "shadow", "box", "layout"]) assert.ok(await page.$(`[data-testid=insp-sec-${sec}]`), `section ${sec}`);
  assert.equal(await page.$eval("[data-testid=insp-preset]", (el) => el.tagName), "SELECT", "the looks are one dropdown, not a row of buttons");
  assert.equal(await page.$(".presets"), null);
  await (await page.$(".side"))!.screenshot({ path: out("text") });

  // Font: the picker draws each name in its font; DM Mono picked; the preview uses it.
  await page.click("[data-testid=insp-font]");
  await waitFor("[data-testid=insp-font-popover]");
  assert.equal(await page.$eval('[data-testid=insp-font-option][data-font="DM Mono"]', (el) => (el as HTMLElement).style.fontFamily), '"DM Mono"');
  await (await page.$(".side"))!.screenshot({ path: out("font-picker") });
  await page.type("[data-testid=insp-font-search]", "dm mo");
  await clickEdit('[data-testid=insp-font-option][data-font="DM Mono"]');
  assert.equal(item("t1")!.style!.font, "DM Mono");
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.pv-text[data-item="t1"]')!).fontFamily.startsWith('"DM Mono"'));

  // Italic, title case, the fill's opacity (#RRGGBBAA), rotation: one edit each, drawn at once.
  await clickEdit("[data-testid=insp-italic]");
  assert.equal(item("t1")!.style!.italic, true);
  await clickEdit("[data-testid=insp-case][data-case=title]");
  assert.equal(item("t1")!.style!.case, "title");
  await setField("insp-color-opacity", "50");
  assert.equal(item("t1")!.style!.color, "#F2F1EE80");
  await setField("insp-rotate", "-8");
  assert.equal(item("t1")!.transform!.rotate, -8);
  const css = await page.$eval('.pv-text[data-item="t1"]', (el) => {
    const c = getComputedStyle(el);
    return { style: c.fontStyle, transform: c.textTransform, color: c.color, rot: (el as HTMLElement).style.transform };
  });
  assert.deepEqual(css, { style: "italic", transform: "capitalize", color: "rgba(242, 241, 238, 0.5)", rot: "rotate(-8deg)" });

  // A scrubbed label (drag "Spacing" right) and the opacity slider: previewed while moving, one edit each.
  let r = await revision();
  const scrub = await box("[data-testid=insp-tracking-scrub]");
  await page.mouse.move(scrub.x + scrub.width / 2, scrub.y + scrub.height / 2);
  await page.mouse.down();
  await page.mouse.move(scrub.x + scrub.width / 2 + 30, scrub.y + scrub.height / 2, { steps: 10 });
  assert.equal(await revision(), r, "nothing saved while scrubbing");
  const live = await page.$eval('.pv-text[data-item="t1"]', (el) => getComputedStyle(el).letterSpacing);
  await page.mouse.up();
  await waitRevision(r + 1);
  await sleep(300);
  assert.equal(await revision(), r + 1, "a scrub is one edit");
  assert.ok(item("t1")!.style!.tracking! > 0, `tracking ${item("t1")!.style!.tracking}`);
  assert.notEqual(live, "normal");
  r = await revision();
  const slider = await box("[data-testid=insp-opacity-slider]");
  await page.mouse.move(slider.x + slider.width * 0.95, slider.y + slider.height / 2);
  await page.mouse.down();
  await page.mouse.move(slider.x + slider.width * 0.6, slider.y + slider.height / 2, { steps: 8 });
  await page.mouse.up();
  await waitRevision(r + 1);
  await sleep(300);
  assert.equal(await revision(), r + 1, "a slider drag is one edit");
  const opacity = item("t1")!.transform!.opacity!;
  assert.ok(opacity > 0.4 && opacity < 0.8, `opacity ${opacity}`);

  // Align to the frame: the measured box's right edge on the safe margin.
  await clickEdit("[data-testid=insp-frame-align][data-edge=right]");
  const w = await page.$eval('.pv-text[data-item="t1"]', (el) => (el as HTMLElement).offsetWidth);
  assert.ok(Math.abs(item("t1")!.transform!.x! + w - (1920 - 72)) <= 2, `right edge ${item("t1")!.transform!.x! + w}`);
  await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path: out("text-preview") });

  // Two texts selected: one weight change restyles both in one edit.
  await selectItem("t2", true);
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=text-style]")?.dataset.targets === "2");
  r = await revision();
  await page.select("[data-testid=insp-weight]", "300");
  await waitRevision(r + 1);
  await sleep(300);
  assert.equal(await revision(), r + 1);
  assert.deepEqual([item("t1")!.style!.weight, item("t2")!.style!.weight], [300, 300]);
  const labels = historyLabels();
  assert.ok(
    labels.includes("Set font to DM Mono") &&
      labels.includes("Set text in italic") &&
      labels.includes("Set text in title case") &&
      labels.includes("Rotate text -8°") &&
      labels.includes("Align text to the right") &&
      labels.includes("Set weight to Light (2 items)"),
    labels.join(" | "),
  );
});

test("E1/E2/E3: the Elements grid (general elements, + centred, hide remembered, one Background)", { skip, timeout: 180000 }, async () => {
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Escape");
  await page.click("[data-testid=rail-elements]");
  await waitFor("[data-testid=components-grid]");
  const grid = await page.$$eval("[data-testid=components-grid] [data-component]", (els) => els.map((e) => (e as HTMLElement).dataset.component));
  for (const id of ["shape", "lower-third", "callout", "progress-bar", "countdown", "subscribe", "sticker", "image-frame", "solid"])
    assert.ok(grid.includes(`component.${id}`), `${id} in the grid`);
  for (const id of ["agent-log", "compare-table", "device-frame", "terminal", "code-block"]) assert.ok(!grid.includes(`component.${id}`), `${id} hidden`);
  assert.equal(await page.$$eval("[data-testid=background-tile]", (els) => els.length), 1, "one Background element");
  assert.equal(await page.$("[data-testid=background-preset]"), null);

  // E1: the + is centred in its circle, the circle 4 px inside the tile's corner.
  await page.hover("[data-testid=component-tile][data-component='component.shape']");
  await sleep(200);
  const plus = await page.$eval("[data-testid=component-tile][data-component='component.shape']", (tile) => {
    const t = tile.getBoundingClientRect();
    const btn = tile.querySelector("[data-testid=component-add]")!.getBoundingClientRect();
    const icon = tile.querySelector("[data-testid=component-add] svg")!.getBoundingClientRect();
    return {
      dx: icon.x + icon.width / 2 - (btn.x + btn.width / 2),
      dy: icon.y + icon.height / 2 - (btn.y + btn.height / 2),
      right: t.right - btn.right,
      top: btn.top - t.top,
    };
  });
  assert.ok(Math.abs(plus.dx) < 0.6 && Math.abs(plus.dy) < 0.6, `+ centred (${plus.dx}, ${plus.dy})`);
  assert.ok(Math.abs(plus.right - 4) < 1.5 && Math.abs(plus.top - 4) < 1.5, `4 px from the corner (${plus.right}, ${plus.top})`);
  await (await page.$("[data-testid=elements-library]"))!.screenshot({ path: out("elements") });

  // E2: hide the sticker; after a restart it's still hidden; then shown again from the list.
  await page.hover("[data-testid=component-tile][data-component='component.sticker']");
  await page.click("[data-testid=component-tile][data-component='component.sticker'] [data-testid=element-hide]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=component-tile][data-component='component.sticker']"));
  assert.match(await page.$eval("[data-testid=hidden-elements-toggle]", (el) => el.textContent ?? ""), /Hidden \(6\)/);
  await app!.close();
  app = undefined;
  await launch();
  await page.click("[data-testid=rail-elements]");
  await waitFor("[data-testid=components-grid]");
  assert.equal(await page.$("[data-testid=component-tile][data-component='component.sticker']"), null, "still hidden after a restart");
  await page.click("[data-testid=hidden-elements-toggle]");
  await (await page.$("[data-testid=elements-library]"))!.screenshot({ path: out("elements-hidden") });
  await page.click("[data-testid=hidden-element-tile][data-component='component.sticker'] [data-testid=element-show]");
  await waitFor("[data-testid=component-tile][data-component='component.sticker']");

  // E3: the Background: radial, a middle colour, grain; the preview draws exactly that.
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("End");
  // Nothing selected: + adds it at once, no Behind this / Whole edit question (D220).
  await page.keyboard.press("Escape");
  await page.click("[data-testid=rail-elements]");
  const r = await revision();
  await page.hover("[data-testid=background-tile]");
  await page.click("[data-testid=background-add]");
  await waitRevision(r + 1);
  await waitFor("[data-testid=background-editor]");
  const id = await page.$eval("[data-testid=inspector-item]", (el) => (el as HTMLElement).dataset.item!);
  await clickEdit("[data-testid=bg-fill][data-value=radial]");
  await clickEdit("[data-testid=bg-add-stop]");
  await setField("bg-to-hex", "#F5C26B");
  await setField("bg-noise", "35");
  assert.deepEqual(item(id)!.props, { color: "#0B1D3A", to: "#F5C26B", gradient: "radial", via: "#2A1A4A", noise: 0.35 });
  const drawn = await page.$eval(`.pv-solid[data-item="${id}"]`, (el) => getComputedStyle(el).backgroundImage);
  assert.match(
    drawn,
    /^url\("data:image\/svg\+xml,.*"\), radial-gradient\(circle(?: at 50% 50%)?, rgb\(11, 29, 58\), rgb\(42, 26, 74\), rgb\(245, 194, 107\)\)$/,
  );
  await (await page.$(".side"))!.screenshot({ path: out("background") });
  await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path: out("background-preview") });
});

test("E4: an element's params as typed controls in sections, with reset", { skip, timeout: 120000 }, async () => {
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Home");
  await page.click("[data-testid=rail-elements]");
  let r = await revision();
  await page.hover("[data-testid=component-tile][data-component='component.lower-third']");
  await page.click("[data-testid=component-tile][data-component='component.lower-third'] [data-testid=component-add]");
  await waitRevision(r + 1);
  await waitFor("[data-testid=component-editor][data-component='component.lower-third']");
  const id = await page.$eval("[data-testid=inspector-item]", (el) => (el as HTMLElement).dataset.item!);
  for (const sec of ["content", "style", "motion"]) assert.ok(await page.$(`[data-testid=param-sec-${sec}]`), `section ${sec}`);
  assert.equal(await page.$eval("[data-testid=param-slide-row] [data-testid=param-slide]", (el) => el.tagName), "INPUT");
  assert.ok(await page.$("[data-testid=param-slide-slider]"), "a bounded number gets a slider");
  await setField("param-name", "Ada Lovelace");
  await setField("param-accent-hex", "#FF0055");
  assert.equal(item(id)!.props!.accent, "#FF0055");
  await page.waitForFunction((i) => document.querySelector(`.pv-comp[data-item="${i}"]`)?.innerHTML.includes("#FF0055"), {}, id);
  await setField("param-slide", "1.2");
  assert.equal(item(id)!.props!.slide, 1.2);
  await (await page.$(".side"))!.screenshot({ path: out("element") });
  r = await revision();
  await page.hover("[data-testid=param-accent-row]");
  await page.click("[data-testid=param-accent-row-reset]");
  await waitRevision(r + 1);
  const defaults = JSON.parse(readFileSync(resolve("spec/modules/builtin/component.lower-third.json"), "utf8")).component.defaults as Record<string, unknown>;
  assert.equal(item(id)!.props!.accent, defaults.accent, "reset to the manifest's default");
});

test("X2: a dragged tile is a small chip; the canvas and the timeline show where it lands", { skip, timeout: 120000 }, async () => {
  await page.click("[data-testid=rail-text]");
  await waitFor("[data-testid=text-grid]");
  // The drag image: a chip with the tile's own rendering and name (not the browser's screenshot).
  const chip = await page.evaluate(() => {
    const tile = document.querySelector<HTMLElement>("[data-testid=text-preset][data-preset=title]")!;
    const dt = new DataTransfer();
    let image: { cls: string; thumb: boolean; text: string; w: number } | undefined;
    dt.setDragImage = (el: Element) =>
      void (image = { cls: el.className, thumb: !!el.querySelector(".text-thumb .tt-text"), text: el.textContent ?? "", w: (el as HTMLElement).offsetWidth });
    tile.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return image;
  });
  assert.ok(chip && chip.cls === "drag-chip" && chip.thumb && chip.w < 260, JSON.stringify(chip));
  // Over the canvas: a faint ghost of the title, under the pointer.
  const frame = await box("[data-testid=preview-frame]");
  const over = (selector: string, x: number, y: number) =>
    page.evaluate(
      (sel, cx, cy) => {
        const dt = new DataTransfer();
        dt.setData("application/x-uncut-text", "title");
        document.querySelector(sel)!.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
      },
      selector,
      x,
      y,
    );
  await over("[data-testid=preview-frame]", frame.x + frame.width * 0.3, frame.y + frame.height * 0.7);
  await waitFor("[data-testid=drop-ghost] .pv-text");
  const ghost = await box("[data-testid=drop-ghost] .pv-text");
  assert.ok(Math.abs(ghost.x - (frame.x + frame.width * 0.3)) < 3, "starts at the pointer");
  assert.ok(ghost.y < frame.y + frame.height * 0.7 && ghost.y + ghost.height > frame.y + frame.height * 0.7, "its line on the pointer's height");
  await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path: out("drag-canvas") });
  await page.evaluate(() =>
    document.querySelector("[data-testid=preview-frame]")!.dispatchEvent(new DragEvent("dragleave", { bubbles: true, relatedTarget: null })),
  );
  await page.waitForFunction(() => !document.querySelector("[data-testid=drop-ghost]"));
  // Over the timeline: the span it would fill (3 s from the pointer's frame).
  const lanes = await box("[data-testid=lanes]");
  await over("[data-testid=lanes]", lanes.x + 200, lanes.y + 60);
  await waitFor("[data-testid=timeline-drop-ghost]");
  const ppf = Number(await page.$eval("[data-testid=timeline]", (el) => (el as HTMLElement).dataset.ppf));
  const span = await box("[data-testid=timeline-drop-ghost]");
  assert.ok(Math.abs(span.width - 90 * ppf) < 2, `3 s wide (${span.width} vs ${90 * ppf})`);
  assert.ok(Math.abs(span.x - (lanes.x + 200)) < ppf + 2, "from the pointer");
  await (await page.$("[data-testid=timeline]"))!.screenshot({ path: out("drag-timeline") });
  await page.evaluate(() => document.querySelector("[data-testid=lanes]")!.dispatchEvent(new DragEvent("dragleave", { bubbles: true, relatedTarget: null })));
  await page.waitForFunction(() => !document.querySelector("[data-testid=timeline-drop-ghost]"));
});
