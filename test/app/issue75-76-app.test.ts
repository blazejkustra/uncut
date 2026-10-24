// Issues #75 and #76 on the packaged app, run invisibly, with the stand-in claude.
// #75 (D255): a new project shows the agent centre stage (a large card over the dimmed, blurred
// editor, with the suggestions); Esc and "Go to editor" send it to the editor, the Agent tab's empty
// state brings it back; the first turn docks it into the Agent tab. A project with content doesn't
// show it.
// #76 (D256): ⇧⌘L, ⇧⌘I, ⇧⌘T hide the left rail and panel, the right panel and the timeline (the
// preview grows into the room) and the top bar's buttons bring them back; ⇧⌘F is focus mode (only
// the preview and the agent beside it, D270); the choice is remembered across a relaunch.
// Screenshots: test-output/issue75-76-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let projects = "";
let full = "";
const apps = new Set<LaunchedApp>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (page: Page, name: string) => page.screenshot({ path: `test-output/issue75-76-${name}.png` });
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const gone = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { hidden: true, timeout });
const rect = (page: Page, selector: string) =>
  page.$eval(selector, (el) => el.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number });
const has = async (page: Page, selector: string) => (await page.$(selector)) !== null;
/** ⇧⌘<key>, as the View menu's shortcuts. */
const shiftCmd = async (page: Page, code: "KeyL" | "KeyI" | "KeyT" | "KeyF") => {
  await page.keyboard.down("Shift");
  await page.keyboard.down("Meta");
  await page.keyboard.press(code);
  await page.keyboard.up("Meta");
  await page.keyboard.up("Shift");
  await sleep(450); // the grid's 0.2 s transition
};

const launch = (dialogs: Array<unknown>) =>
  launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify(dialogs),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: join(root, "plan.json"),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
    },
  }).then((app) => (apps.add(app), app));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue75-")));
  projects = join(root, "projects");
  mkdirSync(projects);
  // A project with content: a title on the text track.
  full = join(root, "Full.uncut");
  mkdirSync(full);
  writeFileSync(
    join(full, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Full",
      canvas: { width: 1920, height: 1080, fps: 30 },
      textLooks: 1,
      media: [],
      tracks: [
        {
          id: "text",
          kind: "text",
          name: "Text",
          items: [
            {
              id: "t1",
              type: "text",
              start: 0,
              duration: 90,
              text: "Launch day",
              transform: { x: 160, y: 440 },
              style: { preset: "text.title", size: 140, weight: 700 },
            },
          ],
        },
        { id: "main", kind: "video", role: "main", name: "Main", items: [] },
      ],
    }),
  );
  writeFileSync(join(root, "prompts.jsonl"), "");
  // One turn: a short pause (so the docking can be seen), then a reply.
  writeFileSync(join(root, "plan.json"), JSON.stringify([[{ sleep: 600 }, { text: "Here's a plan for your launch video." }]]));
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("#75 #76: the agent centre stage on a new project, docking; hideable panels, focus mode, remembered", { skip, timeout: 300000 }, async () => {
  let app = await launch([projects, full]);
  let { page } = app;
  await waitForWelcome(page);

  // ---- #75: a new project: the agent centre stage ----
  await page.click("[data-testid=new-project]");
  await waitFor(page, "[data-testid=new-project-form]");
  await page.click("[data-testid=project-name]", { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type("[data-testid=project-name]", "Stage Test");
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction((dir: string) => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title === dir, {}, projects);
  await page.click("[data-testid=create]");
  await waitFor(page, "[data-testid=editor]");
  await waitFor(page, "[data-testid=agent-stage-card]");
  await sleep(500);
  const win = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const card = await rect(page, "[data-testid=agent-stage-card]");
  assert.ok(card.width >= 600 && card.height >= 420, `a large card (${JSON.stringify(card)})`);
  assert.ok(Math.abs(card.x + card.width / 2 - win.w / 2) < 4, "centred across the window");
  assert.ok(Math.abs(card.y + card.height / 2 - (40 + (win.h - 40) / 2)) < 30, "centred under the top bar");
  // The question and the composer are in the card, together in its middle (no prefilled prompts);
  // the editor behind is dimmed and blurred.
  assert.match(await page.$eval("[data-testid=agent-stage-card] [data-testid=agent-empty]", (el) => el.textContent ?? ""), /What should we make in/);
  assert.equal(await page.$("[data-testid=agent-example]"), null, "no starter suggestions");
  const title = await rect(page, "[data-testid=agent-stage-card] .agent-empty-title");
  const box = await rect(page, "[data-testid=agent-stage-card] [data-testid=agent-input]");
  assert.ok(box.y - (title.y + title.height) < 90, `the composer right under the question (${JSON.stringify({ title, box })})`);
  assert.ok(Math.abs((title.y + box.y + box.height) / 2 - (card.y + card.height / 2)) < 60, "both in the middle of the card");
  assert.ok(await has(page, "[data-testid=agent-stage-card] [data-testid=agent-input]"), "the composer");
  assert.equal((await page.$$("[data-testid=agent-input]")).length, 1, "one composer in the window");
  const backdrop = await page.$eval("[data-testid=agent-stage]", (el) => {
    const s = getComputedStyle(el);
    return { filter: s.backdropFilter, events: s.pointerEvents };
  });
  assert.match(backdrop.filter, /blur/);
  assert.equal(backdrop.events, "none", "the backdrop doesn't take clicks");
  assert.ok(await has(page, "[data-testid=side-staged]"), "the Agent tab says the chat is in the middle");
  await shot(page, "stage");

  // D266: a drop on the card that imports nothing says why in the card (not only in Media, under
  // the backdrop); the stage stays. Banners and toasts draw above the stage.
  writeFileSync(join(root, "broken.mp4"), "not a video at all");
  const cardBox = await rect(page, "[data-testid=agent-stage-card]");
  const cdp = await page.target().createCDPSession();
  const dropData = { items: [], files: [join(root, "broken.mp4")], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const)
    await cdp.send("Input.dispatchDragEvent", { type, x: cardBox.x + cardBox.width / 2, y: cardBox.y + cardBox.height / 2, data: dropData });
  await waitFor(page, "[data-testid=agent-stage-card] [data-testid=agent-stage-import-report]", 30000);
  assert.match(await page.$eval("[data-testid=agent-stage-import-report]", (el) => el.textContent ?? ""), /broken\.mp4/);
  assert.ok(await has(page, "[data-testid=agent-stage-card]"), "the stage stays: nothing was imported");
  const z = await page.evaluate(() => ({
    banners: Number(getComputedStyle(document.querySelector(".app > .banners")!).zIndex),
    stage: Number(getComputedStyle(document.querySelector("[data-testid=agent-stage]")!).zIndex),
  }));
  assert.ok(z.banners > z.stage, `banners and toasts above the stage (${JSON.stringify(z)})`);
  await shot(page, "stage-import-failed");
  await page.click("[data-testid=agent-stage-import-report] .link-btn");
  await gone(page, "[data-testid=agent-stage-import-report]");

  // Esc goes to the editor; the Agent tab's empty state brings the stage back.
  await page.keyboard.press("Escape");
  await gone(page, "[data-testid=agent-stage]");
  await waitFor(page, ".side [data-testid=agent-panel]");
  assert.equal(await page.$eval("[data-testid=tab-agent]", (el) => el.classList.contains("active")), true, "docked into the Agent tab");
  await sleep(500);
  await shot(page, "dismissed");
  await page.click("[data-testid=agent-stage-reopen]");
  await waitFor(page, "[data-testid=agent-stage-card]");
  // "Go to editor" too.
  await page.click("[data-testid=agent-stage-dismiss]");
  await gone(page, "[data-testid=agent-stage]");
  await page.click("[data-testid=agent-stage-reopen]");
  await waitFor(page, "[data-testid=agent-stage-card]");
  await sleep(400);

  // A prompt, then Enter: the first turn docks the stage into the Agent tab.
  await page.click("[data-testid=agent-stage-card] [data-testid=agent-input]");
  await page.keyboard.type("Make a 5 s title card that says Hello");
  await page.keyboard.press("Enter");
  await gone(page, "[data-testid=agent-stage]");
  await waitFor(page, ".side [data-testid=agent-turn]");
  await page.waitForFunction(() => document.querySelector("[data-testid=agent-turn]")?.getAttribute("data-status") === "done", { timeout: 30000 });
  assert.equal(await has(page, "[data-testid=agent-stage-reopen]"), false, "no way back once the agent ran");
  await sleep(400);
  await shot(page, "docked");
  const prompts = readFileSync(join(root, "prompts.jsonl"), "utf8").trim().split("\n").filter(Boolean);
  assert.ok(prompts.length >= 1, "the turn ran");

  // A project with content: no stage.
  await page.click("[data-testid=close-project]");
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor(page, "[data-testid=editor]");
  await waitFor(page, "[data-testid=timeline]").catch(() => {});
  await sleep(1500);
  assert.equal(await has(page, "[data-testid=agent-stage]"), false, "a project with content opens in the editor");

  // ---- #76: hide each part; the preview takes the room ----
  const stage0 = await rect(page, "[data-testid=stage]");
  const lib0 = await rect(page, "[data-testid=library]");
  const side0 = await rect(page, "aside.side");
  const bottom0 = await rect(page, ".bottom");
  await shot(page, "panels-all");

  await shiftCmd(page, "KeyL");
  assert.equal(await has(page, "[data-testid=library]"), false, "the left panel is hidden");
  assert.equal(await has(page, ".rail"), false, "the rail too");
  let s = await rect(page, "[data-testid=stage]");
  assert.ok(Math.abs(s.width - (stage0.width + lib0.width + 56)) < 3, `the preview takes the left panel's and the rail's room (${stage0.width} → ${s.width})`);
  assert.ok(s.x < 1, "from the window's left edge");
  assert.equal(await page.$eval("[data-testid=toggle-lib]", (el) => el.getAttribute("aria-pressed")), "false");

  await shiftCmd(page, "KeyI");
  assert.equal(await has(page, "aside.side"), false, "the right panel is hidden");
  s = await rect(page, "[data-testid=stage]");
  assert.ok(Math.abs(s.width - win.w) < 3, `the preview spans the window (${s.width})`);

  await shiftCmd(page, "KeyT");
  assert.equal(await has(page, ".bottom"), false, "the timeline is hidden");
  s = await rect(page, "[data-testid=stage]");
  assert.ok(Math.abs(s.height - (stage0.height + bottom0.height)) < 3, `the preview takes the timeline's room (${stage0.height} → ${s.height})`);
  await shot(page, "panels-hidden");

  // The top bar's toggles name their part and its fixed View key in the shared tooltip (#86, D256).
  const tipOf = async (sel: string) => {
    await page.mouse.move(5, 5);
    await page.waitForFunction(() => !document.querySelector("[data-testid=tooltip]"), { timeout: 3000 });
    await sleep(700);
    assert.equal(await page.$eval(sel, (el) => el.getAttribute("title")), null, `${sel}: no native title`);
    await page.hover(sel);
    await waitFor(page, "[data-testid=tooltip]");
    return page.$eval("[data-testid=tooltip]", (el) => ({
      label: el.querySelector(".tooltip-label")?.textContent ?? "",
      keys: [...el.querySelectorAll("kbd")].map((k) => k.textContent ?? ""),
    }));
  };
  assert.deepEqual(await tipOf("[data-testid=toggle-side]"), { label: "Show the right panel", keys: ["⇧⌘I"] });
  assert.deepEqual(await tipOf("[data-testid=toggle-lib]"), { label: "Show the left panel", keys: ["⇧⌘L"] });
  assert.deepEqual(await tipOf("[data-testid=toggle-bottom]"), { label: "Show the timeline", keys: ["⇧⌘T"] });
  assert.deepEqual(await tipOf("[data-testid=toggle-focus]"), { label: "Focus mode: only the preview and the agent", keys: ["⇧⌘F"] });
  await shot(page, "toggle-tooltip");
  // A disabled control shows its tip too (Redo with nothing to redo).
  assert.equal(await page.$eval("[data-testid=redo]", (el) => (el as HTMLButtonElement).disabled), true);
  assert.deepEqual(await tipOf("[data-testid=redo]"), { label: "Redo", keys: ["⇧⌘Z"] });
  await page.mouse.move(5, 5);

  // The top bar's buttons bring each one back.
  await page.click("[data-testid=toggle-side]");
  await sleep(450);
  assert.ok(Math.abs((await rect(page, "aside.side")).width - side0.width) < 3, "the right panel is back at its width");
  await page.click("[data-testid=toggle-lib]");
  await page.click("[data-testid=toggle-bottom]");
  await sleep(450);
  s = await rect(page, "[data-testid=stage]");
  assert.ok(Math.abs(s.width - stage0.width) < 3 && Math.abs(s.height - stage0.height) < 3, "everything back as it was");

  // ---- Focus mode: the preview and the agent only ----
  await shiftCmd(page, "KeyF");
  for (const sel of ["[data-testid=library]", ".rail", "aside.side", ".bottom"]) assert.equal(await has(page, sel), false, `${sel} is hidden in focus mode`);
  await waitFor(page, "[data-testid=focus-agent] [data-testid=agent-input]");
  const focusAgent = await rect(page, "[data-testid=focus-agent]");
  s = await rect(page, "[data-testid=stage]");
  // D270 (#98): the preview on the left, the agent a full-height column on the right.
  assert.ok(s.x < 1, "the preview starts at the window's left edge");
  assert.ok(Math.abs(s.x + s.width - focusAgent.x) < 2, "the agent is beside the preview, on the right");
  assert.ok(Math.abs(focusAgent.x + focusAgent.width - win.w) < 3, "up to the window's right edge");
  assert.ok(Math.abs(focusAgent.y - s.y) < 2 && Math.abs(focusAgent.y + focusAgent.height - win.h) < 3, "full height under the top bar");
  assert.ok(await has(page, "[data-testid=focus-exit]"), "a visible way out");
  await shot(page, "focus");
  await page.click("[data-testid=focus-exit]");
  await sleep(450);
  assert.ok((await has(page, "[data-testid=library]")) && (await has(page, ".bottom")) && (await has(page, "aside.side")), "focus mode left: everything back");

  // ---- Remembered on this Mac: the timeline hidden, then a relaunch ----
  await shiftCmd(page, "KeyT");
  assert.equal(await has(page, ".bottom"), false);
  assert.deepEqual(JSON.parse((await page.evaluate(() => localStorage.getItem("uncut.layout.hidden"))) ?? "{}"), {
    lib: false,
    side: false,
    bottom: true,
    focus: false,
  });
  await app.close();
  apps.delete(app);

  app = await launch([]);
  page = app.page;
  await waitForWelcome(page);
  await waitFor(page, "[data-testid=recent]");
  await page.click("[data-testid=recent]");
  await waitFor(page, "[data-testid=editor]");
  await sleep(800);
  assert.equal(await has(page, ".bottom"), false, "the timeline stays hidden after a relaunch");
  assert.ok((await has(page, "[data-testid=library]")) && (await has(page, "aside.side")), "the others still show");
  assert.equal(await page.$eval("[data-testid=toggle-bottom]", (el) => el.getAttribute("aria-pressed")), "false");
  await shot(page, "relaunch");
  // Focus mode is remembered too.
  await shiftCmd(page, "KeyF");
  await app.close();
  apps.delete(app);
  app = await launch([]);
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=recent]");
  await waitFor(page, "[data-testid=focus-agent]");
  assert.ok(await has(page, "[data-testid=focus-exit]"));
  await page.click("[data-testid=focus-exit]");
  await sleep(450);
  assert.equal(await has(page, ".bottom"), false, "leaving focus mode keeps what was hidden before");
  await page.click("[data-testid=toggle-bottom]");
  await waitFor(page, ".bottom");
});
