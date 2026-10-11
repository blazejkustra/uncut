// Phase 3: the server owns projects. Create, open, edit, undo/redo and recents over RPC,
// checked against what ends up on disk (D12 layout) and against @uncut/core's validator.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModules, validateProject } from "../packages/core/src/index.mjs";
import { BUNDLE, MEDIA, MODULES, connect, killAll, openSocket, startServer } from "./helpers/server.mjs";

const skip = existsSync(BUNDLE) && existsSync(MEDIA) ? false : "server bundle or media core not built (run pnpm build)";
const T = { skip, timeout: 30000 };

let root, modules;
const data = () => join(root, "data");
const onDisk = (dir) => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));

/** A fresh server and client sharing the test's data dir (so recents carry over). */
async function session(env = {}) {
  const server = await startServer({ env: { UNCUT_DATA_DIR: data(), ...env } });
  const client = await connect(server.ready.port, server.ready.token);
  return { ...client, server, end: async () => (client.close(), await server.stop()) };
}

const title = { id: "hello", type: "text", start: 0, duration: 60, text: "Hello", transform: { x: 100, y: 100 }, style: { preset: "text.title", size: 120 } };
const addTitle = { op: "insert_item", track: "text", item: title };

before(async () => {
  if (skip) return;
  // Real path: the server reports folders resolved through symlinks (/var is /private/var).
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-projects-")));
  modules = await loadModules(MODULES);
});
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("create makes the D12 folder with a valid empty project and opens it", T, async () => {
  const s = await session();
  try {
    const snap = await s.ok("project.create", { parentDir: root, name: "First" });
    const dir = join(root, "First.uncut");
    assert.equal(snap.dir, dir);
    assert.deepEqual({ revision: snap.revision, canUndo: snap.canUndo, canRedo: snap.canRedo }, { revision: 0, canUndo: false, canRedo: false });
    assert.deepEqual(readdirSync(dir).sort(), [".cache", ".gitignore", "graphics", "media", "project.json"]);
    for (const sub of [".cache", "graphics", "media"]) assert.ok(statSync(join(dir, sub)).isDirectory(), sub);
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), ".cache/\n");
    const project = onDisk(dir);
    assert.deepEqual(project, snap.project);
    assert.deepEqual(validateProject(project, modules), []);
    assert.equal(project.format, "uncut/0");
    assert.equal(project.name, "First");
    assert.deepEqual(project.canvas, { width: 1920, height: 1080, fps: 30 });
    assert.deepEqual(project.media, []);
    assert.deepEqual(project.tracks.map((t) => [t.kind, t.role ?? null, t.items.length]), [["text", null, 0], ["video", "main", 0], ["audio", null, 0]]);
    assert.deepEqual(await s.ok("project.get"), snap);

    const custom = await s.ok("project.create", { parentDir: root, name: "Vertical", canvas: { width: 1080, height: 1920, fps: 60 } });
    assert.deepEqual(custom.project.canvas, { width: 1080, height: 1920, fps: 60 });
  } finally {
    await s.end();
  }
});

test("create refuses an existing folder, a bad name and a missing parent", T, async () => {
  const s = await session();
  try {
    mkdirSync(join(root, "Taken.uncut"));
    writeFileSync(join(root, "Taken.uncut", "keep.txt"), "mine");
    const exists = await s.fail("project.create", { parentDir: root, name: "Taken" });
    assert.deepEqual([exists._tag, exists.reason], ["ProjectError", "exists"]);
    assert.deepEqual(readdirSync(join(root, "Taken.uncut")), ["keep.txt"]);
    for (const name of ["", "a/b", ".hidden", " padded"]) {
      assert.equal((await s.fail("project.create", { parentDir: root, name })).reason, "invalid-name", JSON.stringify(name));
    }
    assert.equal((await s.fail("project.create", { parentDir: join(root, "nope"), name: "X" })).reason, "missing");
    assert.equal(existsSync(join(root, "nope")), false);
  } finally {
    await s.end();
  }
});

test("before anything is open, get/edit/undo say so", T, async () => {
  const s = await session();
  try {
    for (const [tag, payload] of [["project.get"], ["project.edit", { ops: [addTitle] }], ["project.undo"], ["project.redo"]]) {
      assert.equal((await s.fail(tag, payload)).reason, "no-project", tag);
    }
  } finally {
    await s.end();
  }
});

test("edit saves atomically, survives a reopen, and undo/redo walk it back and forth", T, async () => {
  const dir = join(root, "Edits.uncut");
  let s = await session();
  try {
    await s.ok("project.create", { parentDir: root, name: "Edits" });
    const edited = await s.ok("project.edit", { ops: [addTitle], summary: "Add a title" });
    assert.deepEqual({ revision: edited.revision, canUndo: edited.canUndo, canRedo: edited.canRedo }, { revision: 1, canUndo: true, canRedo: false });
    assert.deepEqual(onDisk(dir).tracks[0].items, [title]);
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".tmp")), [], "no temp files left behind");
  } finally {
    await s.end();
  }

  // A new server process reads it back from disk.
  s = await session();
  try {
    const reopened = await s.ok("project.open", { dir });
    assert.deepEqual(reopened.project.tracks[0].items, [title]);
    assert.equal(reopened.canUndo, false);

    const moved = await s.ok("project.edit", { ops: [{ op: "update_item", item: "hello", set: { text: "Hi" } }] });
    assert.equal(moved.project.tracks[0].items[0].text, "Hi");
    const undone = await s.ok("project.undo");
    assert.equal(undone.project.tracks[0].items[0].text, "Hello");
    assert.deepEqual([undone.canUndo, undone.canRedo], [false, true]);
    assert.equal(onDisk(dir).tracks[0].items[0].text, "Hello");
    const redone = await s.ok("project.redo");
    assert.equal(redone.project.tracks[0].items[0].text, "Hi");
    assert.equal(onDisk(dir).tracks[0].items[0].text, "Hi");
    // Nothing more to redo: a no-op, not an error.
    assert.deepEqual(await s.ok("project.redo"), redone);
  } finally {
    await s.end();
  }
});

test("an invalid or malformed edit is refused with details and leaves the file alone", T, async () => {
  const s = await session();
  try {
    const { dir } = await s.ok("project.create", { parentDir: root, name: "Refusals" });
    await s.ok("project.edit", { ops: [addTitle] });
    const before = readFileSync(join(dir, "project.json"), "utf8");

    // A second title over the first one: the validator's overlap rule.
    const overlap = await s.fail("project.edit", { ops: [{ op: "insert_item", track: "text", item: { ...title, id: "again", start: 30 } }] });
    assert.equal(overlap._tag, "EditRefused");
    assert.match(overlap.message, /invalid/);
    assert.ok(overlap.details.some((d) => d.code === "overlap" && d.path === "/tracks/text/items/again"), JSON.stringify(overlap.details));

    const missing = await s.fail("project.edit", { ops: [{ op: "delete_item", item: "ghost" }] });
    assert.deepEqual([missing._tag, missing.message], ["EditRefused", 'Item "ghost" does not exist']);

    const malformed = await s.fail("project.edit", { ops: [{ op: "insert_item", track: "text" }] });
    assert.equal(malformed._tag, "EditRefused");

    // All or nothing: a valid op followed by a bad one changes nothing.
    const mixed = await s.fail("project.edit", { ops: [{ op: "update_item", item: "hello", set: { text: "Changed" } }, { op: "delete_item", item: "ghost" }] });
    assert.equal(mixed._tag, "EditRefused");

    assert.equal(readFileSync(join(dir, "project.json"), "utf8"), before);
    assert.equal((await s.ok("project.get")).revision, 1);
  } finally {
    await s.end();
  }
});

test("opening a missing or invalid folder is a typed error with readable details", T, async () => {
  const s = await session();
  try {
    const missing = await s.fail("project.open", { dir: join(root, "Nowhere.uncut") });
    assert.deepEqual([missing._tag, missing.reason], ["ProjectError", "missing"]);
    assert.match(missing.message, /does not exist/);

    const notJson = join(root, "NotJson.uncut");
    mkdirSync(notJson);
    writeFileSync(join(notJson, "project.json"), "{ nope");
    const bad = await s.fail("project.open", { dir: notJson });
    assert.equal(bad.reason, "invalid");
    assert.equal(bad.details[0].code, "json");

    const invalid = join(root, "Invalid.uncut");
    mkdirSync(invalid);
    writeFileSync(join(invalid, "project.json"), JSON.stringify({ format: "uncut/0", name: "Bad", canvas: { width: 1920, height: 1080, fps: 30 }, media: [], tracks: [{ id: "t", kind: "text", name: "T", items: [] }] }));
    const rules = await s.fail("project.open", { dir: invalid });
    assert.equal(rules.reason, "invalid");
    assert.deepEqual(rules.details.map((d) => d.code), ["main-track-count"]);
    assert.match(rules.details[0].message, /exactly one main track/);
    // A failed open doesn't open anything.
    assert.equal((await s.fail("project.get")).reason, "no-project");
  } finally {
    await s.end();
  }
});

test("recents are newest first, persist across a restart and drop deleted folders", T, async () => {
  rmSync(data(), { recursive: true, force: true });
  let s = await session();
  try {
    assert.deepEqual(await s.ok("recents.list"), []);
    await s.ok("project.create", { parentDir: root, name: "R1" });
    await s.ok("project.create", { parentDir: root, name: "R2" });
    await s.ok("project.open", { dir: join(root, "R1.uncut") });
    const list = await s.ok("recents.list");
    assert.deepEqual(list.map((r) => [r.name, r.dir]), [["R1", join(root, "R1.uncut")], ["R2", join(root, "R2.uncut")]]);
    assert.ok(list.every((r) => !Number.isNaN(Date.parse(r.openedAt))));
  } finally {
    await s.end();
  }
  assert.ok(existsSync(join(data(), "recents.json")));

  rmSync(join(root, "R1.uncut"), { recursive: true });
  s = await session();
  try {
    assert.deepEqual((await s.ok("recents.list")).map((r) => r.name), ["R2"]);
  } finally {
    await s.end();
  }
  assert.deepEqual(JSON.parse(readFileSync(join(data(), "recents.json"), "utf8")).map((r) => r.name), ["R2"]);
});

const tempFiles = (dir) => readdirSync(dir).filter((f) => f.includes(".tmp"));

test("prototype keys in ops are refused and can't produce an unopenable project.json", T, async () => {
  const s = await session();
  try {
    const { dir } = await s.ok("project.create", { parentDir: root, name: "Proto" });
    await s.ok("project.edit", { ops: [addTitle] });
    const before = readFileSync(join(dir, "project.json"), "utf8");
    // Sent as raw JSON, the way a client would: "__proto__" is an own key on the wire.
    for (const raw of [
      '{"op":"update_item","item":"hello","set":{"duration":null,"__proto__":{"duration":60}}}',
      '{"op":"update_project","set":{"media":null,"__proto__":{"media":[]}}}',
      '{"op":"insert_item","track":"text","item":{"id":"p2","__proto__":{"type":"text"}}}',
    ]) {
      const error = await s.fail("project.edit", { ops: [JSON.parse(raw)] });
      assert.equal(error._tag, "EditRefused", raw);
      assert.ok(error.details.some((d) => d.code === "unsafe-key"), JSON.stringify(error.details));
    }
    assert.equal(readFileSync(join(dir, "project.json"), "utf8"), before);
    const reopened = await s.ok("project.open", { dir });
    assert.deepEqual(reopened.project.tracks[0].items, [title]);
  } finally {
    await s.end();
  }
});

test("malformed ops are refused by the edit-ops schema, as are empty edits and renames", T, async () => {
  const s = await session();
  try {
    const { dir } = await s.ok("project.create", { parentDir: root, name: "Malformed" });
    await s.ok("project.edit", { ops: [addTitle] });
    const before = readFileSync(join(dir, "project.json"), "utf8");
    const cases = [
      [[], "ops"],
      [[{ op: "trim_item", item: "hello", edge: "end", frames: "10" }], "schema"],
      [[{ op: "delete_item", item: "hello", force: true }], "schema"],
      [[{ op: "update_item", item: "hello", set: { id: "renamed" } }], "rename"],
      [[{ op: "teleport", item: "hello" }], "unknown-op"],
    ];
    for (const [ops, code] of cases) {
      const error = await s.fail("project.edit", { ops });
      assert.equal(error._tag, "EditRefused", JSON.stringify(ops));
      assert.deepEqual(error.details.map((d) => d.code), [code], JSON.stringify(error.details));
    }
    assert.equal(readFileSync(join(dir, "project.json"), "utf8"), before);
  } finally {
    await s.end();
  }
});

test("revisions only go up: undo and redo get new numbers, a future baseRevision is refused", T, async () => {
  const s = await session();
  try {
    assert.equal((await s.ok("project.create", { parentDir: root, name: "Revisions" })).revision, 0);
    assert.equal((await s.ok("project.edit", { ops: [addTitle] })).revision, 1);
    const undone = await s.ok("project.undo");
    assert.deepEqual([undone.revision, undone.project.tracks[0].items.length], [2, 0]);
    const redone = await s.ok("project.redo");
    assert.deepEqual([redone.revision, redone.project.tracks[0].items.length], [3, 1]);
    const future = await s.fail("project.edit", { ops: [{ op: "update_item", item: "hello", set: { text: "x" } }], baseRevision: 99 });
    assert.deepEqual([future._tag, future.details[0].code], ["EditRefused", "base-revision"]);
    assert.equal((await s.ok("project.edit", { ops: [{ op: "update_item", item: "hello", set: { text: "x" } }], baseRevision: 3 })).revision, 4);
    // Opening another project doesn't reset the count either.
    assert.ok((await s.ok("project.create", { parentDir: root, name: "Revisions2" })).revision > 4);
  } finally {
    await s.end();
  }
});

test("a hand edit to project.json is never overwritten: edits are refused until a reload", T, async () => {
  const s = await session();
  try {
    const { dir } = await s.ok("project.create", { parentDir: root, name: "Hand" });
    await s.ok("project.edit", { ops: [addTitle] });
    const file = join(dir, "project.json");
    const hand = onDisk(dir);
    hand.tracks[0].items[0].text = "Typed by hand";
    writeFileSync(file, JSON.stringify(hand, null, 2));

    for (const [tag, payload] of [["project.edit", { ops: [{ op: "update_item", item: "hello", set: { duration: 90 } }] }], ["project.undo"]]) {
      const error = await s.fail(tag, payload);
      assert.deepEqual([error._tag, error.reason], ["ProjectError", "changed-on-disk"], tag);
    }
    assert.equal(onDisk(dir).tracks[0].items[0].text, "Typed by hand");

    // An invalid hand edit can't be reloaded; the session stays and still refuses to save.
    writeFileSync(file, "{ broken");
    const bad = await s.fail("project.reload");
    assert.equal(bad.reason, "invalid");
    assert.equal((await s.ok("project.get")).project.tracks[0].items[0].text, "Hello");
    writeFileSync(file, JSON.stringify(hand, null, 2));

    const reloaded = await s.ok("project.reload");
    assert.equal(reloaded.project.tracks[0].items[0].text, "Typed by hand");
    assert.deepEqual([reloaded.canUndo, reloaded.canRedo], [false, false]);
    const edited = await s.ok("project.edit", { ops: [{ op: "update_item", item: "hello", set: { duration: 90 } }] });
    assert.ok(edited.revision > reloaded.revision);
    assert.deepEqual([onDisk(dir).tracks[0].items[0].text, onDisk(dir).tracks[0].items[0].duration], ["Typed by hand", 90]);
  } finally {
    await s.end();
  }
});

test("clients hanging up mid-save never leave disk and memory disagreeing, nor temp files", { ...T, timeout: 60000 }, async () => {
  const s = await session();
  try {
    const { dir } = await s.ok("project.create", { parentDir: root, name: "Hammer" });
    // A big project so each save takes a moment.
    const items = Array.from({ length: 2000 }, (_, i) => ({ ...title, id: `t${i}`, start: i * 60, text: `Title ${i} `.repeat(20) }));
    await s.ok("project.edit", { ops: items.map((item) => ({ op: "insert_item", track: "text", item })) });
    const { port, token } = s.server.ready;
    for (let i = 0; i < 40; i++) {
      const ws = await openSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
      ws.send(JSON.stringify({ _tag: "Request", id: "1", tag: "project.edit", payload: { ops: [{ op: "update_item", item: `t${i}`, set: { text: `edit ${i}` } }] }, headers: [] }));
      // Hang up at varying points: before, during and after the server's save.
      await new Promise((r) => setTimeout(r, (i * 7) % 60));
      ws.close();
    }
    await new Promise((r) => setTimeout(r, 500));
    const now = await s.ok("project.get");
    assert.deepEqual(onDisk(dir), now.project);
    assert.ok(now.revision > 1, "some of the edits went through");
    assert.deepEqual(tempFiles(dir), []);
    // And it still saves fine afterwards.
    await s.ok("project.edit", { ops: [{ op: "update_item", item: "t0", set: { text: "after" } }] });
    assert.equal(onDisk(dir).tracks[0].items[0].text, "after");
  } finally {
    await s.end();
  }
});

test("a symlinked project.json stays a symlink; saves go through to its target", T, async () => {
  const s = await session();
  try {
    const { dir } = await s.ok("project.create", { parentDir: root, name: "Linked" });
    const real = join(root, "linked-target.json");
    writeFileSync(real, readFileSync(join(dir, "project.json")));
    rmSync(join(dir, "project.json"));
    symlinkSync(real, join(dir, "project.json"));
    await s.ok("project.open", { dir });
    await s.ok("project.edit", { ops: [addTitle] });
    assert.ok(lstatSync(join(dir, "project.json")).isSymbolicLink());
    assert.deepEqual(JSON.parse(readFileSync(real, "utf8")).tracks[0].items, [title]);
    assert.deepEqual(tempFiles(dir), []);
    assert.deepEqual(readdirSync(root).filter((f) => f.includes(".tmp")), []);
  } finally {
    await s.end();
  }
});

test("a create that fails halfway removes the folder it made, and only that", T, async () => {
  const s = await session({ UNCUT_TEST_FAULT: "create-after-mkdir" });
  try {
    const error = await s.fail("project.create", { parentDir: root, name: "Halfway" });
    assert.equal(error.reason, "io");
    assert.equal(existsSync(join(root, "Halfway.uncut")), false);
    assert.ok(existsSync(join(root, "First.uncut")), "other projects are untouched");
  } finally {
    await s.end();
  }
});

test("names with control characters or trailing dots and relative paths are refused", T, async () => {
  const s = await session();
  try {
    for (const name of ["tab\there", "bell\u0007", "dots.", "trailing "]) {
      assert.equal((await s.fail("project.create", { parentDir: root, name })).reason, "invalid-name", JSON.stringify(name));
    }
    assert.equal((await s.fail("project.create", { parentDir: "relative/dir", name: "X" })).reason, "invalid-path");
    assert.equal((await s.fail("project.open", { dir: "First.uncut" })).reason, "invalid-path");
  } finally {
    await s.end();
  }
});

test("recents dedupe by real path and drop entries whose project.json is gone", T, async () => {
  rmSync(data(), { recursive: true, force: true });
  const s = await session();
  try {
    await s.ok("project.create", { parentDir: root, name: "Dedupe" });
    const link = join(root, "alias.uncut");
    symlinkSync(join(root, "Dedupe.uncut"), link);
    const viaLink = await s.ok("project.open", { dir: link });
    assert.equal(viaLink.dir, join(root, "Dedupe.uncut"));
    assert.deepEqual((await s.ok("recents.list")).map((r) => r.dir), [join(root, "Dedupe.uncut")]);

    await s.ok("project.create", { parentDir: root, name: "Emptied" });
    rmSync(join(root, "Emptied.uncut", "project.json"));
    assert.deepEqual((await s.ok("recents.list")).map((r) => r.name), ["Dedupe"]);
  } finally {
    await s.end();
  }
});

test("close goes back to no project, and revisions keep climbing after a close", T, async () => {
  const s = await session();
  try {
    await s.ok("project.close"); // nothing open: a no-op
    await s.ok("project.create", { parentDir: root, name: "Closing" });
    const edited = await s.ok("project.edit", { ops: [addTitle] });
    await s.ok("project.close");
    assert.equal((await s.fail("project.get")).reason, "no-project");
    assert.equal((await s.fail("project.edit", { ops: [addTitle] })).reason, "no-project");
    const reopened = await s.ok("project.open", { dir: edited.dir });
    assert.ok(reopened.revision > edited.revision, `${reopened.revision} after ${edited.revision}`);
  } finally {
    await s.end();
  }
});

test("recents follow a rename (by edit, undo or reload)", T, async () => {
  rmSync(data(), { recursive: true, force: true });
  const s = await session();
  try {
    const { dir } = await s.ok("project.create", { parentDir: root, name: "Named" });
    const names = async () => (await s.ok("recents.list")).map((r) => r.name);
    await s.ok("project.edit", { ops: [{ op: "update_project", set: { name: "Renamed" } }] });
    assert.deepEqual(await names(), ["Renamed"]);
    await s.ok("project.undo");
    assert.deepEqual(await names(), ["Named"]);
    const hand = onDisk(dir);
    hand.name = "By hand";
    writeFileSync(join(dir, "project.json"), JSON.stringify(hand));
    await s.ok("project.reload");
    assert.deepEqual(await names(), ["By hand"]);
  } finally {
    await s.end();
  }
});

test("project.subscribe streams the open project: now, then every change, in order", T, async () => {
  const s = await session();
  try {
    const watch = s.subscribe("project.subscribe");
    await watch.until((v) => v === null);
    const created = await s.ok("project.create", { parentDir: root, name: "Watched" });
    await watch.until((v) => v?.revision === created.revision);
    const edited = await s.ok("project.edit", { ops: [{ op: "update_project", set: { name: "Watched 2" } }] });
    await watch.until((v) => v?.revision === edited.revision && v.project.name === "Watched 2");
    await s.ok("project.close");
    await watch.until((v, i, all) => all.at(-1) === null);
    const revisions = watch.values.filter(Boolean).map((v) => v.revision);
    assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b), "never goes backwards");
    // A late subscriber gets the current state straight away.
    const late = s.subscribe("project.subscribe");
    await late.until((v) => v === null);
  } finally {
    await s.end();
  }
});

test("names must be non-blank and at most 100 characters", T, async () => {
  const s = await session();
  try {
    const { dir } = await s.ok("project.create", { parentDir: root, name: "Short" });
    const blank = await s.fail("project.edit", { ops: [{ op: "update_project", set: { name: "   " } }] });
    assert.equal(blank.message, "A project needs a name.");
    const long = await s.fail("project.edit", { ops: [{ op: "update_project", set: { name: "x".repeat(101) } }] });
    assert.equal(long.message, "A project name can be at most 100 characters.");
    assert.equal((await s.ok("project.edit", { ops: [{ op: "update_project", set: { name: "y".repeat(100) } }] })).project.name.length, 100);
    assert.equal(onDisk(dir).name.length, 100);
    assert.equal((await s.fail("project.create", { parentDir: root, name: "z".repeat(101) })).reason, "invalid-name");
  } finally {
    await s.end();
  }
});
