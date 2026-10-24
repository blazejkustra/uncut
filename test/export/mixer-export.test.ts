// Phase 6 chunk 6 (D83) through ffmpeg: the export's mix of tones of known level, measured on the
// rendered file. The audio graph is the export's own (planExport + audioGraph, what exportCommand
// puts in the full graph), written to 32-bit float WAV so nothing but the mix changes the samples;
// one full exportCommand run (picture + AAC) checks the same levels end to end.
// - pan −1 puts everything left at 0 dB (right below −40 dB relative), 0 leaves both as they were,
//   ±0.5 lands on the law (core panGains: near side 1, far side −5.3 dB) within 0.5 dB, nothing is
//   boosted; a stereo source is balanced, not folded;
// - a track at −6 dB is 6 ±0.5 dB quieter; the master volume applies after the sum;
// - solo silences the other tracks, a muted solo silences everything;
// - a gainKeys ramp gives core's RMS in every 0.1 s window (±0.5 dB); LUFS (ebur128) of a mix
//   with pan, keys and a fade matches core's prediction within 1 dB.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layout, outputGains, panGains, type Item, type Project, type Track } from "../../packages/core/src/index.ts";
import { audioGraph, exportCommand, planExport, silentFailure } from "../../apps/server/src/export/exportPlan.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = hasFfmpeg ? false : "needs ffmpeg";
const FPS = 30;
let dir = "";
const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
const dB = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

// Tones (48 kHz float WAV, 6 s): mono 440 Hz at 0.25 (RMS 0.1768); stereo with 550 Hz at 0.2 on the
// left and 770 Hz at 0.1 on the right; mono 660 Hz at 0.25.
const TONE_RMS = 0.25 / Math.SQRT2;
before(() => {
  if (skip) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "uncut-mixer-export-")));
  ff("-f", "lavfi", "-i", "aevalsrc=0.25*sin(2*PI*440*t):s=48000:d=6", "-c:a", "pcm_f32le", join(dir, "voice.wav"));
  ff("-f", "lavfi", "-i", "aevalsrc=0.2*sin(2*PI*550*t)|0.1*sin(2*PI*770*t):s=48000:d=6:c=stereo", "-c:a", "pcm_f32le", join(dir, "stereo.wav"));
  ff("-f", "lavfi", "-i", "aevalsrc=0.25*sin(2*PI*660*t):s=48000:d=6", "-c:a", "pcm_f32le", join(dir, "music.wav"));
  ff("-f", "lavfi", "-i", "color=c=black:s=640x360", "-frames:v", "1", join(dir, "bg.png"));
});
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const media = () => [
  { id: "m-voice", kind: "audio" as const, name: "voice.wav", path: join(dir, "voice.wav"), probe: { frames: 180 } },
  { id: "m-stereo", kind: "audio" as const, name: "stereo.wav", path: join(dir, "stereo.wav"), probe: { frames: 180 } },
  { id: "m-music", kind: "audio" as const, name: "music.wav", path: join(dir, "music.wav"), probe: { frames: 180 } },
];
const audioItem = (id: string, m: string, extra: Partial<Item> = {}): Item => ({ id, type: "audio", media: m, in: 0, start: 0, duration: 120, ...extra });
const mixProject = (tracks: Array<Track>, master?: Project["master"]): Project => ({
  format: "uncut/0",
  name: "Mix",
  canvas: { width: 640, height: 360, fps: FPS },
  media: media(),
  tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [] }, ...tracks],
  ...(master ? { master } : {}),
});

/** The export's mix of a project, as 32-bit float WAV. */
function mix(project: Project, name: string): string {
  const plan = planExport(project, { mediaPath: (m) => m.path, width: 640, height: 360 });
  if ("problem" in plan) throw new Error(plan.problem);
  const g = audioGraph(plan, 0);
  const graph = join(dir, `out-${name}.txt`);
  writeFileSync(graph, g.filters.join(";\n"));
  const out = join(dir, `out-${name}.wav`);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-y", ...g.inputs, "-/filter_complex", graph, "-map", "[aout]", "-c:a", "pcm_f32le", out], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr.slice(-800));
  return out;
}
/** Both channels of a file as float samples (48 kHz), decoded by ffmpeg. */
function samples(file: string): { left: Float32Array; right: Float32Array } {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a", "-f", "f32le", "-ac", "2", "-ar", "48000", "-"], { maxBuffer: 1 << 28 });
  const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const n = all.length / 2;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) ((left[i] = all[2 * i]!), (right[i] = all[2 * i + 1]!));
  return { left, right };
}
const rmsOf = (a: Float32Array, from: number, to: number) => {
  let s = 0;
  const i0 = Math.round(from * 48000);
  const i1 = Math.min(a.length, Math.round(to * 48000));
  for (let i = i0; i < i1; i++) s += a[i]! ** 2;
  return Math.sqrt(s / Math.max(1, i1 - i0));
};
/** Per-channel RMS (dBFS) over [from, to) seconds, from ffmpeg's astats. */
function astats(file: string, from: number, to: number): { left: number; right: number } {
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      file,
      "-map",
      "0:a",
      "-af",
      `atrim=start=${from}:end=${to},astats=measure_perchannel=RMS_level:measure_overall=none`,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  const levels = [...r.stderr.matchAll(/RMS level dB: (-?[\d.]+|-inf)/g)].map((m) => (m[1] === "-inf" ? -Infinity : Number(m[1])));
  assert.equal(levels.length, 2, r.stderr.slice(-600));
  return { left: levels[0]!, right: levels[1]! };
}
/** Integrated loudness (LUFS) from ffmpeg's ebur128. */
function lufs(file: string): number {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-map", "0:a", "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" });
  const m = /Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(r.stderr);
  assert.ok(m, r.stderr.slice(-400));
  return Number(m[1]);
}
const within = (got: number, want: number, tol: number, what: string) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: ${got.toFixed(2)} vs ${want.toFixed(2)} (±${tol})`);

/** Core's prediction of a channel's RMS over [from, to): each item's tone RMS × its output gain, power-summed per 1/480 s step. */
function predicted(project: Project, channel: "left" | "right", from: number, to: number, toneRms: (item: Item, channel: "left" | "right") => number): number {
  const { starts } = layout(project);
  let sum = 0;
  let n = 0;
  for (let t = from + 1 / 960; t < to; t += 1 / 480) {
    let p = 0;
    for (const track of project.tracks) {
      track.items.forEach((item, index) => {
        const local = t * FPS - (starts.get(item.id) ?? 0);
        if (local < 0 || local >= item.duration) return;
        p += (outputGains(project, track, index, local)[channel] * toneRms(item, channel)) ** 2;
      });
    }
    sum += p;
    n++;
  }
  return Math.sqrt(sum / n);
}
const tone = (item: Item, channel: "left" | "right") => (item.media === "m-stereo" ? (channel === "left" ? 0.2 : 0.1) / Math.SQRT2 : TONE_RMS);

test(
  "pan: −1 is all left at 0 dB (right below −40 dB), 0 is unchanged, ±0.5 is on the law within 0.5 dB, never a boost; stereo is balanced",
  { skip, timeout: 60000 },
  () => {
    const ref = dB(TONE_RMS);
    const at = (pan: number) =>
      astats(
        mix(mixProject([{ id: "voice", kind: "audio", name: "Voice", mixer: pan ? { pan } : {}, items: [audioItem("v", "m-voice")] }]), `pan${pan}`),
        0.5,
        3.5,
      );
    const centre = at(0);
    within(centre.left, ref, 0.1, "centre left");
    within(centre.right, ref, 0.1, "centre right");
    const left = at(-1);
    within(left.left, ref, 0.1, "hard left: left stays at 0 dB");
    assert.ok(left.right < left.left - 40, `hard left: right ${left.right} dB vs left ${left.left} dB`);
    const half = at(0.5);
    within(half.left, ref + dB(panGains(0.5).left), 0.5, "+0.5 left (far side)");
    within(half.right, ref, 0.5, "+0.5 right (near side, 0 dB)");
    within(half.left, ref - 5.33, 0.5, "+0.5: the far side −5.3 dB");
    // Stereo at −0.5: each side keeps its own channel (L × 1, R × √2·sin(π/8)), nothing folds over.
    const st = astats(
      mix(mixProject([{ id: "st", kind: "audio", name: "Stereo", mixer: { pan: -0.5 }, items: [audioItem("s", "m-stereo")] }]), "stereo"),
      0.5,
      3.5,
    );
    within(st.left, dB(0.2 / Math.SQRT2), 0.5, "stereo left unchanged");
    within(st.right, dB(0.1 / Math.SQRT2) + dB(panGains(-0.5).right), 0.5, "stereo right −5.3 dB");
    // A full-scale source panned hard stays at full scale (no boost, no clipping). The master limiter (D86) is bypassed
    // here: this is about the pan law (effects-export.test.ts checks the limiter).
    const peak = Number(
      /Peak level dB: (-?[\d.]+)/.exec(
        spawnSync(
          "ffmpeg",
          [
            "-hide_banner",
            "-i",
            mix(
              mixProject([{ id: "voice", kind: "audio", name: "Voice", mixer: { pan: -1, gainDb: 12 }, items: [audioItem("v", "m-voice")] }], {
                effects: [{ module: "audio.limiter", bypass: true }],
              }),
              "loud",
            ),
            "-af",
            "astats=measure_perchannel=none",
            "-f",
            "null",
            "-",
          ],
          { encoding: "utf8" },
        ).stderr,
      )?.[1],
    );
    within(peak, dB(0.25) + 12, 0.1, "+12 dB and hard left: the peak is the gain's, nothing more");
  },
);

test("volume: a track at −6 dB is 6 ±0.5 dB quieter; the master volume applies after the sum", { skip, timeout: 60000 }, () => {
  const tracks = (gainDb?: number): Array<Track> => [
    { id: "voice", kind: "audio", name: "Voice", ...(gainDb ? { mixer: { gainDb } } : {}), items: [audioItem("v", "m-voice")] },
    { id: "music", kind: "audio", name: "Music", items: [audioItem("m", "m-music")] },
  ];
  const voiceOnly = (gainDb?: number) => astats(mix(mixProject([tracks(gainDb)[0]!]), `voice${gainDb ?? 0}`), 0.5, 3.5).left;
  within(voiceOnly() - voiceOnly(-6), 6, 0.5, "track −6 dB");
  // Two tones summed (different pitches: powers add), then the master: −4 dB.
  const sum = astats(mix(mixProject(tracks()), "sum"), 0.5, 3.5).left;
  const master = astats(mix(mixProject(tracks(), { gainDb: -4 }), "master"), 0.5, 3.5).left;
  within(sum, dB(TONE_RMS) + 3.0103, 0.2, "two equal tones sum by +3 dB");
  within(sum - master, 4, 0.3, "master −4 dB");
  const silent = astats(mix(mixProject(tracks(), { gainDb: -60 }), "master-off"), 0.5, 3.5).left;
  assert.ok(silent < -100, `master at −∞: ${silent}`);
});

test("solo: only soloed tracks are mixed; a muted solo silences everything", { skip, timeout: 60000 }, () => {
  // Voice over 0–2 s, music over 2–4 s.
  const project = (voice: Track["mixer"], music: Track["mixer"] = {}) =>
    mixProject([
      { id: "voice", kind: "audio", name: "Voice", mixer: voice, items: [audioItem("v", "m-voice", { duration: 60 })] },
      { id: "music", kind: "audio", name: "Music", mixer: music, items: [audioItem("m", "m-music", { start: 60, duration: 60 })] },
    ]);
  const both = samples(mix(project({}), "solo-none"));
  assert.ok(dB(rmsOf(both.left, 2.5, 3.5)) > -20, "without solo the music plays");
  const solo = samples(mix(project({ solo: true }), "solo-voice"));
  within(dB(rmsOf(solo.left, 0.5, 1.5)), dB(TONE_RMS), 0.1, "the soloed voice as before");
  assert.ok(dB(rmsOf(solo.left, 2.5, 3.5)) < -100, "the music is silent while the voice is soloed");
  const mutedSolo = samples(mix(project({ solo: true, mute: true }, {}), "solo-muted"));
  assert.ok(dB(rmsOf(mutedSolo.left, 0.2, 3.8)) < -100, "a muted solo: nothing sounds");
});

test(
  "gainKeys: a ramp gives core's RMS in every 0.1 s window (±0.5 dB); a mix with pan, keys, a fade and master lands on core's LUFS (±1 dB)",
  { skip, timeout: 60000 },
  () => {
    // Voice: 0 dB at 0.5 s → −20 dB at 2.5 s (linear in dB), held; panned 0.3 right.
    const project = mixProject(
      [
        {
          id: "voice",
          kind: "audio",
          name: "Voice",
          mixer: { pan: 0.3 },
          items: [
            audioItem("v", "m-voice", {
              duration: 150,
              gainKeys: [
                { frame: 15, db: 0 },
                { frame: 75, db: -20 },
              ],
            }),
          ],
        },
        {
          id: "music",
          kind: "audio",
          name: "Music",
          mixer: { gainDb: -6, pan: -0.6 },
          items: [audioItem("m", "m-music", { duration: 150, fadeIn: 30, fadeOut: 45 })],
        },
      ],
      { gainDb: -2 },
    );
    const voiceOnly = mixProject([project.tracks[1]!], project.master);
    const s = samples(mix(voiceOnly, "ramp"));
    for (let t = 0; t + 0.1 <= 4.9; t += 0.1) {
      for (const ch of ["left", "right"] as const)
        within(dB(rmsOf(s[ch], t, t + 0.1)), dB(predicted(voiceOnly, ch, t, t + 0.1, tone)), 0.5, `ramp ${ch} at ${t.toFixed(1)} s`);
    }
    const both = mix(project, "full");
    const all = samples(both);
    for (let t = 0; t + 0.25 <= 4.9; t += 0.25) {
      for (const ch of ["left", "right"] as const)
        within(dB(rmsOf(all[ch], t, t + 0.25)), dB(predicted(project, ch, t, t + 0.25, tone)), 0.5, `mix ${ch} at ${t.toFixed(2)} s`);
    }
    // LUFS: the predicted mix rendered as the sum of pure tones with core's gains, measured the same way.
    const want = join(dir, "want.wav");
    const exprs = (ch: "left" | "right") => {
      // A step function per 10 ms of core's gains, as an aevalsrc expression would be too long: write raw samples instead.
      const n = Math.round(5 * 48000);
      const out = new Float32Array(n);
      const { starts } = layout(project);
      for (let i = 0; i < n; i++) {
        const t = i / 48000;
        let v = 0;
        for (const track of project.tracks)
          track.items.forEach((item, index) => {
            const local = t * FPS - (starts.get(item.id) ?? 0);
            if (local < 0 || local >= item.duration) return;
            const f = item.media === "m-voice" ? 440 : 660;
            v += outputGains(project, track, index, local)[ch] * 0.25 * Math.sin(2 * Math.PI * f * t);
          });
        out[i] = v;
      }
      return out;
    };
    const l = exprs("left");
    const r = exprs("right");
    const inter = new Float32Array(l.length * 2);
    for (let i = 0; i < l.length; i++) ((inter[2 * i] = l[i]!), (inter[2 * i + 1] = r[i]!));
    writeFileSync(join(dir, "want.f32"), Buffer.from(inter.buffer));
    ff("-f", "f32le", "-ar", "48000", "-ac", "2", "-i", join(dir, "want.f32"), "-c:a", "pcm_f32le", want);
    within(lufs(both), lufs(want), 1, "LUFS of the export vs core's mix");
  },
);

test("the full export command (picture + AAC) carries pan, track volume and master", { skip, timeout: 120000 }, () => {
  const project = mixProject([{ id: "voice", kind: "audio", name: "Voice", mixer: { pan: -1, gainDb: -6 }, items: [audioItem("v", "m-voice")] }], {
    gainDb: -3,
  });
  const plan = planExport(project, { mediaPath: (m) => m.path, width: 640, height: 360 });
  assert.ok(!("problem" in plan));
  const out = join(dir, "full.mp4");
  const cmd = exportCommand(plan, {
    background: join(dir, "bg.png"),
    rasters: new Map(),
    caps: { encoders: new Set(["libx264"]), videotoolboxDecode: false, major: 8 },
    quality: "draft",
    output: out,
  });
  writeFileSync(join(dir, "full-graph.txt"), cmd.graph);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-y", ...cmd.inputs, "-/filter_complex", join(dir, "full-graph.txt"), ...cmd.outputArgs], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr.slice(-800));
  assert.equal(silentFailure(r.stderr), undefined);
  const got = astats(out, 0.5, 3.5);
  within(got.left, dB(TONE_RMS) - 6 - 3, 0.5, "AAC: left = tone (pan −1 keeps it) −6 (track) −3 (master)");
  assert.ok(got.right < got.left - 40, `AAC: right ${got.right} vs left ${got.left}`);
});
