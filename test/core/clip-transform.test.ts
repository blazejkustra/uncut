// Phase 6 chunk 1 (D75): the clip box model in core. Boxes for contain / cover / fill, the
// defaults (no transform = the full frame, contain: what clips drew before), one-sided sizes and
// centring, scale as a zoom inside the box, keys with eases (per property, held outside their
// range), loop wrapping the source, visualsAt carrying the box and its opacity, and the schema.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { baseBox, clipBox, EASES, fitRect, isPlainBox, keyAt, layout, loadModules, validateProject, visualsAt, type Item, type Project } from "../../packages/core/src/index.ts";

const canvas = { width: 1920, height: 1080 };
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const near = (got: { x: number; y: number; w: number; h: number }, want: { x: number; y: number; w: number; h: number }, what: string) =>
  assert.ok(close(got.x, want.x) && close(got.y, want.y) && close(got.w, want.w) && close(got.h, want.h), `${what}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
const clip = (extra: Partial<Item> = {}): Item => ({ id: "c", type: "clip", media: "m", duration: 90, ...extra });

test("no transform: the whole canvas, contain, scale 1 — the picture fitted as clips drew before D75", () => {
  for (const media of [{ width: 1920, height: 1080 }, { width: 640, height: 480 }, { width: 1080, height: 1920 }, undefined]) {
    const box = clipBox(clip(), canvas, media, 10);
    assert.ok(isPlainBox(box, canvas), JSON.stringify(box));
    assert.equal(box.opacity, 1);
    // The old export: scale to fit (force_original_aspect_ratio=decrease) and centre (pad (ow-iw)/2).
    const k = media ? Math.min(1920 / media.width, 1080 / media.height) : 1;
    const w = media ? media.width * k : 1920;
    const h = media ? media.height * k : 1080;
    near(box.content, { x: (1920 - w) / 2, y: (1080 - h) / 2, w, h }, `content of ${JSON.stringify(media)}`);
  }
});

test("contain, cover and fill place a 4:3 picture in a 16:9 box", () => {
  const media = { width: 800, height: 600 };
  const t = { x: 100, y: 200, w: 640, h: 360 };
  near(clipBox(clip({ transform: { ...t, fit: "contain" } }), canvas, media, 0).content, { x: 100 + (640 - 480) / 2, y: 200, w: 480, h: 360 }, "contain");
  near(clipBox(clip({ transform: { ...t, fit: "cover" } }), canvas, media, 0).content, { x: 100, y: 200 - (480 - 360) / 2, w: 640, h: 480 }, "cover");
  near(clipBox(clip({ transform: { ...t, fit: "fill" } }), canvas, media, 0).content, { x: 100, y: 200, w: 640, h: 360 }, "fill");
  // The box itself is the transform's whatever the fit.
  near(clipBox(clip({ transform: { ...t, fit: "cover" } }), canvas, media, 0), { x: 100, y: 200, w: 640, h: 360 }, "box");
  // No media size known: the picture is taken to have the box's shape.
  near(fitRect({ x: 0, y: 0, w: 100, h: 50 }, "contain", undefined), { x: 0, y: 0, w: 100, h: 50 }, "unknown size");
});

test("one size given: the other from the media's aspect (else the canvas's); no x / y: centred", () => {
  near(baseBox({ transform: { x: 100, y: 200, w: 640 } }, canvas, { width: 800, height: 600 }), { x: 100, y: 200, w: 640, h: 480 }, "w only, 4:3 media");
  near(baseBox({ transform: { h: 540 } }, canvas, { width: 1080, height: 1920 }), { x: (1920 - 303.75) / 2, y: 270, w: 303.75, h: 540 }, "h only, vertical media, centred");
  near(baseBox({ transform: { w: 960 } }, canvas, undefined), { x: 480, y: 270, w: 960, h: 540 }, "w only, no media size");
  near(baseBox({ transform: { fit: "cover" } }, canvas, { width: 640, height: 480 }), { x: 0, y: 0, w: 1920, h: 1080 }, "fit only");
  // A zero or negative size is ignored rather than drawing nothing.
  near(baseBox({ transform: { w: 0, h: -5 } }, canvas, undefined), { x: 0, y: 0, w: 1920, h: 1080 }, "bad sizes");
});

test("scale zooms the picture about the box's centre; the box, opacity and radius", () => {
  const media = { width: 1600, height: 900 };
  const box = clipBox(clip({ transform: { x: 100, y: 100, w: 800, h: 450, scale: 1.5, opacity: 0.5, radius: 400 } }), canvas, media, 0);
  near(box, { x: 100, y: 100, w: 800, h: 450 }, "the box doesn't grow");
  near(box.content, { x: 500 - 600, y: 325 - 337.5, w: 1200, h: 675 }, "zoomed content");
  assert.equal(box.opacity, 0.5);
  assert.equal(box.radius, 225, "radius at most half the shorter side");
  assert.ok(!isPlainBox(box, canvas));
  assert.ok(!isPlainBox(clipBox(clip({ transform: { fit: "cover" } }), canvas, media, 0), canvas), "cover on the full frame isn't plain");
  assert.ok(isPlainBox(clipBox(clip({ transform: { opacity: 0.3 } }), canvas, media, 0), canvas), "opacity alone keeps the plain box");
});

test("keys: linear and the cubic eases, per property, held outside their range; the leaving key's ease shapes the segment", () => {
  assert.equal(EASES.linear(0.25), 0.25);
  assert.equal(EASES.in(0.5), 0.125);
  assert.equal(EASES.out(0.5), 0.875);
  assert.equal(EASES.inOut(0.25), 0.0625);
  assert.equal(EASES.inOut(0.75), 0.9375);
  for (const e of Object.values(EASES)) assert.ok(close(e(0), 0) && close(e(1), 1));
  const keys: Item["keys"] = [
    { frame: 10, x: 0, scale: 1, ease: "out" },
    { frame: 30, x: 100 },
    { frame: 50, scale: 2, opacity: 0.2, ease: "in" },
    { frame: 70, x: 300, ease: "inOut" },
    { frame: 70, x: 400 },
  ];
  // x: 0 @10 (out) → 100 @30 (linear) → 400 @70 (the later key at 70 wins).
  assert.equal(keyAt(keys, "x", 0), 0, "held before the first key");
  assert.equal(keyAt(keys, "x", 10), 0);
  assert.ok(close(keyAt(keys, "x", 20)!, 100 * EASES.out(0.5)), "eased out from the key at 10");
  assert.equal(keyAt(keys, "x", 30), 100);
  assert.ok(close(keyAt(keys, "x", 50)!, 100 + 300 * 0.5), "linear from the key at 30");
  assert.equal(keyAt(keys, "x", 70), 400);
  assert.equal(keyAt(keys, "x", 90), 400, "held after the last key");
  // scale: 1 @10 (out) → 2 @50; the key at 30 has no scale, so it doesn't break the segment.
  assert.ok(close(keyAt(keys, "scale", 30)!, 1 + EASES.out(0.5)));
  // opacity: one key = constant.
  assert.equal(keyAt(keys, "opacity", 0), 0.2);
  assert.equal(keyAt(keys, "y", 20), undefined, "no key carries y");
  assert.equal(keyAt(undefined, "x", 20), undefined);
  // In the box: keyed x moves it (y from the transform), keyed scale zooms, keyed opacity multiplies.
  const item = clip({ transform: { x: 50, y: 60, w: 640, h: 360, opacity: 0.9 }, keys });
  const at20 = clipBox(item, canvas, { width: 1280, height: 720 }, 20);
  assert.ok(close(at20.x, 100 * EASES.out(0.5)) && at20.y === 60);
  assert.ok(close(at20.scale, 1 + EASES.out(0.25)));
  assert.equal(at20.opacity, 0.2, "a keyed opacity replaces the transform's");
  // Pre-roll (a transition before the item's start) holds the first key.
  assert.equal(clipBox(item, canvas, undefined, -5).x, 0);
});

const probe = { frames: 100, fps: 30, width: 640, height: 360, hasAudio: false };
const project = (items: Array<Item>): Project => ({
  format: "uncut/0",
  name: "Box",
  canvas: { width: 1280, height: 720, fps: 30 },
  media: [
    { id: "m", kind: "video", name: "M.mp4", path: "/nowhere/M.mp4", probe },
    { id: "still", kind: "image", name: "S.png", path: "/nowhere/S.png", probe: { width: 400, height: 400 } },
  ],
  tracks: [
    { id: "text", kind: "text", name: "Text", items: [{ id: "t", type: "text", start: 0, duration: 30, text: "Hi" }] },
    { id: "pip", kind: "video", name: "PiP", items: [{ id: "s", type: "clip", media: "still", start: 0, duration: 60, transform: { x: 40, y: 40, w: 200, radius: 24, opacity: 0.5 } }] },
    { id: "main", kind: "video", role: "main", name: "Main", items },
  ],
});

test("loop: a clip longer than its media starts the media over (from its beginning); without loop it doesn't", () => {
  const looped = project([clip({ in: 80, duration: 150, loop: true })]);
  const { starts } = layout(looped);
  const src = (p: Project, f: number) => visualsAt(p, starts, f).find((v) => v.item.id === "c")!.source;
  assert.ok(close(src(looped, 0), 80 / 30));
  assert.ok(close(src(looped, 19), 99 / 30));
  assert.ok(close(src(looped, 20), 0), "wraps at the media's 100 frames");
  assert.ok(close(src(looped, 120), 0), "and again");
  assert.ok(close(src(looped, 149), 29 / 30));
  const plain = project([clip({ in: 0, duration: 90 })]);
  assert.ok(close(src(plain, 89), 89 / 30));
});

test("visualsAt: clips carry their box, their opacity includes the box's; text and stills", () => {
  const p = project([clip({ in: 0, duration: 60, transform: { opacity: 0.25 }, keys: [{ frame: 0, scale: 1 }, { frame: 60, scale: 2 }] })]);
  const { starts } = layout(p);
  const at = visualsAt(p, starts, 30);
  const main = at.find((v) => v.item.id === "c")!;
  const still = at.find((v) => v.item.id === "s")!;
  const text = at.find((v) => v.item.id === "t");
  assert.equal(main.opacity, 0.25);
  assert.ok(close(main.box!.scale, 1.5));
  assert.equal(still.opacity, 0.5);
  near(still.box!, { x: 40, y: 40, w: 200, h: 200 }, "still box from its square aspect");
  assert.equal(still.box!.radius, 24);
  assert.equal(text, undefined, "text ended at 30");
  assert.equal(visualsAt(p, starts, 0).find((v) => v.item.id === "t")!.box, undefined, "text has no box");
});

test("schema: loop on clips, transform.radius and typed keys validate; bad values don't", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const modules = await loadModules(join(root, "spec/modules/builtin"));
  const good = project([clip({ in: 0, duration: 150, loop: true, transform: { x: 100, y: 200, w: 640, fit: "cover", radius: 12 }, keys: [{ frame: 0, scale: 1, ease: "inOut" }, { frame: 150, scale: 1.2, x: 300, opacity: 0.5 }] })]);
  assert.deepEqual(validateProject(good, modules), []);
  const bad = (set: Partial<Item>) => validateProject(project([clip({ in: 0, duration: 60, ...set })]), modules);
  assert.ok(bad({ keys: [{ frame: 0, opacity: 1.5 }] }).length > 0, "opacity key above 1");
  assert.ok(bad({ keys: [{ frame: 0, scale: 0 }] }).length > 0, "zero scale key");
  assert.ok(bad({ transform: { radius: -1 } }).length > 0, "negative radius");
  assert.ok(bad({ keys: [{ frame: 61, x: 0 }] }).some((e) => e.code === "key-range"), "key past the end");
  // Without loop, a clip can't run past its media.
  assert.ok(validateProject(project([clip({ in: 0, duration: 150 })]), modules).some((e) => e.code === "media-range"));
});

// ---- the editor's planners (apps/web/src/timeline/clip.ts), the edit log and the agent's docs ----

import { applyEdit, createSession, describeOp, type Op } from "../../packages/core/src/index.ts";
import { clipState, keyState, planClipBox, planLoop, planResetBox, planToggleKey, resizeBox } from "../../apps/web/src/timeline/clip.ts";
import { SYSTEM_PROMPT } from "../../apps/server/src/agent/agentTools.ts";
import { AGENT_TEXT } from "../helpers/agentText.ts";

const apply = (p: Project, plan: { ops: ReadonlyArray<Op> } | { problem: string }) => {
  if ("problem" in plan) throw new Error(plan.problem);
  return applyEdit(createSession(p), { actor: "user", ops: plan.ops }).project;
};
const mainClip = (p: Project) => p.tracks.find((t) => t.role === "main")!.items[0]!;

test("planners: one edit per change with the whole box; keyed properties change their key at the playhead; labels", () => {
  let p = project([clip({ in: 0, duration: 90 })]);
  // Moving a clip without a transform writes the box it shows (whole pixels), centred defaults resolved.
  let plan = planClipBox(p, "c", { x: 40 }, 10);
  assert.ok("ops" in plan);
  assert.equal(plan.summary, "Move clip");
  p = apply(p, plan);
  assert.deepEqual(mainClip(p).transform, { x: 40, y: 0, w: 1280, h: 720 });
  plan = planClipBox(p, "c", { w: 640.4 }, 10);
  assert.ok("ops" in plan && plan.summary === "Resize clip");
  p = apply(p, plan);
  assert.deepEqual(mainClip(p).transform, { x: 40, y: 0, w: 640, h: 720 });
  p = apply(p, planClipBox(p, "c", { fit: "cover" }, 10));
  assert.equal(mainClip(p).transform?.fit, "cover");
  assert.equal((planClipBox(p, "c", { scale: 1.2 }, 10) as { summary: string }).summary, "Zoom clip to 120%");
  // Clamped to what the schema takes; defaults (scale 1, opacity 1, fit contain) leave the transform.
  p = apply(p, planClipBox(p, "c", { opacity: 1.7, radius: -4 }, 10));
  assert.deepEqual(mainClip(p).transform, { x: 40, y: 0, w: 640, h: 720, fit: "cover" });
  // A diamond adds a scale key at the playhead with the value there; a second one elsewhere; editing scale now edits the key.
  plan = planToggleKey(p, "c", "scale", 0);
  assert.ok("ops" in plan && plan.summary === "Add scale key at 0.0 s");
  p = apply(p, plan);
  p = apply(p, planToggleKey(p, "c", "scale", 60));
  plan = planClipBox(p, "c", { scale: 1.5 }, 60);
  assert.ok("ops" in plan && plan.summary === "Zoom clip to 150% (key at 2.0 s)");
  p = apply(p, plan);
  assert.deepEqual(mainClip(p).keys, [{ frame: 0, scale: 1 }, { frame: 60, scale: 1.5 }]);
  assert.equal(mainClip(p).transform?.scale, undefined, "the transform's scale is untouched");
  assert.equal(clipState(p, "c", 30)!.box.scale, 1.25);
  assert.equal(keyState(mainClip(p), "scale", 60), "on");
  assert.equal(keyState(mainClip(p), "scale", 30), "keyed");
  assert.equal(keyState(mainClip(p), "x", 30), "none");
  // An x key at a frame that already has a scale key joins it; removing scale there keeps the x.
  p = apply(p, planToggleKey(p, "c", "x", 60));
  assert.deepEqual(mainClip(p).keys![1], { frame: 60, scale: 1.5, x: 40 });
  plan = planToggleKey(p, "c", "scale", 60);
  assert.ok("ops" in plan && plan.summary === "Remove scale key at 2.0 s");
  p = apply(p, plan);
  assert.deepEqual(mainClip(p).keys, [{ frame: 0, scale: 1 }, { frame: 60, x: 40 }]);
  // Outside the clip: no key.
  assert.ok("problem" in planToggleKey(p, "c", "x", 200));
  // Reset: no transform, no keys.
  plan = planResetBox(p, "c");
  assert.ok("ops" in plan && plan.summary === "Reset clip position and size");
  p = apply(p, plan);
  assert.equal(mainClip(p).transform, undefined);
  assert.equal(mainClip(p).keys, undefined);
  const looped = planLoop(p, "c", true);
  assert.ok("ops" in looped && looped.summary === "Loop clip");
  assert.equal(mainClip(apply(p, looped)).loop, true);
  // A locked track refuses.
  const locked = { ...p, tracks: p.tracks.map((t) => (t.role === "main" ? { ...t, locked: true } : t)) };
  assert.ok("problem" in planClipBox(locked, "c", { x: 1 }, 0));
});

test("corner handles: the opposite corner stays, the box keeps its shape unless free, at least 16 px", () => {
  const from = { x: 100, y: 100, w: 400, h: 200 };
  assert.deepEqual(resizeBox(from, "se", 100, 0, false), { x: 100, y: 100, w: 500, h: 250 });
  assert.deepEqual(resizeBox(from, "nw", 100, 0, false), { x: 200, y: 150, w: 300, h: 150 });
  assert.deepEqual(resizeBox(from, "ne", 0, -100, false), { x: 100, y: 0, w: 600, h: 300 });
  assert.deepEqual(resizeBox(from, "sw", -40, 10, true), { x: 60, y: 100, w: 440, h: 210 });
  assert.deepEqual(resizeBox(from, "se", -1000, -1000, true), { x: 100, y: 100, w: 16, h: 16 });
});

test("the edit log and the agent's docs say what a box, keys and loop do", () => {
  const p = project([clip({ in: 0, duration: 90 })]);
  const words = (op: Op) => describeOp(op, p);
  assert.equal(words({ op: "update_item", item: "c", set: { transform: { x: 40, y: 0, w: 640, h: 360, fit: "cover", scale: 1.2, opacity: 0.5, radius: 12 } } }), "Moved M.mp4 (c) on the canvas to x 40, y 0, box 640×360, fit cover, scale 120%, opacity 50%, corners 12");
  assert.equal(words({ op: "update_item", item: "c", set: { keys: [{ frame: 0, scale: 1 }, { frame: 60, scale: 1.2, x: 4 }] } }), "Keyframed M.mp4 (c): keys x at 2.0s; scale at 0.0s, 2.0s");
  assert.equal(words({ op: "update_item", item: "c", set: { transform: null, keys: null } }), "Restyled M.mp4 (c): position and size reset; no keys");
  assert.match(words({ op: "update_item", item: "c", set: { loop: true } }), /looped/);
  assert.match(AGENT_TEXT, /Clips \(video and stills\) draw in a box: transform \{x, y, w, h\}/);
  assert.match(AGENT_TEXT, /keys animate x, y, scale and opacity/);
  assert.match(AGENT_TEXT, /"loop":true on a clip/);
  assert.match(AGENT_TEXT, /media clips in their box/);
});

test("split and trims keep keyed values: a key on the cut, keys re-timed, none past the end", () => {
  const p = project([clip({ in: 0, duration: 90, keys: [{ frame: 0, scale: 1 }, { frame: 89, scale: 1.89, x: 50 }] })]);
  const split = apply(p, { ops: [{ op: "split_item", item: "c", at: 45, newId: "c2" }] });
  const [a, b] = split.tracks.find((t) => t.role === "main")!.items;
  assert.deepEqual(a!.keys, [{ frame: 0, scale: 1 }, { frame: 45, scale: 1.45, x: 50 }]);
  assert.deepEqual(b!.keys, [{ frame: 0, scale: 1.45, x: 50 }, { frame: 44, scale: 1.89, x: 50 }]);
  const end = apply(p, { ops: [{ op: "trim_item", item: "c", edge: "end", frames: 30 }] });
  assert.deepEqual(mainClip(end).keys, [{ frame: 0, scale: 1 }, { frame: 60, scale: 1.6, x: 50 }]);
  const start = apply(p, { ops: [{ op: "trim_item", item: "c", edge: "start", frames: 10 }] });
  assert.deepEqual(mainClip(start).keys, [{ frame: 0, scale: 1.1, x: 50 }, { frame: 79, scale: 1.89, x: 50 }]);
});

test("an eased segment split or trimmed keeps its motion frame for frame; extending the start adds no key; keyed edits stay on the clip", () => {
  const kb = project([clip({ in: 0, duration: 100, keys: [{ frame: 0, scale: 1, ease: "inOut" }, { frame: 100, scale: 2 }] })]);
  const original = mainClip(kb).keys;
  const split = apply(kb, { ops: [{ op: "split_item", item: "c", at: 25, newId: "c2" }] });
  const [a, b] = split.tracks.find((t) => t.role === "main")!.items;
  for (const f of [10, 20, 40, 60, 80]) {
    const after = f < 25 ? keyAt(a!.keys, "scale", f)! : keyAt(b!.keys, "scale", f - 25)!;
    assert.ok(Math.abs(after - keyAt(original, "scale", f)!) < 1e-5, `split, frame ${f}: ${after} vs ${keyAt(original, "scale", f)}`);
  }
  const trimmed = mainClip(apply(kb, { ops: [{ op: "trim_item", item: "c", edge: "start", frames: 25 }] })).keys;
  for (const f of [40, 60, 80]) assert.ok(Math.abs(keyAt(trimmed, "scale", f - 25)! - keyAt(original, "scale", f)!) < 1e-5, `trim, frame ${f}`);
  // Extending the start only shifts the keys.
  const late = project([clip({ in: 100, duration: 100, keys: [{ frame: 10, scale: 1, ease: "inOut" }, { frame: 90, scale: 2 }] })]);
  assert.deepEqual(mainClip(apply(late, { ops: [{ op: "trim_item", item: "c", edge: "start", frames: -20 }] })).keys, [{ frame: 30, scale: 1, ease: "inOut" }, { frame: 110, scale: 2 }]);
  // A keyed edit with the playhead past the clip goes on its last frame, never past its end.
  const keyed = project([clip({ in: 0, duration: 90, keys: [{ frame: 0, scale: 1 }] })]);
  const plan = planClipBox(keyed, "c", { scale: 1.5 }, 300);
  assert.ok("ops" in plan);
  assert.deepEqual(mainClip(apply(keyed, plan)).keys, [{ frame: 0, scale: 1 }, { frame: 89, scale: 1.5 }]);
});
