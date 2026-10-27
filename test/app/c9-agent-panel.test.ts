// Handoff 8, 9, 21 on the packaged app, run invisibly, with the stand-in claude: the meter's tooltip
// says the context as Claude Code counts it (the cache split, where it compacts on its own); an
// undone turn offers Redo turn, which puts its title back; Compact adds a row to the thread and the
// meter drops. Screenshots: test-output/c9-*.png.
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
let app: LaunchedApp | undefined;
const out = (name: string) => resolve("test-output", `c9-${name}.png`);
const title = {
  id: "title-1",
  type: "text",
  start: 0,
  duration: 90,
  text: "Hello",
  transform: { x: 154, y: 410 },
  style: { preset: "text.title", size: 130, weight: 700 },
};

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-c9-")));
  const dir = join(root, "C9.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "C9",
      canvas: { width: 1920, height: 1080, fps: 30 },
      textLooks: 1,
      media: [],
      tracks: [
        { id: "text", kind: "text", name: "Text", items: [] },
        { id: "main", kind: "video", role: "main", name: "Main", items: [] },
      ],
    }),
  );
  const usage = {
    usage: { input_tokens: 12, cache_read_input_tokens: 380_000, cache_creation_input_tokens: 4_000, output_tokens: 300 },
    model: "claude-opus-5-5",
  };
  writeFileSync(
    join(root, "plan.json"),
    JSON.stringify([
      [
        { tool: "project_read" },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Add a title", ops: [{ op: "insert_item", track: "text", item: title }] } },
        { text: "Added a title." },
        usage,
      ],
    ]),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const onDisk = () => JSON.parse(readFileSync(join(root, "C9.uncut", "project.json"), "utf8"));
const hasTitle = () => onDisk().tracks.some((t: any) => t.items.some((i: any) => i.id === "title-1"));
const meterText = (page: Page) => page.$eval("[data-testid=agent-token-used]", (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
const until = async (check: () => boolean, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (check()) return;
  assert.fail("timed out");
};

test("meter tooltip, Redo turn and Compact in the Agent panel", { skip, timeout: 180000 }, async () => {
  app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([join(root, "C9.uncut")]),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: join(root, "plan.json"),
      FAKE_COMPACT_AT: "967000",
    },
  });
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click("[data-testid=tab-agent]");
  await page.waitForSelector("[data-testid=agent-input]:not([disabled])", { timeout: 15000 });
  await page.click("[data-testid=agent-input]");
  await page.keyboard.type("Add a title");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-testid=agent-turn][data-status=done]", { timeout: 30000 });
  assert.ok(hasTitle());

  await page.waitForFunction(() => /\/ 1M/.test(document.querySelector("[data-testid=agent-token-used]")?.textContent ?? ""), { timeout: 5000 });
  assert.equal(await meterText(page), "384k / 1M");
  await page.hover("[data-testid=agent-token-meter]");
  await page.waitForSelector("[data-testid=tooltip]", { timeout: 3000 });
  const tip = await page.$eval("[data-testid=tooltip]", (el) => (el as HTMLElement).innerText);
  assert.match(tip, /Context: 384,012 of 1,000,000 tokens \(38%\) after the agent's last answer, as Claude Code counts it/);
  assert.match(tip, /Cache read 380k, cache write 4k, fresh 12/);
  assert.match(tip, /compacts the conversation on its own at 967k/);
  await new Promise((r) => setTimeout(r, 250));
  await page.screenshot({ path: out("meter-tooltip") });

  await page.mouse.move(10, 10);
  await page.click("[data-testid=agent-undo-turn]");
  await until(() => !hasTitle());
  await page.waitForSelector("[data-testid=agent-redo-turn]:not([disabled])", { timeout: 10000 });
  await page.screenshot({ path: out("redo-button") });
  await page.click("[data-testid=agent-redo-turn]");
  await until(hasTitle);
  await page.waitForSelector("[data-testid=agent-turn][data-undo=available] [data-testid=agent-undo-turn]", { timeout: 10000 });
  assert.equal(await page.$("[data-testid=agent-redo-turn]"), null, "Redo goes once the turn is back");

  await page.click("[data-testid=agent-compact]");
  await page.waitForSelector("[data-testid=agent-compact-row][data-status=done]", { timeout: 15000 });
  const row = await page.$eval("[data-testid=agent-compact-row]", (el) => (el as HTMLElement).innerText);
  assert.match(row, /Compacted the conversation: 384k → 15k tokens/);
  await page.waitForFunction(() => (document.querySelector("[data-testid=agent-token-used]")?.textContent ?? "").startsWith("18k"), { timeout: 5000 });
  await page.screenshot({ path: out("compact-row") });
  assert.deepEqual(app.errors, []);
});
