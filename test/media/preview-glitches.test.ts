// Issue #55: the preview glitch counter (test/helpers/preview-glitches.ts) on made-up samples.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countGlitches, type GlitchLayer, type GlitchSample, type LayerSample } from "../helpers/preview-glitches.ts";

const FPS = 30;
const layers: Array<GlitchLayer> = [
  { id: "v1", kind: "video", track: 0, start: 0, duration: 300, in: 0, fx: true },
  { id: "v2", kind: "video", track: 2, start: 0, duration: 300, in: 30 },
  { id: "t1", kind: "text", track: 1, start: 0, duration: 300 },
];

/** Playing from frame 0 at 60 animation frames a second: every layer drawn, at the right time, presenting. */
function run(n: number, change?: (i: number, frame: number, l: Record<string, LayerSample>) => void, playing = true): Array<GlitchSample> {
  return Array.from({ length: n }, (_, i) => {
    const frame = playing ? Math.floor(i / 2) : 50;
    const l: Record<string, LayerSample> = {
      v1: { d: true, f: true, z: 3, mt: frame / FPS, p: i, s: false },
      v2: { d: true, z: 1, mt: (30 + frame) / FPS, p: i, s: false },
      t1: { d: true, z: 2 },
    };
    change?.(i, frame, l);
    return { t: i * 16.7, frame, playing, layers: l };
  });
}

test("a clean run counts nothing", () => {
  const c = countGlitches(run(400), layers, { fps: FPS });
  assert.deepEqual(
    { ...c, worstFrameMs: 0, details: [] },
    { flash: 0, late: 0, lookFlash: 0, stale: 0, frozen: 0, order: 0, longFrames: 0, worstFrameMs: 0, details: [] },
  );
});

test("a layer that blanks for a few frames is one flash; one that never shows is late", () => {
  const c = countGlitches(
    run(400, (i, _f, l) => {
      if (i >= 100 && i < 104) l.v2 = { ...l.v2!, d: false };
      if (i >= 200 && i < 203) l.v2 = { ...l.v2!, d: false };
      l.t1 = { d: false, z: 2 };
    }),
    layers,
    { fps: FPS },
  );
  assert.equal(c.flash, 2);
  assert.equal(c.late, 1);
});

test("effects lost after they showed is a look flash", () => {
  const c = countGlitches(
    run(300, (i, _f, l) => i >= 150 && i < 160 && (l.v1 = { ...l.v1!, f: false })),
    layers,
    { fps: FPS },
  );
  assert.equal(c.lookFlash, 1);
  assert.equal(c.flash, 0);
});

test("a video behind the playhead is stale, one that stops presenting is frozen", () => {
  const c = countGlitches(
    run(400, (i, frame, l) => {
      if (i >= 100 && i < 140) l.v2 = { ...l.v2!, mt: (30 + frame) / FPS - 0.5 };
      if (i >= 200) l.v1 = { ...l.v1!, p: 200 };
    }),
    layers,
    { fps: FPS },
  );
  assert.equal(c.stale, 1);
  assert.equal(c.frozen, 1);
});

test("layers stacked against their tracks count once per sample; long frames count", () => {
  const samples = run(100, (i, _f, l) => i >= 10 && i < 20 && (l.t1 = { d: true, z: 0 }));
  const late = samples.map((s, i) => (i >= 50 ? { ...s, t: s.t + 150 } : s));
  const c = countGlitches(late, layers, { fps: FPS });
  assert.equal(c.order, 10);
  assert.equal(c.longFrames, 1);
  assert.ok(c.worstFrameMs > 150);
});

test("paused, nothing is stale or frozen; the first moments of playback aren't judged", () => {
  assert.equal(
    countGlitches(
      run(200, (_i, _f, l) => (l.v2 = { ...l.v2!, mt: 0, p: 0 }), false),
      layers,
      { fps: FPS },
    ).stale,
    0,
  );
  const c = countGlitches(
    run(400, (i, frame, l) => i < 20 && (l.v2 = { ...l.v2!, mt: (30 + frame) / FPS - 1 })),
    layers,
    { fps: FPS },
  );
  assert.equal(c.stale, 0);
});
