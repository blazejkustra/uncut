// Issue #33 (D194) on the packaged app run invisibly and muted, with the stand-in claude: Claude
// Code's own tools in the Agent tab. "Ask before big changes": a command waits on a permission card
// (the tool, the command, Deny / Always for this session / Allow once); Always lets the same
// program run again without a card; a destructive command says why and can't be remembered; Deny
// refuses it. The work log names each built-in call with its target and opens to its result.
// Screenshots: test-output/issue33-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const out = (name: string) => resolve("test-output", `issue33-${name}.png`);
const plan = () => join(root, "plan.json");

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue33-")));
  mkdirSync(join(root, "projects"));
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(join(root, "results.jsonl"), "");
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const text = (page: Page, selector: string) => page.$eval(selector, (el) => (el as HTMLElement).innerText.trim());

test("issue 33: built-in tools in the work log with their results, permission cards in Ask before big changes", { skip, timeout: 300000 }, async () => {
  writeFileSync(
    plan(),
    JSON.stringify([
      [
        { builtin: "WebSearch", args: { query: "Argent Software Mansion" }, prompt: false, result: "1. Argent: let your coding agent drive the iOS simulator (argent.example.dev)\n2. software-mansion/argent on GitHub" },
        { builtin: "WebFetch", args: { url: "https://argent.example.dev/", prompt: "What does it do?" }, prompt: false, result: "Argent gives coding agents eyes and hands on iOS simulators and Android emulators." },
        { builtin: "Task", args: { description: "Find Argent's logo and screenshots", prompt: "…" }, prompt: false, result: "Logo: https://argent.example.dev/logo.svg" },
        { builtin: "Bash", args: { command: "ls -la media", description: "List the media folder" }, result: "total 0" },
        { builtin: "Bash", args: { command: "ls -la media" }, result: "total 0" },
        { builtin: "Bash", args: { command: "rm -rf ~/Desktop/old-renders" } },
      ],
    ]),
  );
  const app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan(), FAKE_PROMPT_LOG: join(root, "prompts.jsonl"), FAKE_RESULT_LOG: join(root, "results.jsonl"), UNCUT_APPROVAL_MS: "60000" },
  });
  apps.add(app);
  const { page } = app;
  const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=new-project]");
    await waitFor("[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor("[data-testid=agent-panel]");
    await page.click("[data-testid=agent-access]");
    await waitFor("[data-testid=agent-access-menu]");
    await page.click("[data-testid=agent-access-option][data-access=ask]");

    await page.click("[data-testid=agent-input]");
    await page.keyboard.type("Make a 20 s promo for Argent");
    await page.keyboard.press("Enter");

    // A plain command: a card with Always for this session.
    await waitFor("[data-testid=agent-approval][data-kind=permission]");
    assert.equal(await text(page, "[data-testid=agent-approval] .approval-text"), "Run a command?");
    assert.equal(await text(page, "[data-testid=agent-permission-target]"), "ls -la media");
    assert.ok(await page.$("[data-testid=agent-allow-always]"), "Always for this session is offered");
    await page.screenshot({ path: out("permission-card") });
    const firstId = await page.$eval("[data-testid=agent-approval]", (el) => (el as HTMLElement).dataset.id);
    await page.click("[data-testid=agent-allow-always]");

    // The same command runs again without a card; the destructive one asks, says why, and can't be remembered.
    await page.waitForFunction((id) => {
      const card = document.querySelector<HTMLElement>("[data-testid=agent-approval][data-kind=permission]");
      return card && card.dataset.id !== id;
    }, { timeout: 15000 }, firstId);
    assert.equal(await text(page, "[data-testid=agent-permission-target]"), "rm -rf ~/Desktop/old-renders");
    assert.match(await text(page, "[data-testid=agent-permission-why]"), /^It deletes .* outside the project\.$/);
    assert.equal(await page.$("[data-testid=agent-allow-always]"), null, "a destructive command is never remembered");
    await page.screenshot({ path: out("destructive") });
    await page.click("[data-testid=agent-decline]");
    await page.waitForFunction(() => document.querySelector("[data-testid=agent-turn]")?.getAttribute("data-status") === "done", { timeout: 20000 });

    // The work log: each call with its target; the denied one opened with why; a result opens from its row.
    await waitFor("[data-testid=agent-worklog-toggle][aria-expanded=true]");
    // The folded head leads with the denied command, so it shows ✕.
    assert.ok(await page.$("[data-testid=agent-worklog-toggle] svg.bad"), "the head's icon is ✕ when its last step failed");
    const steps = await page.$$eval("[data-testid=agent-worklog] .worklog-steps [data-testid=agent-step]", (els) => els.map((el) => (el as HTMLElement).innerText.trim()));
    assert.deepEqual(steps, [
      'Searched the web for "Argent Software Mansion"',
      "Read argent.example.dev",
      `Started a subagent "Find Argent's logo and screenshots"`,
      "Ran `ls -la media`",
      "Ran `ls -la media`",
      "Ran `rm -rf ~/Desktop/old-renders`",
    ]);
    assert.match(await text(page, "[data-testid=agent-step-error]"), /said no to "Run a command: rm -rf ~\/Desktop\/old-renders"/);
    await page.click("[data-testid=agent-worklog] .worklog-steps [data-testid=agent-step][data-tool=WebSearch]");
    await waitFor("[data-testid=agent-step-result]");
    assert.match(await text(page, "[data-testid=agent-step-result]"), /argent\.example\.dev/);
    await page.click("[data-testid=agent-worklog] .worklog-steps [data-testid=agent-step][data-tool=WebFetch]");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=agent-step-result]").length === 2);
    await page.screenshot({ path: out("worklog") });

    const decisions = readFileSync(join(root, "results.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.builtin);
    assert.deepEqual(decisions.map((d: any) => [d.builtin, d.decision.behavior]), [["WebSearch", "allow"], ["WebFetch", "allow"], ["Task", "allow"], ["Bash", "allow"], ["Bash", "allow"], ["Bash", "deny"]]);
  } catch (error) {
    await page.screenshot({ path: out("failure") }).catch(() => {});
    throw error;
  }
});
