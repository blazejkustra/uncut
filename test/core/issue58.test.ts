// Issue #58 (D229): a selection or a linked group with main clips moves together. Main clips keep
// their order and the spaces between them (D224 gaps), the other main clips stay put unless one
// lands on them, linked sounds follow (still linked), and it's one edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, loadModules, resolveStarts, timelineProblems, validateProject, type Item, type Op, type Project } from "../../packages/core/src/index.ts";
import { shiftMainItems, withLinkedAudio } from "../../packages/core/src/timeline/arrange.ts";
import { draftOf, planGroupMove } from "../../apps/web/src/timeline/edit.ts";

const modules = await loadModules("spec/modules/builtin");
const clip = (id: string, duration: number, extra: Partial<Item> = {}): Item => ({ id, type: "clip", media: "m", in: 100, duration, ...extra });
function projectWith(main: ReadonlyArray<Item>, audio: ReadonlyArray<Item> = [], over: ReadonlyArray<Item> = [], locked = false): Project {
  return {
    format: "uncut/0",
    name: "Group",
    canvas: { width: 320, height: 180, fps: 30 },
    media: [{ id: "m", kind: "video", name: "Talk.mp4", path: "/tmp/Talk.mp4", probe: { frames: 900, fps: 30, width: 320, height: 180, hasAudio: true } }],
    tracks: [
      { id: "over", kind: "text", name: "Text", items: over },
      { id: "main", kind: "video", role: "main", name: "Main", items: main, ...(locked ? { locked: true } : {}) },
      { id: "voice", kind: "audio", name: "Voice", items: audio },
    ],
  };
}
const lanes = ["over", "main", "voice"];
const ok = <T extends object>(plan: T): Exclude<T, { readonly problem: string }> => {
  assert.ok(!("problem" in plan), "problem" in plan ? String(plan.problem) : "");
  return plan as Exclude<T, { readonly problem: string }>;
};
/** As the server applies it: the ops plus what keeps linked items in step (D123). */
const run = (p: Project, ops: ReadonlyArray<Op>) => {
  const s = applyEdit(createSession(p), { actor: "user", ops: withLinkedAudio(p, ops) }, timelineProblems).project;
  assert.deepEqual(validateProject(s, modules), []);
  return s;
};
const at = (p: Project) => Object.fromEntries(resolveStarts(p));
const order = (p: Project) => p.tracks.find((t) => t.role === "main")!.items.map((i) => i.id);
const item = (p: Project, id: string) => p.tracks.flatMap((t) => t.items).find((i) => i.id === id)!;

test("a main clip and its linked sound move together: the clip leaves a gap, the sound follows still linked", () => {
  const p = projectWith([clip("a", 30), clip("b", 30), clip("c", 30)], [{ id: "mic", type: "audio", media: "m", in: 100, start: 30, duration: 30, linkedTo: "b" }]);
  const plan = ok(planGroupMove(p, ["b", "mic"], 20, 0, lanes));
  assert.equal(plan.delta, 20);
  // The sound gets no op of its own (a move would unlink it).
  assert.ok(!plan.ops.some((o) => "item" in o && o.item === "mic"));
  const q = run(p, plan.ops);
  assert.deepEqual(order(q), ["a", "b", "c"]);
  // b slides right into c, which is pushed later; a stays.
  assert.deepEqual(at(q), { a: 0, b: 50, c: 80, mic: 50 });
  assert.equal(item(q, "mic").linkedTo, "b");
  // The renderer's draft agrees (same rules, linked sound included).
  const draft = draftOf(p, plan.ops);
  assert.ok(!("problem" in draft));
  assert.equal(resolveStarts(draft.project).get("mic"), 50);
});

test("selected main clips keep their order and spaces; they pass an unselected clip as one block", () => {
  const p = projectWith([clip("a", 30), clip("b", 30), clip("c", 30, { gap: 10 }), clip("d", 30)]);
  // a and b (one block, 0–60) move right by 70: its middle (100) passes c's (85), not d's (115).
  const plan = ok(planGroupMove(p, ["a", "b"], 70, 0, lanes));
  const q = run(p, plan.ops);
  assert.deepEqual(order(q), ["c", "a", "b", "d"]);
  // c stays at 70; a lands on it and is pushed to its end, b right after a; d is pushed too.
  assert.deepEqual(at(q), { c: 70, a: 100, b: 130, d: 160 });
  // Leftwards: clamped at frame 0 for the earliest of the group.
  const left = ok(planGroupMove(p, ["c", "d"], -200, 0, lanes));
  assert.equal(left.delta, -70);
  const r = run(p, left.ops);
  assert.deepEqual(order(r), ["a", "c", "d", "b"]);
  assert.deepEqual(at(r), { a: 0, c: 30, d: 60, b: 90 });
});

test("every main clip selected: the whole spine moves, the first one gets the gap; with an overlay", () => {
  const p = projectWith([clip("a", 30), clip("b", 30, { gap: 15 })], [], [{ id: "t", type: "text", text: "Hi", start: 5, duration: 20 }]);
  const plan = ok(planGroupMove(p, ["a", "b", "t"], 40, 0, lanes));
  const q = run(p, plan.ops);
  assert.deepEqual(order(q), ["a", "b"]);
  assert.deepEqual(at(q), { a: 40, b: 85, t: 45 });
  assert.equal(item(q, "a").gap, 40);
  assert.equal(item(q, "b").gap, 15);
  // Dragged across lanes with main clips in it: the group moves in time only.
  const across = ok(planGroupMove(p, ["a", "t"], 10, 1, lanes));
  const r = run(p, across.ops);
  assert.equal(item(r, "t").start, 15);
  assert.ok(p.tracks[0]!.items.some((i) => i.id === "t") && r.tracks[0]!.items.some((i) => i.id === "t"));
});

test("transitions go where the cut changes or a gap opens, and stay between clips that move together", () => {
  const tr = { module: "transition.crossfade", duration: 6 };
  const p = projectWith([clip("a", 30), clip("b", 30, { transitionIn: tr }), clip("c", 30, { transitionIn: tr }), clip("d", 30, { transitionIn: tr })]);
  const plan = ok(planGroupMove(p, ["b", "c"], 10, 0, lanes));
  const q = run(p, plan.ops);
  // b now follows a gap (its transition goes); c still meets b and d still meets c (kept).
  assert.equal(item(q, "b").transitionIn, undefined);
  assert.deepEqual(item(q, "c").transitionIn, tr);
  assert.deepEqual(item(q, "d").transitionIn, tr);
  assert.deepEqual(at(q), { a: 0, b: 40, c: 70, d: 100 });
  assert.deepEqual(timelineProblems(q), []);
});

test("a locked main track or clip is still refused; nothing moves for a zero shift", () => {
  const p = projectWith([clip("a", 30), clip("b", 30)], [], [], true);
  assert.match((planGroupMove(p, ["a", "b"], 10, 0, lanes) as { problem: string }).problem, /locked/);
  const q = projectWith([clip("a", 30), clip("b", 30, { locked: true })]);
  assert.match((planGroupMove(q, ["a", "b"], 10, 0, lanes) as { problem: string }).problem, /locked/);
  assert.deepEqual(ok(planGroupMove(q, ["a"], 0, 0, lanes)).ops, []);
});

test("core shiftMainItems: reorders with the fewest moves and returns where each lands", () => {
  const track = { items: [clip("a", 30), clip("b", 30), clip("c", 30), clip("d", 30)] };
  const { ops, starts } = shiftMainItems(track, new Set(["a"]), 100);
  // a's middle (115) passes d's (105): it goes last; b keeps its frame (a gap where a was).
  assert.deepEqual(ops.filter((o) => o.op === "move_item"), [{ op: "move_item", item: "a", index: 3 }]);
  assert.deepEqual([...starts], [["b", 30], ["c", 60], ["d", 90], ["a", 120]]);
  // Same order: gaps only, no move_item.
  const same = shiftMainItems({ items: [clip("a", 30), clip("b", 30, { gap: 50 })] }, new Set(["a"]), 20);
  assert.deepEqual(same.ops, [
    { op: "update_item", item: "a", set: { gap: 20 } },
    { op: "update_item", item: "b", set: { gap: 30 } },
  ]);
});
