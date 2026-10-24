// Issues #40 and #41 (D215) in core: any picture on Main (text as a title clip: ripple and
// transitions), a multi-source take put on Main with its parts linked (they follow ripple, splits
// and transcript cuts with their own in offsets), cut by text off Main (the item and its group's
// parts, closing up in place, Main untouched), captions from any item (anyTrack) and through a main
// clip's linked microphone.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEdit,
  captionCards,
  createSession,
  editWords,
  layout,
  planMakeCaptions,
  planTextCut,
  speechItem,
  timelineProblems,
  transcriptScope,
  visualsAt,
  type CutTranscript,
  type Item,
  type Op,
  type Project,
} from "../../packages/core/src/index.ts";
import { planPutOnMain, withLinkedAudio } from "../../packages/core/src/timeline/arrange.ts";

// 30 fps; words in seconds of the microphone's file (frame = seconds × 30).
const WORDS = [
  { text: "Hello", start: 0.5, end: 1.0 }, // w0 15–30
  { text: "um", start: 1.2, end: 1.5 }, // w1 36–45
  { text: "this", start: 1.6, end: 2.0 }, // w2 48–60
  { text: "is", start: 2.1, end: 2.3 }, // w3 63–69
  { text: "a", start: 2.4, end: 2.5 }, // w4 72–75
  { text: "test.", start: 2.6, end: 3.0 }, // w5 78–90, then a 1 s pause
  { text: "Second", start: 4.0, end: 4.5 }, // w6 120–135
  { text: "part", start: 4.6, end: 5.0 }, // w7 138–150
];
const T: CutTranscript = { words: WORDS, language: "en", seconds: 8 };

/** A camera + microphone take (D211's placement): camera on a Camera track, mic on Voiceover, grouped, aligned (mic in 12, camera in 5), at frame 30. */
function takeProject(main: ReadonlyArray<Item> = [{ id: "intro", type: "clip", media: "m-b", in: 0, duration: 90 }]): Project {
  return {
    format: "uncut/0",
    name: "Take",
    canvas: { width: 1280, height: 720, fps: 30 },
    textLooks: 1,
    media: [
      { id: "m-cam", kind: "video", name: "Take camera", path: "/tmp/camera.mp4", probe: { frames: 240, fps: 30, width: 1280, height: 720, hasAudio: false } },
      { id: "m-mic", kind: "audio", name: "Take microphone", path: "/tmp/mic.m4a", probe: { frames: 240, hasAudio: true } },
      { id: "m-b", kind: "video", name: "B.mp4", path: "/tmp/B.mp4", probe: { frames: 300, fps: 30, width: 1280, height: 720, hasAudio: false } },
    ],
    tracks: [
      { id: "camera", kind: "video", name: "Camera", items: [{ id: "cam-1", type: "clip", media: "m-cam", in: 5, start: 30, duration: 150, group: "take-1" }] },
      { id: "main", kind: "video", role: "main", name: "Main", items: main },
      {
        id: "voice",
        kind: "audio",
        name: "Voiceover",
        items: [{ id: "mic-1", type: "audio", media: "m-mic", in: 12, start: 30, duration: 150, group: "take-1" }],
      },
    ],
  };
}

const ok = <R extends object>(r: R): Exclude<R, { readonly problem: string }> => {
  assert.ok(!("problem" in r), "problem" in r ? (r as { problem: string }).problem : "");
  return r as Exclude<R, { readonly problem: string }>;
};
/** Ops applied as the server applies them (linked items follow, D123), checked with the timeline rules. */
const apply = (p: Project, ops: ReadonlyArray<Op>) => applyEdit(createSession(p), { actor: "user", ops: withLinkedAudio(p, ops) }, timelineProblems).project;
const items = (p: Project) => new Map(p.tracks.flatMap((t) => t.items.map((i) => [i.id, { ...i, track: t.id }] as const)));
const startsOf = (p: Project) => layout(p).starts;

test("rules: Main takes text, elements and graphics (not captions or sound); text still can't go on an overlay video track", () => {
  const p = takeProject([
    { id: "a", type: "clip", media: "m-b", in: 0, duration: 60 },
    { id: "title", type: "text", text: "Chapter one", duration: 60 },
    { id: "bg", type: "component", component: "component.solid", duration: 30, props: { color: "#102030" } },
  ]);
  assert.deepEqual(timelineProblems(p), []);
  const bad = structuredClone(p) as Project & { tracks: Array<{ items: Array<Item> }> };
  bad.tracks[1]!.items.push({ id: "snd", type: "audio", media: "m-mic", duration: 30 }, { id: "cap", type: "captions", source: "m-mic", duration: 30 });
  bad.tracks[0]!.items.push({ id: "t2", type: "text", text: "x", start: 200, duration: 10 });
  const codes = timelineProblems(bad)
    .filter((e) => e.code === "item-track-kind")
    .map((e) => e.message);
  assert.deepEqual(codes, ["a text item can't go on a video track", "a audio item can't go on the main track", "a captions item can't go on the main track"]);
});

test("text on Main is a title clip: transitions into and out of it need no footage, hold its looks through the overlap, and it ripples", () => {
  const p = takeProject([
    { id: "a", type: "clip", media: "m-b", in: 0, duration: 60 },
    {
      id: "title",
      type: "text",
      text: "Chapter one",
      duration: 60,
      transitionIn: { module: "transition.crossfade", duration: 10 },
      animation: { in: { module: "move.fade", duration: 10 } },
    },
    { id: "b", type: "clip", media: "m-b", in: 100, duration: 60, transitionIn: { module: "transition.push-left", duration: 10 } },
  ]);
  assert.deepEqual(timelineProblems(p), []);
  const starts = startsOf(p);
  assert.deepEqual([starts.get("a"), starts.get("title"), starts.get("b")], [0, 60, 120]);
  // Crossfade into the text: it fades in over [55, 65), its own fade-in skipped (the transition blends); the clip under it is still drawn.
  const at = (f: number) =>
    visualsAt(p, starts, f)
      .filter((v) => v.track.role === "main")
      .map((v) => [v.item.id, Math.round(v.opacity * 100) / 100]);
  assert.deepEqual(at(57), [
    ["a", 1],
    ["title", 0.2],
  ]);
  assert.deepEqual(at(60), [
    ["a", 1],
    ["title", 0.5],
  ]);
  // Pushed out by b: the text (no box) moves as the whole canvas; before its start it holds its first look.
  const push = visualsAt(p, starts, 122).find((v) => v.item.id === "title")!;
  assert.ok(push.shift! < 0, "the outgoing text moves left");
  // Ripple: delete a (its transition into the text goes too) and the text starts the edit.
  const rippled = apply(p, [
    { op: "set_transition", item: "title", transition: null },
    { op: "delete_item", item: "a" },
  ]);
  assert.deepEqual([startsOf(rippled).get("title"), startsOf(rippled).get("b")], [0, 60]);
  // A text moved from a text track onto Main (move_item) loses its start and plays in the spine.
  const withText = structuredClone(p) as Project & { tracks: Array<Record<string, unknown>> };
  (withText.tracks as Array<unknown>).unshift({
    id: "text",
    kind: "text",
    name: "Text",
    items: [{ id: "kicker", type: "text", text: "Kicker", start: 10, duration: 40 }],
  });
  const moved = apply(withText as Project, [{ op: "move_item", item: "kicker", track: "main", index: 0 }]);
  assert.equal(items(moved).get("kicker")!.track, "main");
  assert.equal(items(moved).get("kicker")!.start, undefined);
  assert.deepEqual([startsOf(moved).get("kicker"), startsOf(moved).get("a")], [0, 40]);
});

test("Put on Main: a camera + mic take goes in at the nearest cut, the mic linked (own offset kept), the Camera track goes; the mic follows ripple", () => {
  const p = takeProject();
  // Asked on the microphone: the take's picture goes.
  const plan = ok(planPutOnMain(p, "mic-1"));
  assert.equal(plan.itemId, "cam-1");
  assert.equal(plan.index, 1);
  assert.deepEqual(plan.linked, ["mic-1"]);
  assert.equal(plan.summary, "Put cam-1 on Main");
  const put = apply(p, plan.ops);
  const by = items(put);
  assert.equal(by.get("cam-1")!.track, "main");
  assert.equal(by.get("cam-1")!.group, undefined);
  assert.deepEqual(
    [by.get("mic-1")!.start, by.get("mic-1")!.in, by.get("mic-1")!.linkedTo, by.get("mic-1")!.group, by.get("mic-1")!.track],
    [90, 12, "cam-1", undefined, "voice"],
  );
  assert.ok(!put.tracks.some((t) => t.id === "camera"), "the empty Camera track goes");
  assert.equal(startsOf(put).get("cam-1"), 90);
  // Ripple: a clip inserted before it moves both; the mic keeps its own in point.
  const rippled = apply(put, [{ op: "insert_item", track: "main", index: 0, item: { id: "pre", type: "clip", media: "m-b", in: 0, duration: 30 } }]);
  assert.deepEqual([startsOf(rippled).get("cam-1"), items(rippled).get("mic-1")!.start, items(rippled).get("mic-1")!.in], [120, 120, 12]);
  // A trim of the camera's start trims the mic by as much (in moves with it, offset kept).
  const trimmed = apply(rippled, [{ op: "trim_item", item: "cam-1", edge: "start", frames: 10 }]);
  const mic = items(trimmed).get("mic-1")!;
  assert.deepEqual([items(trimmed).get("cam-1")!.in, mic.in, mic.duration, mic.start], [15, 22, 140, 120]);
  // A detached sound (D123) still gets the clip's own in point (unchanged behaviour).
  assert.deepEqual(timelineProblems(trimmed), []);
});

test("Put on Main with a screen: the screen goes on Main, the camera bubble and mic follow a split as linked pieces", () => {
  const p = takeProject([]);
  const tracks = p.tracks as Array<Project["tracks"][number]>;
  (p.media as Array<Project["media"][number]>).push({
    id: "m-screen",
    kind: "video",
    name: "Take screen",
    path: "/tmp/screen.mp4",
    probe: { frames: 240, fps: 30, width: 1280, height: 720, hasAudio: false },
  });
  tracks.unshift({
    id: "screen",
    kind: "video",
    name: "Screen",
    items: [{ id: "scr-1", type: "clip", media: "m-screen", in: 0, start: 30, duration: 150, group: "take-1" }],
  });
  (tracks[1]!.items as Array<Item>)[0] = { ...tracks[1]!.items[0]!, transform: { x: 900, y: 400, w: 300, h: 300, fit: "cover", radius: 150 } };
  const plan = ok(planPutOnMain(p, "cam-1"));
  // Asked on the camera, the camera goes (the item asked on is a picture).
  assert.equal(plan.itemId, "cam-1");
  const viaMic = ok(planPutOnMain(p, "mic-1"));
  assert.equal(viaMic.itemId, "scr-1", "a sound picks the take's screen");
  const put = apply(p, viaMic.ops);
  assert.deepEqual([...viaMic.linked].sort(), ["cam-1", "mic-1"]);
  assert.equal(startsOf(put).get("scr-1"), 0, "an empty Main: it starts the edit");
  assert.deepEqual([items(put).get("cam-1")!.start, items(put).get("mic-1")!.start], [0, 0]);
  const split = apply(put, [{ op: "split_item", item: "scr-1", at: 60, newId: "scr-2" }]);
  const pieces = [...items(split).values()].filter((i) => i.linkedTo === "scr-2");
  assert.deepEqual(pieces.map((i) => [i.type, i.start, i.in, i.duration]).sort(), [
    ["audio", 60, 72, 90],
    ["clip", 60, 65, 90],
  ]);
  assert.ok(pieces.find((i) => i.type === "clip")!.transform?.radius === 150, "the bubble piece keeps its box");
});

test("cut by text off Main: the take's mic and camera are cut in place and close up together; Main and other items don't move", () => {
  const p = takeProject();
  const scope = transcriptScope(p, "cam-1")!;
  assert.deepEqual(scope, { media: "m-mic", items: ["mic-1"], anchor: "mic-1" });
  assert.equal(speechItem(p, items(p).get("cam-1")!)!.id, "mic-1");
  // The words at the mic's own frames: Hello is media 15–30 → local 3–18 → timeline 33–48.
  const words = editWords(p, new Map([["m-mic", WORDS]]), new Set(scope.items));
  assert.deepEqual(
    words.slice(0, 2).map((w) => [w.clip, w.index, w.start, w.end]),
    [
      ["mic-1", 0, 33, 48],
      ["mic-1", 1, 54, 63],
    ],
  );
  const plan = ok(planTextCut(p, "m-mic", T, { remove: [{ from: 2, to: 5, clip: "mic-1" }], items: scope.items }));
  // Media 50–90 (5 frames kept after "um"): local 38–78, timeline 68–108; 40 frames.
  assert.equal(plan.framesRemoved, 40);
  assert.equal(plan.summary, 'Cut "this is a test." (1.3 s)');
  const after = apply(p, plan.ops);
  const by = items(after);
  const piece = (media: string) =>
    [...by.values()]
      .filter((i) => i.media === media)
      .sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
      .map((i) => [i.start, i.in, i.duration, i.group]);
  assert.deepEqual(piece("m-mic"), [
    [30, 12, 38, "take-1"],
    [68, 90, 72, "take-1"],
  ]);
  assert.deepEqual(piece("m-cam"), [
    [30, 5, 38, "take-1"],
    [68, 83, 72, "take-1"],
  ]);
  assert.deepEqual(after.tracks.find((t) => t.role === "main")!.items, p.tracks.find((t) => t.role === "main")!.items, "Main is untouched");
  // The words after the cut: "this is a test." is gone, "Second" follows the speech (media 120 → mic-2 local 30 → 98).
  const now = editWords(after, new Map([["m-mic", WORDS]]), new Set(transcriptScope(after, "cam-1")!.items));
  assert.deepEqual(
    now.map((w) => w.index),
    [0, 1, 6, 7],
  );
  assert.equal(now[2]!.start, 98);
});

test("captions from an item off Main (anyTrack) follow its own timing and its cuts; the main-track rule is unchanged for old captions", () => {
  const p = takeProject();
  const made = ok(planMakeCaptions(p, { media: "m-mic", transcript: T }));
  const withCaps = apply(p, made.ops);
  const caps = withCaps.tracks.flatMap((t) => t.items).find((i) => i.type === "captions")!;
  assert.equal(caps.anyTrack, true);
  assert.deepEqual(
    captionCards(withCaps, caps).map((c) => [c.from, c.words.map((w) => w.text).join(" ")]),
    [
      [33, "Hello um this is a test."],
      [138, "Second part"],
    ],
  );
  // Without anyTrack (a captions item from before D215) nothing of an off-main mic is captioned.
  const old = { ...caps, anyTrack: undefined } as Item;
  assert.deepEqual(captionCards(withCaps, old), []);
  // A cut by text off Main moves them with the speech.
  const plan = ok(planTextCut(withCaps, "m-mic", T, { remove: [{ from: 2, to: 5 }], items: transcriptScope(withCaps, "mic-1")!.items }));
  const cut = apply(withCaps, plan.ops);
  const caps2 = cut.tracks.flatMap((t) => t.items).find((i) => i.type === "captions")!;
  assert.deepEqual(
    captionCards(cut, caps2).map((c) => [c.from, c.words.map((w) => w.text).join(" ")]),
    [
      [33, "Hello um"],
      [98, "Second part"],
    ],
  );
});

test("the take on Main: words through the camera's linked mic, a cut by text ripples Main and the mic follows; captions through Main", () => {
  const p = apply(takeProject(), ok(planPutOnMain(takeProject(), "cam-1")).ops);
  assert.equal(transcriptScope(p, "cam-1"), undefined, "heard through Main");
  assert.equal(transcriptScope(p, "mic-1"), undefined, "a linked mic is heard through its clip on Main");
  const words = editWords(p, new Map([["m-mic", WORDS]]));
  assert.deepEqual(
    words.slice(0, 1).map((w) => [w.clip, w.via, w.start]),
    [["cam-1", "mic-1", 93]],
  );
  const made = ok(planMakeCaptions(p, { media: "m-mic", transcript: T }));
  const withCaps = apply(p, made.ops);
  const caps = withCaps.tracks.flatMap((t) => t.items).find((i) => i.type === "captions")!;
  assert.equal(caps.anyTrack, undefined, "heard through Main: the main-track rule");
  // Cut on the camera's words (the panel's ranges name the main clip).
  const plan = ok(planTextCut(withCaps, "m-mic", T, { remove: [{ from: 2, to: 5, clip: "cam-1" }] }));
  const cut = apply(withCaps, plan.ops);
  const main = cut.tracks.find((t) => t.role === "main")!.items.map((i) => [i.id, i.in, i.duration]);
  assert.deepEqual(main, [
    ["intro", 0, 90],
    ["cam-1", 5, 38],
    ["cam-2", 83, 72],
  ]);
  const mics = cut.tracks
    .find((t) => t.id === "voice")!
    .items.map((i) => [i.start, i.in, i.duration, i.linkedTo])
    .sort((a, b) => (a[0] as number) - (b[0] as number));
  assert.deepEqual(mics, [
    [90, 12, 38, "cam-1"],
    [128, 90, 72, "cam-2"],
  ]);
  const caps2 = cut.tracks.flatMap((t) => t.items).find((i) => i.type === "captions")!;
  assert.deepEqual(
    captionCards(cut, caps2).map((c) => [c.from, c.words.map((w) => w.text).join(" ")]),
    [
      [93, "Hello um"],
      [158, "Second part"],
    ],
  );
  // The same cut asked on the mic (item mode, linked): it cuts the camera on Main.
  const viaMic = ok(planTextCut(withCaps, "m-mic", T, { remove: [{ from: 2, to: 5 }], items: ["mic-1"] }));
  assert.deepEqual(
    apply(withCaps, viaMic.ops)
      .tracks.find((t) => t.role === "main")!
      .items.map((i) => [i.id, i.in, i.duration]),
    main,
  );
});

test("old projects: a main clip with its detached sound reads and cuts exactly as before (no via, the same pieces)", () => {
  const talk: Project = {
    ...takeProject([{ id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 180, mute: true }]),
  };
  (talk.media as Array<Project["media"][number]>).push({
    id: "m-talk",
    kind: "video",
    name: "Talk.mp4",
    path: "/tmp/Talk.mp4",
    probe: { frames: 180, fps: 30, width: 1280, height: 720, hasAudio: true },
  });
  (talk.tracks as Array<Project["tracks"][number]>).splice(0, 1);
  (talk.tracks as Array<Project["tracks"][number]>)[1] = {
    id: "voice",
    kind: "audio",
    name: "Audio",
    items: [{ id: "audio-1", type: "audio", media: "m-talk", in: 0, start: 0, duration: 180, linkedTo: "clip-1" }],
  };
  const words = editWords(talk, new Map([["m-talk", WORDS]]));
  assert.ok(words.every((w) => w.clip === "clip-1" && w.via === undefined));
  const plan = ok(planTextCut(talk, "m-talk", T, { remove: [{ from: 2, to: 5 }] }));
  assert.deepEqual(
    plan.ops.filter((o) => o.op !== "update_item").map((o) => o.op),
    ["split_item", "trim_item"],
  );
  const cut = apply(talk, plan.ops);
  assert.deepEqual(
    cut.tracks
      .find((t) => t.id === "voice")!
      .items.map((i) => [i.start, i.in, i.duration])
      .sort((a, b) => a[0]! - b[0]!),
    [
      [0, 0, 50],
      [50, 90, 90],
    ],
  );
});
