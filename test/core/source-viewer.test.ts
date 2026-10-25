// D311 without the app: the source viewer's state (apps/web/src/preview/source/source.ts). Space over
// a media tile opens it and plays it (again: pause), Space elsewhere stays the timeline's, the
// timeline playing or Esc goes back to it, I/O mark the file, and In to Out goes on the timeline
// (planAddMedia, planDropMedia) as a valid edit.
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyEdit, createSession, loadModules, validateProject, type Op, type Project } from "../../packages/core/src/index.ts";

Object.assign(globalThis, { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });
const { playback, getPlayback } = await import("../../apps/web/src/preview/playback.ts");
const { getSource, markedRange, source, sourceKey } = await import("../../apps/web/src/preview/source/source.ts");
const { planAddMedia, planDropMedia } = await import("../../apps/web/src/state/project.ts");

const FPS = 30;
const modules = await loadModules("spec/modules/builtin");
const project: Project = {
  format: "uncut/0",
  name: "S",
  canvas: { width: 1920, height: 1080, fps: FPS },
  media: [
    { id: "m-cam", kind: "video", name: "cam.mp4", path: "/cam.mp4", probe: { frames: 300, fps: FPS, hasAudio: true } },
    { id: "m-song", kind: "audio", name: "song.m4a", path: "/song.m4a", probe: { frames: 600, hasAudio: true } },
  ],
  tracks: [
    { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-cam", in: 0, duration: 90 }] },
    { id: "audio", kind: "audio", name: "Audio", items: [] },
  ],
};

function reset() {
  source.close();
  source.hoverTile(undefined);
  source.pointerOver(false);
  playback.reset();
  playback.setProject(301, FPS, 300);
}

function apply(plan: { ops: ReadonlyArray<unknown> } | { problem: string }) {
  assert.ok("ops" in plan, `planned: ${"problem" in plan ? plan.problem : ""}`);
  const next = applyEdit(createSession(project), { actor: "user", ops: plan.ops as ReadonlyArray<Op> }).project;
  assert.deepEqual(validateProject(next, modules), []);
  return next;
}
const itemOf = (p: Project, id: string) => p.tracks.flatMap((t) => t.items).find((i) => i.id === id)!;

test("Space over a media tile opens it in the viewer and plays it; Space over it again pauses and plays", () => {
  reset();
  source.hoverTile("m-cam");
  assert.equal(sourceKey("play", FPS), true);
  assert.equal(getSource().media, "m-cam");
  assert.equal(getSource().playing, true);
  assert.equal(getPlayback().playing, false, "the timeline doesn't play");
  assert.equal(sourceKey("play", FPS), true);
  assert.equal(getSource().playing, false);
  assert.equal(sourceKey("play", FPS), true);
  assert.equal(getSource().playing, true);
  source.hoverTile("m-song");
  sourceKey("play", FPS);
  assert.equal(getSource().media, "m-song", "another tile opens in its place");
  assert.equal(getSource().playing, true);
});

test("Space anywhere else is the timeline's: it plays the timeline, which shows it again", () => {
  reset();
  assert.equal(sourceKey("play", FPS), false, "nothing open, no tile under the pointer");
  source.open("m-cam");
  assert.equal(sourceKey("play", FPS), false, "open, but the pointer is over neither a tile nor the viewer");
  playback.toggle();
  assert.equal(getPlayback().playing, true);
  assert.equal(getSource().media, undefined, "the timeline playing closes the viewer");
  source.hoverTile("m-cam");
  sourceKey("play", FPS);
  assert.equal(getPlayback().playing, false, "opening a tile pauses the timeline");
  assert.equal(getSource().playing, true);
});

test("over the open viewer, Space plays and pauses it; Esc goes back to the timeline", () => {
  reset();
  source.open("m-cam");
  source.pointerOver(true);
  assert.equal(sourceKey("play", FPS), true);
  assert.equal(getSource().playing, true);
  assert.equal(sourceKey("pause", FPS), true);
  assert.equal(getSource().playing, false);
  assert.equal(sourceKey("deselect", FPS), true);
  assert.equal(getSource().media, undefined);
  assert.equal(sourceKey("deselect", FPS), false, "with nothing open Esc deselects as before");
  assert.equal(sourceKey("markIn", FPS), false, "and I marks the timeline");
});

test("I and O mark the file at the viewer's time; an In after the Out drops the Out", () => {
  reset();
  source.open("m-cam");
  source.setDuration(10);
  source.seek(2);
  assert.equal(sourceKey("markIn", FPS), true);
  source.seek(5);
  sourceKey("markOut", FPS);
  assert.deepEqual([getSource().markIn, getSource().markOut], [2, 5]);
  assert.equal(getPlayback().markIn, undefined, "the timeline's marks stay");
  assert.deepEqual(markedRange(getSource(), FPS, 300), { in: 60, duration: 90 });
  source.seek(7);
  sourceKey("markIn", FPS);
  assert.deepEqual([getSource().markIn, getSource().markOut], [7, undefined]);
  assert.deepEqual(markedRange(getSource(), FPS, 300), { in: 210, duration: 90 }, "In to the end");
  source.seek(99);
  assert.equal(getSource().time, 10, "seeks stay inside the file");
  sourceKey("frameBack", FPS);
  assert.ok(Math.abs(getSource().time - (10 - 1 / FPS)) < 1e-9);
  source.clearMarks();
  assert.equal(markedRange(getSource(), FPS, 300), undefined, "no marks: the whole file");
  source.open("m-song");
  assert.deepEqual([getSource().markIn, getSource().time], [undefined, 0], "another media starts fresh");
});

test("In to Out on the timeline: Add puts that stretch at the end of main, a drop where it lands", () => {
  const added = planAddMedia(project, "m-cam", 0, { in: 60, duration: 90 });
  assert.ok("itemId" in added);
  const p = apply(added);
  assert.deepEqual([itemOf(p, added.itemId).in, itemOf(p, added.itemId).duration], [60, 90]);
  const dropped = planDropMedia(project, "m-song", { frame: 30, track: "audio", range: { in: 120, duration: 45 } });
  assert.ok("itemId" in dropped);
  const q = apply(dropped);
  assert.deepEqual([itemOf(q, dropped.itemId).in, itemOf(q, dropped.itemId).duration, itemOf(q, dropped.itemId).start], [120, 45, 30]);
  const whole = planDropMedia(project, "m-song", { frame: 0, track: "audio" });
  assert.ok("itemId" in whole);
  assert.equal(itemOf(apply(whole), whole.itemId).duration, 600, "without a range, the whole file as before");
});
