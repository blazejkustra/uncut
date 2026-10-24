// Phase 6 chunk 5 (D82): captions from a transcript in core. Words are a snapshot on the captions
// item (media seconds), resolved through the main-track clips at every frame, grouped into cards
// per clip, drawn as a text item by textHtml.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  activeWord,
  applyEdit,
  captionAt,
  autoMaxChars,
  captionBox,
  captionCardList,
  captionSegments,
  checkCaptionLines,
  editWords,
  captionCards,
  captionExtent,
  captionsCoverMain,
  createSession,
  layout,
  loadModules,
  planCaptionEdit,
  planMakeCaptions,
  planTextCut,
  projectDuration,
  textHtml,
  textPlacement,
  timelineProblems,
  validateProject,
  visualsAt,
  type CutTranscript,
  type Item,
  type Op,
  type Project,
} from "../../packages/core/src/index.ts";

const modules = await loadModules("spec/modules/builtin");

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

const clip = (id: string, inF: number, duration: number, extra: Partial<Item> = {}): Item => ({
  id,
  type: "clip",
  media: "m-talk",
  in: inF,
  duration,
  ...extra,
});
function projectWith(main: ReadonlyArray<Item>, captions?: Partial<Item>): Project {
  const p: Project = {
    format: "uncut/0",
    name: "Captions",
    canvas: { width: 1920, height: 1080, fps: 30 },
    textLooks: 1,
    media: [
      { id: "m-talk", kind: "video", name: "Talk.mp4", path: "/tmp/Talk.mp4", probe: { frames: 180, fps: 30, width: 1920, height: 1080, hasAudio: true } },
      { id: "m-b", kind: "video", name: "B.mp4", path: "/tmp/B.mp4", probe: { frames: 300, fps: 30, hasAudio: false } },
    ],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [] },
      { id: "main", kind: "video", role: "main", name: "Main", items: main },
    ],
  };
  if (!captions) return p;
  const made = planMakeCaptions(p, { media: "m-talk", transcript: T });
  assert.ok(!("problem" in made), "problem" in made ? made.problem : "");
  const s = applyEdit(createSession(p), { actor: "user", ops: made.ops });
  const item = capOf(s.project);
  return { ...s.project, tracks: s.project.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.id === item.id ? { ...i, ...captions } : i)) })) };
}
const capOf = (p: Project) => p.tracks.flatMap((t) => t.items).find((i) => i.type === "captions")!;
const texts = (p: Project) => captionCardList(p, capOf(p)).map((c) => c.text);
const spans = (p: Project) => captionCards(p, capOf(p)).map((c) => [c.from, c.to]);
const cut = (p: Project, ops: ReadonlyArray<Op>) => applyEdit(createSession(p), { actor: "user", ops }, timelineProblems).project;

test("Make captions: a captions item on its own track over the main track, valid, the look's position", () => {
  const p = projectWith([clip("clip-1", 0, 180)]);
  const plan = planMakeCaptions(p, { media: "m-talk", transcript: T, mode: "word" });
  assert.ok(!("problem" in plan));
  assert.equal(plan.summary, "Make captions");
  const made = applyEdit(createSession(p), { actor: "user", ops: plan.ops }).project;
  assert.deepEqual(validateProject(made, modules), []);
  assert.equal(made.tracks[0]!.name, "Captions");
  const item = capOf(made);
  assert.equal(item.id, "captions-1");
  assert.deepEqual([item.start, item.duration, item.source, item.mode], [0, 180, "m-talk", "word"]);
  assert.equal(item.words!.length, 8);
  assert.equal(item.words![1]!.filler, true, "um is a hesitation");
  assert.deepEqual(item.style, { preset: "text.caption", size: 49, weight: 600 });
  assert.deepEqual(item.transform, { x: 72, y: 864, w: 1776 }, "lower safe area, spanning the safe width");
  // Refusals.
  assert.match((planMakeCaptions(p, { media: "m-b", transcript: T }) as { problem: string }).problem, /no sound/);
  assert.match(
    (planMakeCaptions(projectWith([clip("b", 0, 90, { media: "m-b" })]), { media: "m-talk", transcript: T }) as { problem: string }).problem,
    /isn't on the timeline/,
  );
  assert.match((planMakeCaptions(p, { media: "m-talk", transcript: T, look: "text.nope" }) as { problem: string }).problem, /no text look/);
});

test("grouping: pauses, sentence ends, characters per line, 1 and 2 lines, max duration, words per line", () => {
  const main = [clip("clip-1", 0, 180)];
  // Defaults (32 chars, 2 lines, 3 s, 0.3 s pause): "test." ends a sentence and a 1 s pause follows.
  assert.deepEqual(texts(projectWith(main, {})), ["Hello um this is a test.", "Second part"]);
  // Hidden fillers.
  assert.deepEqual(texts(projectWith(main, { hideFillers: true })), ["Hello this is a test.", "Second part"]);
  // 10 characters per line, 2 lines: "Hello um" / "this is a", then "test." starts a new card (no room).
  assert.deepEqual(texts(projectWith(main, { lines: { maxChars: 10 } })), ["Hello um / this is a", "test.", "Second / part"]);
  // One line of 10.
  assert.deepEqual(texts(projectWith(main, { lines: { maxChars: 10, maxLines: 1 } })), ["Hello um", "this is a", "test.", "Second", "part"]);
  // A word longer than a line gets a line of its own.
  assert.deepEqual(texts(projectWith(main, { lines: { maxChars: 4, maxLines: 1 } })), ["Hello", "um", "this", "is a", "test.", "Second", "part"]);
  // A pause of at least 0.2 s starts a card: "Hello" → "um" is 0.2 s; the others are 0.1 s.
  assert.deepEqual(texts(projectWith(main, { lines: { pause: 0.2 } })), ["Hello", "um this is a test.", "Second part"]);
  assert.deepEqual(texts(projectWith(main, { lines: { pause: 0.1 } })), ["Hello", "um", "this", "is", "a", "test.", "Second", "part"]);
  // Max 1 s per card (first word's start to last word's end).
  assert.deepEqual(texts(projectWith(main, { lines: { maxSeconds: 1 } })), ["Hello um", "this is a", "test.", "Second part"]);
  // Two words per line, one line.
  assert.deepEqual(texts(projectWith(main, { lines: { maxWords: 2, maxLines: 1 } })), ["Hello um", "this is", "a test.", "Second part"]);
  // A forced break (re-split by the user).
  assert.deepEqual(texts(projectWith(main, { breaks: [3] })), ["Hello um this", "is a test.", "Second part"]);
});

test("card timing: first word's start to last word's end + 0.3 s hold, close cards bridged (no flicker)", () => {
  const main = [clip("clip-1", 0, 180)];
  // Card 1 ends at 90 + 9 = 99; card 2 starts at 120 (1 s later: not bridged).
  assert.deepEqual(spans(projectWith(main, {})), [
    [15, 99],
    [120, 159],
  ]);
  // 1-line cards of 10: "Hello um" (15–45) holds until "this is a" (48): bridged.
  assert.deepEqual(
    spans(projectWith(main, { lines: { maxChars: 10, maxLines: 1 } })),
    [
      [15, 48],
      [48, 78],
      [78, 99],
      [120, 138],
      [138, 159],
    ],
    '"Second part" is 11 characters',
  );
  // Captions never make the video longer, and the window clips the cards.
  const p = projectWith(main, { duration: 130, coversMain: false });
  assert.equal(layout(p).duration, 180);
  assert.deepEqual(spans(p), [
    [15, 99],
    [120, 130],
  ]);
  assert.equal(projectDuration(projectWith(main, { duration: 9000, coversMain: false })), 180);
  assert.deepEqual(captionExtent(p, capOf(p)), { from: 15, to: 130 });
});

test("mapping through cuts: a split, a trim, a transcript_edit removal", () => {
  const p = projectWith([clip("clip-1", 0, 180)], {});
  // A split between "is" and "a" (frame 70): cards are per clip, the timing doesn't move.
  const split = cut(p, [{ op: "split_item", item: "clip-1", at: 70, newId: "clip-2" }]);
  assert.deepEqual(texts(split), ["Hello um this is", "a test.", "Second part"]);
  assert.deepEqual(spans(split), [
    [15, 72],
    [72, 99],
    [120, 159],
  ]);
  // A trim of the first second: "Hello" goes, the rest moves 30 frames earlier.
  const trimmed = cut(p, [{ op: "trim_item", item: "clip-1", edge: "start", frames: 30 }]);
  assert.deepEqual(texts(trimmed), ["um this is a test.", "Second part"]);
  assert.deepEqual(spans(trimmed), [
    [6, 69],
    [90, 129],
  ]);
  // transcript_edit removes "this is a" (w2–w4): the words vanish, the rest follows the cut.
  const plan = planTextCut(p, "m-talk", T, { remove: [{ from: 2, to: 4 }] });
  assert.ok(!("problem" in plan));
  const edited = cut(p, plan.ops);
  assert.deepEqual(texts(edited), ["Hello um", "test.", "Second part"]);
  const removed = plan.framesRemoved;
  assert.ok(removed > 20);
  const cards = captionCards(edited, capOf(edited));
  // "test." starts where its frames landed after the cut (78 − removed), "Second" 120 − removed.
  assert.equal(cards[1]!.words[0]!.from, 78 - removed);
  assert.equal(cards[2]!.from, 120 - removed);
  for (const c of cards) for (const w of c.words) assert.ok(![2, 3, 4].includes(w.index), "removed words aren't in any card");
});

test("mapping: two clips of the same media, a clip used twice, a clip with a transition", () => {
  // Two clips: "Second part" first (in 110), then "Hello um this" (in 0, 62 frames).
  const two = projectWith([clip("a", 110, 70), clip("b", 0, 62)], {});
  assert.deepEqual(texts(two), ["Second part", "Hello um this"]);
  assert.deepEqual(spans(two), [
    [10, 49],
    [85, 132],
  ]);
  // The same stretch twice: the words show twice, each where it plays.
  const twice = projectWith([clip("a", 0, 100), clip("b", 0, 100)], {});
  assert.deepEqual(texts(twice), ["Hello um this is a test.", "Hello um this is a test."]);
  assert.deepEqual(spans(twice), [
    [15, 99],
    [115, 199],
  ]);
  // A crossfade into the second clip: cards stay on the clips' own frames (no doubles in the
  // overlap); the 11-frame gap between them is bridged.
  const faded = projectWith([clip("a", 0, 100), clip("b", 110, 70, { transitionIn: { module: "transition.crossfade", duration: 10 } })], {});
  assert.deepEqual(texts(faded), ["Hello um this is a test.", "Second part"]);
  assert.deepEqual(spans(faded), [
    [15, 110],
    [110, 149],
  ]);
  for (let f = 90; f < 110; f++) assert.ok(visualsAt(faded, layout(faded).starts, f).filter((v) => v.item.id === capOf(faded).id).length <= 1);
});

test("a word straddling a cut goes to the clip that plays its middle, clipped to it", () => {
  // "this" is 48–60; a clip ending at 57 plays its middle (54): it's there, ending at the clip's end.
  const a = projectWith([clip("a", 0, 57), clip("b", 120, 60)], {});
  const cards = captionCards(a, capOf(a));
  const w = cards.flatMap((c) => c.words).find((x) => x.index === 2)!;
  assert.deepEqual([w.from, w.to], [48, 57]);
  // A clip ending at 53 doesn't (middle 54): the word is gone; the next clip starts with "Second".
  const b = projectWith([clip("a", 0, 53), clip("b", 120, 60)], {});
  assert.deepEqual(texts(b), ["Hello um", "Second part"]);
});

test("word mode: the speaking word is accented on each frame; single mode shows only it", () => {
  const p = projectWith([clip("clip-1", 0, 180)], { mode: "word" });
  const item = capOf(p);
  const at = (f: number) => captionAt(p, item, f)?.text;
  assert.equal(at(14), undefined);
  assert.equal(at(15), "[[Hello]] um this is a test.");
  assert.equal(at(35), "[[Hello]] um this is a test.", "between words the last one stays lit");
  assert.equal(at(36), "Hello [[um]] this is a test.");
  assert.equal(at(80), "Hello um this is a [[test.]]");
  assert.equal(at(98), "Hello um this is a [[test.]]");
  assert.equal(at(99), undefined);
  assert.equal(at(140.6), "Second [[part]]");
  const card = captionCards(p, item)[0]!;
  assert.deepEqual(
    [15, 47, 48, 63, 72, 78].map((f) => activeWord(card, f)),
    [0, 1, 2, 3, 4, 5],
  );
  const single = projectWith([clip("clip-1", 0, 180)], { mode: "single" });
  assert.equal(captionAt(single, capOf(single), 64)!.text, "is");
  // A two-line card in word mode keeps its lines.
  const lines = projectWith([clip("clip-1", 0, 180)], { mode: "word", lines: { maxChars: 10 } });
  assert.equal(captionAt(lines, capOf(lines), 50)!.text, "Hello um\n[[this]] is a");
  // The drawn HTML: the accent is a span (textHtml), its colour the theme's accent.
  assert.match(textHtml(captionAt(p, item, 36)!, p), /Hello <span class="accent">um<\/span> this/);
});

test("bottom-anchored: every card is drawn from the bottom edge of a full card, so fewer lines sit lower and wraps grow up", () => {
  const p = projectWith([clip("clip-1", 0, 180)], { lines: { maxChars: 10 } });
  const item = capOf(p);
  const two = captionAt(p, item, 20)!;
  const one = captionAt(p, item, 80)!;
  assert.equal(two.text, "Hello um\nthis is a");
  assert.equal(one.text, "test.");
  const size = textPlacement(item, p).size;
  const box = captionBox(p, item);
  assert.ok(Math.abs(box.bottom - (864 + 2 * size * 1.4)) < 1e-9, "the top (864) plus two of text.caption's lines");
  for (const t of [one, two]) {
    assert.equal(t.anchor, "bottom");
    assert.equal(t.transform!.y, box.bottom);
  }
  assert.match(textHtml(one, p), /bottom:7\.29\d*%/, "CSS bottom, not top");
  assert.doesNotMatch(textHtml(one, p), /top:/);
});

test("corrections, hidden words and breaks: edited in one update, kept through a re-cut and a remake", () => {
  const p = projectWith([clip("clip-1", 0, 180)], {});
  const edit = planCaptionEdit(p, capOf(p).id, {
    words: [
      { index: 6, text: "Argent" },
      { index: 1, text: "" },
    ],
  });
  assert.ok(!("problem" in edit));
  assert.equal(edit.summary, "Fix 2 caption words");
  const fixed = cut(p, edit.ops);
  assert.deepEqual(capOf(fixed).edits, [
    { word: 1, text: "" },
    { word: 6, text: "Argent" },
  ]);
  assert.deepEqual(texts(fixed), ["Hello this is a test.", "Argent part"]);
  const brk = planCaptionEdit(fixed, capOf(fixed).id, { breaks: [{ index: 3, on: true }] });
  assert.ok(!("problem" in brk));
  assert.equal(brk.summary, "Start a caption card");
  const split = cut(fixed, brk.ops);
  assert.deepEqual(texts(split), ["Hello this", "is a test.", "Argent part"]);
  // Re-cut: remove "test." with transcript_edit; corrections stay on their words.
  const plan = planTextCut(split, "m-talk", T, { remove: [{ from: 5, to: 5 }] });
  assert.ok(!("problem" in plan));
  const recut = cut(split, plan.ops);
  assert.deepEqual(texts(recut), ["Hello this", "is a", "Argent part"]);
  // Back to the transcript's word: the correction goes; the same text as the transcript is no edit.
  const restore = planCaptionEdit(recut, capOf(recut).id, {
    words: [
      { index: 6, text: null },
      { index: 2, text: "this" },
    ],
  });
  assert.ok(!("problem" in restore));
  assert.deepEqual(capOf(cut(recut, restore.ops)).edits, [{ word: 1, text: "" }]);
  // Remaking from the same transcript keeps them and refits the window; a different one drops them.
  const remake = planMakeCaptions(recut, { media: "m-talk", transcript: T, mode: "word" });
  assert.ok(!("problem" in remake) && remake.remade);
  const again = cut(recut, remake.ops);
  assert.deepEqual(capOf(again).edits, capOf(recut).edits);
  assert.equal(capOf(again).mode, "word");
  assert.equal(capOf(again).duration, layout(again).duration);
  const other = planMakeCaptions(recut, { media: "m-talk", transcript: { ...T, words: WORDS.map((w, i) => (i === 0 ? { ...w, text: "Hi" } : w)) } });
  assert.ok(!("problem" in other));
  assert.equal(capOf(cut(recut, other.ops)).edits, undefined);
  // Refusals and no-ops.
  assert.match((planCaptionEdit(p, capOf(p).id, { words: [{ index: 99, text: "x" }] }) as { problem: string }).problem, /no word 99/);
  assert.match((planCaptionEdit(p, "clip-1", { mode: "word" }) as { problem: string }).problem, /isn't a captions item/);
  assert.deepEqual(planCaptionEdit(p, capOf(p).id, { mode: "line" }), { ops: [], summary: "" });
  const modes = planCaptionEdit(p, capOf(p).id, { mode: "word" });
  assert.equal("summary" in modes && modes.summary, "Captions word by word");
});

test("the window: without coversMain, cards draw only inside it; cover fits it again; Make captions covers the main track whatever comes later", () => {
  const made = projectWith([clip("clip-1", 0, 180)], {});
  assert.equal(capOf(made).coversMain, true);
  const grown = cut(made, [{ op: "insert_item", track: "main", item: clip("clip-2", 0, 100) }]);
  assert.ok(captionsCoverMain(grown, capOf(grown)));
  assert.deepEqual(texts(grown), ["Hello um this is a test.", "Second part", "Hello um this is a test."], "clips added later get captions too");
  const p = projectWith([clip("clip-1", 0, 180)], { coversMain: false });
  const shorter = cut(p, [{ op: "trim_item", item: "clip-1", edge: "end", frames: 60 }]);
  assert.equal(layout(shorter).duration, 120, "the video ends with the main track");
  assert.ok(captionsCoverMain(shorter, capOf(shorter)));
  const longer = cut(p, [{ op: "insert_item", track: "main", item: clip("clip-2", 0, 100) }]);
  assert.ok(!captionsCoverMain(longer, capOf(longer)));
  assert.deepEqual(texts(longer), ["Hello um this is a test.", "Second part"], "cards past the window don't draw");
  const cover = planCaptionEdit(longer, capOf(longer).id, { cover: true });
  assert.ok(!("problem" in cover));
  assert.equal(cover.summary, "Fit captions to the edit");
  assert.deepEqual(texts(cut(longer, cover.ops)), ["Hello um this is a test.", "Second part", "Hello um this is a test."]);
});

test("visualsAt draws the card as a text item with the captions' id; hidden track draws nothing", () => {
  const p = projectWith([clip("clip-1", 0, 180)], {});
  const { starts } = layout(p);
  const v = visualsAt(p, starts, 50).find((x) => x.item.id === capOf(p).id)!;
  assert.equal(v.item.type, "text");
  assert.equal(v.item.text, "Hello um this is a test.");
  assert.equal(v.opacity, 1);
  assert.ok(!visualsAt(p, starts, 110).some((x) => x.item.id === capOf(p).id));
  const hidden = { ...p, tracks: p.tracks.map((t, i) => (i === 0 ? { ...t, hidden: true } : t)) };
  assert.ok(!visualsAt(hidden, starts, 50).some((x) => x.item.id === capOf(p).id));
});

test("old projects are unaffected: a captions item without words is valid and draws nothing; the examples keep their length", async () => {
  const longform = JSON.parse(await readFile("spec/examples/drone-weekend.uncut/project.json", "utf8")) as Project;
  assert.deepEqual(validateProject(longform, modules), []);
  assert.equal(projectDuration(longform), 36000);
  const cap = longform.tracks.flatMap((t) => t.items).find((i) => i.type === "captions")!;
  assert.deepEqual(captionCards(longform, cap), []);
  assert.ok(!visualsAt(longform, layout(longform).starts, 100).some((v) => v.item.id === cap.id));
  // A project without captions draws exactly what it drew (no captions code path is taken).
  const plain = projectWith([clip("clip-1", 0, 180)]);
  assert.deepEqual(
    visualsAt(plain, layout(plain).starts, 50).map((v) => v.item.id),
    ["clip-1"],
  );
  // Schema: bad words and settings are refused.
  const p = projectWith([clip("clip-1", 0, 180)], {});
  const bad = (patch: Partial<Item>) =>
    validateProject({ ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.type === "captions" ? { ...i, ...patch } : i)) })) }, modules);
  assert.ok(bad({ lines: { maxLines: 3 } }).length > 0);
  assert.ok(bad({ mode: "karaoke" as never }).length > 0);
  assert.ok(bad({ words: [{ text: "x", start: -1, end: 0 }] }).length > 0);
  assert.deepEqual(bad({ mode: "single", hideFillers: true, breaks: [2], lines: { maxChars: 20, maxLines: 1, maxSeconds: 2, pause: 0.5, maxWords: 4 } }), []);
});

const portrait = (width: number, height: number, main: ReadonlyArray<Item>, words: CutTranscript): Project => {
  const p: Project = { ...projectWith(main), canvas: { width, height, fps: 30 } };
  const made = planMakeCaptions(p, { media: "m-talk", transcript: words });
  assert.ok(!("problem" in made));
  return applyEdit(createSession(p), { actor: "user", ops: made.ops }).project;
};

test("characters per line follow the canvas: 32 at 16:9, fewer at 4:5 and 9:16 (font-aware); an explicit maxChars wins", () => {
  const item = { style: { preset: "text.caption", size: 49, weight: 600 } };
  assert.equal(autoMaxChars(item, { canvas: { width: 1920, height: 1080 } }), 32);
  const fourFive = autoMaxChars({ style: { preset: "text.caption", size: 61, weight: 600 } }, { canvas: { width: 1080, height: 1350 } });
  const nineSixteen = autoMaxChars({ style: { preset: "text.caption", size: 86, weight: 600 } }, { canvas: { width: 1080, height: 1920 } });
  assert.ok(fourFive >= 20 && fourFive <= 26, `4:5: ${fourFive}`);
  assert.ok(nineSixteen >= 12 && nineSixteen < fourFive, `9:16: ${nineSixteen}`);
  assert.ok(
    autoMaxChars({ style: { preset: "text.caption", size: 61, weight: 600, uppercase: true } }, { canvas: { width: 1080, height: 1350 } }) < fourFive,
    "capitals are wider",
  );
  const long: CutTranscript = {
    words: "Every caption line should fit inside the safe area of a tall canvas without wrapping"
      .split(" ")
      .map((text, i) => ({ text, start: 0.2 + i * 0.25, end: 0.4 + i * 0.25 })),
    seconds: 6,
  };
  const p = portrait(1080, 1350, [clip("clip-1", 0, 180)], long);
  const max = autoMaxChars(capOf(p), p);
  for (const c of captionCardList(p, capOf(p))) for (const line of c.text.split(" / ")) assert.ok(line.length <= max, `"${line}" > ${max}`);
  const set = portrait(1080, 1350, [clip("clip-1", 0, 180)], long);
  const explicit = {
    ...set,
    tracks: set.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.type === "captions" ? { ...i, lines: { maxChars: 40 } } : i)) })),
  };
  assert.ok(captionCardList(explicit, capOf(explicit)).some((c) => c.text.split(" / ").some((l) => l.length > max)));
});

test("the hold stays inside the clip when the next clip is other footage; a card shows at least 0.7 s; abbreviations don't end sentences", () => {
  // "test." ends at 90: the hold would run to 99, but the clip ends at 92 and B-roll follows.
  const cutAway = projectWith([clip("clip-1", 0, 92), clip("b", 0, 60, { media: "m-b" })], {});
  assert.deepEqual(spans(cutAway), [[15, 92]]);
  // The same media next: the hold may run on past the cut (bridged up to its next card at 102).
  const same = projectWith([clip("clip-1", 0, 92), clip("clip-2", 110, 70)], {});
  assert.deepEqual(spans(same), [
    [15, 102],
    [102, 141],
  ]);
  // One short word alone (pause 0.1 s: every word its own card) still shows 0.7 s when there's room.
  const short = projectWith([clip("clip-1", 0, 180)], { lines: { pause: 0.1 } });
  const cards = captionCards(short, capOf(short));
  assert.deepEqual([cards.at(-1)!.from, cards.at(-1)!.to], [138, 159]);
  const one = captionCards(short, capOf(short)).find((c) => c.words[0]!.index === 4)!;
  assert.deepEqual([one.from, one.to], [72, 78], '"a" (72–75) holds to the next card');
  const abbrev: CutTranscript = {
    words: ["I", "met", "Dr.", "Smith", "today.", "Then", "home."].map((text, i) => ({ text, start: 0.5 + i * 0.3, end: 0.7 + i * 0.3 })),
    seconds: 6,
  };
  const p = portrait(1920, 1080, [clip("clip-1", 0, 180)], abbrev);
  assert.deepEqual(texts(p), ["I met Dr. Smith today.", "Then home."]);
});

test("word mode: a word ending in ] keeps the accent around the whole word", () => {
  const p = projectWith([clip("clip-1", 0, 180)], { mode: "word", edits: [{ word: 0, text: "[Hello]" }] });
  const text = captionAt(p, capOf(p), 20)!.text!;
  assert.match(textHtml(captionAt(p, capOf(p), 20)!, p), /<span class="accent">\[Hello\]\u200B<\/span> um/);
  assert.ok(text.startsWith("[[[Hello]"));
});

test("segments: one look per card (line) or speaking word, equal to captionAt on every frame", () => {
  for (const mode of ["line", "word", "single"] as const) {
    const p = projectWith([clip("a", 0, 100), clip("b", 110, 70)], { mode });
    const item = capOf(p);
    const segs = captionSegments(p, item);
    assert.equal(segs.length, mode === "line" ? 2 : 8);
    for (const s of segs) for (let f = s.from; f < s.to; f++) assert.deepEqual(captionAt(p, item, f), s.text, `${mode} ${f}`);
    let covered = 0;
    for (let f = 0; f < 180; f++) if (captionAt(p, item, f)) covered++;
    assert.equal(
      segs.reduce((n, s) => n + s.to - s.from, 0),
      covered,
    );
  }
});

test("planners keep to the schema's bounds; restore labels; an empty Captions track is reused; a remake says how many fixes it dropped", () => {
  const p = projectWith([clip("clip-1", 0, 180)], {});
  const id = capOf(p).id;
  for (const lines of [
    { maxChars: 3 },
    { maxChars: 10.5 },
    { maxLines: 3 },
    { maxSeconds: 0 },
    { maxSeconds: 31 },
    { pause: 11 },
    { maxWords: 0 },
    { colour: 1 },
  ]) {
    assert.ok("problem" in planCaptionEdit(p, id, { lines: lines as never }), JSON.stringify(lines));
    assert.ok("problem" in planMakeCaptions(p, { media: "m-talk", transcript: T, lines: lines as never }), JSON.stringify(lines));
  }
  assert.deepEqual(checkCaptionLines({ maxChars: 20, pause: null }, true), { lines: { maxChars: 20, pause: null } });
  const fixed = cut(p, (planCaptionEdit(p, id, { words: [{ index: 6, text: "Argent" }] }) as { ops: Array<Op> }).ops);
  assert.equal((planCaptionEdit(fixed, id, { words: [{ index: 6, text: "Second" }] }) as { summary: string }).summary, 'Restore caption word "Second"');
  assert.equal((planCaptionEdit(fixed, id, { words: [{ index: 6, text: null }] }) as { summary: string }).summary, 'Restore caption word "Second"');
  const other = planMakeCaptions(fixed, { media: "m-talk", transcript: { ...T, words: WORDS.map((w, i) => (i === 0 ? { ...w, text: "Hi" } : w)) } });
  assert.ok(!("problem" in other));
  assert.deepEqual([other.fixesDropped, other.summary], [1, "Remake captions (1 fix dropped)"]);
  // Deleting the captions leaves their track empty; Make captions uses it again.
  const gone = cut(fixed, [{ op: "delete_item", item: id }]);
  const again = planMakeCaptions(gone, { media: "m-talk", transcript: T });
  assert.ok(!("problem" in again));
  assert.deepEqual(
    again.ops.map((o) => o.op),
    ["insert_item"],
  );
  assert.deepEqual(validateProject(cut(gone, again.ops), modules), []);
});

test("editWords: 9000 words under 3000 clips in well under a pointer move's budget", () => {
  const sized = (n: number) => {
    const words = Array.from({ length: 3 * n }, (_, i) => ({ text: `w${i}`, start: i * 0.4, end: i * 0.4 + 0.3 }));
    const main = Array.from({ length: n }, (_, k) => clip(`c${k}`, k * 36, 30));
    const project: Project = {
      ...projectWith([]),
      media: [{ id: "m-talk", kind: "video", name: "T", path: "/tmp/T.mp4", probe: { frames: 200000, fps: 30, hasAudio: true } }],
      tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: main }],
    };
    return { project, transcripts: new Map([["m-talk", words]]) };
  };
  // #89: the fastest of several runs (a busy machine only ever adds time), and the cost of 10× the
  // input relative to 1×, so a full test run's load can't fail it but a quadratic scan still does.
  const fastest = ({ project, transcripts }: ReturnType<typeof sized>) => {
    editWords(project, transcripts);
    let best = Infinity;
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      editWords(project, transcripts);
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  const { project: p, transcripts } = sized(3000);
  const words = transcripts.get("m-talk")!;
  const out = editWords(p, transcripts);
  const ms = fastest(sized(3000));
  const small = fastest(sized(300));
  console.log(`  editWords: ${out.length} words heard in ${ms.toFixed(1)} ms (a tenth of it: ${small.toFixed(2)} ms)`);
  assert.ok(out.length > 6000);
  assert.ok(ms < 50, `${ms} ms`);
  // Linear is ~10×, quadratic ~100×; below a millisecond the small run is mostly timer noise.
  assert.ok(ms < 30 * Math.max(small, 0.5), `10× the words and clips cost ${(ms / small).toFixed(0)}× (${small.toFixed(2)} → ${ms.toFixed(1)} ms)`);
  // Same answer as the plain scan for words out of order (the fallback).
  const shuffled = words.slice(0, 50).reverse();
  const q: Project = { ...p, tracks: [{ ...p.tracks[0]!, items: [clip("c0", 0, 300)] }] };
  assert.equal(editWords(q, new Map([["m-talk", shuffled]])).length, 25);
});
