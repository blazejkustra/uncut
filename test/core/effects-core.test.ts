// Phase 6 chunk 7 (D84–D88) without the app: the effect manifests and their params, the stages an
// effect stands for (EQ bands, the voice chain, bypass, noise removal export-only), the cookbook
// curves at known points, the ducking curve from a synthetic envelope (attack / release timing,
// the amount, mapping through cuts and in points, no speech = no duck, muted or missing keys), the
// master limiter's default, the loudness target mapping, the Mixer's planners (their edits pass the
// validator) and the words History and the agent get.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyEdit,
  biquadResponseDb,
  BUTTERWORTH_Q,
  choiceOfTarget,
  createSession,
  dbToGain,
  describeOp,
  duckCurve,
  duckDbAt,
  duckKeysIn,
  duckMediaIds,
  duckNote,
  effectStages,
  itemGain,
  loadModules,
  masterLimiter,
  noiseFloorDb,
  projectTargetLufs,
  targetOfChoice,
  trackStages,
  trackNoiseFloorDb,
  validateModule,
  validateProject,
  VOICE_PRESET,
  voiceStages,
  type Item,
  type Op,
  type Project,
  type SpeechEnvelope,
  type Track,
} from "../../packages/core/src/index.ts";
import { planExport } from "../../apps/server/src/export/exportPlan.ts";
import {
  planAddEffect,
  planBypassEffect,
  planDuck,
  planEffectParams,
  planLoudnessTarget,
  planMasterLimiter,
  planMoveEffect,
  planRemoveEffect,
  planVoicePreset,
} from "../../apps/web/src/audio/sound.ts";

const modules = await loadModules("spec/modules/builtin");
const FPS = 30;
const near = (a: number, b: number, eps: number, what = "") => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} ≉ ${b}`);

const project = (voice: Partial<Track> = {}, music: Partial<Track> = {}, voiceItems?: Array<Item>, master?: Project["master"]): Project => ({
  format: "uncut/0",
  name: "Fx",
  canvas: { width: 1920, height: 1080, fps: FPS },
  media: [
    { id: "m-voice", kind: "audio", name: "voice.wav", path: "/voice.wav", probe: { frames: 300 } },
    { id: "m-song", kind: "audio", name: "song.wav", path: "/song.wav", probe: { frames: 600 } },
  ],
  tracks: [
    { id: "main", kind: "video", role: "main", name: "Main", items: [] },
    {
      id: "voice",
      kind: "audio",
      name: "Voice",
      ...voice,
      items: voiceItems ?? [{ id: "v", type: "audio", media: "m-voice", in: 0, start: 0, duration: 300 }],
    },
    { id: "music", kind: "audio", name: "Music", ...music, items: [{ id: "s", type: "audio", media: "m-song", in: 0, start: 0, duration: 450 }] },
  ],
  ...(master ? { master } : {}),
});
const track = (p: Project, id: string) => p.tracks.find((t) => t.id === id)!;
function apply(p: Project, plan: { ops: ReadonlyArray<unknown> } | { problem: string }) {
  assert.ok("ops" in plan, `planned: ${"problem" in plan ? plan.problem : ""}`);
  const next = applyEdit(createSession(p), { actor: "user", ops: plan.ops as ReadonlyArray<Op> }).project;
  assert.deepEqual(validateProject(next, modules), []);
  return next;
}
/** A 10 s envelope (100 windows a second): speech (−20 dBFS) in the given second ranges, −70 elsewhere. */
const envelope = (speech: Array<[number, number]>, seconds = 10): SpeechEnvelope => {
  const db = new Float32Array(seconds * 100).fill(-70);
  for (const [a, b] of speech) for (let k = Math.round(a * 100); k < Math.round(b * 100); k++) db[k] = -20;
  return { rate: 100, db };
};
const duck = (params: Record<string, unknown> = {}) => ({ mixer: { effects: [{ module: "audio.duck", params: { under: ["voice"], ...params } }] } });
const secs = (keys: ReadonlyArray<{ frame: number; db: number }>) => keys.map((k) => [Math.round((k.frame / FPS) * 1000) / 1000, k.db]);

test("manifests: the six audio processors validate, their params check projects (ranges, unknown keys, duck targets)", () => {
  for (const id of ["audio.eq", "audio.compressor", "audio.duck", "audio.limiter", "audio.denoise", "audio.voice-enhance"]) {
    const m = modules.get(id)!;
    assert.equal(m.kind, "audio-processor", id);
    assert.deepEqual(validateModule(m), [], id);
    assert.ok(typeof m.description === "string" && m.description.length > 20, `${id} describes itself`);
  }
  const good = project(
    { mixer: { effects: [...VOICE_PRESET, { module: "audio.denoise", params: { amount: 0.4 } }, { module: "audio.voice-enhance", params: { amount: 1 } }] } },
    duck({ amountDb: -15, attackMs: 100, releaseMs: 900, thresholdDb: -40 }),
    undefined,
    { loudness: { targetLufs: -23 }, effects: [{ module: "audio.limiter", params: { ceilingDb: -2 } }] },
  );
  assert.deepEqual(validateProject(good, modules), []);
  const bad = (t: Partial<Track>) =>
    validateProject(project(t), modules)
      .map((p) => p.message)
      .join(" | ");
  // New params have ranges; params that existed before v0.2 keep their old (loose) schema and are clamped at use.
  assert.match(bad({ mixer: { effects: [{ module: "audio.compressor", params: { releaseMs: 1500 } }] } }), /audio\.compressor: must be <= 1000/);
  assert.match(bad({ mixer: { effects: [{ module: "audio.compressor", params: { attackMs: 0 } }] } }), /audio\.compressor: must be >= 1/);
  assert.match(bad({ mixer: { effects: [{ module: "audio.eq", params: { lowGainDb: 30 } }] } }), /audio\.eq: must be <= 24/);
  assert.match(bad({ mixer: { effects: [{ module: "audio.eq", params: { nope: 1 } }] } }), /must NOT have additional properties: nope/);
  assert.match(
    bad({ mixer: { effects: [{ module: "audio.duck", params: { under: ["nope"] } }] } }),
    /track "Voice" \(voice\) ducks under track "nope", which doesn't exist: remove or retarget its audio\.duck entry/,
  );
  assert.match(bad({ mixer: { effects: [{ module: "audio.duck", params: { under: ["music"], amountDb: 3 } }] } }), /audio\.duck: must be <= 0/);
  // Projects from before v0.2 open: old EQ bands, any cut frequency, an unbounded ratio and threshold, a
  // limiter under −12, a duck deeper than −40 or under nothing. Each is clamped where it's used.
  const old = project(
    {
      mixer: {
        effects: [
          { module: "audio.eq", params: { lowCutHz: 5, highCutHz: 40000, bands: [{ f: 1000, g: 3 }] } },
          { module: "audio.compressor", params: { ratio: 30, thresholdDb: -80 } },
        ],
      },
    },
    { mixer: { effects: [{ module: "audio.duck", params: { under: [], amountDb: -60 } }] } },
    undefined,
    { effects: [{ module: "audio.limiter", params: { ceilingDb: -20 } }] },
  );
  assert.deepEqual(validateProject(old, modules), []);
  assert.deepEqual(
    trackStages(track(old, "voice")).map((st) => (st.kind === "biquad" ? [st.type, st.freq] : st.kind === "compressor" ? [st.ratio, st.thresholdDb] : [])),
    [
      ["highpass", 20],
      ["lowpass", 20000],
      [20, -60],
    ],
  );
  assert.deepEqual(masterLimiter(old), { ceilingDb: -12 });
  assert.deepEqual(duckCurve(old, track(old, "music"), new Map())!.keys, [], "a duck under nothing ducks nothing");
  // The spec's example projects (they used EQ, ducking, voice, compressor and the limiter before D84) still validate.
  for (const name of ["close-the-loop", "drone-weekend"]) {
    const example = JSON.parse(readFileSync(`spec/examples/${name}.uncut/project.json`, "utf8"));
    // Only plugin modules that aren't installed here (argent.capture) may be reported; nothing about the mix.
    assert.deepEqual(
      validateProject(example, modules).filter((p) => /mixer|master|effects/.test(p.path) || p.code === "params"),
      [],
      name,
    );
  }
});

test("stages: EQ bands (a 0 dB band is none), the voice chain = the voice preset at 0.5, bypass = nothing, noise removal with its track's floor", () => {
  assert.deepEqual(effectStages({ module: "audio.eq" }), []);
  assert.deepEqual(effectStages({ module: "audio.eq", params: { lowCutHz: 80, midGainDb: 3 } }), [
    { kind: "biquad", type: "highpass", freq: 80, q: BUTTERWORTH_Q, gainDb: 0 },
    { kind: "biquad", type: "peaking", freq: 1000, q: 1, gainDb: 3 },
  ]);
  assert.deepEqual(effectStages({ module: "audio.eq", params: { lowCutHz: 80 }, bypass: true }), []);
  assert.deepEqual(VOICE_PRESET.flatMap(effectStages), voiceStages(0.5));
  assert.deepEqual(effectStages({ module: "audio.voice-enhance" }), voiceStages(0.5));
  assert.deepEqual(effectStages({ module: "audio.duck", params: { under: ["voice"] } }), []);
  assert.deepEqual(effectStages({ module: "audio.limiter" }), [], "a limiter on a track does nothing (the master's)");
  const t: Track = { id: "t", kind: "audio", name: "T", mixer: { effects: [{ module: "audio.denoise" }, { module: "audio.compressor" }] }, items: [] };
  assert.deepEqual(
    trackStages(t).map((s) => s.kind),
    ["denoise", "compressor"],
  );
  // With envelopes (the preview and the export alike, D246): the track's measured floor, the quietest of its media's.
  const tm: Track = {
    ...t,
    items: [
      { id: "a", type: "audio", media: "m1", in: 0, start: 0, duration: 30 },
      { id: "b", type: "audio", media: "m2", in: 0, start: 30, duration: 30 },
    ],
  };
  const media = [
    { id: "m1", kind: "audio", name: "1", path: "/1" },
    { id: "m2", kind: "audio", name: "2", path: "/2" },
  ] as unknown as Project["media"];
  assert.equal(trackNoiseFloorDb({ media }, tm, new Map()), -40);
  assert.equal(trackNoiseFloorDb({ media }, tm, new Map([["m1", envelope([[0, 5]])]])), -64);
  assert.deepEqual(
    trackStages(
      tm,
      { media },
      new Map([
        ["m1", envelope([[0, 5]])],
        ["m2", null],
      ]),
    )[0],
    { kind: "denoise", amount: 0.5, floorDb: -64 },
  );
  // The noise floor from an envelope: its quiet windows (+6 dB for the 16 kHz decode).
  near(noiseFloorDb(envelope([[0, 5]])), -64, 1e-9, "floor");
});

test("cookbook curves at known points: a Butterworth high-pass is −3.01 dB at its corner, a peak is its gain at its centre, shelves reach their gain", () => {
  near(biquadResponseDb({ kind: "biquad", type: "highpass", freq: 100, q: BUTTERWORTH_Q, gainDb: 0 }, 48000, 100), -3.0103, 0.01, "HP corner");
  near(biquadResponseDb({ kind: "biquad", type: "highpass", freq: 100, q: BUTTERWORTH_Q, gainDb: 0 }, 48000, 2000), 0, 0.01, "HP pass band");
  near(biquadResponseDb({ kind: "biquad", type: "lowpass", freq: 5000, q: BUTTERWORTH_Q, gainDb: 0 }, 48000, 5000), -3.0103, 0.01, "LP corner");
  near(biquadResponseDb({ kind: "biquad", type: "peaking", freq: 1000, q: 1.4, gainDb: -8 }, 48000, 1000), -8, 1e-6, "peak centre");
  near(biquadResponseDb({ kind: "biquad", type: "peaking", freq: 1000, q: 1.4, gainDb: -8 }, 48000, 20000), 0, 0.2, "peak far away");
  near(biquadResponseDb({ kind: "biquad", type: "lowshelf", freq: 200, q: 1, gainDb: 6 }, 48000, 10), 6, 0.05, "low shelf at DC");
  near(biquadResponseDb({ kind: "biquad", type: "lowshelf", freq: 200, q: 1, gainDb: 6 }, 48000, 200), 3, 0.05, "low shelf: half its gain at the corner");
  near(biquadResponseDb({ kind: "biquad", type: "highshelf", freq: 6000, q: 1, gainDb: -6 }, 48000, 23000), -6, 0.1, "high shelf near Nyquist");
});

test("ducking: from a synthetic envelope — down `attack` before the speech, the amount during it, back over `release`; holds short gaps, drops blips", () => {
  const env = new Map([["m-voice", envelope([[2, 3.5]])]]);
  const p = project({}, duck({ amountDb: -12, attackMs: 250, releaseMs: 600 }));
  const c = duckCurve(p, track(p, "music"), env)!;
  assert.deepEqual(secs(c.keys), [
    [1.75, 0],
    [2, -12],
    [3.5, -12],
    [4.1, 0],
  ]);
  assert.deepEqual(c.keyTracks, ["voice"]);
  assert.deepEqual(c.missing, []);
  // The curve between keys, linear in dB.
  near(duckDbAt(c.keys, 1.875 * FPS), -6, 1e-9, "half way down");
  near(duckDbAt(c.keys, 2.5 * FPS), -12, 1e-9, "during");
  near(duckDbAt(c.keys, 3.8 * FPS), -6, 1e-9, "half way up");
  assert.equal(duckDbAt(c.keys, 5 * FPS), 0);
  assert.equal(duckDbAt(c.keys, 0), 0);
  // It is the item gain's extra dB on the ducked track (the preview's and the export's maths).
  near(itemGain(track(p, "music"), 0, 2.5 * FPS, duckDbAt(c.keys, 2.5 * FPS)), dbToGain(-12), 1e-12);
  // A 0.2 s gap is held (< DUCK_HOLD_S); a 30 ms blip doesn't duck; runs closer than attack + release join.
  const gaps = duckCurve(
    p,
    track(p, "music"),
    new Map([
      [
        "m-voice",
        envelope([
          [1, 2],
          [2.2, 3],
          [6, 6.03],
          [7, 7.5],
          [8, 8.5],
        ]),
      ],
    ]),
  )!;
  assert.deepEqual(secs(gaps.keys), [
    [0.75, 0],
    [1, -12],
    [3, -12],
    [3.6, 0],
    [6.75, 0],
    [7, -12],
    [8.5, -12],
    [9.1, 0],
  ]);
  // A zero attack is a step at the onset.
  const step = duckCurve(project({}, duck({ attackMs: 0 })), track(project({}, duck({ attackMs: 0 })), "music"), env)!;
  assert.deepEqual(secs(step.keys).slice(0, 2), [
    [2, 0],
    [2, -12],
  ]);
  assert.equal(duckDbAt(step.keys, 2 * FPS), -12, "from the step's frame on");
  // An explicit threshold above the speech: nothing ducks.
  assert.deepEqual(duckCurve(project({}, duck({ thresholdDb: -10 })), track(project({}, duck({ thresholdDb: -10 })), "music"), env)!.keys, []);
});

test("ducking: no speech, a muted key, a key at −∞ or missing analysis duck nothing (and say why); the curve maps through cuts and in points", () => {
  const p = project({}, duck());
  assert.deepEqual(duckCurve(p, track(p, "music"), new Map([["m-voice", envelope([])]]))!.keys, [], "no speech, no duck");
  assert.deepEqual(duckCurve(p, track(p, "music"), new Map([["m-voice", null]]))!.keys, [], "a key without sound");
  const missing = duckCurve(p, track(p, "music"), new Map())!;
  assert.deepEqual(missing.missing, ["m-voice"]);
  assert.equal(duckNote(p, track(p, "music"), missing), "Music's ducking waits for the loudness of voice.wav to be measured.");
  assert.deepEqual(duckMediaIds(p), ["m-voice"]);
  const muted = project({ mixer: { mute: true } }, duck());
  const mc = duckCurve(muted, track(muted, "music"), new Map([["m-voice", envelope([[2, 3]])]]))!;
  assert.deepEqual(mc.keys, []);
  assert.deepEqual(mc.keyTracks, []);
  assert.match(duckNote(muted, track(muted, "music"), mc)!, /ducks under nothing that is heard/);
  assert.deepEqual(duckMediaIds(muted), [], "a muted key needs no analysis");
  const silent = project({}, duck(), [{ id: "v", type: "audio", media: "m-voice", in: 0, start: 0, duration: 300, gainDb: -60 }]);
  assert.deepEqual(duckCurve(silent, track(silent, "music"), new Map([["m-voice", envelope([[2, 3]])]]))!.keys, [], "a key at −∞");
  // Through the timeline: speech at 1.0–2.0 s of the media. Piece A plays 0–1.5 s of it from 0; piece
  // B plays from 2.5 s of the media at timeline 1.5 s (a cut took 1.5–2.5 s). Only 1.0–1.5 s is heard.
  const env = new Map([["m-voice", envelope([[1, 2]])]]);
  const cut = project({}, duck({ attackMs: 100, releaseMs: 200 }), [
    { id: "a", type: "audio", media: "m-voice", in: 0, start: 0, duration: 45 },
    { id: "b", type: "audio", media: "m-voice", in: 75, start: 45, duration: 60 },
  ]);
  assert.deepEqual(secs(duckCurve(cut, track(cut, "music"), env)!.keys), [
    [0.9, 0],
    [1, -12],
    [1.5, -12],
    [1.7, 0],
  ]);
  // A key item starting at 4 s with an in point of 0.5 s: the speech is heard at 4.5–5.5 s.
  const moved = project({}, duck({ attackMs: 100, releaseMs: 200 }), [{ id: "v", type: "audio", media: "m-voice", in: 15, start: 120, duration: 90 }]);
  assert.deepEqual(secs(duckCurve(moved, track(moved, "music"), env)!.keys), [
    [4.4, 0],
    [4.5, -12],
    [5.5, -12],
    [5.7, 0],
  ]);
  // The export plan folds the keys over each item into its gain (frames local to the item).
  const plan = planExport(moved, { mediaPath: (m) => m.path, width: 640, height: 360, envelopes: env });
  assert.ok(!("problem" in plan));
  const music = plan.audio.find((a) => a.track === "music")!;
  assert.deepEqual(music.gain.duck, [
    { frame: 132, db: 0 },
    { frame: 135, db: -12 },
    { frame: 165, db: -12 },
    { frame: 171, db: 0 },
  ]);
  assert.deepEqual(duckKeysIn(music.gain.duck!, 200, 300), [], "nothing past the curve");
  assert.equal(plan.audio.find((a) => a.track === "voice")!.gain.duck, undefined);
});

test("limiter and loudness targets: the limiter is on at −1 dBTP by default; Normal/Quieter/Broadcast/the project's own number map to targets", () => {
  assert.deepEqual(masterLimiter({}), { ceilingDb: -1 });
  assert.equal(masterLimiter({ master: { effects: [{ module: "audio.limiter", bypass: true }] } }), undefined);
  assert.deepEqual(masterLimiter({ master: { effects: [{ module: "audio.limiter", params: { ceilingDb: -2 } }] } }), { ceilingDb: -2 });
  assert.equal(projectTargetLufs({}), -14);
  assert.equal(projectTargetLufs({ master: { loudness: { targetLufs: -23 } } }), -23);
  assert.equal(choiceOfTarget(-14), "normal");
  assert.equal(choiceOfTarget(-16), "quiet");
  assert.equal(choiceOfTarget(-23), "broadcast");
  assert.equal(choiceOfTarget(-18), "target");
  assert.equal(targetOfChoice("off"), undefined);
  assert.equal(targetOfChoice("normal"), -14);
  assert.equal(targetOfChoice("quiet"), -16);
  assert.equal(targetOfChoice("broadcast"), -23);
  assert.equal(targetOfChoice("target", -18), -18);
  assert.equal(targetOfChoice("target"), -14);
  // The export plan carries the limiter; a project without any is limited at −1.
  const plan = planExport(project(), { mediaPath: (m) => m.path, width: 640, height: 360 });
  assert.ok(!("problem" in plan));
  assert.deepEqual(plan.limiter, { ceilingDb: -1 });
  // The planners: −23 is stored, −14 (the default) removes it; the limiter off is a bypassed entry, back on removes it.
  const p = project({}, {}, undefined, { gainDb: -3 });
  const broadcast = apply(p, planLoudnessTarget(p, -23));
  assert.deepEqual(broadcast.master, { gainDb: -3, loudness: { targetLufs: -23 } });
  assert.deepEqual(apply(broadcast, planLoudnessTarget(broadcast, -14)).master, { gainDb: -3 });
  const off = apply(p, planMasterLimiter(p, false));
  assert.deepEqual(off.master, { gainDb: -3, effects: [{ module: "audio.limiter", bypass: true }] });
  assert.equal(masterLimiter(off), undefined);
  assert.deepEqual(apply(off, planMasterLimiter(off, true, -2)).master, { gainDb: -3, effects: [{ module: "audio.limiter", params: { ceilingDb: -2 } }] });
  assert.deepEqual(apply(off, planMasterLimiter(off, true)).master, { gainDb: -3 });
  assert.equal((planLoudnessTarget(p, -23) as { summary: string }).summary, "Set the loudness target to Broadcast (−23 LUFS)");
  assert.equal((planMasterLimiter(p, false) as { summary: string }).summary, "Turn off the master limiter");
});

test("Mixer planners: add, voice preset, reorder (past ducking), bypass, params, remove, duck — valid edits, History words, the agent's words", () => {
  let p = project();
  p = apply(p, planAddEffect(p, "voice", "audio.eq"));
  p = apply(p, planAddEffect(p, "voice", "audio.compressor"));
  assert.deepEqual(track(p, "voice").mixer?.effects, [{ module: "audio.eq" }, { module: "audio.compressor" }]);
  const params = planEffectParams(p, "voice", 0, { lowCutHz: 90, midGainDb: 3.456 });
  assert.equal((params as { summary: string }).summary, "Set EQ on Voice: low cut 90 Hz, +3.5 dB at 1 kHz");
  p = apply(p, params);
  assert.deepEqual(track(p, "voice").mixer?.effects?.[0], { module: "audio.eq", params: { lowCutHz: 90, midGainDb: 3.46 } });
  p = apply(p, planEffectParams(p, "voice", 0, { midGainDb: null }));
  assert.deepEqual(track(p, "voice").mixer?.effects?.[0], { module: "audio.eq", params: { lowCutHz: 90 } });
  const moved = planMoveEffect(p, "voice", 1, -1);
  assert.equal((moved as { summary: string }).summary, "Move Compressor up on Voice");
  p = apply(p, moved);
  assert.deepEqual(
    track(p, "voice").mixer?.effects?.map((f) => f.module),
    ["audio.compressor", "audio.eq"],
  );
  assert.deepEqual((planMoveEffect(p, "voice", 0, -1) as { ops: ReadonlyArray<unknown> }).ops, [], "the first can't go up");
  const bypass = planBypassEffect(p, "voice", 1, true);
  assert.equal((bypass as { summary: string }).summary, "Bypass EQ on Voice");
  p = apply(p, bypass);
  assert.equal(track(p, "voice").mixer?.effects?.[1]?.bypass, true);
  p = apply(p, planBypassEffect(p, "voice", 1, false));
  assert.equal(track(p, "voice").mixer?.effects?.[1]?.bypass, undefined);
  p = apply(p, planRemoveEffect(p, "voice", 0));
  p = apply(p, planRemoveEffect(p, "voice", 0));
  assert.equal(track(p, "voice").mixer, undefined, "an empty chain removes the mixer");
  p = apply(p, planVoicePreset(p, "voice"));
  assert.deepEqual(track(p, "voice").mixer?.effects, VOICE_PRESET);
  // Ducking: one entry, replaced in place; reordering skips it; stopping removes it.
  const d = planDuck(p, "music", { under: ["voice"], amountDb: -10 });
  assert.equal((d as { summary: string }).summary, "Duck Music under Voice by −10 dB");
  p = apply(p, d);
  assert.deepEqual(track(p, "music").mixer?.effects, [{ module: "audio.duck", params: { under: ["voice"], amountDb: -10, attackMs: 250, releaseMs: 600 } }]);
  p = apply(p, planAddEffect(p, "music", "audio.eq", { highGainDb: -3 }));
  p = apply(p, planDuck(p, "music", { under: ["voice"], releaseMs: 900 }));
  assert.deepEqual(
    track(p, "music").mixer?.effects?.map((f) => f.module),
    ["audio.duck", "audio.eq"],
  );
  assert.equal(track(p, "music").mixer?.effects?.[0]?.params?.releaseMs, 900);
  assert.equal(track(p, "music").mixer?.effects?.[0]?.params?.amountDb, -10, "kept");
  assert.deepEqual((planMoveEffect(p, "music", 1, -1) as { ops: ReadonlyArray<unknown> }).ops, [], "nothing to pass but the duck");
  assert.ok("problem" in planDuck(p, "music", { under: ["music"] }), "not under itself");
  p = apply(p, planDuck(p, "music", null));
  assert.deepEqual(track(p, "music").mixer?.effects, [{ module: "audio.eq", params: { highGainDb: -3 } }]);
  // A popover's edit names the module it saw: if the chain changed under it, nothing is edited.
  const guarded = apply(p, planAddEffect(p, "voice", "audio.compressor"));
  assert.ok("problem" in planEffectParams(guarded, "voice", 0, { ratio: 4 }, "audio.compressor"), "index 0 is the EQ now");
  assert.ok("problem" in planBypassEffect(guarded, "voice", 0, true, "audio.compressor"));
  assert.ok("problem" in planRemoveEffect(guarded, "voice", 0, "audio.compressor"));
  assert.ok("ops" in planRemoveEffect(guarded, "voice", 2, "audio.compressor"));
  // Editing a bypassed duck keeps it bypassed.
  const offDuck = apply(p, planDuck(p, "music", { under: ["voice"] }));
  const duckAt = track(offDuck, "music").mixer!.effects!.findIndex((f) => f.module === "audio.duck");
  const bypassedDuck = apply(offDuck, planBypassEffect(offDuck, "music", duckAt, true, "audio.duck"));
  const edited = apply(bypassedDuck, planDuck(bypassedDuck, "music", { under: ["voice"], amountDb: -20 }));
  assert.deepEqual(track(edited, "music").mixer?.effects?.[duckAt], {
    module: "audio.duck",
    params: { under: ["voice"], amountDb: -20, attackMs: 250, releaseMs: 600 },
    bypass: true,
  });
  // History words: the summary in the past tense; the agent's edits (no summary) list the chain.
  const op: Op = {
    op: "update_track",
    track: "music",
    set: {
      mixer: {
        gainDb: -8,
        effects: [
          { module: "audio.duck", params: { under: ["voice"], amountDb: -12 } },
          { module: "audio.eq", params: { lowCutHz: 80 } },
        ],
      },
    },
  };
  assert.equal(describeOp(op, p), "Set effects of track music: ducking under voice, −12 dB, EQ (low cut 80 Hz); volume −8 dB");
  assert.equal(describeOp(op, p, "Duck Music under Voice by −12 dB"), "Ducked Music under Voice by −12 dB");
  assert.equal(describeOp(op, p, "Add EQ to Music"), "Added EQ to Music");
  assert.equal(describeOp(op, p, "Turn on EQ on Music"), "Turned on EQ on Music");
  assert.equal(
    describeOp({ op: "update_project", set: { master: { loudness: { targetLufs: -23 } } } }, p),
    "Set the master: loudness target Broadcast (−23 LUFS)",
  );
  assert.equal(
    describeOp({ op: "update_project", set: { master: { effects: [{ module: "audio.limiter", bypass: true }] } } }, p),
    "Set the master: limiter off",
  );
  assert.equal(
    describeOp({ op: "update_project", set: { master: { gainDb: -3, effects: [] } } }, p, "Turn off the master limiter"),
    "Turned off the master limiter",
  );
  assert.equal(describeOp({ op: "update_project", set: { master: { gainDb: -3 } } }, p), "Set master volume to −3 dB");
  // Every part of the master is said: a volume doesn't hide a target or a limiter change.
  assert.equal(
    describeOp(
      { op: "update_project", set: { master: { gainDb: -3, loudness: { targetLufs: -16 }, effects: [{ module: "audio.limiter", bypass: true }] } } },
      p,
    ),
    "Set the master: volume −3 dB, loudness target Quieter (−16 LUFS), limiter off",
  );
});
