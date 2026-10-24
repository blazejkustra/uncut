// Issues #48 and #52 on the packaged app, run invisibly.
// #48: after clicking around (a text field, the ruler, the stage, a number field, a checkbox, a
// slider, a button), Space plays the timeline and no field changes; a field really being typed in
// still takes the space, and Esc leaves it.
// #52: a notice banner floats over the panels: showing and dismissing it moves no panel.
// Screenshots: test-output/issue48-52-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", `issue48-52-${name}.png`);
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const rect = (selector: string) => page.$eval(selector, (el) => el.getBoundingClientRect().toJSON() as DOMRect);
const ppf = () => page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
const xOf = async (frame: number) => (await rect("[data-testid=lanes]")).left + frame * (await ppf());
const item = (id: string) => `[data-testid=timeline-item][data-item="${id}"]`;
const seek = async (frame: number) => {
  const ruler = await rect("[data-testid=ruler]");
  await page.mouse.click(await xOf(frame), ruler.top + ruler.height - 6);
  await page.waitForFunction(
    (f) => Math.abs(Number((document.querySelector("[data-testid=preview-frame]") as HTMLElement).dataset.frame) - f) <= 1,
    { timeout: 5000 },
    frame,
  );
};
const playing = () => page.$eval("[data-testid=play]", (el) => /Pause/.test((el as HTMLElement).getAttribute("aria-label") ?? ""));
const waitPlaying = (on: boolean) =>
  page.waitForFunction(
    (want) => /Pause/.test((document.querySelector("[data-testid=play]") as HTMLElement | null)?.getAttribute("aria-label") ?? "") === want,
    { timeout: 5000 },
    on,
  );
const value = (selector: string) => page.$eval(selector, (el) => (el as HTMLInputElement).value);
const focused = () => page.evaluate(() => document.activeElement?.tagName ?? "");
/** Space plays (and nothing is left focused to type in), Space again pauses. */
const spacePlays = async (what: string) => {
  assert.equal(await playing(), false, `${what}: paused before Space`);
  await page.keyboard.press("Space");
  await waitPlaying(true).catch(async () => assert.fail(`${what}: Space didn't play (focus on ${await focused()})`));
  assert.ok(!["INPUT", "TEXTAREA", "SELECT"].includes(await focused()), `${what}: no field keeps focus`);
  await page.keyboard.press("Space");
  await waitPlaying(false);
};
const PANELS = [".rail", ".library", ".stage", ".side", ".bottom", "[data-testid=preview-frame]", "[data-testid=lanes]"];
const panelRects = () =>
  page.evaluate(
    (sels) =>
      sels.map((s) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        return { s, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }),
    PANELS,
  );

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue48-")));
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=640x360:rate=30",
    "-t",
    "10",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    join(root, "Shot.mp4"),
  ]);
  dir = join(root, "Issue48.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Issue48",
      canvas: { width: 1920, height: 1080, fps: 30 },
      textLooks: 1,
      media: [
        {
          id: "m-shot",
          kind: "video",
          name: "Shot.mp4",
          path: join(root, "Shot.mp4"),
          probe: { frames: 300, fps: 30, width: 640, height: 360, hasAudio: false },
        },
      ],
      tracks: [
        // Locked, so splitting the title is refused with a notice banner (#52).
        {
          id: "text",
          kind: "text",
          name: "Text",
          locked: true,
          items: [
            {
              id: "t1",
              type: "text",
              start: 0,
              duration: 120,
              text: "Launch day",
              transform: { x: 160, y: 440 },
              style: { preset: "text.title", size: 140, weight: 700 },
            },
          ],
        },
        { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "a", type: "clip", media: "m-shot", in: 0, duration: 300 }] },
      ],
    }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const open = async () => {
  if (app) return;
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  await waitFor(item("a"));
  await page.click("[data-testid=bottom-timeline]");
};

test("issue #48: Space plays after clicking fields and controls; no field changes; a field being typed in keeps it", { skip, timeout: 240000 }, async () => {
  await open();
  await page.click("[data-testid=tab-inspector]");
  await waitFor("[data-testid=inspector-name]");
  const name = await value("[data-testid=inspector-name]");

  // ---- A text field clicked, then the ruler (a press the timeline cancels) ----
  await page.click("[data-testid=inspector-name]");
  assert.equal(await focused(), "INPUT");
  await seek(60);
  await spacePlays("name field, then the ruler");
  assert.equal(await value("[data-testid=inspector-name]"), name, "the name didn't get a space");

  // ---- Really typing in it: Space is a space; Esc puts the name back and leaves the field ----
  await page.click("[data-testid=inspector-name]");
  await page.keyboard.press("End");
  await page.keyboard.type("x ");
  await sleep(300);
  assert.equal(await value("[data-testid=inspector-name]"), `${name}x `, "typed text keeps its space");
  assert.equal(await playing(), false, "typing a space doesn't play");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.tagName !== "INPUT", { timeout: 3000 });
  assert.equal(await value("[data-testid=inspector-name]"), name, "Esc put the name back");
  await spacePlays("after Esc in the name field");

  // ---- A text field clicked, then the stage ----
  await page.click("[data-testid=inspector-name]");
  const stage = await rect("[data-testid=preview-frame]");
  await page.mouse.click(stage.left + stage.width * 0.9, stage.top + stage.height * 0.9);
  await sleep(200);
  await spacePlays("name field, then the stage");

  // ---- The clip's controls ----
  await page.click(item("a"));
  await waitFor("[data-testid=insp-opacity-num]");
  // A number field: a click puts the caret in it, but a space is never a number.
  await page.click("[data-testid=insp-opacity-num]");
  await sleep(100);
  const opacity = await value("[data-testid=insp-opacity-num]");
  await spacePlays("opacity number field");
  assert.equal(await value("[data-testid=insp-opacity-num]"), opacity, "the number field is unchanged");

  // A checkbox: the click sets it, Space doesn't toggle it back.
  await page.click("[data-testid=insp-loop]");
  await page.waitForFunction(() => (document.querySelector("[data-testid=insp-loop]") as HTMLInputElement).checked, { timeout: 5000 });
  await spacePlays("loop checkbox");
  assert.equal(await page.$eval("[data-testid=insp-loop]", (el) => (el as HTMLInputElement).checked), true, "the checkbox is unchanged");

  // A slider: the click sets it, Space leaves it be.
  const slider = await rect("[data-testid=insp-opacity]");
  await page.mouse.click(slider.left + slider.width * 0.75, slider.top + slider.height / 2);
  await page.waitForFunction(() => (document.querySelector("[data-testid=insp-opacity]") as HTMLInputElement).value !== "100", { timeout: 5000 });
  await sleep(400);
  const sliderValue = await value("[data-testid=insp-opacity]");
  await spacePlays("opacity slider");
  assert.equal(await value("[data-testid=insp-opacity]"), sliderValue, "the slider is unchanged");

  // A button.
  await page.click("[data-testid=bottom-timeline]");
  await spacePlays("a button");
  await page.screenshot({ path: out("after-space") });
  assert.deepEqual(app!.errors, []);
});

test("issue #52: a notice banner floats over the panels; showing and dismissing it moves nothing", { skip, timeout: 120000 }, async () => {
  await open();
  await page.keyboard.press("Escape");
  await seek(45);
  await page.click(item("t1"));
  await sleep(300);
  const before = await panelRects();
  await page.keyboard.press("s");
  await waitFor("[data-testid=editor-error]");
  await page.waitForFunction(() => /locked/.test(document.querySelector("[data-testid=editor-error]")?.textContent ?? ""));
  await sleep(300);
  await page.screenshot({ path: out("banner") });
  assert.deepEqual(await panelRects(), before, "the banner moved no panel");
  const banner = await rect("[data-testid=editor-error]");
  const stage = await rect(".stage");
  assert.ok(banner.top >= 40 && banner.top < stage.top + 40, `the banner sits just under the top bar, over the panels (top ${banner.top}, stage ${stage.top})`);
  await page.click("[data-testid=editor-error] button");
  await page.waitForFunction(() => !document.querySelector("[data-testid=editor-error]"), { timeout: 5000 });
  await sleep(300);
  assert.deepEqual(await panelRects(), before, "dismissing it moved no panel");
  await page.screenshot({ path: out("dismissed") });
  assert.deepEqual(app!.errors, []);
});
