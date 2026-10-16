// D248 (review of #60) on the packaged app, run invisibly and muted: allowing a data plugin that
// ships skills says the agent follows them (and can run commands with the access it's given), the
// approval card lists the skills by name, and the approval saved is for those skills (a hash).
// Screenshot: test-output/issue60-review-consent.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, clickWhenReady } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const text = (page: Page, selector: string) => page.$eval(selector, (el) => ((el as HTMLElement).innerText ?? "").trim());

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue60-review-")));
  mkdirSync(join(root, "plugins", "acme"), { recursive: true });
  const skill = (name: string, title: string) => ({ name, title, description: `When ${name} fits.`, instructions: `Do ${name}.` });
  writeFileSync(
    join(root, "plugins", "acme", "uncut.module.json"),
    JSON.stringify({ manifest: "uncut.module/0", apiVersion: "uncut.module/1", id: "acme.pack", kind: "pack", name: "Acme skills", version: "1.0.0", runtime: { type: "data" }, contributes: { skills: [skill("cold-open", "Cold open"), skill("end-card", "end-card")] } }),
  );
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("allowing a plugin with skills says the agent follows them and lists them; the approval is for those skills", { skip, timeout: 120000 }, async () => {
  const app = await launchApp({ command: APP, firstLaunch: true, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_PLUGINS_DIR: join(root, "plugins") } });
  apps.add(app);
  const { page } = app;
  try {
    await waitFor(page, "[data-testid=onboarding]");
    await clickWhenReady(page, "[data-testid=wizard-step-1]");
    const row = "[data-testid='plugin-acme.pack']";
    await waitFor(page, `${row}[data-status=needs-approval]`);
    // D272: the row says how many; the details (the chevron) list them with their commands.
    assert.match(await text(page, row), /2 editing skills/);
    await page.click("[data-testid='plugin-more-acme.pack']");
    assert.match(await text(page, "[data-testid='plugin-details-acme.pack']"), /Cold open\s+\/cold-open\s+\/end-card/);
    assert.match(await text(page, "[data-testid='plugin-detail-acme.pack']"), /adds 2 skills\. Its skills are instructions the agent follows when they fit, without asking you first/);

    await page.click("[data-testid='plugin-allow-acme.pack']");
    await waitFor(page, "[data-testid=plugin-dialog]");
    assert.match(await text(page, "[data-testid=plugin-dialog-adds]"), /Skills: Cold open \(\/cold-open\), \/end-card/);
    const rights = await text(page, "[data-testid=plugin-dialog-rights]");
    assert.match(rights, /a skill can lead it to run commands and change your files\. Allow it only if you trust where it came from\./);
    assert.ok(!/only adds text looks/.test(await text(page, "[data-testid=plugin-dialog]")), "not described as harmless data");
    await page.screenshot({ path: "test-output/issue60-review-consent.png" });

    await page.click("[data-testid=plugin-dialog-allow]");
    await waitFor(page, `${row}[data-status=ready]`);
    const saved = JSON.parse(readFileSync(join(root, "data", "settings.json"), "utf8")).pluginApprovals["acme.pack"];
    assert.match(saved.skills, /^[0-9a-f]{32}$/);
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: "test-output/issue60-review-failure.png" }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});
