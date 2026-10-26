// D311: how well the preview keeps up with playback, from the glitch probe's samples
// (preview-glitches.ts), as numbers to compare engines with. Pure, unit-tested in
// test/media/playback-bench.test.ts. Per layer and sample while playing (inside the layer, past its
// edges and the first `settleMs`), the picture on screen (`pt`) against the source time the playhead
// asks for:
// - late: more than `tolerance` frames behind, or not drawn; ahead: more than `tolerance` + 1 frames
//   ahead (the playhead's frame is read whole, so a picture on time can be a frame past it);
// - frozen: the same picture held longer than `holdFrames` frame durations while the playhead moves;
//   the time past that is summed;
// - cut latency: from the playhead entering a layer until its first on-time sample;
// - dropped: source frames the visit should have shown that never appeared;
// - missing: time a layer wasn't drawn at all;
// - clock slip: how far the playhead fell behind the wall clock over the run (a clock re-anchored
//   to a late decoder plays slower than real time).
import type { GlitchLayer, GlitchSample } from "./preview-glitches.ts";

export interface BenchOptions {
  readonly fps: number;
  readonly tolerance?: number;
  readonly holdFrames?: number;
  readonly settleMs?: number;
  readonly edgeFrames?: number;
}

export interface BenchResult {
  /** Layer samples judged. */
  samples: number;
  late: number;
  latePct: number;
  ahead: number;
  frozenMs: number;
  cuts: number;
  cutMedianMs: number;
  cutP90Ms: number;
  cutMaxMs: number;
  /** Cuts whose first on-time picture came more than 100 ms after the playhead got there, and those never on time. */
  slowCuts: number;
  neverOnTime: number;
  dropped: number;
  expected: number;
  clockSlipMs: number;
  longFrames: number;
  /** Time a layer the playhead was inside wasn't drawn at all (ms, summed over layers). */
  missingMs: number;
}

const quantile = (values: ReadonlyArray<number>, q: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

interface Visit {
  readonly enteredAt: number;
  onTimeAt: number | undefined;
  readonly shown: Set<number>;
  firstFrame: number;
  lastFrame: number;
  held: { pt: number; since: number } | undefined;
}

export function benchPlayback(samples: ReadonlyArray<GlitchSample>, layers: ReadonlyArray<GlitchLayer>, options: BenchOptions): BenchResult {
  const { fps, tolerance = 1.5, holdFrames = 2.5, settleMs = 300, edgeFrames = 1 } = options;
  const playing = samples.filter((s) => s.playing);
  const result: BenchResult = {
    samples: 0,
    late: 0,
    latePct: 0,
    ahead: 0,
    frozenMs: 0,
    cuts: 0,
    cutMedianMs: 0,
    cutP90Ms: 0,
    cutMaxMs: 0,
    slowCuts: 0,
    neverOnTime: 0,
    dropped: 0,
    expected: 0,
    clockSlipMs: 0,
    longFrames: 0,
    missingMs: 0,
  };
  if (playing.length < 2) return result;
  const start = playing[0]!;
  const end = playing.at(-1)!;
  result.clockSlipMs = Math.max(0, end.t - start.t - ((end.frame - start.frame) / fps) * 1000);
  const latencies: Array<number> = [];
  const visits = new Map<string, Visit>();
  const closeVisit = (id: string) => {
    const v = visits.get(id);
    if (!v) return;
    visits.delete(id);
    if (v.onTimeAt !== undefined) latencies.push(v.onTimeAt - v.enteredAt);
    else latencies.push(Infinity);
    const expected = v.lastFrame - v.firstFrame + 1;
    let seen = 0;
    for (const f of v.shown) if (f >= v.firstFrame - 1 && f <= v.lastFrame + 2) seen++;
    result.expected += expected;
    result.dropped += Math.max(0, expected - seen);
  };
  let prev: GlitchSample | undefined;
  for (const s of playing) {
    if (prev && s.t - prev.t > 50) result.longFrames++;
    const settled = s.t - start.t >= settleMs;
    for (const l of layers) {
      if (l.kind !== "video") continue;
      const inside = s.frame >= l.start + edgeFrames && s.frame < l.start + l.duration - edgeFrames;
      if (!inside || !settled) {
        closeVisit(l.id);
        continue;
      }
      const want = ((l.in ?? 0) + (s.frame - l.start)) / fps;
      let v = visits.get(l.id);
      if (!v) {
        v = { enteredAt: s.t, onTimeAt: undefined, shown: new Set(), firstFrame: Math.round(want * fps), lastFrame: Math.round(want * fps), held: undefined };
        visits.set(l.id, v);
      }
      v.lastFrame = Math.round(want * fps);
      result.samples++;
      const ls = s.layers[l.id];
      if (!ls?.d && prev) result.missingMs += s.t - prev.t;
      const pt = ls?.d ? ls.pt : undefined;
      const behind = pt === undefined || pt < want - tolerance / fps;
      const ahead = pt !== undefined && pt > want + (tolerance + 1) / fps;
      if (behind) result.late++;
      if (ahead) result.ahead++;
      if (!behind && !ahead) v.onTimeAt ??= s.t;
      if (pt === undefined) continue;
      v.shown.add(Math.round(pt * fps));
      if (!v.held || Math.abs(v.held.pt - pt) > 0.25 / fps) {
        v.held = { pt, since: s.t };
        continue;
      }
      const limit = (holdFrames / fps) * 1000;
      const heldFor = s.t - v.held.since;
      const before = prev ? prev.t - v.held.since : 0;
      if (heldFor > limit) result.frozenMs += heldFor - Math.max(limit, before);
    }
    prev = s;
  }
  for (const id of [...visits.keys()]) closeVisit(id);
  const finite = latencies.filter((x) => Number.isFinite(x));
  result.cuts = latencies.length;
  result.cutMedianMs = quantile(finite, 0.5);
  result.cutP90Ms = quantile(latencies, 0.9);
  result.cutMaxMs = Math.max(0, ...finite);
  result.slowCuts = latencies.filter((x) => x > 100).length;
  result.neverOnTime = latencies.length - finite.length;
  result.latePct = result.samples ? (100 * result.late) / result.samples : 0;
  return result;
}

export const formatBench = (r: BenchResult) =>
  `late ${r.late}/${r.samples} (${r.latePct.toFixed(1)}%), ahead ${r.ahead}, frozen ${r.frozenMs.toFixed(0)} ms, cuts ${r.cuts} (latency median ${r.cutMedianMs.toFixed(0)} ms, p90 ${r.cutP90Ms.toFixed(0)} ms, max on time ${r.cutMaxMs.toFixed(0)} ms, ${r.slowCuts} over 100 ms, ${r.neverOnTime} never on time), dropped ${r.dropped}/${r.expected} frames, missing ${r.missingMs.toFixed(0)} ms, clock slip ${r.clockSlipMs.toFixed(0)} ms, rAF gaps > 50 ms ${r.longFrames}`;
