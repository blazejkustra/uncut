// Issue #118: marked sections. A locked stretch never moves or changes, whoever edits (the user's
// ripple trim or delete before it, the agent's ops, undoing a turn); only the user unlocks it; the
// planners the editor uses; and what the agent is told (project_read, every message).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, EditError, loadModules, sectionsNote, undoTurn, validateOps, validateProject, type Op, type Project } from "../../packages/core/src/index.ts";
import { lockedSectionProblem, planLockRest, planMarkSection, planRemoveSection } from "../../packages/core/src/timeline/sections.ts";
import { planReplaceRange } from "../../packages/core/src/timeline/arrange.ts";
import { expandArrangeOps } from "../../apps/server/src/agent/tools/expand.ts";
import { projectSummary } from "../../apps/server/src/agent/tools/summary.ts";

const modules = await loadModules("spec/modules/builtin");
const probe = { frames: 900, fps: 30, width: 1280, height: 720, hasAudio: true };
const base: Project = {
  format: "uncut/0",
  name: "Song",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "m-a", kind: "video", name: "a.mp4", path: "/x/a.mp4", probe },
    { id: "m-b", kind: "video", name: "b.mp4", path: "/x/b.mp4", probe },
    { id: "m-song", kind: "audio", name: "song.m4a", path: "/x/song.m4a", probe: { frames: 900, hasAudio: true } },
  ],
  tracks: [
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "c1", type: "clip", media: "m-a", in: 0, duration: 120 },
        { id: "c2", type: "clip", media: "m-a", in: 300, duration: 150 },
        { id: "c3", type: "clip", media: "m-b", in: 0, duration: 90 },
      ],
    },
    { id: "audio", kind: "audio", name: "Song", items: [{ id: "song", type: "audio", media: "m-song", in: 0, start: 0, duration: 360 }] },
  ],
};
const user = (p: Project, ops: ReadonlyArray<Op>) => applyEdit(createSession(p), { actor: "user", ops }).project;
const agent = (p: Project, ops: ReadonlyArray<Op>) => applyEdit(createSession(p), { actor: "agent", ops }).project;
const mark = (p: Project, from: number, to: number, state: "locked" | "redo", note?: string) => {
  const plan = planMarkSection(p, from, to, state, note);
  assert.ok(!("problem" in plan), JSON.stringify(plan));
  return user(p, plan.ops);
};
const refused = (fn: () => unknown, words: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof EditError && words.test(JSON.stringify((e as EditError).details)));

// c2 plays frames 120–270 on Main; locked: 150–240, inside it.
const locked = mark(base, 150, 240, "locked");

test("marking: a valid section in the project, overlapping marks cut out of each other, unmarking and locking the rest", () => {
  assert.deepEqual(locked.sections, [{ id: "section-1", start: 150, end: 240, state: "locked" }]);
  // The edit the editor sends passes the server's op checks.
  const plan = planMarkSection(base, 150, 240, "locked");
  assert.ok(!("problem" in plan));
  assert.deepEqual(validateOps(plan.ops), []);
  assert.deepEqual(validateProject(locked, modules), []);
  // A redo mark over the lock's end takes that part of the lock.
  const both = mark(locked, 200, 300, "redo", "  the cut is late  ");
  assert.deepEqual(both.sections, [
    { id: "section-1", start: 150, end: 200, state: "locked" },
    { id: "section-2", start: 200, end: 300, state: "redo", note: "the cut is late" },
  ]);
  assert.deepEqual(validateProject(both, modules), []);
  // Lock the rest: everything not flagged is locked, the flag stays.
  const rest = planLockRest(both);
  assert.ok(!("problem" in rest));
  const all = user(both, rest.ops);
  assert.deepEqual(
    all.sections!.map((s) => [s.start, s.end, s.state]),
    [
      [0, 150, "locked"],
      [150, 200, "locked"],
      [200, 300, "redo"],
      [300, 360, "locked"],
    ],
  );
  assert.ok("problem" in planLockRest(all), "nothing left to lock");
  const removed = planRemoveSection(both, "section-2");
  assert.ok(!("problem" in removed));
  assert.deepEqual(user(both, removed.ops).sections, [{ id: "section-1", start: 150, end: 200, state: "locked" }]);
  assert.ok("problem" in planMarkSection(base, 40, 40, "locked"));
  // Overlapping or empty sections in project.json are invalid.
  const bad = { ...base, sections: [{ id: "s1", start: 10, end: 50, state: "locked" as const }, { id: "s2", start: 40, end: 40, state: "redo" as const }] };
  assert.deepEqual(validateProject(bad, modules).map((p) => p.code).sort(), ["section-overlap", "section-range"]);
});

test("a ripple before a locked section is refused, the user's and the agent's alike", () => {
  // Trimming, deleting or inserting on Main before the lock would shift what plays in it.
  for (const ops of [
    [{ op: "trim_item", item: "c1", edge: "end", frames: 10 }],
    [{ op: "delete_item", item: "c1" }],
    [{ op: "insert_item", track: "main", index: 0, item: { id: "new", type: "clip", media: "m-b", in: 0, duration: 30 } }],
    [{ op: "move_item", item: "c3", index: 0 }],
  ] as Array<Array<Op>>) {
    refused(() => user(locked, ops), /locked-section/);
    refused(() => agent(locked, ops), /locked-section/);
  }
  // Changing what plays in it: another media, a restyle, the song moved under it.
  refused(() => user(locked, [{ op: "update_item", item: "c2", set: { media: "m-b" } }]), /locked/);
  refused(() => agent(locked, [{ op: "update_item", item: "c2", set: { effects: [{ module: "effect.color", params: { saturation: 0 } }] } }]), /locked/);
  refused(() => agent(locked, [{ op: "move_item", item: "song", start: 5 }]), /locked/);
  const problem = lockedSectionProblem(locked, { ...user(base, [{ op: "trim_item", item: "c1", edge: "end", frames: 10 }]), sections: locked.sections! });
  assert.match(problem!.message, /frames 150–240 \(0:05\.0–0:08\.0\) are locked/);
});

test("edits around a locked section that leave it as it was go through", () => {
  // After it: a ripple trim of the last clip, a delete of it.
  assert.equal(user(locked, [{ op: "trim_item", item: "c3", edge: "end", frames: 30 }]).tracks[0]!.items[2]!.duration, 60);
  agent(locked, [{ op: "delete_item", item: "c3" }]);
  // A split of the clip it's in (before the section): the half in it is renamed and keeps playing the same frames.
  const split = agent(locked, [{ op: "split_item", item: "c2", at: 10, newId: "c2b" }]);
  assert.deepEqual(split.tracks[0]!.items.map((i) => i.id), ["c1", "c2", "c2b", "c3"]);
  // A replaced fragment before it (an overwrite, nothing moves), planned by the agent's replace_range.
  const ops = expandArrangeOps(locked, [{ op: "replace_range", item: "c1", from: 30, to: 60, media: "m-b", in: 100 }]);
  assert.ok(!("problem" in ops), JSON.stringify(ops));
  agent(locked, ops.ops as Array<Op>);
  // But not inside it: the planner says why.
  const inside = planReplaceRange(locked, { item: "c2", from: 160, to: 200, media: "m-b" });
  assert.ok("problem" in inside && /locked/.test(inside.problem), JSON.stringify(inside));
});

test("only the user unlocks: the agent can't remove, move or resize a lock, but may clear a redo mark", () => {
  const flagged = mark(locked, 0, 100, "redo");
  const lock = flagged.sections!.find((s) => s.state === "locked")!;
  const redo = flagged.sections!.find((s) => s.state === "redo")!;
  for (const sections of [[redo], [{ ...lock, end: 200 }, redo], [{ ...lock, state: "redo" as const }, redo], null]) {
    refused(() => agent(flagged, [{ op: "update_project", set: { sections } }]), /only the user can unlock/);
  }
  // Unlock and ripple in one edit: refused for the agent, allowed for the user.
  const unlockAndTrim: Array<Op> = [{ op: "update_project", set: { sections: [redo] } }, { op: "trim_item", item: "c1", edge: "end", frames: 10 }];
  refused(() => agent(flagged, unlockAndTrim), /only the user/);
  assert.equal(user(flagged, unlockAndTrim).tracks[0]!.items[0]!.duration, 110);
  // The agent redid the flagged part and clears its mark; the lock stays.
  assert.deepEqual(agent(flagged, [{ op: "update_project", set: { sections: [lock] } }]).sections, [lock]);
});

test("undoing an agent turn that would shift a section locked since is refused", () => {
  let s = createSession(base);
  s = applyEdit(s, { actor: "agent", turnId: "t1", ops: [{ op: "trim_item", item: "c1", edge: "end", frames: -30 }] });
  const plan = planMarkSection(s.project, 180, 270, "locked");
  assert.ok(!("problem" in plan));
  s = applyEdit(s, { actor: "user", ops: plan.ops });
  assert.throws(() => undoTurn(base, s, "t1"), EditError);
});

test("the agent is told: project_read's sections and the line sent with every message", () => {
  const flagged = mark(locked, 0, 100, "redo", "too dark");
  const note = sectionsNote(flagged);
  assert.equal(note.split("\n").length, 2);
  assert.match(note, /^section-2: frames 0–100 \(0:00\.0–0:03\.3\) NOT OK, redo it: too dark$/m);
  assert.match(note, /^section-1: frames 150–240 \(0:05\.0–0:08\.0\) LOCKED/m);
  const summary = projectSummary(flagged, 3) as { sections?: string; sectionsNote?: string };
  assert.equal(summary.sections, note);
  assert.match(summary.sectionsNote!, /replace_range/);
  assert.equal((projectSummary(base, 1) as { sections?: string }).sections, undefined);
  assert.equal(sectionsNote(base), "");
});
