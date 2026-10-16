// D291: motion blur's sub-frame timing (core motionBlur.ts) and how the export plan uses it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { itemMotionBlur, loadModules, MOTION_BLUR_DEFAULTS, motionBlurDefault, projectMotionBlur, subFrameTimes, validateProject, type Project } from "../../packages/core/src/index.ts";
import { planExport } from "../../apps/server/src/export/exportPlan.ts";
import { streamsLayer } from "../../apps/server/src/export/exporter/rasterise.ts";

const modules = await loadModules(join(import.meta.dirname, "../../spec/modules/builtin"));
const close = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]!) < 1e-12);

test("subFrameTimes: n sub-frames from the frame's own moment over shutter/360 of the frame interval", () => {
  // 4 sub-frames, 180°: 0, 1/8, 2/8, 3/8 of a frame after it.
  assert.ok(close(subFrameTimes(10, 60, { samples: 4, shutter: 180 }), [10 / 60, 10.125 / 60, 10.25 / 60, 10.375 / 60]));
  // 360°: spread over the whole interval, never reaching the next frame.
  assert.ok(close(subFrameTimes(0, 30, { samples: 2, shutter: 360 }), [0, 0.5 / 30]));
  // No blur, or one sample: the frame's moment alone.
  assert.deepEqual(subFrameTimes(7, 60), [7 / 60]);
  assert.deepEqual(subFrameTimes(7, 60, { samples: 1, shutter: 180 }), [7 / 60]);
  // A held frame stays sharp: its moment n times.
  assert.deepEqual(subFrameTimes(5, 60, { samples: 4, shutter: 180 }, true), [5 / 60, 5 / 60, 5 / 60, 5 / 60]);
  // The first sub-frame is the sharp frame.
  for (const f of [0, 1, 59, 1679]) assert.equal(subFrameTimes(f, 60, MOTION_BLUR_DEFAULTS)[0], f / 60);
});

test("motion blur settings: defaults by quality, the project's own, clamped, an item opting out", () => {
  assert.deepEqual(MOTION_BLUR_DEFAULTS, { samples: 4, shutter: 180 });
  assert.equal(motionBlurDefault({}, "draft"), false);
  assert.equal(motionBlurDefault({}, "standard"), true);
  assert.equal(motionBlurDefault({}, "high"), true);
  assert.equal(motionBlurDefault({ motionBlur: { on: false } }, "high"), false);
  assert.equal(motionBlurDefault({ motionBlur: { on: true } }, "draft"), true);
  assert.deepEqual(projectMotionBlur({}), { samples: 4, shutter: 180 });
  assert.deepEqual(projectMotionBlur({ motionBlur: { samples: 8, shutter: 90 } }), { samples: 8, shutter: 90 });
  assert.deepEqual(projectMotionBlur({ motionBlur: { samples: 99, shutter: 0 } }), { samples: 16, shutter: 1 });
  assert.equal(itemMotionBlur({}, {}, false), undefined);
  assert.deepEqual(itemMotionBlur({}, {}, true), { samples: 4, shutter: 180 });
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
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: 500, props: { color: "#000000" } }] },
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
  assert.ok(g.frames.every((f, i) => f === i), "every frame its own");
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
  const faded = { ...project(), tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: 500, props: { color: "#000000" } }, { id: "film2", type: "graphic", src: "graphics/film.html", duration: 100, transitionIn: { module: "transition.crossfade", duration: 20 } }] }] } as Project;
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
  const eight = planExport(project({ motionBlur: { samples: 8, shutter: 360 } }), { mediaPath: () => "", width: 320, height: 400, graphic: () => GRAPHIC, motionBlur: true });
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
  assert.deepEqual(validateProject(ok, modules).filter((p) => /motionBlur/.test(JSON.stringify(p))), []);
  const bad = project({ motionBlur: { samples: 1 } as Project["motionBlur"] });
  assert.ok(validateProject(bad, modules).some((p) => /motionBlur/.test(JSON.stringify(p))), "samples below 2 is refused");
});
