// D291: motion blur's sub-frame timing (core motionBlur.ts) and how the export plan uses it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  applyEdit,
  createSession,
  describeOp,
  itemMotionBlur,
  BLUR_REFINE,
  blurSignature,
  blurStep,
  blurFarPairs,
  blurMoving,
  blurLevels,
  blurRefinable,
  loadModules,
  validateOps,
  MOTION_BLUR_DEFAULTS,
  motionBlurDefault,
  projectMotionBlur,
  subFrameTimes,
  validateProject,
  type Project,
} from "../../packages/core/src/index.ts";
import { planExport } from "../../apps/server/src/export/exportPlan.ts";
import { streamsLayer } from "../../apps/server/src/export/exporter/rasterise.ts";

const modules = await loadModules(join(import.meta.dirname, "../../spec/modules/builtin"));
const close = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]!) < 1e-12);

test("subFrameTimes: n sub-frames from the frame's own moment over shutter/360 of the frame interval", () => {
  // 4 sub-frames, 180°: the middles of 4 slots of the half frame after it (D309).
  assert.ok(close(subFrameTimes(10, 60, { samples: 4, shutter: 180 }), [10.0625 / 60, 10.1875 / 60, 10.3125 / 60, 10.4375 / 60]));
  // 360°: spread over the whole interval, never reaching the next frame.
  assert.ok(close(subFrameTimes(0, 30, { samples: 2, shutter: 360 }), [0.25 / 30, 0.75 / 30]));
  // No blur, or one sample: the frame's moment alone.
  assert.deepEqual(subFrameTimes(7, 60), [7 / 60]);
  assert.deepEqual(subFrameTimes(7, 60, { samples: 1, shutter: 180 }), [7 / 60]);
  // A held frame stays sharp: its moment n times.
  assert.deepEqual(subFrameTimes(5, 60, { samples: 4, shutter: 180 }, true), [5 / 60, 5 / 60, 5 / 60, 5 / 60]);
  // The shutter opens at the frame's own moment: the first sub-frame half a slot after it (D309).
  for (const f of [0, 1, 59, 1679]) assert.ok(Math.abs(subFrameTimes(f, 60, MOTION_BLUR_DEFAULTS)[0]! - (f + 0.25 / 8) / 60) < 1e-12);
});

test("motion blur settings: defaults by quality, the project's own, clamped, an item opting out", () => {
  assert.deepEqual(MOTION_BLUR_DEFAULTS, { samples: 4, shutter: 90 });
  assert.equal(motionBlurDefault({}, "draft"), false);
  assert.equal(motionBlurDefault({}, "standard"), true);
  assert.equal(motionBlurDefault({}, "high"), true);
  assert.equal(motionBlurDefault({ motionBlur: { on: false } }, "high"), false);
  assert.equal(motionBlurDefault({ motionBlur: { on: true } }, "draft"), true);
  assert.deepEqual(projectMotionBlur({}), { samples: 4, shutter: 90 });
  assert.deepEqual(projectMotionBlur({ motionBlur: { samples: 8, shutter: 90 } }), { samples: 8, shutter: 90 });
  assert.deepEqual(projectMotionBlur({ motionBlur: { samples: 99, shutter: 0 } }), { samples: 16, shutter: 1 });
  assert.equal(itemMotionBlur({}, {}, false), undefined);
  assert.deepEqual(itemMotionBlur({}, {}, true), { samples: 4, shutter: 90 });
  assert.equal(itemMotionBlur({ motionBlur: false }, {}, true), undefined);
  // The export's switch is the last word: an item can't turn blur on in an export without it.
  assert.equal(itemMotionBlur({ motionBlur: true }, {}, false), undefined);
});

const GRAPHIC = `<script>window.render = (t) => {};</script>`;
const project = (extra: Partial<Project> = {}, item: Record<string, unknown> = {}): Project =>
  ({
    format: "uncut/0",
    name: "Blur",
    canvas: { width: 320, height: 400, fps: 60 },
    media: [],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [{ id: "bg", type: "component", component: "component.solid", duration: 500, props: { color: "#000000" } }],
      },
      { id: "g", kind: "video", name: "Graphics", items: [{ id: "film", type: "graphic", src: "graphics/film.html", start: 10, duration: 420, ...item }] },
    ],
    ...extra,
  }) as Project;

test("the plan: a graphic past 360 frames is drawn on every frame; with blur, each frame's sub-frames (held frames sharp)", () => {
  const sharp = planExport(project(), { mediaPath: () => "", width: 320, height: 400, graphic: () => GRAPHIC });
  assert.ok(!("problem" in sharp));
  const g = sharp.visuals.find((l) => l.item.id === "film")!;
  assert.ok(g.kind === "graphic");
  assert.equal(g.frames.length, 420);
  assert.ok(
    g.frames.every((f, i) => f === i),
    "every frame its own",
  );
  assert.equal(g.motion, undefined, "blur is off unless the export turns it on");
  assert.deepEqual(sharp.warnings, []);
  assert.ok(streamsLayer(g), "a changing graphic is streamed");

  const blurred = planExport(project(), { mediaPath: () => "", width: 320, height: 400, graphic: () => GRAPHIC, motionBlur: true });
  assert.ok(!("problem" in blurred));
  const b = blurred.visuals.find((l) => l.item.id === "film")!;
  assert.ok(b.kind === "graphic" && b.motion);
  assert.equal(b.motion.samples, 4);
  assert.equal(b.motion.ts.length, 420);
  assert.ok(close(b.motion.ts[100]!, subFrameTimes(100, 60, MOTION_BLUR_DEFAULTS)));

  // A crossfade into it from before its start: the frames before it hold frame 0, sharp.
  const faded = {
    ...project(),
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "bg", type: "component", component: "component.solid", duration: 500, props: { color: "#000000" } },
          { id: "film2", type: "graphic", src: "graphics/film.html", duration: 100, transitionIn: { module: "transition.crossfade", duration: 20 } },
        ],
      },
    ],
  } as Project;
  const fp = planExport(faded, { mediaPath: () => "", width: 320, height: 400, graphic: () => GRAPHIC, motionBlur: true });
  assert.ok(!("problem" in fp));
  const parts = fp.visuals.filter((l) => l.item.id === "film2");
  assert.ok(parts.length >= 1);
  const frames = parts.flatMap((l) => (l.kind === "graphic" ? l.frames : []));
  const ts = parts.flatMap((l) => (l.kind === "graphic" && l.motion ? l.motion.ts : []));
  assert.equal(ts.length, frames.length);
  // Frames before the item's start show frame 0 at one moment (no blur); from its start, spread.
  const startAt = frames.lastIndexOf(0);
  assert.ok(startAt > 0, "the crossfade shows it before its start");
  assert.deepEqual(ts[0], [0, 0, 0, 0]);
  assert.ok(close(ts[startAt]!, subFrameTimes(0, 60, MOTION_BLUR_DEFAULTS)));
  assert.ok(close(ts[startAt + 1]!, subFrameTimes(1, 60, MOTION_BLUR_DEFAULTS)));

  // The project's samples and shutter; an item opting out.
  const eight = planExport(project({ motionBlur: { samples: 8, shutter: 360 } }), {
    mediaPath: () => "",
    width: 320,
    height: 400,
    graphic: () => GRAPHIC,
    motionBlur: true,
  });
  assert.ok(!("problem" in eight));
  const e = eight.visuals.find((l) => l.item.id === "film")!;
  assert.ok(e.kind === "graphic" && e.motion?.samples === 8 && e.motion.shutter === 360);
  const out = planExport(project({}, { motionBlur: false }), { mediaPath: () => "", width: 320, height: 400, graphic: () => GRAPHIC, motionBlur: true });
  assert.ok(!("problem" in out));
  const o = out.visuals.find((l) => l.item.id === "film")!;
  assert.ok(o.kind === "graphic" && o.motion === undefined);
});

test("the project schema takes motionBlur on the project and on an item", () => {
  const ok = project({ motionBlur: { on: true, samples: 6, shutter: 270 } }, { motionBlur: false });
  assert.deepEqual(
    validateProject(ok, modules).filter((p) => /motionBlur/.test(JSON.stringify(p))),
    [],
  );
  const bad = project({ motionBlur: { samples: 1 } as Project["motionBlur"] });
  assert.ok(
    validateProject(bad, modules).some((p) => /motionBlur/.test(JSON.stringify(p))),
    "samples below 2 is refused",
  );
});

// A2: the motion-film skill says update_project {"motionBlur":{"samples":12}}; the edit schema refused it.
test("update_project takes motionBlur, merges it field by field and keeps the project's bounds", () => {
  const ops = [{ op: "update_project", set: { motionBlur: { samples: 12 } } }];
  assert.deepEqual(validateOps(ops), []);
  assert.ok(validateOps([{ op: "update_project", set: { motionBlur: { samples: 1 } } }]).length, "samples below 2");
  assert.ok(validateOps([{ op: "update_project", set: { motionBlur: { samples: 17 } } }]).length, "samples over 16");
  assert.ok(validateOps([{ op: "update_project", set: { motionBlur: { shutter: 400 } } }]).length, "shutter over 360");
  assert.ok(validateOps([{ op: "update_project", set: { motionBlur: { blur: 3 } } }]).length, "an unknown field");
  const start = createSession(project({ motionBlur: { on: true, shutter: 270 } }));
  const after = applyEdit(start, { actor: "agent", ops: ops as never }, (p) => validateProject(p, modules));
  assert.deepEqual(after.project.motionBlur, { on: true, shutter: 270, samples: 12 }, "on and shutter kept");
  assert.equal(projectMotionBlur(after.project).samples, 12);
  const cleared = applyEdit(after, { actor: "agent", ops: [{ op: "update_project", set: { motionBlur: { shutter: null } } }] as never });
  assert.deepEqual(cleared.project.motionBlur, { on: true, samples: 12 });
  assert.equal(applyEdit(cleared, { actor: "agent", ops: [{ op: "update_project", set: { motionBlur: null } }] as never }).project.motionBlur, undefined);
  assert.equal(describeOp(ops[0] as never, start.project), "Set motion blur: 12 samples");
});

// D309: adaptive sub-frames. Pictures are BGRA (premultiplied), opaque black with white shapes.
const picture = (w: number, h: number, draw: (x: number, y: number) => boolean) => {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = draw(x, y) ? 255 : 0;
      px.set([v, v, v, 255], (y * w + x) * 4);
    }
  return px;
};
const sigOf = (draw: (x: number, y: number) => boolean) => blurSignature(picture(320, 160, draw), 320, 160);
const bar = (left: number, width = 4) => sigOf((x) => x >= left && x < left + width);
/** A few lines of "text": 2 px strokes every 6 px in a 120 × 40 block. */
const text = (dx: number) => sigOf((x, y) => x >= 40 + dx && x < 160 + dx && y >= 40 && y < 80 && (x - dx) % 6 < 2);

test("D309 blurStep: the same picture or a few px move is near; a thin line or text jumping is far", () => {
  assert.equal(blurStep(bar(100), bar(100)), 0);
  assert.ok(blurStep(bar(100, 40), bar(103, 40)) < BLUR_REFINE.points, "a wide shape's edges sliding 3 px: explained");
  assert.ok(blurStep(text(0), text(1)) < BLUR_REFINE.points, "text snapping 1 px: explained");
  assert.ok(blurStep(bar(100), bar(125)) >= BLUR_REFINE.points, "a 4 px line 25 px on: far");
  assert.ok(blurStep(text(0), text(15)) >= BLUR_REFINE.points, "text 15 px on: far");
  assert.ok(blurStep(bar(100, 2), bar(112, 2)) >= BLUR_REFINE.points, "a 2 px line 12 px on: far");
});

test("D309 refinement: a move over every gap refines on, one jump (a pop) doesn't; every grid covers the same shutter", () => {
  const moving = [0, 25, 50, 75].map((d) => bar(100 + d));
  assert.equal(blurFarPairs(moving), 3);
  assert.ok(blurMoving(blurFarPairs(moving), 4));
  const pop = [bar(100), bar(100), bar(200), bar(200)];
  assert.equal(blurFarPairs(pop), 1);
  assert.ok(!blurMoving(1, 4) && !blurMoving(0, 4) && blurMoving(2, 4), "most gaps far, not one");
  assert.ok(!blurMoving(3, 8) && blurMoving(4, 8));
  const ts = subFrameTimes(10, 60, MOTION_BLUR_DEFAULTS);
  assert.ok(blurRefinable(ts));
  assert.ok(!blurRefinable(subFrameTimes(10, 60, MOTION_BLUR_DEFAULTS, true)), "a held frame isn't refined");
  assert.ok(!blurRefinable([0.1]));
  // Every grid is the middles of the same slots split finer: the same span and centre (the smear
  // doesn't grow or shift where refining starts), each in time order.
  const levels = blurLevels(ts);
  assert.deepEqual(
    levels.map((l) => l.length),
    [16, 32],
  );
  const open = MOTION_BLUR_DEFAULTS.shutter / 360 / 60;
  for (const grid of [ts, ...levels]) {
    const slot = open / grid.length;
    assert.ok(
      Math.abs(grid[0]! - slot / 2 - 10 / 60) < 1e-12 && Math.abs(grid.at(-1)! + slot / 2 - (10 / 60 + open)) < 1e-12,
      `${grid.length}: spans the open shutter`,
    );
    const centre = grid.reduce((a, t) => a + t, 0) / grid.length;
    assert.ok(Math.abs(centre - (10 / 60 + open / 2)) < 1e-12, `${grid.length}: centred on it`);
    assert.ok(
      grid.every((t, j) => j === 0 || t > grid[j - 1]!),
      "in time order",
    );
  }
  assert.deepEqual(
    blurLevels(subFrameTimes(0, 60, { samples: 16, shutter: 90 })).map((l) => l.length),
    [32],
  );
  assert.deepEqual(
    blurLevels(subFrameTimes(0, 60, { samples: 2, shutter: 90 })).map((l) => l.length),
    [8, 16, 32],
  );
  assert.deepEqual(blurLevels([0.5]), []);
});
