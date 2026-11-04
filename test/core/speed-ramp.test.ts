// D327: speed ramps (a clip's speedKeys) and reverse in core: the curve's source mapping, its
// inverse, what splits and trims keep, the planners, the rules and the reversed copy's seconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyEdit,
  audibleAt,
  createSession,
  EASES,
  layout,
  loadModules,
  localForSource,
  presetKeys,
  presetOf,
  RAMP_PRESETS,
  reverseRange,
  sourceAt,
  sourceFrames,
  sourceSpan,
  speedAt,
  timelineProblems,
  validateProject,
  visualsAt,
  type Item,
  type Op,
  type Project,
} from "../../packages/core/src/index.ts";
import { planDetachAudio, planReverse, planSetSpeed, planSpeedRamp } from "../../packages/core/src/timeline/arrange.ts";

const here = dirname(fileURLToPath(import.meta.url));
const modules = await loadModules(join(here, "../../spec/modules/builtin"));

const project = (items: Array<Item>, frames = 600, hasAudio = true): Project => ({
  format: "uncut/0",
  name: "Ramp",
  canvas: { width: 640, height: 360, fps: 30 },
  media: [{ id: "m", kind: "video", name: "clip.mp4", path: "/tmp/clip.mp4", probe: { frames, fps: 30, width: 320, height: 180, hasAudio } }],
  tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items }],
});
const edit = (p: Project, ops: ReadonlyArray<Op>) => applyEdit(createSession(p), { actor: "user", ops }).project;
const itemOf = (p: Project, id: string) => p.tracks.flatMap((t) => t.items).find((i) => i.id === id)!;

/** The curve's integral by the midpoint rule, from speedAt alone. */
const numeric = (item: Item, to: number, steps = 20000) => {
  let sum = 0;
  for (let i = 0; i < steps; i++) sum += speedAt(item, ((i + 0.5) / steps) * to);
  return (sum * to) / steps;
};

const ramp: Item = {
  id: "c",
  type: "clip",
  media: "m",
  in: 30,
  duration: 120,
  speedKeys: [
    { frame: 0, speed: 3, ease: "inOut" },
    { frame: 40, speed: 0.25 },
    { frame: 70, speed: 0.25, ease: "in" },
    { frame: 100, speed: 2, ease: "out" },
    { frame: 120, speed: 4 },
  ],
};

test("constant speed maps exactly as before (local × speed), with no keys", () => {
  for (const speed of [undefined, 1, 0.5, 1.37, 3]) {
    const item: Item = { id: "c", type: "clip", media: "m", in: 12, duration: 90, ...(speed ? { speed } : {}) };
    for (const local of [0, 1, 7, 33.5, 89]) {
      assert.equal(sourceFrames(item, local), local * (speed ?? 1));
      assert.equal(sourceAt(project([item]), item, local), (12 + local * (speed ?? 1)) / 30);
      assert.equal(localForSource(item, local * (speed ?? 1)), (local * (speed ?? 1)) / (speed ?? 1));
    }
    assert.equal(sourceSpan(item), 90 * (speed ?? 1));
  }
});

test("the curve: speeds eased between keys, held outside them; the mapping is its exact integral, monotonic, and inverts", () => {
  assert.equal(speedAt(ramp, -5), 3);
  assert.equal(speedAt(ramp, 0), 3);
  assert.equal(speedAt(ramp, 20), 3 + (0.25 - 3) * EASES.inOut(0.5));
  assert.equal(speedAt(ramp, 55), 0.25);
  assert.equal(speedAt(ramp, 85), 0.25 + (2 - 0.25) * EASES.in(0.5));
  assert.equal(speedAt(ramp, 200), 4);
  for (const t of [1, 13, 40, 55, 77.5, 100, 119, 120]) assert.ok(Math.abs(sourceFrames(ramp, t) - numeric(ramp, t)) < 1e-6, `integral at ${t}`);
  // Each ease's own integral over a whole segment: linear 1/2, in 1/4, out 3/4, inOut 1/2 of the step.
  for (const [ease, share] of [
    ["linear", 0.5],
    ["in", 0.25],
    ["out", 0.75],
    ["inOut", 0.5],
  ] as const) {
    const item: Item = {
      id: "x",
      type: "clip",
      media: "m",
      duration: 10,
      speedKeys: [
        { frame: 0, speed: 1, ease },
        { frame: 10, speed: 3 },
      ],
    };
    assert.ok(Math.abs(sourceFrames(item, 10) - (10 + 20 * share)) < 1e-12, ease);
  }
  let last = -Infinity;
  for (let t = 0; t <= 120; t += 0.25) {
    const s = sourceFrames(ramp, t);
    assert.ok(s > last, `monotonic at ${t}`);
    last = s;
    assert.ok(Math.abs(localForSource(ramp, s) - t) < 1e-7, `inverse at ${t}`);
  }
  assert.equal(sourceSpan(ramp), sourceFrames(ramp, 120));
  assert.equal(sourceAt(project([ramp]), ramp, 50), (30 + sourceFrames(ramp, 50)) / 30);
});

test("split and trim keep the curve: each piece plays exactly the frames the whole did there", () => {
  const p = project([ramp]);
  const split = edit(p, [{ op: "split_item", item: "c", at: 55, newId: "d" }]);
  const [a, b] = [itemOf(split, "c"), itemOf(split, "d")];
  assert.equal(a.duration, 55);
  assert.equal(b.duration, 65);
  assert.equal(b.in, 30 + Math.floor(sourceFrames(ramp, 55)));
  for (const t of [0, 10, 54]) assert.equal(sourceFrames(a, t), sourceFrames(ramp, t));
  for (const t of [0, 10, 30, 64]) {
    assert.equal(speedAt(b, t), speedAt(ramp, 55 + t));
    assert.ok(Math.abs(sourceFrames(b, t) - (sourceFrames(ramp, 55 + t) - sourceFrames(ramp, 55))) < 1e-9);
  }
  // A key before the piece's start stays so the segment it's in keeps its shape.
  assert.ok(b.speedKeys!.some((k) => k.frame < 0));
  assert.deepEqual(timelineProblems(split), []);
  const trimmed = edit(p, [{ op: "trim_item", item: "c", edge: "start", frames: 20 }]);
  const t1 = itemOf(trimmed, "c");
  assert.equal(t1.in, 30 + Math.floor(sourceFrames(ramp, 20)));
  for (const t of [0, 25, 99]) assert.equal(speedAt(t1, t), speedAt(ramp, 20 + t));
  const end = itemOf(edit(p, [{ op: "trim_item", item: "c", edge: "end", frames: 30 }]), "c");
  assert.deepEqual(
    end.speedKeys!.map((k) => k.frame),
    [0, 40, 70, 100],
  );
  for (const t of [0, 50, 89]) assert.equal(sourceFrames(end, t), sourceFrames(ramp, t));
});

test("planSpeedRamp: a preset keeps the clip's media stretch, its length is the curve's; null and set_speed go back to constant", () => {
  const plain: Item = { id: "c", type: "clip", media: "m", in: 30, duration: 120, fadeIn: 10 };
  const p = project([plain, { id: "after", type: "clip", media: "m", in: 0, duration: 30 }]);
  for (const name of Object.keys(RAMP_PRESETS)) {
    const plan = planSpeedRamp(p, "c", name);
    assert.ok(!("problem" in plan), name);
    const next = edit(p, plan.ops);
    const c = itemOf(next, "c");
    assert.equal(c.duration, plan.duration);
    assert.equal(presetOf(c.speedKeys, c.duration), name);
    assert.deepEqual(c.speedKeys, presetKeys(RAMP_PRESETS[name]!, c.duration));
    assert.ok(Math.abs(sourceSpan(c) - 120) < Math.max(...c.speedKeys!.map((k) => k.speed)), `${name} plays about 120 media frames (${sourceSpan(c)})`);
    assert.equal(layout(next).starts.get("after"), c.duration, "main ripples");
    assert.deepEqual(validateProject(next, modules), []);
    assert.ok(!audibleAt(next, layout(next).starts, 10).some((a) => a.item.id === "c"), "a ramped clip is silent");
    const back = planSpeedRamp(next, "c", null);
    assert.ok(!("problem" in back));
    const c2 = itemOf(edit(next, back.ops), "c");
    assert.equal(c2.speedKeys, undefined);
    assert.equal(c2.duration, Math.round(sourceSpan(c)));
    const fixed = planSetSpeed(next, "c", 2);
    assert.ok(!("problem" in fixed));
    assert.equal(itemOf(edit(next, fixed.ops), "c").speedKeys, undefined);
  }
  const custom = planSpeedRamp(p, "c", [
    { frame: 0, speed: 1 },
    { frame: 30, speed: 0.5 },
  ]);
  assert.ok(!("problem" in custom));
  const cc = itemOf(edit(p, custom.ops), "c");
  assert.ok(Math.abs(sourceSpan(cc) - 120) <= 0.5);
  assert.match((planSpeedRamp(p, "c", "warp") as { problem: string }).problem, /no ramp called "warp"/);
  assert.match((planSpeedRamp(project([{ ...plain, loop: true }]), "c", "hero") as { problem: string }).problem, /looped or held/);
  const rampedP = edit(p, (planSpeedRamp(p, "c", "hero") as { ops: ReadonlyArray<Op> }).ops);
  assert.match((planDetachAudio(rampedP, "c", new Set()) as { problem: string }).problem, /speed ramp plays without its sound/);
});

test("planSpeedRamp never runs a clip past its media's end", () => {
  const near: Item = { id: "c", type: "clip", media: "m", in: 500, duration: 100 };
  const p = project([near]);
  const plan = planSpeedRamp(p, "c", "bullet");
  assert.ok(!("problem" in plan));
  const c = itemOf(edit(p, plan.ops), "c");
  assert.ok(500 + sourceSpan(c) <= 600 + 1e-6);
  assert.deepEqual(timelineProblems(edit(p, plan.ops)), []);
});

test("rules: a ramp or reverse on a looped or held clip, or reverse without a known length, is a problem", () => {
  assert.deepEqual(
    timelineProblems(project([{ ...ramp, loop: true }])).map((p) => p.code),
    ["speed-ramp"],
  );
  assert.deepEqual(
    timelineProblems(project([{ id: "c", type: "clip", media: "m", duration: 30, reverse: true, hold: true }])).map((p) => p.code),
    ["speed-ramp"],
  );
  assert.deepEqual(timelineProblems(project([ramp])), []);
  assert.deepEqual(validateProject(project([ramp]), modules), []);
});

test("reverse: in counts from the media's end, so the same stretch plays backwards; the copy's seconds run forwards", () => {
  const fwd: Item = { id: "c", type: "clip", media: "m", in: 100, duration: 60 };
  const p = project([fwd]);
  const plan = planReverse(p, "c", true);
  assert.ok(!("problem" in plan));
  const next = edit(p, plan.ops);
  const r = itemOf(next, "c");
  assert.equal(r.reverse, true);
  assert.equal(r.in, 600 - 100 - 60);
  // The copy holds media frames [from, to) rounded out to 2 s steps.
  assert.deepEqual(reverseRange(next, r), { from: 60, to: 180 });
  // Local frame t shows media frame 159 - t: the copy's frame (to - 1) - (159 - t).
  for (const t of [0, 1, 30, 59]) {
    const seconds = sourceAt(next, r, t);
    assert.equal(Math.round(seconds * 30), 180 - 1 - (159 - t));
  }
  const back = planReverse(next, "c", false);
  assert.ok(!("problem" in back));
  assert.equal(itemOf(edit(next, back.ops), "c").in, 100);
  assert.match((planReverse(project([{ ...fwd, loop: true }]), "c", true) as { problem: string }).problem, /looped or held/);
  const noLength: Project = { ...p, media: [{ ...p.media[0]!, probe: { fps: 30 } }] };
  assert.match((planReverse(noLength, "c", true) as { problem: string }).problem, /doesn't know this video's length/);
  // visualsAt hands the preview and export the copy's seconds.
  const { starts } = layout(next);
  assert.equal(visualsAt(next, starts, 10).find((v) => v.item.id === "c")!.source, sourceAt(next, r, 10));
});

test("reverse with a ramp: the copy is read through the curve", () => {
  const p = project([{ ...ramp, reverse: true, in: 0 }]);
  const r = itemOf(p, "c");
  const range = reverseRange(p, r)!;
  assert.equal(range.to, 600);
  for (const t of [0, 40, 119]) assert.ok(Math.abs(sourceAt(p, r, t) - (sourceFrames(ramp, t) + range.to - 600) / 30) < 1e-12);
});

test("review: a ramped piece's in is floored, so no split, trim or reverse of a ramp runs past its media", () => {
  for (const name of Object.keys(RAMP_PRESETS)) {
    for (const duration of [97, 100, 123, 150, 600]) {
      const p = project([{ id: "c", type: "clip", media: "m", in: 0, duration }]);
      const plan = planSpeedRamp(p, "c", name);
      if ("problem" in plan) continue;
      const ramped = edit(p, plan.ops);
      const c = itemOf(ramped, "c");
      for (let at = 1; at < c.duration; at += 3) {
        assert.deepEqual(timelineProblems(edit(ramped, [{ op: "split_item", item: "c", at, newId: "d" }])), [], `${name} ${duration} split ${at}`);
        assert.deepEqual(timelineProblems(edit(ramped, [{ op: "trim_item", item: "c", edge: "start", frames: at }])), [], `${name} ${duration} trim ${at}`);
      }
      const back = planReverse(ramped, "c", true);
      assert.ok(!("problem" in back), `${name} ${duration}: ${"problem" in back ? back.problem : ""}`);
      const there = edit(ramped, back.ops);
      assert.deepEqual(timelineProblems(there), [], `${name} ${duration} reversed`);
      const again = planReverse(there, "c", false);
      assert.ok(!("problem" in again));
      assert.deepEqual(timelineProblems(edit(there, again.ops)), []);
    }
  }
  // The 600-frame Bullet clip of the report: split at 25.
  const p = project([{ id: "c", type: "clip", media: "m", in: 0, duration: 600 }]);
  const bullet = edit(p, (planSpeedRamp(p, "c", "bullet") as { ops: ReadonlyArray<Op> }).ops);
  assert.deepEqual(timelineProblems(edit(bullet, [{ op: "split_item", item: "c", at: 25, newId: "d" }])), []);
});

test("review: a reversed clip's copy covers what its transitions play past its ends, at its speed", () => {
  const fast: Item = {
    id: "c",
    type: "clip",
    media: "m",
    in: 200,
    duration: 60,
    speed: 3,
    reverse: true,
    transitionIn: { module: "transition.crossfade", duration: 90 },
  };
  const after: Item = { id: "d", type: "clip", media: "m", in: 0, duration: 120, transitionIn: { module: "transition.crossfade", duration: 90 } };
  const before: Item = { id: "b", type: "clip", media: "m", in: 0, duration: 120 };
  const p = project([before, fast, after]);
  const range = reverseRange(p, fast)!;
  const seconds = (local: number) => sourceAt(p, fast, local);
  for (const local of [-45, 0, 59, 105]) {
    assert.ok(
      seconds(local) >= 0 && seconds(local) <= (range.to - range.from) / 30,
      `local ${local}: ${seconds(local)} s in a ${(range.to - range.from) / 30} s copy`,
    );
  }
});
