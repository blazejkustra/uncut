// The slip view without the app (apps/web/src/timeline/slip/slipView.ts): what a double click
// opens, the window on the media (speed, the Slip tool's limits, a loop), a press that grabs or
// jumps, the strip's opening zoom and keeping the window in view, and the session's own ⌘Z.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Project } from "../../packages/core/src/index.ts";
import { planSlipBy } from "../../apps/web/src/timeline/edit/slipRoll.ts";
import {
  centredScroll,
  getSlip,
  keepInView,
  minVisible,
  nudged,
  offsetFor,
  openVisible,
  pressOn,
  slip,
  slipOpen,
  slipSubject,
  windowStart,
  type SlipSubject,
} from "../../apps/web/src/timeline/slip/slipView.ts";

const probe = { frames: 300, fps: 30, width: 1280, height: 720, hasAudio: true };
const base: Project = {
  format: "uncut/0",
  name: "Cut",
  canvas: { width: 1920, height: 1080, fps: 30 },
  media: [
    { id: "m-a", kind: "video", name: "a.mp4", path: "/x/a.mp4", probe },
    { id: "m-long", kind: "video", name: "long.mp4", path: "/x/long.mp4", probe: { ...probe, frames: 40 * 60 * 30 } },
    { id: "m-still", kind: "image", name: "s.png", path: "/x/s.png" },
    { id: "m-song", kind: "audio", name: "song.m4a", path: "/x/song.m4a", probe: { frames: 600 } },
  ],
  tracks: [
    {
      id: "main",
      kind: "video",
      role: "main",
      name: "Main",
      items: [
        { id: "c1", type: "clip", media: "m-a", in: 50, duration: 100 },
        { id: "c2", type: "clip", media: "m-long", in: 1000, duration: 90 },
        { id: "c3", type: "clip", media: "m-still", duration: 50 },
      ],
    },
    { id: "music", kind: "audio", name: "Music", items: [{ id: "a1", type: "audio", media: "m-song", in: 100, start: 0, duration: 200 }] },
  ],
};
const with_ = (id: string, set: object): Project => ({
  ...base,
  tracks: base.tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.id === id ? { ...i, ...set } : i)) })),
});
const subject = (project: Project, id: string, online = true) => slipSubject(project, id, online) as SlipSubject;

test("a double click opens it on clips and sounds with media time; a still keeps double click to rename", () => {
  const c1 = subject(base, "c1");
  assert.deepEqual([c1.total, c1.from, c1.span, c1.lo, c1.hi, c1.readOnly], [300, 50, 100, -50, 150, undefined]);
  const a1 = subject(base, "a1");
  assert.deepEqual([a1.media.kind, a1.lo, a1.hi], ["audio", -100, 300]);
  assert.equal(slipSubject(base, "c3", true), undefined);
  assert.equal(slipSubject(base, "nope", true), undefined);
  assert.equal(slipSubject(with_("c1", { media: "m-unknown" }), "c1", true), undefined);
});

test("it opens read only, saying why, where the Slip tool would refuse", () => {
  assert.match(subject(base, "c1", false).readOnly!, /connected/);
  assert.match(subject(with_("c1", { locked: true }), "c1").readOnly!, /locked/);
  const all = subject(with_("c1", { in: 0, duration: 300 }), "c1");
  assert.match(all.readOnly!, /already shows all its media/);
  assert.deepEqual([all.lo, all.hi], [0, 0]);
});

test("the window is the media the item plays: twice as long at 2×, moved two media frames per frame of slip", () => {
  const fast = subject(with_("c1", { speed: 2, duration: 50 }), "c1");
  assert.equal(fast.span, 100);
  assert.equal(windowStart(fast, 10), 70);
  assert.equal(offsetFor(fast, 70), 10);
  assert.equal(offsetFor(fast, -999), fast.lo);
  assert.equal(offsetFor(fast, 999), fast.hi);
});

test("a looping clip has no end to run out of, but its window starts inside the media", () => {
  const loop = subject(with_("c1", { loop: true }), "c1");
  assert.equal(loop.hi, 249);
  assert.equal(windowStart(loop, loop.hi), 299);
});

test("a press inside the window grabs it; outside, the window jumps there, centred, within the media", () => {
  const c1 = subject(base, "c1");
  assert.deepEqual(pressOn(c1, 0, 80), { offset: 0, grab: 30 });
  assert.deepEqual(pressOn(c1, 0, 220), { offset: 120, grab: 50 });
  assert.deepEqual(pressOn(c1, 0, 280), { offset: 150, grab: 80 });
  assert.deepEqual(pressOn(c1, 0, 10), { offset: -50, grab: 10 });
});

test("← / → move a frame, never past the limits", () => {
  const c1 = subject(base, "c1");
  assert.equal(nudged(c1, 0, 1), 1);
  assert.equal(nudged(c1, -50, -1), -50);
  assert.equal(nudged(c1, 150, 1), 150);
});

test("the strip opens at 20× the window (the whole media when that's shorter), centred on it", () => {
  const long = subject(base, "c2");
  assert.equal(openVisible(long, 900), 1800);
  assert.equal(openVisible(subject(base, "c1"), 900), 300);
  assert.equal(minVisible(subject(base, "c1"), 900), 125);
  // 1800 frames over 900 px: 0.5 px a frame; the window (1000..1090) centred.
  assert.equal(centredScroll(long, 1000, 1800, 900), 1045 * 0.5 - 450);
  assert.equal(centredScroll(subject(base, "c1"), 50, 300, 900), 0);
});

test("the window keeps itself in view as it moves", () => {
  assert.equal(keepInView(0, 1000, 1100, 900), 224);
  assert.equal(keepInView(500, 100, 200, 900), 76);
  assert.equal(keepInView(100, 300, 400, 900), 100);
  assert.equal(keepInView(0, 1000, 2000, 900), 976);
});

test("the session: each move, and each drag however long, is one step of ⌘Z; a new move drops the redo", () => {
  slip.open("c1", { baseRevision: 7, dir: "/p" });
  assert.ok(slipOpen());
  assert.deepEqual([getSlip().baseRevision, getSlip().dir], [7, "/p"]);
  slip.move(5);
  slip.move(8);
  slip.undo();
  assert.equal(getSlip().offset, 5);
  slip.undo();
  assert.equal(getSlip().offset, 0);
  slip.undo();
  assert.equal(getSlip().offset, 0);
  slip.redo();
  assert.equal(getSlip().offset, 5);
  slip.move(3);
  slip.redo();
  assert.equal(getSlip().offset, 3);
  slip.begin();
  slip.move(4);
  slip.move(6);
  slip.move(9);
  slip.end();
  assert.deepEqual(getSlip().past, [0, 5, 3]);
  slip.undo();
  assert.equal(getSlip().offset, 3);
  // A press that moved nothing (a click on the window) isn't a step.
  slip.begin();
  slip.end();
  assert.deepEqual(getSlip().past, [0, 5]);
  slip.close();
  assert.ok(!slipOpen());
  assert.deepEqual([getSlip().offset, getSlip().past], [0, []]);
});

test("Done sends one slip_item for the whole session, clamped like the Slip tool's", () => {
  assert.deepEqual((planSlipBy(base, "c1", 30) as { ops: unknown }).ops, [{ op: "slip_item", item: "c1", frames: 30 }]);
  assert.deepEqual((planSlipBy(base, "c1", 500) as { ops: unknown }).ops, [{ op: "slip_item", item: "c1", frames: 150 }]);
  assert.deepEqual((planSlipBy(base, "c1", 0) as { ops: unknown }).ops, []);
  assert.ok("problem" in planSlipBy(with_("c1", { locked: true }), "c1", 5));
});
