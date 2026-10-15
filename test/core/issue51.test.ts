// Issue #51 (D224): the main track keeps gaps. A main item's `gap` is the empty frames before it;
// a delete and a drag leave space, ripple delete and cuts by text close up, transitions can't cross
// a gap, and every place that walks the main track (layout, captions, transcript, cuts) counts it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, audibleAt, createSession, cutsOf, editWords, layout, loadModules, mainEnd, planTextCut, resolveStarts, timelineProblems, transitionLimits, undoTurn, validateProject, visualsAt, type CutTranscript, type Item, type Op, type Project } from "../../packages/core/src/index.ts";
import { mainSlot, planPlaceMedia } from "../../packages/core/src/timeline/arrange.ts";
import { draftOf, planDelete, planMove, planRippleDelete } from "../../apps/web/src/timeline/edit.ts";
import { planDeleteMany } from "../../apps/web/src/timeline/clipboard.ts";

const modules = await loadModules("spec/modules/builtin");
const clip = (id: string, duration: number, extra: Partial<Item> = {}): Item => ({ id, type: "clip", media: "m", in: 0, duration, ...extra });
function projectWith(main: ReadonlyArray<Item>, other: ReadonlyArray<Item> = []): Project {
  return {
    format: "uncut/0",
    name: "Gaps",
    canvas: { width: 320, height: 180, fps: 30 },
    media: [{ id: "m", kind: "video", name: "Talk.mp4", path: "/tmp/Talk.mp4", probe: { frames: 600, fps: 30, width: 320, height: 180, hasAudio: true } }],
    tracks: [
      { id: "over", kind: "text", name: "Text", items: other },
      { id: "main", kind: "video", role: "main", name: "Main", items: main },
    ],
  };
}
const ok = <T extends object>(plan: T): Exclude<T, { readonly problem: string }> => {
  assert.ok(!("problem" in plan), "problem" in plan ? String(plan.problem) : "");
  return plan as Exclude<T, { readonly problem: string }>;
};
const run = (p: Project, ops: ReadonlyArray<Op>) => {
  const s = applyEdit(createSession(p), { actor: "user", ops }, timelineProblems).project;
  assert.deepEqual(validateProject(s, modules), []);
  return s;
};
const startsOf = (p: Project) => {
  const s = resolveStarts(p);
  return p.tracks.find((t) => t.role === "main")!.items.map((i) => [i.id, s.get(i.id)]);
};

test("a gap puts a main item later; old projects (no gap) lay out as before", () => {
  const plain = projectWith([clip("a", 30), clip("b", 30)]);
  assert.deepEqual(startsOf(plain), [["a", 0], ["b", 30]]);
  assert.equal(layout(plain).duration, 60);
  const gapped = projectWith([clip("a", 30, { gap: 150 }), clip("b", 30, { gap: 15 })]);
  assert.deepEqual(startsOf(gapped), [["a", 150], ["b", 195]]);
  assert.deepEqual([...layout(gapped).starts.entries()], [["a", 150], ["b", 195]]);
  assert.equal(layout(gapped).duration, 225);
  assert.equal(mainEnd(gapped), 225);
  assert.deepEqual(validateProject(gapped, modules), []);
  // The slot a drop's middle picks counts the gaps.
  assert.equal(mainSlot(gapped.tracks[1]!.items, 100), 0);
  assert.equal(mainSlot(gapped.tracks[1]!.items, 170), 1);
});

test("rules: a gap only on main, no transition across one; cutsOf and the transition limits skip it", () => {
  const off = projectWith([clip("a", 30)], [{ id: "t", type: "text", text: "Hi", start: 0, duration: 30, gap: 5 }]);
  assert.deepEqual(timelineProblems(off).map((p) => p.code), ["gap-track"]);
  const across = projectWith([clip("a", 30, { in: 20 }), clip("b", 30, { in: 20, gap: 10, transitionIn: { module: "transition.crossfade", duration: 10 } })]);
  assert.deepEqual(timelineProblems(across).map((p) => p.code), ["transition-gap"]);
  assert.deepEqual(cutsOf(across.tracks[1]).length, 0, "no cut where two clips don't meet");
  const met = projectWith([clip("a", 30, { gap: 10 }), clip("b", 30), clip("c", 30, { gap: 5 })]);
  assert.deepEqual(cutsOf(met.tracks[1]).map((c) => [c.item.id, c.frame]), [["b", 40]]);
  assert.match((transitionLimits(met, "c", "transition.crossfade") as { problem: string }).problem, /gap/);
});

test("a gap is black and silent: nothing on main draws or sounds there", () => {
  const p = projectWith([clip("a", 30), clip("b", 30, { gap: 60 })]);
  const { starts } = layout(p);
  assert.deepEqual(visualsAt(p, starts, 10).map((v) => v.item.id), ["a"]);
  assert.deepEqual(visualsAt(p, starts, 60).map((v) => v.item.id), []);
  assert.deepEqual(audibleAt(p, starts, 60).map((a) => a.item.id), []);
  assert.deepEqual(visualsAt(p, starts, 95).map((v) => v.item.id), ["b"]);
  assert.deepEqual(audibleAt(p, starts, 95).map((a) => a.item.id), ["b"]);
});

test("engine: a split leaves the gap on the first half; a moved item leaves its gap behind", () => {
  const p = projectWith([clip("a", 30), clip("b", 60, { gap: 20 })]);
  const split = run(p, [{ op: "split_item", item: "b", at: 30, newId: "b-2" }]);
  assert.deepEqual(startsOf(split), [["a", 0], ["b", 50], ["b-2", 80]]);
  assert.equal(split.tracks[1]!.items[2]!.gap, undefined);
  const moved = run(p, [{ op: "move_item", item: "b", index: 0 }]);
  assert.equal(moved.tracks[1]!.items[0]!.gap, undefined);
  // Off main (onto a video track) the gap goes too, so the rules accept it there.
  const withVideo: Project = { ...p, tracks: [{ id: "v2", kind: "video", name: "Video 2", items: [] }, p.tracks[1]!] };
  const off = run(withVideo, [{ op: "move_item", item: "b", track: "v2", start: 0 }]);
  assert.equal(off.tracks[0]!.items[0]!.gap, undefined);
});

test("delete leaves a gap (one or several); ripple delete closes the clip's frames but keeps the gap before it", () => {
  const p = projectWith([clip("a", 30), clip("b", 30), clip("c", 30), clip("d", 30)]);
  // Delete the middle clip b: c and d stay where they were.
  let after = run(p, ok(planDelete(p, "b")).ops);
  assert.deepEqual(startsOf(after), [["a", 0], ["c", 60], ["d", 90]]);
  // Several at once (b and c): d stays.
  after = run(p, ok(planDeleteMany(p, ["b", "c"])).ops);
  assert.deepEqual(startsOf(after), [["a", 0], ["d", 90]]);
  // The first one: everything after it stays (a gap from 0).
  after = run(p, ok(planDelete(p, "a")).ops);
  assert.deepEqual(startsOf(after), [["b", 30], ["c", 60], ["d", 90]]);
  // Ripple delete: c, d close up.
  after = run(p, ok(planRippleDelete(p, ["b"])).ops);
  assert.deepEqual(startsOf(after), [["a", 0], ["c", 30], ["d", 60]]);
  // A gapped clip ripple-deleted: its frames go, the space before it stays (before the next clip).
  const gapped = projectWith([clip("a", 30), clip("b", 30, { gap: 40 }), clip("c", 30)]);
  after = run(gapped, ok(planRippleDelete(gapped, ["b"])).ops);
  assert.deepEqual(startsOf(after), [["a", 0], ["c", 70]]);
  // Deleting the clip after a gap keeps the clip after it in place too.
  after = run(gapped, ok(planDelete(gapped, "b")).ops);
  assert.deepEqual(startsOf(after), [["a", 0], ["c", 100]]);
});

test("a delete or move that leaves a clip after a gap drops its transition", () => {
  const p = projectWith([clip("a", 30, { in: 20 }), clip("b", 30, { in: 20 }), clip("c", 30, { in: 20, transitionIn: { module: "transition.crossfade", duration: 10 } })]);
  const del = run(p, ok(planDelete(p, "b")).ops);
  assert.equal(del.tracks[1]!.items[1]!.transitionIn, undefined);
  // b dragged later in its slot: c (landed on) is pushed and loses nothing; b's own cut changes.
  const moved = run(p, ok(planMove(p, "b", "main", 40)).ops);
  assert.deepEqual(startsOf(moved), [["a", 0], ["b", 40], ["c", 70]]);
  assert.equal(moved.tracks[1]!.items[2]!.transitionIn, undefined);
});

test("a main clip drags to 5 s and stays there; the clips after keep their frames; the drag result is valid", () => {
  const p = projectWith([clip("a", 30), clip("b", 30), clip("c", 30)]);
  const plan = ok(planMove(p, "a", "main", 150));
  assert.equal(plan.start, 150);
  const after = run(p, plan.ops);
  assert.deepEqual(startsOf(after), [["b", 30], ["c", 60], ["a", 150]]);
  // The renderer's draft (same rules as the server) accepts it.
  assert.ok(!("problem" in draftOf(p, plan.ops)));
  // Then delete the middle one: the gap stays.
  const del = run(after, ok(planDelete(after, "c")).ops);
  assert.deepEqual(startsOf(del), [["b", 30], ["a", 150]]);
  // An overlay dragged onto main lands where it's dropped too.
  const withOverlay: Project = { ...p, tracks: [{ id: "v2", kind: "video", name: "Video 2", items: [clip("o", 30, { start: 0 })] }, p.tracks[1]!] };
  const onto = ok(planMove(withOverlay, "o", "main", 200));
  assert.deepEqual(startsOf(run(withOverlay, onto.ops)), [["a", 0], ["b", 30], ["c", 60], ["o", 200]]);
});

test("adding to main at a slot starts right after the clip before it (gaps counted)", () => {
  const p = projectWith([clip("a", 30, { gap: 60 }), clip("b", 30, { gap: 30 })]);
  const plan = ok(planPlaceMedia(p, [{ id: "m", kind: "video", name: "Talk.mp4", probe: { frames: 20, fps: 30, hasAudio: true } }], { frame: 200, track: "main" }, new Set()));
  const after = run(p, plan.ops);
  assert.deepEqual(startsOf(after).at(-1), [plan.placed[0]!.itemId, 150]);
  assert.equal(plan.placed[0]!.start, 150);
});

// 30 fps; words on round frames.
const WORDS = [
  { text: "One", start: 0.2, end: 0.6 }, // 6–18
  { text: "two", start: 1.2, end: 1.6 }, // 36–48
  { text: "three", start: 2.2, end: 2.6 }, // 66–78
];
const T: CutTranscript = { words: WORDS, language: "en", seconds: 3 };

test("captions and the transcript follow a gapped main track; a cut by text keeps the gap before a clip it removes", () => {
  // a plays 0–30 of the media (One), b (after a 60-frame gap, at 90) 36–48 (two), c 60–90 (three).
  const p = projectWith([clip("a", 30), clip("b", 12, { in: 36, gap: 60 }), clip("c", 30, { in: 60 })]);
  const words = editWords(p, new Map([["m", WORDS]]));
  assert.deepEqual(words.map((w) => [w.clip, w.index, w.start, w.end]), [["a", 0, 6, 18], ["b", 1, 90, 102], ["c", 2, 108, 120]]);
  // Captions covering main draw "two" where b plays it, after the gap; nothing in the gap.
  const cap: Item = { id: "cap", type: "captions", source: "m", coversMain: true, start: 0, duration: 150, words: WORDS.map((w) => ({ ...w })) };
  const withCaptions: Project = { ...p, tracks: [{ id: "caps", kind: "text", name: "Captions", items: [cap] }, p.tracks[1]!] };
  const { starts } = layout(withCaptions);
  const shown = (f: number) => visualsAt(withCaptions, starts, f).find((v) => v.item.type === "text")?.item.text ?? "";
  assert.match(shown(95), /two/i);
  assert.doesNotMatch(shown(60), /two/i);
  // Cutting "two" removes b whole: c closes up to where b started (the gap stays), one edit.
  const plan = ok(planTextCut(p, "m", T, { remove: [{ from: 1, to: 1 }] }));
  assert.ok(plan.ops.some((o) => o.op === "delete_item" && o.item === "b"), JSON.stringify(plan.ops));
  const after = run(p, plan.ops);
  assert.deepEqual(startsOf(after), [["a", 0], ["c", 90]]);
  assert.equal(plan.framesRemoved, 12);
});

test("undo: a delete that leaves a gap undoes as one step (turn replay restores the frames)", () => {
  const p = projectWith([clip("a", 30), clip("b", 30), clip("c", 30)]);
  let s = createSession(p);
  s = applyEdit(s, { actor: "agent", turnId: "t1", ops: ok(planDelete(p, "b")).ops }, timelineProblems);
  assert.deepEqual(startsOf(s.project), [["a", 0], ["c", 60]]);
  s = undoTurn(p, s, "t1", timelineProblems);
  assert.deepEqual(startsOf(s.project), [["a", 0], ["b", 30], ["c", 60]]);
  assert.equal(s.project.tracks[1]!.items[2]!.gap, undefined);
});
