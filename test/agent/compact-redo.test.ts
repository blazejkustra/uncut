// Handoff 8, 9, 21 on the bundled server with the scripted claude: the meter counts context as
// Claude Code does (fresh + cache read + cache write) with the window and auto-compact point from
// its get_context_usage; Compact (/compact) runs Claude Code's own compaction as a row in the thread,
// the meter drops and the user's pending note waits for the next real message; Redo turn puts an
// undone turn's edits back as a new revision (the agent's next note says so) and is refused when a
// later edit changed what the turn changed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(BUNDLE) && existsSync(MCP) && existsSync(MEDIA) ? false : "server bundle or media core not built (run pnpm build)";

const item = (project: any, id: string) => project.tracks.flatMap((t: any) => t.items).find((i: any) => i.id === id);
const text = (id: string, words: string) => ({
  id,
  type: "text",
  start: 0,
  duration: 90,
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-compact-redo-")));
});

async function setup(name: string, fake: Record<string, string> = {}) {
  const base = join(root, name);
  mkdirSync(join(base, "projects"), { recursive: true });
  const plan = join(base, "plan.json");
  const log = join(base, "prompts.jsonl");
  writeFileSync(log, "");
  const server = await startServer({
    env: { UNCUT_DATA_DIR: join(base, "data"), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan, FAKE_PROMPT_LOG: log, FAKE_COMPACT_AT: "400000", ...fake },
  });
  const client = await connect(server.ready.port, server.ready.token);
  const agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(base, "projects"), name: "P" });
  await agent.until((s) => s?.dir === snap.dir);
  const turns: Array<unknown> = [];
  const latest = () => agent.values.at(-1);
  const turn = (id: string) => latest()?.turns.find((t: { id: string }) => t.id === id);
  const self = {
    client,
    agent,
    latest,
    turn,
    prompts: (): Array<string> =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l).prompt),
    onDisk: () => JSON.parse(readFileSync(join(snap.dir, "project.json"), "utf8")),
    send: async (prompt: string, steps?: Array<unknown>) => {
      if (steps) {
        turns.push(steps);
        writeFileSync(plan, JSON.stringify(turns));
      }
      const { turnId } = await client.ok("agent.send", { prompt });
      await agent.until(() => turn(turnId) && turn(turnId).status !== "running", 20000);
      return turn(turnId);
    },
    stop: async () => {
      client.close();
      await server.stop();
    },
  };
  return self;
}

const usage = {
  usage: { input_tokens: 2_000, cache_read_input_tokens: 380_000, cache_creation_input_tokens: 20_000, output_tokens: 900 },
  model: "claude-opus-5-5",
};

test(
  "meter as Claude Code counts it; Compact compacts the conversation, shows a row and the meter drops; the note waits",
  { skip, timeout: 60000 },
  async () => {
    const s = await setup("compact");
    try {
      const t1 = await s.send("look", [{ tool: "project_read" }, { text: "Looked." }, usage]);
      assert.equal(t1.status, "done", t1.error);
      await s.agent.until((v) => v?.context?.compactAt === 400_000, 5000);
      const before = s.latest().context;
      assert.equal(before.used, 402_000, "fresh + cache read + cache write; output isn't counted until the next call reads it");
      assert.equal(before.window, 1_000_000, "the window from get_context_usage, before any result said it");
      assert.deepEqual([before.fresh, before.cacheRead, before.cacheWrite, before.output], [2_000, 380_000, 20_000, 900]);

      // A hand edit before the compact: its note isn't spent on the /compact.
      await s.client.ok("project.edit", { ops: [{ op: "update_track", track: "text", set: { name: "Titles" } }] });
      const c = await s.send("/compact");
      assert.equal(c.kind, "compact");
      assert.equal(c.status, "done", c.error);
      assert.deepEqual(c.compacted, { trigger: "manual", before: 402_000, after: 15_000 });
      assert.equal(c.note, undefined, "no note goes with /compact");
      await s.agent.until((v) => v?.context?.used === 18_000, 5000);
      assert.equal(s.latest().context.compactAt, 400_000);
      assert.deepEqual(
        s.prompts().map((p) => p.split("\n")[0]),
        ["look"],
        "/compact went to claude as itself, not as a planned turn",
      );

      await s.send("next", [{ text: "ok" }]);
      const next = s.prompts().at(-1)!;
      assert.match(next, /^next/);
      assert.match(next, /Changed name on track text|track text/, "the hand edit's note comes with the next message");
    } finally {
      await s.stop();
    }
  },
);

test("the meter keeps Claude Code's capped window when a result reports the model's 1M", { skip, timeout: 60000 }, async () => {
  const s = await setup("capped-window", { FAKE_CONTEXT_WINDOW: "283000", FAKE_COMPACT_AT: "250000" });
  try {
    await s.send("one", [{ text: "ok" }, { ...usage, contextWindow: 1_000_000 }]);
    await s.send("two", [{ text: "ok" }, { ...usage, contextWindow: 1_000_000 }]);
    await s.agent.until((v) => v?.context?.compactAt === 250_000, 5000);
    assert.equal(s.latest().context.window, 283_000);
  } finally {
    await s.stop();
  }
});

test("Compact with no conversation yet is refused", { skip, timeout: 30000 }, async () => {
  const s = await setup("compact-empty");
  try {
    const error = await s.client.fail("agent.send", { prompt: "/compact" });
    assert.match(error.message, /no conversation to compact/);
  } finally {
    await s.stop();
  }
});

test(
  "Redo turn: the undone turn's edits come back as a new revision and the agent hears it; a later edit to the same item blocks it",
  { skip, timeout: 60000 },
  async () => {
    const s = await setup("redo");
    try {
      const t1 = await s.send("add a title", [
        { tool: "project_read" },
        {
          tool: "timeline_edit",
          args: { baseRevision: "$rev", summary: "Add a title", ops: [{ op: "insert_item", track: "text", item: text("title-1", "Hello") }] },
        },
      ]);
      assert.equal(t1.status, "done", t1.error);
      await s.client.ok("agent.undoTurn", { turnId: t1.id });
      assert.equal(item(s.onDisk(), "title-1"), undefined);
      await s.agent.until(() => s.turn(t1.id)?.undo.redo === "available", 5000);
      assert.equal(s.turn(t1.id).undo.state, "undone");

      const undoneAt = (await s.client.ok("project.get")).revision;
      const redone = await s.client.ok("agent.redoTurn", { turnId: t1.id });
      assert.equal(redone.revision, undoneAt + 1, "its own revision");
      assert.equal(item(s.onDisk(), "title-1").text, "Hello");
      await s.agent.until(() => s.turn(t1.id)?.undo.state === "available", 5000);
      assert.ok(s.turn(t1.id).redoneAt);

      await s.send("next", [{ text: "ok" }]);
      const prompt = s.prompts().at(-1)!;
      assert.match(prompt, /Undid your turn "add a title"/);
      assert.match(prompt, /Redid your turn "add a title"/);

      // Undo it again, then the user makes an item with the same id: Redo is blocked and refused.
      await s.client.ok("agent.undoTurn", { turnId: t1.id });
      await s.client.ok("project.edit", { ops: [{ op: "insert_item", track: "text", item: text("title-1", "Mine") }] });
      await s.agent.until(() => s.turn(t1.id)?.undo.redo === "blocked", 5000);
      assert.match(s.turn(t1.id).undo.redoReason, /title-1/);
      const error = await s.client.fail("agent.redoTurn", { turnId: t1.id });
      assert.match(error.message, /later edit changed what the turn changed \(title-1\)/);
      assert.equal(item(s.onDisk(), "title-1").text, "Mine", "the user's item stands");
    } finally {
      await s.stop();
    }
  },
);
