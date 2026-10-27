// C12: several agents in one project. Conflicts are checked by who made an edit (its agent, else
// its actor): agent B's stale edit of an item agent A changed is refused and says who; different
// items both apply; the user/agent cases are as before. The note for one agent names the others' edits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyEdit, createSession, EditConflict } from "../../packages/core/src/timeline/apply-ops.ts";
import { manualEditsNote } from "../../packages/core/src/timeline/edit-log.ts";
import { netEditsNote, othersEditsNote } from "../../packages/core/src/timeline/net-edits.ts";
import type { LogEntry, Op, Project, Session } from "../../packages/core/src/timeline/types.ts";
import { HistoryDb, SCHEMA_VERSION } from "../../apps/server/src/project/history.ts";
import { storedAgents } from "../../apps/server/src/project/history/agents.ts";

const project = (): Project =>
  ({
    format: "uncut/0",
    name: "M",
    canvas: { width: 1920, height: 1080, fps: 30 },
    media: [],
    tracks: [
      {
        id: "text",
        kind: "text",
        name: "Text",
        items: [
          { id: "a", type: "text", start: 0, duration: 30, text: "A" },
          { id: "b", type: "text", start: 40, duration: 30, text: "B" },
        ],
      },
    ],
  }) as unknown as Project;

const retitle = (item: string, text: string): Op => ({ op: "update_item", item, set: { text } }) as Op;
const byAgent = (s: Session, agentId: string, base: number, ...ops: Array<Op>) =>
  applyEdit(s, { actor: "agent", agentId, turnId: `turn-${agentId}`, ops, baseRevision: base });

test("agent B's stale edit of an item agent A changed is refused, saying A changed it; different items both apply", () => {
  const start = createSession(project());
  const afterA = byAgent(start, "ag-a", 0, retitle("a", "by A"));
  assert.equal(afterA.log.at(-1)!.agentId, "ag-a");
  assert.throws(
    () => byAgent(afterA, "ag-b", 0, retitle("a", "by B")),
    (error: unknown) => error instanceof EditConflict && error.details.includes("a") && error.by.get("a") === "ag-a",
  );
  const afterB = byAgent(afterA, "ag-b", 0, retitle("b", "by B"));
  const text = (s: Session, id: string) => (s.project.tracks[0]!.items.find((i) => i.id === id) as { text: string }).text;
  assert.equal(text(afterB, "a"), "by A");
  assert.equal(text(afterB, "b"), "by B");
  // An agent's own newer edit never conflicts with itself.
  assert.doesNotThrow(() => byAgent(afterB, "ag-a", 0, retitle("a", "A again")));
});

test("the user and agent cases are as before: a user edit refuses a stale agent edit, the agent's own edits and agent entries without an id agree", () => {
  const start = createSession(project());
  const user = applyEdit(start, { actor: "user", ops: [retitle("a", "mine")] });
  assert.throws(
    () => applyEdit(user, { actor: "agent", ops: [retitle("a", "agent")], baseRevision: 0 }),
    (e: unknown) => e instanceof EditConflict && e.by.get("a") === "user",
  );
  assert.doesNotThrow(() => applyEdit(user, { actor: "agent", ops: [retitle("b", "agent")], baseRevision: 0 }));
  const agent = applyEdit(start, { actor: "agent", ops: [retitle("a", "agent")] });
  assert.doesNotThrow(() => applyEdit(agent, { actor: "agent", ops: [retitle("a", "agent 2")], baseRevision: 0 }), "no agentId on either: the same author");
  assert.throws(() => applyEdit(agent, { actor: "user", ops: [retitle("a", "user")], baseRevision: 0 }), EditConflict);
});

test("one agent's note names the user's edits and each other agent's, leaving its own out", () => {
  const start = createSession(project());
  let s = byAgent(start, "ag-a", 0, retitle("a", "by A"));
  s = byAgent(s, "ag-b", 1, retitle("b", "by B"));
  s = applyEdit(s, { actor: "user", ops: [{ op: "move_item", item: "b", start: 50 } as Op] });
  const names: Record<string, string> = { "ag-a": "Graphics", "ag-b": "Cuts" };
  const forB = (e: LogEntry) => e.actor === "user" || (e.agentId !== undefined && e.agentId !== "ag-b");
  const nameForB = (e: LogEntry) => (e.actor === "agent" && e.agentId && e.agentId !== "ag-b" ? names[e.agentId] : undefined);
  const note = othersEditsNote(start.project, s, 0, forB, nameForB);
  assert.match(note, /now at revision 3/);
  assert.match(note, /- by Graphics: Changed the text of a/);
  assert.match(note, /The user changed 1 thing by hand/);
  assert.doesNotMatch(note, /by Cuts/, "its own edit isn't news");
  const listed = manualEditsNote(s, 0, forB, nameForB);
  assert.match(listed, /- by Graphics: /);
  // With only the user among the others, the words are netEditsNote's (one agent, as before).
  const user = applyEdit(start, { actor: "user", ops: [retitle("a", "mine")] });
  assert.equal(othersEditsNote(start.project, user, 0, forB, nameForB), netEditsNote(start.project, user, 0, forB));
});

test("history.db: an existing db opens with no schema change, its turns belong to the default agent, agent rows get their agent from the turn", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-multi-history-")));
  try {
    const dir = join(root, "old.uncut");
    mkdirSync(dir);
    writeFileSync(join(dir, "project.json"), JSON.stringify(project()));
    // A history written as before several agents: one agent's turns, no agentId, no agent list.
    const h = HistoryDb.open(dir, {}, false);
    const p = project();
    let cursor = h.record({ kind: "initial", author: "user", revision: 0, label: "Created", project: p }, { past: [], future: [] });
    const s1 = applyEdit(createSession(p), { actor: "agent", turnId: "turn-old", ops: [retitle("a", "old agent")] });
    cursor = h.record(
      { kind: "edit", author: "agent", revision: 1, label: "Retitle", lines: ["Retitle"], ops: s1.log[0]!.ops, turnId: "turn-old", project: s1.project },
      { past: [...cursor.past, 0], future: [] },
    );
    h.saveAgent({
      sessionId: "sess-old",
      pendingNote: undefined,
      turns: [
        {
          id: "turn-old",
          prompt: "retitle",
          status: "done",
          startedAt: "2026-10-01T10:00:00.000Z",
          data: { id: "turn-old", prompt: "retitle", status: "done", startedAt: "2026-10-01T10:00:00.000Z", items: [], edits: [] },
        },
      ],
    });
    h.close();

    const again = HistoryDb.open(dir, {}, false);
    try {
      assert.equal(again.agent().turns.length, 1, "the default agent has the old turn");
      assert.equal(again.agent().sessionId, "sess-old");
      assert.equal(again.agent("ag-other").turns.length, 0);
      assert.deepEqual(
        storedAgents(again.agentList()).map((a) => [a.id, a.name, a.focus]),
        [["ag-main", "Editor", "general"]],
      );
      assert.equal(again.turnAgent("turn-old"), "ag-main");
      assert.equal(again.logAt(1).log[0]!.agentId, "ag-main", "restored log entries keep their agent (undo/redo)");
      // A second agent's turn and session sit beside the first's.
      again.saveAgentList(
        JSON.stringify([
          { id: "ag-main", name: "Editor", focus: "general", colour: "#5b8def", createdAt: "x" },
          { id: "ag-gfx", name: "Graphics", focus: "graphics", colour: "#3fb68b", createdAt: "y" },
        ]),
      );
      again.saveAgent({
        agentId: "ag-gfx",
        sessionId: "sess-gfx",
        pendingNote: "news",
        turns: [
          {
            id: "turn-gfx",
            prompt: "style",
            status: "done",
            startedAt: "2026-10-02T10:00:00.000Z",
            data: { id: "turn-gfx", agentId: "ag-gfx", prompt: "style", status: "done", startedAt: "2026-10-02T10:00:00.000Z", items: [], edits: [] },
          },
        ],
      });
      assert.equal(again.turnAgent("turn-gfx"), "ag-gfx");
      assert.deepEqual([again.agent("ag-gfx").sessionId, again.agent("ag-gfx").pendingNote, again.agent("ag-gfx").turns.length], ["sess-gfx", "news", 1]);
      assert.equal(again.agent().sessionId, "sess-old", "the default agent's session is untouched");
      assert.equal(again.agent().turns.length, 1);
    } finally {
      again.close();
    }
    const raw = new DatabaseSync(join(dir, "history.db"), { readOnly: true });
    try {
      assert.equal((raw.prepare("SELECT version FROM schema_version").get() as { version: number }).version, SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 1, "no schema bump: older builds keep reading it");
    } finally {
      raw.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
