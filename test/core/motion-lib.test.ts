// D292: uncut:lib/motion.js (uncutMotion), the one-take motion film helpers. Run in a VM as a
// classic script: its spring is core's spring value for value, a value with many targets is the
// sum of one spring per change (continuous at every retarget, settling on the last target), the
// liquid indicator's leading edge runs ahead, text rises out of its mask line and leaves upward, a
// flood covers past the corners and takes its time, iris blades close the aperture, the squeeze keeps
// letters touching, the cursor dips on a click, the next shot grows out of a shape (no cut) and a
// footage frame is asked for at its drawn size or larger, and every function is a pure function of t.
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
  camera: (t: number, keys: Array<Record<string, number>>, s?: unknown, o?: { drift?: number }) => { x: number; y: number; zoom: number };
  beat: (n: number, o?: { bpm?: number; offset?: number }) => number;
  loop: (t: number, d: number) => number;
  ease: { inOut: (p: number) => number };
  mixColor: (a: string, b: string, p: number) => string;
  shape: (t: number, keys: Array<Record<string, unknown>>, o?: Record<string, unknown>) => { x: number; y: number; w: number; h: number; r: number; full: boolean };
  shapePath: (ctx: unknown, s: { x: number; y: number; w: number; h: number; r: number }) => void;
  footageRect: (sw: number, sh: number, w: number, h: number, s?: Record<string, number>) => { x: number; y: number; w: number; h: number };
  riseText: (ctx: unknown, text: string, x: number, baseline: number, t: number, o: Record<string, unknown>) => boolean;
  frameRect: (left: number, top: number, w: number, h: number, o?: Record<string, unknown>) => { x: number; y: number; zoom: number };
  apply: (ctx: unknown, cam: { x: number; y: number; zoom: number }, w: number, h: number) => void;
  toScreen: (cam: { x: number; y: number; zoom: number }, x: number, y: number, w: number, h: number) => [number, number];
  morph: (t: number, from: Record<string, number> | string, to: Record<string, number> | string, o?: Record<string, unknown>) => { x: number; y: number; w: number; h: number; r: number; p: number; full: boolean };
  coverage: (s: { x: number; y: number; w: number; h: number; r: number }, w: number, h: number) => number;
  cameraCSS: (cam: { x: number; y: number; zoom: number }, w: number, h: number) => string;
  shapeCSS: (s: { x: number; y: number; w: number; h: number; r: number }) => { left: number; top: number; width: number; height: number; borderRadius: number };
  riseCSS: (t: number, o: Record<string, number>) => { height: number; transform: string; visible: boolean };
  swap: (t: number, at: number, o?: Record<string, number>) => Record<"out" | "in", { alpha: number; blur: number; dy: number; visible: boolean }>;
  grow: (t: number, o: Record<string, unknown>) => { rects: Array<{ x: number; y: number; w: number; h: number; r: number }>; x: number; y: number; w: number; h: number; r: number; scale: number; full: boolean; visible: boolean };
  growPath: (ctx: unknown, g: { rects: Array<{ x: number; y: number; w: number; h: number; r: number }> }) => void;
  growCSS: (g: { rects: Array<{ x: number; y: number; w: number; h: number; r: number }> }) => string;
  frameWidth: (drawn: number, zoom?: number) => number;
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

// D296: the hero shape morphs (a flood is a morph to bleed), the footage covers the shape's whole
// extent at one scale, and a rising line's mask never cuts a resting glyph.
test("shape: one rounded rect morphing key to key; bleed fills past every edge; continuous", () => {
  const W = 1080;
  const H = 1350;
  const keys = [{ at: 0, x: 540, y: 675, w: 980, h: 1250, r: 48 }, { at: 1, bleed: true }, { at: 2, x: 540, y: 600, w: 700, h: 700, r: 350 }];
  const a = M.shape(0.5, keys, { width: W, height: H });
  assert.deepEqual([a.w, a.h, a.r, a.full], [980, 1250, 48, false]);
  const b = M.shape(1.9, keys, { width: W, height: H });
  assert.ok(b.full && b.r < 1 && b.w > W && b.h > H, JSON.stringify(b));
  const c = M.shape(3.5, keys, { width: W, height: H });
  assert.ok(near(c.w, 700, 0.5) && near(c.r, 350, 0.5) && !c.full);
  // No jump between frames at 60 fps.
  for (let f = 0; f < 240; f++) {
    const p = M.shape(f / 60, keys, { width: W, height: H });
    const q = M.shape((f + 1) / 60, keys, { width: W, height: H });
    assert.ok(Math.abs(q.w - p.w) < W * 0.2, `frame ${f}`);
  }
  const path: Array<string> = [];
  M.shapePath({ beginPath: () => path.push("b"), moveTo: () => path.push("m"), arcTo: () => path.push("a"), closePath: () => path.push("z") }, a);
  assert.equal(path.join(""), "bmaaaaz");
});

test("footageRect: covers the frame and the growing shape; the same scale while the shape fits", () => {
  const inside = M.footageRect(3840, 2160, 1080, 1350, { x: 540, y: 675, w: 600, h: 600, r: 300 });
  const frame = M.footageRect(3840, 2160, 1080, 1350);
  assert.deepEqual(inside, frame, "no zoom while the shape is inside the frame");
  assert.ok(frame.w >= 1080 && frame.h >= 1350 && near(frame.h, 1350, 1e-6));
  // A circle grown past the corners: the clip still covers all of it (no flat edges).
  const big = { x: 540, y: 675, w: 2000, h: 2000, r: 1000 };
  const f = M.footageRect(3840, 2160, 1080, 1350, big);
  assert.ok(f.x <= big.x - big.w / 2 && f.y <= big.y - big.h / 2 && f.x + f.w >= big.x + big.w / 2 && f.y + f.h >= big.y + big.h / 2, JSON.stringify(f));
});

test("riseText: at rest the mask holds the whole line (ascenders and descenders); it's gone after it leaves", () => {
  const calls: Array<{ op: string; args: Array<number | string> }> = [];
  const ctx = new Proxy({}, { get: (_t, op: string) => (...args: Array<number | string>) => calls.push({ op, args }) });
  assert.equal(M.riseText(ctx, "Uncut", 100, 500, 0.4, { at: 0.5, size: 100 }), false, "before it rises");
  assert.equal(M.riseText(ctx, "Uncut", 100, 500, 2, { at: 0.5, out: 3, size: 100 }), true);
  const rect = calls.find((c) => c.op === "rect")!.args as Array<number>;
  const text = calls.find((c) => c.op === "fillText")!.args;
  assert.ok(rect[1]! <= 500 - 100 && rect[1]! + rect[3]! >= 500 + 30, `mask ${rect[1]} to ${rect[1]! + rect[3]!}`);
  assert.ok(Math.abs((text[2] as number) - 500) < 0.5, "at rest on its baseline");
  assert.equal(M.riseText(ctx, "Uncut", 100, 500, 4, { at: 0.5, out: 3, size: 100 }), false, "left within a second");
});

// Rehearsal 3: UI beats framed full-bleed (the UI surface is the frame), a button that grows into
// the next scene instead of collapsing into a dot, and an even push (zoom in log space).
test("frameRect covers the frame with a UI rect; apply and toScreen agree; camera zooms evenly and carries missing fields", () => {
  const W = 1080;
  const H = 1350;
  // A 600 x 400 panel at (200, 100): cover fills the frame (height-limited), cropped at the centre.
  const k = M.frameRect(200, 100, 600, 400, { width: W, height: H });
  assert.ok(near(k.zoom, H / 400, 1e-9));
  const [l, tp] = M.toScreen(k, 200, 100, W, H);
  const [r, b] = M.toScreen(k, 800, 500, W, H);
  assert.ok(l <= 0 && tp <= 1e-6 && r >= W && b >= H - 1e-6, `panel on screen ${l},${tp} to ${r},${b}`);
  assert.ok(near(l + r, W, 1e-6), "centred crop");
  // align x 0 shows the panel's left edge.
  const left = M.frameRect(200, 100, 600, 400, { width: W, height: H, align: { x: 0 } });
  assert.ok(near(M.toScreen(left, 200, 100, W, H)[0], 0, 1e-6));
  // fit shows all of it, with the pad around.
  const fit = M.frameRect(200, 100, 600, 400, { width: W, height: H, fit: true, pad: 20 });
  const [fl] = M.toScreen(fit, 200, 100, W, H);
  assert.ok(near(fl, 20 * fit.zoom, 1e-6), "the pad, scaled");
  // apply is the same transform.
  const calls: Array<Array<number>> = [];
  M.apply({ transform: (...a: Array<number>) => calls.push(a) }, k, W, H);
  const [a, , , d, e, f] = calls[0]!;
  assert.ok(near(a! * 200 + e!, l, 1e-6) && near(d! * 100 + f!, tp, 1e-6));
  // Zoom rides the spring in log space: halfway in time the log zoom is about halfway (1x to 4x passes 2x, not 2.5x),
  // and a key without x/y/zoom keeps the previous key's.
  const keys: Array<Record<string, number>> = [{ at: 0, x: 540, y: 675, zoom: 1 }, { at: 1, zoom: 4 }];
  const z = M.camera(1.15, keys, "spring.settle");
  const lin = 1 + 3 * M.spring(0.15, "spring.settle");
  assert.ok(near(Math.log(z.zoom), Math.log(4) * M.spring(0.15, "spring.settle"), 1e-9) && z.zoom < lin, `${z.zoom} vs linear ${lin}`);
  assert.ok(near(z.x, 540, 1e-9) && near(z.y, 675, 1e-9), "x and y carried over");
});

// Blind round 3: still holds read as dead next to the references; drift keeps a hold alive without
// a breathing loop, stays continuous through the next move and leaves the loop seam alone.
test("camera drift: zoom creeps from key to key, springs away under the next move, continuous, none after the last key", () => {
  const keys: Array<Record<string, number>> = [{ at: 0, x: 540, y: 675, zoom: 2 }, { at: 2, zoom: 3 }, { at: 4, zoom: 2 }];
  const o = { drift: 0.02 };
  const plain = (t: number) => M.camera(t, keys, "spring.settle").zoom;
  const drifted = (t: number) => M.camera(t, keys, "spring.settle", o).zoom;
  assert.equal(drifted(0), plain(0), "nothing at the first key");
  assert.ok(near(drifted(1) / plain(1), Math.sqrt(1.02), 1e-6), "halfway through the hold, half the creep (log space)");
  assert.ok(near(drifted(2) / plain(2), 1.02, 1e-6), "the whole creep at the next key");
  assert.ok(drifted(1.5) > drifted(1) && drifted(1) > drifted(0.5), "always moving in a hold");
  assert.ok(near(drifted(6), plain(6), 1e-3) && near(M.camera(9, keys, "spring.settle", o).zoom, 2, 1e-3), "after the last key it settles where the key says (the seam)");
  const creep = (t: number) => Math.log(drifted(t) / plain(t));
  for (let f = 1; f < 6 * 60; f++) assert.ok(Math.abs(creep(f / 60) - creep((f - 1) / 60)) < 0.002, `the creep never jumps (f ${f})`);
  assert.equal(M.camera(1, [{ at: 0, x: 0, y: 0, zoom: 1, drift: 0 }, { at: 2, zoom: 1 }], undefined, o).zoom, 1, "a key's drift: 0 opts its hold out");
  assert.deepEqual(M.camera(1, keys, "spring.settle"), M.camera(1, keys, "spring.settle", {}), "no drift by default");
});

test("morph grows a button into the next scene's full shape in dur s; coverage measures it", () => {
  const W = 1080;
  const H = 1350;
  const button = { x: 960, y: 1250, w: 88, h: 88, r: 44 };
  const scene = { x: 540, y: 675, w: 1000, h: 1270, r: 40 };
  assert.deepEqual({ ...M.morph(0.9, button, scene, { at: 1 }) }, { p: 0, ...button, full: false });
  const done = M.morph(1.31, button, scene, { at: 1, dur: 0.3 });
  assert.ok(near(done.w, 1000, 1e-9) && near(done.r, 40, 1e-9) && done.p === 1);
  assert.ok(M.morph(1.5, button, "bleed", { at: 1, width: W, height: H }).full, "to bleed");
  // Coverage: the whole frame, a quarter, a rounded rect's corners off it, nothing.
  assert.equal(M.coverage({ x: 540, y: 675, w: 1400, h: 1700, r: 0 }, W, H), 1);
  assert.ok(near(M.coverage({ x: 270, y: 337.5, w: 540, h: 675, r: 0 }, W, H), 0.25, 1e-9));
  assert.ok(M.coverage(scene, W, H) > 0.85 && M.coverage(scene, W, H) < 1);
  assert.ok(M.coverage(button, W, H) < 0.01);
  assert.equal(M.coverage({ x: -500, y: -500, w: 100, h: 100, r: 0 }, W, H), 0);
  // The morph from the button: past the first frames coverage only rises (grows, never collapses).
  let prev = 0;
  for (let f = 0; f <= 24; f++) {
    const c = M.coverage(M.morph(1 + f / 60, button, scene, { at: 1 }), W, H);
    assert.ok(c >= prev - 1e-12, `frame ${f}`);
    prev = c;
  }
  assert.ok(prev > 0.85);
});

test("swap: the old content leaves first, then the new arrives, each quick and with its own timing", () => {
  const before = M.swap(0.9, 1);
  assert.ok(before.out.alpha === 1 && before.out.blur === 0 && before.out.visible && !before.in.visible);
  const mid = M.swap(1.12, 1);
  assert.ok(!mid.out.visible && !mid.in.visible, "the gap: neither overlaps the other");
  const arriving = M.swap(1.2, 1);
  assert.ok(arriving.in.visible && arriving.in.alpha < 1 && arriving.in.blur > 0 && arriving.in.dy > 0);
  const done = M.swap(1.3, 1);
  assert.ok(done.in.alpha === 1 && done.in.blur === 0 && done.in.dy === 0);
});

test("DOM twins: cameraCSS is apply's matrix, shapeCSS the shape's box, riseCSS the rise in a mask", () => {
  const cam = { x: 300, y: 200, zoom: 2 };
  assert.equal(M.cameraCSS(cam, 1080, 1350), `matrix(2, 0, 0, 2, ${540 - 600}, ${675 - 400})`);
  assert.deepEqual({ ...M.shapeCSS({ x: 540, y: 675, w: 200, h: 100, r: 80 }) }, { left: 440, top: 625, width: 200, height: 100, borderRadius: 50 });
  const before = M.riseCSS(0.4, { at: 0.5, size: 100 });
  const rest = M.riseCSS(2, { at: 0.5, size: 100 });
  assert.ok(!before.visible && rest.visible && near(rest.height, 140, 1e-9));
  assert.match(rest.transform, /^translateY\(-?0(\.\d+)?(e-\d+)?px\)$/);
});

test("grow (review): a full before at doesn't stick the scale at 1.12; dur 0 cuts in at once; a negative dur is 0", () => {
  const o = { at: 2, full: 0.5, kind: "inset" };
  assert.ok(near(M.grow(5, o).scale, 1, 1e-9), "settles");
  assert.ok(M.grow(5, o).full);
  for (const dur of [0, -1]) {
    const before = M.grow(1.999, { at: 2, full: 2, dur });
    const on = M.grow(2, { at: 2, full: 2, dur });
    assert.ok(!before.visible && near(before.scale, 1.12, 1e-9), `dur ${dur}: nothing before at`);
    assert.ok(on.full && near(on.scale, 1, 1e-9), `dur ${dur}: full and settled on at`);
    for (const r of on.rects) for (const v of [r.x, r.y, r.w, r.h, r.r]) assert.ok(Number.isFinite(v), `dur ${dur}: no NaN`);
  }
  // dur 0 with the default full (at + 0.5): the seed at once, the bleed at once on full.
  const seed = M.grow(2.01, { at: 2, dur: 0 });
  assert.ok(seed.visible && !seed.full && M.grow(2.5, { at: 2, dur: 0 }).full);
  assert.ok(near(M.grow(2.1, { at: 2 }).w, M.grow(2.1, { at: 2, dur: undefined }).w, 1e-9), "no dur: 0.3 s as before");
});

test("grow: the next shot grows out of a shape into a seed on the kick, then bleeds full on the next; never a blank, never a jump", () => {
  const W = 1080;
  const H = 1350;
  for (const kind of ["inset", "pill", "circle", "strip", "split"]) {
    const o = { at: 13, full: 13.5, kind, width: W, height: H };
    assert.ok(!M.grow(12.99, o).visible, `${kind}: nothing before the kick`);
    const seed = M.grow(13.4, o);
    assert.ok(seed.visible && !seed.full, `${kind}: a seed shape, the old shot still around it`);
    assert.ok(M.grow(13.81, o).full, `${kind}: full by the kick plus dur`);
    assert.ok(seed.scale > 1 && near(M.grow(13.81, o).scale, 1, 1e-9), `${kind}: the picture settles`);
    // Continuous: no rect edge moves more than a fifth of the frame between 60 fps frames.
    let prev = M.grow(13, o);
    for (let f = 1; f <= 60; f++) {
      const g = M.grow(13 + f / 60, o);
      g.rects.forEach((r, i) => assert.ok(Math.abs(r.w - prev.rects[i]!.w) < W / 5 && Math.abs(r.h - prev.rects[i]!.h) < H / 5, `${kind} frame ${f}`));
      prev = g;
    }
  }
  assert.equal(M.grow(13.4, { at: 13, kind: "split" }).rects.length, 2, "split is two halves closing");
  // Round 2's A1: the split's seed left an 8 % sliver of the old shot across the frame (a torn block
  // wipe); its seed leaves a clear window of at least a third of the frame.
  const [a, b] = M.grow(13.4, { at: 13, full: 13.5, kind: "split", width: W, height: H }).rects;
  assert.ok(b!.y - b!.h / 2 - (a!.y + a!.h / 2) >= H / 3, "a window, not a sliver");
  // It grows out of a rect in the previous shot (a thumbnail, a button), not out of nothing.
  const origin = { x: 200, y: 1100, w: 160, h: 90, r: 12 };
  assert.deepEqual({ ...M.grow(13, { at: 13, origin }).rects[0] }, origin);
  // Clip paths: canvas path has one round rect per rect; CSS is a path() of the same.
  const calls: Array<string> = [];
  const ctx = new Proxy({}, { get: (_t, k) => (...a: Array<unknown>) => calls.push(`${String(k)}${a.length}`) });
  M.growPath(ctx, M.grow(13.4, { at: 13, kind: "split" }));
  assert.equal(calls.filter((c) => c === "beginPath0").length, 1);
  assert.equal(calls.filter((c) => c === "closePath0").length, 2);
  assert.match(M.growCSS(M.grow(13.4, { at: 13, kind: "pill" })), /^path\("M [\d.-]+ [\d.-]+ H .* Z"\)$/);
  // Pure: same t, same answer.
  assert.deepEqual(M.grow(13.2, { at: 13, kind: "circle" }), M.grow(13.2, { at: 13, kind: "circle" }));
});

test("frameWidth: footage is asked for at its drawn size times the zoom or larger, on fixed steps", () => {
  assert.equal(M.frameWidth(1080), 1080);
  assert.equal(M.frameWidth(540, 1.8), 1080, "a tile zoomed 1.8x needs 972 px");
  assert.equal(M.frameWidth(1080, 1.12), 1440);
  assert.equal(M.frameWidth(300), 360);
  assert.equal(M.frameWidth(4000), 1920, "capped at uncut.frame's longest edge");
  for (let w = 10; w < 1900; w += 37) assert.ok(M.frameWidth(w, 1) >= w);
});
