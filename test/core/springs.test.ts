// D192: springs. The closed-form step response against a small-step integration, settling, the
// presets' overshoots, purity, "sum of springs" retargeting on box keys (value and velocity
// continuous at the retarget), keys mixing springs with linear moves, text moves with a spring
// ease, a split through a moving spring keeping its motion, and the schemas taking the names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  animationAt,
  applyEdit,
  clipBox,
  createSession,
  keyAt,
  loadModules,
  SPRING_DOC,
  SPRING_NAMES,
  SPRING_PRESETS,
  springAt,
  springEase,
  springSettleTime,
  springState,
  validateProject,
  type Item,
  type Project,
  type SpringParams,
} from "../../packages/core/src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Semi-implicit Euler at 20 µs steps: the reference the closed form must match. */
function integrate(p: SpringParams, until: number): number {
  const m = p.mass ?? 1;
  let x = 0;
  let v = p.velocity ?? 0;
  const dt = 2e-5;
  for (let t = 0; t < until - 1e-12; t += dt) {
    v += ((-p.stiffness * (x - 1) - p.damping * v) / m) * dt;
    x += v * dt;
  }
  return x;
}

test("closed form matches a small-step integration (under, critically and over damped, with mass and velocity)", () => {
  const cases: Array<SpringParams> = [
    ...SPRING_NAMES.map((n) => SPRING_PRESETS[n]),
    { stiffness: 100, damping: 20 }, // critical (ζ = 1)
    { stiffness: 100, damping: 50 }, // over
    { stiffness: 80, damping: 6, mass: 2, velocity: 3 },
    { stiffness: 200, damping: 40, mass: 0.5, velocity: -2 },
  ];
  for (const p of cases) {
    for (const t of [0.05, 0.13, 0.3, 0.7, 1.2]) {
      const want = integrate(p, t);
      const got = springAt(p, t);
      assert.ok(Math.abs(got - want) < 1e-3, `${JSON.stringify(p)} at ${t}s: ${got} vs ${want}`);
    }
  }
});

test("settles to the target; settle time is where it stays within the tolerance", () => {
  for (const n of SPRING_NAMES) {
    const T = springSettleTime(n);
    assert.ok(T > 0.1 && T < 3, `${n} settles in ${T}s`);
    for (let t = T; t < T + 3; t += 0.01) assert.ok(Math.abs(springAt(n, t) - 1) <= 1e-3 + 1e-9, `${n} at ${t}`);
    assert.ok(Math.abs(springAt(n, 10) - 1) < 1e-9);
    assert.equal(springAt(n, 0), 0);
    assert.equal(springAt(n, -1), 0);
  }
});

const peak = (n: (typeof SPRING_NAMES)[number]) => {
  let max = 0;
  for (let t = 0; t < 4; t += 0.0005) max = Math.max(max, springAt(n, t));
  return max - 1;
};
/** The deviations from 1 at each turning point (velocity sign change). */
const extremes = (n: (typeof SPRING_NAMES)[number]) => {
  const out: Array<number> = [];
  let prev = springState(n, 0).velocity;
  for (let t = 0.0005; t < 4; t += 0.0005) {
    const s = springState(n, t);
    if ((prev > 0 && s.velocity <= 0) || (prev < 0 && s.velocity >= 0)) out.push(s.value - 1);
    prev = s.velocity;
  }
  return out;
};

test("presets: snap barely overshoots, land overshoots visibly once, bounce oscillates; spring is settle", () => {
  assert.ok(peak("spring.snap") < 0.02, `snap ${peak("spring.snap")}`);
  const land = peak("spring.land");
  assert.ok(land > 0.03 && land < 0.15, `land ${land}`);
  // Land: one visible overshoot, then the rest is under 3 %.
  assert.ok(extremes("spring.land").slice(1).every((d) => Math.abs(d) < 0.03), JSON.stringify(extremes("spring.land")));
  const bounce = extremes("spring.bounce").filter((d) => Math.abs(d) > 0.02);
  assert.ok(bounce.length >= 3, `bounce turning points over 2 %: ${JSON.stringify(bounce)}`);
  for (let i = 1; i < bounce.length; i++) assert.ok(Math.sign(bounce[i]!) !== Math.sign(bounce[i - 1]!), "alternating sides");
  assert.deepEqual(SPRING_PRESETS.spring, SPRING_PRESETS["spring.settle"]);
  assert.ok(peak("spring.settle") > peak("spring.snap") && peak("spring.settle") < land);
});

test("pure: the same t gives the same value whatever was asked before", () => {
  const ts = [0.9, 0.1, 0.5, 0.1, 2, 0.9, 0.33];
  const first = ts.map((t) => springAt("spring.bounce", t));
  const again = [...ts].reverse().map((t) => springAt("spring.bounce", t)).reverse();
  assert.deepEqual(first, again);
  const keys: Item["keys"] = [{ frame: 0, x: 0, ease: "spring.land" }, { frame: 10, x: 100, ease: "spring.bounce" }, { frame: 25, x: -50 }];
  const forward = Array.from({ length: 60 }, (_, f) => keyAt(keys, "x", f, 30));
  const backward = Array.from({ length: 60 }, (_, f) => 59 - f).map((f) => keyAt(keys, "x", f, 30)).reverse();
  assert.deepEqual(forward, backward);
});

test("springEase: 0 at the start, exactly 1 at the end, overshoots in between for land", () => {
  for (const n of SPRING_NAMES) {
    const e = springEase(n);
    assert.equal(e(0), 0);
    assert.equal(e(1), 1);
    assert.ok(Math.abs(e(0.999) - 1) < 2e-3, `${n} near the end`);
  }
  const land = springEase("spring.land");
  let max = 0;
  for (let p = 0; p <= 1; p += 0.001) max = Math.max(max, land(p));
  assert.ok(max > 1.03 && max < 1.15, `land overshoot ${max}`);
});

test("keys: a spring runs from its key's frame in real time (fps) toward the next value, holding the first value before", () => {
  const keys: Item["keys"] = [{ frame: 10, x: 100, ease: "spring.land" }, { frame: 20, x: 300 }];
  assert.equal(keyAt(keys, "x", 0, 30), 100);
  assert.equal(keyAt(keys, "x", 10, 30), 100);
  for (const f of [12, 15, 20, 30, 40]) assert.ok(Math.abs(keyAt(keys, "x", f, 30)! - (100 + 200 * springAt("spring.land", (f - 10) / 30))) < 1e-9, `frame ${f}`);
  // It runs on past the next key's frame (overshoot included) and settles there.
  const after = Array.from({ length: 40 }, (_, k) => keyAt(keys, "x", 20 + k, 30)!);
  assert.ok(Math.max(...after) > 310, `overshoots past 300: ${Math.max(...after)}`);
  assert.ok(Math.abs(keyAt(keys, "x", 200, 30)! - 300) < 1e-6);
  // fps changes the timing; without one it's 30.
  assert.equal(keyAt(keys, "x", 15), keyAt(keys, "x", 15, 30));
  assert.notEqual(keyAt(keys, "x", 15, 60), keyAt(keys, "x", 15, 30));
  // clipBox takes the canvas's fps.
  const item = { keys, transform: { w: 100, h: 100 } };
  assert.equal(clipBox(item, { width: 1920, height: 1080, fps: 60 }, undefined, 15).x, keyAt(keys, "x", 15, 60));
  assert.equal(clipBox(item, { width: 1920, height: 1080 }, undefined, 15).x, keyAt(keys, "x", 15, 30));
});

test("retarget: a key that starts before the spring settled keeps the value and velocity continuous", () => {
  // Spring toward 100 from frame 0, retargeted at frame 6 (mid-flight) toward 20.
  const keys: Item["keys"] = [{ frame: 0, x: 0, ease: "spring.settle" }, { frame: 6, x: 100, ease: "spring.settle" }, { frame: 30, x: 20 }];
  const fps = 30;
  const at = (f: number) => keyAt(keys, "x", f, fps)!;
  const h = 1e-4;
  assert.ok(Math.abs(at(6 - h) - at(6 + h)) < 1e-2, "no jump at the retarget");
  const vBefore = (at(6) - at(6 - h)) / h;
  const vAfter = (at(6 + h) - at(6)) / h;
  assert.ok(vBefore > 1, `moving at the retarget: ${vBefore}`);
  assert.ok(Math.abs(vBefore - vAfter) / Math.abs(vBefore) < 0.01, `velocity carries: ${vBefore} vs ${vAfter}`);
  // The earlier spring's rest still plays out: the value isn't the second spring alone from at(6).
  const alone = at(6) + (20 - at(6)) * springAt("spring.settle", 4 / fps);
  assert.ok(Math.abs(at(10) - alone) > 1, "the first spring keeps contributing");
  assert.ok(Math.abs(at(400) - 20) < 1e-6, "settles on the last key's value");
});

test("keys mixing a spring with linear and cubic moves; without springs nothing changes", () => {
  const keys: Item["keys"] = [{ frame: 0, scale: 1 }, { frame: 10, scale: 2, ease: "spring.snap" }, { frame: 20, scale: 3, ease: "inOut" }, { frame: 40, scale: 1 }];
  const fps = 30;
  // Linear from 0 to 10.
  assert.ok(Math.abs(keyAt(keys, "scale", 5, fps)! - 1.5) < 1e-12);
  // The spring from 10 toward 3 (step 1), then the cubic from 20 to 40 adds −2·inOut on top.
  for (const f of [12, 18, 25, 33, 39, 60]) {
    const spring = springAt("spring.snap", (f - 10) / fps);
    const p = Math.min(1, Math.max(0, (f - 20) / 20));
    const cubic = f <= 20 ? 0 : p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
    assert.ok(Math.abs(keyAt(keys, "scale", f, fps)! - (2 + spring - 2 * cubic)) < 1e-12, `frame ${f}`);
  }
  // No spring: exactly the plain interpolation (the D75 path).
  const plain: Item["keys"] = [{ frame: 0, x: 0, ease: "inOut" }, { frame: 10, x: 10 }];
  assert.equal(keyAt(plain, "x", 2.5, 30), 10 * 4 * 0.25 ** 3);
});

const canvas = { width: 1920, height: 1080 };
const text = (module: string, params: Record<string, unknown>): Item => ({ id: "t", type: "text", text: "Hello there", duration: 60, animation: { in: { module, duration: 20, params } } });

test("text moves with a spring ease: zoom, rise, pop and scale follow the fitted spring; fades stay linear", () => {
  const e = springEase("spring.land");
  for (const f of [0, 5, 10, 15, 19]) {
    const p = f / 20;
    const zoom = animationAt(text("move.zoom", { scale: 0.5, ease: "spring.land" }), f, canvas);
    if (f === 0) assert.equal(zoom.motion.scale, 0.5);
    else assert.ok(Math.abs((zoom.motion.scale ?? 1) - (0.5 + 0.5 * e(p))) < 1e-12, `zoom at ${f}`);
    assert.ok(Math.abs(zoom.opacity - p) < 1e-12, "the fade is linear");
    const rise = animationAt(text("move.rise", { ease: "spring.land" }), f, canvas);
    assert.ok(Math.abs((rise.motion.dy ?? 0) - (1 - e(p)) * 1080 * 0.04) < 1e-9, `rise at ${f}`);
    const scale = animationAt(text("move.scale", { ease: "spring.land" }), f, canvas);
    assert.ok(Math.abs((scale.motion.scale ?? 1) - e(p)) < 1e-12 || (f === 0 && scale.motion.scale === 0), `scale at ${f}`);
    const pop = animationAt(text("move.pop", { ease: "spring.land" }), f, canvas);
    assert.ok(Math.abs((pop.motion.scale ?? 1) - (0.4 + 0.6 * e(p))) < 1e-12, `pop at ${f}`);
  }
  // The overshoot shows: somewhere in the move the scale goes past 1, the rise past its rest.
  const scales = Array.from({ length: 20 }, (_, f) => animationAt(text("move.scale", { ease: "spring.land" }), f, canvas).motion.scale ?? 1);
  assert.ok(Math.max(...scales) > 1.03, `scale overshoots: ${Math.max(...scales)}`);
  // After the move: the plain text.
  assert.deepEqual(animationAt(text("move.scale", { ease: "spring.land" }), 30, canvas), { opacity: 1, motion: {} });
  // Without an ease each move keeps its own curve (rise eases out).
  const rise = animationAt(text("move.rise", {}), 10, canvas);
  assert.ok(Math.abs((rise.motion.dy ?? 0) - (1 - (1 - (1 - 0.5) ** 3)) * 1080 * 0.04) < 1e-9);
  // Out moves mirror the in move (the same curve, reversed).
  const out: Item = { id: "t", type: "text", text: "Hi", duration: 60, animation: { out: { module: "move.scale", duration: 20, params: { ease: "spring.bounce" } } } };
  assert.ok(Math.abs((animationAt(out, 49, canvas).motion.scale ?? 1) - springEase("spring.bounce")(10 / 20)) < 1e-12);
});

function project(keys: Item["keys"]): Project {
  return {
    format: "uncut/0",
    name: "Springs",
    canvas: { width: 1920, height: 1080, fps: 30 },
    media: [{ id: "m", kind: "video", name: "A.mp4", path: "/A.mp4", probe: { frames: 300, fps: 30, width: 1920, height: 1080, hasAudio: false } }],
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "c", type: "clip", media: "m", in: 0, duration: 120, keys, transform: { w: 400, h: 300 } }] }],
  };
}

test("split through a moving spring: both halves keep the motion frame for frame", async () => {
  const keys: Item["keys"] = [{ frame: 0, x: 0, scale: 1, ease: "spring.bounce" }, { frame: 10, x: 500, scale: 1.5, ease: "spring.land" }, { frame: 30, x: 200 }];
  const before = project(keys);
  const modules = await loadModules(join(root, "spec/modules/builtin"));
  assert.deepEqual(validateProject(before, modules), []);
  const s = applyEdit(createSession(before), { baseRevision: 0, actor: "user", ops: [{ op: "split_item", item: "c", at: 20, newId: "c2" }] }, (p) => validateProject(p, modules));
  const items = s.project.tracks[0]!.items;
  const [a, b] = [items[0]!, items[1]!];
  for (let f = 0; f < 120; f++) {
    const half = f < 20 ? a : b;
    const local = f < 20 ? f : f - 20;
    for (const prop of ["x", "scale"] as const) {
      const want = keyAt(keys, prop, f, 30)!;
      const got = keyAt(half.keys, prop, local, 30)!;
      assert.ok(Math.abs(got - want) < 1e-4, `${prop} at ${f}: ${got} vs ${want}`);
    }
  }
});

test("schemas take the spring names on keys and move params; the doc names them", async () => {
  const modules = await loadModules(join(root, "spec/modules/builtin"));
  const ok = project([{ frame: 0, x: 0, ease: "spring.land" }, { frame: 10, x: 100, ease: "spring" }]);
  assert.deepEqual(validateProject(ok, modules), []);
  const bad = project([{ frame: 0, x: 0, ease: "spring.wobble" as "spring" }, { frame: 10, x: 100 }]);
  assert.ok(validateProject(bad, modules).length > 0);
  const withMove = (module: string, ease: string): Project => ({ ...ok, tracks: [...ok.tracks, { id: "tx", kind: "text", name: "Text", items: [{ id: "t", type: "text", text: "Hi", start: 0, duration: 60, animation: { in: { module, duration: 20, params: { ease } } } }] }] });
  for (const m of ["move.zoom", "move.rise", "move.pop", "move.scale", "move.slide-left", "move.bounce", "move.blur", "move.wipe"]) {
    assert.deepEqual(validateProject(withMove(m, "spring.land"), modules), [], m);
    assert.ok(validateProject(withMove(m, "wobbly"), modules).length > 0, `${m} refuses an unknown ease`);
  }
  for (const n of SPRING_NAMES) assert.ok(SPRING_DOC.includes(`"${n}"`), n);
  assert.doesNotMatch(SPRING_DOC, /[·•*]/);
});
