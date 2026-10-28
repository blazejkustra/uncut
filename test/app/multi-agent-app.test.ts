// C12 on the packaged app, run invisibly, with the stand-in claude: + adds an agent with a name and a
// focus; a message to each, both tabs show working at once, and both agents' edits land on the
// timeline. Screenshots: test-output/c12-*.png.
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
const out = (name: string) => resolve("test-output", `c12-${name}.png`);
const text = (id: string, words: string, start: number) => ({
  id,
  type: "text",
  start,
  duration: 90,
  text: words,
  transform: { x: 154, y: 410 },
  style: { preset: "text.title", size: 130, weight: 700 },
});
const retitle = (id: string, words: string, summary: string) => [
  { tool: "project_read" },
  { sleep: 4000 },
  { tool: "timeline_edit", args: { baseRevision: "$rev", summary, ops: [{ op: "update_item", item: id, set: { text: words } }] } },
  { text: "Done." },
];

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-c12-")));
  const dir = join(root, "C12.uncut");
  mkdirSync(dir);
  const tracks = [
    { id: "text", kind: "text", name: "Text", items: [text("t1", "One", 0), text("t2", "Two", 120)] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [] },
  ];
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({ format: "uncut/0", name: "C12", canvas: { width: 1920, height: 1080, fps: 30 }, textLooks: 1, media: [], tracks }),
  );
  writeFileSync(join(root, "plan.json"), JSON.stringify([retitle("t1", "Cut by Editor", "Retitle t1"), retitle("t2", "Styled by Graphics", "Retitle t2")]));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const textOf = (id: string) =>
  JSON.parse(readFileSync(join(root, "C12.uncut", "project.json"), "utf8"))
    .tracks.flatMap((t: any) => t.items)
    .find((i: any) => i.id === id)?.text;
const until = async (check: () => boolean, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (check()) return;
  assert.fail("timed out");
};
const tabStatus = (page: Page, id: string) => page.$eval(`[data-testid=agent-tab-${id}]`, (el) => el.getAttribute("data-status"));
const sendMessage = async (page: Page, words: string) => {
  await page.waitForSelector("[data-testid=agent-input]:not([disabled])", { timeout: 15000 });
  await page.click("[data-testid=agent-input]");
  await page.keyboard.type(words);
  await page.keyboard.press("Enter");
};

test("add an agent with a focus, send to both, both tabs working, both edits on the timeline", { skip, timeout: 180000 }, async () => {
  app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([join(root, "C12.uncut")]),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: join(root, "plan.json"),
    },
  });
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click("[data-testid=tab-agent]");
  await page.waitForSelector("[data-testid=agent-input]:not([disabled])", { timeout: 15000 });
  assert.equal(await page.$("[data-testid=agent-tabs]"), null, "one agent: no tab row");

  await page.click("[data-testid=agent-add]");
  await page.waitForSelector("[data-testid=agent-add-name]", { timeout: 5000 });
  await page.click("[data-testid=agent-add-name]");
  await page.keyboard.type("Graphics");
  await page.click("[data-testid=agent-add-focus-graphics]");
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: out("add-agent") });
  await page.click("[data-testid=agent-add-create]");
  await page.waitForSelector("[data-testid=agent-tabs] [data-testid^=agent-tab-ag-]:not([data-testid=agent-tab-ag-main])", { timeout: 10000 });
  const graphics = await page.$eval("[data-testid=agent-tabs] [data-testid^=agent-tab-ag-]:not([data-testid=agent-tab-ag-main])", (el) =>
    el.getAttribute("data-testid")!.replace("agent-tab-", ""),
  );

  await page.click("[data-testid=agent-tab-ag-main]");
  await sendMessage(page, "Retitle t1");
  await page.waitForFunction(() => document.querySelector("[data-testid=agent-tab-ag-main]")?.getAttribute("data-status") === "working", { timeout: 10000 });
  await page.click(`[data-testid=agent-tab-${graphics}]`);
  await sendMessage(page, "Retitle t2");
  await page.waitForFunction(
    (id) => document.querySelector(`[data-testid=agent-tab-${id}]`)?.getAttribute("data-status") === "working",
    { timeout: 10000 },
    graphics,
  );
  assert.equal(await tabStatus(page, "ag-main"), "working", "both agents work at once");
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: out("two-agents") });

  await until(() => textOf("t1") === "Cut by Editor" && textOf("t2") === "Styled by Graphics");
  await page.waitForFunction(() => [...document.querySelectorAll("[data-testid^=agent-tab-ag-]")].every((el) => el.getAttribute("data-status") === "idle"), {
    timeout: 15000,
  });
  await page.waitForSelector("[data-testid=agent-turn][data-status=done]", { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: out("both-done") });
});
