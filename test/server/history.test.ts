// D71: history.db on its own (no server): revisions and their states survive reopening, patches
// rebuild every state exactly, logs leave undone turns out, compaction keeps the file bounded over
// 2000 edits, the agent's turns are stored, and a damaged, locked or newer history.db never throws:
// it becomes an in-memory history with a problem, leaving the file as it was.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyEdit, type Op, type Project, type Session } from "../../packages/core/src/index.ts";
import { HistoryDb, HISTORY_FILE, withHistory, type Cursor } from "../../apps/server/src/project/history.ts";
import { applyPatch, diff, sameJson } from "../../apps/server/src/project/jsonPatch.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-history-")));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const folder = () => {
  const dir = join(root, `p${++n}.uncut`);
  mkdirSync(dir);
  return dir;
};

const empty = (): Project =>
  ({
    format: "uncut/0",
    name: "H",
    canvas: { width: 1920, height: 1080, fps: 30 },
    media: [],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [] },
      { id: "main", kind: "video", role: "main", name: "Main", items: [] },
      { id: "audio", kind: "audio", name: "Audio", items: [] },
    ],
  }) as unknown as Project;

// A small deterministic PRNG, so a failure can be replayed.
const rng = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

/** A random valid edit against `p`: add, retitle, move or delete a text item, rename, add a track. */
function randomOps(p: Project, rand: () => number, i: number): Array<Op> {
  const items = p.tracks[0]!.items;
  const r = rand();
  if (!items.length || r < 0.35) {
    const start = items.reduce((end, it) => Math.max(end, (it.start ?? 0) + it.duration), 0);
    return [{ op: "insert_item", track: "text", item: { id: `t${i}`, type: "text", start, duration: 10 + Math.floor(rand() * 50), text: `Title ${i}` } } as Op];
  }
  const it = items[Math.floor(rand() * items.length)]!;
  if (r < 0.6) return [{ op: "update_item", item: it.id, set: { text: `Edited ${i} ${"x".repeat(Math.floor(rand() * 20))}` } } as Op];
  if (r < 0.7) return [{ op: "update_item", item: it.id, set: { style: { size: 40 + Math.floor(rand() * 100) } } } as Op];
  if (r < 0.85) return [{ op: "delete_item", item: it.id } as Op];
  if (r < 0.95) return [{ op: "update_project", set: { name: `Name ${i}` } } as Op];
  return [{ op: "add_track", track: { id: `extra${i}`, kind: "audio", name: `Extra ${i}` } } as Op];
}

/** A server-like driver: edits, ⌘Z / ⇧⌘Z and Undo turn recorded the way projects.ts does. */
class Driver {
  history: HistoryDb;
  session: Session;
  cursor: Cursor = { past: [], future: [] };
  constructor(dir: string, options = {}) {
    this.history = HistoryDb.open(dir, options);
    const head = this.history.head;
    if (head === undefined) {
      this.session = { project: empty(), revision: 0, log: [] };
      this.cursor = this.history.record({ kind: "initial", author: "user", revision: 0, label: "Created", project: this.session.project }, this.cursor);
    } else {
      this.session = { project: this.history.stateAt(head), revision: head, log: this.history.logAt(head).log };
      this.cursor = this.history.cursor;
    }
  }
  edit(ops: Array<Op>, actor: "user" | "agent" = "user", turnId?: string) {
    const prev = this.session.revision;
    this.session = applyEdit(this.session, { actor, ops, ...(turnId ? { turnId } : {}) });
    this.cursor = this.history.record(
      { kind: "edit", author: actor, revision: this.session.revision, label: `edit ${this.session.revision}`, ops, turnId, project: this.session.project },
      { past: [...this.cursor.past, prev], future: [] },
    );
  }
  move(from: "past" | "future") {
    const target = this.cursor[from].at(-1)!;
    const revision = this.session.revision + 1;
    const head = this.session.revision;
    const past = [...this.cursor.past];
    const future = [...this.cursor.future];
    (from === "past" ? past : future).pop();
    (from === "past" ? future : past).push(head);
    // Read before recording, as projects.ts does (a compaction may turn the target into history).
    const project = this.history.stateAt(target);
    const { log } = this.history.logAt(target);
    this.cursor = this.history.record({ kind: from === "past" ? "undo" : "redo", author: "user", revision, label: "", target }, { past, future });
    this.session = { project, revision, log };
  }
}

test("jsonPatch: diff then applyPatch rebuilds the target for random project changes, key order aside", () => {
  const rand = rng(7);
  let a: Session = { project: empty(), revision: 0, log: [] };
  for (let i = 1; i <= 300; i++) {
    const b = applyEdit(a, { actor: "user", ops: randomOps(a.project, rand, i) });
    const patch = diff(a.project, b.project);
    const rebuilt = applyPatch(structuredClone(a.project), JSON.parse(JSON.stringify(patch)));
    assert.ok(sameJson(rebuilt, b.project), `step ${i}`);
    a = b;
  }
  // A whole-value change and a __proto__ key stay data.
  assert.deepEqual(applyPatch({ a: 1 }, diff({ a: 1 }, [1, 2])), [1, 2]);
  const evil = applyPatch({}, [{ p: ["__proto__"], v: { polluted: true } }]) as Record<string, unknown>;
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.ok(Object.hasOwn(evil, "__proto__"));
});

test("revisions, states, the cursor and logs survive closing and reopening history.db", () => {
  const dir = folder();
  const d = new Driver(dir);
  const rand = rng(1);
  const states = new Map<number, Project>([[0, d.session.project]]);
  for (let i = 1; i <= 120; i++) {
    d.edit(randomOps(d.session.project, rand, i), i % 3 ? "user" : "agent", i % 3 ? undefined : `turn-${Math.floor(i / 9)}`);
    states.set(d.session.revision, d.session.project);
  }
  d.move("past");
  d.move("past");
  const head = d.session.revision;
  d.history.close();
  assert.ok(existsSync(join(dir, HISTORY_FILE)));

  const again = HistoryDb.open(dir);
  assert.equal(again.persistent, true);
  assert.equal(again.problem, undefined);
  assert.equal(again.head, head);
  assert.deepEqual(again.cursor, d.cursor);
  // Every edit's state comes back exactly (snapshots every 50 patches, patches in between).
  for (const [revision, project] of states) assert.ok(sameJson(again.stateAt(revision), project), `revision ${revision}`);
  // The undo rows restore their target's state, and the log there is the target's.
  assert.ok(sameJson(again.stateAt(head), states.get(again.resolve(head))));
  const { log, initial } = again.logAt(head);
  assert.equal(initial, 0);
  assert.equal(log.length, again.resolve(head), "every edit since the start, in order");
  assert.deepEqual(log.map((e) => e.revision), Array.from({ length: log.length }, (_, i) => i + 1));
  assert.ok(log.every((e) => e.actor === (e.revision % 3 ? "user" : "agent")));
  again.close();
});

test("an undone turn leaves the log; an external revision is a boundary the log starts after", () => {
  const dir = folder();
  const d = new Driver(dir);
  d.edit([{ op: "insert_item", track: "text", item: { id: "a", type: "text", start: 0, duration: 30, text: "A" } } as Op], "agent", "T1");
  d.edit([{ op: "insert_item", track: "text", item: { id: "b", type: "text", start: 30, duration: 30, text: "B" } } as Op], "user");
  const without = { ...d.session.project, tracks: d.session.project.tracks.map((t) => ({ ...t, items: t.items.filter((i) => i.id !== "a") })) } as Project;
  d.cursor = d.history.record({ kind: "undo-turn", author: "user", revision: 3, label: "Undid T1", undoTurn: "T1", project: without }, { past: [...d.cursor.past, 2], future: [] });
  assert.deepEqual(d.history.logAt(3).log.map((e) => e.revision), [2], "T1's edit is left out");
  assert.ok(sameJson(d.history.stateAt(3), without));
  const outside = { ...without, name: "Changed by git" } as Project;
  d.cursor = d.history.record({ kind: "external", author: "external", revision: 4, label: "Changed outside Uncut", project: outside }, { past: [], future: [] });
  assert.deepEqual(d.history.logAt(4), { log: [], initial: 4 });
  assert.equal(d.history.boundaryOf(4).kind, "external");
  assert.deepEqual(d.history.cursor, { past: [], future: [] });
  // History can still reach the revision before it.
  assert.ok(sameJson(d.history.stateAt(3), without));
  d.history.close();
});

test("2000 edits: compaction keeps the last 1000 revisions, the file stays small, every kept state and ⌘Z still work", () => {
  const dir = folder();
  const d = new Driver(dir);
  const rand = rng(42);
  const started = Date.now();
  const states = new Map<number, Project>();
  for (let i = 1; i <= 2000; i++) {
    d.edit(randomOps(d.session.project, rand, i), "user");
    if (i > 1850) states.set(d.session.revision, d.session.project);
  }
  const ms = Date.now() - started;
  assert.ok(d.history.size <= 1100, `${d.history.size} rows kept`);
  assert.ok(d.history.size >= 1000);
  assert.ok(d.cursor.past.length >= 999 && d.cursor.past.length <= 1100, `${d.cursor.past.length} undo steps`);
  const oldest = Math.min(...d.cursor.past);
  assert.ok(d.history.has(oldest) && !d.history.has(oldest - 1));
  assert.ok(d.history.row(oldest).boundary, "the oldest kept revision became a boundary with a snapshot");
  d.history.close();
  const size = statSync(join(dir, HISTORY_FILE)).size + (existsSync(join(dir, `${HISTORY_FILE}-wal`)) ? statSync(join(dir, `${HISTORY_FILE}-wal`)).size : 0);
  const projectSize = JSON.stringify(d.session.project).length;
  console.log(`# 2000 edits in ${ms} ms; history.db ${(size / 1024).toFixed(0)} KB (project ${(projectSize / 1024).toFixed(1)} KB)`);
  assert.ok(size < 8 * 1024 * 1024, `history.db is ${size} bytes`);

  const again = new Driver(dir);
  for (const [revision, project] of states) assert.ok(sameJson(again.history.stateAt(revision), project), `revision ${revision}`);
  // ⌘Z all the way back works and ends at the oldest kept revision.
  let steps = 0;
  while (again.cursor.past.length) {
    again.move("past");
    steps++;
  }
  assert.ok(steps >= 999, `${steps} undo steps after reopening`);
  assert.equal(again.history.resolve(again.session.revision), oldest);
  again.history.close();
});

test("the agent's turns, session and pending note are stored and come back; withHistory shares the open connection", () => {
  const dir = folder();
  const h = HistoryDb.open(dir);
  const turn = (id: string, status: string) => ({ id, prompt: `do ${id}`, status, startedAt: new Date().toISOString(), data: { id, prompt: `do ${id}`, status, items: [], edits: [] } });
  h.saveAgent({ sessionId: "s1", pendingNote: "note", turns: [turn("a", "done"), turn("b", "running")] });
  withHistory(dir, (shared) => {
    assert.equal(shared, h, "the open connection is used");
    shared.saveAgent({ sessionId: "s1", pendingNote: undefined, turns: [{ ...turn("b", "done"), startRevision: 3 }], order: ["a", "b"] });
  });
  h.close();
  const back = withHistory(dir, (other) => other.agent());
  assert.equal(back.sessionId, "s1");
  assert.equal(back.pendingNote, undefined);
  assert.deepEqual(back.turns.map((t: any) => [t.id, t.status]), [["a", "done"], ["b", "done"]]);
  const db = new DatabaseSync(join(dir, HISTORY_FILE));
  assert.deepEqual({ ...(db.prepare("SELECT start_revision, ord FROM turns WHERE id = 'b'").get() as object) }, { start_revision: 3, ord: 1 });
  db.close();
});

test("a damaged history.db opens as an in-memory history with a problem, and the file is left as it was", () => {
  const dir = folder();
  const file = join(dir, HISTORY_FILE);
  writeFileSync(file, "this is not a database ".repeat(200));
  const before = readFileSync(file);
  const d = new Driver(dir);
  assert.equal(d.history.persistent, false);
  assert.match(d.history.problem!, /history\.db is damaged/);
  assert.match(d.history.problem!, /aren't saved/);
  d.edit([{ op: "update_project", set: { name: "Still works" } } as Op]);
  d.move("past");
  assert.equal(d.session.project.name, "H", "undo works in memory");
  d.history.close();
  assert.deepEqual(readFileSync(file), before);
});

test("a history.db from a newer Uncut isn't touched: in memory, with why", () => {
  const dir = folder();
  const db = new DatabaseSync(join(dir, HISTORY_FILE));
  db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (99);");
  db.close();
  const h = HistoryDb.open(dir);
  assert.equal(h.persistent, false);
  assert.match(h.problem!, /newer version of Uncut/);
  h.close();
  const check = new DatabaseSync(join(dir, HISTORY_FILE));
  assert.equal((check.prepare("SELECT version FROM schema_version").get() as { version: number }).version, 99);
  check.close();
});

/** Another process holding history.db's write lock until told to let go. */
async function holdLock(file: string) {
  const child = spawn(process.execPath, ["-e", `const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(${JSON.stringify(file)});d.exec("PRAGMA journal_mode=WAL");d.exec("BEGIN IMMEDIATE");console.log("locked");process.stdin.on("data",()=>{d.exec("COMMIT");d.close();process.exit(0)})`], { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  return { release: () => new Promise<void>((resolve) => (child.once("exit", () => resolve()), child.stdin.write("x\n"))) };
}

test("a locked history.db: opening falls back to memory; a lock taken mid-session moves the history to memory with its revisions", async () => {
  const dir = folder();
  // Opened while another program holds the lock.
  const seed = new Driver(dir);
  seed.edit([{ op: "update_project", set: { name: "One" } } as Op]);
  seed.history.close();
  const lock = await holdLock(join(dir, HISTORY_FILE));
  try {
    const t0 = Date.now();
    const h = HistoryDb.open(dir, { busyMs: 200 });
    assert.equal(h.persistent, false);
    assert.match(h.problem!, /in use by another program/);
    assert.ok(Date.now() - t0 < 3000);
    h.close();
  } finally {
    await lock.release();
  }

  // Locked after opening: the next write waits, then the history continues in memory, keeping what it had.
  const d = new Driver(dir, { busyMs: 200 });
  assert.equal(d.history.persistent, true);
  d.edit([{ op: "update_project", set: { name: "Two" } } as Op]);
  const late = await holdLock(join(dir, HISTORY_FILE));
  try {
    d.edit([{ op: "update_project", set: { name: "Three" } } as Op]);
    assert.equal(d.history.persistent, false);
    assert.match(d.history.problem!, /in use by another program/);
    assert.equal(d.history.size, 4, "initial + three edits, all in memory");
    d.move("past");
    d.move("past");
    assert.equal(d.session.project.name, "One", "⌘Z reaches revisions saved before the lock");
  } finally {
    await late.release();
    d.history.close();
  }
});

test("two copies of Uncut on one history.db don't interleave: the second writer continues in memory on its own line", () => {
  const dir = folder();
  const a = new Driver(dir);
  a.edit([{ op: "update_project", set: { name: "A1" } } as Op]);
  // Another process opens the same file (a dev build next to the packaged app, a synced folder).
  const b = HistoryDb.open(dir, {}, false);
  const bHead = b.head!;
  a.edit([{ op: "update_project", set: { name: "A2" } } as Op]);
  const bProject = { ...b.stateAt(bHead), name: "B2" } as Project;
  b.record({ kind: "edit", author: "user", revision: bHead + 1, label: "B", project: bProject }, { past: [bHead], future: [] });
  assert.equal(b.persistent, false);
  assert.match(b.problem!, /another copy of Uncut/);
  assert.ok(sameJson(b.stateAt(bHead + 1), bProject), "B's own line, in memory");
  assert.equal(b.row(bHead + 1).label, "B");
  assert.deepEqual(b.cursor, { past: [bHead], future: [] });
  b.close();
  // The file is A's alone, and A keeps saving to it.
  assert.equal(a.history.persistent, true);
  a.edit([{ op: "update_project", set: { name: "A3" } } as Op]);
  assert.equal(a.history.persistent, true);
  a.history.close();
  const again = HistoryDb.open(dir);
  assert.equal(again.stateAt(again.head!).name, "A3");
  assert.equal(again.stateAt(bHead + 1).name, "A2", "B's write never reached the file");
  again.close();
});

test("an external revision keeps its parent: lineage (History's 'current') runs through it, the log and state still stop there", () => {
  const dir = folder();
  const d = new Driver(dir);
  d.edit([{ op: "update_project", set: { name: "Mine" } } as Op]);
  d.cursor = d.history.record({ kind: "external", author: "external", revision: 2, label: "Changed outside Uncut", project: { ...d.session.project, name: "Git" } as Project }, { past: [], future: [] });
  assert.deepEqual([...d.history.lineage(2)].sort(), [0, 1, 2]);
  assert.deepEqual(d.history.logAt(2), { log: [], initial: 2 });
  assert.equal(d.history.boundaryOf(2).kind, "external");
  assert.equal(d.history.stateAt(2).name, "Git");
  d.history.close();
});

test("jsonPatch: a splice of 200 000 items applies (inserted in chunks)", () => {
  const big = Array.from({ length: 200_000 }, (_, i) => i);
  const patch = diff({ list: [] }, { list: big });
  assert.deepEqual((applyPatch({ list: [] }, patch) as { list: Array<number> }).list.length, 200_000);
  const mid = applyPatch({ list: [-1, -2] }, [{ p: ["list"], s: [1, 0, big] }]) as { list: Array<number> };
  assert.deepEqual([mid.list.length, mid.list[0], mid.list[1], mid.list.at(-1)], [200_002, -1, 0, -2]);
});
