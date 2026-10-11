// Spike B in the app: the agent edits live through MCP, sees the user's manual edits,
// can't overwrite them (D6), and a whole turn can be undone (D7). A scripted stand-in for
// `claude` drives the real MCP server, so these run without using a subscription.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchEditor } from "./helpers/electron.mjs";

const DEMO = "fixtures/drone-demo.uncut/project.json";
const skip = !existsSync(DEMO) && "needs fixtures/drone-demo.uncut (node spikes/editor/make-demo.mjs)";
const dir = resolve("test-output/agent-ui.uncut");
const plan = resolve("test-output/fake-plan.json");
const prompts = resolve("test-output/fake-prompts.jsonl");
let app, page;

const onDisk = () => JSON.parse(readFileSync(`${dir}/project.json`, "utf8"));
const item = (p, id) => p.tracks.flatMap((t) => t.items).find((i) => i.id === id);
const lastTurn = () => page.evaluate(() => window.__uncut.turns.at(-1));

async function ask(text) {
  const before = await page.evaluate(() => window.__uncut.turns.length);
  await page.click('[data-side="agent"]');
  await page.waitForSelector("#agent-input");
  await page.type("#agent-input", text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => window.__uncut.turns.length > n && window.__uncut.turns.at(-1).status !== "working", { timeout: 60000 }, before);
  return lastTurn();
}

before(async () => {
  if (skip) return;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/project.json`, readFileSync(DEMO));
  for (const f of [prompts, `${plan}.turn`]) rmSync(f, { force: true });
  writeFileSync(plan, JSON.stringify([
    // Turn 1: look, shorten the bench shot, look again.
    [{ tool: "project_read" }, { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Shorten the bench shot", ops: [{ op: "trim_item", item: "bench", edge: "end", frames: 120 }] } }, { tool: "render_frames", args: { frames: [10] } }],
    // Turn 2: reads, then tries to edit the orbit shot with a stale revision after the user trimmed it.
    [{ tool: "project_read" }, { tool: "timeline_edit", args: { baseRevision: 0, summary: "Trim the orbit", ops: [{ op: "trim_item", item: "orbit", edge: "end", frames: 30 }] } }],
  ]));
  app = await launchEditor({ project: dir, env: { UNCUT_CLAUDE: resolve("test/helpers/fake-claude.mjs"), FAKE_PLAN: plan, FAKE_PROMPT_LOG: prompts } });
  page = app.page;
});
after(async () => app?.close());

test("an agent turn edits live, is saved, and shows its steps", { skip }, async () => {
  const t = await ask("Make the ending shorter");
  assert.equal(t.status, "done", t.result);
  assert.deepEqual(t.steps.map((s) => [s.label, s.done, !!s.isError]), [
    ["Read the timeline", true, false],
    ["Shorten the bench shot", true, false],
    ["Looked at frame 10", true, false],
  ]);
  assert.equal(t.edits, 1);
  assert.equal(await page.evaluate(() => window.__uncut.duration), 2100 - 120, "the window shows the edit");
  assert.equal(item(onDisk(), "bench").duration, 180, "the edit is saved");
  assert.ok(await page.$('[data-undo-turn]'), "the turn can be undone");
});

test("D6: the agent is told about edits made by hand, and can't overwrite them", { skip }, async () => {
  // The user trims the orbit shot by hand.
  await page.click('[data-side="inspector"]');
  const edge = await (await page.$('.clip[data-item="orbit"] .edge.r')).boundingBox();
  const ppf = await page.evaluate(() => document.querySelector('.clip[data-item="orbit"]').offsetWidth / 420);
  const y = edge.y + edge.height * 0.75;
  await page.mouse.move(edge.x + 3, y);
  await page.mouse.down();
  await page.mouse.move(edge.x + 3 - 60 * ppf, y, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__uncut.project.tracks.find((t) => t.role === "main").items.find((i) => i.id === "orbit").duration < 400);
  const orbit = item(onDisk(), "orbit").duration;

  const t = await ask("Tighten the orbit too");
  const sent = readFileSync(prompts, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.match(sent[1].prompt, /by hand/, "the prompt carries the manual-edits note");
  assert.match(sent[1].prompt, /orbit/);
  assert.doesNotMatch(sent[0].prompt, /by hand/, "no note when nothing was done by hand");
  assert.equal(sent[1].resume, true, "the second turn continues the same conversation");
  assert.ok(t.note, "the turn card shows the note");
  const refused = t.steps.find((s) => s.label === "Trim the orbit");
  assert.equal(refused.isError, true, "the stale edit is refused");
  assert.equal(item(onDisk(), "orbit").duration, orbit, "the user's trim stands");
});

test("D7: undoing the agent's turn removes its edit and keeps the user's", { skip }, async () => {
  const orbit = item(onDisk(), "orbit").duration;
  await page.click('[data-side="agent"]');
  const first = await page.evaluate(() => window.__uncut.turns[0].id);
  await page.click(`[data-undo-turn="${first}"]`);
  await page.waitForFunction(() => window.__uncut.turns[0].status === "undone");
  const p = onDisk();
  assert.equal(item(p, "bench").duration, 300, "the agent's trim is gone");
  assert.equal(item(p, "orbit").duration, orbit, "the user's later trim is kept");
  assert.equal(await page.evaluate(() => window.__uncut.duration), 2100 - (420 - orbit));
  await page.screenshot({ path: "test-output/agent-ui.png" });
  assert.deepEqual(app.errors, []);
});
