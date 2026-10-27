// The measure tool's sound (handoff point 15): the export's mix read by ebur128 per role, on tones
// of known level. A voice, a music bed 15 dB under it and an effect 25 dB under it give those gaps
// (within 1 dB) and verdicts; raising the effect by 15 dB makes it too loud with the gain change
// that fixes it; the master reads at the project's loudness target as exported.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { soundRoles, type Item, type Project, type Track } from "../../packages/core/src/index.ts";
import { parseMixMeasure } from "../../apps/server/src/export/plan/mixMeasure.ts";
import { makeMixMeasure } from "../../apps/server/src/export/exporter/mixMeasure.ts";
import { effectVerdict, gatedLoudness, mixLines, mixReport, EFFECT_UNDER_VOICE } from "../../apps/server/src/agent/agentMix.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = hasFfmpeg ? false : "needs ffmpeg";
const ffmpeg = (() => {
  const r = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" });
  return r.stdout.trim() || "ffmpeg";
})();
const FPS = 30;
const VOICE = 0.2;
let dir = "";
const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
const amp = (underDb: number) => VOICE * 10 ** (-underDb / 20);

before(() => {
  if (skip) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "uncut-mix-measure-")));
  ff("-f", "lavfi", "-i", `aevalsrc=${VOICE}*sin(2*PI*1000*t):s=48000:d=10`, "-c:a", "pcm_f32le", join(dir, "narration.wav"));
  ff("-f", "lavfi", "-i", `aevalsrc=${amp(15)}*sin(2*PI*1200*t):s=48000:d=10`, "-c:a", "pcm_f32le", join(dir, "music-bed.wav"));
  ff("-f", "lavfi", "-i", `aevalsrc=${amp(25)}*sin(2*PI*1100*t):s=48000:d=1`, "-c:a", "pcm_f32le", join(dir, "whoosh.wav"));
});
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const item = (id: string, media: string, start: number, duration: number, extra: Partial<Item> = {}): Item => ({
  id,
  type: "audio",
  media,
  in: 0,
  start,
  duration,
  ...extra,
});
function project(effect: Partial<Item> = {}): Project {
  const tracks: Array<Track> = [
    { id: "main", kind: "video", role: "main", name: "Main", items: [] },
    { id: "vo", kind: "audio", name: "Voiceover", items: [item("vo-1", "m-voice", 0, 300)] },
    { id: "bed", kind: "audio", name: "Music", items: [item("bed-1", "m-music", 0, 300)] },
    { id: "sfx", kind: "audio", name: "Sound effects", items: [item("sfx-1", "m-whoosh", 120, 30, effect)] },
  ];
  return {
    format: "uncut/0",
    name: "Mix",
    canvas: { width: 640, height: 360, fps: FPS },
    media: [
      { id: "m-voice", kind: "audio", name: "narration.wav", path: join(dir, "narration.wav"), probe: { frames: 300 } },
      { id: "m-music", kind: "audio", name: "music-bed.wav", path: join(dir, "music-bed.wav"), probe: { frames: 300 } },
      { id: "m-whoosh", kind: "audio", name: "whoosh.wav", path: join(dir, "whoosh.wav"), probe: { frames: 30 } },
    ],
    tracks,
  };
}

const measure = async (p: Project) => {
  const traces = await makeMixMeasure()(ffmpeg, p, (m) => m.path, new Map());
  assert.ok(traces && !("problem" in traces), JSON.stringify(traces));
  return traces;
};

test("roles: the voiceover is voice, the bed music, the short named sound an effect", { skip }, () => {
  const roles = soundRoles(project());
  assert.equal(roles.get("vo-1")?.role, "voice");
  assert.equal(roles.get("bed-1")?.role, "music");
  assert.equal(roles.get("sfx-1")?.role, "effects");
  assert.equal(roles.get("sfx-1")?.kind, "whoosh");
});

test("with no speech track, the main track's own sound is the voice", () => {
  const p: Project = {
    format: "uncut/0",
    name: "Talk",
    canvas: { width: 640, height: 360, fps: FPS },
    media: [{ id: "m-cam", kind: "video", name: "camera.mp4", path: "/x/camera.mp4", probe: { frames: 300, hasAudio: true } }],
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "cam-1", type: "clip", media: "m-cam", in: 0, duration: 300 }] }],
  };
  assert.equal(soundRoles(p).get("cam-1")?.role, "voice");
});

test("the mix by role: the effect 25 dB and the music 15 dB under the voice, the master at the target", { skip }, async () => {
  const traces = await measure(project());
  assert.ok(traces.roles.voice && traces.roles.music && traces.roles.effects);
  assert.equal(traces.master.momentary.length, 100, "one reading per 0.1 s of the 10 s mix");
  const report = mixReport(project(), traces);
  assert.equal(report.master.targetLufs, -14);
  assert.ok(Math.abs(report.roles.voice!.lufs! - -14) < 0.5, `the voice dominates the master: ${report.roles.voice!.lufs}`);
  assert.ok(Math.abs(report.roles.voice!.lufs! - report.roles.music!.lufs! - 15) < 1, JSON.stringify(report.roles));
  const [effect] = report.effects;
  assert.ok(effect);
  assert.equal(effect.item, "sfx-1");
  assert.equal(effect.at, 4);
  assert.equal(effect.against, "voice");
  assert.ok(Math.abs(effect.under! - 25) < 1, `the effect sits ${effect.under} dB under`);
  assert.match(effect.verdict, /fine/);
  assert.match(report.music ?? "", /sits 1[45](\.\d)? dB under the voice: fine/);
  assert.equal(report.overTime.voice?.length, 10, "one short-term reading per second");
  const lines = mixLines(report);
  assert.match(lines[0]!, /^Measured mix: integrated loudness as exported, master −14\.0 LUFS, voice −1\d\.\d LUFS, music/);
  assert.ok(lines.some((l) => /measured sound effect 4\.0 s whoosh\.wav \(whoosh\)/.test(l)));
});

test("an effect raised 15 dB reads too loud, with the cut that puts it back in the band", { skip }, async () => {
  const p = project({ gainDb: 15 });
  const [effect] = mixReport(p, await measure(p)).effects;
  assert.ok(effect && Math.abs(effect.under! - 10) < 1, `${effect?.under}`);
  assert.match(effect.verdict, /likely too loud for a background effect \(typical 22 to 30 dB under\); lower its gain by about 1[56] dB/);
});

test("a muted track and a faded-out effect: the role is left out, the effect reads silent", { skip }, async () => {
  const p = project({ gainDb: -80 });
  const report = mixReport(p, await measure(p));
  assert.equal(report.effects[0]?.peak, null);
  assert.match(report.effects[0]!.verdict, /silent in the mix/);
  const muted = project();
  const sfx = muted.tracks.find((t) => t.id === "sfx")!;
  const mutedTracks = muted.tracks.map((t) => (t === sfx ? { ...t, mixer: { mute: true } } : t));
  const traces = await measure({ ...muted, tracks: mutedTracks });
  assert.equal(traces.roles.effects, undefined);
});

test("parsing: ebur128's readings, silence floored, integrated from the last block", () => {
  const out = [
    "frame:0    pts:0       pts_time:0",
    "lavfi.r128.M=-120.691",
    "lavfi.r128.S=-inf",
    "lavfi.r128.I=-70.000",
    "lavfi.r128.true_peak=0.000",
    "frame:1    pts:4800    pts_time:0.1",
    "lavfi.r128.M=-20.5",
    "lavfi.r128.S=-22.0",
    "lavfi.r128.I=-21.300",
    "lavfi.r128.true_peak=0.5",
  ].join("\n");
  const t = parseMixMeasure(out);
  assert.deepEqual(t.momentary, [-120, -20.5]);
  assert.deepEqual(t.shortTerm, [-120, -22]);
  assert.equal(t.lufs, -21.3);
  assert.equal(t.truePeak, -6);
  assert.equal(parseMixMeasure("lavfi.r128.I=-70.000\n").lufs, null);
});

test("verdicts and the gate", () => {
  assert.match(effectVerdict(5, "voice"), /5 dB under the voice: likely too loud.*lower its gain by about 21 dB/);
  assert.match(effectVerdict(-3, "voice"), /3 dB over the voice: likely too loud/);
  assert.match(effectVerdict(26, "voice"), /fine/);
  assert.match(effectVerdict(36, "voice"), /likely too quiet to notice.*raise its gain by about 10 dB/);
  assert.match(effectVerdict(10, "music"), /under the music: fine/);
  assert.match(effectVerdict(null, null), /nothing else sounding/);
  assert.equal(EFFECT_UNDER_VOICE.min, 22);
  assert.equal(Math.round(gatedLoudness([-20, -20, -20, -20, -20, -120, -120])!), -20);
  assert.equal(gatedLoudness([-20, -20, -120]), undefined, "under half a second of sound");
});
