// User feedback round 3, editor (planning/FEEDBACK.md U10–U14, D176–D180), on the packaged app run
// invisibly and muted, with the stand-in claude:
// - U14: a new project opens on the Agent tab; reopening a project brings back the tab it was left on.
// - U11: Transcript is a rail tab (its panel in the left column); the bottom keeps Timeline and Mixer.
// - U10: a middle-button drag on the preview pans it, at Fit and zoomed in, without touching the project.
// - U13: typing in the composer, menus, resizing and scrolling panels never scroll the window's root.
// - U12: closing the project with a running agent turn and a value being typed asks in the app
//   (Cancel stays; Save and wait saves the value, waits for the turn, then closes); with nothing
//   pending it closes at once; closing the window with a turn running asks too, and Discard and stop
//   quits; the test's SIGTERM never waits on the dialog.
// Screenshots: test-output/round3-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", `round3-${name}.png`);
const plan = () => join(root, "plan.json");
const turns: Array<unknown> = [];
const nextTurn = (steps: Array<unknown>) => {
  turns.push(steps);
  writeFileSync(plan(), JSON.stringify(turns));
};

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-round3-")));
  mkdirSync(join(root, "projects"));
  writeFileSync(plan(), "[]");
  writeFileSync(join(root, "prompts.jsonl"), "");
  // A 4 s clip with sound (so the transcript lists it) for the timeline, the menus and the preview.
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=640x360:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "4",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    join(root, "Talk.mp4"),
  ]);
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

function ui(page: Page) {
  const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
  const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
  const activeSide = () => page.$$eval(".side .tabs button.active", (els) => els.map((e) => (e as HTMLElement).dataset.testid));
  /** Every root-level scroller: where it is and whether it could scroll at all. */
  const rootScroll = () =>
    page.evaluate(() => {
      const els = [
        document.scrollingElement!,
        document.documentElement,
        document.body,
        document.getElementById("root")!,
        document.querySelector(".app") ?? document.body,
      ];
      return els.map((el) => ({
        name: el === document.scrollingElement ? "scrollingElement" : el.id || el.className || el.tagName,
        top: el.scrollTop,
        left: el.scrollLeft,
        over: el.scrollHeight - el.clientHeight,
        wide: el.scrollWidth - el.clientWidth,
      }));
    });
  const assertNoRootScroll = async (when: string) => {
    for (const r of await rootScroll()) {
      assert.equal(r.top, 0, `${when}: ${r.name} scrollTop`);
      assert.equal(r.left, 0, `${when}: ${r.name} scrollLeft`);
      assert.ok(r.over <= 1 && r.wide <= 1, `${when}: ${r.name} overflows (${r.over} px down, ${r.wide} px across)`);
    }
  };
  return { waitFor, revision, activeSide, rootScroll, assertNoRootScroll };
}

test(
  "round 3 editor: Agent tab first, Transcript in the rail, middle-button pan, no root scroll, leaving with work in progress",
  { skip, timeout: 300000 },
  async () => {
    const app = await launchApp({
      command: APP,
      env: {
        UNCUT_DATA_DIR: join(root, "data"),
        UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects"), [join(root, "Talk.mp4")]]),
        UNCUT_CLAUDE: FAKE,
        FAKE_PLAN: plan(),
        FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      },
    });
    apps.add(app);
    const { page } = app;
    const { waitFor, revision, activeSide, rootScroll, assertNoRootScroll } = ui(page);
    try {
      // ---- U14: a new project opens on the Agent tab ----
      await waitForWelcome(page);
      await page.click("[data-testid=new-project]");
      await waitFor("[data-testid=new-project-form]");
      await page.click("[data-testid=choose-folder]");
      await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
      await page.click("[data-testid=create]");
      await waitFor("[data-testid=editor]");
      await waitFor("[data-testid=agent-panel]");
      assert.deepEqual(await activeSide(), ["tab-agent"]);
      await page.screenshot({ path: out("new-project-agent") });
      const dir = await page.$eval("[data-testid=project-title]", (el) => (el as HTMLElement).title);
      const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));

      // The clip on the main track.
      await page.click("[data-testid=import]");
      await page.waitForFunction(() => document.querySelectorAll("[data-testid=media-tile]").length === 1, { timeout: 60000 });
      await page.$eval("[data-testid=media-tile] [data-testid=add-to-timeline]", (el) => (el as HTMLElement).click());
      await waitFor("[data-testid=timeline-item]");

      // ---- U11: Transcript is a rail tab; the bottom has Timeline and Mixer ----
      assert.equal(await page.$("[data-testid=bottom-transcript]"), null);
      assert.deepEqual(await page.$$eval("[data-testid=bottom-tabs] button", (els) => els.map((e) => e.textContent?.trim())), ["Timeline", "Mixer"]);
      await page.click("[data-testid=rail-transcript]");
      await waitFor("[data-testid=transcript-panel] [data-testid=tx-block]");
      const lib = await page.$eval("[data-testid=transcript-panel]", (el) => ({ area: getComputedStyle(el).gridArea, ...el.getBoundingClientRect().toJSON() }));
      const rail = await page.$eval("[data-testid=rail]", (el) => el.getBoundingClientRect().toJSON());
      assert.match(lib.area, /^lib/);
      assert.ok(Math.abs(lib.left - rail.right) <= 1, "the panel sits right of the rail");
      // The timeline stays on screen under it, and its tools (fillers, pauses, captions) are there.
      await waitFor("[data-testid=timeline]");
      for (const id of ["remove-fillers", "remove-pauses", "pause-threshold", "make-captions"])
        assert.ok(await page.$(`[data-testid=transcript-panel] [data-testid=${id}]`), id);
      await page.screenshot({ path: out("transcript-rail") });

      // ---- U10: a middle-button drag pans the preview, at Fit and zoomed in ----
      const frameMove = () => page.$eval("[data-testid=preview-frame]", (el) => (el as HTMLElement).style.transform);
      const rev0 = await revision();
      const selection = () => page.$$eval("[data-testid=timeline-item].selected", (els) => els.map((e) => (e as HTMLElement).dataset.item));
      const selected0 = await selection();
      const stage = await page.$eval("[data-testid=stage-canvas]", (el) => el.getBoundingClientRect().toJSON());
      const cx = stage.left + stage.width / 2;
      const cy = stage.top + stage.height / 2;
      const middleDrag = async (dx: number, dy: number) => {
        await page.mouse.move(cx, cy);
        await page.mouse.down({ button: "middle" });
        await page.mouse.move(cx + dx / 2, cy + dy / 2, { steps: 4 });
        assert.equal(await page.$eval("[data-testid=stage-canvas]", (el) => el.classList.contains("panning")), true, "a grabbing cursor while panning");
        await page.mouse.move(cx + dx, cy + dy, { steps: 4 });
        await page.mouse.up({ button: "middle" });
      };
      assert.equal(await frameMove(), "");
      await middleDrag(60, 30);
      assert.equal(await frameMove(), "translate(60px, 30px)", "panned at Fit");
      assert.equal(await page.$eval("[data-testid=stage-canvas]", (el) => el.classList.contains("panning")), false);
      await page.select("[data-testid=preview-zoom]", "2");
      await middleDrag(-80, -40);
      assert.match(await frameMove(), /^translate\(/);
      assert.notEqual(await frameMove(), "translate(60px, 30px)", "panned zoomed in");
      assert.equal(await page.$eval("[data-testid=stage-canvas]", (el) => (el as HTMLElement).dataset.zoom), "2.000");
      await page.screenshot({ path: out("middle-pan") });
      await page.select("[data-testid=preview-zoom]", "fit");
      await sleep(300);
      assert.equal(await revision(), rev0, "panning never edits the project");
      assert.deepEqual(await selection(), selected0, "nor the selection");

      // ---- U13: the root never scrolls ----
      await assertNoRootScroll("start");
      await page.click("[data-testid=tab-agent]");
      await page.click("[data-testid=agent-input]");
      for (let i = 0; i < 30; i++) {
        await page.keyboard.type(`line ${i}`);
        await page.keyboard.down("Shift");
        await page.keyboard.press("Enter");
        await page.keyboard.up("Shift");
      }
      await assertNoRootScroll("after typing in the composer");
      await page.$eval("[data-testid=agent-input]", (el) => {
        const t = el as HTMLTextAreaElement;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(t, "");
        t.dispatchEvent(new Event("input", { bubbles: true }));
      });
      // The clip's menu, opened as low in the window as the timeline goes, then its submenu by keys.
      const item = await page.$eval("[data-testid=timeline-item]", (el) => el.getBoundingClientRect().toJSON());
      await page.mouse.click(item.left + 10, item.bottom - 3, { button: "right" });
      await waitFor(".ctx-menu");
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowRight");
      await assertNoRootScroll("with the item menu open");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      // Every panel edge dragged to its extremes.
      const drag = async (id: string, dx: number, dy: number) => {
        const r = await page.$eval(`[data-testid=resize-${id}]`, (el) => el.getBoundingClientRect().toJSON());
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + dx, y + dy, { steps: 6 });
        await page.mouse.up();
      };
      await drag("bottom", 0, -1000);
      await drag("lib", 1000, 0);
      await drag("side", -1000, 0);
      await assertNoRootScroll("panels at their largest");
      await drag("bottom", 0, 1000);
      await drag("lib", -1000, 0);
      await drag("side", 1000, 0);
      await assertNoRootScroll("panels at their smallest");
      // Panels scroll inside themselves; scripted scrolls and scrollIntoView can't move the root.
      for (const id of ["rail-text", "rail-effects", "rail-transitions"]) {
        await page.click(`[data-testid=${id}]`);
        await page.$eval(".library", (el) => el.scrollTo(0, el.scrollHeight));
        await page.$eval(".library", (el) => el.lastElementChild?.lastElementChild?.scrollIntoView());
      }
      await page.$eval(".bottom-body", (el) => el.scrollTo(400, 400));
      await page.evaluate(() => {
        document.scrollingElement!.scrollTop = 200;
        document.body.scrollTop = 200;
        document.getElementById("root")!.scrollTop = 200;
        document.querySelector(".app")!.scrollTop = 200;
        document.querySelector<HTMLElement>("[data-testid=resize-bottom]")!.scrollIntoView();
        [...document.querySelectorAll(".rail button")].at(-1)!.scrollIntoView();
      });
      await sleep(100);
      await assertNoRootScroll("after panel scrolls and scripted scrolls");
      await page.setViewport({ width: 1024, height: 640 });
      await sleep(300);
      // Ten rail tabs fit (or the rail scrolls) at the smallest window.
      await assertNoRootScroll("at 1024×640");
      const railBox = await page.$eval("[data-testid=rail]", (el) => ({
        bottom: el.getBoundingClientRect().bottom,
        scroll: el.scrollHeight - el.clientHeight,
        overflow: getComputedStyle(el).overflowY,
      }));
      const bottomTop = await page.$eval(".bottom", (el) => el.getBoundingClientRect().top);
      assert.ok(railBox.bottom <= bottomTop + 1, "the rail ends above the timeline");
      assert.ok(railBox.scroll <= 0 || railBox.overflow === "auto", "tabs that don't fit scroll in the rail");
      await page.screenshot({ path: out("no-root-scroll") });
      await page.setViewport({ width: 1280, height: 800 });
      void rootScroll;

      // ---- U12: nothing pending: Close project closes at once ----
      await page.click("[data-testid=tab-inspector]");
      await page.click("[data-testid=close-project]");
      await waitForWelcome(page);
      assert.equal(await page.$("[data-testid=leave-dialog]"), null);

      // ---- U14: reopened, the project comes back on the tab it was left on (Inspector) ----
      await page.click("[data-testid=recent]");
      await waitFor("[data-testid=editor]");
      assert.deepEqual(await activeSide(), ["tab-inspector"]);
      await page.click("[data-testid=tab-history]");

      // ---- U12: a running agent turn and a value being typed ----
      nextTurn([{ tool: "project_read" }, { sleep: 4000 }, { text: "Done thinking." }]);
      await page.click("[data-testid=tab-agent]");
      await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"));
      await page.click("[data-testid=agent-input]");
      await page.type("[data-testid=agent-input]", "take a moment");
      await page.keyboard.press("Enter");
      await waitFor("[data-testid=agent-turn][data-status=running] [data-testid=agent-step][data-status=done]");
      await page.click("[data-testid=tab-inspector]");
      await page.click("[data-testid=inspector-name]", { clickCount: 3 });
      await page.keyboard.type("Renamed while busy");
      // ⌘W with the field still focused (a click on the X would leave the field, which saves it).
      const closeKeys = async () => {
        await page.keyboard.down("Meta");
        await page.keyboard.press("w");
        await page.keyboard.up("Meta");
      };
      await closeKeys();
      await waitFor("[data-testid=leave-dialog][data-reason=close-project]");
      const items = () => page.$$eval("[data-testid=leave-item]", (els) => els.map((e) => e.textContent?.trim()));
      assert.deepEqual(await items(), ["A value being typed", "The agent is working"]);
      const buttons = await page.$$eval("[data-testid=leave-dialog] button", (els) => els.map((e) => e.textContent?.trim()));
      assert.deepEqual(buttons, ["Cancel", "Discard and stop", "Save and wait"]);
      assert.doesNotMatch(await page.$eval("[data-testid=leave-dialog]", (el) => el.textContent ?? ""), /[·*•]/);
      await page.screenshot({ path: out("leave-dialog") });
      // Cancel: still in the project, the name still being typed (not saved).
      await page.click("[data-testid=leave-cancel]");
      await page.waitForFunction(() => !document.querySelector("[data-testid=leave-dialog]"));
      assert.ok(await page.$("[data-testid=editor]"));
      assert.notEqual(onDisk().name, "Renamed while busy");
      // Save and wait: the name is saved, the dialog waits for the turn, then the project closes.
      await page.click("[data-testid=inspector-name]");
      await page.keyboard.press("End");
      await page.keyboard.type("!");
      await closeKeys();
      await waitFor("[data-testid=leave-dialog]");
      await page.click("[data-testid=leave-keep]");
      await waitFor("[data-testid=leave-dialog][data-waiting=true]");
      await page.waitForFunction(() => [...document.querySelectorAll("[data-testid=leave-item]")].every((e) => e.getAttribute("data-id") === "agent"), {
        timeout: 5000,
      });
      await page.screenshot({ path: out("leave-waiting") });
      await waitForWelcome(page, 20000);
      assert.equal(onDisk().name, "Renamed while busy!");

      // ---- U12: closing the window with a turn running asks; Discard and stop quits ----
      await page.click("[data-testid=recent]");
      await waitFor("[data-testid=editor]");
      nextTurn([{ tool: "project_read" }, { sleep: 60000 }]);
      await page.click("[data-testid=tab-agent]");
      await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"));
      await page.click("[data-testid=agent-input]");
      await page.type("[data-testid=agent-input]", "a long one");
      await page.keyboard.press("Enter");
      await waitFor("[data-testid=agent-turn][data-status=running] [data-testid=agent-step][data-status=done]");
      // The window's close button (SIGUSR2 is the test stand-in for it, D178).
      app.proc.kill("SIGUSR2");
      await waitFor("[data-testid=leave-dialog][data-reason=window]");
      assert.equal(await page.$eval("[data-testid=leave-dialog] .confirm-title", (el) => el.textContent), "Close Uncut?");
      // Not answered by a timeout: the window waits for the user.
      await sleep(2500);
      assert.equal(app.proc.exitCode, null, "the window is still open");
      await page.screenshot({ path: out("leave-window") });
      const quitAt = Date.now();
      await page.click("[data-testid=leave-drop]").catch(() => {});
      await app.exited;
      apps.delete(app);
      assert.ok(Date.now() - quitAt < 8000, `quit in ${Date.now() - quitAt} ms`);
      assert.deepEqual(app.errors, []);
    } catch (error) {
      await page.screenshot({ path: out("failure") }).catch(() => {});
      const output = app.output().slice(-3000);
      // Quit now, not in after(): a window still open holds the single-instance lock, so the next
      // test's launch would exit at once and fail for this one's reason.
      await app.close().catch(() => {});
      apps.delete(app);
      throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${output}` });
    }
  },
);

test("round 3: a quit by signal (the test's teardown) never waits on the leave dialog", { skip, timeout: 120000 }, async () => {
  const app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan(), FAKE_PROMPT_LOG: join(root, "prompts.jsonl") },
  });
  apps.add(app);
  const { page } = app;
  const { waitFor } = ui(page);
  await waitForWelcome(page);
  await page.click("[data-testid=recent]");
  await waitFor("[data-testid=editor]");
  // A turn that runs past the teardown, and a value being typed.
  nextTurn([{ tool: "project_read" }, { sleep: 60000 }]);
  await page.click("[data-testid=tab-agent]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"));
  await page.click("[data-testid=agent-input]");
  await page.type("[data-testid=agent-input]", "keep going");
  await page.keyboard.press("Enter");
  await waitFor("[data-testid=agent-turn][data-status=running]");
  const at = Date.now();
  await app.close();
  apps.delete(app);
  assert.ok(Date.now() - at < 6000, `SIGTERM quit in ${Date.now() - at} ms`);
});
