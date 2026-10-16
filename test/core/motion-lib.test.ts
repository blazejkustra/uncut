// D292: uncut:lib/motion.js (uncutMotion), the one-take motion film helpers. Run in a VM as a
// classic script: its spring is core's spring value for value, a value with many targets is the
// sum of one spring per change (continuous at every retarget, settling on the last target), the
// liquid indicator's leading edge runs ahead, text rises out of its mask line and leaves upward, a
// flood covers past the corners and takes its time, iris blades close the aperture, the squeeze keeps
// letters touching, the cursor dips on a click, and every function is a pure function of t.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { SPRING_NAMES, springAt } from "../../packages/core/src/index.ts";

type Pt = [number, number];
interface Motion {
  spring: (t: number, s: unknown) => number;
  springs: (t: number, keys: Array<Record<string, number>>, s?: unknown, field?: string) => number;
  edges: (t: number, keys: Array<{ at: number; left: number; right: number }>, o?: unknown) => { left: number; right: number };
  rise: (t: number, o: { at: number; out?: number; height: number }) => { y: number; visible: boolean };
  flood: (t: number, o: Record<string, unknown>) => { x: number; y: number; r: number; full: boolean };
  cover: (x: number, y: number, w: number, h: number) => number;
  iris: (open: number, o: { x: number; y: number; r: number; blades?: number }) => Array<Array<Pt>>;
  squeeze: (xs: Array<number>, widths: Array<number>, anchor: number, f: number) => Array<{ x: number; scale: number; width: number }>;
  cursor: (t: number, path: Array<Record<string, unknown>>, o?: unknown) => { x: number; y: number; scale: number; down: boolean };
  camera: (t: number, keys: Array<Record<string, number>>, s?: unknown) => { x: number; y: number; zoom: number };
  beat: (n: number, o?: { bpm?: number; offset?: number }) => number;
  loop: (t: number, d: number) => number;
  ease: { inOut: (p: number) => number };
  mixColor: (a: string, b: string, p: number) => string;
}

const load = (): Motion => {
  const window: Record<string, unknown> = {};
  runInNewContext(readFileSync(join(resolve("assets/graphic-libs"), "motion.js"), "utf8"), { window });
  return window.uncutMotion as Motion;
};
const M = load();
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

test("spring is core's spring, value for value", () => {
  for (const p of [...SPRING_NAMES, { stiffness: 100, damping: 20 }, { stiffness: 100, damping: 50, mass: 2, velocity: 1 }, { stiffness: 80, damping: 6, velocity: -3 }]) {
    for (let t = -0.1; t < 3; t += 0.037) assert.ok(near(M.spring(t, p), springAt(p, t), 1e-12), `${JSON.stringify(p)} at ${t}`);
  }
});

test("springs: one spring per target change, continuous at every retarget, settles on the last target", () => {
  const keys = [
    { at: 0, to: 0 },
    { at: 1, to: 200 },
    { at: 1.15, to: 80 },
    { at: 2, to: 80 },
  ];
  assert.equal(M.springs(0.5, keys, "spring.snap"), 0, "the first target before any change");
  // A single change is that spring scaled.
  for (let t = 1; t < 1.15; t += 0.01) assert.ok(near(M.springs(t, keys, "spring.snap"), 200 * springAt("spring.snap", t - 1), 1e-9));
  // Continuous: no jump across the retarget at 1.15 (it's mid-flight there).
  const dt = 1 / 240;
  const before = M.springs(1.15 - 1e-6, keys, "spring.snap");
  const after = M.springs(1.15 + 1e-6, keys, "spring.snap");
  assert.ok(Math.abs(after - before) < 0.01, `${before} → ${after}`);
  // No frame-to-frame jump anywhere bigger than what the springs' speeds allow.
  let worst = 0;
  for (let t = 0; t < 3; t += dt) worst = Math.max(worst, Math.abs(M.springs(t + dt, keys, "spring.snap") - M.springs(t, keys, "spring.snap")));
  assert.ok(worst < 20, `largest step ${worst}`);
  assert.ok(near(M.springs(4, keys, "spring.snap"), 80, 1e-3), "rests on the last target");
  // Order of keys doesn't matter; the same t gives the same value whatever was asked before.
  assert.equal(M.springs(1.3, [...keys].reverse(), "spring.snap"), M.springs(1.3, keys, "spring.snap"));
  assert.equal(load().springs(1.3, keys, "spring.snap"), M.springs(1.3, keys, "spring.snap"));
});

test("edges: the leading edge runs ahead of the trailing one, both ways", () => {
  const keys = [
    { at: 0, left: 0, right: 100 },
    { at: 1, left: 300, right: 400 },
    { at: 3, left: 0, right: 100 },
  ];
  const right = M.edges(1.08, keys);
  assert.ok(right.right - right.left > 100 + 20, `stretches while moving right: width ${right.right - right.left}`);
  const back = M.edges(3.08, keys);
  assert.ok(back.right - back.left > 100 + 20, `stretches while moving left: width ${back.right - back.left}`);
  assert.ok(300 - back.left > 400 - back.right, "moving left, the left edge leads");
  const rest = M.edges(2.9, keys);
  assert.ok(near(rest.left, 300, 0.5) && near(rest.right, 400, 0.5), "settles at its target width");
});

test("rise: text comes up out of its mask line and leaves upward", () => {
  const o = { at: 1, out: 2, height: 80 };
  assert.equal(M.rise(0.5, o).visible, false);
  assert.equal(M.rise(0.5, o).y, 80, "below the line before it starts");
  assert.ok(near(M.rise(1.9, o).y, 0, 0.1), "in place");
  assert.ok(M.rise(2.1, o).y < 0, "leaves upward");
  assert.ok(M.rise(2.9, o).y <= -79 && !M.rise(3, o).visible, "gone above the line");
});

test("flood: overscales past the corners, takes its time, then contracts into the next shape", () => {
  const W = 1080;
  const H = 1350;
  const o = { at: 1, x: 540, y: 675, r: 40, width: W, height: H, dur: 0.3, until: 2, to: { x: 540, y: 400, r: 120 } };
  const corner = Math.hypot(540, 675);
  assert.ok(M.cover(540, 675, W, H) > corner, "past the farthest corner");
  assert.equal(M.flood(0.9, o).r, 40);
  assert.ok(M.flood(1.3, o).r > corner && M.flood(1.3, o).full, "full at the end of its 0.3 s");
  // At 60 fps no single frame grows it by more than a third of the frame's diagonal.
  let worst = 0;
  for (let t = 1; t < 1.3; t += 1 / 60) worst = Math.max(worst, M.flood(t + 1 / 60, o).r - M.flood(t, o).r);
  assert.ok(worst < Math.hypot(W, H) / 3, `largest step ${worst}`);
  assert.ok(M.flood(1.15, o).r < corner, "not full half way");
  const end = M.flood(2.4, o);
  assert.deepEqual([end.x, end.y, end.r], [540, 400, 120], "contracted into the next shape");
});

test("iris: six blades; open, the aperture is clear; closed, the blades cover the centre", () => {
  const o = { x: 500, y: 500, r: 200 };
  const open = M.iris(1, o);
  assert.equal(open.length, 6);
  const inside = (p: Pt, poly: Array<Pt>) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]!;
      const [xj, yj] = poly[j]!;
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  assert.ok(!open.some((b) => inside([500, 500], b)), "open: the centre is clear");
  const half = M.iris(0.5, o);
  assert.ok(!half.some((b) => inside([500, 500], b)), "half: the centre is still clear");
  assert.ok(half.some((b) => inside([500 + 150, 500 + 20], b)), "half: the blades cover the outer ring");
  const closed = M.iris(0.02, o);
  assert.ok(closed.some((b) => inside([510, 505], b)), "nearly closed: near the centre is covered");
  for (const b of closed) for (const [x, y] of b) assert.ok(Math.hypot(x - 500, y - 500) <= 200 + 1e-6, "blades stay in the circle");
  assert.deepEqual(M.iris(0.5, o), half, "pure");
});

test("squeeze, cursor, camera, beat, loop, colours", () => {
  // Letters pulled into the period keep touching: each letter's right edge meets the next's left.
  const xs = [0, 60, 120];
  const ws = [60, 60, 60];
  for (const f of [1, 0.5, 0.1]) {
    const s = M.squeeze(xs, ws, 180, f);
    for (let i = 0; i < 2; i++) assert.ok(near(s[i]!.x + s[i]!.width, s[i + 1]!.x, 1e-9), `touching at ${f}`);
  }
  assert.deepEqual([...M.squeeze(xs, ws, 180, 0).map((l) => l.x)], [180, 180, 180]);
  // The cursor travels between waypoints and dips on a click.
  const path = [
    { at: 0, x: 100, y: 100 },
    { at: 0.5, x: 500, y: 300, click: 1 },
    { at: 2, x: 100, y: 100 },
  ];
  const c = M.cursor(1.1, path);
  assert.ok(near(c.x, 500, 10) && c.down && c.scale < 0.95, JSON.stringify(c));
  assert.ok(near(M.cursor(1.6, path).scale, 1, 0.01) && !M.cursor(1.6, path).down, "back after the press");
  assert.ok(near(M.cursor(4, path).x, 100, 0.5), "back where it started for a loop");
  const cam = M.camera(3, [
    { at: 0, x: 0, y: 0, zoom: 1 },
    { at: 1, x: 200, y: 50, zoom: 2 },
  ]);
  assert.ok(near(cam.zoom, 2, 0.01) && near(cam.x, 200, 1));
  assert.equal(M.beat(4, { bpm: 120, offset: 0.25 }), 2.25);
  assert.equal(M.loop(9.5, 8), 1.5);
  assert.equal(M.loop(-0.5, 8), 7.5);
  assert.equal(M.mixColor("#000", "#ffffff", 0.5), "rgb(128, 128, 128)");
  assert.equal(M.ease.inOut(0), 0);
  assert.equal(M.ease.inOut(1), 1);
});
