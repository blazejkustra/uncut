// D328: vision results on clips in core: a clip's moment to its media's seconds (constant speed,
// a ramp, reversed), the stretch its results cover, matte frames, face boxes drawn between and
// held, the cutout's alpha (JS and ffmpeg forms), the reframe planner on synthetic subject tracks,
// and text behind subject.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyEdit,
  createSession,
  CUTOUT,
  FACE_BLUR,
  faceCoverage,
  faceList,
  faceMasks,
  facesAt,
  frameIndex,
  loadModules,
  matteAlpha,
  matteAlphaExpr,
  matteFrames,
  planEffect,
  planReframe,
  planTextBehindSubject,
  reframeGeometry,
  reframePath,
  REFRAME_DEAD_ZONE,
  reverseProblem,
  sourceAt,
  validateProject,
  visionProblem,
  visionRange,
  visionSeconds,
  clipBox,
  type FaceFrames,
  type Item,
  type Op,
  type Project,
} from "../../packages/core/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const modules = await loadModules(join(here, "../../spec/modules/builtin"));

const project = (items: Array<Item>, canvas: Project["canvas"] = { width: 640, height: 360, fps: 30 }, others: Project["tracks"] = []): Project => ({
  format: "uncut/0",
  name: "Vision",
  canvas,
  media: [{ id: "m", kind: "video", name: "talk.mp4", path: "/tmp/talk.mp4", probe: { frames: 900, fps: 30, width: 1920, height: 1080, hasAudio: true } }],
  tracks: [...others, { id: "main", kind: "video", role: "main", name: "Main", items }],
});
const clip = (over: Partial<Item> = {}): Item => ({ id: "c", type: "clip", media: "m", in: 60, duration: 90, ...over });
const edit = (p: Project, ops: ReadonlyArray<Op>) => applyEdit(createSession(p), { actor: "user", ops }).project;

// ---- time mapping ----

test("a clip's moment maps to its media's seconds through sourceAt: constant speed and a ramp", () => {
  const p = project([clip()]);
  assert.equal(visionSeconds(p, clip(), 0), 2);
  assert.equal(visionSeconds(p, clip(), 15), 2.5);
  const fast = clip({ speed: 2 });
  assert.equal(visionSeconds(project([fast]), fast, 15), 3);
  const ramped = clip({ speedKeys: [{ frame: 0, speed: 3, ease: "inOut" }, { frame: 45, speed: 0.3 }, { frame: 90, speed: 3 }] });
  const rp = project([ramped]);
  for (const f of [0, 7, 30, 44, 60, 89]) assert.equal(visionSeconds(rp, ramped, f), sourceAt(rp, ramped, f), `frame ${f}`);
});

test("a reversed clip maps to the forward media's frame its copy shows", () => {
  const rev = clip({ reverse: true, in: 0 });
  const p = project([rev]);
  // Virtual frame 0 of a 900-frame media reversed is its last frame.
  assert.equal(visionSeconds(p, rev, 0), 899 / 30);
  assert.equal(visionSeconds(p, rev, 30), 869 / 30);
});

test("the results cover the clip's stretch plus transition handles, in 2 s steps, inside the media", () => {
  const p = project([clip()]);
  assert.deepEqual(visionRange(p, clip()), { start: 2, end: 6 });
  const a = clip({ id: "a", in: 0, duration: 60 });
  const b = clip({ id: "b", in: 100, duration: 60, transitionIn: { module: "transition.crossfade", duration: 20 } });
  const both = project([a, b]);
  // b's first 10 frames play before its start: media seconds from 3 (100 - 10 frames), rounded down to 2.
  assert.deepEqual(visionRange(both, b), { start: 2, end: 6 });
  assert.deepEqual(visionRange(both, a), { start: 0, end: 4 });
  const end = clip({ in: 880, duration: 20 });
  assert.equal(visionRange(project([end]), end)!.end, 30);
  const loop = clip({ loop: true, duration: 1200 });
  assert.deepEqual(visionRange(project([loop]), loop), { start: 0, end: 30 });
});

test("matte frames: the frame showing at each moment, also for irregular frame times", () => {
  const times = [2, 2.04, 2.07, 2.1, 2.2, 2.21];
  assert.equal(frameIndex(times, 1.5), 0);
  assert.equal(frameIndex(times, 2.0999), 3);
  assert.equal(frameIndex(times, 2.15), 3);
  assert.equal(frameIndex(times, 9), 5);
  const p = project([clip()]);
  assert.deepEqual(matteFrames(p, clip(), times, 0, 4), [0, 0, 1, 3]);
});

test("vision refuses what it can't do, with a sentence", () => {
  assert.match(visionProblem(project([clip({ reverse: true })]), clip({ reverse: true }), "matte")!, /backwards/);
  assert.match(visionProblem(project([clip({ loop: true })]), clip({ loop: true }), "matte")!, /looped/);
  assert.equal(visionProblem(project([clip({ reverse: true })]), clip({ reverse: true }), "faces"), undefined);
  const cut = clip({ effects: [{ module: CUTOUT, params: { mode: "person" } }] });
  assert.match(reverseProblem(project([cut]), cut)!, /background removed/);
  assert.match((planEffect(project([clip({ reverse: true })]), "c", CUTOUT) as { problem: string }).problem, /backwards/);
  assert.ok("ops" in planEffect(project([clip()]), "c", FACE_BLUR));
});

test("the effects' manifests take their params, and face picks are kept", () => {
  const p = edit(project([clip()]), (planEffect(project([clip()]), "c", FACE_BLUR) as { ops: ReadonlyArray<Op> }).ops);
  const picked = planEffect(p, "c", FACE_BLUR, { faces: [3, 1] }) as { ops: ReadonlyArray<Op>; summary: string };
  const q = edit(p, picked.ops);
  const fx = q.tracks[0]!.items[0]!.effects![0]!;
  assert.deepEqual((fx.params as { faces: Array<number> }).faces, [3, 1]);
  assert.deepEqual(validateProject(edit(q, (planEffect(q, "c", CUTOUT) as { ops: ReadonlyArray<Op> }).ops), modules), []);
});

// ---- cutout ----

test("matteAlpha: softness 1 keeps the matte, a crisper edge sits half way, shrink moves it in; the lut is the same sum", () => {
  const raw = { mode: "person" as const, softness: 1, shrink: 0 };
  for (const m of [0, 0.25, 0.5, 0.9, 1]) assert.ok(Math.abs(matteAlpha(raw, m) - m) < 1e-12);
  const crisp = { mode: "person" as const, softness: 0.2, shrink: 0 };
  assert.equal(matteAlpha(crisp, 0.5), 0.5);
  assert.equal(matteAlpha(crisp, 0.35), 0);
  assert.equal(matteAlpha(crisp, 0.65), 1);
  const shrunk = { mode: "person" as const, softness: 0.2, shrink: 1 };
  assert.equal(matteAlpha(shrunk, 0.8), 0);
  for (const c of [raw, crisp, shrunk])
    for (let v = 0; v <= 255; v += 17) {
      const run = new Function("val", "clip", `return ${matteAlphaExpr(c)};`) as (val: number, clip: (x: number, lo: number, hi: number) => number) => number;
      const got = run(v, (x, lo, hi) => Math.min(hi, Math.max(lo, x)));
      assert.ok(Math.abs(got - 255 * matteAlpha(c, v / 255)) < 1e-6, `${JSON.stringify(c)} at ${v}`);
    }
});

// ---- faces ----

const track = (frames: number, gap: ReadonlyArray<number> = [], fps = 30): FaceFrames => ({
  frames: Array.from({ length: frames }, (_, i) => ({ t: i / fps, faces: gap.includes(i) ? [] : [{ id: 7, x: 0.1 + i * 0.01, y: 0.2, w: 0.2, h: 0.3 }] })),
});

test("faces: a box on its frame, drawn between neighbours across a short miss, held briefly after the last", () => {
  const f = track(30, [10, 11, 12]);
  assert.ok(Math.abs(facesAt(f, 5 / 30)[0]!.x - 0.15) < 1e-9);
  const between = facesAt(f, 11 / 30)[0]!;
  assert.ok(Math.abs(between.x - 0.21) < 1e-9, `interpolated x ${between.x}`);
  const ended = track(30, Array.from({ length: 20 }, (_, i) => i + 10));
  assert.ok(Math.abs(facesAt(ended, 12 / 30)[0]!.x - 0.19) < 1e-9, "held at its last box");
  assert.equal(facesAt(ended, 20 / 30).length, 0, "gone after the hold");
  const long = track(60, Array.from({ length: 20 }, (_, i) => i + 10));
  assert.equal(facesAt(long, 25 / 30).length, 0, "a miss longer than the gap isn't bridged");
});

test("faces: only the picked ids, the list of faces seen, and their masks with padding and coverage", () => {
  const two: FaceFrames = {
    frames: [
      { t: 0, faces: [{ id: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, { id: 2, x: 0.6, y: 0.1, w: 0.2, h: 0.2 }] },
      { t: 1 / 30, faces: [{ id: 2, x: 0.6, y: 0.1, w: 0.2, h: 0.2 }] },
    ],
  };
  assert.deepEqual(facesAt(two, 0, [2]).map((f) => f.id), [2]);
  assert.deepEqual(faceList(two).map((f) => f.id), [1, 2]);
  const blur = { amount: 10, shape: "rectangle" as const, feather: 0, padding: 0.5 };
  const [m] = faceMasks([{ id: 1, x: 0.25, y: 0.25, w: 0.5, h: 0.5 }], blur, 100, 100);
  assert.deepEqual([m!.x, m!.y, m!.w, m!.h], [0, 0, 100, 100]);
  const masks = faceMasks(facesAt(two, 0), { ...blur, padding: 0 }, 100, 100);
  assert.equal(faceCoverage(masks, 20, 20), 1);
  assert.equal(faceCoverage(masks, 70, 20), 1);
  assert.equal(faceCoverage(masks, 50, 50), 0);
});

// ---- reframe ----

const reframeOpts = { fps: 30, window: 0.32, min: 0.16, max: 0.84 };

test("reframe path: a still subject with jitter gives one key", () => {
  const jitter = Array.from({ length: 300 }, (_, i) => 0.5 + 0.02 * Math.sin(i * 1.7) + 0.01 * Math.cos(i * 4.1));
  const keys = reframePath(jitter, reframeOpts)!;
  assert.equal(keys.length, 1);
  assert.ok(Math.abs(keys[0]!.centre - 0.5) < 0.01);
});

test("reframe path: a subject that walks across moves the camera in few eased moves, inside the picture", () => {
  const walk = Array.from({ length: 300 }, (_, i) => 0.1 + (0.8 * i) / 299);
  const keys = reframePath(walk, reframeOpts)!;
  assert.ok(keys.length >= 3 && keys.length <= 5, `${keys.length} keys`);
  for (const k of keys) assert.ok(k.centre >= reframeOpts.min - 1e-9 && k.centre <= reframeOpts.max + 1e-9, `centre ${k.centre}`);
  assert.equal(keys[0]!.centre, reframeOpts.min, "starts at the left edge it can reach");
  assert.ok(keys.at(-1)!.centre > 0.75);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i]!.frame > keys[i - 1]!.frame);
  assert.ok(keys.some((k) => k.ease === "inOut"));
});

test("reframe path: a step past the dead zone moves once; inside it, not at all; gaps hold the last place", () => {
  const step = Array.from({ length: 200 }, (_, i) => (i < 100 ? 0.4 : 0.65));
  const moved = reframePath(step, reframeOpts)!;
  assert.equal(moved.length, 3, JSON.stringify(moved));
  const small = Array.from({ length: 200 }, (_, i) => (i < 100 ? 0.5 : 0.5 + REFRAME_DEAD_ZONE * reframeOpts.window * 0.8));
  assert.equal(reframePath(small, reframeOpts)!.length, 1);
  const holes = Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? 0.5 : undefined));
  assert.equal(reframePath(holes, reframeOpts)!.length, 1);
  assert.equal(reframePath(Array(50).fill(undefined), reframeOpts), undefined);
});

test("auto reframe: 16:9 footage on a 9:16 canvas fills it at cover size and follows the face, one edit", () => {
  const canvas: Project["canvas"] = { width: 1080, height: 1920, fps: 30 };
  const g = reframeGeometry(canvas, { width: 1920, height: 1080 })!;
  assert.equal(g.axis, "x");
  assert.ok(Math.abs(g.window - 1080 / g.w) < 1e-9);
  const p = project([clip({ transform: { opacity: 0.9 }, keys: [{ frame: 0, opacity: 1 }] })], canvas);
  // The face is at the left, then walks right after the first second.
  const plan = planReframe(p, "c", (s) => ({ x: s < 3 ? 0.15 : 0.7, y: 0.3, w: 0.1, h: 0.2 })) as { ops: ReadonlyArray<Op>; summary: string };
  assert.ok("ops" in plan, JSON.stringify(plan));
  assert.equal(plan.ops.length, 1);
  const after = edit(p, plan.ops);
  const item = after.tracks[0]!.items[0]!;
  assert.equal(item.transform!.fit, "cover");
  assert.equal(item.transform!.opacity, 0.9, "other transform fields stay");
  assert.ok(item.keys!.some((k) => k.opacity === 1), "other keys stay");
  for (let f = 0; f < item.duration; f += 5) {
    const box = clipBox(item, canvas, { width: 1920, height: 1080 }, f);
    assert.ok(box.content.x <= 1e-6 && box.content.x + box.content.w >= canvas.width - 1e-6, `frame ${f}: the picture covers the canvas`);
  }
  const x = (f: number) => clipBox(item, canvas, { width: 1920, height: 1080 }, f);
  const faceAt = (f: number, u: number) => x(f).content.x + u * x(f).content.w;
  assert.ok(Math.abs(faceAt(0, 0.2) - 540) < 320, "the face starts near the middle");
  assert.ok(Math.abs(faceAt(89, 0.75) - 540) < 200, "and is near the middle at the end");
  assert.match(plan.summary, /Reframe talk\.mp4/);
  assert.match((planReframe(p, "c", () => undefined) as { problem: string }).problem, /nothing to follow/);
  assert.match((planReframe(project([clip()], { width: 1920, height: 1080, fps: 30 }), "c", () => ({ x: 0, y: 0, w: 1, h: 1 })) as { problem: string }).problem, /already has the canvas's shape/);
});

// ---- text behind subject ----

test("text behind subject: the clip under the text copied above it with its background removed, silent, one edit", () => {
  const text: Item = { id: "title", type: "text", text: "HELLO", start: 10, duration: 40 };
  const p = project([clip()], undefined, [{ id: "text", kind: "text", name: "Text", items: [text] }]);
  const plan = planTextBehindSubject(p, ["title"]);
  assert.ok("ops" in plan, JSON.stringify(plan));
  const after = edit(p, plan.ops);
  assert.equal(after.tracks[0]!.kind, "video");
  assert.equal(after.tracks[1]!.id, "text", "the copy's track is above the text's");
  const copy = after.tracks[0]!.items[0]!;
  assert.equal(copy.mute, true);
  assert.equal(copy.start, 0);
  assert.equal(copy.in, 60);
  assert.deepEqual(copy.effects!.map((e) => e.module), [CUTOUT]);
  assert.deepEqual(validateProject(after, modules), []);
  const alone = project([], undefined, [{ id: "text", kind: "text", name: "Text", items: [text] }]);
  assert.match((planTextBehindSubject(alone, ["title"]) as { problem: string }).problem, /no video clip under/);
  assert.match((planTextBehindSubject(p, ["c"]) as { problem: string }).problem, /text items/);
});
