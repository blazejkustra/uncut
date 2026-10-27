// Phase 4 chunk 2, review fixes, on the bundled server with the scripted claude: D6 across a close
// and reopen (the note carries over, a revision from an earlier opening is refused), user edits made
// during a turn reach the next note, an agent edit after the user's undo is refused, a multi-edit
// turn is one ⌘Z step, undo states are validated, reopening mid-turn keeps one history, replies keep
// split UTF-8 characters, an unreadable turns.json is never overwritten, a stopping server takes its
// claude with it, and a killed server's leftovers are cleaned on the next start.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { readAgentHistory } from "../helpers/history.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(BUNDLE) && existsSync(MCP) && existsSync(MEDIA) ? false : "server bundle or media core not built (run pnpm build)";

interface Run {
  prompt: string;
  resume: string | null;
  pid: number;
  mcpPid: number;
  system: string;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const items = (project: any) => project.tracks.flatMap((t: any) => t.items);
const item = (project: any, id: string) => items(project).find((i: any) => i.id === id);
const text = (id: string, start: number, duration: number, words: string) => ({
  id,
  type: "text",
  start,
  duration,
  text: words,
  transform: { x: 154, y: 410 },
  style: { preset: "text.title", size: 130, weight: 700 },
});

let root = "";
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});
before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-safety-")));
});

/** A server with its own scripted claude, a project in its own folder, and helpers. */
async function setup(name: string, env: Record<string, string> = {}) {
  const base = join(root, name);
  mkdirSync(join(base, "projects"), { recursive: true });
  const plan = join(base, "plan.json");
  const log = join(base, "prompts.jsonl");
  writeFileSync(log, "");
  const server = await startServer({ env: { UNCUT_DATA_DIR: join(base, "data"), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan, FAKE_PROMPT_LOG: log, ...env } });
  const client = await connect(server.ready.port, server.ready.token);
  const agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(base, "projects"), name: "P" });
  await agent.until((s) => s?.dir === snap.dir);
  const turns: Array<unknown> = [];
  const latest = () => agent.values.at(-1);
  const turn = (id: string) => latest()?.turns.find((t: { id: string }) => t.id === id);
  const self = {
    server,
    client,
    agent,
    dir: snap.dir as string,
    latest,
    turn,
    runs: (): Array<Run> =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    onDisk: () => JSON.parse(readFileSync(join(snap.dir, "project.json"), "utf8")),
    /** Queue the steps of the next turn and send it; resolves with the turn id. */
    start: async (prompt: string, steps: Array<unknown>) => {
      turns.push(steps);
      writeFileSync(plan, JSON.stringify(turns));
      const { turnId } = await client.ok("agent.send", { prompt });
      return turnId as string;
    },
    done: async (id: string) => {
      await agent.until(() => turn(id) && turn(id).status !== "running", 20000);
      return turn(id);
    },
    ask: async (prompt: string, steps: Array<unknown>) => self.done(await self.start(prompt, steps)),
    stop: async () => {
      client.close();
      await server.stop();
    },
  };
  return self;
}

test(
  "D6 across close and reopen: the earlier hand edit is in the next prompt; a revision from the earlier opening is refused",
  { skip, timeout: 60000 },
  async () => {
    const s = await setup("reopen");
    try {
      const t1 = await s.ask("add a title", [
        { tool: "project_read" },
        {
          tool: "timeline_edit",
          args: {
            baseRevision: "$rev",
            summary: "Add a title",
            ops: [{ op: "insert_item", track: "text", item: text("title-1", 0, 150, "Kraków from above") }],
          },
        },
      ]);
      assert.equal(t1.status, "done", t1.error);
      const oldRevision = t1.edits[0].revision;
      // The user rewords it by hand, then closes and reopens the project.
      await s.client.ok("project.edit", { ops: [{ op: "update_item", item: "title-1", set: { text: "Kraków, from the air" } }] });
      await s.client.ok("project.close");
      await s.agent.until((v) => v === null);
      const reopened = await s.client.ok("project.open", { dir: s.dir });
      await s.agent.until((v, i, all) => v?.dir === s.dir && all.slice(0, i).some((x) => x === null));

      // Turn 2 tries the revision it remembers from the earlier opening (refused), then the one
      // the turn's note names (overnight 2026-10-27, handoff 19: a revision it was given counts as read).
      const t2 = await s.ask("make the title shout", [
        {
          tool: "timeline_edit",
          args: { baseRevision: oldRevision, summary: "Shout (stale)", ops: [{ op: "update_item", item: "title-1", set: { text: "KRAKÓW" } }] },
        },
        {
          tool: "timeline_edit",
          args: { baseRevision: reopened.revision, summary: "Shout (from the note)", ops: [{ op: "update_item", item: "title-1", set: { text: "KRAKÓW" } }] },
        },
      ]);
      assert.deepEqual(
        t2.items.filter((i: any) => i.kind === "step").map((i: any) => i.status),
        ["error", "done"],
      );
      assert.match(t2.items.find((i: any) => i.kind === "step").error ?? "", /changed after revision|isn.t a revision you were given/);
      assert.equal(item(s.onDisk(), "title-1").text, "KRAKÓW");
      const prompt = s.runs()[1]!.prompt;
      assert.match(prompt, new RegExp(`now at revision ${reopened.revision}\\b`));
      assert.match(prompt, /Earlier, before the project was closed and reopened:/);
      assert.match(prompt, /Changed the text of title-1 to "Kraków, from the air"/);
      assert.match(prompt, /closed and opened again/);
      assert.match(t2.note, /Kraków, from the air/, "the card shows it too");

      // Delivered once: the next turn's prompt doesn't repeat it.
      await s.ask("anything else?", [{ tool: "project_read" }]);
      assert.doesNotMatch(s.runs()[2]!.prompt, /by hand|reopened/);
    } finally {
      await s.stop();
    }
  },
);

test(
  "D6 during a turn: a hand edit made while the agent works reaches the next note; an edit after the user's undo is refused",
  { skip, timeout: 60000 },
  async () => {
    const s = await setup("during");
    try {
      await s.ask("add a title", [
        { tool: "project_read" },
        {
          tool: "timeline_edit",
          args: { baseRevision: "$rev", summary: "Add a title", ops: [{ op: "insert_item", track: "text", item: text("title-1", 0, 90, "One") }] },
        },
      ]);
      // Turn 2 reads, waits (the user edits the title meanwhile), then adds something else.
      const t2 = await s.start("add a second card", [
        { tool: "project_read" },
        { sleep: 1500 },
        {
          tool: "timeline_edit",
          args: { baseRevision: "$rev", summary: "Add a second card", ops: [{ op: "insert_item", track: "text", item: text("two-1", 90, 60, "Two") }] },
        },
      ]);
      await s.agent.until(() => s.turn(t2)?.items.some((i: any) => i.status === "done"), 10000);
      await s.client.ok("project.edit", { ops: [{ op: "update_item", item: "title-1", set: { text: "Uno" } }] });
      assert.equal((await s.done(t2)).status, "done");
      assert.equal(item(s.onDisk(), "two-1").text, "Two", "an edit to something else goes through");
      await s.ask("next", [{ tool: "project_read" }]);
      assert.match(s.runs()[2]!.prompt, /Changed the text of title-1 to "Uno"/, "the hand edit made mid-turn is reported");

      // Turn 4 reads, waits (the user presses ⌘Z), then edits: refused, the undo is news.
      const t4 = await s.start("rename the title", [
        { tool: "project_read" },
        { sleep: 1500 },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Rename", ops: [{ op: "update_item", item: "title-1", set: { text: "Primo" } }] } },
      ]);
      await s.agent.until(() => s.turn(t4)?.items.some((i: any) => i.status === "done"), 10000);
      await s.client.ok("project.undo");
      const done4 = await s.done(t4);
      assert.equal(done4.items.filter((i: any) => i.kind === "step").at(-1).status, "error", "refused after the user's undo");
      assert.notEqual(item(s.onDisk(), "title-1")?.text, "Primo");
      await s.ask("next", [{ tool: "project_read" }]);
      assert.match(s.runs()[4]!.prompt, /Used undo/);
    } finally {
      await s.stop();
    }
  },
);

test("D7: a multi-edit turn is one ⌘Z step; a turn whose undo wouldn't validate shows as blocked", { skip, timeout: 60000 }, async () => {
  const s = await setup("undo");
  try {
    const t1 = await s.ask("two cards", [
      { tool: "project_read" },
      {
        tool: "timeline_edit",
        args: { baseRevision: "$rev", summary: "First card", ops: [{ op: "insert_item", track: "text", item: text("a-1", 0, 60, "A") }] },
      },
      { tool: "project_read" },
      {
        tool: "timeline_edit",
        args: { baseRevision: "$rev", summary: "Second card", ops: [{ op: "insert_item", track: "text", item: text("b-1", 60, 60, "B") }] },
      },
    ]);
    assert.equal(t1.edits.length, 2);
    const undone = await s.client.ok("project.undo");
    assert.deepEqual([item(undone.project, "a-1"), item(undone.project, "b-1")], [undefined, undefined], "one ⌘Z takes back the whole turn");
    const redone = await s.client.ok("project.redo");
    assert.ok(item(redone.project, "a-1") && item(redone.project, "b-1"));

    // The agent shortens b-1; the user puts a card in the freed space. Undoing the turn would
    // stretch b-1 over it again: structurally fine, invalid (overlap), so it shows as blocked.
    const t2 = await s.ask("shorten B", [
      { tool: "project_read" },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Shorten B", ops: [{ op: "trim_item", item: "b-1", edge: "end", frames: 30 }] } },
    ]);
    await s.client.ok("project.edit", { ops: [{ op: "insert_item", track: "text", item: text("u-1", 95, 20, "U") }] });
    await s.agent.until(() => s.turn(t2.id)?.undo.state === "blocked");
    const refused = await s.client.fail("agent.undoTurn", { turnId: t2.id });
    assert.equal(refused._tag, "EditRefused");
  } finally {
    await s.stop();
  }
});

test("reopening the same project mid-turn stops the turn, keeps its reply, and the next turn runs", { skip, timeout: 60000 }, async () => {
  const s = await setup("midturn");
  try {
    const t1 = await s.start("slow", [{ tool: "project_read" }, { text: "Looking at it" }, { sleep: 60000 }]);
    await s.agent.until(() => s.turn(t1)?.items.some((i: any) => i.kind === "text"), 10000);
    const { pid } = s.runs()[0]!;
    await s.client.ok("project.open", { dir: s.dir });
    const stopped = await s.done(t1);
    assert.equal(stopped.status, "cancelled");
    assert.match(stopped.error, /Stopped: the project was closed or opened again/);
    assert.doesNotMatch(stopped.error, /Interrupted/);
    assert.deepEqual(
      stopped.items.map((i: any) => i.text),
      ["Read the timeline", "Looking at it"],
      "the streamed reply is kept",
    );
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
    assert.equal(alive(pid), false);
    assert.equal(s.latest().running, null);
    assert.equal(s.latest().turns.length, 1, "one history, not two");
    // Saved as stopped, with its reply.
    await sleep(200);
    const saved = readAgentHistory(s.dir).turns;
    assert.deepEqual([saved.length, saved[0].status, saved[0].items.length], [1, "cancelled", 2]);
    const t2 = await s.ask("again", [{ tool: "project_read" }]);
    assert.equal(t2.status, "done", "not busy");
  } finally {
    await s.stop();
  }
});

test("a reply keeps a character split across two pipe reads, and the agent is told not to promise later actions", { skip, timeout: 30000 }, async () => {
  const s = await setup("utf8");
  try {
    const t = await s.ask("say something Polish", [{ text: "Kraków, Łódź i Gdańsk", split: true }]);
    assert.equal(t.items[0].text, "Kraków, Łódź i Gdańsk");
    assert.match(s.runs()[0]!.system, /Don't promise to do something later/);
  } finally {
    await s.stop();
  }
});

test("an unreadable agent/turns.json is never overwritten: turns are refused with why", { skip, timeout: 30000 }, async () => {
  const s = await setup("locked");
  const file = join(s.dir, "agent", "turns.json");
  try {
    await s.client.ok("project.close");
    mkdirSync(join(s.dir, "agent"), { recursive: true });
    const original = `${JSON.stringify({ format: "uncut.agent-history/0", turns: [] })}\n`;
    writeFileSync(file, original);
    chmodSync(file, 0o000);
    await s.client.ok("project.open", { dir: s.dir });
    await s.client.ok("project.edit", { ops: [{ op: "insert_item", track: "text", item: text("x-1", 0, 30, "X") }] });
    const error = await s.client.fail("agent.send", { prompt: "hello" });
    assert.equal(error.reason, "failed");
    assert.match(error.message, /Can't read this project's agent history/);
    await sleep(300);
    chmodSync(file, 0o644);
    assert.equal(readFileSync(file, "utf8"), original, "left exactly as it was");
  } finally {
    if (existsSync(file)) chmodSync(file, 0o644);
    await s.stop();
  }
});

test("a server that stops takes its claude along; a killed server's claude and folder are cleaned up by the next one", { skip, timeout: 60000 }, async () => {
  // SIGTERM: the normal quit path (and bin.ts's 1 s exit timer) must not leave claude running.
  const a = await setup("sigterm");
  await a.start("slow", [{ tool: "project_read" }, { sleep: 60000 }]);
  await a.agent.until(() => a.latest()?.turns[0]?.items.some((i: any) => i.status === "done"), 10000);
  const { pid, mcpPid } = a.runs()[0]!;
  a.client.close();
  a.server.proc.kill("SIGTERM");
  await a.server.exited;
  for (let i = 0; i < 50 && (alive(pid) || alive(mcpPid)); i++) await sleep(100);
  assert.deepEqual([alive(pid), alive(mcpPid)], [false, false], "claude and its MCP server are gone");

  // SIGKILL: nothing runs in the server, so claude outlives it; the next server cleans up.
  const b = await setup("sigkill");
  await b.start("slow", [{ tool: "project_read" }, { sleep: 60000 }]);
  await b.agent.until(() => b.latest()?.turns[0]?.items.some((i: any) => i.status === "done"), 10000);
  const orphan = b.runs()[0]!;
  const serverPid = b.server.proc.pid!;
  const folders = () => readdirSync(tmpdir()).filter((n) => n.startsWith(`uncut-agent-${serverPid}-`));
  assert.equal(folders().length, 1);
  b.client.close();
  b.server.proc.kill("SIGKILL");
  await b.server.exited;
  assert.ok(alive(orphan.pid), "claude survived the SIGKILL");
  const c = await setup("cleanup");
  try {
    for (let i = 0; i < 50 && alive(orphan.pid); i++) await sleep(100);
    assert.equal(alive(orphan.pid), false, "the next server stopped the orphaned claude");
    assert.deepEqual(folders(), [], "and removed its folder");
  } finally {
    await c.stop();
    // Belt and braces: never leave a stray process behind.
    for (const p of [orphan.pid, orphan.mcpPid]) if (alive(p)) spawnSync("kill", ["-9", String(p)]);
  }
});
