// Slip and roll: the ops in the engine (sync kept, limits, locks, linked sound, conflicts, words in
// the log), the planners behind the tools, and their keys in all four keymaps.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEdit,
  createSession,
  describeOp,
  EditConflict,
  EditError,
  layout,
  validateOps,
  validateProject,
  loadModules,
  type Op,
  type Project,
} from "../../packages/core/src/index.ts";
import { withLinkedAudio } from "../../packages/core/src/timeline/arrange.ts";
import { conflicts, presetBindings, PRESETS } from "../../apps/web/src/editor/keymap.ts";
import { planRoll, planSlip, rollTarget } from "../../apps/web/src/timeline/edit/slipRoll.ts";
import { findItem } from "../../apps/web/src/timeline/edit/base.ts";

const modules = await loadModules("spec/modules/builtin");
const probe = { frames: 300, fps: 30, width: 1280, height: 720, hasAudio: true };
const base: Project = {
  format: "uncut/0",
  name: "Cut",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "m-a", kind: "video", name: "a.mp4", path: "/x/a.mp4", probe },
    { id: "m-still", kind: "image", name: "s.png", path: "/x/s.png" },
  ],
  tracks: [
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "c1", type: "clip", media: "m-a", in: 50, duration: 100, gainKeys: [{ frame: 40, db: -6 }] },
        { id: "c2", type: "clip", media: "m-a", in: 100, duration: 100 },
        { id: "c3", type: "clip", media: "m-still", duration: 50 },
        { id: "c4", type: "clip", media: "m-a", in: 0, gap: 20, duration: 100 },
      ],
    },
    {
      id: "over",
      kind: "video",
      name: "Over",
      items: [
        { id: "o1", type: "clip", media: "m-a", in: 10, start: 0, duration: 30 },
        { id: "o2", type: "clip", media: "m-a", in: 60, start: 30, duration: 30 },
      ],
    },
  ],
};

const apply = (ops: ReadonlyArray<Op>, project = base, actor: "user" | "agent" = "user") =>
  applyEdit(createSession(project), { actor, ops }, (p) => validateProject(p, modules)).project;
const item = (p: Project, id: string) => p.tracks.flatMap((t) => t.items).find((i) => i.id === id)!;
const with_ = (id: string, set: object): Project => ({
  ...base,
  tracks: base.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.id === id ? { ...i, ...set } : i)) })),
});

test("the ops are well-formed in the schema, 0 frames isn't", () => {
  assert.deepEqual(
    validateOps([
      { op: "slip_item", item: "c1", frames: 5 },
      { op: "roll_edit", item: "c1", frames: -5 },
    ]),
    [],
  );
  assert.equal(validateOps([{ op: "slip_item", item: "c1", frames: 0 }]).length > 0, true);
});

test("slip: other frames in the same place, keys kept, nothing else moves", () => {
  const before = layout(base).starts;
  const after = apply([{ op: "slip_item", item: "c1", frames: 20 }]);
  assert.equal(item(after, "c1").in, 70);
  assert.equal(item(after, "c1").duration, 100);
  assert.deepEqual(item(after, "c1").gainKeys, [{ frame: 40, db: -6 }]);
  assert.deepEqual(layout(after).starts, before);
  assert.equal(item(apply([{ op: "slip_item", item: "c1", frames: 10 }], with_("c1", { speed: 2, duration: 50 })), "c1").in, 70);
});

test("slip: refused past the media, on a still, and on a lock", () => {
  assert.throws(() => apply([{ op: "slip_item", item: "c1", frames: -51 }]), /before its media.*50 frames/);
  assert.throws(() => apply([{ op: "slip_item", item: "c1", frames: 151 }]), /invalid/);
  assert.throws(() => apply([{ op: "slip_item", item: "c3", frames: 5 }]), /no media time/);
  assert.throws(() => apply([{ op: "slip_item", item: "c1", frames: 5 }], with_("c1", { locked: true })), EditError);
});

test("roll: the cut moves, the edit's length and everything else stay, on main and on a free track", () => {
  const later = apply([{ op: "roll_edit", item: "c1", frames: 30 }]);
  assert.deepEqual([item(later, "c1").duration, item(later, "c2").duration, item(later, "c2").in], [130, 70, 130]);
  assert.equal(layout(later).duration, layout(base).duration);
  assert.equal(layout(later).starts.get("c3"), layout(base).starts.get("c3"));
  const earlier = apply([{ op: "roll_edit", item: "c1", frames: -20 }]);
  assert.deepEqual([item(earlier, "c1").duration, item(earlier, "c2").duration, item(earlier, "c2").in], [80, 120, 80]);
  assert.deepEqual(item(earlier, "c1").gainKeys, [{ frame: 40, db: -6 }]);
  const free = apply([{ op: "roll_edit", item: "o1", frames: 5 }]);
  assert.deepEqual([item(free, "o1").duration, item(free, "o2").start, item(free, "o2").duration, item(free, "o2").in], [35, 35, 25, 65]);
});

test("roll: refused with no neighbour, past the media, or when either side is locked; never by the agent's hand on a locked neighbour", () => {
  assert.throws(() => apply([{ op: "roll_edit", item: "c3", frames: 5 }]), /Nothing plays right after/);
  assert.throws(
    () =>
      apply([
        { op: "roll_edit", item: "c1", frames: -5 },
        { op: "roll_edit", item: "c1", frames: 200 },
      ]),
    EditError,
  );
  assert.throws(() => apply([{ op: "roll_edit", item: "c1", frames: 5 }], with_("c2", { locked: true })), /locked/);
  assert.throws(() => apply([{ op: "roll_edit", item: "c1", frames: 5 }], with_("c1", { locked: true })), /locked/);
});

test("roll: a newer user edit of the item after the cut is a conflict for the agent", () => {
  let s = createSession(base);
  s = applyEdit(s, { actor: "user", ops: [{ op: "update_item", item: "c2", set: { name: "Hero" } }] });
  assert.throws(() => applyEdit(s, { actor: "agent", baseRevision: 0, ops: [{ op: "roll_edit", item: "c1", frames: 5 }] }), EditConflict);
});

test("a linked sound follows a slip and a roll of its clip", () => {
  const linked: Project = {
    ...base,
    tracks: [
      ...base.tracks,
      { id: "s", kind: "audio", name: "Sound", items: [{ id: "a1", type: "audio", media: "m-a", in: 50, start: 0, duration: 100, linkedTo: "c1" }] },
    ],
  };
  const slipped = apply(withLinkedAudio(linked, [{ op: "slip_item", item: "c1", frames: 20 }]), linked);
  assert.equal(item(slipped, "a1").in, 70);
  const rolled = apply(withLinkedAudio(linked, [{ op: "roll_edit", item: "c1", frames: 20 }]), linked);
  assert.equal(item(rolled, "a1").duration, 120);
});

test("the edit log says it in words", () => {
  assert.match(describeOp({ op: "slip_item", item: "c1", frames: 30 }, base), /Slipped .* later in its media/);
  assert.match(describeOp({ op: "roll_edit", item: "c1", frames: -30 }, base), /Rolled the cut after .* earlier/);
});

test("planSlip: a drag right shows earlier frames, clamped to the media both ways", () => {
  const plan = planSlip(base, "c1", 10);
  assert.ok(!("problem" in plan));
  assert.deepEqual(plan.ops, [{ op: "slip_item", item: "c1", frames: -10 }]);
  assert.deepEqual((planSlip(base, "c1", 500) as { ops: unknown }).ops, [{ op: "slip_item", item: "c1", frames: -50 }]);
  assert.deepEqual((planSlip(base, "c1", -500) as { ops: unknown }).ops, [{ op: "slip_item", item: "c1", frames: 150 }]);
  assert.ok("problem" in planSlip(base, "c3", 10));
  assert.ok("problem" in planSlip(with_("c1", { in: 0, duration: 300 }), "c1", 10));
  assert.ok("problem" in planSlip(with_("c1", { locked: true }), "c1", 10));
});

test("planRoll: clamped so both sides keep a frame and media; refuses locks and a lone item", () => {
  assert.deepEqual((planRoll(base, "c1", 500) as { ops: unknown }).ops, [{ op: "roll_edit", item: "c1", frames: 99 }]);
  assert.deepEqual((planRoll(base, "c1", -500) as { ops: unknown }).ops, [{ op: "roll_edit", item: "c1", frames: -99 }]);
  const tight = planRoll(with_("c2", { in: 3 }), "c1", -50) as { ops: unknown };
  assert.deepEqual(tight.ops, [{ op: "roll_edit", item: "c1", frames: -3 }]);
  assert.ok("problem" in planRoll(base, "c3", 10));
  assert.match((planRoll(with_("c2", { locked: true }), "c1", 10) as { problem: string }).problem, /locked/);
  assert.equal(rollTarget(findItem(base, "c2")!, true), "c1");
  assert.equal(rollTarget(findItem(base, "c2")!, false), "c2");
  assert.equal(rollTarget(findItem(base, "o2")!, true), "o1");
});

test("all four keymaps bind slip and roll, without a conflict", () => {
  const keys = Object.fromEntries(PRESETS.map((p) => [p.id, [presetBindings(p.id).toolSlip, presetBindings(p.id).toolRoll]]));
  assert.deepEqual(keys, { uncut: [["Y"], ["N"]], premiere: [["Y"], ["N"]], resolve: [["T"], ["⇧T"]], finalcut: [["T"], ["⇧T"]] });
  for (const p of PRESETS) assert.deepEqual(conflicts(presetBindings(p.id)), [], p.id);
});
