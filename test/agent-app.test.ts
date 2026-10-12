// Phase 4 chunk 2 on the packaged app: the Agent tab. A scripted stand-in for claude
// (helpers/fake-claude.ts) drives the real MCP server shipped in the app, started on the app's
// own runtime, so this runs the whole path without a subscription. An empty project gets a
// title from the agent (live on the timeline and in the preview), a manual edit shows up as the
// note on the next turn, Undo turn takes back exactly one turn, Stop cancels, and without Claude
// Code the tab shows how to install it. Screenshots: test-output/agent-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp } from "./helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const plan = () => join(root, "plan.json");
const promptLog = () => join(root, "prompts.jsonl");
const turns: Array<unknown> = [];
const nextTurn = (steps: Array<unknown>) => {
  turns.push(steps);
  writeFileSync(plan(), JSON.stringify(turns));
};
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const text = (page: Page, selector: string) => page.$eval(selector, (el) => (el.textContent ?? "").trim());
const timelineItems = (page: Page) =>
  page.$$eval("[data-testid=timeline-item]", (els) => els.map((e) => ({ id: (e as HTMLElement).dataset.item, track: ((e.parentElement as HTMLElement).dataset.track) })));
const turnCount = (page: Page) => page.$$eval("[data-testid=agent-turn]", (els) => els.length);

async function newProject(app: LaunchedApp) {
  const { page } = app;
  await waitFor(page, "[data-testid=welcome]");
  await page.click("[data-testid=new-project]");
  await waitFor(page, "[data-testid=new-project-form]");
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
  await page.click("[data-testid=create]");
  await waitFor(page, "[data-testid=editor]");
  return page.$eval("[data-testid=project-dir]", (el) => (el as HTMLElement).title);
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-app-")));
  mkdirSync(join(root, "projects"));
  mkdirSync(join(root, "projects-bare"));
  writeFileSync(promptLog(), "");
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the agent on an empty project: a title appears live, the manual-edit note shows, Undo turn and Stop work", { skip, timeout: 180000 }, async () => {
  const app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: plan(),
      FAKE_PROMPT_LOG: promptLog(),
      ANTHROPIC_API_KEY: "sk-ant-test-not-a-key",
    },
  });
  apps.add(app);
  try {
    await agentOnEmptyProject(app);
  } catch (error) {
    // The app's output (server and agent logs) says why far better than a timeout does.
    const cards = await app.page.$$eval("[data-testid=agent-turn]", (els) => els.map((e) => `${(e as HTMLElement).dataset.status}: ${(e as HTMLElement).innerText}`)).catch(() => []);
    const log = readFileSync(promptLog(), "utf8").slice(-1500);
    const panel = await app.page.$eval("[data-testid=agent-panel]", (e) => (e as HTMLElement).innerText).catch(() => "(no agent panel)");
    await app.page.screenshot({ path: "test-output/agent-failure.png" }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- agent tab ---\n${panel}\n--- turns ---\n${cards.join("\n")}\n--- claude runs ---\n${log}\n--- app output ---\n${app.output().slice(-4000)}` });
  }
});

async function agentOnEmptyProject(app: LaunchedApp) {
  const { page } = app;
  const dir = await newProject(app);
  const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));

  // An empty project's Agent tab invites a first prompt, with examples that need no media.
  await page.click("[data-testid=tab-agent]");
  await waitFor(page, "[data-testid=agent-empty]");
  assert.match(await text(page, "[data-testid=agent-empty]"), /No media needed to start/);
  assert.equal((await page.$$("[data-testid=agent-example]")).length, 3);
  // Claude Code (the stand-in) is found and signed in, so there's no setup card.
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.$("[data-testid=agent-setup]"), null);
  await page.screenshot({ path: "test-output/agent-empty.png" });

  // Turn 1: an example prompt; the fake reads the timeline and adds a 5 s title through MCP.
  nextTurn([
    { tool: "project_read" },
    {
      tool: "timeline_edit",
      args: {
        baseRevision: "$rev",
        summary: "Add a 5 s title card",
        ops: [{ op: "insert_item", track: "text", item: { id: "title-1", type: "text", start: 0, duration: 150, text: "Kraków from above", transform: { x: 154, y: 410 }, style: { preset: "text.title", size: 130, weight: 700 } } }],
      },
    },
    { text: "I added a **5 s** title card that says Kraków from above." },
  ]);
  await page.click("[data-testid=agent-example]");
  assert.match(await page.$eval("[data-testid=agent-input]", (el) => (el as HTMLTextAreaElement).value), /Kraków from above/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "agent-input", "the example is ready to send with Enter");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=agent-turn]")?.dataset.status === "done", { timeout: 30000 });
  const first = "[data-testid=agent-turn]:nth-of-type(1)";
  assert.deepEqual(await timelineItems(page), [{ id: "title-1", track: "text" }], "the title is on the timeline");
  await waitFor(page, '.pv-text[data-item="title-1"]');
  assert.equal(await text(page, '.pv-text[data-item="title-1"]'), "Kraków from above", "and in the preview");
  assert.equal(await text(page, "[data-testid=timecode]"), "00:00:00:00 / 00:00:05:00");
  assert.equal(onDisk().tracks[0].items[0].id, "title-1", "and saved");
  assert.deepEqual(
    await page.$$eval(`${first} [data-testid=agent-step]`, (els) => els.map((e) => [e.textContent, (e as HTMLElement).dataset.status])),
    [
      ["Read the timeline", "done"],
      ["Add a 5 s title card", "done"],
    ],
  );
  assert.match(await text(page, `${first} [data-testid=agent-edits]`), /1 edit.*Add a 5 s title card.*Added text title-1 on track text/);
  assert.equal(await text(page, `${first} [data-testid=agent-reply] b`), "5 s", "the reply's markdown is rendered");
  assert.equal(await page.$(`${first} [data-testid=agent-note]`), null);
  assert.equal(await page.$eval(`${first} [data-testid=agent-undo-turn]`, (b) => (b as HTMLButtonElement).disabled), false);
  await page.screenshot({ path: "test-output/agent-turn.png" });

  // A manual edit: the Text tab's lower third at the playhead (frame 0) goes on a new track.
  await page.click("[data-testid=rail-text]");
  await waitFor(page, "[data-testid=text-library]");
  await page.click("[data-testid=text-preset][data-preset=lower-third]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=timeline-item]").length === 2);

  // Turn 2 (⇧Enter makes a new line, Enter sends): the note about the manual edit is on the card
  // and in the prompt.
  nextTurn([
    { tool: "project_read" },
    { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Add an end card", ops: [{ op: "insert_item", track: "text", item: { id: "end-1", type: "text", start: 150, duration: 90, text: "Thanks for watching", transform: { x: 154, y: 410 }, style: { preset: "text.title", size: 130, weight: 700 } } }] } },
  ]);
  await page.click("[data-testid=agent-input]");
  await page.type("[data-testid=agent-input]", "add an end card");
  await page.keyboard.down("Shift");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Shift");
  await page.type("[data-testid=agent-input]", "that thanks people");
  assert.equal(await page.$eval("[data-testid=agent-input]", (el) => (el as HTMLTextAreaElement).value), "add an end card\nthat thanks people");
  assert.equal(await turnCount(page), 1, "⇧Enter didn't send");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll<HTMLElement>("[data-testid=agent-turn]")[1]?.dataset.status === "done", { timeout: 30000 });
  const second = "[data-testid=agent-turn]:nth-of-type(2)";
  assert.match(await text(page, `${second} [data-testid=agent-note]`), /Told the agent about 2 changes you made by hand.*Added text track "Text 2" \(text-1\).*Added text lower-third-1/);
  const prompts = readFileSync(promptLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(prompts[1].prompt.split("\n\n<editor-context>")[0], "add an end card\nthat thanks people");
  assert.match(prompts[1].prompt, /by hand/);
  assert.equal(prompts[1].resume, "fake-session");
  assert.ok(!prompts[0].env.includes("ANTHROPIC_API_KEY"), "D41 in the packaged app too");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=timeline-item]").length === 3);
  await page.screenshot({ path: "test-output/agent-note.png" });

  // Undo turn 2: only the end card goes; the title and the lower third stay.
  await page.click(`${second} [data-testid=agent-undo-turn]`);
  await page.waitForFunction(() => document.querySelectorAll<HTMLElement>("[data-testid=agent-turn]")[1]?.dataset.undo === "undone");
  assert.deepEqual((await timelineItems(page)).map((i) => i.id).sort(), ["lower-third-1", "title-1"]);
  assert.equal(await page.$(`${second} [data-testid=agent-undo-turn]`), null, "an undone turn has no Undo button");
  // Undo turn 1 too: nothing the user did depends on the title.
  await page.click(`${first} [data-testid=agent-undo-turn]`);
  await page.waitForFunction(() => document.querySelectorAll<HTMLElement>("[data-testid=agent-turn]")[0]?.dataset.undo === "undone");
  assert.deepEqual((await timelineItems(page)).map((i) => i.id), ["lower-third-1"]);
  assert.deepEqual(onDisk().tracks.flatMap((t: { items: Array<{ id: string }> }) => t.items.map((i) => i.id)), ["lower-third-1"]);
  // ⌘Z brings the last undone turn back in one step.
  await page.click("[data-testid=undo]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=timeline-item]").length === 2);

  // Stop: a turn that hangs is cancelled from its card.
  nextTurn([{ tool: "project_read" }, { sleep: 60000 }]);
  const third = await (async () => {
    await page.click("[data-testid=agent-input]");
    await page.type("[data-testid=agent-input]", "take your time");
    await page.keyboard.press("Enter");
    await waitFor(page, "[data-testid=agent-turn]:nth-of-type(3)[data-status=running] [data-testid=agent-step][data-status=done]");
    return "[data-testid=agent-turn]:nth-of-type(3)";
  })();
  assert.equal(await page.$eval("[data-testid=agent-send]", (b) => (b as HTMLButtonElement).disabled), true, "one turn at a time");
  await page.click(`${third} [data-testid=agent-cancel]`);
  await waitFor(page, `${third}[data-status=cancelled]`, 10000);
  assert.equal(await text(page, `${third} .turn-status`), "Stopped");
  await page.screenshot({ path: "test-output/agent-stopped.png" });
  assert.deepEqual(app.errors, []);
}

test("without Claude Code the Agent tab says how to install it instead of failing", { skip, timeout: 120000 }, async () => {
  const app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data-bare"),
      UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects-bare")]),
      // No claude anywhere: a bare PATH and no login-shell lookup.
      UNCUT_CLAUDE: "",
      UNCUT_SHELL_ENV: "off",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
  });
  apps.add(app);
  const { page } = app;
  await newProject(app);
  await page.click("[data-testid=tab-agent]");
  await waitFor(page, "[data-testid=agent-setup][data-status=missing]", 30000);
  assert.match(await text(page, "[data-testid=agent-setup]"), /Claude Code isn't installed/);
  assert.match(await text(page, "[data-testid=agent-setup-command]"), /claude\.ai\/install\.sh/);
  assert.equal(await page.$eval("[data-testid=agent-input]", (el) => (el as HTMLTextAreaElement).disabled), true);
  assert.equal(await page.$eval("[data-testid=agent-example]", (el) => (el as HTMLButtonElement).disabled), true);
  await page.screenshot({ path: "test-output/agent-missing.png" });
  assert.deepEqual(app.errors, []);
});
