// Issue #90 (D258) on the packaged app, run invisibly: Settings › Plugins is a marketplace. The
// example plugin (uncut.example-kit) is an Available card (name, author, kinds, description, what
// allowing it means); search narrows the cards; Install… copies it in and opens the approval
// dialog (D248's skills warning); Allow moves it to Installed, enabled, and its look is in the Text
// grid; Disable and Enable… go through the same approval; Make a plugin shows the guide and leads
// back to the example's card; Remove puts it back in Available. Uncut's own skills are Built in.
// Screenshots: test-output/issue90-market.png, issue90-dialog.png, issue90-installed.png, issue90-guide.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;
const KIT = "[data-testid=market-card][data-id='uncut.example-kit']";

let root = "";
let app: LaunchedApp | undefined;
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const text = (page: Page, selector: string) => page.$eval(selector, (el) => ((el as HTMLElement).innerText ?? "").trim());
const search = async (page: Page, query: string) => {
  await page.$eval("[data-testid=market-search]", (el) => ((el as HTMLInputElement).select(), undefined));
  await page.keyboard.press("Backspace");
  if (query) await page.type("[data-testid=market-search]", query);
};
const openPlugins = async (page: Page) => {
  await page.click("[data-testid=open-settings]");
  await waitFor(page, "[data-testid=settings-nav-plugins]");
  await page.click("[data-testid=settings-nav-plugins]");
  await waitFor(page, "[data-testid=plugins-market]");
};

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue90-")));
  mkdirSync(join(root, "projects"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("Settings › Plugins: browse the catalog, install and allow the example plugin, disable and enable it, read the guide, remove it", { skip, timeout: 180000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]) } });
  const { page } = app;
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=new-project]");
    await waitFor(page, "[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor(page, "[data-testid=editor]");
    // A new empty project opens the agent's centre stage; Esc leaves it for the editor.
    await page.keyboard.press("Escape");

    // The marketplace: the example is available, Uncut's skills are built in.
    await openPlugins(page);
    await waitFor(page, `[data-testid=market-available] ${KIT}[data-state=available]`);
    const card = await text(page, KIT);
    assert.match(card, /Example kit/);
    assert.match(card, /By Uncut, version 1\.0\.0/);
    assert.match(card, /worked example/);
    for (const kind of ["Text looks", "Components", "Shader effects", "Skills"]) assert.ok(card.includes(kind), kind);
    assert.match(await text(page, `${KIT} [data-testid=market-perms]`), /doesn't run a program itself, but it adds a skill/);
    await waitFor(page, "[data-testid=market-installed] [data-testid=market-card][data-id='uncut.skills'][data-state=bundled]");
    assert.match(await text(page, "[data-testid=market-card][data-id='uncut.skills']"), /Built in/);
    assert.equal(await page.$("[data-testid='market-remove-uncut.skills']"), null, "a bundled plugin can't be removed");
    assert.ok(await page.$("[data-testid=market-card][data-id='taste.extra'][data-state=available]"), "the rest of the catalog is available too");
    assert.ok(!/[·•]| \* /.test(await text(page, "[data-testid=plugins-settings]")), "no dots or stars between words");
    await page.screenshot({ path: "test-output/issue90-market.png" });

    // Search: by what it adds; nothing for nonsense.
    await search(page, "spotlight");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=market-available] [data-testid=market-card]").length === 1);
    assert.ok(await page.$(KIT));
    await search(page, "no such plugin");
    await page.waitForFunction(() => !document.querySelector("[data-testid=market-card]"));
    assert.match(await text(page, "[data-testid=market-available]"), /No plugin in the catalog matches that/);
    await search(page, "");
    await waitFor(page, KIT);

    // Install → the approval dialog; Allow → installed and enabled.
    await page.click("[data-testid='market-install-uncut.example-kit']");
    await waitFor(page, "[data-testid=plugin-dialog]", 20000);
    assert.match(await text(page, "[data-testid=plugin-dialog-source]"), /Uncut's plugin catalog/);
    assert.match(await text(page, "[data-testid=plugin-dialog-adds]"), /Text looks: Lower third\. Components: Callout badge\. Shader effects: Spotlight\. Skills: Lower thirds \(\/example-kit-lower-thirds\)/);
    assert.match(await text(page, "[data-testid=plugin-dialog-rights]"), /the agent follows/);
    await page.screenshot({ path: "test-output/issue90-dialog.png" });
    await page.click("[data-testid=plugin-dialog-allow]");
    await waitFor(page, `[data-testid=market-installed] ${KIT}[data-state=enabled]`);
    assert.equal(await page.$(`[data-testid=market-available] ${KIT}`), null, "no longer available");
    const settings = JSON.parse(readFileSync(join(root, "data", "settings.json"), "utf8"));
    assert.equal(settings.pluginInstalls["uncut.example-kit"].kind, "catalog");
    assert.ok(settings.pluginApprovals["uncut.example-kit"].skills, "allowed for its skills (D248)");
    await page.$eval(KIT, (el) => el.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: "test-output/issue90-installed.png" });

    // Disable stops allowing it; Enable… asks again.
    await page.click("[data-testid='market-disable-uncut.example-kit']");
    await waitFor(page, `${KIT}[data-state=disabled]`);
    assert.equal(JSON.parse(readFileSync(join(root, "data", "settings.json"), "utf8")).pluginApprovals["uncut.example-kit"], undefined);
    await page.click("[data-testid='market-enable-uncut.example-kit']");
    await waitFor(page, "[data-testid=plugin-dialog]");
    await page.click("[data-testid=plugin-dialog-allow]");
    await waitFor(page, `${KIT}[data-state=enabled]`);

    // Make a plugin: the guide, and the way back to the example's card.
    await page.click("[data-testid=plugins-tab-guide]");
    await waitFor(page, "[data-testid=plugins-guide]");
    for (const id of ["what", "start", "manifest", "kinds", "sdk", "approval", "test", "publish"]) assert.ok(await page.$(`[data-testid=plugins-guide-${id}]`), id);
    assert.match(await text(page, "[data-testid=plugins-guide-kinds]"), /shaders[\s\S]*skills[\s\S]*agent tools/);
    assert.match(await text(page, "[data-testid=plugins-guide-start]"), /pnpm plugin:new acme\.promo-kit --from uncut\.example-kit/);
    assert.equal(await page.$eval("[data-testid=plugins-guide-source]", (el) => (el as HTMLAnchorElement).href), "https://github.com/blazejkustra/uncut/tree/main/plugins/catalog/uncut-example-kit");
    assert.ok(!/[·•]| \* /.test(await text(page, "[data-testid=plugins-guide]")), "no dots or stars between words");
    await page.screenshot({ path: "test-output/issue90-guide.png" });
    await page.click("[data-testid=plugins-guide-show-example]");
    await waitFor(page, `${KIT}.highlight`);
    assert.equal(await page.$eval("[data-testid=market-search]", (el) => (el as HTMLInputElement).value), "Example kit");

    // What it adds is in the editor: its look in the Text grid.
    await page.click("[data-testid=settings-close]");
    await page.click("[data-testid=rail-text]");
    await waitFor(page, "[data-testid=text-preset][data-module='uncut.example-kit.lower-third']");

    // Remove: the copy goes, the card is available again.
    await openPlugins(page);
    await search(page, "");
    await waitFor(page, `${KIT}[data-state=enabled]`);
    await page.click("[data-testid='market-remove-uncut.example-kit']");
    await waitFor(page, `[data-testid=market-available] ${KIT}[data-state=available]`);
    assert.deepEqual(readdirSync(join(root, "data", "plugins")).filter((n) => !n.startsWith(".")), []);
    assert.equal(JSON.parse(readFileSync(join(root, "data", "settings.json"), "utf8")).pluginInstalls?.["uncut.example-kit"], undefined);
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: "test-output/issue90-failure.png" }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});
