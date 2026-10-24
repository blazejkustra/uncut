// Feedback round 1 (D115–D121), without the app: the shortcuts' planners (edit points, deleting
// several items, paste and duplicate), the playback clock's J/K/L rates, the canvas settings'
// edit, the remembered rail order and panel sizes, and the preview's zoom-around-the-pointer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit, createSession, loadModules, validateProject, type Project } from "../../packages/core/src/index.ts";
import { copyItems, editPoints, nextEditPoint, planDeleteMany, planPaste } from "../../apps/web/src/timeline/clipboard.ts";
import { planCanvas, aspectOf, canvasSide } from "../../apps/web/src/settings/canvas.ts";
import { clampSize, layoutStyle, railOrder } from "../../apps/web/src/editor/layout.ts";
import { clampPan, zoomAround } from "../../apps/web/src/preview/viewport.ts";

const modules = await loadModules("spec/modules/builtin");
const project: Project = {
  format: "uncut/0",
  name: "P",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [{ id: "m", kind: "video", name: "a.mp4", path: "/a.mp4", probe: { frames: 300, fps: 30, width: 320, height: 180, hasAudio: false } }],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [{ id: "title-1", type: "text", start: 10, duration: 30, text: "Title" }] },
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "a", type: "clip", media: "m", in: 0, duration: 90 },
        { id: "b", type: "clip", media: "m", in: 100, duration: 60, transitionIn: { module: "transition.crossfade", duration: 10 } },
        { id: "c", type: "clip", media: "m", in: 20, duration: 30, transitionIn: { module: "transition.crossfade", duration: 10 } },
      ],
    },
    { id: "audio", kind: "audio", name: "Audio", items: [] },
  ],
};

const apply = (ops: ReadonlyArray<unknown>) => {
  const next = applyEdit(createSession(project), { actor: "user", ops: ops as never }).project;
  assert.deepEqual(validateProject(next, modules), []);
  return next;
};

test("↑/↓ jump between the edit points: every start and end, 0 included", () => {
  assert.deepEqual(editPoints(project), [0, 10, 40, 90, 150, 180]);
  assert.equal(nextEditPoint(project, 0, 1), 10);
  assert.equal(nextEditPoint(project, 45, 1), 90);
  assert.equal(nextEditPoint(project, 90, -1), 40);
  assert.equal(nextEditPoint(project, 180, 1), undefined);
  assert.equal(nextEditPoint(project, 0, -1), undefined);
});

test("⌫ on several items deletes them in one edit; a transition into a clip that now follows another goes", () => {
  const plan = planDeleteMany(project, ["a", "title-1"]);
  assert.ok("ops" in plan);
  assert.equal(plan.summary, "Delete 2 items");
  const next = apply(plan.ops);
  const main = next.tracks.find((t) => t.id === "main")!;
  assert.deepEqual(
    main.items.map((i) => i.id),
    ["b", "c"],
  );
  assert.equal(main.items[0]!.transitionIn, undefined, "b is first now: no transition into it");
  assert.ok(main.items[1]!.transitionIn, "c still follows b");
  assert.equal(next.tracks.find((t) => t.id === "text")!.items.length, 0);
  const locked = { ...project, tracks: project.tracks.map((t) => (t.id === "text" ? { ...t, locked: true } : t)) };
  assert.ok("problem" in planDeleteMany(locked, ["a", "title-1"]));
});

test("⌘C ⌘V: a free item pastes at the playhead on its own track, else a free one, else a new track", () => {
  const clip = copyItems(project, ["title-1"]);
  assert.equal(clip.length, 1);
  // At 100 the text track is free: same track.
  const p1 = planPaste(project, clip, 100);
  assert.ok("ops" in p1);
  const n1 = apply(p1.ops);
  const pasted = n1.tracks.find((t) => t.id === "text")!.items.find((i) => i.id === p1.ids[0])!;
  assert.equal(pasted.start, 100);
  assert.equal(pasted.text, "Title");
  // At 20 it overlaps the original: a new text track on top.
  const p2 = planPaste(project, clip, 20);
  assert.ok("ops" in p2);
  const n2 = apply(p2.ops);
  assert.equal(n2.tracks[0]!.kind, "text");
  assert.notEqual(n2.tracks[0]!.id, "text");
  assert.equal(n2.tracks[0]!.items[0]!.start, 20);
});

test("⌘V of a main clip inserts it on main after the clip under the playhead, without its transition; ⌘D's paste after it", () => {
  const clip = copyItems(project, ["b"]);
  const plan = planPaste(project, clip, 100);
  assert.ok("ops" in plan);
  const next = apply(plan.ops);
  const main = next.tracks.find((t) => t.id === "main")!;
  assert.deepEqual(
    main.items.map((i) => i.id),
    ["a", "b", plan.ids[0], "c"],
  );
  assert.equal(main.items[2]!.transitionIn, undefined);
  assert.equal(main.items[2]!.in, 100);
  // Several items keep their relative timing.
  const both = copyItems(project, ["title-1", "a"]);
  assert.deepEqual(
    both.map((c) => c.offset),
    [0, 10],
  );
  assert.ok("problem" in planPaste(project, [], 0));
});

test("J/K/L: the clock runs at the shuttle rate, backwards too, and stops at 0", async () => {
  let now = 0;
  const frames: Array<FrameRequestCallback> = [];
  Object.assign(globalThis, { requestAnimationFrame: (cb: FrameRequestCallback) => frames.push(cb), cancelAnimationFrame: () => {} });
  const realNow = performance.now.bind(performance);
  performance.now = () => now;
  try {
    const { playback, getPlayback } = await import("../../apps/web/src/preview/playback.ts");
    const runFrame = (t: number) => {
      now = t;
      const cb = frames.shift();
      cb?.(t);
    };
    playback.setProject(301, 30, 300);
    playback.seek(150);
    playback.shuttle(1);
    assert.equal(getPlayback().rate, 1);
    playback.shuttle(1);
    assert.equal(getPlayback().rate, 2);
    runFrame(1000);
    assert.equal(Math.round(getPlayback().frame), 210, "two seconds of frames in one second");
    playback.shuttle(-1);
    assert.equal(getPlayback().rate, -1);
    playback.shuttle(-1);
    assert.equal(getPlayback().rate, -2);
    runFrame(5000);
    assert.equal(getPlayback().frame, 0);
    assert.equal(getPlayback().playing, false);
    assert.equal(getPlayback().rate, 1);
    playback.setMark("in", 30);
    playback.setMark("out", 60);
    assert.deepEqual([getPlayback().markIn, getPlayback().markOut], [30, 60]);
    playback.selectMany(["a", "b"]);
    assert.deepEqual([getPlayback().selected, getPlayback().also], ["a", ["b"]]);
    playback.select("c");
    assert.deepEqual(getPlayback().also, []);
  } finally {
    performance.now = realNow;
  }
});

test("Settings › Project: aspect presets and canvas edits; the frame rate only while the timeline is empty", () => {
  assert.equal(aspectOf({ width: 1080, height: 1350 }), "4:5");
  assert.equal(aspectOf({ width: 1000, height: 1001 }), undefined);
  assert.equal(canvasSide(1081), 1082);
  assert.equal(canvasSide(1), 16);
  const vertical = planCanvas(project, { width: 1080, height: 1920 });
  assert.ok("ops" in vertical);
  assert.equal(vertical.summary, "Changed canvas to 1080×1920");
  const next = apply(vertical.ops);
  assert.deepEqual(next.canvas, { width: 1080, height: 1920, fps: 30 });
  const bg = planCanvas(project, { background: "#112233" });
  assert.ok("ops" in bg);
  assert.equal(apply(bg.ops).canvas.background, "#112233");
  assert.ok("problem" in planCanvas(project, { fps: 60 }));
  const empty = { ...project, tracks: project.tracks.map((t) => ({ ...t, items: [] })) };
  const fps = planCanvas(empty, { fps: 60 });
  assert.ok("ops" in fps && fps.ops.length === 1);
  assert.deepEqual(planCanvas(project, { width: 1920 }), { ops: [], summary: "" });
});

test("the rail's saved order and the panel sizes are read defensively", () => {
  const ids = ["media", "text", "audio"] as const;
  assert.deepEqual(railOrder(["audio", "bogus", "audio", "media"], ids), ["audio", "media", "text"]);
  assert.deepEqual(railOrder("nonsense", ids), ["media", "text", "audio"]);
  assert.equal(clampSize("lib", 20), 180);
  assert.equal(clampSize("bottom", 5000), 900);
  assert.deepEqual(layoutStyle({ side: 300 }), { "--side-col": "clamp(240px, 300px, 40vw)" });
});

test("preview zoom keeps the point under the pointer in place; pan keeps some picture in view", () => {
  // The canvas point 100 px right of the centre stays under a pointer there from 1× to 2×.
  const pan = zoomAround({ x: 0, y: 0 }, 1, 2, 100, 0);
  assert.deepEqual(pan, { x: -100, y: 0 });
  assert.equal(pan.x + 50 * 2, 0, "the point 50 canvas px right of centre is under the pointer at 2×");
  assert.deepEqual(clampPan({ x: 5000, y: -5000 }, { w: 400, h: 300 }, { w: 800, h: 600 }), { x: 552, y: -402 });
});
