// Phase 4 chunk 4 on the packaged app (D53), with a real mouse and keyboard: a title is selected
// from the preview; its text, style, position and animation change through the Inspector and the
// canvas (each saved, each one undo step, the preview's pixels following); a typing burst is one
// undo step and Space/S/⌫ type into the editors instead of playing, splitting or deleting; a
// double click edits in place (Esc cancels, Enter saves, ⇧Enter is a new line); a background
// from the Elements tab fills the frame under the text; and the agent's next prompt lists the
// edits in words. Screenshots: test-output/text-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp } from "./helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg for pixel checks") : `packaged app not built: run pnpm dist to create ${APP}`;

/** Longer than the Inspector's typing pause, so a late second save would have happened. */
const TYPING_SETTLE = 1100;
let root = "";
// The fake claude's turns; the test appends to it as it goes.
const plan: Array<Array<unknown>> = [[{ text: "Noted." }]];
const apps = new Set<LaunchedApp>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const meta = async (page: Page, key: Parameters<Page["keyboard"]["press"]>[0], shift = false) => {
  await page.keyboard.down("Meta");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
};
/** ⌘A in a text field (puppeteer on macOS needs the editing command spelled out). */
const selectAll = async (page: Page) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyA", { commands: ["SelectAll"] });
  await page.keyboard.up("Meta");
};
const revision = (page: Page) => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const frameOf = (page: Page) => page.$eval("[data-testid=preview-frame]", (el) => Number((el as HTMLElement).dataset.frame));
const playing = (page: Page) => page.$eval("[data-testid=preview-frame]", (el) => (el as HTMLElement).dataset.playing === "true");
const itemCount = (page: Page) => page.$$eval("[data-testid=timeline-item]", (els) => els.length);

/** RGB pixels of the preview, w×h, through ffmpeg. */
function rgb(png: string, w: number, h: number) {
  return execFileSync("ffmpeg", ["-v", "error", "-i", png, "-vf", `scale=${w}:${h}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
}
/** Pixels near a colour (each channel within `tol`) in a box of the frame (fractions), and their mean x (fraction). */
function colourIn(png: string, [r, g, b]: readonly [number, number, number], box = { x0: 0, y0: 0, x1: 1, y1: 1 }, tol = 40) {
  const w = 480;
  const h = 270;
  const px = rgb(png, w, h);
  let n = 0;
  let total = 0;
  let sx = 0;
  for (let y = Math.floor(box.y0 * h); y < Math.ceil(box.y1 * h); y++) {
    for (let x = Math.floor(box.x0 * w); x < Math.ceil(box.x1 * w); x++) {
      total++;
      const i = (y * w + x) * 3;
      if (Math.abs(px[i]! - r) <= tol && Math.abs(px[i + 1]! - g) <= tol && Math.abs(px[i + 2]! - b) <= tol) {
        n++;
        sx += x / w;
      }
    }
  }
  return { share: n / total, meanX: n ? sx / n : NaN };
}
async function shot(page: Page, name: string) {
  const path = out(`text-${name}.png`);
  await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
  return path;
}
/** Wait until the saved revision passes `after`, then a beat for the snapshot to land. */
async function savedAfter(page: Page, after: number) {
  await page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1] ?? -1) > r, { timeout: 10000 }, after);
  await sleep(150);
  return revision(page);
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-text-")));
  mkdirSync(join(root, "projects"));
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(join(root, "plan.json"), JSON.stringify(plan));
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("text CapCut-style: select on the canvas, edit in the Inspector and in place, drag with snapping, backgrounds, animation, and the agent hears about it", { skip, timeout: 240000 }, async () => {
  const app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: join(root, "plan.json"),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
    },
  });
  apps.add(app);
  const { page } = app;
  try {
    await waitFor(page, "[data-testid=welcome]");
    await page.click("[data-testid=new-project]");
    await waitFor(page, "[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor(page, "[data-testid=editor]");
    const dir = await page.$eval("[data-testid=project-dir]", (el) => (el as HTMLElement).title);
    const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
    const title = () => onDisk().tracks.find((t: { id: string }) => t.id === "text").items[0];

    // A title from the Text tab, then deselect; a click on it in the preview selects it again
    // (the timeline follows) and the Inspector shows the text editor.
    await page.click("[data-testid=rail-text]");
    await page.click("[data-testid=text-preset][data-preset=title]");
    await waitFor(page, '.pv-text[data-item="title-1"]');
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-testid=text-editor]"));
    await page.click('.pv-text[data-item="title-1"]');
    await waitFor(page, "[data-testid=text-editor]");
    assert.equal(await page.$eval('[data-testid=timeline-item][data-item="title-1"]', (el) => el.classList.contains("selected")), true, "the timeline selection follows the preview");
    assert.equal(await page.$eval('.pv-text[data-item="title-1"]', (el) => el.classList.contains("sel-box")), true);

    // Typing in the Inspector: Space, S and ⌫ type (no play, split or delete); the burst is saved
    // once (one revision, one ⌘Z) and the preview shows it.
    let rev = await revision(page);
    await page.click("[data-testid=insp-text]");
    await selectAll(page);
    await page.keyboard.type("Krakow from above SS", { delay: 15 });
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    assert.equal(await playing(page), false, "Space typed a space, it didn't play");
    assert.equal(await itemCount(page), 1, "S didn't split, ⌫ didn't delete");
    assert.equal(await page.$eval("[data-testid=insp-text]", (el) => (el as HTMLTextAreaElement).value), "Krakow from above");
    assert.equal(await page.$eval('.pv-text[data-item="title-1"]', (el) => el.textContent), "Krakow from above", "the preview shows the text while typing");
    await page.keyboard.press("Tab"); // blur saves
    rev = await savedAfter(page, rev);
    assert.equal(title().text, "Krakow from above");
    await sleep(TYPING_SETTLE);
    assert.equal(await revision(page), rev, "one burst of typing is one edit");
    // A click on the timeline past the title's end puts the playhead at the end (D56), where
    // nothing is drawn: back to the start to see the title.
    await page.click("[data-testid=timeline]");
    await page.keyboard.press("Home");
    await meta(page, "KeyZ");
    await page.waitForFunction(() => document.querySelector('.pv-text[data-item="title-1"]')?.textContent === "Title");
    assert.equal(title().text, "Title", "one ⌘Z takes the whole burst back");
    await meta(page, "KeyZ", true);
    await page.waitForFunction(() => document.querySelector('.pv-text[data-item="title-1"]')?.textContent === "Krakow from above");
    rev = await revision(page);
    await page.click('.pv-text[data-item="title-1"]');
    await waitFor(page, "[data-testid=text-editor]");

    // Colour: an amber swatch; the title's pixels turn amber.
    const amber = [245, 194, 107] as const;
    const before = await shot(page, "white");
    assert.ok(colourIn(before, amber).share < 0.001, "no amber before");
    await page.click('[data-testid=insp-color][data-color="#F5C26B"]');
    rev = await savedAfter(page, rev);
    assert.equal(title().style.color, "#F5C26B");
    assert.deepEqual(title().style, { preset: "text.title", size: 130, weight: 700, color: "#F5C26B" }, "the rest of the style stays");
    const amberShot = await shot(page, "amber");
    assert.ok(colourIn(amberShot, amber).share > 0.01, `amber text (${colourIn(amberShot, amber).share})`);

    // Size by number: bigger text, bigger box.
    const h0 = await page.$eval('.pv-text[data-item="title-1"]', (el) => el.getBoundingClientRect().height);
    await page.click("[data-testid=insp-size-num]", { clickCount: 3 });
    await page.keyboard.type("180");
    await page.keyboard.press("Enter");
    rev = await savedAfter(page, rev);
    assert.equal(title().style.size, 180);
    const h1 = await page.$eval('.pv-text[data-item="title-1"]', (el) => el.getBoundingClientRect().height);
    assert.ok(Math.abs(h1 / h0 - 180 / 130) < 0.08, `box grew with the size (${h0} → ${h1})`);

    // Size by slider: the preview follows while dragging; one edit on release.
    const slider = (await (await page.$("[data-testid=insp-size]"))!.boundingBox())!;
    await page.mouse.move(slider.x + slider.width * 0.4, slider.y + slider.height / 2);
    await page.mouse.down();
    await page.mouse.move(slider.x + slider.width * 0.3, slider.y + slider.height / 2, { steps: 8 });
    const mid = await page.$eval('.pv-text[data-item="title-1"]', (el) => el.getBoundingClientRect().height);
    assert.equal(await revision(page), rev, "nothing saved while the slider moves");
    assert.ok(mid < h1, "the preview shows the new size while dragging");
    await page.mouse.up();
    rev = await savedAfter(page, rev);
    const sliderSize = title().style.size;
    assert.ok(sliderSize < 180 && sliderSize > 8, `slider size ${sliderSize}`);
    await sleep(300);
    assert.equal(await revision(page), rev, "a slider drag is one edit");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), null, "the slider lets go of focus (Space plays again)");

    // Preset: Lower third sets its size and weight, keeps the colour.
    await page.click('[data-testid=insp-preset][data-preset="text.lower-third"]');
    rev = await savedAfter(page, rev);
    assert.deepEqual(title().style, { preset: "text.lower-third", size: 54, weight: 600, color: "#F5C26B" });
    await page.select("[data-testid=insp-weight]", "800");
    rev = await savedAfter(page, rev);
    assert.equal(title().style.weight, 800);
    await page.click('[data-testid=insp-preset][data-preset="text.title"]');
    rev = await savedAfter(page, rev);
    assert.equal(title().style.size, 130);

    // Drag on the canvas: lands with its centre on the frame's vertical centre line (snapped, with
    // a guide while dragging), the vertical move as dragged; one edit.
    const frame = (await (await page.$("[data-testid=preview-frame]"))!.boundingBox())!;
    const scale = 1920 / frame.width;
    const box = (await (await page.$('.pv-text[data-item="title-1"]'))!.boundingBox())!;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const targetX = frame.x + frame.width / 2 + 4; // 4 px off the centre line: snaps
    const dy = -frame.height * 0.2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move((startX + targetX) / 2, startY + dy / 2, { steps: 6 });
    await page.mouse.move(targetX, startY + dy, { steps: 6 });
    await waitFor(page, "[data-testid=canvas-guide][data-axis=x][data-kind=centre]");
    assert.equal(await revision(page), rev, "nothing saved mid-drag");
    await page.screenshot({ path: out("text-drag.png") });
    await page.mouse.up();
    rev = await savedAfter(page, rev);
    assert.equal(await page.$("[data-testid=canvas-guide]"), null, "guides go on release");
    const moved = title().transform;
    // The preview lays text out at canvas size (D56): its layout width is in canvas pixels.
    const wCanvas = await page.$eval('.pv-text[data-item="title-1"]', (el) => (el as HTMLElement).offsetWidth);
    assert.ok(Math.abs(wCanvas - (await page.$eval('.pv-text[data-item="title-1"]', (el) => el.getBoundingClientRect().width)) * scale) < 2, "drawn scaled to the frame");
    assert.ok(Math.abs(moved.x + wCanvas / 2 - 960) <= 2, `centred: x ${moved.x}, box ${wCanvas.toFixed(0)} wide`);
    assert.ok(Math.abs(moved.y - (410 + dy * scale)) <= 3 * scale, `y follows the drag: ${moved.y}`);
    await sleep(300);
    assert.equal(await revision(page), rev, "a drag is one edit");
    const centred = await shot(page, "centred");
    assert.ok(Math.abs(colourIn(centred, amber).meanX - 0.5) < 0.03, `amber pixels centred (${colourIn(centred, amber).meanX})`);

    // Alignment: two lines, left vs right aligned in a fixed-width box: the short line moves.
    await page.click("[data-testid=insp-w]", { clickCount: 3 });
    await page.keyboard.type("1600");
    await page.keyboard.press("Enter");
    rev = await savedAfter(page, rev);
    await page.click("[data-testid=insp-x]", { clickCount: 3 });
    await page.keyboard.type("160");
    await page.keyboard.press("Enter");
    rev = await savedAfter(page, rev);
    assert.deepEqual({ x: title().transform.x, w: title().transform.w }, { x: 160, w: 1600 });
    const leftShot = await shot(page, "align-left");
    await page.click('[data-testid=insp-align][data-align="right"]');
    rev = await savedAfter(page, rev);
    assert.equal(title().style.align, "right");
    const rightShot = await shot(page, "align-right");
    const [lx, rx] = [colourIn(leftShot, amber).meanX, colourIn(rightShot, amber).meanX];
    assert.ok(rx - lx > 0.15, `right-aligned text sits further right (${lx.toFixed(3)} → ${rx.toFixed(3)})`);

    // Double click: edit in place. Esc cancels (Space and S typed, nothing played or split).
    await page.click('.pv-text[data-item="title-1"]', { clickCount: 2 });
    await waitFor(page, "[data-testid=inline-editor]");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "inline-editor");
    await page.keyboard.type("Nope S ", { delay: 10 });
    assert.equal(await playing(page), false);
    assert.equal(await itemCount(page), 1);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-testid=inline-editor]"));
    await sleep(300);
    assert.equal(await revision(page), rev, "Esc saved nothing");
    assert.equal(title().text, "Krakow from above");
    assert.equal(await page.$eval('.pv-text[data-item="title-1"]', (el) => (el as HTMLElement).style.visibility), "", "the text shows again");
    // Again: ⇧Enter makes a new line, Enter saves.
    await page.click('.pv-text[data-item="title-1"]', { clickCount: 2 });
    await waitFor(page, "[data-testid=inline-editor]");
    await selectAll(page);
    await page.keyboard.type("Krakow");
    await page.keyboard.down("Shift");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Shift");
    await page.keyboard.type("from above");
    await page.keyboard.press("Enter");
    rev = await savedAfter(page, rev);
    assert.equal(title().text, "Krakow\nfrom above");
    assert.equal(await page.$("[data-testid=inline-editor]"), null);
    assert.match(await page.$eval('.pv-text[data-item="title-1"]', (el) => (el as HTMLElement).innerText), /^Krakow\nfrom above$/);

    // A background from the Elements tab, with the title selected: a title card on main, the
    // same length, filling the frame with dark blue under the (still visible) amber text.
    await page.click("[data-testid=rail-elements]");
    await page.click('[data-testid=background-preset][data-background="dark-blue"]');
    rev = await savedAfter(page, rev);
    const main = onDisk().tracks.find((t: { id: string }) => t.id === "main");
    assert.deepEqual(main.items, [{ id: "background-1", type: "component", component: "component.solid", duration: 90, props: { color: "#0B1D3A" } }]);
    await waitFor(page, '.pv-solid[data-item="background-1"]');
    const card = await shot(page, "card");
    const blue = colourIn(card, [11, 29, 58], { x0: 0, y0: 0, x1: 1, y1: 0.12 }, 12);
    assert.ok(blue.share > 0.95, `the top of the frame is dark blue (${blue.share})`);
    assert.ok(colourIn(card, amber).share > 0.005, "the text is still drawn above it");
    assert.deepEqual(
      await page.$$eval("[data-testid=track]", (els) => els.map((e) => (e as HTMLElement).dataset.id)),
      ["text", "main", "audio"],
      "the background sits on main, below the text track",
    );
    const bgItem = '[data-testid=timeline-item][data-item="background-1"]';
    assert.equal(await page.$eval(`${bgItem} .nm`, (el) => el.textContent), "Background #0B1D3A", "the timeline names the colour, not the id");
    assert.equal(await page.$eval(`${bgItem} [data-testid=solid-fill]`, (el) => getComputedStyle(el).backgroundColor), "rgb(11, 29, 58)", "and shows it");

    // Its Inspector: a gradient.
    await waitFor(page, "[data-testid=background-editor]");
    await page.click("[data-testid=bg-gradient]");
    rev = await savedAfter(page, rev);
    assert.deepEqual(main.items[0].props.color, "#0B1D3A");
    const bgProps = () => onDisk().tracks.find((t: { id: string }) => t.id === "main").items[0].props;
    assert.deepEqual(bgProps(), { color: "#0B1D3A", to: "#3B1E54", angle: 160 });
    await page.waitForFunction((sel) => document.querySelector(`${sel} .nm`)?.textContent === "Gradient #0B1D3A → #3B1E54", {}, bgItem);
    // The checkbox keeps focus, and ⌘Z there undoes the project (it isn't a text field).
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "bg-gradient");
    await meta(page, "KeyZ");
    await page.waitForFunction(() => !(document.querySelector<HTMLInputElement>("[data-testid=bg-gradient]")?.checked ?? true));
    assert.deepEqual(bgProps(), { color: "#0B1D3A" });
    await meta(page, "KeyZ", true);
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=bg-gradient]")?.checked === true);
    assert.deepEqual(bgProps(), { color: "#0B1D3A", to: "#3B1E54", angle: 160 });
    rev = await revision(page);

    // Animation: select the title again and fade it in over 10 frames.
    await page.click('.pv-text[data-item="title-1"]');
    await waitFor(page, "[data-testid=text-editor]");
    await page.click("[data-testid=insp-tab-animation]");
    await page.select("[data-testid=insp-anim-in]", "move.fade");
    rev = await savedAfter(page, rev);
    assert.deepEqual(title().animation, { in: { module: "move.fade", duration: 10 } });
    await page.click("[data-testid=timeline]");
    await page.keyboard.press("Home");
    const opacities: Array<number> = [];
    for (const f of [0, 5, 10]) {
      while ((await frameOf(page)) < f) await page.keyboard.press("ArrowRight");
      await page.waitForFunction((n) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === n, {}, f);
      opacities.push(await page.$eval('.pv-text[data-item="title-1"]', (el) => Number((el as HTMLElement).style.opacity)));
      if (f === 0) assert.ok(colourIn(await shot(page, "fade-0"), amber).share < 0.001, "invisible on its first frame");
      if (f === 10) assert.ok(colourIn(await shot(page, "fade-10"), amber).share > 0.005, "fully there after 10 frames");
    }
    assert.deepEqual(opacities, [0, 0.5, 1]);

    // The agent's next prompt lists the edits in words.
    await page.click("[data-testid=tab-agent]");
    await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"), { timeout: 30000 });
    await page.click("[data-testid=agent-input]");
    await page.keyboard.type("what did I change?");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=agent-turn]")?.dataset.status === "done", { timeout: 30000 });
    const prompt: string = JSON.parse(readFileSync(join(root, "prompts.jsonl"), "utf8").trim().split("\n")[0]!).prompt;
    assert.match(prompt, /Changed the text of title-1 to "Krakow from above"/);
    assert.match(prompt, /Restyled .*\(title-1\): style text\.title, size 130, weight 700, colour #F5C26B/);
    assert.match(prompt, /Moved .*\(title-1\) on the canvas to x \d+, y \d+/);
    assert.match(prompt, /Changed the text of title-1 to "Krakow \/ from above"/);
    assert.match(prompt, /Added background background-1 \(#0B1D3A\) on track main/);
    assert.match(prompt, /Restyled background \(background-1\): colour #0B1D3A to #3B1E54 \(gradient\)/);
    assert.match(prompt, /Animated .*\(title-1\): fade in 0\.3s, no out animation/);
    await page.screenshot({ path: out("text-editor.png") });

    // The agent edits while the Inspector's text field has focus. Nothing typed yet: the field
    // shows the agent's text, and what's typed next builds on it.
    const agentTurn = async (prompt: string, steps: Array<unknown>) => {
      plan.push(steps);
      writeFileSync(join(root, "plan.json"), JSON.stringify(plan));
      await page.click("[data-testid=tab-agent]");
      await page.click("[data-testid=agent-input]");
      await page.keyboard.type(prompt);
      await page.keyboard.press("Enter");
      await page.click("[data-testid=tab-inspector]");
    };
    const turnsDone = (n: number) => page.waitForFunction((k) => [...document.querySelectorAll<HTMLElement>("[data-testid=agent-turn]")].filter((t) => t.dataset.status === "done").length >= k, { timeout: 30000 }, n);
    const retitle = (text: string) => [
      { tool: "project_read" },
      { sleep: 2500 },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Retitle", ops: [{ op: "update_item", item: "title-1", set: { text } }] } },
      { text: "Done." },
    ];
    const waitDisk = async (check: () => boolean, what: string) => {
      for (let i = 0; i < 150 && !check(); i++) await sleep(100);
      assert.ok(check(), what);
    };
    await page.click('.pv-text[data-item="title-1"]');
    await agentTurn("retitle it", retitle("Agent title"));
    await waitFor(page, "[data-testid=text-editor]");
    await page.click("[data-testid=insp-text]");
    await waitDisk(() => title().text === "Agent title", "the agent's edit landed");
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("[data-testid=insp-text]")!.value === "Agent title");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "insp-text", "still focused");
    rev = await revision(page);
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await page.keyboard.press("Tab");
    rev = await savedAfter(page, rev);
    assert.equal(title().text, "Agent title!");
    assert.equal(await page.$("[data-testid=editor-error]"), null);
    await page.click("[data-testid=tab-agent]");
    await turnsDone(2);

    // Typing already pending when the agent edits: the save is refused as a conflict (the banner
    // says so), the agent's text stays, and the field shows it again.
    await agentTurn("retitle it again", retitle("Agent again"));
    await page.click("[data-testid=insp-text]");
    await page.keyboard.press("End");
    for (let i = 0; i < 80 && title().text !== "Agent again"; i++) {
      await page.keyboard.type("x");
      await sleep(100);
    }
    assert.equal(title().text, "Agent again", "the agent edited while the user was typing");
    await page.keyboard.type("yz");
    await page.keyboard.press("Tab");
    await waitFor(page, "[data-testid=editor-error]");
    assert.match(await page.$eval("[data-testid=editor-error]", (el) => el.textContent ?? ""), /agent changed that/);
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("[data-testid=insp-text]")!.value === "Agent again");
    assert.equal(title().text, "Agent again", "the agent's change wasn't overwritten");
    await page.click("[data-testid=editor-error] button");
    await page.click("[data-testid=tab-agent]");
    await turnsDone(3);

    // A snapshot arriving mid-drag (the agent recolours the background) doesn't freeze the drag:
    // the text keeps following the pointer, and the drop is saved.
    await agentTurn("darker background", [
      { tool: "project_read" },
      { sleep: 2000 },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Darker", ops: [{ op: "update_item", item: "background-1", set: { props: { color: "#222222" } } }] } },
      { text: "Done." },
    ]);
    const t0 = (await (await page.$('.pv-text[data-item="title-1"]'))!.boundingBox())!;
    const yBefore = title().transform.y;
    const gx = t0.x + t0.width / 2;
    let gy = t0.y + t0.height / 2;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    gy -= 5;
    await page.mouse.move(gx, gy, { steps: 3 });
    await waitDisk(() => bgProps().color === "#222222", "the agent's edit landed mid-drag");
    await sleep(200);
    gy -= 25;
    await page.mouse.move(gx, gy, { steps: 5 });
    const t1 = (await (await page.$('.pv-text[data-item="title-1"]'))!.boundingBox())!;
    assert.ok(Math.abs(t1.y - (t0.y - 30)) < 4, `the text followed the pointer after the snapshot (${t0.y} → ${t1.y})`);
    rev = await revision(page);
    await page.mouse.up();
    rev = await savedAfter(page, rev);
    assert.ok(Math.abs(title().transform.y - (yBefore - 30 * scale)) <= 4 * scale, `drop saved: ${yBefore} → ${title().transform.y}`);
    assert.equal(bgProps().color, "#222222", "and the agent's edit stays");
    await page.click("[data-testid=tab-agent]");
    await turnsDone(4);
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: out("text-failure.png") }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-3000)}` });
  }
});

test("the preview stacks text and backgrounds in track order, as export will (D39)", { skip, timeout: 120000 }, async () => {
  // A background on a video track above the text track covers the title; hiding that track shows it.
  const dir = join(root, "Order.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Order",
      canvas: { width: 1920, height: 1080, fps: 30 },
      media: [],
      tracks: [
        { id: "cover", kind: "video", name: "Cover", items: [{ id: "red", type: "component", component: "component.solid", start: 0, duration: 90, props: { color: "#C81E1E" } }] },
        { id: "text", kind: "text", name: "Text", items: [{ id: "title-1", type: "text", start: 0, duration: 90, text: "Hidden", transform: { x: 154, y: 410 }, style: { preset: "text.title", size: 130, weight: 700 } }] },
        { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "under", type: "component", component: "component.solid", duration: 90, props: { color: "#0B1D3A" } }] },
        { id: "audio", kind: "audio", name: "Audio", items: [] },
      ],
    }),
  );
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data-order"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  apps.add(app);
  const { page } = app;
  await waitFor(page, "[data-testid=welcome]");
  await page.click("[data-testid=open-project]");
  await waitFor(page, '.pv-text[data-item="title-1"]');
  await waitFor(page, '.pv-solid[data-item="red"]');
  const z = (sel: string) => page.$eval(sel, (el) => Number((el as HTMLElement).style.zIndex));
  assert.ok((await z('.pv-solid[data-item="red"]')) > (await z('.pv-text[data-item="title-1"]')), "the cover is stacked above the text");
  assert.ok((await z('.pv-text[data-item="title-1"]')) > (await z('.pv-solid[data-item="under"]')), "the text above main's background");
  const covered = await shot(page, "order-covered");
  const white = [242, 241, 238] as const;
  assert.ok(colourIn(covered, white).share < 0.001, `no title pixels under the cover (${colourIn(covered, white).share})`);
  assert.ok(colourIn(covered, [190, 45, 40], undefined, 40).share > 0.95, "the frame is the cover's red (display colour management shifts it a little)");
  // Hide the cover track: the title over main's background.
  await page.click('[data-testid=track][data-id="cover"] [data-testid=track-hide]');
  await page.waitForFunction(() => !document.querySelector('.pv-solid[data-item="red"]'));
  const shown = await shot(page, "order-shown");
  assert.ok(colourIn(shown, white).share > 0.002, "the title shows once the cover is hidden");
  assert.deepEqual(app.errors, []);
});
