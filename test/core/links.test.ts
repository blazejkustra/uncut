// Timeline v2 phase 2 (D347): links by delta. A clip and its sound share a `link` and get the same
// move, the same trim of edges that lined up, a split at the same frame, the same middle cut, the
// same speed change and delete; ⌥ (solo) edits one side; a J/L cut stays through unrelated edits;
// old linkedTo projects read as links and convert without changing what plays.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEdit,
  audibleAt,
  captionCards,
  createSession,
  editWords,
  layout,
  loadModules,
  planTextCut,
  validateProject,
  visualsAt,
  type Item,
  type Op,
  type Project,
} from "../../packages/core/src/index.ts";
import {
  legacyLinkOps,
  linkDrift,
  linkIndex,
  planDetachAudio,
  planLink,
  planMoveIntoSync,
  planSetSpeed,
  planUnlink,
  takenIds,
  withLinks,
} from "../../packages/core/src/timeline/arrange.ts";
import { planRippleDelete } from "../../apps/web/src/timeline/edit.ts";

const modules = await loadModules("spec/modules/builtin");
const probe = { frames: 900, fps: 30, width: 320, height: 180, hasAudio: true };

/** V1: a, b (each with its sound on A1); V2: an off-main clip `v` with its sound `vs` on A2. */
const project = (): Project => ({
  format: "uncut/0",
  name: "Links",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "cam", kind: "video", name: "cam.mp4", path: "/cam.mp4", probe },
    { id: "music", kind: "audio", name: "music.m4a", path: "/music.m4a", probe: { frames: 900, fps: 30, hasAudio: true } },
  ],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [{ id: "title", type: "text", start: 0, duration: 60, text: "Hi" }] },
    {
      id: "v2",
      kind: "video",
      name: "Video 2",
      items: [{ id: "v", type: "clip", media: "cam", in: 500, start: 400, duration: 100, mute: true, link: "link-v" }],
    },
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "a", type: "clip", media: "cam", in: 0, duration: 120, mute: true, link: "link-a" },
        { id: "b", type: "clip", media: "cam", in: 200, duration: 120, mute: true, link: "link-b" },
      ],
    },
    {
      id: "a1",
      kind: "audio",
      name: "Audio",
      items: [
        { id: "as", type: "audio", media: "cam", in: 0, start: 0, duration: 120, link: "link-a" },
        { id: "bs", type: "audio", media: "cam", in: 200, start: 120, duration: 120, link: "link-b" },
      ],
    },
    { id: "a2", kind: "audio", name: "Audio 2", items: [{ id: "vs", type: "audio", media: "cam", in: 500, start: 400, duration: 100, link: "link-v" }] },
    { id: "bed", kind: "audio", name: "Music", items: [{ id: "song", type: "audio", media: "music", in: 0, start: 600, duration: 200 }] },
  ],
});

const linked = (p: Project, ops: ReadonlyArray<Op>) => {
  const out = withLinks(p, ops);
  assert.ok(!("problem" in out), JSON.stringify(out));
  return out.ops;
};
const edit = (p: Project, ops: ReadonlyArray<Op>) => {
  const next = applyEdit(createSession(p), { actor: "user", ops: linked(p, ops) }).project;
  assert.deepEqual(validateProject(next, modules), []);
  return next;
};
const find = (p: Project, id: string) => p.tracks.flatMap((t) => t.items).find((i) => i.id === id);
/** [start, in, duration] of an item, its start resolved (main items have none of their own). */
const geo = (p: Project, id: string) => {
  const item = find(p, id);
  return item ? [layout(p).starts.get(id), item.in ?? 0, item.duration] : undefined;
};
const onTrack = (p: Project, track: string) =>
  p.tracks
    .find((t) => t.id === track)!
    .items.map((i) => ({ id: i.id, start: i.start, in: i.in, duration: i.duration, link: i.link }))
    .sort((x, y) => x.start! - y.start!);

test("the fixture is valid and its pairs are in sync", () => {
  const p = project();
  assert.deepEqual(validateProject(p, modules), []);
  assert.deepEqual([...linkIndex(p.tracks).members.keys()].sort(), ["link-a", "link-b", "link-v"]);
  for (const id of ["a", "as", "b", "bs", "v", "vs"]) assert.equal(linkDrift(p, id), 0, id);
  assert.equal(linkDrift(p, "song"), undefined);
});

test("move: a clip moved off Main moves its sound; a ripple on Main carries the sounds of the clips after", () => {
  const p = project();
  const moved = edit(p, [{ op: "move_item", item: "v", start: 430 }]);
  assert.deepEqual(geo(moved, "vs"), [430, 500, 100]);
  // Deleting a (the engine closes up): its sound goes, b's sound moves left with b.
  const rippled = edit(p, [{ op: "delete_item", item: "a" }]);
  assert.equal(find(rippled, "as"), undefined);
  assert.deepEqual(geo(rippled, "bs"), [0, 200, 120]);
});

test("move: the sound moved alone takes its main clip along, and a clip it pushes takes its own sound", () => {
  const p = project();
  const q = edit(p, [{ op: "move_item", item: "as", start: 40 }]);
  assert.deepEqual(geo(q, "a"), [40, 0, 120]);
  // b was in the way: pushed to a's new end, and its sound came along.
  assert.deepEqual(geo(q, "b"), [160, 200, 120]);
  assert.deepEqual(geo(q, "bs"), [160, 200, 120]);
  for (const id of ["a", "as", "b", "bs"]) assert.equal(linkDrift(q, id), 0, id);
});

test("trim: an edge that lined up is trimmed too, on Main (ripple, start kept) and off it", () => {
  const p = project();
  const end = edit(p, [{ op: "trim_item", item: "v", edge: "end", frames: 30 }]);
  assert.deepEqual(geo(end, "vs"), [400, 500, 70]);
  const start = edit(p, [{ op: "trim_item", item: "v", edge: "start", frames: 20 }]);
  assert.deepEqual(geo(start, "vs"), [420, 520, 80]);
  // Main keeps the start and ripples: a's sound loses its first 20 frames in place, b's moves left.
  const main = edit(p, [{ op: "trim_item", item: "a", edge: "start", frames: 20 }]);
  assert.deepEqual(
    [geo(main, "a"), geo(main, "as"), geo(main, "bs")],
    [
      [0, 20, 100],
      [0, 20, 100],
      [100, 200, 120],
    ],
  );
  // Lengthened back: the sound grows with it.
  const longer = edit(start, [{ op: "trim_item", item: "v", edge: "start", frames: -20 }]);
  assert.deepEqual(geo(longer, "vs"), [400, 500, 100]);
});

test("trim: an edge that didn't line up (an L cut) stays; ⌥ trims one side only", () => {
  const p = project();
  // ⌥: the sound runs 30 frames past its clip (an L cut); the clip stays as it was.
  const l = edit(p, [{ op: "trim_item", item: "vs", edge: "end", frames: -30, solo: true }]);
  assert.deepEqual(
    [geo(l, "v"), geo(l, "vs")],
    [
      [400, 500, 100],
      [400, 500, 130],
    ],
  );
  // Trimming the clip's end now leaves the sound's later end alone.
  const t = edit(l, [{ op: "trim_item", item: "v", edge: "end", frames: 10 }]);
  assert.deepEqual(
    [geo(t, "v"), geo(t, "vs")],
    [
      [400, 500, 90],
      [400, 500, 130],
    ],
  );
  // Its start still lines up: a start trim takes both.
  const s = edit(t, [{ op: "trim_item", item: "v", edge: "start", frames: 10 }]);
  assert.deepEqual(
    [geo(s, "v"), geo(s, "vs")],
    [
      [410, 510, 80],
      [410, 510, 120],
    ],
  );
  assert.equal(linkDrift(s, "vs"), 0, "a J/L cut is still in sync");
});

test("split: the sound splits at the same frame and each half is linked with the clip's half over it", () => {
  const p = project();
  const q = edit(p, [{ op: "split_item", item: "v", at: 40, newId: "v-2" }]);
  const sounds = onTrack(q, "a2");
  assert.deepEqual(
    sounds.map((s) => [s.start, s.in, s.duration]),
    [
      [400, 500, 40],
      [440, 540, 60],
    ],
  );
  assert.equal(sounds[0]!.link, find(q, "v")!.link);
  assert.equal(sounds[1]!.link, find(q, "v-2")!.link);
  assert.notEqual(sounds[0]!.link, sounds[1]!.link);
  // ⌥: only the clip is cut, the sound stays whole (linked with both halves).
  const solo = edit(p, [{ op: "split_item", item: "v", at: 40, newId: "v-2", solo: true }]);
  assert.equal(onTrack(solo, "a2").length, 1);
  // A split of the left half later moves only its own sound.
  const moved = edit(q, [{ op: "move_item", item: "v-2", start: 470 }]);
  assert.deepEqual(
    onTrack(moved, "a2").map((s) => s.start),
    [400, 470],
  );
});

test("ripple delete and delete: a clip's sound goes with it; the clips after keep their sounds under them", () => {
  const p = project();
  const gone = edit(p, [{ op: "delete_item", item: "v" }]);
  assert.equal(find(gone, "vs"), undefined);
  const both = edit(p, [
    { op: "delete_item", item: "a" },
    { op: "delete_item", item: "as" },
  ]);
  assert.deepEqual(
    [geo(both, "b"), geo(both, "bs")],
    [
      [0, 200, 120],
      [0, 200, 120],
    ],
  );
});

test("ripple delete of a sound alone (the timeline's ⇧⌫): its clip goes too and the next pair closes up together", () => {
  const p = project();
  const plan = planRippleDelete(p, ["as"]);
  assert.ok(!("problem" in plan));
  const q = edit(p, plan.ops);
  assert.deepEqual([find(q, "a"), find(q, "as")], [undefined, undefined]);
  assert.deepEqual([geo(q, "b"), geo(q, "bs")], [
    [0, 200, 120],
    [0, 200, 120],
  ]);
});

test("speed: the sound takes the clip's speed and length; the sounds after move with the ripple", () => {
  const p = project();
  const plan = planSetSpeed(p, "a", 2);
  assert.ok(!("problem" in plan));
  const q = edit(p, plan.ops);
  assert.deepEqual([find(q, "as")!.speed, find(q, "as")!.duration, find(q, "as")!.start], [2, 60, 0]);
  assert.deepEqual([find(q, "a")!.link, find(q, "as")!.link], ["link-a", "link-a"]);
  assert.deepEqual(geo(q, "bs"), [60, 200, 120]);
});

test("transcript cut: the cut words leave the sound too, the rest stays under its clip", () => {
  const p = project();
  const words = [
    { text: "Hello", start: 0.5, end: 1.0 },
    { text: "um", start: 1.2, end: 1.5 },
    { text: "this", start: 1.6, end: 2.0 },
  ];
  const cut = planTextCut(p, "cam", { words, language: "en", seconds: 30 }, { remove: [{ from: 1, to: 1 }] });
  assert.ok(!("problem" in cut), JSON.stringify(cut));
  const q = edit(p, cut.ops);
  const sounds = onTrack(q, "a1");
  const pictures = q.tracks.find((t) => t.id === "main")!.items;
  const starts = layout(q).starts;
  // One sound piece under each picture piece, same frames, same link.
  assert.equal(sounds.length, pictures.length);
  for (const pic of pictures) {
    const s = sounds.find((x) => x.link === pic.link)!;
    assert.deepEqual([s.start, s.in, s.duration], [starts.get(pic.id), pic.in, pic.duration], pic.id);
  }
  for (let f = 0; f < 200; f += 2) {
    const heard = audibleAt(q, starts, f).filter((a) => a.item.media === "cam");
    assert.ok(heard.length <= 1, `one sound at ${f}`);
    if (heard[0] && heard[0].item.id.startsWith("as")) {
      const source = heard[0].source * 30;
      assert.ok(source < 36 || source >= 45, `the cut word isn't heard at ${f}`);
    }
  }
});

test("a J/L cut survives 20 unrelated edits", () => {
  let p = edit(project(), [{ op: "trim_item", item: "bs", edge: "end", frames: -15, solo: true }]);
  const before = geo(p, "bs");
  assert.deepEqual(before, [120, 200, 135]);
  const unrelated: Array<ReadonlyArray<Op>> = [
    [{ op: "update_item", item: "title", set: { text: "Hello" } }],
    [{ op: "move_item", item: "title", start: 10 }],
    [{ op: "trim_item", item: "title", edge: "end", frames: 5 }],
    [{ op: "move_item", item: "song", start: 650 }],
    [{ op: "update_item", item: "song", set: { gainDb: -6 } }],
    [{ op: "trim_item", item: "song", edge: "end", frames: 20 }],
    [{ op: "move_item", item: "v", start: 520 }],
    [{ op: "update_item", item: "v", set: { name: "Wide" } }],
    [{ op: "trim_item", item: "v", edge: "end", frames: 10 }],
    [{ op: "split_item", item: "song", at: 40, newId: "song-2" }],
    [{ op: "delete_item", item: "song-2" }],
    [{ op: "update_item", item: "bs", set: { gainDb: -3 } }],
    [{ op: "update_item", item: "b", set: { name: "Talk" } }],
    [{ op: "update_item", item: "as", set: { fadeIn: 10 } }],
    [{ op: "move_item", item: "vs", start: 530 }],
    [{ op: "update_item", item: "title", set: { text: "Bye" } }],
    [{ op: "trim_item", item: "vs", edge: "start", frames: 5 }],
    [{ op: "update_item", item: "song", set: { fadeOut: 15 } }],
    [{ op: "move_item", item: "title", start: 20 }],
    [{ op: "update_item", item: "a", set: { name: "Intro" } }],
  ];
  assert.equal(unrelated.length, 20);
  for (const ops of unrelated) p = edit(p, ops);
  assert.deepEqual(geo(p, "bs"), before);
  assert.deepEqual(geo(p, "b"), [120, 200, 120]);
  assert.equal(linkDrift(p, "bs"), 0);
});

test("Link, Unlink, the drift and Move into sync", () => {
  const p = project();
  const off = edit(p, [{ op: "move_item", item: "vs", start: 412, solo: true }]);
  assert.deepEqual([linkDrift(off, "vs"), linkDrift(off, "v")], [12, -12]);
  // The item it's asked on moves (the sound, when asked on a main clip).
  const sync = planMoveIntoSync(off, "v");
  assert.ok(!("problem" in sync));
  const back = edit(off, sync.ops);
  assert.deepEqual(
    [geo(back, "v"), geo(back, "vs")],
    [
      [412, 500, 100],
      [412, 500, 100],
    ],
  );
  const drifted = edit(p, [
    { op: "trim_item", item: "as", edge: "end", frames: 10, solo: true },
    { op: "move_item", item: "as", start: 5, solo: true },
  ]);
  assert.equal(linkDrift(drifted, "a"), -5);
  const fromMain = planMoveIntoSync(drifted, "a");
  assert.ok(!("problem" in fromMain));
  assert.deepEqual(geo(edit(drifted, fromMain.ops), "as"), [0, 0, 110]);
  const unlink = planUnlink(p, ["vs"]);
  assert.ok(!("problem" in unlink));
  const free = edit(p, unlink.ops);
  assert.deepEqual([find(free, "v")!.link, find(free, "vs")!.link], [undefined, undefined]);
  const alone = edit(free, [{ op: "move_item", item: "v", start: 450 }]);
  assert.equal(geo(alone, "vs")![0], 400, "unlinked, the sound stays");
  const relink = planLink(alone, ["v", "vs"]);
  assert.ok(!("problem" in relink));
  const again = edit(alone, relink.ops);
  assert.equal(linkDrift(again, "vs"), -50);
  assert.ok("problem" in planLink(again, ["v", "vs"]), "already linked");
});

test("a locked sound stays where it is; a mate that can't follow refuses the edit with why", () => {
  const p = project();
  const locked = edit(p, [{ op: "update_item", item: "vs", set: { locked: true } }]);
  const moved = edit(locked, [{ op: "move_item", item: "v", start: 430 }]);
  assert.deepEqual(geo(moved, "vs"), [400, 500, 100]);
  const blocked = withLinks(p, [{ op: "move_item", item: "v", start: 600 }]);
  assert.ok(!("problem" in blocked), "nothing on A2 there");
  const inTheWay: Project = {
    ...p,
    tracks: p.tracks.map((t) =>
      t.id === "a2" ? { ...t, items: [...t.items, { id: "fx", type: "audio", media: "music", in: 0, start: 520, duration: 30 } as Item] } : t,
    ),
  };
  const refused = withLinks(inTheWay, [{ op: "move_item", item: "v", start: 450 }]);
  assert.ok("problem" in refused);
  assert.match(refused.problem, /linked item can't go along/);
  assert.ok(!("problem" in withLinks(inTheWay, [{ op: "move_item", item: "v", start: 450, solo: true }])), "⌥ moves the clip alone");
});

test("Detach audio links the clip and its sound; they then move and delete together", () => {
  const p = project();
  const free: Project = {
    ...p,
    tracks: p.tracks.map((t) => (t.id === "main" ? { ...t, items: [{ id: "c", type: "clip", media: "cam", in: 0, duration: 90 }] } : t)),
  };
  const det = planDetachAudio(free, "c", takenIds(free));
  assert.ok(!("problem" in det));
  const q = edit(free, det.ops);
  assert.ok(find(q, "c")!.link);
  assert.equal(find(q, "c")!.link, find(q, det.itemId)!.link);
  assert.equal(find(edit(q, [{ op: "delete_item", item: "c" }]), det.itemId), undefined);
});

/** D215's take on Main: the screen on Main, its microphone and camera linkedTo it; and a D123 detached sound. */
const legacy = (): Project => ({
  format: "uncut/0",
  name: "Old",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "screen", kind: "video", name: "screen.mov", path: "/screen.mov", probe: { ...probe, hasAudio: false } },
    { id: "camera", kind: "video", name: "camera.mov", path: "/camera.mov", probe },
    { id: "mic", kind: "audio", name: "mic.m4a", path: "/mic.m4a", probe: { frames: 900, fps: 30, hasAudio: true } },
    { id: "cam", kind: "video", name: "cam.mp4", path: "/cam.mp4", probe },
  ],
  tracks: [
    {
      id: "captions",
      kind: "text",
      name: "Captions",
      items: [
        {
          id: "caps",
          type: "captions",
          source: "mic",
          start: 0,
          duration: 300,
          coversMain: true,
          words: [
            { text: "One", start: 0.2, end: 0.6 },
            { text: "two", start: 1.0, end: 1.4 },
            { text: "three", start: 4.2, end: 4.8 },
          ],
        },
      ],
    },
    {
      id: "bubble",
      kind: "video",
      name: "Camera",
      items: [{ id: "cam-1", type: "clip", media: "camera", in: 12, start: 0, duration: 120, linkedTo: "scr-1" }],
    },
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "scr-1", type: "clip", media: "screen", in: 0, duration: 120 },
        { id: "talk", type: "clip", media: "cam", in: 30, duration: 150, mute: true },
      ],
    },
    { id: "voice", kind: "audio", name: "Voiceover", items: [{ id: "mic-1", type: "audio", media: "mic", in: 8, start: 0, duration: 120, linkedTo: "scr-1" }] },
    { id: "a1", kind: "audio", name: "Audio", items: [{ id: "talk-sound", type: "audio", media: "cam", in: 30, start: 120, duration: 150, linkedTo: "talk" }] },
  ],
});

test("old linkedTo projects read as links, and converting them changes nothing that plays", () => {
  const old = legacy();
  assert.deepEqual(validateProject(old, modules), []);
  const index = linkIndex(old.tracks);
  assert.equal(index.members.size, 2);
  assert.deepEqual(
    index.members
      .get(index.keyOf.get("scr-1")!)!
      .map((p) => p.item.id)
      .sort(),
    ["cam-1", "mic-1", "scr-1"],
  );
  // Edited before converting, a legacy link already acts by delta.
  const moved = edit(old, [{ op: "trim_item", item: "talk", edge: "end", frames: 30 }]);
  assert.deepEqual(geo(moved, "talk-sound"), [120, 30, 120]);

  const converted = applyEdit(createSession(old), { actor: "user", ops: legacyLinkOps(old) }).project;
  assert.deepEqual(validateProject(converted, modules), []);
  assert.ok(converted.tracks.every((t) => t.items.every((i) => i.linkedTo === undefined)));
  assert.deepEqual(legacyLinkOps(converted), []);
  const groups = [...linkIndex(converted.tracks).members.values()].map((m) => m.map((p) => p.item.id).sort());
  assert.deepEqual(groups.sort(), [
    ["cam-1", "mic-1", "scr-1"],
    ["talk", "talk-sound"],
  ]);
  // Bit for bit: what plays, what shows, the transcript's words on Main and the caption cards.
  const a = layout(old).starts;
  const b = layout(converted).starts;
  const plain = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v) => (k === "link" || k === "linkedTo" ? undefined : v)));
  for (let f = 0; f < 270; f++) {
    assert.deepEqual(plain(audibleAt(converted, b, f)), plain(audibleAt(old, a, f)), `sound at ${f}`);
    assert.deepEqual(plain(visualsAt(converted, b, f)), plain(visualsAt(old, a, f)), `picture at ${f}`);
  }
  const transcripts = new Map([["mic", { words: [{ text: "One", start: 0.2, end: 0.6 }], language: "en", seconds: 30 }]]);
  assert.deepEqual(plain(editWords(converted, transcripts as never)), plain(editWords(old, transcripts as never)));
  const caps = (p: Project) => captionCards(p, find(p, "caps")!);
  assert.deepEqual(plain(caps(converted)), plain(caps(old)));
  assert.ok(caps(old).length > 0);
});
