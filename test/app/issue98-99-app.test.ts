// Issues #98 and #99 on the packaged app, run invisibly.
// #98 (D270): focus mode (⇧⌘F) is the preview on the left and the agent (thread and composer) a
// full-height column on the right; the top bar's Leave focus button is a square-cornered button whose
// icon, label and key sit on one centre line.
// #99 (D271): hiding and showing the timeline (⇧⌘T) animates like the side panels (the preview's
// height passes through in-between values), and doesn't under prefers-reduced-motion.
// Screenshots: test-output/issue98-99-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let full = "";
const apps = new Set<LaunchedApp>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (page: Page, name: string) => page.screenshot({ path: `test-output/issue98-99-${name}.png` });
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const rect = (page: Page, selector: string) => page.$eval(selector, (el) => el.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number });
const has = async (page: Page, selector: string) => (await page.$(selector)) !== null;
const shiftCmd = async (page: Page, code: "KeyT" | "KeyF") => {
  await page.keyboard.down("Shift");
  await page.keyboard.down("Meta");
  await page.keyboard.press(code);
  await page.keyboard.up("Meta");
  await page.keyboard.up("Shift");
};
/** The preview's height on every frame for 450 ms while ⇧⌘T toggles the timeline. */
const timelineFrames = async (page: Page): Promise<Array<number>> => {
  const sampling = page.evaluate(
    () =>
      new Promise<Array<number>>((done) => {
        const out: Array<number> = [];
        const t0 = performance.now();
        const tick = () => {
          out.push(Math.round(document.querySelector("[data-testid=stage]")!.getBoundingClientRect().height));
          if (performance.now() - t0 < 450) requestAnimationFrame(tick);
          else done(out);
        };
        requestAnimationFrame(tick);
      }),
  );
  await sleep(30);
  await shiftCmd(page, "KeyT");
  return sampling;
};
const between = (frames: Array<number>) => {
  const a = frames[0]!;
  const b = frames[frames.length - 1]!;
  return [...new Set(frames.filter((h) => h > Math.min(a, b) + 2 && h < Math.max(a, b) - 2))];
};

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue98-")));
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
        { id: "text", kind: "text", name: "Text", items: [{ id: "t1", type: "text", start: 0, duration: 90, text: "Launch day", transform: { x: 160, y: 440 }, style: { preset: "text.title", size: 140, weight: 700 } }] },
        { id: "main", kind: "video", role: "main", name: "Main", items: [] },
      ],
    }),
  );
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("#98 #99: focus mode puts the agent on the right; the timeline animates", { skip, timeout: 180000 }, async () => {
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([full]) } });
  apps.add(app);
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor(page, "[data-testid=editor]");
  await waitFor(page, ".bottom");
  await sleep(1200);
  const win = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));

  // ---- #99: the timeline hides and shows over several frames ----
  const stage0 = await rect(page, "[data-testid=stage]");
  const hiding = await timelineFrames(page);
  assert.equal(await has(page, ".bottom"), false, "the timeline is hidden");
  assert.ok(hiding[hiding.length - 1]! > stage0.height + 50, `the preview took the room (${stage0.height} → ${hiding[hiding.length - 1]})`);
  assert.ok(between(hiding).length >= 3, `hiding animates: in-between heights ${JSON.stringify(between(hiding))} of ${JSON.stringify(hiding)}`);
  const showing = await timelineFrames(page);
  await waitFor(page, ".bottom");
  assert.ok(Math.abs(showing[showing.length - 1]! - stage0.height) < 3, "the timeline is back at its height");
  assert.ok(between(showing).length >= 3, `showing animates: ${JSON.stringify(showing)}`);
  // Mid-way through showing, for the record.
  await shiftCmd(page, "KeyT");
  await sleep(500);
  await shiftCmd(page, "KeyT");
  await sleep(90);
  await shot(page, "timeline-mid");
  await sleep(400);

  // Reduced motion: one jump.
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  const reduced = await timelineFrames(page);
  assert.equal(between(reduced).length, 0, `no animation under reduced motion: ${JSON.stringify(reduced)}`);
  await shiftCmd(page, "KeyT");
  await sleep(300);
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  await waitFor(page, ".bottom");

  // ---- #98: focus mode, the preview left and the agent right ----
  await shiftCmd(page, "KeyF");
  await waitFor(page, "[data-testid=focus-agent] [data-testid=agent-input]");
  await sleep(450);
  for (const sel of ["[data-testid=library]", ".rail", "aside.side", ".bottom"]) assert.equal(await has(page, sel), false, `${sel} is hidden in focus mode`);
  const s = await rect(page, "[data-testid=stage]");
  const agent = await rect(page, "[data-testid=focus-agent]");
  const top = await rect(page, ".topbar");
  assert.ok(s.x < 1 && Math.abs(s.x + s.width - agent.x) < 2, "the preview on the left, the agent right of it");
  assert.ok(agent.width >= 340 && agent.width < win.w / 2, `the agent is a column (${agent.width} of ${win.w})`);
  assert.ok(Math.abs(agent.x + agent.width - win.w) < 2, "to the right edge");
  assert.ok(Math.abs(agent.y - (top.y + top.height)) < 2 && Math.abs(agent.y + agent.height - win.h) < 2, "full height under the top bar");
  assert.ok(Math.abs(s.y + s.height - win.h) < 2, "the preview full height too");
  const input = await rect(page, "[data-testid=focus-agent] [data-testid=agent-input]");
  assert.ok(input.x >= agent.x && input.x + input.width <= agent.x + agent.width + 1 && input.y > agent.y + agent.height / 2, "the composer at the bottom of the column");

  // The Leave focus button: square corners, icon, label and key on one centre line.
  const exit = await page.$eval("[data-testid=focus-exit]", (el) => {
    const box = el.getBoundingClientRect();
    const mid = (r: DOMRect) => r.y + r.height / 2;
    const text = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())!;
    const range = document.createRange();
    range.selectNodeContents(text);
    return {
      radius: parseFloat(getComputedStyle(el).borderTopLeftRadius),
      box: mid(box),
      icon: mid(el.querySelector("svg")!.getBoundingClientRect()),
      text: mid(range.getBoundingClientRect()),
      kbd: mid(el.querySelector("kbd")!.getBoundingClientRect()),
    };
  });
  assert.ok(exit.radius <= 6, `not a pill (radius ${exit.radius})`);
  for (const k of ["icon", "text", "kbd"] as const) assert.ok(Math.abs(exit[k] - exit.box) <= 1, `${k} centred (${exit[k]} vs ${exit.box})`);
  await shot(page, "focus");
  const clip = await rect(page, "[data-testid=focus-exit]");
  await page.screenshot({ path: "test-output/issue98-99-focus-exit.png", clip: { x: clip.x - 8, y: clip.y - 8, width: clip.width + 16, height: clip.height + 16 } });

  await page.click("[data-testid=focus-exit]");
  await sleep(450);
  assert.ok((await has(page, "[data-testid=library]")) && (await has(page, ".bottom")) && (await has(page, "aside.side")), "everything back");
});
