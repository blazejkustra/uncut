// Overnight 2026-10-27 (handoff 19): "baseRevision N isn't a revision you read in this session" on
// short follow-up turns. Any revision the agent was given counts as read: the turn note's "now at
// revision N" (100s t12), a conflict refusal's revision (e2e t4), its own last edit's revision
// across a close and reopen (fam t11). A number it was never given is still refused.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(BUNDLE) && existsSync(MCP) && existsSync(MEDIA) ? false : "server bundle or media core not built (run pnpm build)";

let root = "";
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});
before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-revisions-")));
});

type Result = { tool: string; result: { isError?: boolean; content: Array<{ text: string }> } };

async function setup(name: string) {
  const base = join(root, name);
  mkdirSync(join(base, "projects"), { recursive: true });
  const plan = join(base, "plan.json");
  const log = join(base, "prompts.jsonl");
  const results = join(base, "results.jsonl");
  writeFileSync(log, "");
  writeFileSync(results, "");
  const server = await startServer({
    env: { UNCUT_DATA_DIR: join(base, "data"), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan, FAKE_PROMPT_LOG: log, FAKE_RESULT_LOG: results },
  });
  const client = await connect(server.ready.port, server.ready.token);
  const agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(base, "projects"), name: "P" });
  await agent.until((s) => s?.dir === snap.dir);
  const turns: Array<unknown> = [];
  const turn = (id: string) => agent.values.at(-1)?.turns.find((t: { id: string }) => t.id === id);
  const self = {
    base,
    client,
    agent,
    dir: snap.dir as string,
    prompts: (): Array<string> =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l).prompt),
    edits: (): Array<Record<string, any>> =>
      readFileSync(results, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Result)
        .filter((x) => x.tool === "timeline_edit")
        .map((x) => ({ isError: !!x.result.isError, ...JSON.parse(x.result.content[0]!.text) })),
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
    stop: async () => {
      client.close();
      await server.stop();
    },
  };
  return self;
}

const title = (id: string, text: string) => ({ op: "insert_item", track: "text", item: { id, type: "text", start: 0, duration: 30, text } });
const edit = (baseRevision: number | string, summary: string, ops: Array<unknown>) => ({ tool: "timeline_edit", args: { baseRevision, summary, ops } });

test("100s t12: a short follow-up edits from the turn note's 'now at revision N' without a project_read", { skip, timeout: 60000 }, async () => {
  const s = await setup("note");
  try {
    const a = await s.done(await s.start("add a title", [{ tool: "project_read" }, edit("$rev", "Title", [title("cap-1", "Hello")])]));
    assert.equal(a.status, "done", a.error);
    const own = s.edits()[0]!;
    assert.equal(own.ok, true, JSON.stringify(own));
    const byHand = await s.client.ok("project.edit", { ops: [{ op: "update_item", item: "cap-1", set: { text: "Hello there" } }] });
    const now = byHand.revision as number;
    assert.ok(now > own.revision);
    const b = await s.done(
      await s.start("@0:06 this is still like to fast for a real person", [edit(now, "Slower", [{ op: "trim_item", item: "cap-1", edge: "end", frames: 6 }])]),
    );
    assert.equal(b.status, "done", b.error);
    assert.match(s.prompts()[1]!, new RegExp(`now at revision ${now}\\b`), "the note names the revision");
    const second = s.edits()[1]!;
    assert.equal(second.ok, true, JSON.stringify(second));
    // A number it was never given is still refused: the first of two hand edits (the note names the second).
    const first = await s.client.ok("project.edit", { ops: [{ op: "update_track", track: "text", set: { name: "Words" } }] });
    await s.client.ok("project.edit", { ops: [{ op: "update_track", track: "text", set: { name: "Titles" } }] });
    const c = await s.done(await s.start("again", [edit(first.revision, "Guess", [{ op: "update_item", item: "cap-1", set: { text: "x" } }])]));
    assert.equal(c.status, "done", c.error);
    assert.match(String(s.edits()[2]!.refused), /isn't a revision you were given/);
  } finally {
    await s.stop();
  }
});

test(
  "e2e t4: after a conflict refusal (the user trimmed the item while the turn ran), the agent edits from the refusal's revision",
  { skip, timeout: 60000 },
  async () => {
    const s = await setup("conflict");
    try {
      const a = await s.done(await s.start("add a panel", [{ tool: "project_read" }, edit("$rev", "Panel", [title("panel", "Panel")])]));
      assert.equal(a.status, "done", a.error);
      const gate = join(s.base, "gate.json");
      const id = await s.start("make the panel shorter", [{ tool: "project_read" }, { await: gate }]);
      await s.agent.until(
        (v) => v?.turns.find((t: { id: string }) => t.id === id)?.items.some((i: any) => i.kind === "step" && i.tool === "project_read" && i.status === "done"),
        10000,
      );
      const read = s.edits().length;
      const byHand = await s.client.ok("project.edit", { ops: [{ op: "trim_item", item: "panel", edge: "end", frames: 5 }] });
      writeFileSync(
        gate,
        JSON.stringify([
          edit("$rev", "Shorter", [{ op: "trim_item", item: "panel", edge: "end", frames: 10 }]),
          edit(byHand.revision, "Shorter", [{ op: "trim_item", item: "panel", edge: "end", frames: 4 }]),
        ]),
      );
      const b = await s.done(id);
      assert.equal(b.status, "done", b.error);
      const [conflict, retry] = s.edits().slice(read);
      assert.equal(conflict!.isError, true);
      assert.match(String(conflict!.refused), /Conflicts with newer edits/);
      assert.equal(conflict!.revision, byHand.revision);
      assert.equal(retry!.ok, true, JSON.stringify(retry));
    } finally {
      await s.stop();
    }
  },
);

test("fam t11: after the project is closed and opened again, the agent edits from its own last edit's revision", { skip, timeout: 60000 }, async () => {
  const s = await setup("reopen");
  try {
    const a = await s.done(await s.start("add a title", [{ tool: "project_read" }, edit("$rev", "Title", [title("cap-1", "Hello")])]));
    assert.equal(a.status, "done", a.error);
    const own = s.edits()[0]!;
    await s.client.ok("project.close");
    await s.client.ok("project.open", { dir: s.dir });
    await s.agent.until((v) => v?.dir === s.dir);
    const b = await s.done(
      await s.start("the camera is super bright can we adjust it?", [
        edit(own.revision, "Darker", [{ op: "update_item", item: "cap-1", set: { text: "Hello again" } }]),
      ]),
    );
    assert.equal(b.status, "done", b.error);
    const second = s.edits()[1]!;
    assert.equal(second.ok, true, JSON.stringify(second));
  } finally {
    await s.stop();
  }
});
