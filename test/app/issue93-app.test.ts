// Issue #93 (D261) on the packaged app, run invisibly, with the stand-in claude: the composer shows
// the context window's use from the usage claude reports. Hidden before any answer; "92k / 200k"
// after one (the last top-level assistant message's input + cache read + cache creation + output,
// the result's modelUsage contextWindow; a subagent's bigger usage is ignored); "+~N" for a draft;
// the tooltip breaks it down (system + tools, conversation, this message's context, the draft);
// amber from 80 %, red from 95 % with a warning in the tooltip.
// Screenshots: test-output/issue93-*.png.
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
let dir = "";
let app: LaunchedApp | undefined;
const out = (name: string) => resolve("test-output", `issue93-${name}.png`);
const MODEL = "claude-opus-5-5";
const usage = (input: number, cacheRead: number, cacheCreation: number, output: number) => ({
  usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation, output_tokens: output },
  model: MODEL,
  contextWindow: 200_000,
});

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue93-")));
  dir = join(root, "Issue93.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Issue93",
      canvas: { width: 1920, height: 1080, fps: 30 },
      textLooks: 1,
      media: [],
      tracks: [
        {
          id: "text",
          kind: "text",
          name: "Text",
          items: [
            {
              id: "t1",
              type: "text",
              start: 0,
              duration: 90,
              text: "Launch day",
              transform: { x: 160, y: 440 },
              style: { preset: "text.title", size: 140, weight: 700 },
            },
          ],
        },
        { id: "main", kind: "video", role: "main", name: "Main", items: [] },
      ],
    }),
  );
  // A subagent's message with a far bigger context: not the conversation's.
  const subagent = {
    raw: {
      type: "assistant",
      parent_tool_use_id: "toolu_sub",
      message: { id: "msg_sub", model: MODEL, role: "assistant", content: [{ type: "text", text: "subagent" }], usage: { input_tokens: 150_000 } },
    },
  };
  writeFileSync(
    join(root, "plan.json"),
    JSON.stringify([
      [subagent, { text: "Looked at the project." }, usage(12, 88_000, 4_000, 300)],
      [{ text: "Still going." }, usage(10, 165_000, 3_000, 500)],
      [{ text: "Nearly full." }, usage(10, 190_000, 1_000, 300)],
    ]),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** The composer can re-render right after the tab opens: click again if the node went away. */
const clickInput = async (page: Page) => {
  for (let k = 0; ; k++) {
    try {
      await page.waitForSelector("[data-testid=agent-input]:not([disabled])", { timeout: 15000 });
      return await page.click("[data-testid=agent-input]");
    } catch (error) {
      if (k >= 5) throw error;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
};
/** ⌘A (as the menu's Select All runs it) and Backspace. */
const clearInput = async (page: Page) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyA", { commands: ["selectAll"] });
  await page.keyboard.up("Meta");
  await page.keyboard.press("Backspace");
};
const sendAndWait = async (page: Page, text: string, n: number) => {
  // Typed again if a re-render ate it (the composer's value must hold the text before Enter).
  for (let k = 0; k < 5; k++) {
    await clickInput(page);
    await clearInput(page);
    await page.keyboard.type(text);
    if ((await page.$eval("[data-testid=agent-input]", (el) => (el as HTMLTextAreaElement).value)) === text) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await page.keyboard.press("Enter");
  await page
    .waitForFunction((k) => document.querySelectorAll("[data-testid=agent-turn][data-status=done]").length === k, { timeout: 30000 }, n)
    .catch(async (error) => {
      await page.screenshot({ path: out(`stuck-${n}`) });
      const turns = await page.$$eval("[data-testid=agent-turn]", (els) =>
        els.map((el) => `${el.getAttribute("data-status")}: ${(el as HTMLElement).innerText.slice(0, 300)}`),
      );
      throw new Error(`turn ${n} didn't finish: ${JSON.stringify(turns)} ${app?.output().slice(-1500)}`, { cause: error });
    });
};
const meter = (page: Page) =>
  page.$eval("[data-testid=agent-token-meter]", (el) => ({
    text: (el.querySelector("[data-testid=agent-token-used]")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    count: document.querySelectorAll("[data-testid=agent-token-meter]").length,
    width: el.getBoundingClientRect().width,
    level: el.getAttribute("data-level"),
    color: getComputedStyle(el).color,
  }));
const tooltip = async (page: Page) => {
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => !document.querySelector("[data-testid=tooltip]"), { timeout: 3000 });
  await page.hover("[data-testid=agent-token-meter]");
  await page.waitForSelector("[data-testid=tooltip]", { timeout: 3000 });
  // Past its fade-in, for the screenshots.
  await new Promise((r) => setTimeout(r, 250));
  return page.$eval("[data-testid=tooltip]", (el) => (el as HTMLElement).innerText);
};

test("issue #93: the composer's context meter, its breakdown and the near-limit warning", { skip, timeout: 180000 }, async () => {
  app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: FAKE, FAKE_PLAN: join(root, "plan.json") },
  });
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click("[data-testid=tab-agent]");
  await page.waitForSelector("[data-testid=agent-input]", { timeout: 15000 });
  assert.equal(await page.$("[data-testid=agent-token-meter]"), null, "hidden until claude reported usage");

  // ---- After one answer: 12 + 88,000 + 4,000 + 300 = 92,312 of 200,000 ----
  await sendAndWait(page, "Look at the project", 1);
  await page.waitForSelector("[data-testid=agent-token-meter]", { timeout: 5000 });
  let m = await meter(page);
  assert.equal(m.text, "92k / 200k", "used / window, the subagent's 150k ignored");
  assert.equal(m.level, "ok");
  assert.equal(m.count, 1, "one meter");
  assert.ok(m.width > 40, `the meter shows its numbers (${m.width}px)`);
  assert.equal(await page.$("[data-testid=agent-token-draft]"), null, "no draft estimate with an empty composer");

  // ---- A draft: +~N ----
  await clickInput(page);
  await page.keyboard.type("Add a title card that says Launch day and fade it out after three seconds");
  await page.waitForSelector("[data-testid=agent-token-draft]", { timeout: 3000 });
  assert.match(await page.$eval("[data-testid=agent-token-draft]", (el) => el.textContent ?? ""), /^\+~\d+(\.\d)?k?$/);
  const tip = await tooltip(page);
  assert.match(tip, /Context: 92,312 of 200,000 tokens \(46%\)/);
  assert.match(tip, /System prompt \+ tools: ~\d+(\.\d)?k \(estimate\)/);
  assert.match(tip, /Conversation: ~\d+(\.\d)?k?/);
  assert.doesNotMatch(tip, /Conversation: ~0\n/, "the rest of the 92k is conversation");
  assert.doesNotMatch(tip, /This message's context: ~0 /, "Uncut's <editor-context> counts");
  assert.match(tip, /This message's context: ~\d+(\.\d)?k? \(estimate\)/);
  assert.match(tip, /Your draft adds ~\d+(\.\d)?k? \(estimate\)/);
  assert.equal(tip.split("\n").length, 5, "one line per part");
  await page.screenshot({ path: out("tooltip") });
  const meterBox = await page.$eval("[data-testid=agent-token-meter]", (el) => el.getBoundingClientRect().toJSON() as DOMRect);
  await page.screenshot({ path: out("meter"), clip: { x: Math.max(0, meterBox.x - 260), y: Math.max(0, meterBox.y - 120), width: 420, height: 160 } });
  // Clear the draft.
  await clickInput(page);
  await clearInput(page);
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-token-draft]"), { timeout: 3000 });

  // ---- Past 80 %: amber ----
  await sendAndWait(page, "Keep going", 2);
  await page.waitForFunction(() => document.querySelector("[data-testid=agent-token-meter]")?.getAttribute("data-level") === "high", { timeout: 5000 });
  m = await meter(page);
  assert.equal(m.text, "169k / 200k");
  assert.match(await tooltip(page), /Getting full/);
  await page.screenshot({ path: out("high") });

  // ---- Past 95 %: red, and the tooltip warns ----
  await sendAndWait(page, "One more", 3);
  await page.waitForFunction(() => document.querySelector("[data-testid=agent-token-meter]")?.getAttribute("data-level") === "full", { timeout: 5000 });
  m = await meter(page);
  assert.equal(m.text, "191k / 200k");
  assert.notEqual(m.color, "", "coloured");
  const full = await tooltip(page);
  assert.match(full, /Context: 191,310 of 200,000 tokens \(96%\)/);
  assert.match(full, /Almost full/);
  await page.screenshot({ path: out("full") });
  assert.deepEqual(app.errors, []);
});
