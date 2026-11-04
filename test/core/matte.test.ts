// Chroma key, blend modes and shape masks (D326): the registry against the manifests, params with
// defaults and bad values, what clipFx compiles, the key, spill, blend and mask maths, their ffmpeg
// expressions against the JS, mask keys (keyed, split, History words) and the planners.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  applyEdit,
  blendChannel,
  BLEND_MODES,
  clipFx,
  createSession,
  despill,
  describeOp,
  effectInfo,
  effectOptions,
  effectParams,
  fxWords,
  KEY_PROPS,
  keyAlpha,
  keyAlphaExpr,
  loadModules,
  maskAt,
  maskCoverage,
  maskCoverageExpr,
  needsPicturePass,
  planEffect,
  spillChannel,
  validateProject,
  type ClipMask,
  type Item,
  type Op,
  type Project,
} from "../../packages/core/src/index.ts";

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function project(effects?: Item["effects"], extra: Partial<Item> = {}): Project {
  return {
    format: "uncut/0",
    name: "Matte",
    canvas: { width: 1280, height: 720, fps: 30 },
    media: [{ id: "m-a", kind: "video", name: "A.mp4", path: "/a.mp4", probe: { frames: 300, fps: 30, width: 1280, height: 720, hasAudio: false } }],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [{ id: "c1", type: "clip", media: "m-a", in: 0, duration: 90, ...(effects ? { effects } : {}), ...extra }],
      },
    ],
  };
}

/** An ffmpeg expression (the functions these use) evaluated in JS. */
function evalExpr(expr: string, vars: Record<string, number>): number {
  const js = expr.replace(/\bif\(/g, "iff(").replace(/(?<![.\w])(hypot|abs|max|min)\(/g, "Math.$1(");
  const names = Object.keys(vars);
  const f = new Function(...names, "clip", "iff", "gt", `return ${js};`);
  return f(
    ...names.map((n) => vars[n]),
    (v: number, a: number, b: number) => Math.min(b, Math.max(a, v)),
    (c: number, a: number, b: number) => (c ? a : b),
    (a: number, b: number) => (a > b ? 1 : 0),
  );
}

test("D326: the three effects' manifests are the registry's (options and numbers), and validate with their defaults", async () => {
  for (const id of ["effect.chroma-key", "effect.blend", "effect.mask"]) {
    const info = effectInfo(id)!;
    const props = json(`spec/modules/builtin/${id}.json`).params.properties as Record<string, { default: unknown; enum?: Array<string> }>;
    for (const o of info.options ?? []) {
      assert.deepEqual(props[o.key]!.default, o.default, `${id} ${o.key}`);
      if (o.kind === "choice")
        assert.deepEqual(
          props[o.key]!.enum,
          o.choices.map((c) => c.id),
        );
    }
  }
  assert.deepEqual(
    json("spec/modules/builtin/effect.blend.json").params.properties.mode.enum,
    BLEND_MODES.map((b) => b.id),
  );
  const modules = await loadModules("spec/modules/builtin");
  const ok: Item["effects"] = [
    { module: "effect.chroma-key", params: { color: "#3a9f4c", tolerance: 0.2, softness: 0.05, spill: 0.7 } },
    { module: "effect.blend", params: { mode: "multiply" } },
    { module: "effect.mask", params: { shape: "ellipse", x: 10, y: 20, w: 300, h: 200, feather: 12, invert: true } },
  ];
  assert.deepEqual(
    validateProject(
      project(ok, {
        keys: [
          { frame: 0, maskX: 10 },
          { frame: 30, maskX: 200, maskW: 100 },
        ],
      }),
      modules,
    ),
    [],
  );
  assert.ok(validateProject(project([{ module: "effect.blend", params: { mode: "dodge" } }]), modules).length > 0, "unknown mode");
  assert.ok(validateProject(project([{ module: "effect.chroma-key", params: { color: "green" } }]), modules).length > 0, "a colour is #rrggbb");
  assert.ok(validateProject(project([{ module: "effect.mask", params: { shape: "star" } }]), modules).length > 0, "unknown shape");
});

test("D326: params: defaults, bad values replaced, numbers clamped; clipFx compiles key, mask and blend (normal draws nothing)", () => {
  assert.deepEqual(effectOptions("effect.chroma-key", {}), { color: "#00ff00" });
  assert.deepEqual(effectOptions("effect.chroma-key", { color: "#3A9F4C" }), { color: "#3a9f4c" });
  assert.deepEqual(effectOptions("effect.blend", { mode: "dodge" }), { mode: "screen" });
  assert.deepEqual(effectOptions("effect.mask", { invert: "yes", shape: "ellipse" }), { shape: "ellipse", invert: false });
  assert.deepEqual(effectParams("effect.chroma-key", { tolerance: 3, softness: 0 }), { tolerance: 1, softness: 0.01, spill: 0.5 });
  const fx = clipFx({
    type: "clip",
    effects: [
      { module: "effect.chroma-key" },
      { module: "effect.mask", params: { w: 100, h: 50, radius: 8 } },
      { module: "effect.blend", params: { mode: "overlay" } },
    ],
  })!;
  assert.deepEqual(fx.key, { color: "#00ff00", tolerance: 0.25, softness: 0.1, spill: 0.5 });
  assert.deepEqual(fx.mask, { shape: "rectangle", invert: false, x: 0, y: 0, w: 100, h: 50, radius: 8, feather: 0 });
  assert.equal(fx.blend, "overlay");
  assert.ok(needsPicturePass(fx));
  assert.equal(clipFx({ type: "clip", effects: [{ module: "effect.blend", params: { mode: "normal" } }] }), undefined, "normal is nothing");
  const blendOnly = clipFx({ type: "clip", effects: [{ module: "effect.blend", params: { mode: "add" } }] })!;
  assert.ok(!needsPicturePass(blendOnly), "a blend alone needs no picture pass");
  assert.equal(clipFx({ type: "clip", effects: [{ module: "effect.chroma-key", bypass: true }] }), undefined, "bypassed");
});

test("D326: key maths: the key colour goes, far colours stay, softness ramps, spill comes off green or blue keys; lut2's expression is the same sum", () => {
  const key = { color: "#00ff00", tolerance: 0.25, softness: 0.1, spill: 0.5 };
  assert.equal(keyAlpha(key, 0, 1, 0), 0);
  assert.equal(keyAlpha(key, 0.1, 0.9, 0.1), 0, "near green is keyed");
  assert.equal(keyAlpha(key, 1, 0.2, 0.2), 1, "red is kept");
  assert.equal(keyAlpha(key, 0.9, 0.7, 0.6), 1, "skin is kept");
  const edge = keyAlpha(key, 0.35, 0.8, 0.35);
  assert.ok(edge > 0 && edge < 1, `a soft edge: ${edge}`);
  assert.deepEqual(despill(key, 0.5, 0.8, 0.5), [0.5, 0.65, 0.5]);
  assert.deepEqual(despill(key, 0.9, 0.2, 0.2), [0.9, 0.2, 0.2], "no green to pull");
  assert.equal(spillChannel({ color: "#0047bb" }), "blue");
  assert.equal(spillChannel({ color: "#ff00ff" }), undefined);
  assert.deepEqual(despill({ ...key, color: "#ff00ff" }, 0.5, 0.8, 0.5), [0.5, 0.8, 0.5], "no spill removal for other keys");
  const expr = keyAlphaExpr(key);
  for (const [r, g, b] of [
    [0, 1, 0],
    [0.35, 0.8, 0.35],
    [0.3, 0.7, 0.3],
    [0.9, 0.7, 0.6],
  ] as const) {
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const u = 128 + (224 * (b - y)) / 1.8556;
    const v = 128 + (224 * (r - y)) / 1.5748;
    assert.ok(Math.abs(evalExpr(expr, { x: u, y: v }) / 255 - keyAlpha(key, r, g, b)) < 1e-4, `${r},${g},${b}`);
  }
});

test("D326: blend sums match CSS: screen lightens, multiply darkens, overlay keys on the backdrop, add clips", () => {
  assert.equal(blendChannel("screen", 0.5, 0.5), 0.75);
  assert.equal(blendChannel("multiply", 0.5, 0.5), 0.25);
  assert.equal(blendChannel("overlay", 0.25, 0.8), 0.4, "dark backdrop: 2·b·s");
  assert.ok(Math.abs(blendChannel("overlay", 0.75, 0.2) - 0.6) < 1e-9, "light backdrop: screen");
  assert.equal(blendChannel("add", 0.7, 0.6), 1);
  assert.equal(blendChannel("lighten", 0.3, 0.6), 0.6);
  assert.equal(blendChannel("darken", 0.3, 0.6), 0.3);
  assert.equal(blendChannel("normal", 0.3, 0.6), 0.6);
});

test("D326: mask coverage: inside, outside, a feather centred on the edge, rounded corners, ellipse, invert; ffmpeg's expression is the same number", () => {
  const rect: ClipMask = { shape: "rectangle", invert: false, x: 100, y: 50, w: 200, h: 100, radius: 20, feather: 10 };
  assert.equal(maskCoverage(rect, 200, 100), 1);
  assert.equal(maskCoverage(rect, 50, 100), 0);
  assert.equal(maskCoverage(rect, 100, 100), 0.5, "on the edge: half");
  assert.equal(maskCoverage(rect, 105, 100), 1, "half the feather inside: all");
  assert.equal(maskCoverage(rect, 101, 51), 0, "the rounded corner is cut");
  assert.equal(maskCoverage({ ...rect, feather: 0 }, 100.25, 100), 0.75, "no feather: a pixel's antialiasing");
  assert.equal(maskCoverage({ ...rect, invert: true }, 50, 100), 1);
  const ellipse: ClipMask = { ...rect, shape: "ellipse" };
  assert.equal(maskCoverage(ellipse, 200, 100), 1);
  assert.equal(maskCoverage(ellipse, 300, 100), 0.5, "the ellipse's edge at its widest");
  assert.equal(maskCoverage(ellipse, 120, 60), 0, "a box corner is outside an ellipse");
  for (const m of [rect, ellipse, { ...ellipse, invert: true }, { ...rect, radius: 0, feather: 0 }])
    for (const [x, y] of [
      [200, 100],
      [101, 98],
      [104, 55],
      [298, 140],
      [10, 10],
    ] as const) {
      const want = maskCoverage(m, x + 0.5, y + 0.5);
      assert.ok(Math.abs(evalExpr(maskCoverageExpr(m, "(X+0.5)", "(Y+0.5)"), { X: x, Y: y }) - want) < 1e-6, `${m.shape} ${x},${y}`);
    }
});

test("D326: mask keys: maskX/Y/W/H move it like box keys, a size of 0 is the box's, a split keeps them, History names them", () => {
  const mask: ClipMask = { shape: "rectangle", invert: false, x: 0, y: 10, w: 0, h: 0, radius: 0, feather: 0 };
  const keys: Item["keys"] = [
    { frame: 0, maskX: 0, maskW: 100 },
    { frame: 30, maskX: 300, maskW: 400, ease: "inOut" },
    { frame: 60, maskX: 300 },
  ];
  assert.deepEqual(maskAt(mask, undefined, 15, { w: 640, h: 360 }), { ...mask, w: 640, h: 360 }, "unkeyed, the box's size");
  const mid = maskAt(mask, keys, 15, { w: 640, h: 360 });
  assert.deepEqual([mid.x, mid.w, mid.y, mid.h], [150, 250, 10, 360]);
  assert.ok(KEY_PROPS.includes("maskX") && KEY_PROPS.includes("maskH"));
  const p = project([{ module: "effect.mask", params: { y: 10 } }], { keys });
  const split = applyEdit(createSession(p), { actor: "user", ops: [{ op: "split_item", item: "c1", at: 45, newId: "c2" }] }).project;
  const second = split.tracks[0]!.items.find((i) => i.id === "c2")!;
  assert.equal(maskAt(mask, second.keys, 0, { w: 640, h: 360 }).x, maskAt(mask, keys, 45, { w: 640, h: 360 }).x, "the second half starts where the mask was");
  const op = { op: "update_item", item: "c1", set: { keys } } as Op;
  assert.match(describeOp(op, p), /maskX at 0\.0s, 1\.0s, 2\.0s; maskW at 0\.0s, 1\.0s/);
});

test("D326: planners: a new mask covers the middle of the clip's box, options change with one edit and words; History words", () => {
  let p = project();
  const apply = (plan: ReturnType<typeof planEffect>) => {
    if ("problem" in plan) throw new Error(plan.problem);
    p = applyEdit(createSession(p), { actor: "user", ops: plan.ops as ReadonlyArray<Op> }).project;
    return plan;
  };
  assert.equal(apply(planEffect(p, "c1", "effect.mask")).summary, "Add mask to A.mp4");
  assert.deepEqual(p.tracks[0]!.items[0]!.effects![0]!.params, { shape: "rectangle", invert: false, x: 256, y: 144, w: 768, h: 432, radius: 0, feather: 0 });
  assert.equal(apply(planEffect(p, "c1", "effect.mask", { shape: "ellipse" })).summary, "Set mask shape on A.mp4 to ellipse");
  assert.equal(apply(planEffect(p, "c1", "effect.mask", { invert: true })).summary, "Set mask invert on A.mp4 to on");
  assert.equal(apply(planEffect(p, "c1", "effect.chroma-key")).summary, "Add chroma key to A.mp4");
  assert.equal(apply(planEffect(p, "c1", "effect.chroma-key", { color: "#3366FF" })).summary, "Set chroma key key colour on A.mp4 to #3366ff");
  apply(planEffect(p, "c1", "effect.blend"));
  assert.equal(apply(planEffect(p, "c1", "effect.blend", { mode: "multiply" })).summary, "Set blend mode mode on A.mp4 to multiply");
  assert.equal(fxWords(p.tracks[0]!.items[0]!.effects), "mask ellipse, chroma key #3366ff, blend mode multiply");
});
