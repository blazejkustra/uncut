// Phase 4 chunk 2 on the bundled server, with a scripted stand-in for claude (helpers/fake-claude.ts)
// that drives the real MCP server (dist/mcp.mjs) over the real bridge. Covers D40 (turns, live edits
// through the same engine), D41 (no API key or parent-session variables reach claude), D6 (manual-edit
// note, refusal of stale edits), D7 (undo a turn as one step; refused when later edits build on it),
// Stop (an interrupt, D139), history across reopen, missing Claude Code, and the bridge's session token.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { readAgentHistory } from "../helpers/history.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(BUNDLE) && existsSync(MCP) && existsSync(MEDIA) ? false : "server bundle or media core not built (run pnpm build)";

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let server: Server;
let client: Client;
let agent: ReturnType<Client["subscribe"]>;
let dir = "";
const plan = () => join(root, "plan.json");
const log = () => join(root, "prompts.jsonl");
const sent = (): Array<{ prompt: string; resume: string | null; env: Array<string>; pid: number; mcpPid: number; mcpToken: string; tools: string; allowed: string }> =>
  readFileSync(log(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const latest = () => agent.values.at(-1);
const turnById = (id: string) => latest()?.turns.find((t: { id: string }) => t.id === id);
const items = (project: any) => project.tracks.flatMap((t: any) => t.items);
const item = (project: any, id: string) => items(project).find((i: any) => i.id === id);
const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Write the steps for the next turn (the fake plays turn n of the plan, n counting from 0). */
const turns: Array<unknown> = [];
const nextTurn = (steps: Array<unknown>) => {
  turns.push(steps);
  writeFileSync(plan(), JSON.stringify(turns));
};
async function ask(prompt: string, extra: Record<string, unknown> = {}) {
  const { turnId } = await client.ok("agent.send", { prompt, ...extra });
  await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 30000);
  return turnById(turnId);
}

const title = { id: "title-1", type: "text", start: 0, duration: 150, text: "Kraków from above", transform: { x: 154, y: 410 }, style: { preset: "text.title", size: 130, weight: 700 } };

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-")));
  mkdirSync(join(root, "projects"));
  writeFileSync(log(), "");
  server = await startServer({
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: plan(),
      FAKE_PROMPT_LOG: log(),
      // D41: none of these may reach claude but CLAUDE_CODE_OAUTH_TOKEN (D219). (This test usually
      // runs under Claude Code, which sets CLAUDECODE and CLAUDE_CODE_* already; set them anyway.)
      ANTHROPIC_API_KEY: "sk-ant-test-not-a-key",
      ANTHROPIC_AUTH_TOKEN: "test-token",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_OAUTH_TOKEN: "test-oauth",
    },
  });
  client = await connect(server.ready.port, server.ready.token);
  agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Empty" });
  dir = snap.dir;
  await agent.until((s) => s?.dir === dir);
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("an empty project: a turn adds a title through MCP, live and saved, and the card lists the edit", { skip, timeout: 60000 }, async () => {
  assert.deepEqual(latest().turns, [], "a new project has no turns");
  const project = client.subscribe("project.subscribe");
  nextTurn([
    { tool: "project_read" },
    { tool: "modules_list", args: { kind: "text-style" } },
    { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Add a 5 s title card", ops: [{ op: "insert_item", track: "text", item: title }] } },
  ]);
  const t = await ask("make a 5 s title card that says Kraków from above", { frame: 0 });
  assert.equal(t.status, "done", t.error);
  assert.deepEqual(
    t.items.map((i: any) => [i.kind, i.text, i.status ?? null]),
    [
      ["step", "Read the timeline", "done"],
      ["step", "Checked the text-style modules", "done"],
      ["step", "Add a 5 s title card", "done"],
      ["text", "Done: 3 steps.", null],
    ],
  );
  assert.equal(t.edits.length, 1);
  assert.equal(t.edits[0].summary, "Add a 5 s title card");
  assert.deepEqual(t.edits[0].lines, ["Added text title-1 on track text"]);
  assert.deepEqual(t.undo, { state: "available" });
  assert.equal(t.note, undefined, "nothing was done by hand");
  // Live: the project stream carried the edit; saved: it's in project.json.
  await project.until((s) => s && item(s.project, "title-1"));
  assert.deepEqual(item(onDisk(), "title-1"), title);
  const [first] = sent();
  assert.equal(first!.resume, null, "the first turn starts a conversation");
  assert.equal(first!.tools, "default", "D194: claude gets its built-in tools");
  assert.equal(first!.allowed, "mcp__uncut");
  assert.match(first!.prompt, /^make a 5 s title card that says Kraków from above\n\n<brand>\nNo brand kit is chosen for this project\. The user has no kits yet\.\nNo skills are on for this project\. Uncut's: builtin-[^\n]*\n<\/brand>\n\n<editor-context>\nPlayhead: frame 0/);
  // Saves are queued; give the last one a moment to land.
  const saved = () => readAgentHistory(dir);
  for (let i = 0; i < 50 && saved().turns[0]?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 50));
  const history = saved();
  assert.equal(history.sessionId, "fake-session");
  assert.equal(history.turns[0].edits[0].summary, "Add a 5 s title card");
});

test("D41: claude runs without API keys or a parent Claude Code session's variables", { skip }, () => {
  const env = sent()[0]!.env;
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE"]) assert.ok(!env.includes(name), `${name} reached claude`);
  // Only Uncut's own switches (D181), never one from outside (CLAUDE_CODE_ENTRYPOINT), but the
  // user's setup-token login, CLAUDE_CODE_OAUTH_TOKEN (D219: their subscription, as t3code passes it).
  assert.deepEqual(env.filter((k) => k.startsWith("CLAUDE_CODE_")).sort(), ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CODE_DISABLE_CLAUDE_MDS", "CLAUDE_CODE_OAUTH_TOKEN"], "CLAUDE_CODE_* from outside reached claude");
  assert.ok(env.includes("HOME") && env.includes("FAKE_PLAN"), "the rest of the environment is passed on");
  assert.ok(!env.includes("UNCUT_TOKEN") && !env.includes("ELECTRON_RUN_AS_NODE"));
});

let secondTurn = "";
test("D6: a manual edit is in the next prompt, and the agent's stale edit to it is refused", { skip, timeout: 60000 }, async () => {
  const before = await client.ok("project.get");
  const agentRevision = latest().turns[0].edits[0].revision;
  // The user rewords the title by hand.
  await client.ok("project.edit", { ops: [{ op: "update_item", item: "title-1", set: { text: "Kraków, from above" } }] });
  nextTurn([
    // Planned against the revision before the user's edit: refused.
    { tool: "timeline_edit", args: { baseRevision: agentRevision, summary: "Make the title bigger", ops: [{ op: "update_item", item: "title-1", set: { text: "KRAKÓW FROM ABOVE" } }] } },
    { tool: "project_read" },
    { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Add an end card", ops: [{ op: "insert_item", track: "text", item: { ...title, id: "end-1", start: 150, duration: 90, text: "Thanks for watching" } }] } },
  ]);
  const t = await ask("add an end card");
  secondTurn = t.id;
  assert.equal(t.status, "done", t.error);
  const prompt = sent()[1]!;
  assert.match(prompt.prompt, /made 1 edit by hand/);
  assert.match(prompt.prompt, /Changed the text of title-1 to "Kraków, from above"/);
  assert.match(prompt.prompt, /intentional/);
  assert.equal(prompt.resume, "fake-session", "the second turn continues the conversation");
  assert.match(t.note, /by hand/, "the card shows the note");
  assert.deepEqual(t.items.filter((i: any) => i.kind === "step").map((i: any) => [i.text, i.status]), [
    ["Make the title bigger", "error"],
    ["Read the timeline", "done"],
    ["Add an end card", "done"],
  ]);
  assert.deepEqual(t.edits.map((e: any) => e.summary), ["Add an end card"], "only the applied edit is listed");
  const now = onDisk();
  assert.equal(item(now, "title-1").text, "Kraków, from above", "the user's edit stands");
  assert.equal(item(now, "end-1").text, "Thanks for watching");
  assert.ok(before.revision < (await client.ok("project.get")).revision);
});

test("D7: Undo turn reverts exactly that turn, as one undoable step; a turn later edits build on can't be undone", { skip, timeout: 30000 }, async () => {
  const undone = await client.ok("agent.undoTurn", { turnId: secondTurn });
  assert.equal(item(undone.project, "end-1"), undefined, "the turn's edit is gone");
  assert.equal(item(undone.project, "title-1").text, "Kraków, from above", "the user's earlier edit stays");
  assert.equal(item(onDisk(), "end-1"), undefined);
  await agent.until(() => turnById(secondTurn)?.undo.state === "undone");
  // ⌘Z brings the turn back in one step, ⇧⌘Z undoes it again.
  assert.ok(item((await client.ok("project.undo")).project, "end-1"));
  await agent.until(() => turnById(secondTurn)?.undo.state === "available");
  assert.equal(item((await client.ok("project.redo")).project, "end-1"), undefined);

  // The first turn added the title the user then reworded: undoing it would orphan that edit.
  const first = latest().turns[0];
  await agent.until(() => turnById(first.id)?.undo.state === "blocked");
  assert.match(turnById(first.id).undo.reason, /later edit builds on it/i);
  const refused = await client.fail("agent.undoTurn", { turnId: first.id });
  assert.equal(refused._tag, "EditRefused");
  assert.equal(refused.details[0].code, "depends");
  assert.ok(item(onDisk(), "title-1"), "nothing changed");
});

test("Stop interrupts the turn (D139): claude keeps running for the next message, the session's token takes no call between turns, and what was done stays", { skip, timeout: 30000 }, async () => {
  nextTurn([{ tool: "project_read" }, { sleep: 60000 }]);
  const { turnId } = await client.ok("agent.send", { prompt: "take your time" });
  await agent.until(() => turnById(turnId)?.items.some((i: any) => i.status === "done"), 15000);
  const busy = await client.fail("agent.send", { prompt: "and another thing" });
  assert.equal(busy.reason, "busy", "one turn at a time");
  const { pid, mcpPid, mcpToken } = sent().at(-1)!;
  assert.ok(alive(pid) && alive(mcpPid));
  assert.equal(new Set(sent().map((r) => r.pid)).size, 1, "every message so far went to one claude");
  // While the turn runs, the bridge still wants the session's token: not the app's, not a guess, not none.
  const base = `http://127.0.0.1:${server.ready.port}/agent`;
  assert.equal((await fetch(`${base}/tools`, { headers: { "x-uncut-agent-token": mcpToken } })).status, 200, "the session's own token works");
  for (const headers of [{}, { "x-uncut-agent-token": "nope" }, { "x-uncut-agent-token": server.ready.token }] as Array<Record<string, string>>) {
    assert.equal((await fetch(`${base}/tools`, { headers })).status, 401);
    const call = await fetch(`${base}/call`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "timeline_edit", args: {} }) });
    assert.equal(call.status, 401);
  }
  const started = Date.now();
  await client.ok("agent.cancel");
  await agent.until(() => turnById(turnId)?.status === "cancelled", 10000);
  assert.ok(Date.now() - started < 2500, "the interrupt ended it, not the kill fallback");
  assert.deepEqual(turnById(turnId).items.map((i: any) => [i.kind, i.text]), [["step", "Read the timeline"]], "what was done stays");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(alive(pid) && alive(mcpPid), "claude and its MCP server keep running for the next message");
  // Between turns the token lists tools (claude may ask) but no call is taken.
  assert.equal((await fetch(`${base}/tools`, { headers: { "x-uncut-agent-token": mcpToken } })).status, 200);
  const idle = await fetch(`${base}/call`, { method: "POST", headers: { "x-uncut-agent-token": mcpToken, "content-type": "application/json" }, body: JSON.stringify({ name: "project_read", args: {} }) });
  assert.equal(idle.status, 401, "no turn, no call");
  assert.equal(latest().running, null);
});

test("the history survives closing and reopening the project; old turns keep their Undo turn state (history.db)", { skip, timeout: 30000 }, async () => {
  const { pid, mcpPid } = sent().at(-1)!;
  await client.ok("project.close");
  await agent.until((s) => s === null);
  for (let i = 0; i < 50 && (alive(pid) || alive(mcpPid)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual([alive(pid), alive(mcpPid)], [false, false], "closing the project closes its claude");
  const mark = agent.values.length;
  await client.ok("project.open", { dir });
  await agent.until((s, i) => i >= mark && s?.dir === dir && s.turns.length === 3);
  const [first, second, third] = latest().turns;
  assert.deepEqual([first.status, second.status, third.status], ["done", "done", "cancelled"]);
  // D71: the edit log is in history.db, so the first turn is still blocked by the user's later
  // reword (not "unavailable"), and the second stays undone.
  assert.equal(first.undo.state, "blocked");
  assert.equal(second.undo.state, "undone");
  assert.equal(first.edits[0].summary, "Add a 5 s title card");
  assert.match(second.note, /by hand/);
});

test("without Claude Code a turn is refused with how to install it, and setup shows the fix", { skip, timeout: 30000 }, async () => {
  const bare = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data-bare"), UNCUT_CLAUDE: "", PATH: "/usr/bin:/bin" } });
  try {
    const c = await connect(bare.ready.port, bare.ready.token);
    await c.ok("project.open", { dir });
    const error = await c.fail("agent.send", { prompt: "hello" });
    assert.equal(error.reason, "not-installed");
    assert.match(error.message, /isn't installed/);
    const claude = (await c.ok("setup.check")).find((row: { id: string }) => row.id === "claude");
    assert.equal(claude.status, "missing");
    assert.match(claude.fix.command, /claude\.ai\/install\.sh/);
    c.close();
  } finally {
    await bare.stop();
  }
});
