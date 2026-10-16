// Issues #79, #87, #91 on the packaged app.
// #79 (D243): Welcome fills the window (no card inside a frame) with the Uncut logo; closing a
// project goes back to it and the app stays: a ⌘W held down, and the window's close arriving just
// after (SIGUSR2, the tests' close button), don't quit.
// #87 (D244): the top bar's wordmark (mark, letters with a CSS sweep, a slash, the project's name),
// still under reduced motion, and the bar stays the window's drag region.
// #91 (D245): Settings › Labs lists Environments, off by default; while off the Welcome chip, the
// Settings rows and Manage… are disabled with the Labs hint; turned on they work, and it's
// remembered across a restart.
// Screenshots: test-output/issue79-87-91-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { KeyInput, Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let data = "";
let projects = "";
const apps = new Set<LaunchedApp>();
const launch = async (dialogs: Array<unknown> = []) => {
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: data, UNCUT_TEST_DIALOG: JSON.stringify(dialogs) } });
  apps.add(app);
  return app;
};
const shot = (page: Page, name: string) => page.screenshot({ path: `test-output/issue79-87-91-${name}.png` });
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const meta = async (page: Page, key: KeyInput) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key);
  await page.keyboard.up("Meta");
};
const disabled = (page: Page, id: string) => page.$eval(`[data-testid=${id}]`, (el) => (el as HTMLButtonElement).disabled);
// The Labs hint is the app tooltip on a wrapper (a disabled button gets no hover): hover, read it.
const title = async (page: Page, id: string) => {
  await page.mouse.move(0, 0);
  await page.hover(`[data-testid=labs-tip]:has([data-testid=${id}])`);
  await page.waitForSelector(".tooltip", { timeout: 3000 });
  return page.$eval(".tooltip", (el) => el.textContent ?? "");
};

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue79-")));
  data = join(root, "data");
  projects = join(root, "projects");
  mkdirSync(projects);
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("#79 #87 #91: Welcome fills the window; closing a project stays in the app; the wordmark; Labs › Environments", { skip, timeout: 240000 }, async () => {
  let app = await launch([projects]);
  let { page } = app;
  await waitForWelcome(page);
  await waitFor(page, "[data-testid=no-recents]");

  // #79: the whole window is Welcome: no card in a frame, the logo, a drag bar under the traffic lights.
  const fill = await page.$eval("[data-testid=welcome]", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, iw: innerWidth, ih: innerHeight };
  });
  assert.deepEqual([fill.x, fill.y, fill.w, fill.h], [0, 0, fill.iw, fill.ih], "Welcome is the whole window");
  assert.equal(await page.$(".welcome-card"), null, "no card inside a frame");
  const main = await page.$eval(".welcome-main", (el) => {
    const s = getComputedStyle(el);
    return { border: s.borderTopWidth, radius: s.borderTopLeftRadius, shadow: s.boxShadow };
  });
  assert.deepEqual(main, { border: "0px", radius: "0px", shadow: "none" }, "the start actions aren't a framed panel");
  const logo = await page.$eval(".welcome-logo", (el) => el.getBoundingClientRect().toJSON());
  assert.ok(logo.width >= 48 && logo.top > 0 && logo.bottom < fill.ih, `the logo is shown (${JSON.stringify(logo)})`);
  assert.equal(await page.$eval("[data-testid=welcome-brand]", (el) => el.textContent.trim()), "Uncut");
  assert.equal(await page.$eval(".welcome-bar", (el) => getComputedStyle(el).getPropertyValue("-webkit-app-region")), "drag");
  for (const part of [".welcome-bar", ".welcome-body", ".welcome-foot"]) {
    const w = await page.$eval(part, (el) => el.getBoundingClientRect().width);
    assert.equal(w, fill.iw, `${part} spans the window`);
  }

  // #91: Environments is off: the Welcome chip is disabled and says where to turn it on.
  assert.equal(await disabled(page, "env-chip"), true);
  assert.match(await title(page, "env-chip"), /Settings › Labs/);
  await shot(page, "welcome");

  // A project, through the form.
  await page.click("[data-testid=new-project]");
  await waitFor(page, "[data-testid=new-project-form]");
  await page.click("[data-testid=project-name]", { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type("[data-testid=project-name]", "Wordmark Test");
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction((dir: string) => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title === dir, {}, projects);
  await page.click("[data-testid=create]");
  await waitFor(page, "[data-testid=editor]");

  // #87: the wordmark: the mark, the swept letters, the slash and the project's name, in the drag region.
  await waitFor(page, "[data-testid=wordmark] .wordmark-mark");
  assert.equal(await page.$eval("[data-testid=wordmark-text]", (el) => el.textContent.trim()), "Uncut");
  assert.equal(await page.$eval("[data-testid=project-title]", (el) => el.textContent.trim()), "Wordmark Test");
  const look = await page.$eval("[data-testid=wordmark-text]", (el) => {
    const s = getComputedStyle(el);
    return { clip: s.backgroundClip || s.getPropertyValue("-webkit-background-clip"), anim: s.animationName };
  });
  assert.equal(look.clip, "text", "the letters are a gradient clipped to the text");
  assert.equal(look.anim, "wordmark-sweep");
  const region = await page.$eval("[data-testid=wordmark]", (el) => {
    let node: Element | null = el;
    while (node) {
      const r = getComputedStyle(node).getPropertyValue("-webkit-app-region");
      if (r === "drag" || r === "no-drag") return r;
      node = node.parentElement;
    }
    return "none";
  });
  assert.equal(region, "drag", "the wordmark is part of the window's drag region");
  await sleep(1800);
  const wordmarkBox = await page.$eval("header.topbar", (el) => el.getBoundingClientRect().toJSON());
  await page.screenshot({ path: "test-output/issue79-87-91-wordmark.png", clip: { x: 0, y: 0, width: Math.min(560, wordmarkBox.width), height: wordmarkBox.height } });
  await shot(page, "editor");
  // Reduced motion: no sweep.
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  assert.equal(await page.$eval("[data-testid=wordmark-text]", (el) => getComputedStyle(el).animationName), "none");
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);

  // #91: Settings › App: Environments… is disabled with a way to Labs; Settings (wizard) Manage… too.
  await meta(page, "Comma");
  await waitFor(page, "[data-testid=settings-nav-app]");
  await page.click("[data-testid=settings-nav-app]");
  await waitFor(page, "[data-testid=app-settings]");
  assert.equal(await disabled(page, "settings-open-environments"), true);
  assert.match(await title(page, "settings-open-environments"), /Labs/);
  await waitFor(page, "[data-testid=settings-environments-labs]");
  await page.$eval("[data-testid=settings-environments-labs]", (el) => el.scrollIntoView({ block: "center" }));
  await shot(page, "settings-app-off");
  await page.click("[data-testid=settings-go-labs]");
  await waitFor(page, "[data-testid=labs-settings]");
  assert.equal(await page.$eval("[data-testid=lab-environments-toggle]", (el) => (el as HTMLInputElement).checked), false, "off by default");
  await shot(page, "labs-off");
  await page.click("[data-testid=lab-environments-toggle]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=lab-environments-toggle]")!.checked);
  assert.equal(await page.evaluate(() => localStorage.getItem("uncut.labs.environments")), "on");
  await sleep(400);
  await shot(page, "labs-on");
  await page.click("[data-testid=settings-nav-app]");
  await waitFor(page, "[data-testid=app-settings]");
  assert.equal(await disabled(page, "settings-open-environments"), false);
  assert.equal(await page.$("[data-testid=settings-environments-labs]"), null);
  // Off again for the close checks below.
  await page.click("[data-testid=settings-nav-labs]");
  await page.click("[data-testid=lab-environments-toggle]");
  await page.waitForFunction(() => !document.querySelector<HTMLInputElement>("[data-testid=lab-environments-toggle]")!.checked);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=labs-settings]"));

  // #79: ⌘W closes the project to Welcome; ⌘W held down (repeats) doesn't take the app with it.
  await page.click("[data-testid=timeline]");
  await page.keyboard.down("Meta");
  await page.keyboard.down("KeyW");
  await waitForWelcome(page);
  for (let i = 0; i < 3; i++) await page.keyboard.down("KeyW"); // auto-repeat
  await page.keyboard.up("KeyW");
  await page.keyboard.up("Meta");
  await sleep(1500);
  assert.equal(app.proc.exitCode, null, "the app is still running after ⌘W held down");
  await waitFor(page, "[data-testid=recent]");
  await shot(page, "welcome-after-close");

  // The window's close arriving just as a project closes (a second ⌘W reaching the menu's Close) stays too.
  await page.click("[data-testid=recent]");
  await waitFor(page, "[data-testid=editor]");
  await page.click("[data-testid=close-project]");
  await waitForWelcome(page);
  app.proc.kill("SIGUSR2");
  await sleep(1500);
  assert.equal(app.proc.exitCode, null, "the app is still running");
  assert.ok(await page.$("[data-testid=welcome]"));

  // #91: remembered per Mac: turned on, it's still on after a restart and the chip opens Environments.
  await meta(page, "Comma");
  await waitFor(page, "[data-testid=settings-nav-labs]");
  await page.click("[data-testid=settings-nav-labs]");
  await page.click("[data-testid=lab-environments-toggle]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=lab-environments-toggle]")!.checked);
  await page.keyboard.press("Escape");
  await app.close();
  apps.delete(app);
  app = await launch();
  page = app.page;
  await waitForWelcome(page);
  assert.equal(await disabled(page, "env-chip"), false);
  await page.click("[data-testid=env-chip]");
  await waitFor(page, "[data-testid=environments]");
  assert.equal(await disabled(page, "env-add"), false);
  assert.equal(await page.$("[data-testid=env-labs-note]"), null);
  await shot(page, "environments-on");
});
