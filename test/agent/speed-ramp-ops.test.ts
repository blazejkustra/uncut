// D327: the agent's set_speed takes a ramp (a preset, keys or null) and reverse, expanded by the
// server into the planners' edit ops; bad shapes are refused with a sentence.
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyEdit, createSession, presetOf, sourceSpan, type Item, type Op, type Project } from "../../packages/core/src/index.ts";
import { describeOp } from "../../packages/core/src/timeline/edit-log.ts";
import { expandArrangeOps } from "../../apps/server/src/agent/tools/expand.ts";

const project: Project = {
  format: "uncut/0",
  name: "Ramp ops",
  canvas: { width: 640, height: 360, fps: 30 },
  media: [{ id: "m", kind: "video", name: "clip.mp4", path: "/tmp/clip.mp4", probe: { frames: 600, fps: 30, width: 320, height: 180, hasAudio: true } }],
  tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "c", type: "clip", media: "m", in: 30, duration: 90 } as Item] }],
};
const run = (ops: Array<unknown>) => {
  const r = expandArrangeOps(project, ops);
  if ("problem" in r) return r;
  return { project: applyEdit(createSession(project), { actor: "agent", ops: r.ops as ReadonlyArray<Op> }).project, ops: r.ops as ReadonlyArray<Op> };
};
const clip = (p: Project) => p.tracks[0]!.items[0]!;

test("D327: set_speed with a ramp preset, with keys, with reverse, and back", () => {
  const hero = run([{ op: "set_speed", item: "c", ramp: "hero" }]);
  assert.ok(!("problem" in hero));
  assert.equal(presetOf(clip(hero.project).speedKeys, clip(hero.project).duration), "hero");
  assert.match(describeOp(hero.ops[0]!, project), /speed ramp of 4 keys/);
  const keyed = run([
    {
      op: "set_speed",
      item: "c",
      ramp: [
        { frame: 0, speed: 2, ease: "inOut" },
        { frame: 30, speed: 0.5 },
      ],
      reverse: true,
    },
  ]);
  assert.ok(!("problem" in keyed));
  const c = clip(keyed.project);
  assert.equal(c.reverse, true);
  assert.ok(Math.abs(sourceSpan(c) - 90) <= 0.5);
  assert.equal(c.in, Math.round(600 - 30 - sourceSpan(c)));
  const off = expandArrangeOps(keyed.project, [{ op: "set_speed", item: "c", ramp: null, reverse: false }]);
  assert.ok(!("problem" in off));
});

test("D327: set_speed refuses bad ramps and mixed fields", () => {
  for (const [op, why] of [
    [{ op: "set_speed", item: "c", ramp: "warp" }, /no ramp called "warp"/],
    [{ op: "set_speed", item: "c", ramp: [{ frame: 0, speed: 20 }] }, /speed from 0.1/],
    [{ op: "set_speed", item: "c", ramp: [{ frame: 0, speed: 1, curve: "x" }] }, /ramp must be/],
    [{ op: "set_speed", item: "c", speed: 2, ramp: "hero" }, /not both/],
    [{ op: "set_speed", item: "c" }, /speed, ramp or reverse/],
    [{ op: "set_speed", item: "c", keepPitch: false }, /keepPitch goes with a speed/],
    [{ op: "set_speed", item: "c", reverse: "yes" }, /reverse must be/],
  ] as const) {
    const r = expandArrangeOps(project, [op]);
    assert.ok("problem" in r, JSON.stringify(op));
    assert.match(r.problem, why);
  }
  const plain = run([{ op: "set_speed", item: "c", speed: 2 }]);
  assert.ok(!("problem" in plain));
  assert.equal(clip(plain.project).duration, 45);
});
