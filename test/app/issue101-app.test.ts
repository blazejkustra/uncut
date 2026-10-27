// Issue #101 (D269) on the packaged app, run invisibly, with the stand-in claude: the composer's
// token meter never shows a guessed window. Claude's result (with modelUsage's contextWindow) comes
// 3 s after the answer's usage (FAKE_RESULT_DELAY). Without "[1m]" on the model, the meter reads
// "92k" until the result says 1M, then "92k / 1M" (it used to read "92k / 200k" first). With
// claude's init naming "claude-opus-5-5[1m]" (opus[1m] in the user's Claude Code settings), it
// reads "92k / 1M" from the first answer, before the result.
// Screenshots: test-output/issue101-*.png.
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
const apps = new Set<LaunchedApp>();
const out = (name: string) => resolve("test-output", `issue101-${name}.png`);

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue101-")));
  for (const name of ["Plain", "Marked"]) {
    const dir = join(root, `${name}.uncut`);
    mkdirSync(dir);
    writeFileSync(
      join(dir, "project.json"),
      JSON.stringify({
        format: "uncut/0",
        name,
        canvas: { width: 1920, height: 1080, fps: 30 },
        textLooks: 1,
        media: [],
        tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [] }],
      }),
    );
  }
  // The API's message.model never carries "[1m]"; the result's modelUsage reports the 1M window.
  // One plan per run: its .turn counter counts messages.
  for (const name of ["Plain", "Marked"])
    writeFileSync(
      join(root, `plan-${name}.json`),
      JSON.stringify([
        [
          { text: "Looked at the project." },
          {
            usage: { input_tokens: 12, cache_read_input_tokens: 88_000, cache_creation_input_tokens: 4_000, output_tokens: 300 },
            model: "claude-opus-5-5",
            contextWindow: 1_000_000,
          },
        ],
      ]),
    );
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const meterText = (page: Page) => page.$eval("[data-testid=agent-token-used]", (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
const turnDone = (page: Page) => page.evaluate(() => !!document.querySelector("[data-testid=agent-turn][data-status=done]"));

/** Opens `name`, sends one message, and returns the meter while the result is still pending, then after it. */
async function run(name: string, initModel: string | undefined) {
  const app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, `data-${name}`),
      UNCUT_TEST_DIALOG: JSON.stringify([join(root, `${name}.uncut`)]),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: join(root, `plan-${name}.json`),
      FAKE_RESULT_DELAY: "3000",
      ...(initModel ? { FAKE_INIT_MODEL: initModel } : {}),
    },
  });
  apps.add(app);
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click("[data-testid=tab-agent]");
  await page.waitForSelector("[data-testid=agent-input]:not([disabled])", { timeout: 15000 });
  for (let k = 0; k < 5; k++) {
    await page.click("[data-testid=agent-input]");
    await page.keyboard.type("Look at the project");
    if ((await page.$eval("[data-testid=agent-input]", (el) => (el as HTMLTextAreaElement).value)) === "Look at the project") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await page.keyboard.press("Enter");
  // The answer's usage arrived; its result (and the turn's end) is 3 s away.
  await page.waitForSelector("[data-testid=agent-token-used]", { timeout: 30000 }).catch(async (error) => {
    await page.screenshot({ path: out(`${name.toLowerCase()}-stuck`) });
    const turns = await page.$$eval("[data-testid=agent-turn]", (els) =>
      els.map((el) => `${el.getAttribute("data-status")}: ${(el as HTMLElement).innerText.slice(0, 300)}`),
    );
    throw new Error(`${name}: no meter: ${JSON.stringify(turns)} ${app.output().slice(-1500)}`, { cause: error });
  });
  const early = await meterText(page);
  assert.equal(await turnDone(page), false, `${name}: read before the result`);
  await page.screenshot({ path: out(`${name.toLowerCase()}-before-result`) });
  await page.waitForSelector("[data-testid=agent-turn][data-status=done]", { timeout: 30000 });
  await page.waitForFunction(() => /\//.test(document.querySelector("[data-testid=agent-token-used]")?.textContent ?? ""), { timeout: 5000 });
  const late = await meterText(page);
  await page.hover("[data-testid=agent-token-meter]");
  await page.waitForSelector("[data-testid=tooltip]", { timeout: 3000 });
  const tip = await page.$eval("[data-testid=tooltip]", (el) => (el as HTMLElement).innerText);
  await new Promise((r) => setTimeout(r, 250));
  await page.screenshot({ path: out(`${name.toLowerCase()}-after-result`) });
  assert.deepEqual(app.errors, []);
  await app.close();
  apps.delete(app);
  return { early, late, tip };
}

test("issue #101: no guessed 200k; the window from the model's [1m] at once, else from the result", { skip, timeout: 180000 }, async () => {
  const plain = await run("Plain", undefined);
  assert.equal(plain.early, "92k / 1M", "Claude Code's get_context_usage said the window when the session started");
  assert.equal(plain.late, "92k / 1M", "the result's window");
  assert.match(plain.tip, /Context: 92,012 of 1,000,000 tokens \(9%\) after the agent's last answer, as Claude Code counts it/);
  assert.match(plain.tip, /Cache read 88k, cache write 4k, fresh 12/);
  assert.match(plain.tip, /compacts the conversation on its own at 967k \(97% of the window\)/);

  const marked = await run("Marked", "claude-opus-5-5[1m]");
  assert.equal(marked.early, "92k / 1M", "1M from the first answer: init's model has [1m]");
  assert.equal(marked.late, "92k / 1M");
});
