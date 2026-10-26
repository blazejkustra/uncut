// D311: the fast-cut benchmark's scoring (test/helpers/playback-bench.ts) on made-up samples: a
// layer on time scores clean, a held picture counts as frozen time and dropped frames, a cut whose
// picture comes late counts its latency, and a playhead slower than the wall clock is clock slip.
import { test } from "node:test";
import assert from "node:assert/strict";

import { benchPlayback } from "../helpers/playback-bench.ts";
import type { GlitchLayer, GlitchSample } from "../helpers/preview-glitches.ts";

const FPS = 30;
const layers: Array<GlitchLayer> = [
  { id: "a", kind: "video", track: 0, start: 0, duration: 30, in: 0 },
  { id: "b", kind: "video", track: 0, start: 30, duration: 30, in: 90 },
];

/** Samples at 60 Hz over frames [0, 60), the picture of each layer from `shown` (source s, or undefined for none). */
function run(shown: (id: string, frame: number, t: number) => number | undefined, slowdown = 1): Array<GlitchSample> {
  const out: Array<GlitchSample> = [];
  for (let i = 0; i < 120; i++) {
    const t = 1000 + (i * 1000) / 60;
    const frame = Math.floor(i / 2 / slowdown);
    const sample: Record<string, { d: boolean; z: number; pt?: number }> = {};
    for (const l of layers) {
      if (frame < l.start || frame >= l.start + l.duration) continue;
      const pt = shown(l.id, frame, t);
      sample[l.id] = pt === undefined ? { d: false, z: 1 } : { d: true, z: 1, pt };
    }
    out.push({ t, frame, playing: true, layers: sample });
  }
  return out;
}

const onTime = (id: string, frame: number) => {
  const l = layers.find((x) => x.id === id)!;
  return (l.in! + frame - l.start) / FPS;
};

test("D311: a layer on time scores clean", () => {
  const r = benchPlayback(run(onTime), layers, { fps: FPS, settleMs: 0 });
  assert.equal(r.late, 0);
  assert.equal(r.frozenMs, 0);
  assert.equal(r.dropped, 0);
  assert.equal(r.neverOnTime, 0);
  assert.equal(r.cutMaxMs, 0);
  assert.ok(r.clockSlipMs < 20, `slip ${r.clockSlipMs}`);
});

test("D311: a picture held for 10 frames is frozen time, and its frames are dropped", () => {
  const r = benchPlayback(
    run((id, frame) => (id === "a" && frame >= 10 && frame < 20 ? onTime("a", 10) : onTime(id, frame))),
    layers,
    { fps: FPS, settleMs: 0 },
  );
  assert.ok(r.frozenMs > 200 && r.frozenMs < 300, `frozen ${r.frozenMs}`);
  assert.ok(r.dropped >= 8 && r.dropped <= 10, `dropped ${r.dropped}`);
  assert.ok(r.late > 0);
});

test("D311: a cut whose picture comes 200 ms late counts its latency; one never on time is counted apart", () => {
  const late = benchPlayback(
    run((id, frame, t) => (id === "b" && t < 1000 + 1200 ? undefined : onTime(id, frame))),
    layers,
    { fps: FPS, settleMs: 0 },
  );
  assert.equal(late.cuts, 2);
  assert.ok(late.cutMaxMs > 150 && late.cutMaxMs < 220, `latency ${late.cutMaxMs}`);
  assert.equal(late.slowCuts, 1);
  const never = benchPlayback(
    run((id, frame) => (id === "b" ? undefined : onTime(id, frame))),
    layers,
    { fps: FPS, settleMs: 0 },
  );
  assert.equal(never.neverOnTime, 1);
});

test("D311: a playhead at half speed slips behind the wall clock", () => {
  const r = benchPlayback(run(onTime, 2), layers, { fps: FPS, settleMs: 0 });
  assert.ok(r.clockSlipMs > 900, `slip ${r.clockSlipMs}`);
});
