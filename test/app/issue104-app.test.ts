// Issue #104 (D279) on the packaged app, run invisibly: on first launch the setup wizard is the
// window, edge to edge like Welcome: no frame around it, no border or rounded corners, the top row
// under the traffic lights is the drag region (its buttons aren't), the brand clears the traffic
// lights, and the step's content scrolls under fixed steps. Opened over the editor (Settings › App ›
// Agents and setup…) it is still the modal card. Screenshots: test-output/issue104-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let app: LaunchedApp | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const shot = (page: Page, name: string) => page.screenshot({ path: `test-output/issue104-${name}.png` });

/** Where the wizard card sits and how it's drawn, measured in the page. */
const card = (page: Page) =>
  page.evaluate(() => {
    const wiz = document.querySelector<HTMLElement>("[data-testid=onboarding] .modal.wiz")!;
    const r = wiz.getBoundingClientRect();
    const s = getComputedStyle(wiz);
    const region = (el: Element | null) => (el ? getComputedStyle(el).getPropertyValue("-webkit-app-region") : "");
    // The brand's text, not its box (the box starts at the window's edge, padded past the lights).
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(".wiz-brand")!);
    const brand = range.getBoundingClientRect();
    return {
      box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      win: { w: innerWidth, h: innerHeight },
      border: s.borderTopWidth,
      radius: s.borderTopLeftRadius,
      headerRegion: region(document.querySelector(".wiz-header")),
      skipRegion: region(document.querySelector("[data-testid=wizard-skip]")),
      stepRegion: region(document.querySelector("[data-testid=wizard-step-1]")),
      brand: { left: brand.left, top: brand.top, bottom: brand.bottom },
    };
  });

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue104-")));
  mkdirSync(join(root, "projects"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the first-launch wizard fills the window; over the editor it stays a modal", { skip, timeout: 180000 }, async () => {
  app = await launchApp({
    command: APP,
    firstLaunch: true,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]) },
  });
  const { page } = app;
  try {
    await waitFor(page, "[data-testid=onboarding]");
    for (const [w, h] of [
      [760, 720],
      [600, 520],
    ]) {
      await page.evaluate((w, h) => window.resizeTo(w, h), w, h);
      await sleep(500);
      const m = await card(page);
      const size = `${m.win.w}×${m.win.h}`;
      await shot(page, `1-first-launch-${m.win.w}`);
      assert.deepEqual(m.box, { left: 0, top: 0, right: m.win.w, bottom: m.win.h }, `${size}: the wizard spans the window`);
      assert.equal(m.border, "0px", `${size}: no border`);
      assert.equal(m.radius, "0px", `${size}: no rounded corners`);
      assert.equal(m.headerRegion, "drag", `${size}: the header drags the window`);
      assert.equal(m.skipRegion, "no-drag", `${size}: Skip setup stays clickable`);
      assert.equal(m.stepRegion, "no-drag", `${size}: the steps stay clickable`);
      // Like Welcome's bar: the brand sits in the 46px row, right of the traffic lights.
      assert.ok(m.brand.left >= 80, `${size}: brand clear of the traffic lights (left ${m.brand.left})`);
      assert.ok(m.brand.top >= 0 && m.brand.bottom <= 46, `${size}: brand in the title row (${m.brand.top}-${m.brand.bottom})`);
    }
    // The page itself never scrolls; the step does, and the steps stay on screen.
    const scroll = await page.evaluate(() => ({
      layer: (() => {
        const l = document.querySelector("[data-testid=onboarding]")!;
        return l.scrollHeight > l.clientHeight + 1;
      })(),
      panel: getComputedStyle(document.querySelector(".wiz-panel")!).overflowY,
    }));
    assert.equal(scroll.layer, false, "the layer doesn't scroll");
    assert.equal(scroll.panel, "auto", "the step's panel scrolls");
    await page.click("[data-testid=wizard-step-1]");
    await sleep(300);
    await shot(page, "2-first-launch-capture");

    // Over the editor: the modal card, inset, with its border and corners.
    await page.click("[data-testid=wizard-skip]");
    await waitForWelcome(page);
    await page.click("[data-testid=new-project]");
    await waitFor(page, "[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor(page, "[data-testid=editor]");
    await page.keyboard.press("Escape");
    await page.click("[data-testid=open-settings]");
    await waitFor(page, "[data-testid=settings-nav-app]");
    await page.click("[data-testid=settings-nav-app]");
    await waitFor(page, "[data-testid=settings-setup]");
    await page.click("[data-testid=settings-setup]");
    await waitFor(page, "[data-testid=onboarding]");
    await sleep(300);
    const modal = await card(page);
    await shot(page, "3-over-editor");
    assert.ok(modal.box.left > 0 && modal.box.right < modal.win.w && modal.box.top > 0, `over the editor it's inset (${JSON.stringify(modal.box)})`);
    assert.equal(modal.border, "1px", "the modal keeps its border");
    assert.notEqual(modal.radius, "0px", "the modal keeps its corners");
    assert.notEqual(modal.headerRegion, "drag", "the modal's header isn't a drag region");
  } catch (e) {
    await shot(page, "failure").catch(() => {});
    throw e;
  }
});
