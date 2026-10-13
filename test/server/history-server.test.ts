// D71 on the bundled server (no window): history.db keeps revisions, the undo/redo cursor and the
// agent's turns across a close, a reopen and a server restart. A change made to project.json outside
// Uncut is an "external" revision ⌘Z stops at (with why); History can go back past it as a new,
// undoable revision. Concurrent edits land as consecutive revisions. A damaged history.db, or none at
// all, never stops the project from opening. agent/turns.json is moved in once. With the scripted
// claude: a turn made before a restart can still be undone after it, and the hand edit made before
// the restart reaches the next prompt.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { readAgentHistory, readRevisions } from "../helpers/history.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(BUNDLE) && existsSync(MCP) && existsSync(MEDIA) ? false : "server bundle or media core not built (run pnpm build)";
const T = { skip, timeout: 60000 };

let root = "";
before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-history-server-")));
});
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

const text = (id: string, start: number, words = id) => ({ id, type: "text", start, duration: 30, text: words, transform: { x: 100, y: 100 }, style: { preset: "text.title", size: 120 } });
const add = (id: string, start: number) => ({ ops: [{ op: "insert_item", track: "text", item: text(id, start) }], summary: `Add ${id}` });
const ids = (snap: any) => snap.project.tracks[0].items.map((i: any) => i.id);
const onDisk = (dir: string) => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));

/** A server (sharing the test's data dir unless told otherwise) with a client and a history stream. */
async function session(env: Record<string, string> = {}) {
  const server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data"), ...env } });
  const client = await connect(server.ready.port, server.ready.token);
  const history = client.subscribe("history.subscribe");
  return { ...client, server, history, latest: () => history.values.at(-1), end: async () => (client.close(), await server.stop()) };
}

test("revisions, ⌘Z and ⇧⌘Z survive a server restart; history.subscribe lists who did what", T, async () => {
  let s = await session();
  const { dir } = await s.ok("project.create", { parentDir: root, name: "Restart" });
  await s.ok("project.edit", add("a", 0));
  await s.ok("project.edit", add("b", 30));
  await s.ok("project.edit", add("c", 60));
  const undone = await s.ok("project.undo");
  assert.deepEqual(ids(undone), ["a", "b"]);
  await s.history.until((h) => h?.revision === undone.revision);
  const h = s.latest();
  assert.equal(h.persistent, true);
  assert.equal(h.problem, undefined);
  // Newest first, undo steps not listed; the undone edit isn't in the current version.
  assert.deepEqual(
    h.entries.map((e: any) => [e.revision, e.kind, e.author, e.label, e.current]),
    [
      [3, "edit", "user", "Add c", false],
      [2, "edit", "user", "Add b", true],
      [1, "edit", "user", "Add a", true],
      [0, "initial", "user", "Created the project", true],
    ],
  );
  assert.deepEqual(h.entries[0].lines, ["Added text c on track text"]);
  await s.end();

  s = await session();
  try {
    const reopened = await s.ok("project.open", { dir });
    assert.deepEqual([reopened.revision, reopened.canUndo, reopened.canRedo, ids(reopened)], [undone.revision, true, true, ["a", "b"]]);
    assert.deepEqual(ids(await s.ok("project.redo")), ["a", "b", "c"]);
    await s.ok("project.undo");
    const back = await s.ok("project.undo");
    assert.deepEqual([ids(back), back.canUndo], [["a"], true]);
    assert.deepEqual(onDisk(dir).tracks[0].items.map((i: any) => i.id), ["a"]);
    // Preview: the project at a revision, nothing changes.
    const preview = await s.ok("history.preview", { revision: 3 });
    assert.deepEqual(preview.project.tracks[0].items.map((i: any) => i.id), ["a", "b", "c"]);
    assert.deepEqual((await s.ok("project.get")).revision, back.revision);
    assert.equal((await s.fail("history.preview", { revision: 999 })).reason, "missing");
  } finally {
    await s.end();
  }
});

test("project.json changed while closed: an external revision, ⌘Z stops there and says why, History goes back past it (undoably)", T, async () => {
  const s = await session();
  try {
    const { dir } = await s.ok("project.create", { parentDir: root, name: "Outside" });
    const before = await s.ok("project.edit", add("mine", 0));
    await s.ok("project.close");
    // A git checkout / another editor: the title text changes and an item appears.
    const hand = onDisk(dir);
    hand.tracks[0].items[0].text = "From git";
    hand.tracks[0].items.push(text("theirs", 30));
    writeFileSync(join(dir, "project.json"), JSON.stringify(hand, null, 2));

    const opened = await s.ok("project.open", { dir });
    assert.equal(opened.revision, before.revision + 1, "the change is a revision of its own");
    assert.deepEqual([opened.canUndo, opened.canRedo], [false, false]);
    assert.match(opened.undoStop, /Undo stops at the change made to project\.json outside Uncut/);
    await s.history.until((h) => h?.revision === opened.revision);
    const [external] = s.latest().entries;
    assert.deepEqual([external.kind, external.author, external.label], ["external", "external", "Changed outside Uncut"]);
    assert.deepEqual(external.lines, ["Added theirs", "Changed mine"]);
    // What came before the outside change is still history the project grew from, not "undone".
    assert.deepEqual(s.latest().entries.map((e: any) => [e.kind, e.current]), [["external", true], ["edit", true], ["initial", true]]);
    // ⌘Z is a no-op here: the outside change isn't lost by accident.
    assert.deepEqual(await s.ok("project.undo"), opened);
    assert.equal(onDisk(dir).tracks[0].items[0].text, "From git");

    // Going back past it is explicit: a jump, which one ⌘Z takes back.
    const jumped = await s.ok("history.jump", { revision: before.revision });
    assert.deepEqual([jumped.revision, jumped.canUndo, ids(jumped)], [opened.revision + 1, true, ["mine"]]);
    assert.equal(onDisk(dir).tracks[0].items[0].text, "mine");
    await s.history.until((h) => h?.revision === jumped.revision);
    assert.deepEqual([s.latest().entries[0].kind, s.latest().entries[0].label], ["jump", 'Went back to "Add mine"']);
    const undone = await s.ok("project.undo");
    assert.deepEqual(ids(undone), ["mine", "theirs"]);
    assert.equal(onDisk(dir).tracks[0].items[0].text, "From git");
    // An unchanged reopen adds nothing.
    await s.ok("project.close");
    const again = await s.ok("project.open", { dir });
    assert.equal(again.revision, undone.revision);
    assert.equal(readRevisions(dir).rows.filter((r) => r.kind === "external").length, 1);
  } finally {
    await s.end();
  }
});

test("a hand edit while open, then Reload: an external revision ⌘Z stops at", T, async () => {
  const s = await session();
  try {
    const { dir } = await s.ok("project.create", { parentDir: root, name: "Reload" });
    await s.ok("project.edit", add("one", 0));
    const hand = onDisk(dir);
    hand.name = "Renamed by hand";
    writeFileSync(join(dir, "project.json"), JSON.stringify(hand));
    assert.equal((await s.fail("project.edit", add("two", 30))).reason, "changed-on-disk");
    const reloaded = await s.ok("project.reload");
    assert.deepEqual([reloaded.canUndo, reloaded.project.name], [false, "Renamed by hand"]);
    assert.match(reloaded.undoStop, /outside Uncut/);
    await s.history.until((h) => h?.revision === reloaded.revision);
    assert.ok(s.latest().entries.every((e: any) => e.current), "earlier entries aren't struck through after a Reload");
    const after = await s.ok("project.edit", add("two", 30));
    assert.equal(after.canUndo, true);
    const back = await s.ok("project.undo");
    assert.deepEqual([ids(back), back.canUndo, back.project.name], [["one"], false, "Renamed by hand"]);
    // Reloading a file that only changed its formatting records nothing.
    writeFileSync(join(dir, "project.json"), JSON.stringify(onDisk(dir)));
    const same = await s.ok("project.reload");
    assert.equal(same.revision, back.revision);
  } finally {
    await s.end();
  }
});

test("concurrent edits are serialised: consecutive revisions, one row each, and they all undo after a restart", T, async () => {
  let s = await session();
  const { dir } = await s.ok("project.create", { parentDir: root, name: "Burst" });
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => s.ok("project.edit", add(`t${i}`, i * 30))));
  assert.deepEqual(results.map((r) => r.revision).sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i + 1));
  await s.end();
  const { rows, meta } = readRevisions(dir);
  assert.deepEqual(rows.map((r) => r.revision), Array.from({ length: 41 }, (_, i) => i));
  assert.ok(rows.slice(1).every((r) => r.parent === r.revision - 1 && r.kind === "edit"));
  assert.equal(meta.get("head"), "40");
  assert.equal(JSON.parse(meta.get("past")!).length, 40);

  s = await session();
  try {
    let snap = await s.ok("project.open", { dir });
    assert.equal(ids(snap).length, 40);
    for (let i = 0; i < 40; i++) snap = await s.ok("project.undo");
    assert.deepEqual([ids(snap), snap.canUndo], [[], false]);
  } finally {
    await s.end();
  }
});

test("a damaged history.db never blocks opening: in memory with a note, the file left alone; a copy without history.db starts one", T, async () => {
  const s = await session();
  try {
    const { dir } = await s.ok("project.create", { parentDir: root, name: "Damaged" });
    const last = await s.ok("project.edit", add("kept", 0));
    await s.ok("project.close");
    for (const f of ["history.db-wal", "history.db-shm"]) rmSync(join(dir, f), { force: true });
    writeFileSync(join(dir, "history.db"), "garbage ".repeat(1000));
    const opened = await s.ok("project.open", { dir });
    assert.deepEqual(ids(opened), ["kept"], "project.json is the source of truth");
    assert.match(opened.historyProblem, /history\.db is damaged/);
    assert.ok(opened.revision > last.revision, "a history that starts over doesn't take the folder's revisions back");
    await s.history.until((h) => h?.dir === dir && h.persistent === false);
    assert.match(s.latest().problem, /aren't saved/);
    await s.ok("project.edit", add("more", 30));
    assert.deepEqual(ids(await s.ok("project.undo")), ["kept"], "undo works in memory");
    assert.equal(readFileSync(join(dir, "history.db"), "utf8"), "garbage ".repeat(1000));

    // The project copied to another Mac without its history.
    const copy = join(root, "Copied.uncut");
    mkdirSync(copy);
    cpSync(join(dir, "project.json"), join(copy, "project.json"));
    const fresh = await s.ok("project.open", { dir: copy });
    assert.deepEqual([fresh.revision, fresh.canUndo, fresh.historyProblem, ids(fresh)], [0, false, undefined, ["kept"]]);
    assert.deepEqual(readRevisions(copy).rows.map((r) => [r.kind, r.author, r.label]), [["initial", "import", "Opened project.json: the history starts here"]]);
  } finally {
    await s.end();
  }
});

test("agent/turns.json is moved into history.db once, then renamed", T, async () => {
  const s = await session();
  const agent = s.subscribe("agent.subscribe");
  try {
    const { dir } = await s.ok("project.create", { parentDir: root, name: "Migrate" });
    await s.ok("project.close");
    mkdirSync(join(dir, "agent"));
    const turn = { id: "turn-old", prompt: "an old turn", startedAt: "2026-10-01T10:00:00.000Z", finishedAt: "2026-10-01T10:00:05.000Z", status: "done", items: [{ kind: "text", text: "Done." }], edits: [] };
    writeFileSync(join(dir, "agent", "turns.json"), JSON.stringify({ format: "uncut.agent-history/0", provider: "claude", sessionId: "old-session", pendingNote: "The user did a thing.", turns: [turn] }));
    await s.ok("project.open", { dir });
    await agent.until((a) => a?.dir === dir && a.turns.length === 1);
    assert.equal(agent.values.at(-1).turns[0].prompt, "an old turn");
    const saved = readAgentHistory(dir);
    assert.deepEqual([saved.sessionId, saved.turns.map((t) => t.id)], ["old-session", ["turn-old"]]);
    assert.match(saved.pendingNote!, /The user did a thing\./, "the pending note came along (and keeps growing)");
    assert.equal(existsSync(join(dir, "agent", "turns.json")), false);
    assert.equal(readdirSync(join(dir, "agent")).filter((f) => /^turns\.migrated-\d+\.json$/.test(f)).length, 1, "kept as a backup, never read again");
    // Reopening doesn't bring it in twice.
    await s.ok("project.close");
    await s.ok("project.open", { dir });
    await agent.until((a, i) => a?.dir === dir && i > 2);
    assert.equal(readAgentHistory(dir).turns.length, 1);
  } finally {
    await s.end();
  }
});

test("scripted claude: a turn made before a restart is undone after it; the hand edit made before the restart reaches the next prompt", T, async () => {
  const base = join(root, "agent");
  mkdirSync(join(base, "projects"), { recursive: true });
  const plan = join(base, "plan.json");
  const log = join(base, "prompts.jsonl");
  writeFileSync(log, "");
  const env = { UNCUT_DATA_DIR: join(base, "data"), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan, FAKE_PROMPT_LOG: log };
  const turns: Array<unknown> = [
    [{ tool: "project_read" }, { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Add a title", ops: [{ op: "insert_item", track: "text", item: text("title-1", 0, "Kraków") }] } }, { text: "Added." }],
    [{ tool: "project_read" }, { text: "Looked." }],
  ];
  writeFileSync(plan, JSON.stringify(turns));
  const done = (agent: any, id: string) => agent.until((a: any) => a?.turns.some((t: any) => t.id === id && t.status !== "running"), 20000);

  let s = await session(env);
  let agent = s.subscribe("agent.subscribe");
  const { dir } = await s.ok("project.create", { parentDir: join(base, "projects"), name: "Turns" });
  const { turnId } = await s.ok("agent.send", { prompt: "add a title" });
  await done(agent, turnId);
  assert.equal(agent.values.at(-1).turns[0].status, "done");
  // By hand, after the turn: a second card the turn doesn't touch.
  await s.ok("project.edit", { ops: [{ op: "insert_item", track: "text", item: text("user-1", 60, "Mine") }], summary: "Add a card" });
  await s.end();

  s = await session(env);
  agent = s.subscribe("agent.subscribe");
  try {
    await s.ok("project.open", { dir });
    await agent.until((a) => a?.dir === dir && a.turns[0]?.undo.state === "available");
    const undone = await s.ok("agent.undoTurn", { turnId });
    assert.deepEqual(ids(undone), ["user-1"], "the turn's title goes, the later hand edit stays");
    await agent.until((a) => a?.turns[0]?.undo.state === "undone");
    const back = await s.ok("project.undo");
    assert.deepEqual(ids(back), ["title-1", "user-1"], "one ⌘Z brings the turn back");
    await s.history.until((h) => h?.revision === back.revision);
    const authors = s.latest().entries.map((e: any) => [e.kind, e.author, e.turnId ?? null]);
    assert.deepEqual(authors.slice(-3), [["edit", "user", null], ["edit", "agent", turnId], ["initial", "user", null]]);
    assert.ok(s.latest().entries.some((e: any) => e.kind === "undo-turn" && e.label.startsWith("Undid your turn")));

    const second = await s.ok("agent.send", { prompt: "anything to fix?" });
    await done(agent, second.turnId);
    const prompts = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(prompts.length, 2);
    assert.match(prompts[1].prompt, /Earlier, before the project was closed and reopened:/);
    assert.match(prompts[1].prompt, /Added text user-1 on track text/);
    assert.equal(prompts[1].resume, "fake-session", "the conversation continues after the restart");
  } finally {
    await s.end();
  }
});
