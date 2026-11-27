// D348 on the packaged app, run invisibly, with the stand-in claude: a turn that trims a clip,
// looks over a range and starts a subagent shows the agent's cursor at the clip's trimmed edge
// with its step on the pill, then on the ruler at the range, a smaller child cursor while the
// subagent runs (gone when it finishes), and no cursor once the turn ends. Then two agents at
// once, and reduced motion (the cursor jumps). Screenshots: test-output/d348-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let app: LaunchedApp | undefined;
const out = (name: string) => resolve("test-output", `d348-${name}.png`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const clip = (id: string, at: number) => ({ id, type: "clip", media: "m-shot", in: at, duration: 120 });
const title = {
  id: "t1",
  type: "text",
  start: 30,
  duration: 90,
  text: "Ship it",
  transform: { x: 154, y: 410 },
  style: { preset: "text.title", size: 130, weight: 700 },
};
const edit = (summary: string, op: Record<string, unknown>) => ({ tool: "timeline_edit", args: { baseRevision: "$rev", summary, ops: [op] } });
const subagent = (description: string, inner: Record<string, unknown>) => [
  {
    raw: {
      type: "assistant",
      message: { id: "msg-task", role: "assistant", content: [{ type: "tool_use", id: "tu-task", name: "Task", input: { description, prompt: "Look." } }] },
    },
  },
  { sleep: 600 },
  {
    raw: {
      type: "assistant",
      parent_tool_use_id: "tu-task",
      message: { id: "msg-sub", role: "assistant", content: [{ type: "tool_use", id: "tu-sub-1", name: "mcp__uncut__render_frames", input: inner }] },
    },
  },
  { sleep: 2500 },
  { raw: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-task", content: "The second take." }] } } },
  { sleep: 1500 },
];
const plan = [
  [
    { tool: "project_read" },
    { sleep: 1200 },
    edit("Trim the end of clip 2", { op: "trim_item", item: "c2", edge: "end", frames: 15 }),
    { sleep: 2500 },
    { tool: "project_read", args: { range: { start: 30, end: 120 } } },
    { sleep: 2500 },
    ...subagent("Find the best take", { frames: [60] }),
    { text: "Trimmed clip 2." },
  ],
  [{ tool: "project_read" }, edit("Trim the start of clip 1", { op: "trim_item", item: "c1", edge: "start", frames: 10 }), { sleep: 9000 }, { text: "Done." }],
  [{ tool: "project_read" }, edit("Retitle the title", { op: "update_item", item: "t1", set: { text: "Shipped" } }), { sleep: 9000 }, { text: "Done." }],
  [
    { tool: "project_read" },
    { sleep: 800 },
    edit("Trim the end of clip 1", { op: "trim_item", item: "c1", edge: "end", frames: 5 }),
    { sleep: 4000 },
    { text: "Done." },
  ],
];

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-d348-")));
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=30",
    "-t",
    "12",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    join(root, "Shot.mp4"),
  ]);
  const dir = join(root, "Cursors.uncut");
  mkdirSync(dir);
  const media = [
    { id: "m-shot", kind: "video", name: "Shot.mp4", path: join(root, "Shot.mp4"), probe: { frames: 360, fps: 30, width: 640, height: 360, hasAudio: false } },
  ];
  const tracks = [
    { id: "text", kind: "text", name: "Text", items: [title] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [clip("c1", 0), clip("c2", 120), clip("c3", 240)] },
  ];
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({ format: "uncut/0", name: "Cursors", canvas: { width: 1920, height: 1080, fps: 30 }, textLooks: 1, media, tracks }),
  );
  writeFileSync(join(root, "plan.json"), JSON.stringify(plan));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const sendMessage = async (page: Page, words: string) => {
  await page.waitForSelector("[data-testid=agent-input]:not([disabled])", { timeout: 15000 });
  await page.click("[data-testid=agent-input]");
  await page.keyboard.type(words);
  await page.keyboard.press("Enter");
};

const cursorSel = (agent: string) => `[data-testid=agent-cursor][data-agent="${agent}"]`;

/** The cursor's tip (its translate) and the label on its pill. */
const cursorAt = (page: Page, agent: string) =>
  page.$eval(cursorSel(agent), (el) => {
    const m = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec((el as HTMLElement).style.transform);
    return {
      x: Number(m?.[1]),
      y: Number(m?.[2]),
      label: el.querySelector("[data-testid=agent-cursor-label]")?.textContent ?? "",
      state: (el as HTMLElement).dataset.state,
    };
  });
const rectOf = (page: Page, selector: string) =>
  page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });

test("the agent's cursor follows a turn: the clip's edge, the ruler, a child for the subagent, gone at the end", { skip, timeout: 240000 }, async () => {
  app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([join(root, "Cursors.uncut")]),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: join(root, "plan.json"),
    },
  });
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click("[data-testid=tab-agent]");
  assert.equal(await page.$("[data-testid=agent-cursor]"), null, "no cursor while the agent is idle");

  await sendMessage(page, "Trim clip 2, check the start, find the best take");
  await page.waitForSelector(`${cursorSel("ag-main")}[data-target=item][data-item=c2][data-at=end]`, { timeout: 20000 });
  await wait(700);
  const onClip = await cursorAt(page, "ag-main");
  const c2 = await rectOf(page, "[data-testid=timeline-item][data-item=c2]");
  assert.match(onClip.label, /Trim the end of clip 2/);
  assert.ok(Math.abs(onClip.x - c2.right) <= 8, `at clip 2's end edge: x ${onClip.x}, edge ${c2.right}`);
  assert.ok(onClip.y >= c2.top && onClip.y <= c2.bottom, `on clip 2's lane: y ${onClip.y} in ${c2.top}-${c2.bottom}`);
  assert.equal(await page.$eval(`${cursorSel("ag-main")} [data-testid=agent-cursor-pill]`, (el) => getComputedStyle(el).cursor), "pointer");
  assert.equal(await page.$eval(cursorSel("ag-main"), (el) => getComputedStyle(el).pointerEvents), "none");
  await page.screenshot({ path: out("cursor-on-clip") });

  await page.waitForSelector(`${cursorSel("ag-main")}[data-target=time][data-frame="30"]`, { timeout: 15000 });
  await wait(700);
  const onRuler = await cursorAt(page, "ag-main");
  const ruler = await rectOf(page, "[data-testid=ruler]");
  const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
  assert.ok(Math.abs(onRuler.x - (ruler.left + 30 * ppf)) <= 4, `at frame 30 on the ruler: x ${onRuler.x}`);
  assert.ok(onRuler.y >= ruler.top && onRuler.y <= ruler.bottom, `on the ruler: y ${onRuler.y}`);

  await page.waitForSelector("[data-testid=agent-cursor-child][data-child=tu-task]", { timeout: 15000 });
  await wait(900);
  assert.equal(await page.$eval("[data-testid=agent-cursor-child] .agent-cursor-label", (el) => el.textContent), "Find the best take");
  await page.screenshot({ path: out("child-cursor") });
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-cursor-child]"), { timeout: 15000 });

  await page.waitForSelector("[data-testid=agent-turn][data-status=done]", { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-cursor]"), { timeout: 5000 });
});

test("two agents at once: one cursor each, in its own colour, named", { skip, timeout: 180000 }, async () => {
  const { page } = app!;
  await page.click("[data-testid=agent-add]");
  await page.waitForSelector("[data-testid=agent-add-name]", { timeout: 5000 });
  await page.click("[data-testid=agent-add-name]");
  await page.keyboard.type("Graphics");
  await page.click("[data-testid=agent-add-focus-graphics]");
  await page.click("[data-testid=agent-add-create]");
  const other = "[data-testid=agent-tabs] [data-testid^=agent-tab-ag-]:not([data-testid=agent-tab-ag-main])";
  await page.waitForSelector(other, { timeout: 10000 });
  const graphics = await page.$eval(other, (el) => el.getAttribute("data-testid")!.replace("agent-tab-", ""));

  await page.click("[data-testid=agent-tab-ag-main]");
  await sendMessage(page, "Trim the start of clip 1");
  await page.click(`[data-testid=agent-tab-${graphics}]`);
  await sendMessage(page, "Retitle the title");
  await page.waitForSelector(`${cursorSel("ag-main")}[data-item=c1]`, { timeout: 20000 });
  await page.waitForSelector(`${cursorSel(graphics)}[data-item=t1]`, { timeout: 20000 });
  await wait(800);
  const [editor, other2] = [await cursorAt(page, "ag-main"), await cursorAt(page, graphics)];
  assert.match(editor.label, /Trim the start of clip 1/);
  assert.match(other2.label, /Retitle the title/);
  const names = await page.$$eval("[data-testid=agent-cursor-pill] b", (els) => els.map((el) => el.textContent));
  assert.deepEqual(names.sort(), ["Editor", "Graphics"].sort(), "each pill names its agent once there are two");
  const colours = await page.$$eval("[data-testid=agent-cursor] .agent-cursor-arrow path", (els) => els.map((el) => getComputedStyle(el).fill));
  assert.notEqual(colours[0], colours[1], "each in its own colour");
  await page.screenshot({ path: out("two-agents") });
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-cursor]"), { timeout: 30000 });
});

test("reduced motion: the cursor jumps to its target", { skip, timeout: 120000 }, async () => {
  const { page } = app!;
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.click("[data-testid=agent-tab-ag-main]");
  await sendMessage(page, "Trim the end of clip 1");
  await page.waitForSelector(`${cursorSel("ag-main")}[data-item=c1][data-at=end]`, { timeout: 20000 });
  await wait(80);
  const at = await cursorAt(page, "ag-main");
  const c1 = await rectOf(page, "[data-testid=timeline-item][data-item=c1]");
  assert.ok(Math.abs(at.x - c1.right) <= 8, `already at clip 1's end edge after one frame: x ${at.x}, edge ${c1.right}`);
  await page.screenshot({ path: out("reduced-motion") });
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-cursor]"), { timeout: 20000 });
});
