// Issue #50 on the packaged app, run invisibly, with the stand-in claude: the composer's provider
// button, provider menu and model picker show the providers' real marks the way t3code draws them:
// Claude's in its clay orange (#d97757), OpenAI's blossom in the text colour, both drawn (a visible,
// non-empty box) beside the names; the "not affiliated" line stays in the provider menu.
// Screenshots: test-output/issue50-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let app: LaunchedApp | undefined;
const out = (name: string) => resolve("test-output", `issue50-${name}.png`);

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue50-")));
  mkdirSync(join(root, "projects"));
  writeFileSync(join(root, "plan.json"), "[]");
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Each mark under `scope`: its provider, path count, fill (the svg's computed fill) and drawn size. */
const marks = (page: Page, scope: string) =>
  page.$$eval(`${scope} [data-testid=provider-mark]`, (els) =>
    els.map((el) => {
      const svg = el.querySelector("svg.provider-logo");
      const box = svg?.getBoundingClientRect();
      return {
        provider: (el as HTMLElement).dataset.provider,
        paths: svg?.querySelectorAll("path").length ?? 0,
        fill: svg ? getComputedStyle(svg).fill : "",
        evenodd: !!svg?.querySelector("path[fill-rule=evenodd]"),
        drawn: !!box && box.width >= 12 && box.height >= 12,
      };
    }),
  );

test("issue #50: the provider button, provider menu and model picker show Claude's and OpenAI's real marks", { skip, timeout: 180000 }, async () => {
  app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]), UNCUT_CLAUDE: FAKE, FAKE_PLAN: join(root, "plan.json") },
  });
  const { page } = app;
  const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
  await waitForWelcome(page);
  await page.click("[data-testid=new-project]");
  await waitFor("[data-testid=new-project-form]");
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
  await page.click("[data-testid=create]");
  await waitFor("[data-testid=agent-provider]");

  const claude = { provider: "claude", paths: 1, fill: "rgb(217, 119, 87)", evenodd: false, drawn: true };
  // The composer's provider button: Claude's mark.
  assert.deepEqual(await marks(page, "[data-testid=agent-provider]"), [claude]);

  // The provider menu: both marks beside the names, and the not-affiliated line.
  await page.click("[data-testid=agent-provider]");
  await waitFor("[data-testid=agent-provider-menu]");
  const menu = await marks(page, "[data-testid=agent-provider-menu]");
  assert.equal(menu.length, 2);
  assert.deepEqual(menu[0], claude);
  assert.equal(menu[1]!.provider, "codex");
  assert.equal(menu[1]!.paths, 1);
  assert.ok(menu[1]!.evenodd, "OpenAI's blossom is drawn with evenodd, like t3code");
  assert.ok(menu[1]!.drawn);
  assert.notEqual(menu[1]!.fill, "rgb(217, 119, 87)", "OpenAI's mark takes the text colour");
  assert.deepEqual(await page.$$eval("[data-testid=agent-provider-menu] [data-testid=provider-wordmark]", (els) => els.map((e) => e.textContent)), ["Claude", "Codex"]);
  assert.match(await page.$eval("[data-testid=agent-provider-menu]", (el) => (el as HTMLElement).innerText), /Not made by or affiliated with Anthropic or OpenAI\./);
  await page.screenshot({ path: out("provider-menu") });
  await page.click("[data-testid=agent-provider]");

  // The model picker: the rail's two marks, and Claude's on every model row.
  await page.click("[data-testid=agent-model]");
  await waitFor("[data-testid=agent-model-menu]");
  const rail = await marks(page, "[data-testid=agent-model-rail]");
  assert.deepEqual(rail.map((m) => [m.provider, m.drawn]), [["claude", true], ["codex", true]]);
  const rows = await marks(page, "[data-testid=agent-model-menu] [data-testid=agent-model-option]");
  assert.ok(rows.length >= 2, `model rows: ${rows.length}`);
  for (const row of rows) assert.deepEqual(row, claude);
  await page.screenshot({ path: out("model-picker") });
  assert.deepEqual(app.errors, []);
});
