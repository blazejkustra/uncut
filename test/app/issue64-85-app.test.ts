// Issues #64 and #85 (D235) on the packaged app run invisibly and muted, with the stand-in claude:
// - #64: the Agent tab has no "Follow agent" toggle; the agent's ui_show never moves the playhead
//   or the selection, it only puts up the "Agent changed …" pill;
// - #85: the user parks the playhead and leaves the timeline alone (the old follow rule steered
//   an idle user after 3 s); a turn edits elsewhere and points there; the user presses Space mid-turn
//   and playback starts where they were, moving forward only, while the agent keeps editing.
// Screenshots: test-output/issue64-agent-tab.png, issue85-pill.png, issue85-playing.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let home = "";
const apps = new Set<LaunchedApp>();
const shot = (name: string) => resolve("test-output", `${name}.png`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue64-85-")));
  home = join(root, "home");
  mkdirSync(join(home, "Projects"), { recursive: true });
  writeFileSync(join(root, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const text = (id: string, start: number, duration: number, words: string) => ({ id, type: "text", start, duration, text: words, transform: { x: 154, y: 410 }, style: { preset: "text.title", size: 120, weight: 700 } });

test("issues 64, 85: no Follow agent; Space mid-turn plays from where the user is", { skip, timeout: 240000 }, async () => {
  const plan = join(root, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify([
      // Turn 1: a 20 s timeline to watch.
      [
        { tool: "project_read" },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Two titles", ops: [{ op: "insert_item", track: "text", item: text("title-1", 0, 300, "First") }, { op: "insert_item", track: "text", item: text("title-2", 300, 300, "Second") }] } },
        { tool: "ui_show", args: { frame: 300, select: ["title-2"] } },
        { text: "Two titles are in." },
      ],
      // Turn 2: edits at 0:15 and points there, keeps working, edits again at 0:17 and points there.
      [
        { tool: "project_read" },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "A line at 0:15", ops: [{ op: "insert_item", track: "text", item: text("far-1", 450, 60, "Elsewhere") }] } },
        { tool: "ui_show", args: { frame: 450, select: ["far-1"] } },
        { sleep: 4000 },
        { tool: "project_read" },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "A line at 0:17", ops: [{ op: "insert_item", track: "text", item: text("far-2", 510, 60, "Further") }] } },
        { tool: "ui_show", args: { frame: 510, select: ["far-2"] } },
        { sleep: 1500 },
        { text: "Added two lines at 0:15 and 0:17." },
      ],
    ]),
  );
  const app = await launchApp({
    command: APP,
    env: { HOME: home, UNCUT_FONT_DIRS: "", UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(home, "Projects")]), UNCUT_CLAUDE: join(root, "claude"), FAKE_PLAN: plan, UNCUT_APPROVAL_MS: "60000" },
  });
  apps.add(app);
  const { page } = app;
  const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
  const frame = () => page.$eval("[data-testid=preview-frame]", (el) => Number((el as HTMLElement).dataset.frame));
  const playing = () => page.$eval("[data-testid=play]", (el) => (el.getAttribute("aria-label") ?? "").startsWith("Pause"));
  const turnStatus = (n: number) => page.$$eval("[data-testid=agent-turn]", (els, i) => els[i]?.getAttribute("data-status") ?? "", n);
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=new-project]");
    await waitFor("[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor("[data-testid=agent-panel]");

    // ---- #64: no toggle; turn 1's ui_show is a pill, the playhead and the selection stay ----
    assert.equal(await page.$("[data-testid=agent-follow]"), null, "no Follow agent toggle");
    await page.click("[data-testid=agent-input]");
    await page.keyboard.type("Make two titles");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("[data-testid=agent-turn]")?.getAttribute("data-status") === "done", { timeout: 60000 });
    await waitFor("[data-testid=agent-change]");
    assert.equal(await frame(), 0, "the agent didn't move the playhead");
    assert.equal(await page.$('[data-testid=timeline-item][data-item="title-2"].selected'), null, "nor select");
    assert.equal(await page.$eval("[data-testid=agent-change-jump]", (el) => (el as HTMLElement).innerText.trim()), "Agent changed 0:10–0:20");
    assert.equal(await page.$("[data-testid=agent-follow]"), null);
    await page.screenshot({ path: shot("issue64-agent-tab") });
    await page.click("[data-testid=agent-change-dismiss]");

    // ---- #85 ----
    // The user parks the playhead at 0:02 (frame 60) and leaves the timeline alone (> the old 3 s).
    await page.click("[data-testid=timeline]");
    await page.keyboard.press("Home");
    await page.keyboard.down("Shift");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.up("Shift");
    await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === 60, { timeout: 5000 });
    await sleep(3300);
    await page.click("[data-testid=agent-input]");
    await page.keyboard.type("Add a line somewhere later");
    await page.keyboard.press("Enter");
    // The agent edits at 0:15 and points there, mid-turn: the playhead stays at 60.
    await page.waitForFunction(() => document.querySelector("[data-testid=agent-change]")?.getAttribute("data-from") === "450", { timeout: 30000 });
    assert.equal(await turnStatus(1), "running", "still in the turn");
    assert.equal(await frame(), 60, "the agent's pointer didn't move the playhead");
    assert.equal(await page.$('[data-testid=timeline-item][data-item="far-1"].selected'), null);
    await page.screenshot({ path: shot("issue85-pill") });
    // Space (the composer lets go of the focus first): playback starts from 60 while the turn goes on.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=play]")!.getAttribute("aria-label")!.startsWith("Pause"), { timeout: 5000 });
    const frames: Array<number> = [];
    let sawSecond = false;
    for (let i = 0; i < 30 && !(sawSecond && frames.length > 8); i++) {
      frames.push(await frame());
      assert.ok(await playing(), `still playing at sample ${i} (frames ${frames.join(", ")})`);
      sawSecond ||= (await page.$eval("[data-testid=agent-change]", (el) => el.getAttribute("data-from")).catch(() => null)) === "510";
      await sleep(150);
    }
    assert.ok(sawSecond, "the agent pointed at 0:17 while the user played");
    assert.ok(frames[0]! >= 60 && frames[0]! < 80, `playback started where the user was: ${frames.join(", ")}`);
    for (let i = 1; i < frames.length; i++) assert.ok(frames[i]! >= frames[i - 1]!, `the playhead only moved forward: ${frames.join(", ")}`);
    assert.ok(frames.every((f) => f < 300), `never jumped to the agent's frames: ${frames.join(", ")}`);
    await page.screenshot({ path: shot("issue85-playing") });
    await page.keyboard.press("Space");
    await page.waitForFunction(() => !document.querySelector<HTMLElement>("[data-testid=play]")!.getAttribute("aria-label")!.startsWith("Pause"), { timeout: 5000 });
    const paused = await frame();
    assert.ok(paused >= frames.at(-1)! && paused < 300, `paused where playback got to: ${paused}`);
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=agent-turn]")[1]?.getAttribute("data-status") === "done", { timeout: 30000 });
    assert.equal(await frame(), paused, "the end of the turn doesn't move it either");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
    apps.delete(app);
  }
});
