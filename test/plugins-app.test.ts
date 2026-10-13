// Phase 7 chunk 1 (D97) on the packaged app, run invisibly and muted: a plugin folder
// (UNCUT_PLUGINS_DIR, the fake plugin) shows in Settings' Capture step with what allowing it means;
// Allow saves the approval; then the agent (the scripted stand-in for claude, never the real one)
// calls the plugin's tool, which the app starts on its own runtime ("node" = the Electron binary
// in Node mode, running the plugin's TypeScript), and the turn card names the plugin.
// Screenshots: test-output/plugins-ask.png, test-output/plugins-approve.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp } from "./helpers/app.ts";

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
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-plugins-app-")));
  mkdirSync(join(root, "projects"));
  cpSync(FAKE_PLUGIN, join(root, "plugins", "fake"), { recursive: true });
  for (const f of ["prompts.jsonl", "results.jsonl", "plugin.jsonl"]) writeFileSync(join(root, f), "");
  writeFileSync(join(root, "plan.json"), JSON.stringify([[{ tool: "fake_env", args: {} }, { tool: "fake_echo", args: { text: "from the app" } }]]));
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("a plugin is allowed in Settings, then the agent calls its tool in the packaged app", { skip, timeout: 180000 }, async () => {
  const app = await launchApp({
    command: APP,
    firstLaunch: true,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_PLUGINS_DIR: join(root, "plugins"),
      UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]),
      UNCUT_CLAUDE: FAKE_CLAUDE,
      FAKE_PLAN: join(root, "plan.json"),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      FAKE_RESULT_LOG: join(root, "results.jsonl"),
      FAKE_PLUGIN_LOG: join(root, "plugin.jsonl"),
      ANTHROPIC_API_KEY: "sk-ant-test-not-a-key",
      OPENAI_API_KEY: "sk-test-not-a-key",
    },
  });
  apps.add(app);
  const { page } = app;
  try {
    // First launch: onboarding. The Capture step lists the plugin, not allowed yet.
    await waitFor(page, "[data-testid=onboarding]");
    await page.click("[data-testid=wizard-step-1]");
    const row = "[data-testid='plugin-fake.capture']";
    await waitFor(page, `${row}[data-status=needs-approval]`);
    assert.match(await text(page, row), /Fake capture/);
    assert.match(await text(page, row), /Gives the agent fake_echo, fake_env, fake_crash, fake_sleep/);
    const detail = await text(page, "[data-testid='plugin-detail-fake.capture']");
    assert.match(detail, /runs as a program on this Mac with your rights: it can do anything you can, including reading and changing your files/);
    assert.match(detail, /It says it will start other programs and add media files/);
    assert.ok(!/[·•*]/.test(await text(page, "[data-testid=plugins]")), "no dots or stars between words");
    // The setup rows above finish checking first, so the screenshot shows the whole step.
    await waitFor(page, "[data-testid=check-ffmpeg]", 30000);
    await page.$eval("[data-testid=plugins]", (el) => el.scrollIntoView());
    await page.screenshot({ path: "test-output/plugins-ask.png" });

    await page.click("[data-testid='plugin-allow-fake.capture']");
    await waitFor(page, `${row}[data-status=ready]`);
    assert.equal(await text(page, "[data-testid='plugin-chip-fake.capture']"), "Allowed");
    await page.$eval("[data-testid=plugins]", (el) => el.scrollIntoView());
    await page.screenshot({ path: "test-output/plugins-approve.png" });
    const saved = JSON.parse(readFileSync(join(root, "data", "settings.json"), "utf8")).pluginApprovals["fake.capture"];
    assert.equal(saved.dir, realpathSync(join(root, "plugins", "fake")));
    assert.deepEqual(saved.capabilities, ["process:spawn", "media:write"]);
    assert.equal(readFileSync(join(root, "plugin.jsonl"), "utf8"), "", "allowing it starts nothing");

    // Close onboarding, make a project, and let the agent use the plugin.
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
    await page.type("[data-testid=agent-input]", "Check the capture plugin");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=agent-turn]")?.dataset.status === "done", { timeout: 60000 });
    const steps = await page.$$eval("[data-testid=agent-step]", (els) => els.map((e) => [e.textContent, (e as HTMLElement).dataset.status]));
    assert.deepEqual(steps, [
      ["Used fake_env from Fake capture", "done"],
      ["Used fake_echo from Fake capture", "done"],
    ]);
    const results = readFileSync(join(root, "results.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const facts = JSON.parse(results[0].result.content[0].text);
    assert.equal(facts.cwd, realpathSync(join(root, "plugins", "fake")));
    assert.deepEqual(facts.argv, ["--from-manifest"]);
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "UNCUT_DATA_DIR", "UNCUT_PLUGINS_DIR", "UNCUT_CLAUDE"]) assert.ok(!facts.env.includes(k), `${k} isn't passed to the plugin`);
    assert.equal(results[1].result.content[0].text, "fake_echo: from the app");
    assert.equal(results[1].result.content[1].type, "image");
    const pid = facts.pid as number;
    await app.close();
    apps.delete(app);
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "the plugin stops when the app quits");
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: "test-output/plugins-failure.png" }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});
