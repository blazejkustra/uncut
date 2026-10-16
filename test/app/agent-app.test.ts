// Phase 4 chunk 2 on the packaged app: the Agent tab. A scripted stand-in for claude
// (helpers/fake-claude.ts) drives the real MCP server shipped in the app, started on the app's
// own runtime, so this runs the whole path without a subscription. An empty project gets a
// title from the agent (live on the timeline and in the preview), a manual edit shows up as the
// note on the next turn, Undo turn takes back exactly one turn, Stop cancels, and without Claude
// Code the tab shows how to install it; the composer's @mentions, Add to chat, live view and work
// log (D139-D142). Screenshots: test-output/agent-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

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
  await waitForWelcome(page);
  await page.click("[data-testid=new-project]");
  await waitFor(page, "[data-testid=new-project-form]");
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
  await page.click("[data-testid=create]");
  await waitFor(page, "[data-testid=editor]");
  return page.$eval("[data-testid=project-title]", (el) => (el as HTMLElement).title);
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-app-")));
  mkdirSync(join(root, "projects"));
  mkdirSync(join(root, "projects-bare"));
  mkdirSync(join(root, "projects-ui"));
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
      OPENAI_API_KEY: "sk-openai-test",
      AWS_SECRET_ACCESS_KEY: "aws-test",
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

  // An empty project's Agent tab asks one question naming the project; no prefilled prompts.
  await page.click("[data-testid=tab-agent]");
  await waitFor(page, "[data-testid=agent-empty]");
  assert.match(await text(page, "[data-testid=agent-empty]"), /What should we make in .+\?No media needed to start/);
  assert.equal(await page.$("[data-testid=agent-example]"), null);
  // Claude Code (the stand-in) is found and signed in, so there's no setup card.
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.$("[data-testid=agent-setup]"), null);
  await page.screenshot({ path: "test-output/agent-empty.png" });

  // Turn 1: a typed prompt; the fake reads the timeline and adds a 5 s title through MCP.
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
  await page.click("[data-testid=agent-input]");
  await page.keyboard.type("Make a 5 s title card that says “Kraków from above”");
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
  // Names, not ids (AG5): the edit line says the title's words, not "title-1".
  assert.match(await text(page, `${first} [data-testid=agent-edits]`), /1 edit.*Add a 5 s title card.*Added text Kraków from above on track text/);
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
  const note = await text(page, `${second} [data-testid=agent-note]`);
  assert.match(note, /Told the agent about 2 changes you made by hand.*Added text track "Text 2".*Added text /);
  assert.doesNotMatch(note, /\(text-1\)|lower-third-1/, "ids stay in the prompt, not on screen");
  const prompts = readFileSync(promptLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(prompts[1].prompt.split("\n\n<brand>")[0], "add an end card\nthat thanks people");
  assert.match(prompts[1].prompt, /by hand/);
  assert.equal(prompts[1].resume, "fake-session");
  // D277: Claude Code's own sign-in reaches claude in the packaged app too; a generator key and cloud keys without Bedrock don't.
  assert.ok(prompts[0].env.includes("ANTHROPIC_API_KEY"), "D277: the API key reaches claude");
  for (const k of ["OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY"]) assert.ok(!prompts[0].env.includes(k), `${k} reached claude`);
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
  // One turn at a time: the button is Stop, and a message written now waits for the turn to end.
  assert.equal(await page.$("[data-testid=agent-send]"), null);
  await waitFor(page, "[data-testid=agent-stop]");
  nextTurn([{ text: "Queued one done." }]);
  await page.type("[data-testid=agent-input]", "then say hi");
  await page.keyboard.press("Enter");
  await waitFor(page, "[data-testid=agent-queued]");
  assert.match(await text(page, "[data-testid=agent-queued]"), /Queued: then say hi/);
  assert.equal(await turnCount(page), 3, "not sent yet");
  await page.screenshot({ path: "test-output/agent-queued.png" });
  // Stop (the composer's button): the turn is interrupted, the same claude stays for the queued message.
  await page.click("[data-testid=agent-stop]");
  await waitFor(page, `${third}[data-status=cancelled]`, 10000);
  assert.equal(await text(page, `${third} .turn-status`), "Stopped");
  await page.waitForFunction(() => document.querySelectorAll<HTMLElement>("[data-testid=agent-turn]")[3]?.dataset.status === "done", { timeout: 20000 });
  assert.equal(await page.$("[data-testid=agent-queued]"), null);
  const runs = readFileSync(promptLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.match(runs.at(-1).prompt, /^then say hi/);
  assert.equal(new Set(runs.map((r: { pid: number }) => r.pid)).size, 1, "four messages, one claude process (D139)");
  await page.screenshot({ path: "test-output/agent-stopped.png" });

  // D295: New chat (the strip above the thread): the earlier turns fold behind one line, the next
  // message starts a fresh claude conversation, and the line opens the earlier chat again.
  await page.click("[data-testid=agent-new-chat]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=agent-turn]").length === 0, { timeout: 10000 });
  assert.equal(await text(page, "[data-testid=agent-earlier]"), "Earlier chat, 4 turns");
  assert.equal(await page.$eval("[data-testid=agent-new-chat]", (b) => (b as HTMLButtonElement).disabled), true, "an empty chat needs no new one");
  nextTurn([{ text: "Fresh start." }]);
  await page.click("[data-testid=agent-input]");
  await page.type("[data-testid=agent-input]", "start over");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll<HTMLElement>("[data-testid=agent-turn]")[0]?.dataset.status === "done", { timeout: 20000 });
  assert.equal(await turnCount(page), 1);
  const fresh = readFileSync(promptLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.match(fresh.prompt, /^start over/);
  assert.equal(fresh.resume, null, "a fresh conversation");
  await page.screenshot({ path: "test-output/agent-new-chat.png" });
  await page.click("[data-testid=agent-earlier]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=agent-turn]").length === 5);
  await waitFor(page, "[data-testid=agent-thread-divider]");
  await page.screenshot({ path: "test-output/agent-earlier-chat.png" });
  assert.deepEqual(app.errors, []);
}

test("ui_show opens a panel and offers a jump (never moving the playhead or selecting), once per request (D65, D235)", { skip, timeout: 120000 }, async () => {
  const app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data-ui"),
      UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects-ui")]),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: plan(),
      FAKE_PROMPT_LOG: promptLog(),
    },
  });
  apps.add(app);
  const { page } = app;
  await newProject(app);
  await page.click("[data-testid=tab-agent]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"));
  const textItem = (id: string, start: number, duration: number, words: string) => ({ id, type: "text", start, duration, text: words, transform: { x: 154, y: 410 }, style: { preset: "text.title", size: 130, weight: 700 } });
  // A turn adds two text items, then points at the second one: frame 200, selected, Inspector open.
  nextTurn([
    { tool: "project_read" },
    { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Add a title and an end card", ops: [{ op: "insert_item", track: "text", item: textItem("title-1", 0, 150, "Hello") }, { op: "insert_item", track: "text", item: textItem("end-1", 150, 90, "Bye") }] } },
    { tool: "ui_show", args: { frame: 200, select: ["end-1"], panel: "inspector" } },
  ]);
  await page.click("[data-testid=agent-input]");
  await page.type("[data-testid=agent-input]", "add a title and an end card, then show me the end card");
  await page.keyboard.press("Enter");
  // The side switched to the Inspector; the playhead and the selection stay with the user (D235):
  // the frame and the item become the pill, whose click jumps there and selects it.
  await waitFor(page, "[data-testid=agent-change]", 30000);
  assert.equal(await page.$eval("[data-testid=tab-inspector]", (el) => el.classList.contains("active")), true);
  assert.match(await text(page, "[data-testid=timecode]"), /^00:00:00:00/, "the agent didn't move the playhead");
  assert.equal(await page.$('[data-testid=timeline-item][data-item="end-1"].selected'), null, "nor select");
  assert.equal(await text(page, "[data-testid=agent-change-jump]"), "Agent changed 0:06–0:08");
  await page.click("[data-testid=agent-change-jump]");
  await waitFor(page, '[data-testid=inspector-item][data-item="end-1"]');
  await page.waitForFunction(() => document.querySelector("[data-testid=timecode]")!.textContent!.startsWith("00:00:06:20"));
  assert.equal(await text(page, "[data-testid=timecode]"), "00:00:06:20 / 00:00:08:00");
  assert.equal(await page.$eval('[data-testid=timeline-item][data-item="end-1"]', (el) => el.classList.contains("selected")), true);
  await page.screenshot({ path: "test-output/agent-ui-show.png" });

  // Applied once: the user moves on (Home, the Agent tab), and the next turn (which publishes the
  // agent state again, still carrying that request) doesn't move them back.
  await page.click("[data-testid=tab-agent]");
  await page.waitForFunction(() => document.querySelectorAll<HTMLElement>("[data-testid=agent-turn]")[0]?.dataset.status === "done", { timeout: 30000 });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.querySelector("[data-testid=timecode]")!.textContent!.startsWith("00:00:00:00"));
  nextTurn([{ tool: "project_read" }, { text: "Nothing to change." }]);
  await page.click("[data-testid=agent-input]");
  await page.type("[data-testid=agent-input]", "anything else?");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll<HTMLElement>("[data-testid=agent-turn]")[1]?.dataset.status === "done", { timeout: 30000 });
  assert.equal(await page.$eval("[data-testid=tab-agent]", (el) => el.classList.contains("active")), true, "still on the Agent tab");
  assert.match(await text(page, "[data-testid=timecode]"), /^00:00:00:00/, "the playhead stayed where the user put it");
  assert.equal(await page.$('[data-testid=timeline-item][data-item="end-1"].selected'), null, "and nothing was selected again");
  assert.equal(await page.$("[data-testid=agent-change]"), null, "no pill again for the old request");

  // A request for a library panel opens that tab of the rail.
  nextTurn([{ tool: "ui_show", args: { panel: "text" } }]);
  await page.click("[data-testid=agent-input]");
  await page.type("[data-testid=agent-input]", "where are the text styles?");
  await page.keyboard.press("Enter");
  await waitFor(page, "[data-testid=text-library]", 30000);
  assert.equal(await page.$eval("[data-testid=rail-text]", (el) => el.classList.contains("active")), true);
  assert.deepEqual(app.errors, []);
});

test("the composer (D140-D142): @ picks media, Add to chat from the timeline, the canvas and the Inspector, live thinking and text, a work log, a now line, ↑ history, and no m- id on screen", { skip, timeout: 180000 }, async () => {
  const media = join(root, "media");
  mkdirSync(media, { recursive: true });
  const clip = (name: string, colour: string) => execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=320x180:r=30:d=4`, "-c:v", "libx264", "-pix_fmt", "yuv420p", join(media, name)]);
  clip("DJI_0005.mp4", "teal");
  clip("Harbour.mp4", "navy");
  const probe = { frames: 120, fps: 30, width: 320, height: 180, hasAudio: false };
  const dir = join(root, "Composer.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Composer",
      canvas: { width: 1920, height: 1080, fps: 30 },
      media: [
        { id: "m-dji-0005", kind: "video", name: "DJI_0005.mp4", path: join(media, "DJI_0005.mp4"), probe },
        { id: "m-harbour", kind: "video", name: "Harbour.mp4", path: join(media, "Harbour.mp4"), probe },
      ],
      tracks: [
        { id: "text", kind: "text", name: "Text", items: [{ id: "title-1", type: "text", start: 0, duration: 60, text: "Split from above", transform: { x: 154, y: 410 }, style: { preset: "text.title", size: 130, weight: 700 } }] },
        { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-dji-0005", in: 0, duration: 120 }, { id: "clip-2", type: "clip", media: "m-harbour", in: 0, duration: 120 }] },
      ],
    }),
  );
  const log = join(root, "composer-prompts.jsonl");
  const composerPlan = join(root, "composer-plan.json");
  writeFileSync(log, "");
  const gate = join(root, "composer-gate.json");
  writeFileSync(
    composerPlan,
    JSON.stringify([
      [
        { think: "The user points at DJI_0005 and the harbour clip. I'll read the timeline, check the title, then answer briefly." },
        { tool: "project_read" },
        { tool: "ui_show", args: { select: ["clip-2"] } },
        { tool: "ui_show", args: { frame: 30 } },
        { text: "I looked at m-dji-0005 and clip-2: the harbour shot is the calmer one, so it should open the video.", slow: 1500 },
        { await: gate },
      ],
    ]),
  );
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data-composer"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: FAKE, FAKE_PLAN: composerPlan, FAKE_PROMPT_LOG: log } });
  apps.add(app);
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor(page, '[data-testid=timeline-item][data-item="clip-2"]');
  await page.click("[data-testid=tab-agent]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"));
  const value = () => page.$eval("[data-testid=agent-input]", (el) => (el as HTMLTextAreaElement).value);

  // AG2: @ opens the picker (names, not ids); Enter inserts the chip.
  await page.click("[data-testid=agent-input]");
  await page.type("[data-testid=agent-input]", "compare @dji");
  await waitFor(page, "[data-testid=mention-picker]");
  const options = await page.$$eval("[data-testid=mention-option]", (els) => els.map((e) => [(e as HTMLElement).dataset.kind, e.textContent]));
  assert.deepEqual(options.map((o) => o[0]), ["media", "item"], "the media and its clip");
  assert.ok(options.every((o) => /DJI_0005\.mp4/.test(o[1]!) && !/m-dji/.test(o[1]!)));
  await page.screenshot({ path: "test-output/agent-mention.png" });
  await page.keyboard.press("Enter");
  assert.equal(await value(), "compare @DJI_0005.mp4 ");
  assert.equal(await page.$("[data-testid=mention-picker]"), null);
  await page.type("[data-testid=agent-input]", "with ");

  // AG3: right-click a timeline clip → Add to chat.
  await page.click('[data-testid=timeline-item][data-item="clip-2"]', { button: "right" });
  await waitFor(page, "[data-testid=menu-add-to-chat]");
  await page.click("[data-testid=menu-add-to-chat]");
  await page.waitForFunction(() => (document.querySelector("[data-testid=agent-input]") as HTMLTextAreaElement).value.endsWith("@Harbour.mp4 "));
  // ...right-click the title on the canvas → Add to chat (with the frame it was picked at).
  await waitFor(page, '.pv-text[data-item="title-1"]');
  await page.click('.pv-text[data-item="title-1"]', { button: "right" });
  await waitFor(page, "[data-testid=menu-add-to-chat]");
  await page.click("[data-testid=menu-add-to-chat]");
  await page.waitForFunction(() => (document.querySelector("[data-testid=agent-input]") as HTMLTextAreaElement).value.endsWith("@Split from above "));
  assert.equal(await page.$eval("[data-testid=tab-agent]", (el) => el.classList.contains("active")), true, "the Agent tab opened");
  // ...and the Inspector's button: the Agent tab opens with the chip added.
  await page.click("[data-testid=tab-inspector]");
  await waitFor(page, '[data-testid=inspector-item][data-item="title-1"]');
  await page.click("[data-testid=insp-add-to-chat]");
  await page.waitForFunction(() => document.querySelector("[data-testid=tab-agent]")!.classList.contains("active"));
  assert.equal(await value(), "compare @DJI_0005.mp4 with @Harbour.mp4 @Split from above @Split from above ");
  // One Backspace takes a chip off whole.
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  assert.equal(await value(), "compare @DJI_0005.mp4 with @Harbour.mp4 @Split from above ");
  await page.screenshot({ path: "test-output/agent-chips.png" });

  // AG4: send; thinking and text stream in, steps fold into a work log, a line says what's happening.
  await page.keyboard.press("Enter");
  await waitFor(page, '[data-testid=agent-reply][data-live="true"]', 20000);
  await waitFor(page, "[data-testid=agent-thinking]");
  await waitFor(page, "[data-testid=agent-worklog]");
  assert.match(await text(page, "[data-testid=agent-now]"), /Writing reply…/);
  await page.screenshot({ path: "test-output/agent-live.png" });
  writeFileSync(gate, "[]");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=agent-turn]")?.dataset.status === "done", { timeout: 30000 });
  assert.equal(await page.$("[data-testid=agent-now]"), null);
  assert.equal(await page.$eval("[data-testid=agent-worklog]", (el) => (el as HTMLElement).dataset.count), "3");
  assert.match(await text(page, "[data-testid=agent-worklog-toggle]"), /, and 2 more/);
  await page.click("[data-testid=agent-worklog-toggle]");
  await waitFor(page, ".worklog-steps [data-testid=agent-step]");
  assert.deepEqual(await page.$$eval(".worklog-steps [data-testid=agent-step]", (els) => els.map((e) => e.textContent)), ["Read the timeline", "Pointed at Harbour.mp4", "Pointed at frame 30"]);
  // The card's prompt shows the chips; claude got the labels plus a <context> block with real ids.
  assert.equal((await page.$$("[data-testid=agent-prompt] [data-testid=agent-chip]")).length, 3);
  const sent = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]!).prompt as string;
  assert.match(sent, /^compare @DJI_0005\.mp4 with @Harbour\.mp4 @Split from above\n\n<context>\n/);
  assert.match(sent, /@DJI_0005\.mp4 = media m-dji-0005 \(video/);
  assert.match(sent, /@Harbour\.mp4 = item clip-2 \(clip on track main.*\), frames 120–240/);
  assert.match(sent, /@Split from above = item title-1 \(text on track text.*\), frames 0–60 \(0\.00 s–2\.00 s\), picked at frame 0/);
  // AG5: nothing in the Agent tab says "m-…" (the reply named m-dji-0005; it reads DJI_0005.mp4).
  const panel = await page.$eval("[data-testid=agent-panel]", (el) => (el as HTMLElement).innerText);
  assert.doesNotMatch(panel, /\bm-[a-z0-9]/);
  assert.match(panel, /I looked at DJI_0005\.mp4 and Harbour\.mp4/);
  await page.click("[data-testid=agent-thinking] .thinking-head");
  await page.screenshot({ path: "test-output/agent-worklog.png" });

  // ↑ in the empty box brings the last prompt back, with its chips.
  await page.click("[data-testid=agent-input]");
  await page.keyboard.press("ArrowUp");
  assert.equal(await value(), "compare @DJI_0005.mp4 with @Harbour.mp4 @Split from above");
  assert.deepEqual(app.errors, []);
});

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
  await page.screenshot({ path: "test-output/agent-missing.png" });
  assert.deepEqual(app.errors, []);
});
