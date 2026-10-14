// Issue #38 (D206): timeline_edit friendlier for the agent. place_item resolves overlaps as asked
// ("after", "free-track", "ripple"), set_transition's allowTrim trims exactly the missing spare media
// (and without it the refusal says how many frames are missing), refusals carry a concrete fix, a
// dry run's diff, enum errors list their values, and the turn-end clean-up's pure parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyEdit, createSession, loadModules, timelineProblems, validateOps, validateProject, type Op, type Project } from "../../packages/core/src/index.ts";
import { expandPlacement, freshId, projectDiff, refusalFixes, transitionHandles } from "../../packages/core/src/timeline/agentPlace.ts";
import { emptyAddedTracks, restoreGraphics, trashGraphics, unusedGraphics } from "../../apps/server/src/agent/agentCleanup.ts";

const modules = await loadModules("spec/modules/builtin");
const base: Project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1080, height: 1350, fps: 30 },
  media: [
    { id: "m", kind: "video", name: "a.mp4", path: "/a.mp4", probe: { frames: 600, fps: 30, width: 320, height: 180, hasAudio: true } },
    { id: "short", kind: "video", name: "s.mp4", path: "/s.mp4", probe: { frames: 150, fps: 30, width: 320, height: 180, hasAudio: false } },
  ],
  tracks: [
    {
      id: "text",
      kind: "text",
      name: "Text",
      items: [
        { id: "title-1", type: "text", text: "One", start: 0, duration: 90 },
        { id: "title-2", type: "text", text: "Two", start: 120, duration: 60 },
        { id: "title-3", type: "text", text: "Three", start: 200, duration: 60 },
      ],
    },
    { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "a", type: "clip", media: "short", in: 0, duration: 150 }, { id: "b", type: "clip", media: "m", in: 0, duration: 150 }] },
    { id: "audio", kind: "audio", name: "Audio", items: [] },
  ],
};
const valid = (p: Project) => assert.deepEqual(validateProject(p, modules), []);
const run = (p: Project, ops: ReadonlyArray<unknown>) => {
  const x = expandPlacement(p, ops);
  assert.ok(!("problem" in x), JSON.stringify(x));
  const after = applyEdit(createSession(p), { actor: "agent", ops: x.ops as ReadonlyArray<Op> }).project;
  valid(after);
  return { after, ...x };
};
const where = (p: Project, id: string) => {
  for (const t of p.tracks) for (const i of t.items) if (i.id === id) return { track: t.id, start: i.start, duration: i.duration };
  return undefined;
};
const text = (id: string, duration = 40) => ({ id, type: "text", text: id, duration });

test("place_item: free spot as asked; after, free-track and ripple resolve an overlap and say how", () => {
  // Free there: it goes where asked.
  const free = run(base, [{ op: "place_item", track: "text", item: text("t-free", 20), start: 95, place: "after" }]);
  assert.deepEqual(where(free.after, "t-free"), { track: "text", start: 95, duration: 20 });
  assert.match(free.notes[0]!.how, /where asked/);

  // after: the first free frame after what's in the way (title-1 ends at 90, title-2 starts at 120: 40 doesn't fit, so after title-3).
  const after = run(base, [{ op: "place_item", track: "text", item: text("t-after"), start: 30, place: "after" }]);
  assert.deepEqual(where(after.after, "t-after"), { track: "text", start: 260, duration: 40 });
  assert.match(after.notes[0]!.how, /frame 260, right after "title-3"/);

  // free-track: no other text track, so a new one just above, at the same start.
  const ft = run(base, [{ op: "place_item", track: "text", item: text("t-ft"), start: 30, place: "free-track" }]);
  assert.equal(where(ft.after, "t-ft")!.start, 30);
  assert.equal(where(ft.after, "t-ft")!.track, "text-2");
  assert.equal(ft.after.tracks[0]!.id, "text-2", "above the track asked for");
  assert.equal(ft.after.tracks[0]!.name, "Text 2");
  // A second one at the same moment reuses that track when it's free there... and a third at an
  // overlapping moment gets another new one, never stacking an overlap.
  const ft2 = run(ft.after, [{ op: "place_item", track: "text", item: text("t-ft2", 10), start: 75, place: "free-track" }]);
  assert.equal(where(ft2.after, "t-ft2")!.track, "text-2");
  const ft3 = run(ft2.after, [{ op: "place_item", track: "text", item: text("t-ft3"), start: 40, place: "free-track" }]);
  assert.equal(where(ft3.after, "t-ft3")!.track, "text-3");

  // ripple: title-2 and title-3 move later by what's needed; an item running across the start can't be pushed.
  const rip = run(base, [{ op: "place_item", track: "text", item: text("t-rip", 50), start: 100, place: "ripple" }]);
  assert.deepEqual(where(rip.after, "t-rip"), { track: "text", start: 100, duration: 50 });
  assert.equal(where(rip.after, "title-2")!.start, 150);
  assert.equal(where(rip.after, "title-3")!.start, 230);
  assert.match(rip.notes[0]!.how, /2 items after it on "text" moved 30 frames later/);
  const across = expandPlacement(base, [{ op: "place_item", track: "text", item: text("t-x"), start: 50, place: "ripple" }]);
  assert.match((across as { problem: string }).problem, /"title-1" runs across frame 50 \(0–90\).*Fix: start at 90, or place "free-track"/);

  // Moving an existing item by id.
  const mv = run(base, [{ op: "place_item", item: "title-3", start: 100, place: "after" }]);
  assert.equal(where(mv.after, "title-3")!.start, 180);

  // On the main track it goes in at the cut at start; the rest ripples.
  const main = run(base, [{ op: "place_item", track: "main", item: { id: "c", type: "clip", media: "m", in: 0, duration: 30 }, start: 150, place: "after" }]);
  assert.deepEqual(main.after.tracks[1]!.items.map((i) => i.id), ["a", "c", "b"]);

  // Problems name the fix.
  assert.match((expandPlacement(base, [{ op: "place_item", track: "text", item: text("title-2"), start: 0, place: "after" }]) as { problem: string }).problem, /id "title-2" is taken\. Fix: use "title-4"/);
  assert.match((expandPlacement(base, [{ op: "place_item", track: "nope", item: text("z"), start: 0, place: "after" }]) as { problem: string }).problem, /no track "nope"\. Tracks: text \(text\), main \(video, main\), audio \(audio\)/);
  assert.match((expandPlacement(base, [{ op: "place_item", track: "text", item: text("z"), start: 0, place: "over" }]) as { problem: string }).problem, /place must be "after", "free-track" or "ripple"/);
  assert.equal(freshId("text", new Set(["text-2"])), "text-3");
});

test("set_transition: allowTrim trims exactly the missing spare media; without it the refusal counts the frames", () => {
  // b starts at in 0 (no media before its in-point); a uses all of "short" (no media after its out-point).
  const h = transitionHandles(base, "b", { module: "transition.crossfade", duration: 20 })!;
  assert.deepEqual([h.half, h.missingIn, h.missingOut], [10, 10, 10]);
  const refused = expandPlacement(base, [{ op: "set_transition", item: "b", transition: { module: "transition.crossfade", duration: 20 } }]) as { problem: string };
  assert.match(refused.problem, /needs 10 frames of spare media on each side of the cut; "b" has 0 frames of media before its in-point \(10 missing\) and "a" has 0 after its out-point \(10 missing\)/);
  assert.match(refused.problem, /Fix: pass allowTrim: true on this set_transition to trim 10 frames off the start of "b" and 10 off the end of "a".*transition\.dip-to-black/);
  // A dip needs none: it passes as is.
  const dip = run(base, [{ op: "set_transition", item: "b", transition: { module: "transition.dip-to-black", duration: 20 } }]);
  assert.equal(dip.ops.length, 1);
  // allowTrim: the trims, then the transition; the result is valid and says what was trimmed.
  const trimmed = run(base, [{ op: "set_transition", item: "b", transition: { module: "transition.crossfade", duration: 20 }, allowTrim: true }]);
  assert.deepEqual(trimmed.ops.slice(0, 2), [{ op: "trim_item", item: "a", edge: "end", frames: 10 }, { op: "trim_item", item: "b", edge: "start", frames: 10 }]);
  assert.deepEqual(timelineProblems(trimmed.after), []);
  assert.match(trimmed.notes[0]!.how, /trimmed 10 frames off the start of "b" and 10 off the end of "a"/);
  // The rules agree it now fits.
  const tr = trimmed.after.tracks[1]!.items[1]!;
  assert.equal(tr.in, 10);
});

test("refusals carry a fix: overlap (start and free track), duplicate id, handles, wrong track kind, missing start, unknown media", () => {
  const overlapOps = [{ op: "insert_item", track: "text", item: { ...text("t-new"), start: 100 } }];
  const after = applyEdit(createSession(base), { actor: "agent", ops: overlapOps as ReadonlyArray<Op> }).project;
  const problems = timelineProblems(after);
  const fixed = refusalFixes(base, overlapOps, problems);
  const ov = fixed.find((p) => p.code === "overlap")!;
  assert.match(ov.fix!, /Use start 260 on "text" \(right after "title-3"\), or a new track\. place_item with place "after", "free-track" or "ripple" does it in one op\./);
  // With a second text track free there, the fix names it.
  const two: Project = { ...base, tracks: [{ id: "text-2", kind: "text", name: "Text 2", items: [] }, ...base.tracks] };
  const fixed2 = refusalFixes(two, overlapOps, timelineProblems(applyEdit(createSession(two), { actor: "agent", ops: overlapOps as ReadonlyArray<Op> }).project));
  assert.match(fixed2.find((p) => p.code === "overlap")!.fix!, /or track "text-2" \(free at 100–140\)/);

  const dup = refusalFixes(base, [], [{ code: "duplicate-id", path: "/tracks/text/items/title-2", message: 'id "title-2" is used more than once' }]);
  assert.equal(dup[0]!.fix, 'Use the id "title-4".');

  const handleOps = [{ op: "set_transition", item: "b", transition: { module: "transition.crossfade", duration: 20 } }];
  const hp = timelineProblems(applyEdit(createSession(base), { actor: "agent", ops: handleOps as ReadonlyArray<Op> }).project);
  const hf = refusalFixes(base, handleOps, hp);
  assert.ok(hf.every((p) => p.code !== "transition-handles" || /It lacks 10 frames before "b"'s in-point and 10 after "a"'s out-point\. Pass allowTrim: true/.test(p.fix!)), JSON.stringify(hf));

  const kind = refusalFixes(base, [], [{ code: "item-track-kind", path: "/tracks/audio/items/title-1", message: "" }]);
  assert.equal(kind[0]!.fix, "A text item goes on a text track: text.");
  const missing = refusalFixes(base, [], [{ code: "missing-start", path: "/tracks/text/items/title-2", message: "" }]);
  assert.match(missing[0]!.fix!, /Give it a start frame; 260 is free after the last item on "text"/);
  const media = refusalFixes(base, [], [{ code: "unknown-media", path: "/tracks/main/items/a", message: "" }]);
  assert.equal(media[0]!.fix, "Media ids in the project: m, short.");
});

test("dry-run diff and enum values in schema errors", () => {
  const ops = [{ op: "insert_item", track: "text", item: { ...text("t-new"), start: 300 } }, { op: "move_item", item: "title-1", start: 400 }, { op: "update_item", item: "title-2", set: { text: "2" } }, { op: "delete_item", item: "title-3" }, { op: "add_track", track: { id: "sfx", kind: "audio", name: "SFX" } }];
  const after = applyEdit(createSession(base), { actor: "agent", ops: ops as ReadonlyArray<Op> }).project;
  const d = projectDiff(base, after);
  assert.deepEqual(d.added, [{ id: "t-new", type: "text", track: "text", start: 300, end: 340 }]);
  assert.deepEqual(d.removed, [{ id: "title-3", type: "text", track: "text", start: 200, end: 260 }]);
  assert.deepEqual(d.moved, [{ id: "title-1", type: "text", track: "text", start: 400, end: 490, from: { track: "text", start: 0 } }]);
  assert.deepEqual(d.changed, ["title-2"]);
  assert.deepEqual(d.tracksAdded, ["sfx"]);
  const bad = validateOps([{ op: "trim_item", item: "a", edge: "middle", frames: 3 }]);
  assert.ok(bad.some((p) => /must be equal to one of the allowed values \("start", "end"\)/.test(p.message)), JSON.stringify(bad));
});

test("turn-end clean-up: only the agent's unused graphics go to the trash (not ones history or another graphic uses), and come back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-cleanup-"));
  try {
    mkdirSync(join(dir, "graphics"));
    for (const n of ["used.html", "old.html", "unused.html", "users-own.html", "loader.html", "loaded.html"]) writeFileSync(join(dir, "graphics", n), n === "loader.html" ? "<script src='loaded.html'></script>" : "<p>x</p>");
    const now = { tracks: [{ items: [{ type: "graphic", src: "graphics/used.html" }, { type: "graphic", src: "graphics/loader.html" }] }] };
    const earlier = { tracks: [{ items: [{ type: "graphic", src: "graphics/old.html" }] }] };
    const agentWrote = ["used.html", "old.html", "unused.html", "loaded.html", "gone.html"];
    const unused = await unusedGraphics(dir, agentWrote, [now, earlier]);
    assert.deepEqual(unused, ["unused.html"], "used now, used in recent history, loaded by a kept graphic, the user's own, a missing file: all stay");
    assert.deepEqual(await trashGraphics(dir, "turn-1", unused), ["unused.html"]);
    assert.ok(!existsSync(join(dir, "graphics", "unused.html")));
    assert.deepEqual(readdirSync(join(dir, ".cache", "trash", "turn-1", "graphics")), ["unused.html"]);
    assert.deepEqual(await restoreGraphics(dir, "turn-1", ["unused.html", "../x.html"]), ["unused.html"]);
    assert.ok(existsSync(join(dir, "graphics", "unused.html")));
    // A file written since under that name is never overwritten.
    await trashGraphics(dir, "turn-2", ["unused.html"]);
    writeFileSync(join(dir, "graphics", "unused.html"), "new");
    assert.deepEqual(await restoreGraphics(dir, "turn-2", ["unused.html"]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const p: Project = { ...base, tracks: [...base.tracks, { id: "gfx-2", kind: "video", name: "G", items: [] }, { id: "lock", kind: "video", name: "L", locked: true, items: [] }] };
  assert.deepEqual(emptyAddedTracks(p, new Set(["gfx-2", "lock", "text", "main"])), ["gfx-2"]);
});
