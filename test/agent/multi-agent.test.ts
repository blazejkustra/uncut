// C12: two agents in one project on the bundled server with the scripted claude: turns at once on
// two agents, both edits land and each revision is its agent's; a stale edit of an item another
// agent changed is refused and names it; the other agent's next note names those edits; a send
// past the cap of two working agents is refused; two approval cards at once, answered in either order.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HistoryDb } from "../../apps/server/src/project/history.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(BUNDLE) && existsSync(MCP) && existsSync(MEDIA) ? false : "server bundle or media core not built (run pnpm build)";

const item = (project: any, id: string) => project.tracks.flatMap((t: any) => t.items).find((i: any) => i.id === id);
const text = (id: string, words: string, start = 0) => ({
  id,
  type: "text",
  start,
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-multi-agent-")));
});

async function setup(name: string) {
  const base = join(root, name);
  mkdirSync(join(base, "projects"), { recursive: true });
  const plan = join(base, "plan.json");
  const log = join(base, "prompts.jsonl");
  writeFileSync(log, "");
  const server = await startServer({
    env: { UNCUT_DATA_DIR: join(base, "data"), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan, FAKE_PROMPT_LOG: log, UNCUT_APPROVAL_MS: "20000" },
  });
  const client = await connect(server.ready.port, server.ready.token);
  const agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(base, "projects"), name: "P" });
  await agent.until((s) => s?.dir === snap.dir);
  const turns: Array<unknown> = [];
  const latest = () => agent.values.at(-1);
  const turn = (id: string) => latest()?.turns.find((t: { id: string }) => t.id === id);
  const prompts = (): Array<string> =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l).prompt);
  const self = {
    base,
    dir: snap.dir as string,
    client,
    agent,
    latest,
    turn,
    prompts,
    info: (id: string) => latest()?.agents?.find((a: { id: string }) => a.id === id),
    onDisk: () => JSON.parse(readFileSync(join(snap.dir, "project.json"), "utf8")),
    /** Sends to an agent and waits until its claude has the message (so the next plan turn is the next agent's). */
    plan: (steps: Array<unknown>) => {
      turns.push(steps);
      writeFileSync(plan, JSON.stringify(turns));
    },
    start: async (prompt: string, steps: Array<unknown>, agentId?: string) => {
      self.plan(steps);
      const had = prompts().length;
      const { turnId } = await client.ok("agent.send", { prompt, ...(agentId ? { agentId } : {}) });
      await agent.until(() => prompts().length > had, 15000);
      return turnId as string;
    },
    done: async (id: string) => {
      await agent.until(() => turn(id) && turn(id).status !== "running", 30000);
      return turn(id);
    },
    stop: async () => {
      client.close();
      await server.stop();
    },
  };
  return self;
}

const stepErrors = (t: any) => t.items.filter((i: any) => i.kind === "step" && i.status === "error").map((i: any) => i.error as string);

test(
  "two agents at once: both edits land, each revision is its agent's, a stale edit of the other's item is refused by name, the next note names their edits, a third send waits for a free slot",
  { skip, timeout: 120000 },
  async () => {
    const s = await setup("two");
    try {
      await s.client.ok("project.edit", {
        ops: [
          { op: "insert_item", track: "text", item: text("t1", "One") },
          { op: "insert_item", track: "text", item: text("t2", "Two", 100) },
        ],
      });
      const graphics = await s.client.ok("agent.create", { focus: "graphics" });
      assert.equal(graphics.name, "Graphics");
      assert.equal(graphics.focus, "graphics");
      await s.agent.until((v) => v?.agents?.length === 2, 5000);
      const editor = s.latest().agents[0];
      assert.equal(editor.id, "ag-main");
      assert.equal(editor.name, "Editor");

      const goA = join(s.base, "a.json");
      const goB = join(s.base, "b.json");
      const a = await s.start("retitle t1", [{ tool: "project_read" }, { await: goA }]);
      const b = await s.start("style the titles", [{ tool: "project_read" }, { await: goB }], graphics.id);
      await s.agent.until(() => s.info("ag-main")?.status === "working" && s.info(graphics.id)?.status === "working", 5000);
      assert.equal(s.turn(a).agentId, "ag-main");
      assert.equal(s.turn(b).agentId, graphics.id);
      assert.match(s.prompts()[1]!, /<agents>[\s\S]*You are Graphics[\s\S]*Editor: anything in the edit \(working now\)/);

      // A third agent past the cap: refused, nothing queued.
      const sound = await s.client.ok("agent.create", { focus: "sound", name: "Mix" });
      const refused = await s.client.fail("agent.send", { prompt: "duck the music", agentId: sound.id });
      assert.equal(refused.reason, "busy");
      assert.match(refused.message, /at most 2 agents work at once/);
      assert.equal(s.latest().turns.length, 2, "the refused message made no turn");

      // Editor changes t1; Graphics, from its older read, tries t1 (refused, naming Editor) and t2 (lands).
      writeFileSync(
        goA,
        JSON.stringify([
          { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Retitle", ops: [{ op: "update_item", item: "t1", set: { text: "Editor's" } }] } },
          { text: "Retitled." },
        ]),
      );
      const ta = await s.done(a);
      assert.equal(ta.status, "done", ta.error);
      assert.deepEqual(stepErrors(ta), []);
      writeFileSync(
        goB,
        JSON.stringify([
          {
            tool: "timeline_edit",
            args: { baseRevision: "$rev", summary: "Restyle t1", ops: [{ op: "update_item", item: "t1", set: { text: "Graphics'" } }] },
          },
          {
            tool: "timeline_edit",
            args: { baseRevision: "$rev", summary: "Restyle t2", ops: [{ op: "update_item", item: "t2", set: { text: "Graphics' two" } }] },
          },
          { text: "Styled." },
        ]),
      );
      const tb = await s.done(b);
      assert.equal(tb.status, "done", tb.error);
      const [conflict] = stepErrors(tb);
      assert.match(conflict ?? "", /t1 \(changed by Editor\)/);
      assert.equal(stepErrors(tb).length, 1, "the edit of t2 went through");
      assert.equal(item(s.onDisk(), "t1").text, "Editor's", "Editor's change stands");
      assert.equal(item(s.onDisk(), "t2").text, "Graphics' two");
      assert.equal(tb.edits.length, 1);

      // Graphics' next message: Editor's change is news, named.
      const next = await s.start("next", [{ text: "ok" }], graphics.id);
      await s.done(next);
      assert.match(s.prompts().at(-1)!, /by Editor: Changed the text of t1/);
      assert.doesNotMatch(s.prompts().at(-1)!, /t2/, "its own edit isn't news to it");
      // And Editor's next: Graphics' edit of t2.
      const back = await s.start("again", [{ text: "ok" }]);
      await s.done(back);
      assert.match(s.prompts().at(-1)!, /by Graphics: Changed the text of t2/);

      // An agent can be closed (archived) while others stay.
      await s.client.ok("agent.archive", { agentId: sound.id });
      await s.agent.until((v) => v?.agents?.length === 2, 5000);
    } finally {
      await s.stop();
    }
    // Each agent revision carries its agent (from its turn), also read back from history.db.
    const db = HistoryDb.open(s.dir, {}, false);
    try {
      const head = db.agent("ag-main");
      assert.ok(head.turns.length >= 2);
      const graphicsTurns = db.agentList();
      assert.ok(graphicsTurns && JSON.parse(graphicsTurns).length === 3, "the list keeps the archived agent");
      const revs = db.listed(50).rows.filter((r) => r.author === "agent");
      const log = db.logAt(revs[0]!.revision).log.filter((e) => e.actor === "agent");
      assert.deepEqual(new Set(log.map((e) => e.agentId)).size, 2, "Editor's and Graphics' edits are told apart");
    } finally {
      db.close();
    }
  },
);

test("an agent whose message is still being prepared can't be closed or start a new chat: its turn runs to the end", { skip, timeout: 60000 }, async () => {
  const s = await setup("starting");
  try {
    const cuts = await s.client.ok("agent.create", { focus: "cuts" });
    s.plan([{ text: "ok" }]);
    const [sent, archived, fresh] = await Promise.allSettled([
      s.client.ok("agent.send", { prompt: "go", agentId: cuts.id }),
      s.client.fail("agent.archive", { agentId: cuts.id }),
      s.client.fail("agent.newThread", { agentId: cuts.id }),
    ]);
    assert.equal(sent.status, "fulfilled");
    assert.equal(archived.status === "fulfilled" && archived.value.reason, "busy");
    assert.equal(fresh.status === "fulfilled" && fresh.value.reason, "busy");
    const done = await s.done((sent as PromiseFulfilledResult<{ turnId: string }>).value.turnId);
    assert.equal(done.status, "done", done.error);
    assert.ok(s.info(cuts.id), "still in the tab row");
  } finally {
    await s.stop();
  }
});

test("two approval cards at once, one per agent, answered in either order", { skip, timeout: 90000 }, async () => {
  const s = await setup("cards");
  try {
    const cuts = await s.client.ok("agent.create", { focus: "cuts", name: "Cuts" });
    const ask = (q: string) => [{ tool: "ask_user", args: { question: q, options: [{ label: "Yes" }, { label: "No" }] } }, { text: "ok" }];
    const a = await s.start("ask one", ask("First?"));
    const b = await s.start("ask two", ask("Second?"), cuts.id);
    await s.agent.until(() => s.info("ag-main")?.approval && s.info(cuts.id)?.approval, 15000);
    assert.equal(s.info("ag-main").status, "waiting");
    assert.equal(s.info(cuts.id).status, "waiting");
    assert.equal(s.latest().approval?.turnId, a, "the top-level card is the first agent's, for older clients");
    const cardA = s.info("ag-main").approval;
    const cardB = s.info(cuts.id).approval;
    assert.equal(cardB.question.question, "Second?");
    await s.client.ok("agent.approve", { id: cardB.id, allow: true, answer: { choices: ["Yes"] } });
    const tb = await s.done(b);
    assert.equal(tb.status, "done", tb.error);
    assert.ok(s.info("ag-main").approval, "the other card is still open");
    await s.client.ok("agent.approve", { id: cardA.id, allow: true, answer: { choices: ["No"] } });
    const ta = await s.done(a);
    assert.equal(ta.status, "done", ta.error);
    const answer = (t: any) => t.items.find((i: any) => i.kind === "card")?.card.answer;
    assert.deepEqual(answer(tb), { choices: ["Yes"] });
    assert.deepEqual(answer(ta), { choices: ["No"] });
  } finally {
    await s.stop();
  }
});
