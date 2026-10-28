// Handoff 13 and 16: the check for text shaking by a pixel and for a 1 px line along the frame's
// edge, on synthetic grey frames: a striped block (text-like detail) placed at a whole-pixel y per
// frame. A move 1 px up and straight back is a shake (argent-100s "Claude Code" at f 831 to 834);
// a steady move, a settle that stays, a slow float and a fade are not. A full-screen layer one pixel
// short of the left edge (argent-family) is a sliver; footage reaching the edge is not. And
// review_submit's run plan: a few windows, after the scene changes, inside the edit.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findShakes,
  findSlivers,
  finePlan,
  FINE_RUN,
  FINE_WINDOWS,
  hasSliver,
  jitterFindings,
  tileShift,
  type GrayFrame,
} from "../../apps/server/src/agent/motionJitter.ts";

const W = 192;
const H = 100;

/** A frame with a striped block at x 20..170 whose top is at `y` (and `level` brightness for the stripes). */
function frame(n: number, y: number, level = 230): GrayFrame {
  const gray = new Uint8Array(W * H).fill(30);
  for (let row = 0; row < 30; row++) for (let x = 20; x < 170; x++) gray[(y + row) * W + x] = row % 4 < 2 ? level : 30;
  return { frame: n, gray };
}
const run = (ys: ReadonlyArray<number>, from = 100) => ys.map((y, i) => frame(from + i, y));

test("a tile's shift: still, 1 px up or down, and undefined for a change that isn't a move", () => {
  const a = frame(0, 20).gray;
  assert.equal(tileShift(a, frame(1, 20).gray, W, 0, 2, 96, 48), 0);
  assert.equal(tileShift(a, frame(1, 19).gray, W, 0, 2, 96, 48), -1);
  assert.equal(tileShift(a, frame(1, 21).gray, W, 0, 2, 96, 48), 1);
  assert.equal(tileShift(a, frame(1, 20, 120).gray, W, 0, 2, 96, 48), undefined, "a fade isn't a move");
});

test("1 px up and straight back, then still, is a shake (the spring's tail on whole-pixel text)", () => {
  const shakes = findShakes(run([26, 24, 22, 21, 20, 20, 19, 19, 19, 20, 20, 20, 20, 20]), W, H);
  assert.equal(shakes.length, 1);
  assert.equal(shakes[0]!.frame, 106);
  assert.equal(shakes[0]!.back, 109);
  assert.equal(shakes[0]!.way, "up");
  assert.ok(shakes[0]!.tiles >= 1);
});

test("a vibration up and down every frame is a shake", () => {
  assert.ok(findShakes(run([20, 21, 20, 21, 20, 21, 20, 20, 20, 20]), W, H).length >= 1);
});

test("a steady move, a settle that stays, a slow float and a fade are not shakes", () => {
  assert.deepEqual(findShakes(run([30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20]), W, H), [], "a steady move");
  assert.deepEqual(findShakes(run([28, 24, 21, 20, 20, 19, 19, 19, 19, 19, 19]), W, H), [], "a settle that stays where it lands");
  assert.deepEqual(findShakes(run([20, 20, 21, 21, 21, 20, 20, 19, 19, 19, 20, 20, 21, 21]), W, H), [], "a float of a pixel each way keeps going");
  const fade = [230, 200, 170, 140, 110, 80, 60, 40].map((l, i) => frame(i, 20, l));
  assert.deepEqual(findShakes(fade, W, H), [], "a fade");
});

test("frames that aren't consecutive are never compared", () => {
  const ys = [20, 20, 19, 20, 20, 20, 20, 20];
  const gapped = ys.map((y, i) => frame(i * 2, y));
  assert.deepEqual(findShakes(gapped, W, H), []);
});

/** A frame of `footage` (a smooth gradient) with a dark panel from x = `left` to the right edge. */
function panel(n: number, left: number): GrayFrame {
  const gray = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gray[y * W + x] = x >= left ? 26 : 150 + ((x + y) % 40);
  return { frame: n, gray };
}

test("a full-screen layer a pixel short of the left edge is a sliver; footage to the edge or a full cover is not", () => {
  assert.equal(hasSliver(panel(0, 1).gray, W, H, "left"), true);
  assert.equal(hasSliver(panel(0, 0).gray, W, H, "left"), false, "the panel covers the frame");
  assert.equal(hasSliver(panel(0, 60).gray, W, H, "left"), false, "footage reaching the edge");
  assert.equal(hasSliver(panel(0, 1).gray, W, H, "right"), false);
  const slivers = findSlivers([panel(10, 60), panel(11, 1), panel(12, 1), panel(13, 0)], W, H);
  assert.deepEqual(slivers, [{ edge: "left", start: 11, end: 12 }]);
});

test("the findings: motion, never blockers, with the frames and where", () => {
  const out = jitterFindings([{ frame: 831, back: 834, way: "up", x: 192, y: 98, w: 480, h: 432, tiles: 9 }], [{ edge: "left", start: 279, end: 279 }], 30);
  assert.deepEqual(
    out.map((f) => [f.rule, f.key, f.frame, f.range, f.hard]),
    [
      ["motion", "motion:shake:831", 831, { start: 831, end: 834 }, false],
      ["motion", "motion:sliver:left:279", 279, { start: 279, end: 279 }, false],
    ],
  );
  assert.match(out[0]!.message, /f 831 to f 834 \(27\.70 s\).*1 px up and straight back/);
  assert.match(out[1]!.message, /1 px line along the left edge from f 279 to f 279/);
});

test("review_submit's runs: a few windows of consecutive frames after the scene changes, inside the edit", () => {
  const anchors = [0, 90, 180, 270, 395].map((frame) => ({ frame }));
  const plan = finePlan(anchors, 30, 400);
  assert.equal(plan.length, FINE_WINDOWS);
  for (const frames of plan) {
    assert.equal(frames.length, FINE_RUN);
    assert.ok(frames.every((f, i) => i === 0 || f === frames[i - 1]! + 1));
  }
  assert.deepEqual(
    plan.map((f) => f[0]),
    [3, 183, 400 - FINE_RUN],
    "the last one ends with the edit",
  );
  assert.ok(plan.flat().every((f) => f >= 0 && f < 400));
  assert.deepEqual(
    finePlan([{ frame: 0 }, { frame: 2 }], 30, 40).flat().length,
    new Set(finePlan([{ frame: 0 }, { frame: 2 }], 30, 40).flat()).size,
    "windows don't overlap",
  );
  assert.deepEqual(finePlan([], 30, 400), []);
});
