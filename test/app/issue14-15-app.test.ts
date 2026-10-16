// Issues #14 and #15 (D209) on the packaged app, run invisibly:
// - #14: Welcome, New project and Recents show in a compact window; the editor's full window comes
//   when a project opens and goes when it closes; each size is remembered on its own across a quit.
// - #15: eight presets and a Custom card (width and height with the aspect lock, 29.97 fps, a
//   background colour); "Match first clip": the first video imported sets the size and rate.
// Screenshots: test-output/issue14-welcome.png, issue14-editor.png, issue15-new-project.png,
// issue15-custom.png, issue15-matched.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";
import { smallScreen } from "../helpers/capabilities.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const shot = (page: Page, name: string) => page.screenshot({ path: resolve("test-output", `${name}.png`) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// D295: the form scrolls under its pinned Create foot; bring a field to the middle before clicking it
// (puppeteer only scrolls an element that is fully out of view).
const reveal = (page: Page, selector: string) => page.$eval(selector, (el) => el.scrollIntoView({ block: "center" }));
const viewport = (page: Page) => page.evaluate(() => [innerWidth, innerHeight]);
/** D295: Create is in view and on top at the body's top scroll: above the status foot, the click lands on it. */
const createReachable = async (page: Page, label: string) => {
  const r = await page.evaluate(() => {
    document.querySelector(".welcome-body")!.scrollTop = 0;
    const b = document.querySelector("[data-testid=create]")!.getBoundingClientRect();
    const foot = document.querySelector(".welcome-foot")!.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return { bottom: b.bottom, top: b.top, footTop: foot.top, onTop: !!hit?.closest("[data-testid=create]") };
  });
  assert.ok(r.top >= 0 && r.bottom <= r.footTop, `${label}: Create (${r.top}–${r.bottom}) is above the status foot (${r.footTop})`);
  assert.ok(r.onTop, `${label}: a click on Create lands on it`);
};
const waitViewport = (page: Page, w: number, h: number) =>
  page.waitForFunction((w, h) => innerWidth === w && innerHeight === h, { timeout: 10000 }, w, h).catch(async () => {
    throw new Error(`viewport ${await viewport(page)}, wanted ${w}×${h}`);
  });

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue14-15-")));
  mkdirSync(join(root, "projects"));
  // A 1280×720 clip at 25 fps for Match first clip.
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "Clip25.mp4")]);
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issues 14, 15: a compact start window, the editor's own size, custom canvases and Match first clip", { skip, timeout: 300000 }, async () => {
  const data = join(root, "data");
  const projects = join(root, "projects");
  const launch = async (dialogs: Array<string | Array<string>>) => {
    const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: data, UNCUT_TEST_DIALOG: JSON.stringify(dialogs) } });
    apps.add(app);
    return app;
  };
  let app = await launch([projects]);
  let page = app.page;
  try {
    // #14: the welcome card in a compact window.
    await waitForWelcome(page);
    await waitViewport(page, 760, 720);
    assert.equal(await page.evaluate(() => document.body.dataset.window), "welcome");
    await shot(page, "issue14-welcome");

    // #15: eight presets and Custom.
    await page.click("[data-testid=new-project]");
    await page.waitForSelector("[data-testid=new-project-form]");
    assert.deepEqual(await page.$$eval(".wiz-cards.presets [data-preset]", (els) => els.map((e) => (e as HTMLElement).dataset.preset)), ["landscape", "1080p60", "4k", "cinema", "vertical", "4k-vertical", "social", "square"]);
    const fits = await page.$eval("[data-testid=new-project-form]", (el) => el.getBoundingClientRect().right <= innerWidth);
    assert.ok(fits, "the form fits the compact window");
    await createReachable(page, "760×720");
    // D295: the frame rate works with a preset: Social at 60 fps, and another preset brings back its own.
    await page.click("[data-preset=social]");
    assert.equal(await page.$eval("[data-testid=custom-fps]", (el) => (el as HTMLSelectElement).value), "30");
    await page.select("[data-testid=custom-fps]", "60");
    assert.match(await page.$eval("[data-testid=new-project-meta]", (el) => (el as HTMLElement).innerText), /as 1080×1350, 60 fps\.$/);
    assert.match(await page.$eval("[data-preset=social]", (el) => (el as HTMLElement).innerText), /60 fps/);
    await page.click("[data-preset=cinema]");
    assert.match(await page.$eval("[data-testid=new-project-meta]", (el) => (el as HTMLElement).innerText), /as 2560×1080, 24 fps\.$/);
    await page.click("[data-preset=landscape]");
    await shot(page, "issue15-new-project");
    await page.click("[data-testid=custom-canvas]");
    await page.waitForSelector("[data-testid=custom-fields]");
    // The lock keeps 16:9: 1280 wide is 720 high.
    await page.click("[data-testid=custom-width]", { clickCount: 3 });
    await page.keyboard.type("1280");
    assert.equal(await page.$eval("[data-testid=custom-height]", (el) => (el as HTMLInputElement).value), "720");
    assert.deepEqual(await page.$$eval("[data-testid=custom-fps] option", (els) => els.map((e) => (e as HTMLOptionElement).value)), ["23.976", "24", "25", "29.97", "30", "50", "59.94", "60"]);
    await page.select("[data-testid=custom-fps]", "29.97");
    await page.$eval("[data-testid=custom-background]", (el) => {
      const input = el as HTMLInputElement;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "#123456");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Unlocked, the height is free.
    await page.click("[data-testid=custom-lock]");
    await page.click("[data-testid=custom-height]", { clickCount: 3 });
    await page.keyboard.type("800");
    assert.equal(await page.$eval("[data-testid=custom-width]", (el) => (el as HTMLInputElement).value), "1280");
    await page.click("[data-testid=custom-height]", { clickCount: 3 });
    await page.keyboard.type("720");
    // Locked again at 16:9.
    await page.click("[data-testid=custom-lock]");
    assert.equal(await page.$eval("[data-testid=custom-lock]", (el) => el.getAttribute("aria-pressed")), "true");
    assert.match(await page.$eval("[data-testid=new-project-meta]", (el) => (el as HTMLElement).innerText), /as 1280×720, 29\.97 fps\.$/);
    await createReachable(page, "760×720 with Custom open");
    await shot(page, "issue15-custom");
    await reveal(page, "[data-testid=project-name]");
    await page.click("[data-testid=project-name]", { clickCount: 3 });
    await page.keyboard.type("Custom");
    await reveal(page, "[data-testid=choose-folder]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");

    // #14: the editor gets its full window; the editor shows once the window has that size.
    await page.waitForSelector("[data-testid=editor]", { timeout: 20000 });
    assert.deepEqual(await viewport(page), [1280, 800]);
    assert.equal(await page.evaluate(() => document.body.dataset.window), "editor");
    const custom = JSON.parse(readFileSync(join(projects, "Custom.uncut", "project.json"), "utf8"));
    assert.deepEqual(custom.canvas, { width: 1280, height: 720, fps: 29.97, background: "#123456" });
    assert.equal(existsSync(join(projects, "Custom.uncut", ".cache", "match-first-clip")), false);
    await shot(page, "issue14-editor");

    // Each size is the user's: the editor at 1360×760, then back to Welcome (its own size), 700×600.
    // window.resizeTo stays within the screen: on a small one (GitHub's runner: 1024×768, #89) the
    // editor's own size is 1024×660 instead, still not the 1280×800 default.
    const [ew, eh] = (await smallScreen(page, 1360, 760)) ? [1024, 660] : [1360, 760];
    await page.evaluate((w, h) => window.resizeTo(w, h), ew, eh);
    await waitViewport(page, ew, eh);
    await sleep(800);
    await page.click("[data-testid=close-project]");
    await waitForWelcome(page);
    await waitViewport(page, 760, 720);
    await page.evaluate(() => window.resizeTo(700, 600));
    await waitViewport(page, 700, 600);
    await sleep(800);
    // Below the welcome minimum it stops at 600×520 (the editor's 1024×640 doesn't apply here).
    assert.equal(JSON.parse(readFileSync(join(data, "window.json"), "utf8")).editor.width, ew);
    await app.close();
    apps.delete(app);

    // After a quit: Welcome comes back at 700×600; a project with Match first clip.
    app = await launch([projects, [join(root, "Clip25.mp4")]]);
    page = app.page;
    await waitForWelcome(page);
    await waitViewport(page, 700, 600);
    await page.click("[data-testid=new-project]");
    await page.waitForSelector("[data-testid=new-project-form]");
    await createReachable(page, "700×600");
    await page.evaluate(() => window.resizeTo(600, 520));
    await waitViewport(page, 600, 520);
    await page.click("[data-testid=custom-canvas]");
    await page.waitForSelector("[data-testid=custom-fields]");
    await createReachable(page, "600×520 with Custom open");
    await shot(page, "issue15-small");
    // D295: Social at 60 fps (until the first clip sets it).
    await page.click("[data-preset=social]");
    await page.select("[data-testid=custom-fps]", "60");
    await reveal(page, "[data-testid=project-name]");
    await page.click("[data-testid=project-name]", { clickCount: 3 });
    await page.keyboard.type("Matched");
    await page.click("[data-testid=match-first-clip]");
    assert.match(await page.$eval("[data-testid=new-project-meta]", (el) => (el as HTMLElement).innerText), /until the first video sets it/);
    await reveal(page, "[data-testid=choose-folder]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await page.waitForSelector("[data-testid=editor]", { timeout: 20000 });
    assert.deepEqual(await viewport(page), [ew, eh], "the editor's own size, remembered");
    const dir = join(projects, "Matched.uncut");
    assert.ok(existsSync(join(dir, ".cache", "match-first-clip")));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).canvas, { width: 1080, height: 1350, fps: 60 });
    await page.click("[data-testid=import-plus]");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=media-tile], [data-testid=media-row]").length > 0 || document.querySelector("[data-testid=canvas-info]")?.textContent?.includes("1280"), { timeout: 30000 });
    await page.waitForFunction(() => /1280×720/.test(document.querySelector("[data-testid=canvas-info]")?.textContent ?? ""), { timeout: 30000 });
    const matched = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
    assert.deepEqual(matched.canvas, { width: 1280, height: 720, fps: 25 });
    assert.equal(matched.media[0].probe.frames, 50, "2 s counted at 25 fps");
    assert.equal(existsSync(join(dir, ".cache", "match-first-clip")), false, "matched once");
    await shot(page, "issue15-matched");
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await shot(page, "issue14-15-failure").catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});
