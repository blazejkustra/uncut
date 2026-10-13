// Phase 8 chunk 1 (D102) on the packaged app, run invisibly and muted: Settings › Plugins, Add
// plugin… from a folder (the folder dialog answered by UNCUT_TEST_DIALOG) copies the fake plugin
// into <dataDir>/plugins and opens the approval dialog (source, capabilities, "runs with your
// rights"); Allow; then the agent (the scripted stand-in for claude, never the real one) has its
// tools in tools/list and calls one, which runs on the app's own Node importing the plugin SDK
// shipped in Resources/plugin-sdk. Screenshot: test-output/plugins-install.png (the dialog).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE_CLAUDE = resolve("test/helpers/fake-claude.ts");
const FAKE_PLUGIN = resolve("test/helpers/fake-plugin");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const text = (page: Page, selector: string) => page.$eval(selector, (el) => ((el as HTMLElement).innerText ?? "").trim());

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-plugins-install-")));
  mkdirSync(join(root, "projects"));
  cpSync(FAKE_PLUGIN, join(root, "src", "fake"), { recursive: true });
  for (const f of ["prompts.jsonl", "results.jsonl", "plugin.jsonl", "tools.jsonl"]) writeFileSync(join(root, f), "");
  writeFileSync(join(root, "plan.json"), JSON.stringify([[{ tool: "fake_echo", args: { text: "installed" } }]]));
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("Add plugin from a folder, allow it in the dialog, then the agent sees and calls its tools", { skip, timeout: 180000 }, async () => {
  const src = join(root, "src", "fake");
  const app = await launchApp({
    command: APP,
    firstLaunch: true,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      // The Add plugin… folder dialog, then the new project's.
      UNCUT_TEST_DIALOG: JSON.stringify([src, join(root, "projects")]),
      UNCUT_CLAUDE: FAKE_CLAUDE,
      FAKE_PLAN: join(root, "plan.json"),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      FAKE_RESULT_LOG: join(root, "results.jsonl"),
      FAKE_TOOLS_LOG: join(root, "tools.jsonl"),
      FAKE_PLUGIN_LOG: join(root, "plugin.jsonl"),
    },
  });
  apps.add(app);
  const { page } = app;
  try {
    await waitFor(page, "[data-testid=onboarding]");
    await page.click("[data-testid=wizard-step-1]");
    await waitFor(page, "[data-testid=plugin-add]");
    await page.click("[data-testid=plugin-add]");
    await page.click("[data-testid=plugin-add-folder]");

    // Installed, not allowed: the approval dialog opens.
    await waitFor(page, "[data-testid=plugin-dialog]", 20000);
    const installed = realpathSync(join(root, "data", "plugins", "fake.capture"));
    assert.ok(existsSync(join(installed, "server.ts")));
    assert.match(await text(page, "[data-testid=plugin-dialog-source]"), new RegExp(`Copied from ${src}`));
    assert.match(await text(page, "[data-testid=plugin-dialog-tools-for-the-agent]"), /fake_echo, fake_env, fake_crash, fake_sleep/);
    assert.match(await text(page, "[data-testid=plugin-dialog-asks]"), /It says it will start other programs and add media files/);
    assert.match(await text(page, "[data-testid=plugin-dialog-rights]"), /runs as a program on this Mac with your rights/);
    assert.ok(!/[·•*]/.test(await text(page, "[data-testid=plugin-dialog]")), "no dots or stars between words");
    assert.equal(await page.$eval("[data-testid='plugin-fake.capture']", (el) => (el as HTMLElement).dataset.status), "needs-approval");
    assert.equal(readFileSync(join(root, "plugin.jsonl"), "utf8"), "", "installing starts nothing");
    await page.screenshot({ path: "test-output/plugins-install.png" });

    await page.click("[data-testid=plugin-dialog-allow]");
    await waitFor(page, "[data-testid='plugin-fake.capture'][data-status=ready]");
    assert.equal(await page.$("[data-testid=plugin-dialog]"), null);
    assert.ok(await page.$("[data-testid='plugin-remove-fake.capture']"), "an installed plugin can be removed");
    const settings = JSON.parse(readFileSync(join(root, "data", "settings.json"), "utf8"));
    assert.equal(settings.pluginApprovals["fake.capture"].dir, installed);
    assert.deepEqual(settings.pluginInstalls["fake.capture"].source, src);

    // A project, and a turn: the agent's tools/list has the plugin's tools, and it calls one.
    await page.keyboard.press("Escape");
    await waitFor(page, "[data-testid=welcome]");
    await page.click("[data-testid=new-project]");
    await waitFor(page, "[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor(page, "[data-testid=editor]");
    await page.click("[data-testid=tab-agent]");
    await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"), { timeout: 15000 });
    await page.click("[data-testid=agent-input]");
    await page.type("[data-testid=agent-input]", "Use the plugin I installed");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=agent-turn]")?.dataset.status === "done", { timeout: 60000 });
    const lists = readFileSync(join(root, "tools.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Array<string>);
    for (const t of ["fake_echo", "fake_env", "fake_crash", "fake_sleep"]) assert.ok(lists[0]!.includes(t), `the agent sees ${t}`);
    const steps = await page.$$eval("[data-testid=agent-step]", (els) => els.map((e) => [e.textContent, (e as HTMLElement).dataset.status]));
    assert.deepEqual(steps, [["Used fake_echo from Fake capture", "done"]]);
    const results = readFileSync(join(root, "results.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(results[0].result.content[0].text, "fake_echo: installed");
    const started = readFileSync(join(root, "plugin.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(started[0].cwd, installed, "it runs from the installed copy");
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: "test-output/plugins-install-failure.png" }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});
