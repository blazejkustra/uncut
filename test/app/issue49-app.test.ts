// Issue #49 on the packaged app, run invisibly, with the stand-in claude: text in the Agent tab can be
// selected and copied. A reply, a code block, thinking and a tool's output are selectable
// (user-select: text) while the rest of the app isn't; ⌘C copies a selected reply even with a clip
// selected on the timeline (the timeline's ⌘C used to swallow it); ⌘A then ⌘C copies the composer's
// text; right-click on selected text or in the composer offers the text menu (logged in test mode);
// the Copy buttons on a reply, a code block and a tool's output put the whole piece on the clipboard
// (logged in test mode). The real clipboard is saved first and put back after.
// Screenshots: test-output/issue49-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";
import { eventually } from "../helpers/wait.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let saved: string | undefined;
const out = (name: string) => resolve("test-output", `issue49-${name}.png`);
const pbpaste = () => execFileSync("pbpaste", { encoding: "utf8" });
const pbcopy = (text: string) => execFileSync("pbcopy", { input: text });

const CODE = "ffmpeg -i intro.mp4 -t 5 short.mp4";
const REPLY = `I shortened the intro to five seconds.\n\nRun this to check it:\n\n\`\`\`sh\n${CODE}\n\`\`\`\n\nThe title stays where it was.`;
const THINK = "The intro is 12 s; five seconds keeps the hook.";
const RESULT = "intro.mp4  12.0 s  1920x1080";

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  try {
    saved = pbpaste();
  } catch {
    saved = undefined;
  }
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue49-")));
  dir = join(root, "Issue49.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Issue49",
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
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(
    join(root, "plan.json"),
    JSON.stringify([
      [
        { think: THINK },
        { builtin: "Bash", args: { command: "ls -l intro.mp4", description: "Look at the intro" }, prompt: false, result: RESULT },
        { text: REPLY },
      ],
    ]),
  );
});
after(async () => {
  await app?.close();
  if (saved !== undefined) pbcopy(saved);
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const userSelect = (page: Page, selector: string) => page.$eval(selector, (el) => getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect);
const selection = (page: Page) => page.evaluate(() => document.getSelection()?.toString() ?? "");
/** ⌘C the way the menu's Copy runs it: the keydown first (the page may take it), then the copy command. */
const cmd = async (page: Page, key: string, command: string) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key as never, { commands: [command] });
  await page.keyboard.up("Meta");
};
const logged = async (line: string) => {
  await eventually(() => app!.output().includes(line));
  return app!.output().includes(line);
};

test("issue #49: the Agent tab's text selects and copies (⌘C, the text menu, Copy buttons), the composer too", { skip, timeout: 240000 }, async () => {
  app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([dir]),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: join(root, "plan.json"),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
    },
  });
  const { page } = app;
  const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  await page.click("[data-testid=tab-agent]");
  await waitFor("[data-testid=agent-input]");

  // A turn with thinking, a tool call with output, and a reply with a code block.
  await page.click("[data-testid=agent-input]");
  await page.keyboard.type("Make the intro shorter");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("[data-testid=agent-turn]")?.getAttribute("data-status") === "done", { timeout: 30000 });
  await waitFor("[data-testid=agent-reply]:not([data-live])");

  // ---- Selectable: the conversation is text; the app around it isn't ----
  await page.click("[data-testid=agent-thinking] .thinking-head");
  await waitFor(".thinking-body");
  await page.click("[data-testid=agent-step].has-result");
  await waitFor("[data-testid=agent-step-result]");
  for (const sel of [
    "[data-testid=agent-reply] p",
    "[data-testid=agent-code] pre",
    ".thinking-body",
    "[data-testid=agent-step-result]",
    "[data-testid=agent-prompt]",
    "[data-testid=agent-step] .grow",
  ]) {
    assert.equal(await userSelect(page, sel), "text", `${sel} is selectable`);
  }
  assert.equal(await userSelect(page, "[data-testid=tab-agent]"), "none", "tabs aren't");

  // ---- ⌘C on a selected reply, with a clip selected on the timeline ----
  await page.click("[data-testid=bottom-timeline]").catch(() => {});
  await page.click('[data-testid=timeline-item][data-item="t1"]');
  await page
    .waitForFunction(() => document.querySelector('[data-testid=timeline-item][data-item="t1"]')?.classList.contains("selected"), { timeout: 5000 })
    .catch(() => {});
  pbcopy("before #49");
  await page.click("[data-testid=agent-reply] p", { count: 3 });
  assert.equal((await selection(page)).trim(), "I shortened the intro to five seconds.");
  // The page lets ⌘C through (no preventDefault) while text in the thread is selected.
  const prevented = await page.evaluate(() => {
    const e = new KeyboardEvent("keydown", { key: "c", code: "KeyC", metaKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    return e.defaultPrevented;
  });
  assert.equal(prevented, false, "the timeline's ⌘C doesn't take a text selection");
  await cmd(page, "KeyC", "copy");
  await eventually(() => pbpaste() !== "before #49");
  assert.equal(pbpaste().trim(), "I shortened the intro to five seconds.", "⌘C put the selected reply on the clipboard");
  await page.screenshot({ path: out("selected-reply") });

  // ---- Right-click on the selection: the text menu ----
  const p = await page.$eval("[data-testid=agent-reply] p", (el) => el.getBoundingClientRect().toJSON() as DOMRect);
  await page.mouse.click(p.left + 20, p.top + p.height / 2, { button: "right" });
  assert.ok(await logged("[test] text menu copy"), "right-click on selected text offers Copy");

  // ---- Copy buttons: the reply, the code block, the tool's output ----
  await page.hover("[data-testid=agent-reply]");
  await page.click("[data-testid=agent-reply] > [data-testid=agent-copy]");
  assert.ok(await logged("[test] copied I shortened the intro to five seconds."), "the reply's Copy");
  await page.hover("[data-testid=agent-code]");
  await page.click("[data-testid=agent-code] [data-testid=agent-copy]");
  assert.ok(await logged(`[test] copied ${CODE}`), "the code block's Copy");
  await page.hover("[data-testid=agent-step-result]");
  await page.click(".step-result-wrap [data-testid=agent-copy]");
  assert.ok(await logged(`[test] copied ${RESULT}`), "the tool output's Copy");
  await page.screenshot({ path: out("copy-buttons") });

  // ---- The composer: ⌘A, ⌘C, and its text menu ----
  await page.click("[data-testid=agent-input]");
  await page.keyboard.type("Keep the title as is");
  pbcopy("before composer");
  await cmd(page, "KeyA", "selectAll");
  assert.equal(
    await page.$eval("[data-testid=agent-input]", (el) => {
      const t = el as HTMLTextAreaElement;
      return t.value.slice(t.selectionStart, t.selectionEnd);
    }),
    "Keep the title as is",
    "⌘A selects the composer's text",
  );
  await cmd(page, "KeyC", "copy");
  await eventually(() => pbpaste() !== "before composer");
  assert.equal(pbpaste(), "Keep the title as is", "⌘C copied the composer's text");
  const box = await page.$eval("[data-testid=agent-input]", (el) => el.getBoundingClientRect().toJSON() as DOMRect);
  await page.mouse.click(box.left + 30, box.top + 12, { button: "right" });
  assert.ok(await logged("[test] text menu cut,copy,paste,-,selectAll"), "right-click in the composer offers Cut, Copy, Paste, Select All");
  await page.screenshot({ path: out("composer") });
  assert.deepEqual(app.errors, []);
});
