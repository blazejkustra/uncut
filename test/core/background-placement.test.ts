// Issue #43 (D220): a background goes wherever the user wants it. With nothing selected it still covers
// the whole edit under Main (D146); behind a selected item it covers that item's time on a track
// right under it; once placed it moves, trims and changes layer like any other item.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, layout, loadModules, validateProject, visualsAt, type Item, type Op, type Project } from "../../packages/core/src/index.ts";
import { canGoBehind, planAddBackground } from "../../apps/web/src/preview/text.ts";
import { planLayer, planMove, planTrim } from "../../apps/web/src/timeline/edit.ts";

const modules = await loadModules("spec/modules/builtin");
const title: Item = { id: "title-1", type: "text", start: 30, duration: 60, text: "Title", style: { preset: "text.title" } };
const project: Project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "m", kind: "video", name: "a.mp4", path: "/a.mp4", probe: { frames: 600, fps: 30, width: 320, height: 180, hasAudio: false } },
    { id: "song", kind: "audio", name: "s.mp3", path: "/s.mp3", probe: { frames: 600, fps: 30, hasAudio: true } },
  ],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [title] },
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "clip-1", type: "clip", media: "m", in: 0, duration: 150 },
        { id: "clip-2", type: "clip", media: "m", in: 150, duration: 150 },
      ],
    },
    { id: "audio", kind: "audio", name: "Audio", items: [{ id: "song-1", type: "audio", media: "song", in: 0, start: 0, duration: 300 }] },
  ],
};

function apply(p: Project, plan: { ops: ReadonlyArray<unknown> } | { problem: string }) {
  assert.ok("ops" in plan, `planned: ${"problem" in plan ? plan.problem : ""}`);
  const next = applyEdit(createSession(p), { actor: "user", ops: plan.ops as ReadonlyArray<Op> }).project;
  assert.deepEqual(validateProject(next, modules), []);
  return next;
}
const placed = (p: Project, id: string) => {
  const track = p.tracks.find((t) => t.items.some((i) => i.id === id))!;
  const item = track.items.find((i) => i.id === id)!;
  return { track: track.id, start: item.start, duration: item.duration };
};
const order = (p: Project, frame: number) => visualsAt(p, layout(p).starts, frame).map((v) => v.item.id);

test("nothing selected (or Whole edit): the whole edit on a track under Main, as before", () => {
  const p = apply(project, planAddBackground(project, { color: "#000000" }, 60, undefined));
  assert.deepEqual(
    p.tracks.map((t) => [t.id, t.name]),
    [
      ["text", "Text"],
      ["main", "Main"],
      ["background-track-1", "Background"],
      ["audio", "Audio"],
    ],
  );
  assert.deepEqual(placed(p, "background-1"), { track: "background-track-1", start: 0, duration: 300 });
  assert.deepEqual(order(p, 60), ["background-1", "clip-1", "title-1"]);
});

test("behind a selected title over footage: its time, on a new track right under its track, over the footage", () => {
  assert.equal(canGoBehind(project, "title-1"), true);
  const plan = planAddBackground(project, { color: "#0B1D3A" }, 200, "title-1");
  assert.ok("ops" in plan);
  assert.equal(plan.summary, "Add a background behind title-1");
  const p = apply(project, plan);
  assert.deepEqual(
    p.tracks.map((t) => t.id),
    ["text", "background-track-1", "main", "audio"],
  );
  assert.deepEqual(placed(p, "background-1"), { track: "background-track-1", start: 30, duration: 60 });
  assert.deepEqual(order(p, 60), ["clip-1", "background-1", "title-1"], "over the footage, under the title");
  assert.deepEqual(order(p, 120), ["clip-1"], "only for the title's time");
  // A second title on the same track at another time: that free track right under it is reused.
  const more: Project = { ...p, tracks: p.tracks.map((t) => (t.id === "text" ? { ...t, items: [...t.items, { ...title, id: "title-2", start: 200 }] } : t)) };
  const q = apply(more, planAddBackground(more, { color: "bg" }, 0, "title-2"));
  assert.deepEqual(placed(q, "background-2"), { track: "background-track-1", start: 200, duration: 60 });
  // Behind the same title again: that time is taken there, so another new track right under the text track.
  const r = apply(p, planAddBackground(p, { color: "bg" }, 0, "title-1"));
  assert.deepEqual(
    r.tracks.map((t) => [t.id, t.name]),
    [
      ["text", "Text"],
      ["background-track-2", "Background 2"],
      ["background-track-1", "Background"],
      ["main", "Main"],
      ["audio", "Audio"],
    ],
  );
});

test("behind a selected main clip: that clip's time, under Main; a sound or captions can't be gone behind", () => {
  const p = apply(project, planAddBackground(project, { color: "#000000" }, 0, "clip-2"));
  assert.deepEqual(placed(p, "background-1"), { track: "background-track-1", start: 150, duration: 150 });
  assert.equal(
    p.tracks.findIndex((t) => t.id === "background-track-1"),
    2,
    "right under Main",
  );
  assert.deepEqual(order(p, 160), ["background-1", "clip-2"]);
  // A sound selected: the whole-edit default.
  assert.equal(canGoBehind(project, "song-1"), false);
  const s = apply(project, planAddBackground(project, { color: "#000000" }, 60, "song-1"));
  assert.deepEqual(placed(s, "background-1"), { track: "background-track-1", start: 0, duration: 300 });
});

test("a placed background drags to any track, trims and changes layer like any item", () => {
  let p = apply(project, planAddBackground(project, { color: "#000000" }, 60, undefined));
  // Add an empty video track above the text and drag the background onto it, at 1 s.
  p = { ...p, tracks: [{ id: "over", kind: "video", name: "Overlay", items: [] }, ...p.tracks] };
  p = apply(p, planMove(p, "background-1", "over", 30));
  assert.deepEqual(placed(p, "background-1"), { track: "over", start: 30, duration: 300 });
  assert.deepEqual(order(p, 60), ["clip-1", "title-1", "background-1"], "on top now: it covers everything");
  // Trim both ends.
  p = apply(p, planTrim(p, "background-1", "end", -200));
  p = apply(p, planTrim(p, "background-1", "start", 30));
  assert.deepEqual(placed(p, "background-1"), { track: "over", start: 60, duration: 70 });
  // Send backward: under the title track's level, as for any item.
  const back = planLayer(p, "background-1", 1);
  assert.ok(!("problem" in back), "problem" in back ? back.problem : "");
  p = apply(p, back);
  assert.deepEqual(order(p, 80), ["clip-1", "background-1", "title-1"]);
  // Back onto Main: a card in the sequence.
  p = apply(p, planMove(p, "background-1", "main", 300));
  assert.deepEqual(
    p.tracks.find((t) => t.id === "main")!.items.map((i) => i.id),
    ["clip-1", "clip-2", "background-1"],
  );
});

test("old projects are unchanged: a saved background under Main stays where it is", () => {
  const old: Project = {
    ...project,
    tracks: [
      project.tracks[0]!,
      project.tracks[1]!,
      {
        id: "bgt",
        kind: "video",
        name: "Background",
        items: [{ id: "background-1", type: "component", component: "component.solid", start: 0, duration: 300, props: { color: "bg" } }],
      },
      project.tracks[2]!,
    ],
  };
  assert.deepEqual(validateProject(old, modules), []);
  assert.deepEqual(order(old, 10), ["background-1", "clip-1"]);
});
