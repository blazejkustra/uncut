// Issue #72 (D242): a text resized by a corner on the canvas (apps/web/src/preview/text.ts
// planTextScale): the drag's factor goes to the font size, a box width scales with it, the corner
// opposite the dragged one stays; one update_item that the validator accepts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, loadModules, validateProject, type Item, type Op, type Project } from "../../packages/core/src/index.ts";
import { planTextScale } from "../../apps/web/src/preview/text.ts";

const modules = await loadModules("spec/modules/builtin");
const title: Item = {
  id: "t",
  type: "text",
  start: 0,
  duration: 90,
  text: "Title",
  transform: { x: 200, y: 400 },
  style: { preset: "text.title", size: 100, weight: 700 },
};
const project = (item: Item): Project => ({
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [item] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [] },
  ],
});
const drawn = { x: 200, y: 400, w: 300, h: 120 };

function apply(p: Project, plan: ReturnType<typeof planTextScale>) {
  assert.ok("ops" in plan, `planned: ${"problem" in plan ? plan.problem : ""}`);
  assert.equal(plan.ops.length, 1, "one op: one edit, one undo");
  const next = applyEdit(createSession(p), { actor: "user", ops: plan.ops as ReadonlyArray<Op> }).project;
  assert.deepEqual(validateProject(next, modules), []);
  return next.tracks[0]!.items[0]!;
}

test("the bottom-right corner doubles the font size; the top-left stays", () => {
  const it = apply(project(title), planTextScale(project(title), "t", 2, "se", drawn));
  assert.equal(it.style?.size, 200);
  assert.deepEqual(it.transform, { x: 200, y: 400 });
  assert.equal(it.style?.weight, 700, "the rest of the style is kept");
});

test("the top-left corner halves it; the bottom-right corner stays", () => {
  const it = apply(project(title), planTextScale(project(title), "t", 0.5, "nw", drawn));
  assert.equal(it.style?.size, 50);
  assert.deepEqual(it.transform, { x: 350, y: 460 });
});

test("top-right and bottom-left anchor the other two corners", () => {
  assert.deepEqual(apply(project(title), planTextScale(project(title), "t", 1.5, "ne", drawn)).transform, { x: 200, y: 340 });
  assert.deepEqual(apply(project(title), planTextScale(project(title), "t", 1.5, "sw", drawn)).transform, { x: 50, y: 400 });
});

test("a box width scales with the size; the size stays a whole pixel of at least 1", () => {
  const boxed: Item = { ...title, transform: { x: 200, y: 400, w: 800 } };
  const it = apply(project(boxed), planTextScale(project(boxed), "t", 1.25, "se", drawn));
  assert.equal(it.style?.size, 125);
  assert.equal(it.transform?.w, 1000);
  assert.equal(apply(project(title), planTextScale(project(title), "t", 0.001, "se", drawn)).style?.size, 1);
});

test("a text with no size of its own starts from its look's", () => {
  const bare: Item = { id: "t", type: "text", start: 0, duration: 90, text: "Hi", style: { preset: "text.title" } };
  const it = apply(project(bare), planTextScale(project(bare), "t", 2, "se", drawn));
  assert.ok((it.style?.size ?? 0) > 100, `size ${it.style?.size}`);
  assert.equal(typeof it.transform?.x, "number", "the position is written with it");
});

test("an unchanged size plans nothing; a missing item is a problem", () => {
  const p = planTextScale(project(title), "t", 1, "se", drawn);
  assert.ok("ops" in p && p.ops.length === 0);
  assert.ok("problem" in planTextScale(project(title), "nope", 2, "se", drawn));
});
