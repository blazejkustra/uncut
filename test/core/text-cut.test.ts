// Phase 5 chunk 5 (D69): core planTextCut, cutting a media's words, pauses and fillers out of the
// main track as one edit, and editWords, the words heard in edit order (the Transcript panel).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, decodeEnvelope, editWords, encodeEnvelope, handleFrames, layout, pausesOf, planTextCut, speechEdges, speechWords, tailFrames, timelineProblems, undoTurn, type CutTranscript, type Item, type Project, type TextCutPlan } from "../../packages/core/src/index.ts";

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

test("handles: 2 frames before a kept word at 24–30 fps (more at 50/60), 0.15 s after one (D74)", () => {
  assert.deepEqual([24, 25, 30, 50, 60].map(handleFrames), [2, 2, 2, 3, 4]);
  assert.deepEqual([24, 25, 30, 50, 60].map(tailFrames), [4, 4, 5, 8, 9]);
});

test("one word: cut over its frames, the clip splits and closes up, one edit", () => {
  const project = projectWith([clip("clip-1", 0, 180)]);
  const plan = ok(planTextCut(project, "m-talk", T, { remove: [{ from: 1, to: 1 }] }));
  // "um" covers 36–45; the words around it end at 30 (+5 tail) and start at 48 (−2 head): no handle bites.
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
  // Two cuts inside a clip: the new pieces are numbered left to right. "is" (63–69) keeps the 5-frame
  // tail of "this" (ends at 60): cut 65–69.
  const two = ok(planTextCut(project, "m-talk", T, { remove: [{ from: 1, to: 1 }, { from: 3, to: 3 }] }));
  assert.deepEqual(shape(two.project), [["clip-1", 0, 36], ["clip-2", 45, 20], ["clip-3", 69, 111]]);
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
  // this … test. = 48–90, from 50: the word before ("um") ends at 45 and keeps its 5-frame tail;
  // the next starts at 120 − 2: no handle bites there.
  assert.deepEqual(plan.cuts.map((c) => [c.from, c.to, c.words, c.text, c.clips]), [[50, 90, [2, 5], "this is a test.", ["a", "b"]]]);
  assert.deepEqual(plan.ops, [
    { op: "trim_item", item: "a", edge: "end", frames: 10 },
    { op: "trim_item", item: "b", edge: "start", frames: 30 },
  ]);
  assert.deepEqual(shape(plan.project), [["a", 0, 50], ["b", 90, 90]]);
  assert.equal(plan.framesRemoved, 40);
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
  // Lead 0–0.5 s → [0, 13) (2 before "Hello"); the 1 s gap 3.0–4.0 → [95, 118) (5 after "test.",
  // 2 before "Second"); the tail 5.0–6.0 → [155, 180) (5 after "part").
  assert.deepEqual(plan.cuts.map((c) => [c.from, c.to, c.pauses]), [[0, 13, 1], [95, 118, 1], [155, 180, 1]]);
  assert.equal(plan.framesRemoved, 13 + 23 + 25);
  assert.deepEqual(shape(plan.project), [["clip-1", 13, 82], ["clip-2", 118, 37]]);
  assert.equal(plan.summary, "Removed 3 pauses (2.0 s)");
  // Shorter pauses only at a lower threshold: nothing between 0.3 and 0.5 s here except none, so the same.
  assert.equal(ok(planTextCut(project, "m-talk", T, { pauses: { min: 2 } })).ops.length, 0);
  assert.match(ok(planTextCut(project, "m-talk", T, { pauses: { min: 2 } })).notes.join(" "), /no pauses that long/);
});

test("pauses follow the silences when given (as transcript_read's do)", () => {
  const project = projectWith([clip("clip-1", 0, 180)]);
  const plan = ok(planTextCut(project, "m-talk", T, { pauses: { min: 0.5 }, silences: [{ start: 3.2, end: 3.9 }] }));
  // The gap 3.0–4.0 follows the silence 3.2–3.9: [96 + 5, 117 − 2).
  assert.deepEqual(plan.cuts.map((c) => [c.from, c.to]), [[0, 13], [101, 115], [155, 180]]);
});

test("a removed word and the pause next to it make one cut (no handle between them)", () => {
  const project = projectWith([clip("clip-1", 0, 180)]);
  const plan = ok(planTextCut(project, "m-talk", T, { remove: [{ from: 5, to: 5 }], pauses: { min: 0.5 } }));
  // test. 78–90 (from 80: "a" ends at 75 + 5) runs straight into the pause 90–118.
  assert.deepEqual(plan.cuts.map((c) => [c.from, c.to, c.text, c.pauses]), [[0, 13, "", 1], [80, 118, "test.", 1], [155, 180, "", 1]]);
  assert.equal(plan.summary, "Cut 1 word and 3 pauses (2.5 s)");
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

test("handles keep 5 frames after and 2 before touching words; a word too tight to cut is a note", () => {
  const project = projectWith([clip("clip-1", 0, 180)]);
  const words = [
    { text: "ab", start: 1.0, end: 1.4 }, // 30–42
    { text: "cd", start: 1.5, end: 1.8 }, // 45–54
    { text: "ef", start: 1.8, end: 2.0 }, // 54–60
    { text: "x", start: 2.0, end: 2.05 }, // 60–62
    { text: "gh", start: 2.05, end: 2.3 },
  ];
  const plan = ok(planTextCut(project, "m-talk", { words, language: "en", seconds: 6 }, { remove: [{ from: 1, to: 1 }] }));
  // cd 45–54 keeps 42 + 5 after "ab" and 2 before "ef" (54): 47–52.
  assert.deepEqual(plan.cuts.map((c) => [c.from, c.to]), [[47, 52]]);
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
  const words = Array.from({ length: 15 }, (_, i) => ({ text: i % 2 ? "um" : "go", start: i * 0.4, end: i * 0.4 + 0.25 }));
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
  assert.deepEqual(shape(joint.project), [["clip-1", 0, 35], ["clip-2", 58, 32]]);
  assert.deepEqual(shape(second.project), shape(joint.project));
  // And the other way round.
  const back = ok(planTextCut(ok(planTextCut(project, "m-talk", SEAM, { remove: [{ from: 2, to: 2 }] })).project, "m-talk", SEAM, { remove: [{ from: 1, to: 1 }] }));
  assert.equal(layout(back.project).duration, layout(joint.project).duration);
  for (const item of mainOf(back.project)) assert.ok(item.duration > 4, `no sliver: ${JSON.stringify(shape(back.project))}`);
});

test("a selection across a clip seam (ranges carrying their clip) leaves no slivers", () => {
  const project = seamProject([clip("a", 0, 45), clip("b", 45, 45)]);
  const plan = ok(planTextCut(project, "m-talk", SEAM, { remove: [{ from: 1, to: 1, clip: "a" }, { from: 2, to: 2, clip: "b" }] }));
  assert.deepEqual(shape(plan.project), [["a", 0, 35], ["b", 58, 32]]);
  assert.equal(plan.framesRemoved, 23);
  assert.deepEqual(plan.notes, []);
});

test("the panel's planner cuts a seam selection in one call per media", async () => {
  const { planCutWords, wordsOfEdit } = await import("../../apps/web/src/panels/transcript.ts");
  const project = seamProject([clip("a", 0, 45), clip("b", 45, 45)]);
  const transcripts = new Map([["m-talk", SEAM]]);
  const selected = wordsOfEdit(project, transcripts).filter((w) => w.index === 1 || w.index === 2);
  const plan = planCutWords(project, transcripts, selected);
  assert.ok(!("problem" in plan));
  const after = applyEdit(createSession(project), { actor: "user", ops: plan.ops }, timelineProblems).project;
  assert.deepEqual(shape(after), [["a", 0, 35], ["b", 58, 32]]);
  assert.equal(plan.summary, "Cut 2 words (0.8 s)");
});

test("a word shorter than a frame at the clip's speed gets its own note, and no id is spent", () => {
  const words = [{ text: "a", start: 0, end: 1 }, { text: "b", start: 1.1, end: 1.2 }, { text: "c", start: 1.3, end: 2 }];
  const project = projectWith([clip("clip-1", 0, 22, { speed: 4 })]);
  const plan = ok(planTextCut(project, "m-talk", { words, language: "en", seconds: 3 }, { remove: [{ from: 1, to: 1 }] }));
  assert.deepEqual(plan.ops, []);
  assert.match(plan.notes.join(" "), /"b" \(w1\) is too short to cut at the clip's speed/);
  assert.doesNotMatch(plan.notes.join(" "), /already cut/);
});

test("removing pauses twice changes nothing the second time, even when a silence takes a mistimed word's middle (D72)", () => {
  // Whisper heard "shakes" at 1.2–1.6 s, but the sound is silent from 1.0 to 1.6 s: the pause after
  // "picture" follows the silence and takes the middle of "shakes"; "a" and "lot." come right after.
  const words = [
    { text: "the", start: 0.2, end: 0.4 },
    { text: "picture", start: 0.4, end: 1.0 },
    { text: "shakes", start: 1.2, end: 1.6 },
    { text: "a", start: 1.6, end: 1.7 },
    { text: "lot.", start: 1.7, end: 2.2 },
    { text: "Next", start: 3.4, end: 3.8 },
    { text: "week.", start: 3.8, end: 4.4 },
  ];
  const t: CutTranscript = { words, language: "en", seconds: 6 };
  const silences = [{ start: 1.0, end: 1.6 }, { start: 2.3, end: 3.4 }, { start: 4.5, end: 6 }];
  const first = ok(planTextCut(projectWith([clip("clip-1", 0, 180)]), "m-talk", t, { pauses: { min: 0.5 }, silences }));
  assert.ok(first.framesRemoved > 0);
  const again = ok(planTextCut(first.project, "m-talk", t, { pauses: { min: 0.5 }, silences }));
  assert.deepEqual(again.cuts, [], JSON.stringify(again.cuts));
  assert.equal(again.ops.length, 0);
});

test("Remove pauses, then cutting a word with pauses: no sliver between the word's cut and the pause's (D72 review)", () => {
  // "shakes" is timed late: a silence (0.95–1.52 s) takes its middle, another follows it (1.6–2.4 s).
  const words = [
    { text: "the", start: 0.2, end: 0.4 },
    { text: "picture", start: 0.4, end: 1.0 },
    { text: "shakes", start: 1.2, end: 1.6 },
    { text: "lot", start: 2.4, end: 2.8 },
    { text: "end.", start: 2.8, end: 3.2 },
  ];
  const t: CutTranscript = { words, language: "en", seconds: 6 };
  const silences = [{ start: 0.95, end: 1.52 }, { start: 1.6, end: 2.4 }, { start: 3.3, end: 6 }];
  const first = ok(planTextCut(projectWith([clip("clip-1", 0, 180)]), "m-talk", t, { pauses: { min: 0.5 }, silences }));
  assert.deepEqual(shape(first.project), [["clip-1", 0, 35], ["clip-2", 43, 10], ["clip-3", 70, 34]]);
  const second = ok(planTextCut(first.project, "m-talk", t, { remove: [{ from: 1, to: 1 }], pauses: { min: 0.5 }, silences }));
  assert.deepEqual(shape(second.project), [["clip-1", 0, 17], ["clip-3", 70, 34]]);
  assert.ok(mainOf(second.project).every((i) => i.duration >= 3));
});

// D74: the end of a kept word survives a cut (whisper's ends run early; a word's decay is quiet).
const cutsOf = (words: ReadonlyArray<{ text: string; start: number; end: number }>, extra: Partial<CutTranscript> = {}, silences?: ReadonlyArray<{ start: number; end: number }>) =>
  ok(planTextCut(projectWith([clip("clip-1", 0, 180)]), "m-talk", { words, language: "en", seconds: 6, ...extra }, { pauses: { min: 0.5 }, silences })).cuts.map((c) => [c.from, c.to]);

test("a word's quiet decay inside a −40 dB silence is kept: the pause starts after the word's end, then the tail", () => {
  const words = [{ text: "one", start: 1.0, end: 2.0 }, { text: "two", start: 4.0, end: 5.0 }];
  // The silence starts at 1.9 s, while whisper still hears the word (its decay under −40 dB).
  const cuts = cutsOf(words, {}, [{ start: 1.9, end: 3.95 }]);
  assert.deepEqual(cuts[1], [60 + 5, 118 - 2]);
});

test("a sentence's last word ends no earlier than its segment (whisper's word end runs early)", () => {
  const words = [{ text: "the", start: 1.0, end: 1.3 }, { text: "end.", start: 1.3, end: 1.6 }, { text: "Next", start: 4.0, end: 4.4 }];
  const segments = [{ start: 1.0, end: 2.0, words: [0, 2] as const }, { start: 4.0, end: 4.5, words: [2, 3] as const }];
  // Without segments the pause would start at 48 + 5; the segment says the sentence runs to 2.0 s.
  assert.deepEqual(cutsOf(words)[1], [53, 118]);
  assert.deepEqual(cutsOf(words, { segments })[1], [60 + 5, 118]);
  // And a silence that starts later still (the sound goes on): the word lasts until it.
  assert.deepEqual(cutsOf(words, { segments }, [{ start: 2.2, end: 3.9 }])[1], [66 + 5, 117 - 2]);
  // A segment end at (or past) the next word is punctuation timed there (D68), not sound: ignored.
  const tight = [{ text: "a.", start: 1.0, end: 1.2 }, { text: "b", start: 1.6, end: 1.8 }];
  const after0 = (segEnd: number) => pausesOf(tight, 6, undefined, 0.05, [{ start: 1.0, end: segEnd, words: [0, 1] }]).filter((p) => p.after === 0).map((p) => [p.start, p.end]);
  assert.deepEqual(after0(1.55), [[1.2, 1.6]]);
  assert.deepEqual(after0(1.4), [[1.4, 1.6]]);
});

test("out points round outward: a word ending mid-frame keeps that frame, then the tail", () => {
  const words = [{ text: "one", start: 1.0, end: 2.71 }, { text: "two", start: 4.0, end: 5.0 }];
  // 2.71 s is in frame 81: the pause starts at 82 + 5.
  assert.deepEqual(cutsOf(words)[1], [87, 118]);
});

test("a word whisper starts late keeps its head: the pause ends at the silence's end, less the head", () => {
  const words = [{ text: "one", start: 1.0, end: 2.0 }, { text: "two", start: 4.0, end: 5.0 }];
  // The sound starts again at 3.5 s (the silence ends there); whisper says 4.0.
  assert.deepEqual(cutsOf(words, {}, [{ start: 2.0, end: 3.5 }])[1], [65, 105 - 2]);
});

test("speechWords only widens words, never past their neighbours, and is idempotent", () => {
  const words = [{ text: "a", start: 1.0, end: 1.2 }, { text: "b.", start: 1.3, end: 1.5 }, { text: "c", start: 3.0, end: 3.2 }];
  const opts = { segments: [{ start: 1.0, end: 1.9, words: [0, 2] as const }, { start: 2.8, end: 3.4, words: [2, 3] as const }], silences: [{ start: 2.1, end: 2.9 }], seconds: 6 };
  const once = speechWords(words, opts);
  assert.deepEqual(once.map((w) => [w.text, w.start, w.end]), [["a", 1.0, 1.2], ["b.", 1.3, 2.1], ["c", 2.9, 3.4]]);
  assert.deepEqual(speechWords(once, opts), once);
  for (let i = 0; i < words.length; i++) assert.ok(once[i]!.start <= words[i]!.start && once[i]!.end >= words[i]!.end);
  // A word wholly inside a silence (whisper mistimed it) moves to the nearer edge, in order (and,
  // a timestamp, gets 0.1 s on the side away from the silence).
  const inside = speechWords([{ text: "x.", start: 1.0, end: 1.5 }, { text: "late", start: 2.1, end: 2.3 }, { text: "early", start: 3.6, end: 3.7 }, { text: "y", start: 3.8, end: 4.4 }], { silences: [{ start: 2.0, end: 4.0 }] });
  assert.deepEqual(inside.map((w) => [w.text, w.start, w.end]), [["x.", 1.0, 1.5], ["late", 1.9, 2.0], ["early", 4.0, 4.0], ["y", 4.0, 4.4]]);
});

// Regression (D74): the real agent run behind "the last words are always cut in half". Talk.mp4 of
// the phase 5 manual check, whisper large-v3-turbo-q5_0 words and segments (w23–w30), its loudness
// silence (−40 dB, 0.3 s) between the sentences. The sound of "Croatia." stops at 8.47 s (RMS at
// −50 dB re speech) and "The first" starts at 9.98 s; whisper says 7.82 and 9.52.
test("the real example: 'Croatia.' keeps its end and 'The first' its start", () => {
  const words = [
    { text: "same", start: 6.31, end: 6.54 },
    { text: "harbor", start: 6.54, end: 6.95 },
    { text: "shot", start: 6.95, end: 7.22 },
    { text: "from", start: 7.22, end: 7.49 },
    { text: "Croatia.", start: 7.49, end: 7.82 },
    { text: "The", start: 9.52, end: 9.52 },
    { text: "first", start: 9.52, end: 9.52 },
    { text: "take", start: 9.52, end: 9.52 },
    { text: "was", start: 9.52, end: 9.59 },
    { text: "flown", start: 9.83, end: 10.03 },
  ];
  const segments = [{ start: 4.02, end: 8.28, words: [0, 5] as const }, { start: 9.52, end: 13.26, words: [5, 10] as const }];
  const project = { ...projectWith([clip("clip-1", 0, 360)]), media: [{ id: "m-talk", kind: "video" as const, name: "Talk.mp4", path: "/tmp/Talk.mp4", probe: { frames: 360, fps: 30, hasAudio: true } }] };
  const plan = (silences?: ReadonlyArray<{ start: number; end: number }>) =>
    ok(planTextCut(project, "m-talk", { words, language: "en", seconds: 12, segments }, { pauses: { min: 0.5 }, silences })).cuts.find((c) => c.from > 200)!;
  // Before D74 (whisper's word end + 2 frames) the pause cut started at frame 237 (7.90 s), 0.57 s
  // into "Croatia.". Now: with the silence, at 8.46 s + 5 frames (8.63 s, past the sound's end), and
  // the next piece starts 2 frames before the silence ends (9.90 s, before "The" at 9.98 s).
  const withSilence = plan([{ start: 8.46, end: 9.982 }]);
  assert.deepEqual([withSilence.from, withSilence.to], [254 + 5, 299 - 2]);
  assert.ok(withSilence.from / 30 > 8.47 && withSilence.to / 30 < 9.98);
  // Without the loudness pass, the segment's end (8.28 s) + the tail: 8.47 s, where the sound stops;
  // "The" (a timestamp, 9.52–9.52) gets 0.1 s before it.
  const noSilence = plan();
  assert.deepEqual([noSilence.from, noSilence.to], [249 + 5, 282 - 2]);
  assert.ok(noSilence.from / 30 >= 8.46);
  // The words whisper put inside the silence are heard (and listed) in the piece after it.
  const sil = [{ start: 8.46, end: 9.982 }];
  const cut = ok(planTextCut(project, "m-talk", { words, language: "en", seconds: 12, segments }, { pauses: { min: 0.5 }, silences: sil }));
  const heard = editWords(cut.project, new Map([["m-talk", speechWords(words, { segments, silences: sil, seconds: 12 })]]));
  const pieceOf = (i: number) => heard.find((w) => w.index === i)?.clip;
  assert.deepEqual([5, 6, 7, 8, 9].map(pieceOf), Array(5).fill(pieceOf(9)));
  assert.notEqual(pieceOf(9), pieceOf(4));
  // Remove pauses again: nothing more to cut (idempotent), with and without the silence.
  for (const silences of [[{ start: 8.46, end: 9.982 }], undefined]) {
    const first = ok(planTextCut(project, "m-talk", { words, language: "en", seconds: 12, segments }, { pauses: { min: 0.5 }, silences }));
    const again = ok(planTextCut(first.project, "m-talk", { words, language: "en", seconds: 12, segments }, { pauses: { min: 0.5 }, silences }));
    assert.equal(again.ops.length, 0, JSON.stringify(again.cuts));
    assert.ok(mainOf(first.project).every((i) => i.duration >= 3));
  }
});

// D74, the speech envelope (the loudness analyzer's RMS every 10 ms): words end where their sound does.
/** An envelope of `seconds` at −100 dBFS with [start, end, dB] stretches (and per-window levels from `at`). */
function envelopeOf(seconds: number, parts: ReadonlyArray<readonly [number, number, number]>, at?: { start: number; db: ReadonlyArray<number> }) {
  const db = new Float32Array(Math.round(seconds * 100)).fill(-100);
  for (const [a, b, v] of parts) for (let k = Math.round(a * 100); k < Math.round(b * 100); k++) db[k] = v;
  if (at) at.db.forEach((v, i) => (db[Math.round(at.start * 100) + i] = v));
  return { rate: 100, db };
}

test("envelope: stored as one byte per 10 ms (0.5 dB steps) and read back", () => {
  const stored = encodeEnvelope([-100, -60.2, -12, 0, -200, Number.NEGATIVE_INFINITY]);
  assert.deepEqual([stored.rate, stored.db0, stored.step], [100, -100, 0.5]);
  assert.deepEqual(Array.from(decodeEnvelope(stored)!.db), [-100, -60, -12, 0, -100, -100]);
  assert.equal(decodeEnvelope({ rate: 100, data: 1 }), undefined);
});

test("envelope: a kept word's tail follows its sound past whisper's end (a short stop-consonant dip doesn't end it), its head likewise", () => {
  const words = [{ text: "one", start: 1.0, end: 1.6 }, { text: "two", start: 3.0, end: 3.5 }];
  // The sound of "one": 0.9–1.9 s with a 60 ms dip at 1.7 s; "two" from 2.8 s.
  const env = envelopeOf(6, [[0.9, 1.9, -14], [1.7, 1.76, -70], [2.8, 3.6, -14]]);
  const heard = speechWords(words, { envelope: env, seconds: 6 });
  assert.deepEqual(heard.map((w) => [w.start, w.end]), [[0.9, 1.9], [2.8, 3.6]]);
  assert.deepEqual(speechWords(heard, { envelope: env, seconds: 6 }), heard, "idempotent");
  const project = projectWith([clip("clip-1", 0, 180)]);
  const plan = ok(planTextCut(project, "m-talk", { words, language: "en", seconds: 6 }, { pauses: { min: 0.5 }, envelope: env }));
  // The pause between them: from 57 (1.9 s) + 5 to 84 (2.8 s) − 2; the clip ends 5 frames after "two"'s sound.
  assert.deepEqual(plan.cuts.map((c) => [c.from, c.to]), [[0, 25], [62, 82], [113, 180]]);
  const again = ok(planTextCut(plan.project, "m-talk", { words, language: "en", seconds: 6 }, { pauses: { min: 0.5 }, envelope: env }));
  assert.equal(again.ops.length, 0, "Remove pauses twice: nothing the second time");
  // Sound that runs from one word into the next: the gap is split at its quietest window (here the
  // first, all being equal), not given to the earlier word, and those edges aren't "measured".
  const touching = speechEdges([{ text: "a", start: 1.0, end: 1.2 }, { text: "b", start: 1.5, end: 1.8 }], { envelope: envelopeOf(3, [[1.0, 1.8, -14]]) });
  assert.deepEqual(touching.words.map((w) => [w.start, w.end]), [[1.0, 1.2], [1.2, 1.8]]);
  assert.deepEqual([touching.endMeasured[0], touching.startMeasured[1]], [false, false]);
  const dip = speechEdges([{ text: "a", start: 1.0, end: 1.2 }, { text: "b", start: 1.5, end: 1.8 }], { envelope: envelopeOf(3, [[1.0, 1.8, -14], [1.3, 1.35, -30], [1.32, 1.33, -60]]) });
  assert.deepEqual(dip.words.map((w) => [w.start, w.end]), [[1.0, 1.32], [1.33, 1.8]], "split at the quietest window of a short dip");
});

test("a filler whisper gave no length is removed whole: its sound with the envelope, 0.2 s around it without", () => {
  // "review." then "Um," at 4.02–4.02 (a timestamp); its sound is 4.00–4.35 s; "today" from 4.5 s.
  const words = [{ text: "review.", start: 3.28, end: 3.71 }, { text: "Um,", start: 4.02, end: 4.02 }, { text: "today", start: 4.5, end: 4.8 }];
  const env = envelopeOf(6, [[3.25, 3.85, -14], [4.0, 4.35, -15], [4.5, 4.9, -14]]);
  const project = projectWith([clip("clip-1", 0, 180)]);
  const cut = (envelope?: ReturnType<typeof envelopeOf>) => ok(planTextCut(project, "m-talk", { words, language: "en", seconds: 6 }, { fillers: true, envelope })).cuts.map((c) => [c.from, c.to]);
  assert.deepEqual(cut(env), [[120, 131]], "4.00–4.35 s: all of it");
  // Without the envelope: 3.92–4.12 s, after the 5-frame tail of "review." (ends at frame 112).
  assert.deepEqual(cut(), [[117, 124]]);
});

// Regression (D74): "spray." in the phase 5 manual run lost its end before the removed "Ah, I almost…"
// (a 0.19 s gap: no −40 dB silence of 0.3 s there). The envelope 21.0–22.5 s is the real one.
test("the real example: 'spray.' keeps its end before a removed sentence, with the envelope", () => {
  const real = [-19, -21, -20, -17, -13, -12, -13, -14, -12, -14, -12, -13, -14, -11, -13, -11, -13, -13, -17, -21, -25, -28, -31, -31, -31, -29, -31, -30, -31, -30, -26, -14, -13, -13, -14, -13, -13, -13, -14, -12, -13, -14, -12, -13, -13, -15, -13, -13, -13, -15, -14, -16, -21, -26, -31, -34, -39, -41, -39, -40, -34, -31, -29, -28, -28, -28, -31, -30, -32, -34, -40, -57, -61, -66, -67, -69, -69, -50, -39, -18, -14, -14, -13, -14, -13, -13, -15, -14, -14, -15, -14, -14, -16, -14, -15, -16, -14, -15, -16, -15, -15, -16, -17, -17, -16, -17, -18, -18, -20, -20, -21, -21, -22, -24, -28, -31, -33, -38, -49, -66, -100, -100, -100, -100, -100, -100, -100, -100, -100, -100, -100, -100, -100, -100, -100, -100, -100, -100, -100, -73, -42, -18, -14, -14, -14, -13, -13, -14, -13, -13];
  const env = envelopeOf(24, [[20.0, 21.0, -14], [22.5, 23.0, -14]], { start: 21.0, db: real });
  const words = [
    { text: "salt", start: 20.82, end: 21.15 },
    { text: "spray.", start: 21.15, end: 21.57 },
    { text: "Ah,", start: 22.42, end: 22.42 },
    { text: "I", start: 22.42, end: 22.42 },
    { text: "almost", start: 22.73, end: 22.78 },
  ];
  const segments = [{ start: 18, end: 21.9, words: [0, 2] as const }, { start: 22.42, end: 26.22, words: [2, 5] as const }];
  const project = { ...projectWith([clip("clip-1", 600, 120)]), media: [{ id: "m-talk", kind: "video" as const, name: "Talk.mp4", path: "/tmp/Talk.mp4", probe: { frames: 720, fps: 30, hasAudio: true } }] };
  const plan = (envelope?: ReturnType<typeof envelopeOf>) => ok(planTextCut(project, "m-talk", { words, language: "en", seconds: 24, segments }, { remove: [{ from: 2, to: 4 }], envelope })).cuts[0]!;
  // The sound of "spray." stops at 22.19 s (the p's closure at 21.71 s doesn't end it); "Ah" starts at 22.40 s.
  assert.equal(plan(env).from, 672);
  assert.ok(plan(env).from / 30 > 22.19);
  // Without the envelope: "Ah," (a timestamp) gets 0.1 s before it, so the cut starts at 22.30 s.
  assert.equal(plan().from, 669);
});

// D74 review: the envelope must never clip a kept word itself.
test("envelope: deleting 'um' right before 'Hello' (their sound 60 ms apart) keeps Hello's onset and its margin", () => {
  // um's sound 1.00–1.30 s, a 60 ms dip, Hello's from 1.36 s; whisper: um 1.0–1.25, Hello 1.44–1.75.
  const words = [{ text: "So", start: 0.5, end: 0.8 }, { text: "um", start: 1.0, end: 1.25 }, { text: "Hello", start: 1.44, end: 1.75 }];
  const env = envelopeOf(3, [[0.5, 0.82, -20], [1.0, 1.3, -20], [1.36, 1.8, -20]]);
  const project = { ...projectWith([clip("clip-1", 0, 90)]), media: [{ id: "m-talk", kind: "video" as const, name: "T.mp4", path: "/tmp/T.mp4", probe: { frames: 90, fps: 30, hasAudio: true } }] };
  for (const envelope of [undefined, env]) {
    const cuts = ok(planTextCut(project, "m-talk", { words, language: "en", seconds: 3 }, { remove: [{ from: 1, to: 1 }], envelope })).cuts.map((c) => [c.from, c.to]);
    // Hello's sound starts in frame 40 (1.36 s): the cut stops 2 frames before it.
    assert.deepEqual(cuts, [[30, 38]], envelope ? "with the envelope" : "without");
  }
});

test("envelope: words whose sound runs together are cut on whisper's edges with the margins, as without it", () => {
  const words = [{ text: "I", start: 0.5, end: 0.7 }, { text: "really", start: 0.7, end: 1.1 }, { text: "like", start: 1.1, end: 1.4 }, { text: "it.", start: 1.4, end: 1.6 }];
  const env = envelopeOf(3, [[0.5, 1.7, -20]]);
  const project = { ...projectWith([clip("clip-1", 0, 90)]), media: [{ id: "m-talk", kind: "video" as const, name: "T.mp4", path: "/tmp/T.mp4", probe: { frames: 90, fps: 30, hasAudio: true } }] };
  for (const envelope of [undefined, env]) {
    const cuts = ok(planTextCut(project, "m-talk", { words, language: "en", seconds: 3 }, { remove: [{ from: 1, to: 1 }], envelope })).cuts.map((c) => [c.from, c.to]);
    assert.deepEqual(cuts, [[26, 31]], envelope ? "with the envelope" : "without");
  }
});

test("envelope: breaths and a noise bed between words don't count as speech; pauses are still found and tails kept", () => {
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const bed of [-70, -60, -50, -40, -32]) {
    for (const breath of [false, true]) {
      // 0.4 s words every 1.2 s; each word's sound decays over 0.1 s after whisper's end; a breath at −45 dBFS 0.15–0.35 s after.
      const words: Array<{ text: string; start: number; end: number }> = [];
      for (let t = 0.5; t < 19; t += 1.2) words.push({ text: "w", start: Math.round(t * 1000) / 1000, end: Math.round((t + 0.4) * 1000) / 1000 });
      const db = Array.from({ length: 2000 }, (_, k) => {
        const s = k / 100;
        const w = words.find((x) => s >= x.start && s < x.end + 0.1);
        let v = w ? (s < w.end ? -20 + rnd() * 4 : -30) : bed + (rnd() - 0.5) * 8;
        if (breath && words.some((x) => s >= x.end + 0.15 && s < x.end + 0.35)) v = Math.max(v, -45);
        return v;
      });
      const env = decodeEnvelope(encodeEnvelope(db))!;
      const pauses = pausesOf(words, 20, undefined, 0.5, undefined, env);
      assert.equal(pauses.length, 17, `bed ${bed}, breath ${breath}: ${pauses.length} pauses`);
      const heard = speechWords(words, { seconds: 20, envelope: env });
      // No word swallowed its pause; and where the decay (−30 dBFS) stands out from the bed, every
      // word's tail (to 0.1 s after whisper's end) is inside it (over a −32 dB bed it can't be told
      // apart: the cut's 0.15 s margin keeps it).
      for (const [i, w] of heard.entries()) {
        assert.ok(w.end - w.start < 0.75, `bed ${bed}, breath ${breath}: ${JSON.stringify(w)}`);
        if (bed <= -40 && i < heard.length - 1) assert.ok(w.end >= words[i]!.end + 0.1 - 0.011, `bed ${bed}, breath ${breath}: ${JSON.stringify(w)}`);
      }
    }
  }
});

test("speechWords fuzz: idempotent and in order with segments, silences and an envelope", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  for (let trial = 0; trial < 3000; trial++) {
    const db: Array<number> = [];
    const bursts: Array<[number, number]> = [];
    for (let q = Math.floor(rnd() * 50); q > 0; q--) db.push(-70);
    for (let b = 0; b < 6; b++) {
      const len = 10 + Math.floor(rnd() * 60);
      const s = db.length;
      for (let q = 0; q < len; q++) db.push(-20 - rnd() * 15 - (q > len - 8 ? (q - (len - 8)) * 5 : 0));
      bursts.push([s / 100, db.length / 100]);
      for (let q = Math.floor(rnd() * 80); q > 0; q--) db.push(rnd() < 0.1 ? -45 : -70);
    }
    const seconds = db.length / 100;
    const silences: Array<{ start: number; end: number }> = [];
    let st = -1;
    for (let q = 0; q <= db.length; q++) {
      const quiet = q < db.length && db[q]! < -40;
      if (quiet && st < 0) st = q;
      if (!quiet && st >= 0) {
        if (q - st >= 30) silences.push({ start: st / 100, end: q / 100 });
        st = -1;
      }
    }
    const words: Array<{ text: string; start: number; end: number }> = [];
    let prevEnd = 0;
    for (const [a, b] of bursts) {
      const m = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < m; i++) {
        let s = a + ((b - a) * i) / m + (rnd() - 0.5) * 0.15;
        let e = a + ((b - a) * (i + 1)) / m - rnd() * 0.4;
        if (rnd() < 0.15) e = s;
        s = r3(Math.max(prevEnd, s));
        e = r3(Math.max(s, e));
        words.push({ text: "w", start: s, end: e });
        prevEnd = e;
      }
    }
    const n = words.length;
    const segments = [{ start: r3(Math.max(0, words[0]!.start - 0.1)), end: r3(Math.min(seconds, words[n - 1]!.end + 0.3)), words: [0, n] as const }];
    const opts = { segments, silences, seconds, envelope: decodeEnvelope(encodeEnvelope(db)) };
    const once = speechWords(words, opts);
    assert.deepEqual(speechWords(once, opts), once, `trial ${trial}`);
    for (let i = 1; i < n; i++) assert.ok(once[i]!.start >= once[i - 1]!.end - 1e-9, `trial ${trial}: words ${i - 1} and ${i} overlap`);
  }
});

test("fuzz: deleting words one by one leaves no piece under 3 frames, with or without the envelope", () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const useEnv of [false, true]) {
    for (let t = 0; t < 600; t++) {
      const fps = [24, 25, 30, 60][Math.floor(rnd() * 4)]!;
      const words: Array<{ text: string; start: number; end: number }> = [];
      let x = 0.3 + rnd();
      for (let i = 0; i < 8; i++) {
        const len = 0.05 + rnd() * 0.4;
        const gap = rnd() < 0.6 ? 0 : rnd() * 0.3;
        words.push({ text: `w${i}`, start: +(x + gap).toFixed(3), end: +(x + gap + len).toFixed(3) });
        x += gap + len;
      }
      const seconds = x + 1;
      const frames = Math.ceil(seconds * fps);
      const db = Array.from({ length: Math.ceil(seconds * 100) }, (_, k) => (words.some((w) => k / 100 >= w.start - 0.03 && k / 100 < w.end + 0.12) ? -20 : -70));
      const envelope = useEnv ? decodeEnvelope(encodeEnvelope(db)) : undefined;
      const project: Project = { ...projectWith([clip("c", 0, frames)]), canvas: { width: 320, height: 180, fps: fps as Project["canvas"]["fps"] }, media: [{ id: "m-talk", kind: "video", name: "T.mp4", path: "/tmp/T.mp4", probe: { frames, fps, hasAudio: true } }] };
      const tr = { words, seconds };
      const b = 2 + Math.floor(rnd() * 4);
      const order = Array.from({ length: b - 1 }, (_, k) => 2 + k);
      if (rnd() < 0.5) order.reverse();
      let p = project;
      for (const i of order) {
        const q = ok(planTextCut(p, "m-talk", tr, { remove: [{ from: i, to: i }], envelope }));
        if (q.ops.length) p = q.project;
      }
      assert.ok(mainOf(p).every((i) => i.duration >= 3), `${useEnv ? "env" : "no env"} trial ${t}: ${JSON.stringify(shape(p))}`);
    }
  }
});
