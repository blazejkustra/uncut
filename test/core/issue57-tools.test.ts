// Issue #57 (D230): timeline tools. The tap-to-pick, hold-to-borrow key rule, and the blade's
// split planner (the item under the pointer at the snapped frame, locks respected, one edit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, resolveStarts, timelineProblems, type Item, type Project } from "../../packages/core/src/index.ts";
import { HOLD_MS, makeToolKeys, toolForKey, type Tool } from "../../apps/web/src/timeline/tools.ts";
import { bladeFrame, planBladeSplit } from "../../apps/web/src/timeline/edit.ts";

function keys() {
  let tool: Tool = "select";
  let clock = 0;
  const k = makeToolKeys(() => tool, (t) => void (tool = t), () => clock);
  return { k, tool: () => tool, wait: (ms: number) => void (clock += ms) };
}

test("tool keys: V, C, H pick tools; a tap keeps the tool, a hold gives the old one back on release", () => {
  assert.equal(toolForKey("c"), "blade");
  assert.equal(toolForKey("H"), "hand");
  assert.equal(toolForKey("v"), "select");
  assert.equal(toolForKey("s"), undefined);
  const { k, tool, wait } = keys();
  // Tap C: blade stays.
  k.down("blade", "c");
  wait(80);
  k.up("c");
  assert.equal(tool(), "blade");
  // Hold H: hand while it's down, blade again after.
  k.down("hand", "h");
  assert.equal(tool(), "hand");
  wait(HOLD_MS + 50);
  k.down("hand", "h", true);
  k.up("h");
  assert.equal(tool(), "blade");
  // A quick press used for a click (a pointer press while down) also springs back.
  k.down("select", "v");
  k.pointer();
  wait(60);
  k.up("v");
  assert.equal(tool(), "blade");
  // Losing the window while a key is down gives the tool back too.
  k.down("hand", "h");
  k.blur();
  assert.equal(tool(), "blade");
  // A release of a key that isn't the held one changes nothing.
  k.down("select", "v");
  k.up("c");
  assert.equal(tool(), "select");
});

const clip = (id: string, duration: number, extra: Partial<Item> = {}): Item => ({ id, type: "clip", media: "m", in: 0, duration, ...extra });
function project(lockMusic = false): Project {
  return {
    format: "uncut/0",
    name: "Blade",
    canvas: { width: 320, height: 180, fps: 30 },
    media: [{ id: "m", kind: "video", name: "a.mp4", path: "/a.mp4", probe: { frames: 600, fps: 30, width: 320, height: 180, hasAudio: true } }],
    tracks: [
      { id: "main", kind: "video", role: "main", name: "Main", items: [clip("a", 60), clip("b", 60, { gap: 30 })] },
      { id: "music", kind: "audio", name: "Music", items: [{ id: "s", type: "audio", media: "m", in: 0, start: 10, duration: 100 }], ...(lockMusic ? { locked: true } : {}) },
    ],
  };
}

test("blade: splits the item pressed at that frame (one edit); locked tracks and edges refuse", () => {
  const p = project();
  const plan = planBladeSplit(p, "b", 110);
  assert.ok(!("problem" in plan));
  assert.deepEqual(plan.ops, [{ op: "split_item", item: "b", at: 20, newId: "b-1" }]);
  const q = applyEdit(createSession(p), { actor: "user", ops: plan.ops }, timelineProblems).project;
  assert.deepEqual(Object.fromEntries(resolveStarts(q)), { a: 0, b: 90, "b-1": 110, s: 10 });
  // An audio item on a free track, not only main.
  const sound = planBladeSplit(p, "s", 50);
  assert.ok(!("problem" in sound));
  assert.deepEqual(sound.ops, [{ op: "split_item", item: "s", at: 40, newId: "s-1" }]);
  // On an edge there's nothing to cut.
  const edge = planBladeSplit(p, "b", 90);
  assert.ok(!("problem" in edge));
  assert.deepEqual(edge.ops, []);
  assert.match((planBladeSplit(project(true), "s", 50) as { problem: string }).problem, /locked/);
});

test("blade frame: snaps to the playhead, other items' edges and markers within the threshold, not to its own edges", () => {
  const p = { ...project(), markers: [{ frame: 75 }] };
  // b starts at 90: an edge of another item (a ends at 60, s ends at 110).
  assert.deepEqual(bladeFrame(p, "b", 108, { playhead: 0, threshold: 3 }), { frame: 110, snapAt: 110 });
  assert.deepEqual(bladeFrame(p, "a", 33, { playhead: 31, threshold: 3 }), { frame: 31, snapAt: 31 });
  assert.deepEqual(bladeFrame(p, "s", 74, { playhead: 0, threshold: 3 }), { frame: 75, snapAt: 75 });
  // Its own start (90) isn't a target: the press stays where it is.
  assert.deepEqual(bladeFrame(p, "b", 92.4, { playhead: 0, threshold: 3 }), { frame: 92 });
  // Snapping off.
  assert.deepEqual(bladeFrame(p, "b", 108, undefined), { frame: 108 });
});

// D248 (review Low of #57): a clip whose linked sound is locked can't be cut (the sound would stay
// whole, following only the first half); the blade line takes its refusal from planBladeSplit, so
// it's grey exactly when a click would be refused.
test("blade: a clip whose linked sound is locked (track or item) is refused, saying why", () => {
  const withMic = (trackLocked: boolean, itemLocked: boolean): Project => {
    const p = project();
    return { ...p, tracks: [p.tracks[0]!, { id: "voice", kind: "audio", name: "Voice", items: [{ id: "mic", type: "audio", media: "m", in: 0, start: 90, duration: 60, linkedTo: "b", ...(itemLocked ? { locked: true } : {}) }], ...(trackLocked ? { locked: true } : {}) }] };
  };
  assert.match((planBladeSplit(withMic(true, false), "b", 110) as { problem: string }).problem, /linked sound is on the Voice track, which is locked/);
  assert.match((planBladeSplit(withMic(false, true), "b", 110) as { problem: string }).problem, /linked sound is locked/);
  // Unlocked: one split_item; the sound splits with it as the server applies it (D123).
  const plan = planBladeSplit(withMic(false, false), "b", 110);
  assert.ok(!("problem" in plan));
  assert.equal(plan.ops.length, 1);
});
