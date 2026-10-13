// Phase 3: @uncut/core guards against ops that would reach an object's prototype, and checks
// ops against the edit-ops schema before anything is applied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, EditError, esc, layout, textHtml, validateOps, visualsAt, type Item, type Project } from "../../packages/core/src/index.ts";

const project: Project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [{ id: "hello", type: "text", start: 0, duration: 60, text: "Hi", transform: { x: 0, y: 0 }, style: { size: 100 } }] },
    { id: "main", kind: "video", role: "main", name: "Main", items: [] },
  ],
};
// What a JSON client sends: "__proto__" arrives as an ordinary own key.
const fromJson = (value: unknown): any => JSON.parse(JSON.stringify(value).replace('"proto"', '"__proto__"'));

test("merge refuses __proto__, constructor and prototype instead of touching the prototype", () => {
  const cases = [
    fromJson({ op: "update_item", item: "hello", set: { duration: null, proto: { duration: 60 } } }),
    fromJson({ op: "update_project", set: { media: null, proto: { media: [] } } }),
    { op: "update_item", item: "hello", set: { constructor: { x: 1 } } },
    { op: "update_track", track: "text", set: { prototype: 1 } },
  ];
  for (const op of cases) {
    const session = createSession(project);
    assert.throws(() => applyEdit(session, { actor: "user", ops: [op] }), EditError, JSON.stringify(op));
    assert.equal(Object.getPrototypeOf(session.project.tracks[0].items[0]), Object.prototype);
    assert.equal(session.project.tracks[0].items[0].duration, 60);
  }
  assert.equal(({} as { duration?: unknown }).duration, undefined, "Object.prototype is untouched");
});

test("validateOps checks ops against the edit-ops schema and refuses renames and prototype keys", () => {
  assert.deepEqual(validateOps([{ op: "trim_item", item: "hello", edge: "end", frames: 10 }]), []);
  const codes = (ops: unknown) => validateOps(ops).map((e) => e.code);
  assert.deepEqual(codes([]), ["ops"]);
  assert.deepEqual(codes([{ op: "trim_item", item: "hello", edge: "end", frames: "10" }]), ["schema"]);
  assert.deepEqual(codes([{ op: "delete_item", item: "hello", extra: true }]), ["schema"]);
  assert.deepEqual(codes([{ op: "explode" }]), ["unknown-op"]);
  assert.deepEqual(codes([{ op: "update_item", item: "hello", set: { id: "other" } }]), ["rename"]);
  assert.ok(codes([fromJson({ op: "insert_item", track: "text", item: { id: "x", proto: {} } })]).includes("unsafe-key"));
  const [frames] = validateOps([{ op: "trim_item", item: "hello", edge: "end", frames: "10" }]);
  assert.equal(frames.path, "/0/frames");
});

// Timeline maths (D39: the preview, export and agent share it). 30 fps; a 20-frame crossfade
// into "b" is centred on the cut at frame 60: "a" runs on to 70, "b" starts showing at 50.
const timeline: Project = {
  format: "uncut/0",
  name: "T",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [],
  tracks: [
    {
      id: "text",
      kind: "text",
      name: "Text",
      items: [
        { id: "plain", type: "text", start: 10, duration: 30, text: "Plain", transform: { x: 0, y: 0 }, style: { size: 100 } },
        { id: "faded", type: "text", start: 90, duration: 20, text: "Fade", transform: { x: 0, y: 0 }, style: { size: 100 }, animation: { in: { module: "move.fade", duration: 10 } } },
      ],
    },
    { id: "hidden", kind: "video", name: "Hidden", hidden: true, items: [{ id: "ghost", type: "clip", media: "m", in: 0, start: 0, duration: 200 }] },
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "a", type: "clip", media: "m", in: 100, duration: 60 },
        { id: "b", type: "clip", media: "m", in: 50, duration: 60, transitionIn: { module: "transition.crossfade", duration: 20 } },
        { id: "c", type: "clip", media: "m", in: 0, duration: 60 },
      ],
    },
    { id: "audio", kind: "audio", name: "Audio", items: [{ id: "music", type: "audio", media: "m", in: 0, start: 0, duration: 180 }] },
  ],
};
const at = (f: number) => {
  const { starts } = layout(timeline);
  return visualsAt(timeline, starts, f).map((v) => [v.item.id, v.opacity, v.source] as const);
};
const ids = (f: number) => at(f).map(([id]) => id);

test("layout: main items back to back (a transition doesn't shift them), free items at their start", () => {
  const { starts, duration } = layout(timeline);
  assert.deepEqual(Object.fromEntries(starts), { plain: 10, faded: 90, ghost: 0, a: 0, b: 60, c: 120, music: 0 });
  assert.equal(duration, 200, "the longest track, hidden ones included");
  assert.deepEqual(layout({ tracks: [] }), { starts: new Map(), duration: 1 }, "an empty project is one frame long");
});

test("visualsAt: a crossfade is half before the cut and half after, the incoming clip fading in on top", () => {
  assert.deepEqual(at(49), [["a", 1, (100 + 49) / 30]], "before the window: only the outgoing clip");
  assert.deepEqual(at(50), [["a", 1, (100 + 50) / 30], ["b", 0, (50 - 10) / 30]], "window opens: b starts 10 frames before its in-point, invisible");
  assert.deepEqual(at(55), [["a", 1, (100 + 55) / 30], ["b", 0.25, (50 - 5) / 30]]);
  assert.deepEqual(at(60), [["a", 1, (100 + 60) / 30], ["b", 0.5, 50 / 30]], "on the cut: half way, b at its in-point, a past its out-point");
  assert.deepEqual(at(69), [["a", 1, (100 + 69) / 30], ["b", 0.95, (50 + 9) / 30]], "last frame of the window");
  assert.deepEqual(at(70), [["b", 1, (50 + 10) / 30]], "after the window: only the incoming clip");
  // A plain cut has no overlap.
  assert.deepEqual(ids(119), ["b"]);
  assert.deepEqual(ids(120), ["c"]);
  assert.deepEqual(ids(180), [], "past the main track's end nothing shows; hidden and audio tracks never do");
});

test("visualsAt: free-track items show from start to start + duration - 1, above the main track", () => {
  assert.deepEqual(ids(9), ["a"]);
  assert.deepEqual(at(10), [["a", 1, (100 + 10) / 30], ["plain", 1, 0]], "first frame; text has no source time");
  assert.deepEqual(ids(39), ["a", "plain"]);
  assert.deepEqual(ids(40), ["a"], "start + duration is already past it");
  // A move.fade in-animation ramps the text's opacity over its duration.
  const opacity = (f: number) => at(f).find(([id]) => id === "faded")?.[1];
  assert.deepEqual([opacity(89), opacity(90), opacity(95), opacity(100), opacity(109), opacity(110)], [undefined, 0, 0.5, 1, 1, undefined]);
});

test("esc and textHtml escape <>&\" in text and keep [[accent]] markup", () => {
  assert.equal(esc(`<a href="x">&amp;</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;amp;&lt;/a&gt;");
  assert.equal(esc(42), "42");
  const item: Item = { id: "t1", type: "text", start: 0, duration: 30, text: `Hi <b>"you" & [[me]]</b>`, transform: { x: 960, y: 270 }, style: { size: 108 } };
  const plain = textHtml(item, timeline);
  assert.match(plain, /^<div class="pv-text" data-item="t1" style="left:50%;top:25%;width:max-content;max-width:50%;font-size:10cqh;font-weight:600;/);
  assert.match(plain, /;opacity:1;text-shadow:0 2px 18px rgb\(0 0 0 \/ 45%\)">Hi &lt;b&gt;&quot;you&quot; &amp; <span class="accent">me<\/span>&lt;\/b&gt;<\/div>$/);
  const styled = textHtml({ ...item, style: { size: 108, weight: 800 } }, timeline, { opacity: 0.5, selected: true });
  assert.match(styled, /^<div class="pv-text sel-box" /);
  assert.match(styled, /font-weight:800;/);
  assert.match(styled, /;opacity:0\.5;text-shadow:[^"]*"/);
  assert.ok(!/<b>|"you"/.test(styled), "no raw markup or quotes from the text get through");
});

test("locked tracks and items refuse item edits from anyone; update_track still unlocks, hides and mutes (D52)", () => {
  const locked: Project = {
    ...project,
    tracks: [
      { ...project.tracks[0]!, locked: true },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "c", type: "text", duration: 10, locked: true }] as Array<Item> },
      { id: "free", kind: "text", name: "Free", items: [] },
    ],
  };
  const s = createSession(locked);
  const refused = (op: unknown, actor: "user" | "agent" = "user") =>
    assert.throws(() => applyEdit(s, { actor, ops: [op as never] }), (e: unknown) => e instanceof EditError && /locked/.test((e as Error).message), JSON.stringify(op));
  for (const actor of ["user", "agent"] as const) {
    refused({ op: "trim_item", item: "hello", edge: "end", frames: 10 }, actor);
    refused({ op: "move_item", item: "hello", start: 100 }, actor);
    refused({ op: "split_item", item: "hello", at: 10, newId: "hello-2" }, actor);
    refused({ op: "delete_item", item: "hello" }, actor);
    refused({ op: "update_item", item: "hello", set: { text: "x" } }, actor);
    refused({ op: "insert_item", track: "text", item: { id: "n", type: "text", start: 100, duration: 10 } }, actor);
    refused({ op: "delete_track", track: "text" }, actor);
    // An item that is locked itself (moves into a locked track: the next test).
    refused({ op: "delete_item", item: "c" }, actor);
  }
  // Unlocking (and hiding, muting) a locked track works, and then it edits normally.
  const unlocked = applyEdit(s, { actor: "user", ops: [{ op: "update_track", track: "text", set: { hidden: true } }, { op: "update_track", track: "text", set: { locked: null } }] });
  const moved = applyEdit(unlocked, { actor: "agent", ops: [{ op: "move_item", item: "hello", start: 100 }] });
  assert.equal(moved.project.tracks[0]!.items[0]!.start, 100);
  assert.equal(applyEdit(s, { actor: "user", ops: [{ op: "update_item", item: "c", set: { locked: null } }] }).project.tracks[1]!.items[0]!.locked, undefined);
});

test("split_item refuses a split at the item's first frame", () => {
  assert.throws(() => applyEdit(createSession(project), { actor: "user", ops: [{ op: "split_item", item: "hello", at: 0, newId: "h2" }] }), EditError);
});

test("lock bypasses are closed: move into a locked track, update_track items/id, delete_track with a locked item (D52)", () => {
  const p: Project = {
    ...project,
    tracks: [
      project.tracks[0]!,
      { id: "main", kind: "video", role: "main", name: "Main", items: [] },
      { id: "vault", kind: "text", name: "Vault", locked: true, items: [] },
      { id: "keep", kind: "text", name: "Keep", items: [{ id: "k", type: "text", start: 0, duration: 10, locked: true }] as Array<Item> },
    ],
  };
  const s = createSession(p);
  const refused = (op: unknown, pattern: RegExp) => assert.throws(() => applyEdit(s, { actor: "agent", ops: [op as never] }), (e: unknown) => e instanceof EditError && pattern.test((e as Error).message), JSON.stringify(op));
  refused({ op: "move_item", item: "hello", track: "vault", start: 100 }, /locked/);
  refused({ op: "update_track", track: "vault", set: { items: [] } }, /items/);
  refused({ op: "update_track", track: "keep", set: { items: [] } }, /items/);
  refused({ op: "update_track", track: "text", set: { id: "other" } }, /id/);
  refused({ op: "update_track", track: "vault", set: { kind: "audio" } }, /locked/);
  refused({ op: "delete_track", track: "keep" }, /locked/);
});

test("trim and split: images keep in 0 and extend left; speed scales the source; split hands animations, fades and keys to their half", () => {
  const p: Project = {
    ...project,
    media: [
      { id: "img", kind: "image", name: "a.png", path: "/a.png" },
      { id: "v", kind: "video", name: "v.mp4", path: "/v.mp4", probe: { frames: 300 } },
    ],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [{ id: "t", type: "text", start: 0, duration: 60, animation: { in: { module: "move.fade", duration: 40 }, out: { module: "move.fade", duration: 40 } }, fadeIn: 5 }] as Array<Item> },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "i", type: "clip", media: "img", in: 0, duration: 30 }, { id: "f", type: "clip", media: "v", in: 10, duration: 40, speed: 2 }] as Array<Item> },
    ],
  };
  let s = applyEdit(createSession(p), { actor: "user", ops: [{ op: "trim_item", item: "i", edge: "start", frames: -20 }] });
  assert.deepEqual([s.project.tracks[1]!.items[0]!.in, s.project.tracks[1]!.items[0]!.duration], [0, 50]);
  s = applyEdit(createSession(p), { actor: "user", ops: [{ op: "trim_item", item: "f", edge: "start", frames: 5 }, { op: "split_item", item: "f", at: 10, newId: "f2" }] });
  assert.deepEqual(s.project.tracks[1]!.items.map((i) => i.in), [0, 20, 40]);
  s = applyEdit(createSession(p), { actor: "user", ops: [{ op: "split_item", item: "t", at: 20, newId: "t2" }] });
  const [a, b] = s.project.tracks[0]!.items;
  assert.deepEqual(a!.animation, { in: { module: "move.fade", duration: 20 } }, "clamped to the half");
  assert.deepEqual(b!.animation, { out: { module: "move.fade", duration: 40 } });
  assert.deepEqual([a!.fadeIn, b!.fadeIn], [5, undefined]);
});
