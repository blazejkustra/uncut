// Phase 5 chunk 5 (D69): core planTextCut, cutting a media's words, pauses and fillers out of the
// main track as one edit, and editWords, the words heard in edit order (the Transcript panel).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, editWords, handleFrames, layout, planTextCut, timelineProblems, undoTurn, type CutTranscript, type Item, type Project, type TextCutPlan } from "../packages/core/src/index.ts";

// 30 fps; words on round frames (frame = seconds × 30).
const WORDS = [
  { text: "Hello", start: 0.5, end: 1.0 }, // w0 15–30
  { text: "um", start: 1.2, end: 1.5 }, // w1 36–45
  { text: "this", start: 1.6, end: 2.0 }, // w2 48–60
  { text: "is", start: 2.1, end: 2.3 }, // w3 63–69
  { text: "a", start: 2.4, end: 2.5 }, // w4 72–75
  { text: "test.", start: 2.6, end: 3.0 }, // w5 78–90, then a 1 s pause
  { text: "Second", start: 4.0, end: 4.5 }, // w6 120–135
  { text: "part", start: 4.6, end: 5.0 }, // w7 138–150, then 1 s to the end (6 s)
];
const T: CutTranscript = { words: WORDS, language: "en", seconds: 6 };

const clip = (id: string, inF: number, duration: number, extra: Partial<Item> = {}): Item => ({ id, type: "clip", media: "m-talk", in: inF, duration, ...extra });
function projectWith(main: ReadonlyArray<Item>, other: Partial<Project> = {}): Project {
  return {
    format: "uncut/0",
    name: "Cut",
    canvas: { width: 320, height: 180, fps: 30 },
    media: [
      { id: "m-talk", kind: "video", name: "Talk.mp4", path: "/tmp/Talk.mp4", probe: { frames: 180, fps: 30, width: 320, height: 180, hasAudio: true } },
      { id: "m-b", kind: "video", name: "B.mp4", path: "/tmp/B.mp4", probe: { frames: 300, fps: 30, hasAudio: false } },
    ],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [] },
      { id: "main", kind: "video", role: "main", name: "Main", items: main },
    ],
    ...other,
  };
}
const ok = (r: TextCutPlan | { problem: string }): TextCutPlan => {
  assert.ok(!("problem" in r), "problem" in r ? r.problem : "");
  return r as TextCutPlan;
};
const mainOf = (p: Project) => p.tracks.find((t) => t.role === "main")!.items;
const shape = (p: Project) => mainOf(p).map((i) => [i.id, i.in, i.duration]);

test("handles: 2 frames at 24–30 fps, more at 50/60", () => {
  assert.deepEqual([24, 25, 30, 50, 60].map(handleFrames), [2, 2, 2, 3, 4]);
});

test("one word: cut over its frames, the clip splits and closes up, one edit", () => {
  const project = projectWith([clip("clip-1", 0, 180)]);
  const plan = ok(planTextCut(project, "m-talk", T, { remove: [{ from: 1, to: 1 }] }));
  // "um" covers 36–45; the words around it end at 30 and start at 48, beyond the 2-frame handles.
  assert.deepEqual(plan.cuts.map((c) => [c.from, c.to, c.text, c.frames]), [[36, 45, "um", 9]]);
  assert.deepEqual(plan.ops, [
    { op: "split_item", item: "clip-1", at: 45, newId: "clip-2" },
    { op: "trim_item", item: "clip-1", edge: "end", frames: 9 },
  ]);
  assert.deepEqual(shape(plan.project), [["clip-1", 0, 36], ["clip-2", 45, 135]]);
  assert.equal(plan.framesRemoved, 9);
  assert.deepEqual([plan.before, plan.after], [180, 171]);
  assert.equal(plan.summary, 'Cut "um" (0.3 s)');
  assert.deepEqual(plan.notes, []);
  // Two cuts inside a clip: the new pieces are numbered left to right.
  const two = ok(planTextCut(project, "m-talk", T, { remove: [{ from: 1, to: 1 }, { from: 3, to: 3 }] }));
  assert.deepEqual(shape(two.project), [["clip-1", 0, 36], ["clip-2", 45, 18], ["clip-3", 69, 111]]);
});

test("undo as one step: the plan is one edit (one log entry) and undoing it restores the project", () => {
  const project = projectWith([clip("clip-1", 0, 180), clip("b-1", 0, 90, { media: "m-b" })]);
  const plan = ok(planTextCut(project, "m-talk", T, { remove: [{ from: 1, to: 1 }, { from: 3, to: 4 }], pauses: { min: 0.5 } }));
  const s0 = createSession(project);
  const s1 = applyEdit(s0, { actor: "agent", ops: plan.ops, summary: plan.summary, turnId: "t1" }, timelineProblems);
  assert.equal(s1.log.length, 1);
  assert.equal(s1.revision, 1);
  assert.deepEqual(s1.project, plan.project);
  assert.equal(layout(s1.project).duration, plan.after);
  assert.deepEqual(undoTurn(project, s1, "t1").project, project);
  assert.deepEqual(s0.project, project, "the session it was planned on is untouched");
});

test("a range across a clip boundary trims both clips", () => {
  const project = projectWith([clip("a", 0, 60), clip("b", 60, 120)]);
  const plan = ok(planTextCut(project, "m-talk", T, { remove: [{ from: 2, to: 5 }] }));
  // this … test. = 48–90 (the word before ends at 45 + 2, the next starts at 120 − 2: no handle bites).
  assert.deepEqual(plan.cuts.map((c) => [c.from, c.to, c.words, c.text, c.clips]), [[48, 90, [2, 5], "this is a test.", ["a", "b"]]]);
  assert.deepEqual(plan.ops, [
    { op: "trim_item", item: "a", edge: "end", frames: 12 },
    { op: "trim_item", item: "b", edge: "start", frames: 30 },
  ]);
  assert.deepEqual(shape(plan.project), [["a", 0, 48], ["b", 90, 90]]);
  assert.equal(plan.framesRemoved, 42);
});

test("media used twice: both uses are cut, or only the clips asked for", () => {
  const project = projectWith([clip("clip-1", 0, 180), clip("b-1", 0, 30, { media: "m-b" }), clip("clip-3", 30, 120)]);
  const both = ok(planTextCut(project, "m-talk", T, { remove: [{ from: 1, to: 1 }] }));
  assert.equal(both.framesRemoved, 18);
  assert.deepEqual(both.cuts[0]!.clips, ["clip-1", "clip-3"]);
  assert.deepEqual(shape(both.project), [["clip-1", 0, 36], ["clip-2", 45, 135], ["b-1", 0, 30], ["clip-3", 30, 6], ["clip-4", 45, 105]]);
  const one = ok(planTextCut(project, "m-talk", T, { remove: [{ from: 1, to: 1 }], clips: ["clip-3"] }));
  assert.equal(one.framesRemoved, 9);
  assert.deepEqual(shape(one.project), [["clip-1", 0, 180], ["b-1", 0, 30], ["clip-3", 30, 6], ["clip-2", 45, 105]]);
});

test("words already trimmed out are a no-op with a note; partly visible ones cut what's there", () => {
  const project = projectWith([clip("clip-1", 60, 120)]);
  const none = ok(planTextCut(project, "m-talk", T, { remove: [{ from: 1, to: 1 }] }));
  assert.deepEqual(none.ops, []);
  assert.equal(none.framesRemoved, 0);
  assert.equal(none.summary, "");
  assert.match(none.notes.join(" "), /"um" \(w1\) isn't in the edit any more \(already cut\)/);
  // w2–w3 = 48–69: only 60–69 is in the clip.
  const part = ok(planTextCut(project, "m-talk", T, { remove: [{ from: 2, to: 3 }] }));
  assert.deepEqual(part.ops, [{ op: "trim_item", item: "clip-1", edge: "start", frames: 9 }]);
});

test("remove pauses: inward with handles next to kept words, edge pauses to the media's ends", () => {
  const project = projectWith([clip("clip-1", 0, 180)]);
  const plan = ok(planTextCut(project, "m-talk", T, { pauses: { min: 0.5 } }));
  // Lead 0–0.5 s → [0, 13); the 1 s gap 3.0–4.0 → [92, 118); the tail 5.0–6.0 → [152, 180).
  assert.deepEqual(plan.cuts.map((c) => [c.from, c.to, c.pauses]), [[0, 13, 1], [92, 118, 1], [152, 180, 1]]);
  assert.equal(plan.framesRemoved, 13 + 26 + 28);
  assert.deepEqual(shape(plan.project), [["clip-1", 13, 79], ["clip-2", 118, 34]]);
  assert.equal(plan.summary, "Removed 3 pauses (2.2 s)");
  // Shorter pauses only at a lower threshold: nothing between 0.3 and 0.5 s here except none, so the same.
  assert.equal(ok(planTextCut(project, "m-talk", T, { pauses: { min: 2 } })).ops.length, 0);
  assert.match(ok(planTextCut(project, "m-talk", T, { pauses: { min: 2 } })).notes.join(" "), /no pauses that long/);
});

test("pauses follow the silences when given (as transcript_read's do)", () => {
  const project = projectWith([clip("clip-1", 0, 180)]);
  const plan = ok(planTextCut(project, "m-talk", T, { pauses: { min: 0.5 }, silences: [{ start: 3.2, end: 3.9 }] }));
  assert.deepEqual(plan.cuts.map((c) => [c.from, c.to]), [[0, 13], [98, 115], [152, 180]]);
});

test("a removed word and the pause next to it make one cut (no handle between them)", () => {
  const project = projectWith([clip("clip-1", 0, 180)]);
  const plan = ok(planTextCut(project, "m-talk", T, { remove: [{ from: 5, to: 5 }], pauses: { min: 0.5 } }));
  // test. 78–90 runs straight into the pause 90–118.
  assert.deepEqual(plan.cuts.map((c) => [c.from, c.to, c.text, c.pauses]), [[0, 13, "", 1], [78, 118, "test.", 1], [152, 180, "", 1]]);
  assert.equal(plan.summary, "Cut 1 word and 3 pauses (2.7 s)");
});

test("fillers: hesitations only, en/pl only", () => {
  const project = projectWith([clip("clip-1", 0, 180)]);
  const words = [...WORDS.slice(0, 6), { text: "you", start: 4.0, end: 4.2 }, { text: "know", start: 4.25, end: 4.5 }];
  const plan = ok(planTextCut(project, "m-talk", { words, language: "en", seconds: 6 }, { fillers: true }));
  assert.deepEqual(plan.cuts.map((c) => [c.text, c.fillers]), [["um", 1]], '"you know" is a maybe filler and stays');
  assert.equal(plan.summary, "Removed 1 filler (0.3 s)");
  const de = ok(planTextCut(project, "m-talk", { ...T, language: "de" }, { fillers: true }));
  assert.deepEqual(de.ops, []);
  assert.match(de.notes.join(" "), /only recognised in English and Polish/);
});

test("handles keep 2 frames next to touching words; a word too tight to cut is a note", () => {
  const project = projectWith([clip("clip-1", 0, 180)]);
  const words = [
    { text: "ab", start: 1.0, end: 1.2 }, // 30–36
    { text: "cd", start: 1.2, end: 1.4 }, // 36–42
    { text: "ef", start: 1.4, end: 1.6 }, // 42–48
    { text: "x", start: 1.6, end: 1.65 }, // 48–50
    { text: "gh", start: 1.65, end: 1.8 },
  ];
  const plan = ok(planTextCut(project, "m-talk", { words, language: "en", seconds: 6 }, { remove: [{ from: 1, to: 1 }] }));
  assert.deepEqual(plan.cuts.map((c) => [c.from, c.to]), [[38, 40]]);
  const tight = ok(planTextCut(project, "m-talk", { words, language: "en", seconds: 6 }, { remove: [{ from: 3, to: 3 }] }));
  assert.deepEqual(tight.ops, []);
  assert.match(tight.notes.join(" "), /"x" \(w3\) runs into the words around it/);
});

test("frame snapping: a word covers the frames it's heard in (floor start, ceil end)", () => {
  const project = projectWith([clip("clip-1", 0, 180)]);
  const words = [{ text: "a", start: 0.2, end: 0.5 }, { text: "um", start: 1.21, end: 1.49 }, { text: "b", start: 2.0, end: 2.2 }];
  const plan = ok(planTextCut(project, "m-talk", { words, language: "en", seconds: 6 }, { remove: [{ from: 1, to: 1 }] }));
  assert.deepEqual(plan.cuts.map((c) => [c.from, c.to]), [[36, 45]]);
});

test("ripple: later clips stay back to back; free tracks don't move (and the note says so)", () => {
  const title: Item = { id: "title-1", type: "text", start: 100, duration: 60, text: "Hi" };
  const project = projectWith([clip("b-1", 0, 30, { media: "m-b" }), clip("clip-1", 0, 180), clip("b-2", 100, 60, { media: "m-b" })]);
  const withTitle = { ...project, tracks: [{ ...project.tracks[0]!, items: [title] }, project.tracks[1]!] };
  const plan = ok(planTextCut(withTitle, "m-talk", T, { remove: [{ from: 1, to: 1 }, { from: 6, to: 7 }] }));
  const { starts } = layout(plan.project);
  let t = 0;
  for (const item of mainOf(plan.project)) {
    assert.equal(starts.get(item.id), t);
    t += item.duration;
  }
  assert.equal(mainOf(plan.project).at(-1)!.id, "b-2");
  assert.equal(mainOf(plan.project).at(-1)!.in, 100, "the clip after keeps its in-point");
  assert.equal(starts.get("b-2"), 30 + 180 - plan.framesRemoved);
  assert.equal(starts.get("title-1"), 100);
  assert.match(plan.notes.join(" "), /title-1\) didn't move with the main track/);
});

test("speed: a 2× clip loses half as many frames", () => {
  const project = projectWith([clip("clip-1", 0, 90, { speed: 2 })]);
  const plan = ok(planTextCut(project, "m-talk", T, { remove: [{ from: 1, to: 1 }] }));
  // media 36–45 shows at local 18–22.5: frames 18..22 (5).
  assert.equal(plan.framesRemoved, 5);
  assert.deepEqual(shape(plan.project), [["clip-1", 0, 18], ["clip-2", 46, 67]]);
});

test("transitions at a cut that changes go in the same edit; fades, keys and animations are fitted", () => {
  const fade = { module: "transition.crossfade", duration: 10 };
  const project = projectWith([clip("a", 0, 60), clip("b", 60, 120, { transitionIn: fade, gainKeys: [{ frame: 0, db: 0 }, { frame: 110, db: -12 }], animation: { out: { module: "move.fade", duration: 100 } } })]);
  const plan = ok(planTextCut(project, "m-talk", T, { remove: [{ from: 2, to: 5 }], pauses: { min: 0.5 } }));
  assert.deepEqual(plan.ops[0], { op: "set_transition", item: "b", transition: null });
  const b = mainOf(plan.project).find((i) => i.id === "b")!;
  assert.equal(b.transitionIn, undefined);
  assert.ok(timelineProblems(plan.project).length === 0, JSON.stringify(timelineProblems(plan.project)));
  // b now plays 90–118 (the pause before "Second" cut out after it): its keys end on its last frame.
  for (const item of mainOf(plan.project)) {
    for (const k of item.gainKeys ?? []) assert.ok(k.frame <= item.duration);
    for (const a of Object.values(item.animation ?? {})) assert.ok(!a || a.duration <= item.duration);
  }
  // A whole clip covered by the cut is deleted; the transition into the next one goes.
  const short = projectWith([clip("a", 0, 30), clip("um", 36, 9), clip("c", 50, 100, { transitionIn: { module: "transition.crossfade", duration: 4 } })]);
  const gone = ok(planTextCut(short, "m-talk", T, { remove: [{ from: 1, to: 1 }] }));
  assert.deepEqual(gone.ops, [{ op: "set_transition", item: "c", transition: null }, { op: "delete_item", item: "um" }]);
});

test("locked clips are skipped with a note; a locked main track is refused; bad requests are refused", () => {
  const project = projectWith([clip("clip-1", 0, 180, { locked: true })]);
  const plan = ok(planTextCut(project, "m-talk", T, { remove: [{ from: 1, to: 1 }] }));
  assert.deepEqual(plan.ops, []);
  assert.match(plan.notes.join(" "), /clip-1 is locked/);
  const lockedTrack = { ...project, tracks: project.tracks.map((t) => (t.role === "main" ? { ...t, locked: true, items: [clip("clip-1", 0, 180)] } : t)) };
  assert.match((planTextCut(lockedTrack, "m-talk", T, { fillers: true }) as { problem: string }).problem, /main track is locked/);
  assert.match((planTextCut(project, "m-nope", T, { fillers: true }) as { problem: string }).problem, /no media "m-nope"/);
  assert.match((planTextCut(project, "m-talk", T, {}) as { problem: string }).problem, /Say what to remove/);
  assert.match((planTextCut(project, "m-talk", T, { remove: [{ from: 3, to: 2 }] }) as { problem: string }).problem, /same or a later one/);
  assert.match((planTextCut(project, "m-talk", T, { remove: [{ from: 3, to: 99 }] }) as { problem: string }).problem, /there's no w99/);
  assert.match((planTextCut(project, "m-talk", T, { pauses: { min: 0 } }) as { problem: string }).problem, /pauses.min/);
});

test("never an empty clip: many small cuts in a short clip all stay at least a frame", () => {
  const words = Array.from({ length: 40 }, (_, i) => ({ text: i % 2 ? "um" : "go", start: i * 0.15, end: i * 0.15 + 0.1 }));
  const project = projectWith([clip("clip-1", 0, 180)]);
  const plan = ok(planTextCut(project, "m-talk", { words, language: "en", seconds: 6 }, { fillers: true, pauses: { min: 0.05 } }));
  assert.ok(plan.ops.length > 0);
  for (const item of mainOf(plan.project)) assert.ok(item.duration >= 1);
  assert.deepEqual(timelineProblems(plan.project), []);
});

test("editWords: the words heard on the main track in edit order, at their timeline frames", () => {
  const project = projectWith([clip("a", 36, 54), clip("b-1", 0, 30, { media: "m-b" }), clip("c", 0, 40)]);
  const words = editWords(project, new Map([["m-talk", WORDS]]));
  // a plays media 36–90: um, this, is, a, test.; c plays 0–40: Hello.
  assert.deepEqual(words.map((w) => [w.clip, w.index, w.start, w.end]), [
    ["a", 1, 0, 9],
    ["a", 2, 12, 24],
    ["a", 3, 27, 33],
    ["a", 4, 36, 39],
    ["a", 5, 42, 54],
    ["c", 0, 84 + 15, 84 + 30],
  ]);
});

// Review fixes (D69): handles only for words that stay in the clip being cut.
const SEAM_WORDS = [{ text: "zero", start: 0, end: 1 }, { text: "one", start: 1, end: 1.5 }, { text: "two", start: 1.5, end: 2 }, { text: "three", start: 2, end: 3 }];
const SEAM: CutTranscript = { words: SEAM_WORDS, language: "en", seconds: 3 };
const seamProject = (main: ReadonlyArray<Item>) => ({ ...projectWith(main), media: [{ id: "m-talk", kind: "video" as const, name: "T.mp4", path: "/tmp/T.mp4", probe: { frames: 90, fps: 30, hasAudio: true } }] });

test("deleting touching words one by one ends like deleting them together (no blip from a handle)", () => {
  const project = seamProject([clip("clip-1", 0, 90)]);
  const joint = ok(planTextCut(project, "m-talk", SEAM, { remove: [{ from: 1, to: 2 }] }));
  const first = ok(planTextCut(project, "m-talk", SEAM, { remove: [{ from: 1, to: 1 }] }));
  const second = ok(planTextCut(first.project, "m-talk", SEAM, { remove: [{ from: 2, to: 2 }] }));
  assert.deepEqual(shape(joint.project), [["clip-1", 0, 32], ["clip-2", 58, 32]]);
  assert.deepEqual(shape(second.project), shape(joint.project));
  // And the other way round.
  const back = ok(planTextCut(ok(planTextCut(project, "m-talk", SEAM, { remove: [{ from: 2, to: 2 }] })).project, "m-talk", SEAM, { remove: [{ from: 1, to: 1 }] }));
  assert.equal(layout(back.project).duration, layout(joint.project).duration);
  for (const item of mainOf(back.project)) assert.ok(item.duration > 4, `no sliver: ${JSON.stringify(shape(back.project))}`);
});

test("a selection across a clip seam (ranges carrying their clip) leaves no slivers", () => {
  const project = seamProject([clip("a", 0, 45), clip("b", 45, 45)]);
  const plan = ok(planTextCut(project, "m-talk", SEAM, { remove: [{ from: 1, to: 1, clip: "a" }, { from: 2, to: 2, clip: "b" }] }));
  assert.deepEqual(shape(plan.project), [["a", 0, 32], ["b", 58, 32]]);
  assert.equal(plan.framesRemoved, 26);
  assert.deepEqual(plan.notes, []);
});

test("the panel's planner cuts a seam selection in one call per media", async () => {
  const { planCutWords, wordsOfEdit } = await import("../apps/web/src/transcript.ts");
  const project = seamProject([clip("a", 0, 45), clip("b", 45, 45)]);
  const transcripts = new Map([["m-talk", SEAM]]);
  const selected = wordsOfEdit(project, transcripts).filter((w) => w.index === 1 || w.index === 2);
  const plan = planCutWords(project, transcripts, selected);
  assert.ok(!("problem" in plan));
  const after = applyEdit(createSession(project), { actor: "user", ops: plan.ops }, timelineProblems).project;
  assert.deepEqual(shape(after), [["a", 0, 32], ["b", 58, 32]]);
  assert.equal(plan.summary, "Cut 2 words (0.9 s)");
});

test("a word shorter than a frame at the clip's speed gets its own note, and no id is spent", () => {
  const words = [{ text: "a", start: 0, end: 1 }, { text: "b", start: 1.1, end: 1.2 }, { text: "c", start: 1.3, end: 2 }];
  const project = projectWith([clip("clip-1", 0, 22, { speed: 4 })]);
  const plan = ok(planTextCut(project, "m-talk", { words, language: "en", seconds: 3 }, { remove: [{ from: 1, to: 1 }] }));
  assert.deepEqual(plan.ops, []);
  assert.match(plan.notes.join(" "), /"b" \(w1\) is too short to cut at the clip's speed/);
  assert.doesNotMatch(plan.notes.join(" "), /already cut/);
});
