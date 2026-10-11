// Phase 3: @uncut/core guards against ops that would reach an object's prototype, and checks
// ops against the edit-ops schema before anything is applied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, EditError, validateOps } from "../packages/core/src/index.mjs";

const project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [{ id: "hello", type: "text", start: 0, duration: 60, text: "Hi", transform: { x: 0, y: 0 }, style: { size: 100 } }] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [] },
  ],
};
// What a JSON client sends: "__proto__" arrives as an ordinary own key.
const fromJson = (value) => JSON.parse(JSON.stringify(value).replace('"proto"', '"__proto__"'));

test("merge refuses __proto__, constructor and prototype instead of touching the prototype", () => {
  const cases = [
    fromJson({ op: "update_item", item: "hello", set: { duration: null, proto: { duration: 60 } } }),
    fromJson({ op: "update_project", set: { media: null, proto: { media: [] } } }),
    { op: "update_item", item: "hello", set: { constructor: { x: 1 } } },
    { op: "update_track", track: "text", set: { prototype: 1 } },
  ];
  for (const op of cases) {
    const session = createSession(project);
    assert.throws(() => applyEdit(session, { actor: "user", ops: [op] }), EditError, JSON.stringify(op));
    assert.equal(Object.getPrototypeOf(session.project.tracks[0].items[0]), Object.prototype);
    assert.equal(session.project.tracks[0].items[0].duration, 60);
  }
  assert.equal({}.duration, undefined, "Object.prototype is untouched");
});

test("validateOps checks ops against the edit-ops schema and refuses renames and prototype keys", () => {
  assert.deepEqual(validateOps([{ op: "trim_item", item: "hello", edge: "end", frames: 10 }]), []);
  const codes = (ops) => validateOps(ops).map((e) => e.code);
  assert.deepEqual(codes([]), ["ops"]);
  assert.deepEqual(codes([{ op: "trim_item", item: "hello", edge: "end", frames: "10" }]), ["schema"]);
  assert.deepEqual(codes([{ op: "delete_item", item: "hello", extra: true }]), ["schema"]);
  assert.deepEqual(codes([{ op: "explode" }]), ["unknown-op"]);
  assert.deepEqual(codes([{ op: "update_item", item: "hello", set: { id: "other" } }]), ["rename"]);
  assert.ok(codes([fromJson({ op: "insert_item", track: "text", item: { id: "x", proto: {} } })]).includes("unsafe-key"));
  const [frames] = validateOps([{ op: "trim_item", item: "hello", edge: "end", frames: "10" }]);
  assert.equal(frames.path, "/0/frames");
});
