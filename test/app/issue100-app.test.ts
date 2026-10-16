// Issue #100 (D272) on the packaged app, run invisibly: the setup wizard's Plugins section at the
// onboarding's real window size (760×720) and at its smallest (600×520). The heading and its
// Browse… / Add plugin… sit on one row without overlapping; each plugin row is its name (version
// de-emphasised), one short line ("10 editing skills…", Argent's first clause, not its tool names)
// and the status, in one right-hand column; the full lists are behind the details toggle.
// Settings › Plugins (its own cards, not this component) is screenshotted to check it's unchanged.
// Screenshots: test-output/issue100-*.png.
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
const text = (page: Page, selector: string) => page.$eval(selector, (el) => ((el as HTMLElement).innerText ?? "").trim());
const shot = (page: Page, name: string) => page.screenshot({ path: `test-output/issue100-${name}.png` });
const SKILLS = "[data-testid='plugin-uncut.skills']";

/** The layout facts the issue is about, measured in the page. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const r = (el: Element | null) => el!.getBoundingClientRect().toJSON() as DOMRect;
    const head = document.querySelector("[data-testid=plugins] .plugin-head")!;
    const title = r(head.querySelector(".wiz-section"));
    const buttons = [...head.querySelectorAll("button")].map(r);
    const rows = [...document.querySelectorAll("[data-testid=plugins] .plugin-row")].map((row) => {
      const sub = row.querySelector<HTMLElement>(".plugin-summary")!;
      const status = row.querySelector(".plugin-status")!;
      return { id: row.getAttribute("data-testid"), summaryLines: Math.round(sub.getBoundingClientRect().height / parseFloat(getComputedStyle(sub).lineHeight || "16")), statusRight: r(status).right, rowRight: r(row).right };
    });
    const card = r(document.querySelector("[data-testid=plugins]"));
    return { title, buttons, rows, card, overflow: [...head.querySelectorAll("*")].some((el) => r(el).right > card.right + 0.5) };
  });

const checkLayout = async (page: Page, size: string) => {
  const m = await layout(page);
  for (const b of m.buttons) {
    assert.ok(b.left >= m.title.right, `${size}: a button starts before the heading ends`);
    const mid = (b.top + b.bottom) / 2;
    assert.ok(mid > m.title.top && mid < m.title.bottom, `${size}: buttons centred on the heading row (button ${b.top}-${b.bottom}, heading ${m.title.top}-${m.title.bottom})`);
  }
  assert.equal(m.overflow, false, `${size}: nothing in the heading row past the section's edge`);
  assert.ok(m.rows.length >= 2, `${size}: plugin rows listed`);
  for (const row of m.rows) assert.ok(row.summaryLines <= 1, `${size}: ${row.id}'s summary is one line, not ${row.summaryLines}`);
  const rights = new Set(m.rows.map((row) => Math.round(row.statusRight)));
  assert.equal(rights.size, 1, `${size}: statuses end in one column (${[...rights].join(", ")})`);
};

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue100-")));
  mkdirSync(join(root, "projects"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the wizard's Plugins section: one heading row, one-line summaries, aligned statuses, details on demand", { skip, timeout: 180000 }, async () => {
  app = await launchApp({ command: APP, firstLaunch: true, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]) } });
  const { page } = app;
  try {
    await waitFor(page, "[data-testid=onboarding]");
    await page.evaluate(() => window.resizeTo(760, 720));
    await sleep(500);
    await page.click("[data-testid=wizard-step-1]");
    await waitFor(page, `${SKILLS}[data-status=ready]`);
    await waitFor(page, "[data-testid='plugin-argent.capture']");
    await page.$eval("[data-testid=plugins]", (el) => el.scrollIntoView({ block: "start" }));
    await sleep(200);
    await shot(page, "1-wizard-760");
    await checkLayout(page, "760×720");

    // Short human lines, not every skill and tool name; no dots or stars between words.
    const skills = await text(page, `${SKILLS} .plugin-summary`);
    assert.match(skills, /^10 editing skills/);
    assert.doesNotMatch(skills, /\/launch-promo/);
    const summaries = await page.$$eval("[data-testid=plugins] .plugin-summary", (els) => els.map((e) => (e as HTMLElement).innerText));
    assert.ok(summaries.every((s) => !/argent_|[·•*]/.test(s)), `summaries: ${summaries.join(" | ")}`);
    assert.ok(summaries.some((s) => /^Records iOS simulators/.test(s)), `Argent's line: ${summaries.join(" | ")}`);
    // The version is there, smaller and dimmer than the name.
    const ver = await page.$eval(`${SKILLS} .plugin-version`, (el) => ({ text: el.textContent, size: parseFloat(getComputedStyle(el).fontSize), name: parseFloat(getComputedStyle(el.parentElement!).fontSize) }));
    assert.equal(ver.text, "1.0.0");
    assert.ok(ver.size < ver.name, "version smaller than the name");

    // Details: the skills with their commands, hidden until asked.
    assert.equal(await page.$eval("[data-testid='plugin-details-uncut.skills']", (el) => (el as HTMLElement).hidden), true);
    await page.click("[data-testid='plugin-more-uncut.skills']");
    await waitFor(page, "[data-testid='plugin-details-uncut.skills']:not([hidden])");
    const details = await text(page, "[data-testid='plugin-details-uncut.skills']");
    assert.match(details, /Launch promo\s+\/launch-promo/);
    assert.match(details, /Ships with Uncut/);
    await page.$eval("[data-testid='plugin-details-uncut.skills']", (el) => el.scrollIntoView({ block: "center" }));
    await sleep(200);
    await shot(page, "2-wizard-details");
    await page.click("[data-testid='plugin-more-uncut.skills']");

    // The smallest window.
    await page.evaluate(() => window.resizeTo(600, 520));
    await sleep(500);
    await page.$eval("[data-testid=plugins]", (el) => el.scrollIntoView({ block: "start" }));
    await sleep(200);
    await shot(page, "3-wizard-600");
    await checkLayout(page, "600×520");

    // Settings › Plugins: its own marketplace cards, still fine.
    await page.keyboard.press("Escape");
    await waitForWelcome(page);
    await page.click("[data-testid=new-project]");
    await waitFor(page, "[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor(page, "[data-testid=editor]");
    await page.keyboard.press("Escape");
    await page.click("[data-testid=open-settings]");
    await waitFor(page, "[data-testid=settings-nav-plugins]");
    await page.click("[data-testid=settings-nav-plugins]");
    await waitFor(page, "[data-testid=plugins-market]");
    await sleep(300);
    await shot(page, "4-settings-plugins");
  } catch (e) {
    await shot(page, "failure").catch(() => {});
    throw e;
  }
});
