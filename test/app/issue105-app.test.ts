// D281 on the packaged app, run invisibly: the tools and plugins show their marks, not generic icons.
// The setup wizard's Capture step: Argent, ffmpeg and whisper.cpp rows draw their marks (svg.wiz-mark),
// the Speech model row keeps its waveform icon, and every plugin row (Argent, Uncut skills, Whisper)
// draws its own icon.svg as a mask in the text colour; Browse… lists the catalog with theirs; and
// Settings › Plugins' cards have them too. Screenshots: test-output/issue105-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome, clickWhenReady } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let app: LaunchedApp | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const shot = (page: Page, name: string) => page.screenshot({ path: `test-output/issue105-${name}.png` });

/** A plugin icon as drawn: its mask, size and fill (the text colour). */
const markOf = (page: Page, selector: string) =>
  page.$eval(selector, (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const fg = getComputedStyle(document.documentElement).getPropertyValue("--fg").trim();
    const probe = document.createElement("span");
    probe.style.color = fg;
    document.body.append(probe);
    const fgRgb = getComputedStyle(probe).color;
    probe.remove();
    return { mask: cs.maskImage || cs.getPropertyValue("-webkit-mask-image"), width: r.width, height: r.height, fill: cs.backgroundColor, fg: fgRgb, lucide: !!el.parentElement!.querySelector(":scope > svg.lucide") };
  });

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue105-")));
  mkdirSync(join(root, "projects"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("tool and plugin rows show marks; the Speech model keeps its waveform; Settings › Plugins cards too", { skip, timeout: 180000 }, async () => {
  app = await launchApp({ command: APP, firstLaunch: true, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]) } });
  const { page } = app;
  try {
    await waitFor(page, "[data-testid=onboarding]");
    await page.evaluate(() => window.resizeTo(760, 720));
    await sleep(500);

    // The agents' step still has its marks (D277).
    await waitFor(page, "[data-testid=check-claude]");
    assert.ok(await page.$("[data-testid=check-claude] svg.wiz-mark[data-testid=row-mark-claude]"), "Claude Code's mark");

    await page.click("[data-testid=wizard-step-1]");
    for (const id of ["argent", "ffmpeg", "whisper"]) {
      await waitFor(page, `[data-testid=check-${id}]`, 30000);
      const row = await page.$eval(`[data-testid=check-${id}] .wiz-row`, (el) => {
        const mark = el.querySelector(":scope > svg.wiz-mark");
        const r = mark?.getBoundingClientRect();
        return { mark: mark?.getAttribute("data-testid"), lucide: !!el.querySelector(":scope > svg.lucide"), w: r?.width, h: r?.height, paths: mark?.querySelectorAll("path").length ?? 0 };
      });
      assert.equal(row.mark, `row-mark-${id}`, `${id}'s row draws its mark`);
      assert.equal(row.lucide, false, `${id}'s row has no generic icon`);
      assert.equal(row.w, 20);
      assert.equal(row.h, 20);
      assert.ok(row.paths > 0);
    }
    // The Speech model row (when whisper.cpp is found) keeps its waveform.
    if (await page.$("[data-testid=whisper-model]")) assert.ok(await page.$("[data-testid=whisper-model] .wiz-row > svg.lucide-audio-lines"), "the Speech model keeps its waveform icon");

    for (const id of ["argent.capture", "uncut.skills", "whisper.transcribe"]) {
      await waitFor(page, `[data-testid='plugin-${id}'] [data-testid='plugin-mark-${id}']`);
      const m = await markOf(page, `[data-testid='plugin-mark-${id}']`);
      assert.match(m.mask, /url\("?data:image\/svg\+xml;base64,/, `${id}'s icon is its own svg`);
      assert.equal(m.width, 20);
      assert.equal(m.height, 20);
      assert.equal(m.fill, m.fg, `${id}'s icon is in the text colour`);
      assert.equal(m.lucide, false, `${id} has no generic icon`);
    }
    await page.$eval("[data-testid=check-argent]", (el) => el.scrollIntoView({ block: "start" }));
    await sleep(200);
    await shot(page, "1-wizard-tools");
    await page.$eval("[data-testid=plugins]", (el) => el.scrollIntoView({ block: "start" }));
    await sleep(200);
    await shot(page, "2-wizard-plugins");

    // Browse…: the catalog's plugins with their icons.
    await page.click("[data-testid=plugin-browse]");
    await waitFor(page, "[data-testid=plugin-catalog-entry]");
    const catalog = await page.$$eval("[data-testid=plugin-catalog-entry]", (els) => els.map((e) => ({ id: e.getAttribute("data-id"), mark: !!e.querySelector(".plugin-mark"), lucide: !!e.querySelector(":scope > svg.lucide") })));
    assert.ok(catalog.length >= 3, `catalog: ${JSON.stringify(catalog)}`);
    for (const c of catalog) assert.ok(c.mark && !c.lucide, `${c.id} in the catalog draws its icon`);
    await page.$eval("[data-testid=plugin-browse-panel]", (el) => el.scrollIntoView({ block: "start" }));
    await sleep(200);
    await shot(page, "3-wizard-browse");

    // Settings › Plugins: the marketplace cards.
    await page.keyboard.press("Escape");
    await waitForWelcome(page);
    await page.click("[data-testid=new-project]");
    await waitFor(page, "[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await clickWhenReady(page, "[data-testid=create]");
    await waitFor(page, "[data-testid=editor]");
    await page.keyboard.press("Escape");
    await page.click("[data-testid=open-settings]");
    await waitFor(page, "[data-testid=settings-nav-plugins]");
    await page.click("[data-testid=settings-nav-plugins]");
    await waitFor(page, "[data-testid=plugins-market] [data-testid=market-card]");
    await waitFor(page, "[data-testid=market-available] [data-testid=market-card]");
    await sleep(300);
    const cards = await page.$$eval("[data-testid=market-card]", (els) => els.map((e) => ({ id: e.getAttribute("data-id"), mark: !!e.querySelector(".pm-icon .plugin-mark"), lucide: !!e.querySelector(".pm-icon svg.lucide"), size: e.querySelector(".pm-icon .plugin-mark")?.getBoundingClientRect().width })));
    assert.ok(cards.length >= 6, `cards: ${JSON.stringify(cards)}`);
    for (const c of cards) {
      assert.ok(c.mark && !c.lucide, `${c.id}'s card draws its icon`);
      assert.equal(c.size, 16);
    }
    await shot(page, "4-settings-plugins");
    await page.$eval("[data-testid=market-available]", (el) => el.scrollIntoView({ block: "start" }));
    await sleep(200);
    await shot(page, "5-settings-available");
  } catch (e) {
    await shot(page, "failure").catch(() => {});
    throw e;
  }
});
