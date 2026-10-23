// Issue #118: replacing a fragment without shifting the timeline (an overwrite edit), as the editor
// plans it (core planReplaceRange, the In to Out helper) and as the agent's replace_range expands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, layout, loadModules, validateProject, type Op, type Project } from "../../packages/core/src/index.ts";
import { planReplaceRange } from "../../packages/core/src/timeline/arrange.ts";
import { planReplaceMarks } from "../../apps/web/src/timeline/replace.ts";
import { expandArrangeOps } from "../../apps/server/src/agent/tools/expand.ts";
import { OP_SHAPES, CONVENIENCE_OPS } from "../../apps/server/src/agent/tools/opShapes.ts";

const modules = await loadModules("spec/modules/builtin");
const probe = { frames: 900, fps: 30, width: 1280, height: 720, hasAudio: true };
const project: Project = {
  format: "uncut/0",
  name: "Song",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "m-a", kind: "video", name: "a.mp4", path: "/x/a.mp4", probe },
    { id: "m-b", kind: "video", name: "b.mp4", path: "/x/b.mp4", probe },
    { id: "m-song", kind: "audio", name: "song.m4a", path: "/x/song.m4a", probe: { frames: 900, hasAudio: true } },
    { id: "m-logo", kind: "image", name: "logo.png", path: "/x/logo.png" },
  ],
  tracks: [
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "c1", type: "clip", media: "m-a", in: 0, duration: 120, effects: [{ module: "effect.color", params: { saturation: 0.6 } }] },
        { id: "c2", type: "clip", media: "m-a", in: 300, duration: 150, speed: 2 },
        { id: "c3", type: "clip", media: "m-b", in: 0, duration: 90 },
      ],
    },
    { id: "audio", kind: "audio", name: "Song", items: [{ id: "song", type: "audio", media: "m-song", in: 0, start: 0, duration: 360 }] },
  ],
};
const apply = (ops: ReadonlyArray<Op>) => applyEdit(createSession(project), { actor: "user", ops }).project;
const startsOf = (p: Project) => Object.fromEntries(layout(p).starts);

test("replace a fragment: the piece plays the other media, and nothing after it moves", () => {
  const plan = planReplaceRange(project, { item: "c1", from: 30, to: 60, media: "m-b", in: 200 });
  assert.ok(!("problem" in plan), JSON.stringify(plan));
  const after = apply(plan.ops);
  assert.deepEqual(validateProject(after, modules), []);
  const main = after.tracks[0]!.items;
  assert.deepEqual(main.map((i) => [i.id, i.media, i.in, i.duration]), [
    ["c1", "m-a", 0, 30],
    [plan.piece, "m-b", 200, 30],
    ["c1-2", "m-a", 60, 60],
    ["c2", "m-a", 300, 150],
    ["c3", "m-b", 0, 90],
  ]);
  // The piece keeps the clip's look.
  assert.deepEqual(main[1]!.effects, project.tracks[0]!.items[0]!.effects);
  // Every later clip, and the song, start where they did.
  const before = startsOf(project);
  const now = startsOf(after);
  for (const id of ["c2", "c3", "song"]) assert.equal(now[id], before[id], id);
  assert.equal(layout(after).duration, layout(project).duration);
});

test("replace a fragment: at an item's edges it splits only where needed; a sped-up clip's piece plays at normal speed", () => {
  const whole = planReplaceRange(project, { item: "c3", from: 270, to: 360, media: "m-a" });
  assert.ok(!("problem" in whole));
  assert.deepEqual(whole.ops.map((o) => o.op), ["update_item"], "the whole item: no split");
  const head = planReplaceRange(project, { item: "c2", from: 120, to: 150, media: "m-b", in: 10 });
  assert.ok(!("problem" in head));
  assert.deepEqual(head.ops.map((o) => o.op), ["split_item", "update_item"]);
  const after = apply(head.ops);
  const piece = after.tracks[0]!.items.find((i) => i.id === "c2")!;
  assert.deepEqual([piece.media, piece.in, piece.duration, piece.speed], ["m-b", 10, 30, undefined]);
  assert.equal(startsOf(after).c3, startsOf(project).c3);
});

test("replace a fragment: refusals say what to do", () => {
  const problem = (r: Parameters<typeof planReplaceRange>[1]) => {
    const plan = planReplaceRange(project, r);
    return "problem" in plan ? plan.problem : "";
  };
  assert.match(problem({ item: "c1", from: 100, to: 140, media: "m-b" }), /inside the item: frames 0 to 120/);
  assert.match(problem({ item: "c1", from: 10, to: 20, media: "m-song" }), /needs a video or a picture/);
  assert.match(problem({ item: "c1", from: 10, to: 40, media: "m-b", in: 890 }), /900 frames long.*frame 870 or earlier/);
  assert.match(problem({ item: "nope", from: 0, to: 1, media: "m-b" }), /no item/);
  const locked = { ...project, tracks: project.tracks.map((t) => (t.id === "main" ? { ...t, locked: true } : t)) };
  assert.match("problem" in planReplaceRange(locked, { item: "c1", from: 10, to: 20, media: "m-b" }) ? "locked" : "", /locked/);
  // A still picture over a piece: no in point.
  const still = planReplaceRange(project, { item: "c1", from: 10, to: 20, media: "m-logo" });
  assert.ok(!("problem" in still));
  assert.equal(apply(still.ops).tracks[0]!.items[1]!.in, undefined);
});

test("replace a fragment from the editor: In to Out, in the selected clip or the main clip under it", () => {
  const onMain = planReplaceMarks(project, "m-b", { markIn: 130, markOut: 160, selected: undefined }, 45);
  assert.ok(!("problem" in onMain), JSON.stringify(onMain));
  assert.equal((onMain.ops[0] as { item: string }).item, "c2");
  const inSong = planReplaceMarks(project, "m-b", { markIn: 130, markOut: 160, selected: "song" });
  assert.ok(!("problem" in inSong));
  assert.equal((inSong.ops[0] as { item: string }).item, "song");
  assert.match((planReplaceMarks(project, "m-b", { markIn: undefined, markOut: 60, selected: undefined }) as { problem: string }).problem, /Set In and Out/);
  assert.match((planReplaceMarks(project, "m-b", { markIn: 100, markOut: 140, selected: undefined }) as { problem: string }).problem, /isn't inside one clip/);
});

test("replace_range for the agent: a convenience op with its shape, expanded into the split and update", () => {
  assert.ok(CONVENIENCE_OPS.includes("replace_range"));
  assert.equal(OP_SHAPES.replace_range, '{"op":"replace_range", item, from, to, media, in?, id?}');
  const out = expandArrangeOps(project, [{ op: "replace_range", item: "c1", from: 30, to: 60, media: "m-b", in: 200, id: "new-shot" }]);
  assert.ok(!("problem" in out), JSON.stringify(out));
  const after = apply(out.ops as ReadonlyArray<Op>);
  assert.equal(after.tracks[0]!.items[1]!.id, "new-shot");
  assert.equal(startsOf(after).c3, startsOf(project).c3);
  const bad = expandArrangeOps(project, [{ op: "replace_range", item: "c1", from: 30, media: "m-b" }]);
  assert.match("problem" in bad ? bad.problem : "", /from and to are required/);
  const extra = expandArrangeOps(project, [{ op: "replace_range", item: "c1", from: 30, to: 40, media: "m-b", speed: 2 }]);
  assert.match("problem" in extra ? extra.problem : "", /unknown field speed/);
});
