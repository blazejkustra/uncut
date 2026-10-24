// Phase 3 chunk 5: `uncut-media probe` (headers only, no ffmpeg) agrees with ffprobe on real
// footage and on files made here with ffmpeg. The user's footage is only read, never written.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DJI_CLIP, DJI_STILL, FIRST_FLIGHT } from "../helpers/footage.ts";

const BIN = resolve("native/media/target/release/uncut-media");
const hasFfmpeg = !spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).error && !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(BIN) ? "media core not built (run pnpm build)" : !hasFfmpeg ? "needs ffmpeg and ffprobe for the comparison" : false;

const REAL = [DJI_CLIP, FIRST_FLIGHT, DJI_STILL, resolve("fixtures/synth-hevc10.mp4"), resolve("fixtures/trim-proxy.mp4")];

let dir: string;
const made: Record<string, string> = {};
const ffmpeg = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

before(() => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "uncut-probe-"));
  const p = (name: string) => (made[name] = join(dir, name));
  ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac", p("audio-only.mov"));
  ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=1.5", "-c:a", "aac", p("audio-only.m4a"));
  for (const [name, rate] of [
    ["24fps.mp4", "24"],
    ["25fps.mp4", "25"],
    ["29.97fps.mp4", "30000/1001"],
  ]) {
    ffmpeg("-f", "lavfi", "-i", `testsrc=size=320x240:rate=${rate}`, "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", p(name));
  }
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=640x360:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=1",
    "-t",
    "1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    p("with-audio.mov"),
  );
  // A phone-style clip: stored landscape, shown turned 90°.
  ffmpeg("-display_rotation", "-90", "-i", made["25fps.mp4"]!, "-c", "copy", p("rotated.mp4"));
  // Fragmented MP4 (moov without sample tables, durations in moof/trun).
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=2",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    "-movflags",
    "frag_keyframe+empty_moov",
    p("fragmented.mp4"),
  );
  ffmpeg("-f", "lavfi", "-i", "testsrc=size=640x360", "-frames:v", "1", p("still.png"));
  ffmpeg("-f", "lavfi", "-i", "testsrc=size=800x600", "-frames:v", "1", p("still.jpg"));
});
after(() => dir && rmSync(dir, { recursive: true, force: true }));

const native = (path: string) => JSON.parse(execFileSync(BIN, ["probe", path], { encoding: "utf8" }));

/** What ffprobe says, in the probe's shape. */
function reference(path: string) {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path], { encoding: "utf8" }));
  const image = /png_pipe|jpeg_pipe|image2/.test(j.format.format_name);
  const videos = j.streams.filter((s: any) => s.codec_type === "video");
  const main = videos.sort((a: any, b: any) => b.width * b.height - a.width * a.height)[0];
  const audio = j.streams.find((s: any) => s.codec_type === "audio");
  const rot = main?.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation;
  const created = j.format.tags?.creation_time;
  return {
    kind: image ? "image" : main ? "video" : "audio",
    width: main?.width,
    height: main?.height,
    fps: image || !main ? undefined : main.r_frame_rate,
    durationSeconds: image ? undefined : Number((main ?? audio).duration),
    videoCodec: main?.codec_name,
    videoProfile: image ? undefined : main?.profile,
    audioCodec: audio?.codec_name,
    hasAudio: Boolean(audio),
    rotation: image || !main ? undefined : ((-(rot ?? 0) % 360) + 360) % 360,
    creationTime: created ? `${created.slice(0, 19)}Z` : undefined,
  };
}

function compare(path: string) {
  const ours = native(path);
  const ref = reference(path);
  assert.equal(ours.via, "native");
  for (const key of ["kind", "width", "height", "fps", "videoCodec", "videoProfile", "audioCodec", "hasAudio", "rotation", "creationTime"] as const) {
    assert.deepEqual(ours[key], ref[key], `${path}: ${key} native=${ours[key]} ffprobe=${ref[key]}`);
  }
  if (ref.durationSeconds !== undefined)
    assert.ok(Math.abs(ours.durationSeconds - ref.durationSeconds) < 0.002, `${path}: duration ${ours.durationSeconds} vs ${ref.durationSeconds}`);
  console.log(`# ${path.split("/").pop()}: ${JSON.stringify({ native: ours, ffprobe: ref })}`);
  return ours;
}

for (const path of REAL) {
  test(`matches ffprobe: ${path.replace(homedir(), "~")}`, { skip: skip || (!existsSync(path) && `${path} isn't here`) }, () => {
    const started = process.hrtime.bigint();
    compare(path);
    console.log(`# ${path.split("/").pop()} probed in ${Number(process.hrtime.bigint() - started) / 1e6} ms (incl. process start)`);
  });
}

test("matches ffprobe on generated files: audio-only, 24/25/29.97 fps, audio+video, rotated, png, jpg", { skip }, () => {
  for (const path of Object.values(made)) compare(path);
  assert.equal(native(made["rotated.mp4"]!).rotation, 90);
  assert.equal(native(made["29.97fps.mp4"]!).fps, "30000/1001");
  assert.equal(native(made["audio-only.mov"]!).kind, "audio");
});

// A reviewer's repro files, when UNCUT_PROBE_REPRO_DIR names their folder. Both files, not just the
// folder: an emptied or half-filled folder skips instead of failing (#89).
const SCRATCH = process.env.UNCUT_PROBE_REPRO_DIR ?? "";
const REPRO = SCRATCH ? ["twoedits.mp4", "frag.mp4"].map((name) => join(SCRATCH, name)) : [];

test("variable frame rate: fps is the most used frame duration (ffprobe packet durations), not r_frame_rate by luck", { skip }, () => {
  // 60 fps for the first second, then every other frame: 60 frames at 1/60 s, 60 at 1/30 s, plus a few odd ones.
  const path = join(dir, "vfr.mp4");
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=60",
    "-t",
    "4",
    "-vf",
    "select='lt(n,60)+not(mod(n,2))+gte(n,180)*not(mod(n,2))'",
    "-fps_mode",
    "vfr",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    path,
  );
  const durations = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=duration", "-of", "csv=p=0", path], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map(Number);
  const tb = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=time_base", "-of", "csv=p=0", path], {
    encoding: "utf8",
  }).trim();
  const counts = new Map();
  for (const d of durations) counts.set(d, (counts.get(d) ?? 0) + 1);
  const mode = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const [num, den] = tb.split("/").map(Number);
  const expected = den / (mode * num);
  const ours = native(path);
  assert.ok(Math.abs(ours.fpsValue - expected) < 1e-6, `native ${ours.fps} vs mode ${expected} fps (${JSON.stringify([...counts])})`);
  console.log(`# vfr: native fps ${ours.fps}; packet-duration mode ${expected}; ffprobe avg_frame_rate differs by design`);
});

test(
  "the reviewer's repro files (when present): two edit-list entries, fragmented, VFR",
  { skip: skip || ((!REPRO.length || !REPRO.every((f) => existsSync(f))) && "set UNCUT_PROBE_REPRO_DIR to the folder with twoedits.mp4 and frag.mp4") },
  () => {
    const twoEdits = native(join(SCRATCH, "twoedits.mp4"));
    assert.equal(twoEdits.durationSeconds, reference(join(SCRATCH, "twoedits.mp4")).durationSeconds);
    const frag = native(join(SCRATCH, "frag.mp4"));
    assert.equal(frag.durationSeconds, 3);
    assert.equal(frag.fps, "30/1");
  },
);

test(
  "the DJI clip: main 4K HEVC track chosen over the MJPEG preview, in well under a second",
  { skip: skip || (!existsSync(REAL[0]) && "DJI clip isn't here") },
  () => {
    native(REAL[0]); // warm the page cache like a second import would
    const started = process.hrtime.bigint();
    const p = native(REAL[0]);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.deepEqual([p.width, p.height, p.fps, p.videoCodec, p.videoProfile, p.hasAudio], [3840, 2160, "60000/1001", "hevc", "Main 10", false]);
    assert.ok(ms < 1000, `${ms} ms`);
    console.log(`# DJI 3.6 GB probe, warm: ${ms.toFixed(1)} ms`);
  },
);

test("typed errors: missing file, folder, and something that isn't media", { skip: skip && skip.startsWith("media core") ? skip : false }, () => {
  const run = (path: string) => JSON.parse(spawnSync(BIN, ["probe", path], { encoding: "utf8" }).stdout);
  assert.equal(run("/nope/missing.mp4").error.code, "not-found");
  assert.equal(run(tmpdir()).error.code, "unsupported");
  assert.equal(run(resolve("package.json")).error.code, "unsupported");
});
