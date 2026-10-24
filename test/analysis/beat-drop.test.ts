// D296: beat_grid's drop by level. The beats analyzer keeps the low bands' level per beat
// (beatLevels); dropOf finds the beat where the kick and bass step up (2 bars after vs 2 before,
// a step not a ramp, loud) and the downbeats follow it. Synthetic sound at the analyzer's rate:
// a build (hats, a soft snare) that drops into kick + bass on a downbeat, an even track and an even
// build (no drop). And the rehearsal's real track (Electro Dreams, a 28 s cut with its drop at
// ~12.0 s) when it's on this machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { beatsFromSamples, isBeatsResult, SAMPLE_RATE } from "../../apps/server/src/analysis/beats.ts";
import { beatGrid, dropOf } from "../../apps/server/src/agent/agentPlan.ts";
import { noise } from "../helpers/beats-audio.ts";

const BPM = 120;
const BEAT = 60 / BPM;
const SECONDS = 28;
const OFFSET = 0.25;

/** A decaying sine (a kick: 55 Hz) or a noise burst (a hat or snare) added at t. */
function hit(buf: Float64Array, t: number, kind: "kick" | "hat" | "snare", gain: number, rnd: () => number) {
  const start = Math.round(t * SAMPLE_RATE);
  const len = Math.round((kind === "kick" ? 0.25 : kind === "snare" ? 0.12 : 0.03) * SAMPLE_RATE);
  let prev = 0;
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const env = Math.exp((-i / len) * 5);
    if (kind === "kick") buf[start + i]! += gain * env * Math.sin(2 * Math.PI * 55 * (i / SAMPLE_RATE));
    else {
      // A hat is high-passed noise (the difference of two samples); a snare plain noise.
      const n = rnd();
      buf[start + i]! += gain * env * (kind === "hat" ? n - prev : n);
      prev = n;
    }
  }
}

/** Beats at OFFSET + k·BEAT; `bar(k)` says what plays on beat k. */
function track(play: (k: number, t: number, buf: Float64Array, rnd: () => number) => void, seed = 3) {
  const rnd = noise(seed);
  const buf = new Float64Array(SECONDS * SAMPLE_RATE);
  for (let i = 0; i < buf.length; i++) buf[i] = 0.01 * rnd();
  for (let k = 0, t = OFFSET; t < SECONDS - 0.3; k++, t += BEAT) play(k, t, buf, rnd);
  return buf;
}

/** Sustained bass (45 Hz) from `from` to `to` s. */
function bass(buf: Float64Array, from: number, to: number, gain: number) {
  for (let i = Math.round(from * SAMPLE_RATE); i < Math.min(buf.length, to * SAMPLE_RATE); i++)
    buf[i]! += gain * Math.sin(2 * Math.PI * 45 * (i / SAMPLE_RATE));
}

const DROP_BEAT = 24; // 12.25 s, a downbeat (beat 0 is one).
const build = () => {
  const buf = track((k, t, b, rnd) => {
    hit(b, t, "hat", 0.3, rnd);
    hit(b, t + BEAT / 2, "hat", 0.2, rnd);
    if (k < DROP_BEAT) {
      if (k % 2 === 1) hit(b, t, "snare", 0.25, rnd);
      if (k % 4 === 0) hit(b, t, "kick", 0.15, rnd);
    } else {
      hit(b, t, "kick", 0.8, rnd);
      if (k % 2 === 1) hit(b, t, "snare", 0.35, rnd);
    }
  });
  bass(buf, OFFSET + DROP_BEAT * BEAT, SECONDS, 0.25);
  return buf;
};
const grid = (samples: Float64Array | Float32Array) => {
  const r = beatsFromSamples(samples);
  assert.ok(isBeatsResult(r) && r.bpm, JSON.stringify(r).slice(0, 200));
  return { r, g: beatGrid(r, { id: "music-1", media: "m", start: 0, in: 0, duration: SECONDS * 60, speed: 1 }, 60) };
};

test("a build that drops into kick and bass: the drop is that downbeat, and the downbeats follow it", () => {
  const { r, g } = grid(build());
  assert.equal(r.beatLevels?.length, r.beats?.length, "one level per beat");
  const at = OFFSET + DROP_BEAT * BEAT;
  assert.ok(g.drop, `a drop (levels ${r.beatLevels!.join(" ")})`);
  assert.ok(Math.abs(g.drop.frame - at * 60) <= 3, `drop at frame ${g.drop.frame}, want ~${Math.round(at * 60)}`);
  assert.ok(g.drop.rise >= 2, `rise ${g.drop.rise}`);
  assert.ok(g.downbeats.includes(g.drop.frame), "the drop is a downbeat");
});

test("an even track and an even build have no drop", () => {
  const even = track((k, t, b, rnd) => {
    hit(b, t, "kick", 0.6, rnd);
    hit(b, t, "hat", 0.3, rnd);
    if (k % 2 === 1) hit(b, t, "snare", 0.3, rnd);
  });
  bass(even, 0, SECONDS, 0.15);
  assert.equal(grid(even).g.drop, null, "even");
  // A crescendo: the kick and bass grow a little every bar, no step.
  const ramp = track((k, t, b, rnd) => {
    hit(b, t, "kick", 0.2 + (0.6 * t) / SECONDS, rnd);
    hit(b, t, "hat", 0.3, rnd);
    if (k % 2 === 1) hit(b, t, "snare", 0.3, rnd);
  });
  for (let s = 0; s < SECONDS; s += 2) bass(ramp, s, s + 2, 0.05 + (0.2 * s) / SECONDS);
  assert.equal(grid(ramp).g.drop, null, "even build");
});

test("dropOf by level: a step, not a ramp or a quiet rise; the onsets' rule without levels", () => {
  const beats = Array.from({ length: 32 }, (_, i) => 0.2 + i * 0.5);
  const flat = beats.map(() => ({ t: 0, strength: 0 }));
  const step = beats.map((_, i) => (i < 16 ? 0.2 : 0.9));
  assert.deepEqual(dropOf(beats, 1, flat, step), { seconds: 8.2, rise: 4.5, beat: 16 });
  assert.equal(
    dropOf(
      beats,
      0,
      flat,
      beats.map((_, i) => 0.1 + (0.9 * i) / 31),
    ),
    undefined,
    "a ramp",
  );
  assert.equal(
    dropOf(
      beats,
      0,
      flat,
      beats.map((_, i) => (i < 8 ? 1 : i < 16 ? 0.02 : 0.1)),
    ),
    undefined,
    "a quiet rise after a loud intro",
  );
  assert.equal(
    dropOf(
      beats,
      0,
      flat,
      beats.map((_, i) => (i === 20 ? 1 : 0.2)),
    ),
    undefined,
    "one loud beat isn't a drop",
  );
});

const electro =
  "/private/tmp/claude-501/-Users-blazejkustra-Documents-devrel/3831cfa3-e621-4363-bd93-bfd925d590db/scratchpad/music/cuts/2-electro-dreams_arulo_mixkit-190_cut28.mp3";
const ffmpeg = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
})();

test(
  "Electro Dreams (the launch film's 28 s cut): the drop at ~12.0 s",
  { skip: !ffmpeg ? "ffmpeg isn't installed" : !existsSync(electro) ? "the rehearsal's track isn't on this machine" : false },
  () => {
    const out = spawnSync(ffmpeg!, ["-v", "error", "-i", electro, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
    const samples = new Float32Array(out.stdout.buffer, out.stdout.byteOffset, out.stdout.length / 4);
    const { r, g } = grid(samples);
    assert.ok(Math.abs(r.bpm! - 120) < 1, `bpm ${r.bpm}`);
    assert.ok(g.drop, "a drop");
    assert.ok(Math.abs(g.drop.frame / 60 - 12.0) <= 0.1, `drop at ${(g.drop.frame / 60).toFixed(2)} s`);
    assert.ok(g.downbeats.includes(g.drop.frame));
  },
);
