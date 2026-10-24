// Phase 8 chunk 2 (D103) on the packaged app, run invisibly: Settings › Plugins › Browse lists
// Uncut's catalog (Resources/plugins/catalog, off by default), search narrows it, Enable copies the
// example plugin (taste.extra) in and opens the approval dialog, Allow. Then in a new project its
// look is a tile in the Text grid with its plugin's name, adding it lands a text, its component is in
// the Elements grid (its end-card check has no tab any more, K1). Disable
// takes it out again. Screenshot: test-output/plugins-browse.png (the catalog).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let app: LaunchedApp | undefined;
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const text = (page: Page, selector: string) => page.$eval(selector, (el) => ((el as HTMLElement).innerText ?? "").trim());

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-plugins-browse-")));
  mkdirSync(join(root, "projects"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("Browse the catalog, enable and allow the example plugin, then its look, component and check show up", { skip, timeout: 180000 }, async () => {
  app = await launchApp({
    command: APP,
    firstLaunch: true,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]) },
  });
  const { page } = app;
  try {
    await waitFor(page, "[data-testid=onboarding]");
    await page.click("[data-testid=wizard-step-1]");
    await waitFor(page, "[data-testid=plugin-browse]");
    await page.click("[data-testid=plugin-browse]");
    await waitFor(page, "[data-testid=plugin-catalog-entry][data-id='taste.extra'][data-enabled=false]");
    assert.match(
      await text(page, "[data-testid=plugin-catalog-entry][data-id='taste.extra']"),
      /Taste extra[\s\S]*Text looks: Soft card\. Components: Corner sticker\. Checks: Ends on an end card, No hype words\. Runs no program/,
    );
    assert.equal(await page.$("[data-testid='plugin-taste.extra']"), null, "not loaded until enabled");
    // Search narrows the list.
    await page.type("[data-testid=plugin-catalog-search]", "no such plugin");
    await page.waitForFunction(() => !document.querySelector("[data-testid=plugin-catalog-entry]"));
    await page.$eval("[data-testid=plugin-catalog-search]", (el) => ((el as HTMLInputElement).select(), undefined));
    await page.keyboard.press("Backspace");
    await page.type("[data-testid=plugin-catalog-search]", "sticker");
    await waitFor(page, "[data-testid=plugin-catalog-entry][data-id='taste.extra']");
    assert.ok(!/[·•*]/.test(await text(page, "[data-testid=plugin-browse-panel]")), "no dots or stars between words");
    await page.screenshot({ path: "test-output/plugins-browse.png" });

    // Enable → the approval dialog (a copy, not allowed yet).
    await page.click("[data-testid=plugin-catalog-enable]");
    await waitFor(page, "[data-testid=plugin-dialog]", 20000);
    assert.match(await text(page, "[data-testid=plugin-dialog-source]"), /Uncut's plugin catalog/);
    assert.match(await text(page, "[data-testid=plugin-dialog-adds]"), /Text looks: Soft card/);
    assert.match(await text(page, "[data-testid=plugin-dialog-rights]"), /doesn't run a program/);
    assert.ok(!/[·•*]/.test(await text(page, "[data-testid=plugin-dialog]")));
    await page.screenshot({ path: "test-output/plugins-browse-dialog.png" });
    await page.click("[data-testid=plugin-dialog-allow]");
    await waitFor(page, "[data-testid='plugin-taste.extra'][data-status=ready]");
    await waitFor(page, "[data-testid=plugin-catalog-entry][data-id='taste.extra'][data-enabled=true]");
    const settings = JSON.parse(readFileSync(join(root, "data", "settings.json"), "utf8"));
    assert.equal(settings.pluginInstalls["taste.extra"].kind, "catalog");
    assert.ok(settings.pluginApprovals["taste.extra"]);

    // A project: the look in the Text grid with its plugin's name; adding it lands a text.
    await page.keyboard.press("Escape");
    await waitForWelcome(page);
    await page.click("[data-testid=new-project]");
    await waitFor(page, "[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor(page, "[data-testid=editor]");
    await page.click("[data-testid=rail-text]");
    const tile = "[data-testid=text-preset][data-module='taste.extra.soft-card']";
    await waitFor(page, tile);
    assert.equal(await text(page, `${tile} [data-testid=text-preset-source]`), "Taste extra");
    await page.waitForFunction(
      (sel) => !(document.querySelector(`${sel} .text-thumb-inner`) as HTMLElement | null)?.style.transform.includes("scale(0)"),
      {},
      tile,
    );
    await page.click(tile);
    await page.waitForFunction(() => [...document.querySelectorAll(".pv-text")].some((el) => el.textContent === "Soft card"), { timeout: 10000 });
    const project = JSON.parse(
      readFileSync(
        join(
          root,
          "projects",
          readdirSync(join(root, "projects")).find((n) => n.endsWith(".uncut"))!,
          "project.json",
        ),
        "utf8",
      ),
    ) as { tracks: Array<{ items: Array<{ text?: string; style?: Record<string, unknown> }> }> };
    const added = project.tracks.flatMap((t) => t.items).find((i) => i.text === "Soft card");
    assert.ok(added, "the text is in project.json");
    assert.equal(added!.style?.preset, undefined);
    assert.equal(added!.style?.font, "DM Sans", "the whole look is carried in the item");

    // Its component in the Elements grid.
    await page.click("[data-testid=rail-elements]");
    await waitFor(page, "[data-testid=plugin-component-tile][data-component='taste.extra.sticker']");
    assert.equal(await text(page, "[data-testid=plugin-component-tile] [data-testid=component-source]"), "Taste extra");

    // K1 (D121): the Checks tab that listed its check is gone; plugin rules reaching project_check is phase8-exit's.
    assert.equal(await page.$("[data-testid=tab-checks]"), null);
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: "test-output/plugins-browse-failure.png" }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});
