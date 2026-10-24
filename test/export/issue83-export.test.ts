// Issue #83 (D246): noise removal is heard in the preview as the export renders it. Core's
// SpectralDenoiser (what the preview's AudioWorklet runs) against the export's own afftdn filter
// (stageFilter of the denoise stage) on generated noise and signals, at every amount and around the
// noise floor: the noise left in a noise-only stretch within 2.5 dB of afftdn's, the signal kept
// within 0.3 dB of it, and a perfect reconstruction (one frame late) when nothing is removed.
// The loudness target heard (D246): loudnessGain, the gain the preview plays At target, brings the
// export's mix to the target with the limiter on and off.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DENOISE_FFT, SpectralDenoiser } from "../../packages/core/src/audio/denoise.ts";
import { stageFilter } from "../../apps/server/src/export/plan/audio.ts";
import { audioGraph, loudnessGain, parseEbur128, planExport } from "../../apps/server/src/export/exportPlan.ts";
import type { Project } from "../../packages/core/src/index.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = hasFfmpeg ? false : "needs ffmpeg";
const SR = 48000;
let dir = "";
const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
const read = (file: string) => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "f32le", "-ac", "1", "-ar", String(SR), "-"], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
};
const rmsDb = (a: Float32Array, s: number, e: number, lag = 0) => {
  let sum = 0;
  const i0 = Math.round(s * SR) + lag;
  const i1 = Math.round(e * SR) + lag;
  for (let i = i0; i < i1; i++) sum += a[i]! ** 2;
  return 10 * Math.log10(Math.max(sum / (i1 - i0), 1e-20));
};
/** The preview's denoiser over a whole signal, 128 samples at a time (a worklet's render quantum). */
function denoise(x: Float32Array, amount: number, floorDb: number) {
  const d = new SpectralDenoiser();
  d.set(amount, floorDb);
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 128) d.process(x.subarray(i, i + 128), y.subarray(i, i + 128));
  return y;
}

// Noise-only 0.5–1.8 s, signal 2–4 s.
const FIXTURES = {
  // White noise at −40.8 dBFS RMS under a 440 Hz tone (D88's measurement).
  "white+tone": [
    "-f",
    "lavfi",
    "-i",
    "anoisesrc=d=6:c=white:r=48000:a=0.0158:seed=3",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.18*sin(2*PI*440*t)*between(t,2,4)':s=48000:d=6",
    "-filter_complex",
    "[0][1]amix=inputs=2:normalize=0",
  ],
  // Pink noise under a voice-like harmonic tone.
  "pink+voice": [
    "-f",
    "lavfi",
    "-i",
    "anoisesrc=d=6:c=pink:r=48000:a=0.03:seed=4",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='0.2*(sin(2*PI*220*t)+0.4*sin(2*PI*660*t)+0.2*sin(2*PI*1760*t))*between(t,2,4)':s=48000:d=6",
    "-filter_complex",
    "[0][1]amix=inputs=2:normalize=0",
  ],
  // Quiet white hiss under loud broadband (pink) "music".
  "hiss+music": [
    "-f",
    "lavfi",
    "-i",
    "anoisesrc=d=6:c=white:r=48000:a=0.004:seed=3",
    "-f",
    "lavfi",
    "-i",
    "anoisesrc=d=6:c=pink:r=48000:a=0.2:seed=9",
    "-filter_complex",
    "[1]volume='between(t,2,4)':eval=frame[s];[0][s]amix=inputs=2:normalize=0",
  ],
} as const;

before(() => {
  if (skip) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue83-")));
  for (const [name, args] of Object.entries(FIXTURES)) ff(...args, "-c:a", "pcm_f32le", join(dir, `${name}.wav`));
});
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("the preview's denoiser reconstructs the input exactly (one frame late) when it removes nothing", { skip }, () => {
  const x = read(join(dir, "white+tone.wav"));
  // Amount 0 is still 6 dB of reduction; a floor far below the noise leaves every bin at gain 1.
  const y = denoise(x, 0, -80);
  let worst = 0;
  for (let i = 4096; i < x.length - DENOISE_FFT; i++) worst = Math.max(worst, Math.abs(y[i + DENOISE_FFT]! - x[i]!));
  assert.ok(worst < 1e-4, `reconstruction error ${worst}`);
});

test("noise removal: the preview's denoiser ≈ the export's afftdn (noise left within 2.5 dB, signal within 0.3 dB)", { skip }, () => {
  const rows: Array<string> = [];
  let worstNoise = 0;
  let worstSignal = 0;
  for (const name of Object.keys(FIXTURES)) {
    const file = join(dir, `${name}.wav`);
    const x = read(file);
    for (const amount of [0, 0.5, 1]) {
      for (const floorDb of [-50, -40, -30]) {
        const pre = denoise(x, amount, floorDb);
        const out = join(dir, `${name}-${amount}-${-floorDb}.wav`);
        ff("-i", file, "-af", stageFilter({ kind: "denoise", amount, floorDb }), "-c:a", "pcm_f32le", out);
        const ex = read(out);
        const noise = { input: rmsDb(x, 0.5, 1.8), preview: rmsDb(pre, 0.5, 1.8, DENOISE_FFT), export: rmsDb(ex, 0.5, 1.8) };
        const signal = { preview: rmsDb(pre, 2.5, 3.5, DENOISE_FFT), export: rmsDb(ex, 2.5, 3.5) };
        worstNoise = Math.max(worstNoise, Math.abs(noise.preview - noise.export));
        worstSignal = Math.max(worstSignal, Math.abs(signal.preview - signal.export));
        rows.push(
          `${name} amount ${amount} floor ${floorDb}: noise ${noise.input.toFixed(1)} → preview ${noise.preview.toFixed(2)} / export ${noise.export.toFixed(2)} dB; signal ${signal.preview.toFixed(2)} / ${signal.export.toFixed(2)} dB`,
        );
        assert.ok(Math.abs(noise.preview - noise.export) <= 2.5, rows.at(-1));
        assert.ok(Math.abs(signal.preview - signal.export) <= 0.3, rows.at(-1));
        // White noise with the floor at or over it: both take at least 4 dB off (pink noise's low end sits over a flat floor).
        if (floorDb >= -40 && name === "white+tone") assert.ok(noise.input - noise.preview >= 4, `measurably quieter: ${rows.at(-1)}`);
      }
    }
  }
  console.log(`${rows.join("\n")}\nworst: noise ${worstNoise.toFixed(2)} dB, signal ${worstSignal.toFixed(2)} dB`);
});

test("At target: loudnessGain (what the preview plays) brings the export's mix to the target, limiter on and off", { skip }, async () => {
  const file = join(dir, "pink+voice.wav");
  const project = (master?: Project["master"]): Project => ({
    format: "uncut/0",
    name: "L",
    canvas: { width: 640, height: 360, fps: 30 },
    media: [{ id: "m", kind: "audio", name: "a.wav", path: file, probe: { frames: 180 } }],
    tracks: [
      { id: "main", kind: "video", role: "main", name: "Main", items: [] },
      { id: "a", kind: "audio", name: "A", items: [{ id: "i", type: "audio", media: "m", in: 0, start: 0, duration: 180 }] },
    ],
    ...(master ? { master } : {}),
  });
  const measure = async (pass: { inputs: Array<string>; graph: string; outputArgs: Array<string> }, name: string) => {
    const g = join(dir, `l-${name}`);
    writeFileSync(g, pass.graph);
    const r = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", ...pass.inputs, "-/filter_complex", g, ...pass.outputArgs], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr.slice(-400));
    return r.stderr;
  };
  for (const [name, master] of [
    ["limiter on", undefined],
    ["limiter off", { effects: [{ module: "audio.limiter", bypass: true }] }],
  ] as const) {
    const plan = planExport(project(master), { mediaPath: (m) => m.path, width: 640, height: 360 });
    assert.ok(!("problem" in plan));
    const target = -23;
    const { gainDb, lufs } = await loudnessGain(plan, target, measure);
    assert.ok(gainDb !== undefined && lufs !== undefined);
    const g = audioGraph(plan, 0, { gainDb, tail: "ebur128=peak=true:framelog=quiet" });
    const got = parseEbur128(
      await measure({ inputs: g.inputs, graph: g.filters.join(";\n"), outputArgs: ["-map", "[aout]", "-f", "null", "-"] }, `${name}-check.txt`),
    );
    console.log(`${name}: mix ${lufs} LUFS, gain ${gainDb} dB → ${got?.lufs} LUFS`);
    assert.ok(got && Math.abs(got.lufs - target) <= 0.5, `${name}: ${got?.lufs} LUFS at the target ${target}`);
  }
});
