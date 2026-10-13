// Phase 6 chunk 7 (D84–D88) through ffmpeg: the export's track effects, ducking, master limiter,
// loudness targets and noise removal, measured on generated tones and noise. The audio graph is the
// export's own (planExport + audioGraph, or the full exportCommand with AAC and the loudness passes
// of planLoudness, as exporter.ts runs them).
// - EQ: stepped tones through high-pass, shelves, peak, low-pass and the voice preset: every step's
//   gain within 1 dB of core biquadResponseDb (the Web Audio spec's cookbook curves, which the
//   preview's BiquadFilterNode computes; the app test checks that side);
// - compressor: a steady tone over the threshold lands on the static curve within 1 dB (the
//   documented tolerance), one under it is untouched;
// - ducking: music hard right, voice hard left; the music's level follows core's duck curve per
//   0.05 s window (±0.5 dB): −12 dB while the voice speaks, back after the release;
// - limiter: a +12 dB hot mix stays ≤ −1 dBTP (ebur128 true peak on the AAC file) as mixed and at
//   every target;
// - targets: −14 / −16 / −23 LUFS within ±1 LU, also for a quiet mix with loud clicks (the limiter
//   works, and the check pass corrects the gain);
// - noise removal: broadband noise down by ≥ 6 dB with the tone kept; not in the preview's stages.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbToGain, decodeEnvelope, duckCurve, duckDbAt, effectStages, noiseFloorDb, stagesResponseDb, targetOfChoice, trackStages, VOICE_PRESET, type Item, type LoudnessChoice, type ModuleUse, type Project, type SpeechEnvelope, type Track } from "../../packages/core/src/index.ts";
import { audioGraph, exportCommand, planExport, planLoudness, type ExportPlan } from "../../apps/server/src/export/exportPlan.ts";
import { analyzeLoudness } from "../../apps/server/src/analysis/analysis.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = hasFfmpeg ? false : "needs ffmpeg";
const FPS = 30;
let dir = "";
const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
const dB = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
const within = (got: number, want: number, tol: number, what: string) => assert.ok(Math.abs(got - want) <= tol, `${what}: ${got.toFixed(2)} vs ${want.toFixed(2)} (±${tol})`);

// Stepped tones (0.1 amplitude, 0.4 s each) for the EQ.
const STEPS = [50, 100, 200, 500, 1000, 2000, 3500, 6000, 10000, 15000];
const STEP_S = 0.4;
const stepExpr = () => {
  let f = String(STEPS.at(-1));
  for (let i = STEPS.length - 2; i >= 0; i--) f = `if(lt(t,${((i + 1) * STEP_S).toFixed(2)}),${STEPS[i]},${f})`;
  return `0.1*sin(2*PI*${f}*t)`;
};

before(() => {
  if (skip) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "uncut-effects-export-")));
  const wav = (name: string, expr: string, d: number) => ff("-f", "lavfi", "-i", `aevalsrc='${expr}':s=48000:d=${d}`, "-c:a", "pcm_f32le", join(dir, name));
  wav("steps.wav", stepExpr(), STEPS.length * STEP_S);
  wav("loud.wav", "0.5*sin(2*PI*1000*t)", 4); // peak −6 dBFS
  wav("soft.wav", "0.05*sin(2*PI*1000*t)", 4); // peak −26 dBFS
  // Voice: a 300 Hz "phrase" from 2.0 to 3.5 s (silence around it), 8 s long.
  wav("voice.wav", "0.3*sin(2*PI*300*t)*between(t,2,3.5)", 8);
  wav("music.wav", "0.2*sin(2*PI*660*t)", 8);
  // A hot bed: a tone and noise near full scale (pushed +12 dB by the track).
  ff("-f", "lavfi", "-i", "aevalsrc=0.6*sin(2*PI*220*t)+0.3*sin(2*PI*1500*t):s=48000:d=6", "-f", "lavfi", "-i", "anoisesrc=d=6:c=pink:r=48000:a=0.3:seed=7", "-filter_complex", "[0][1]amix=inputs=2:normalize=0", "-c:a", "pcm_f32le", join(dir, "hot.wav"));
  // A quiet bed with loud clicks every 0.5 s (a large crest: raising it to a target needs the limiter).
  wav("clicks.wav", "0.01*sin(2*PI*440*t)+0.7*lt(mod(t,0.5),0.002)", 6);
  // Music-like for the targets: two tones with a slow swell, and pink noise.
  ff("-f", "lavfi", "-i", "aevalsrc='(0.15+0.1*sin(2*PI*0.5*t))*(sin(2*PI*196*t)+0.5*sin(2*PI*988*t))':s=48000:d=6", "-f", "lavfi", "-i", "anoisesrc=d=6:c=pink:r=48000:a=0.05:seed=3", "-filter_complex", "[0][1]amix=inputs=2:normalize=0", "-c:a", "pcm_f32le", join(dir, "bed.wav"));
  // A noisy tone: 1 kHz at 0.3, on for 0.6 s of every second (like speech with pauses), over white noise at 0.03.
  ff("-f", "lavfi", "-i", "aevalsrc='0.3*sin(2*PI*1000*t)*between(mod(t,1),0,0.6)':s=48000:d=5", "-f", "lavfi", "-i", "anoisesrc=d=5:c=white:r=48000:a=0.03:seed=11", "-filter_complex", "[0][1]amix=inputs=2:normalize=0", "-c:a", "pcm_f32le", join(dir, "noisy.wav"));
  ff("-f", "lavfi", "-i", "color=c=black:s=640x360", "-frames:v", "1", join(dir, "bg.png"));
});
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const FILES: Record<string, number> = { steps: STEPS.length * STEP_S, loud: 4, soft: 4, voice: 8, music: 8, hot: 6, clicks: 6, bed: 6, noisy: 5 };
const media = () => Object.entries(FILES).map(([id, s]) => ({ id: `m-${id}`, kind: "audio" as const, name: `${id}.wav`, path: join(dir, `${id}.wav`), probe: { frames: Math.round(s * FPS) } }));
const audioItem = (id: string, m: string, frames: number, extra: Partial<Item> = {}): Item => ({ id, type: "audio", media: `m-${m}`, in: 0, start: 0, duration: frames, ...extra });
const track = (id: string, items: Array<Item>, mixer?: Track["mixer"]): Track => ({ id, kind: "audio", name: id[0]!.toUpperCase() + id.slice(1), ...(mixer ? { mixer } : {}), items });
const mixProject = (tracks: Array<Track>, master?: Project["master"]): Project => ({
  format: "uncut/0",
  name: "Effects",
  canvas: { width: 640, height: 360, fps: FPS },
  media: media(),
  tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [] }, ...tracks],
  ...(master ? { master } : {}),
});
const NO_LIMITER: Project["master"] = { effects: [{ module: "audio.limiter", bypass: true }] };

const plan = (project: Project, envelopes?: ReadonlyMap<string, SpeechEnvelope | null>): ExportPlan => {
  const p = planExport(project, { mediaPath: (m) => m.path, width: 640, height: 360, envelopes });
  if ("problem" in p) throw new Error(p.problem);
  return p;
};
/** The export's mix of a project, as 32-bit float WAV. */
function mix(project: Project, name: string, envelopes?: ReadonlyMap<string, SpeechEnvelope | null>): string {
  const g = audioGraph(plan(project, envelopes), 0);
  const graph = join(dir, `out-${name}.txt`);
  writeFileSync(graph, g.filters.join(";\n"));
  const out = join(dir, `out-${name}.wav`);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-y", ...g.inputs, "-/filter_complex", graph, "-map", "[aout]", "-c:a", "pcm_f32le", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr.slice(-800));
  return out;
}
/** The whole export (picture + AAC), with the loudness passes exporter.ts runs. */
async function exportFile(project: Project, choice: LoudnessChoice, name: string): Promise<string> {
  const p = plan(project);
  const target = targetOfChoice(choice);
  const { loudness, loudnorm } =
    target === undefined
      ? {}
      : await planLoudness(p, target, async (pass, file) => {
          const graph = join(dir, `${name}-${file}`);
          writeFileSync(graph, pass.graph);
          const r = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", ...pass.inputs, "-/filter_complex", graph, ...pass.outputArgs], { encoding: "utf8" });
          assert.equal(r.status, 0, r.stderr.slice(-600));
          return r.stderr;
        });
  const out = join(dir, `${name}.mp4`);
  const cmd = exportCommand(p, { background: join(dir, "bg.png"), rasters: new Map(), caps: { encoders: new Set(["libx264"]), videotoolboxDecode: false, major: 8 }, quality: "draft", loudness, loudnorm, output: out });
  writeFileSync(join(dir, `${name}-graph.txt`), cmd.graph);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-y", ...cmd.inputs, "-/filter_complex", join(dir, `${name}-graph.txt`), ...cmd.outputArgs], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr.slice(-800));
  return out;
}
/** Both channels of a file as float samples (48 kHz). */
function samples(file: string): { left: Float32Array; right: Float32Array } {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a", "-f", "f32le", "-ac", "2", "-ar", "48000", "-"], { maxBuffer: 1 << 28 });
  const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const n = all.length / 2;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) (left[i] = all[2 * i]!, (right[i] = all[2 * i + 1]!));
  return { left, right };
}
const rmsOf = (a: Float32Array, from: number, to: number) => {
  let s = 0;
  const i0 = Math.round(from * 48000);
  const i1 = Math.min(a.length, Math.round(to * 48000));
  for (let i = i0; i < i1; i++) s += a[i]! ** 2;
  return Math.sqrt(s / Math.max(1, i1 - i0));
};
/** Integrated loudness (LUFS) and true peak (dBTP) from ffmpeg's ebur128. */
function loudness(file: string): { lufs: number; tp: number } {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-map", "0:a", "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" });
  const i = /Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(r.stderr);
  const tp = /True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(r.stderr);
  assert.ok(i && tp, r.stderr.slice(-500));
  return { lufs: Number(i[1]), tp: tp[1] === "-inf" ? -Infinity : Number(tp[1]) };
}

test("EQ: every step of the stepped tones gets core's cookbook response within 1 dB (high-pass, shelves, peak, low-pass, the voice preset)", { skip, timeout: 120000 }, () => {
  const frames = Math.round(STEPS.length * STEP_S * FPS);
  const cases: Array<{ name: string; effects: Array<ModuleUse> }> = [
    { name: "highpass", effects: [{ module: "audio.eq", params: { lowCutHz: 120 } }] },
    { name: "lowshelf", effects: [{ module: "audio.eq", params: { lowGainDb: 6, lowHz: 200 } }] },
    { name: "peak", effects: [{ module: "audio.eq", params: { midGainDb: -8, midHz: 1000, midQ: 1.4 } }] },
    { name: "highshelf", effects: [{ module: "audio.eq", params: { highGainDb: -6, highHz: 6000 } }] },
    { name: "lowpass", effects: [{ module: "audio.eq", params: { highCutHz: 5000 } }] },
    { name: "all", effects: [{ module: "audio.eq", params: { lowCutHz: 60, lowGainDb: -3, lowHz: 150, midGainDb: 5, midHz: 2500, midQ: 0.7, highGainDb: 4, highHz: 9000, highCutHz: 16000 } }] },
    // The voice preset's EQ (its compressor is left out: steps at 0.1 are under its threshold, but keep it pure).
    { name: "voice-eq", effects: [VOICE_PRESET[0]!] },
  ];
  let worst = 0;
  for (const c of cases) {
    const project = mixProject([track("music", [audioItem("s", "steps", frames)], { effects: c.effects })], NO_LIMITER);
    const { left } = samples(mix(project, `eq-${c.name}`));
    const stages = c.effects.flatMap(effectStages);
    STEPS.forEach((f, i) => {
      const got = dB(rmsOf(left, i * STEP_S + 0.15, i * STEP_S + 0.35) / (0.1 / Math.SQRT2));
      const want = stagesResponseDb(stages, 48000, f);
      if (want < -40) return assert.ok(got < -30, `${c.name} at ${f} Hz: ${got.toFixed(1)} dB, core ${want.toFixed(1)} dB`);
      worst = Math.max(worst, Math.abs(got - want));
      within(got, want, 1, `${c.name} at ${f} Hz`);
    });
  }
  console.log(`EQ: worst step vs core ${worst.toFixed(3)} dB`);
});

test("compressor: a steady tone over the threshold lands on the static curve (±1 dB), one under it is untouched", { skip, timeout: 60000 }, () => {
  const comp: ModuleUse = { module: "audio.compressor", params: { thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 150, makeupDb: 2 } };
  const at = (m: string) => {
    const { left } = samples(mix(mixProject([track("voice", [audioItem("v", m, 120)], { effects: [comp] })], NO_LIMITER), `comp-${m}`));
    return dB(rmsOf(left, 1, 3.5));
  };
  // −6 dBFS peak: 12 dB over → 4 dB over the threshold, +2 make-up: peak −12, RMS −15.01.
  const loud = at("loud");
  within(loud, -18 + 12 / 3 + 2 - 3.01, 1, "loud tone, compressed 3:1 with +2 dB make-up");
  const soft = at("soft");
  within(soft, -26 + 2 - 3.01, 0.3, "soft tone (under the threshold): only the make-up");
  console.log(`compressor: loud ${loud.toFixed(2)} dBFS RMS (curve ${(-18 + 4 + 2 - 3.01).toFixed(2)}), soft ${soft.toFixed(2)} (want ${(-26 + 2 - 3.01).toFixed(2)})`);
});

test("ducking: the music follows core's duck curve per 0.05 s window (±0.5 dB): −12 dB under the voice, back after the release", { skip, timeout: 120000 }, async () => {
  const loud = await analyzeLoudness("ffmpeg", join(dir, "voice.wav"), { signal: new AbortController().signal });
  assert.ok(loud.hasAudio);
  const envelopes = new Map([["m-voice", decodeEnvelope(loud.envelope)!]]);
  const project = mixProject(
    [
      track("voice", [audioItem("v", "voice", 240)], { pan: -1 }),
      track("music", [audioItem("m", "music", 240)], { pan: 1, effects: [{ module: "audio.duck", params: { under: ["voice"], amountDb: -12, attackMs: 250, releaseMs: 600 } }] }),
    ],
    NO_LIMITER,
  );
  const curve = duckCurve(project, project.tracks[2]!, envelopes)!;
  assert.deepEqual(curve.missing, []);
  // The speech runs 2.0–3.5 s: down from 1.75 s, at −12 by 2.0 s, up from 3.5 s, back by 4.1 s.
  assert.deepEqual(
    curve.keys.map((k) => [Math.round((k.frame / FPS) * 100) / 100, k.db]),
    [
      [1.75, 0],
      [2, -12],
      [3.5, -12],
      [4.1, 0],
    ],
  );
  const { right } = samples(mix(project, "duck", envelopes));
  const base = 0.2 / Math.SQRT2;
  let worst = 0;
  for (let t = 0.2; t < 7.8; t += 0.05) {
    // Core's level over the window (the curve sampled per 1/480 s, power-averaged).
    let p = 0;
    let n = 0;
    for (let u = t + 1 / 960; u < t + 0.05; u += 1 / 480) (p += (base * dbToGain(duckDbAt(curve.keys, u * FPS))) ** 2, n++);
    const want = dB(Math.sqrt(p / n));
    const got = dB(rmsOf(right, t, t + 0.05));
    worst = Math.max(worst, Math.abs(got - want));
    within(got, want, 0.5, `music at ${t.toFixed(2)} s`);
  }
  within(dB(rmsOf(right, 2.1, 3.4)), dB(base) - 12, 0.3, "during the voice: −12 dB");
  within(dB(rmsOf(right, 4.2, 7)), dB(base), 0.3, "after the release: back");
  // Without the envelope, nothing ducks and the plan says why.
  const unmeasured = plan(project);
  assert.ok(unmeasured.warnings.some((w) => /Music's ducking isn't applied: it needs the loudness of voice\.wav/.test(w)), unmeasured.warnings.join(" | "));
  console.log(`ducking: worst 0.05 s window vs core ${worst.toFixed(3)} dB`);
});

test("limiter: a +12 dB hot mix stays at or under −1 dBTP on the AAC file, as mixed and at every target", { skip, timeout: 300000 }, async () => {
  const hot = mixProject([track("music", [audioItem("h", "hot", 180)], { gainDb: 12 })]);
  // Unlimited, it is far over full scale.
  const raw = loudness(mix({ ...hot, master: NO_LIMITER }, "hot-raw"));
  assert.ok(raw.tp > 6, `unlimited true peak ${raw.tp} dBTP`);
  for (const choice of ["off", "normal", "quiet", "broadcast"] as const) {
    const got = loudness(await exportFile(hot, choice, `hot-${choice}`));
    assert.ok(got.tp <= -1, `${choice}: true peak ${got.tp} dBTP`);
    console.log(`limiter: ${choice} true peak ${got.tp} dBTP, ${got.lufs} LUFS`);
  }
  // A ceiling of −3 holds too.
  const low = loudness(await exportFile({ ...hot, master: { effects: [{ module: "audio.limiter", params: { ceilingDb: -3 } }] } }, "off", "hot-low"));
  assert.ok(low.tp <= -3, `ceiling −3: ${low.tp} dBTP`);
});

test("targets: −14 / −16 / −23 LUFS land within ±1 LU (a music-like bed, and a quiet bed with loud clicks the limiter has to hold)", { skip, timeout: 300000 }, async () => {
  for (const [m, name] of [
    ["bed", "bed"],
    ["clicks", "clicks"],
  ] as const) {
    const project = mixProject([track("music", [audioItem("b", m, 180)])]);
    for (const choice of ["normal", "quiet", "broadcast"] as const) {
      const want = targetOfChoice(choice)!;
      const got = loudness(await exportFile(project, choice, `${name}-${choice}`));
      within(got.lufs, want, 1, `${name} at ${choice}`);
      assert.ok(got.tp <= -1, `${name} at ${choice}: true peak ${got.tp}`);
      console.log(`target ${want}: ${name} ${got.lufs} LUFS, ${got.tp} dBTP`);
    }
  }
  // The project's own target (choice "target").
  const custom = loudness(await exportFile(mixProject([track("music", [audioItem("b", "bed", 180)])], { loudness: { targetLufs: -18 } }), "off", "bed-off"));
  assert.ok(custom.lufs < -5, "as mixed stays as mixed");
});

test("noise removal: broadband noise down ≥ 6 dB with the tone kept (±1 dB), from the measured noise floor; the preview's stages leave it out", { skip, timeout: 120000 }, async () => {
  const denoise: ModuleUse = { module: "audio.denoise", params: { amount: 1 } };
  // The noise floor comes from the track's loudness envelope (the export measures it when it isn't cached).
  const loud = await analyzeLoudness("ffmpeg", join(dir, "noisy.wav"), { signal: new AbortController().signal });
  const env = decodeEnvelope(loud.envelope)!;
  const floor = noiseFloorDb(env);
  assert.ok(floor > -40 && floor < -25, `noise floor ${floor} dBFS`);
  const envelopes = new Map([["m-noisy", env]]);
  const at = (effects: Array<ModuleUse> | undefined, name: string) => mix(mixProject([track("voice", [audioItem("n", "noisy", 150)], effects ? { effects } : undefined)], NO_LIMITER), name, envelopes);
  const band = (file: string, filter: string) => {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", `atrim=start=1.5:end=4.5,${filter},astats=measure_perchannel=none:measure_overall=RMS_level`, "-f", "null", "-"], { encoding: "utf8" });
    return Number(/RMS level dB: (-?[\d.]+)/.exec(r.stderr)![1]);
  };
  const plain = at(undefined, "noisy-plain");
  const clean = at([denoise], "noisy-clean");
  // Noise: above 3 kHz (the tone is at 1 kHz); the tone: a narrow band around it.
  const noiseCut = band(plain, "highpass=f=3000:p=2,highpass=f=3000:p=2") - band(clean, "highpass=f=3000:p=2,highpass=f=3000:p=2");
  const toneDiff = band(clean, "bandpass=f=1000:width_type=q:w=8") - band(plain, "bandpass=f=1000:width_type=q:w=8");
  assert.ok(noiseCut >= 6, `noise down ${noiseCut.toFixed(1)} dB`);
  within(toneDiff, 0, 1, "the tone");
  console.log(`noise removal: floor ${floor} dBFS, noise −${noiseCut.toFixed(1)} dB, tone ${toneDiff.toFixed(2)} dB`);
  const t: Track = track("voice", [], { effects: [denoise, { module: "audio.eq", params: { lowCutHz: 80 } }] });
  assert.deepEqual(trackStages(t).map((s) => s.kind), ["denoise", "biquad"]);
  assert.deepEqual(trackStages(t, { preview: true }).map((s) => s.kind), ["biquad"]);
});
