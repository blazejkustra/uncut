// D327: speed ramps and reverse through ffmpeg. The source (320×180, 30 fps, 72 frames) shows its
// frame number as its grey level (16 + 3n, lossless), with a 440 Hz tone that grows louder; each
// exported frame's mean level says which source frame is on screen, compared with core's sourceAt
// (the last source frame starting at or before its source time, D38). Reversed clips go through
// the server's reversed copy (media/reversed.ts), made in chunks.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyEdit,
  createSession,
  layout,
  presetKeys,
  RAMP_PRESETS,
  sourceAt,
  type Item,
  type Media,
  type Project,
  type ReverseRange,
} from "../../packages/core/src/index.ts";
import { exportCommand, planExport, silentFailure } from "../../apps/server/src/export/exportPlan.ts";
import { BYTES_PER_PIXEL, chunkVideoArgs, ensureReversed, reverseChunks, reverseTargets, REVERSE_BUFFER_BYTES } from "../../apps/server/src/media/reversed.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = hasFfmpeg ? false : "needs ffmpeg";
const W = 320;
const H = 180;
const FPS = 30;
const FRAMES = 72;
let dir = "";

before(() => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "uncut-ramp-export-"));
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${W}x${H}:r=${FPS}:d=${FRAMES / FPS},format=yuv420p,geq=lum='16+3*N':cb=128:cr=128`,
    "-f",
    "lavfi",
    "-i",
    `aevalsrc='0.8*(t/${FRAMES / FPS})*sin(2*PI*440*t)':s=48000:d=${FRAMES / FPS}`,
    "-c:v",
    "libx264",
    "-qp",
    "0",
    "-g",
    "10",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-threads",
    "4",
    join(dir, "count.mp4"),
  ]);
});
after(() => dir && rmSync(dir, { recursive: true, force: true }));

const media = (): Media => ({
  id: "m",
  kind: "video",
  name: "count.mp4",
  path: join(dir, "count.mp4"),
  probe: { frames: FRAMES, fps: FPS, width: W, height: H, hasAudio: true },
});
const project = (clip: Item): Project => ({
  format: "uncut/0",
  name: "Ramp",
  canvas: { width: W, height: H, fps: FPS, background: "#000000" },
  media: [media()],
  tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [clip] }],
});

/** Exports a project; each frame's source frame number (from its grey level) and the audio's length and loudness by halves. */
async function exported(name: string, p: Project) {
  const targets = await reverseTargets(p, join(dir, name), (m) => m.path);
  // Chunks of 9 frames, so a copy is joined from several.
  for (const t of targets) await ensureReversed(t, { ffmpeg: "ffmpeg", fps: FPS, bufferBytes: W * H * BYTES_PER_PIXEL * 9 });
  const files = new Map(targets.map((t) => [`${t.media.id}|${t.range.from}-${t.range.to}`, t.output]));
  const plan = planExport(p, {
    mediaPath: (m) => m.path,
    width: W,
    height: H,
    reversedFile: (m: Media, r: ReverseRange) => files.get(`${m.id}|${r.from}-${r.to}`)!,
  });
  if ("problem" in plan) throw new Error(plan.problem);
  const bg = join(dir, "bg.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}`, "-frames:v", "1", bg]);
  const cmd = exportCommand(plan, {
    background: bg,
    rasters: new Map(),
    caps: { encoders: new Set(["libx264"]), videotoolboxDecode: false, major: 8 },
    quality: "high",
    output: join(dir, `${name}.mp4`),
  });
  writeFileSync(join(dir, `${name}.txt`), cmd.graph);
  const out = join(dir, `${name}.mkv`);
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-threads",
      "4",
      ...cmd.inputs,
      "-/filter_complex",
      join(dir, `${name}.txt`),
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-c:v",
      "ffv1",
      "-c:a",
      "pcm_s16le",
      out,
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, `${name}: ${r.stderr.slice(-1500)}`);
  assert.equal(silentFailure(r.stderr), undefined);
  const grey = execFileSync("ffmpeg", ["-v", "error", "-i", out, "-vf", "extractplanes=y,scale=8:8:flags=area", "-f", "rawvideo", "-"], {
    maxBuffer: 64 << 20,
  });
  const shown: Array<number> = [];
  for (let i = 0; i + 64 <= grey.length; i += 64) {
    let sum = 0;
    for (let k = 0; k < 64; k++) sum += grey[i + k]!;
    shown.push(Math.round((sum / 64 - 16) / 3));
  }
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", out, "-map", "0:a", "-ac", "1", "-f", "s16le", "-"], { maxBuffer: 64 << 20 });
  const samples = pcm.length / 2;
  const rms = (a: number, b: number) => {
    let s = 0;
    for (let i = a; i < b; i++) s += (pcm.readInt16LE(i * 2) / 32768) ** 2;
    return Math.sqrt(s / Math.max(1, b - a));
  };
  return { shown, seconds: samples / 48000, first: rms(0, samples / 2), second: rms(samples / 2, samples), frames: plan.frames };
}

/** The source frame core says frame f shows (D38): the last one starting at or before its source time. */
const expected = (p: Project, clip: Item, f: number) => Math.floor((sourceAt(p, clip, f) + 0.0001) * FPS + 1e-9);

test("D327: a ramped clip shows the source frame core's curve gives at every frame", { skip, timeout: 120000 }, async () => {
  const keys = presetKeys(RAMP_PRESETS.hero!, 50);
  const clip: Item = { id: "c", type: "clip", media: "m", in: 4, duration: 50, speedKeys: keys };
  const p = project(clip);
  const got = await exported("hero", p);
  assert.equal(got.shown.length, 50);
  const want = Array.from({ length: 50 }, (_, f) => expected(p, clip, f));
  assert.deepEqual(got.shown, want);
  // The slow middle repeats frames; the fast ends skip some.
  assert.ok(want.some((v, i) => i > 0 && v === want[i - 1]));
  assert.ok(want.some((v, i) => i > 0 && v - want[i - 1]! > 1));
  // A ramped clip is silent, and the sound track still lasts as long as the video.
  assert.ok(Math.abs(got.seconds - 50 / FPS) < 0.03, `audio ${got.seconds} s`);
  assert.ok(got.first < 0.01 && got.second < 0.01);
});

test("D327: a split ramp exports the same frames as the whole (within the split's rounding of in)", { skip, timeout: 120000 }, async () => {
  const keys = presetKeys(RAMP_PRESETS.bullet!, 40);
  const whole: Item = { id: "c", type: "clip", media: "m", in: 0, duration: 40, speedKeys: keys };
  const p = project(whole);
  const want = Array.from({ length: 40 }, (_, f) => expected(p, whole, f));
  assert.deepEqual((await exported("bullet", p)).shown, want);
  const split = applyEdit(createSession(p), { actor: "user", ops: [{ op: "split_item", item: "c", at: 17, newId: "d" }] }).project;
  const got = (await exported("bullet-split", split)).shown;
  assert.deepEqual(got.slice(0, 17), want.slice(0, 17));
  got.slice(17).forEach((v, i) => assert.ok(Math.abs(v - want[17 + i]!) <= 1, `frame ${17 + i}: ${v} vs ${want[17 + i]}`));
});

test("D327: a reversed clip shows its source frames in reverse order, and its sound backwards", { skip, timeout: 120000 }, async () => {
  // in counts from the media's end: in 12 and 40 frames = media frames 59 down to 20.
  const clip: Item = { id: "c", type: "clip", media: "m", in: 12, duration: 40, reverse: true };
  const p = project(clip);
  const got = await exported("reverse", p);
  assert.deepEqual(
    got.shown,
    Array.from({ length: 40 }, (_, f) => FRAMES - 1 - 12 - f),
  );
  assert.ok(Math.abs(got.seconds - 40 / FPS) < 0.03, `audio ${got.seconds} s`);
  // The tone grows louder in the source, so backwards it gets quieter.
  assert.ok(got.first > got.second * 1.3, `first half ${got.first}, second ${got.second}`);
});

test("D327: reverse at 2× and with a ramp", { skip, timeout: 120000 }, async () => {
  const fast: Item = { id: "c", type: "clip", media: "m", in: 0, duration: 30, speed: 2, reverse: true };
  const got = await exported("reverse-2x", project(fast));
  assert.deepEqual(
    got.shown,
    Array.from({ length: 30 }, (_, f) => FRAMES - 1 - 2 * f),
  );
  assert.ok(Math.abs(got.seconds - 1) < 0.03);
  const ramp: Item = { id: "c", type: "clip", media: "m", in: 2, duration: 40, reverse: true, speedKeys: presetKeys(RAMP_PRESETS.flashIn!, 40) };
  const p = project(ramp);
  const r = await exported("reverse-ramp", p);
  const forward = Array.from({ length: 40 }, (_, f) => Math.floor(2 + (sourceAt(p, ramp, f) - sourceAt(p, ramp, 0)) * FPS + 0.0001 * FPS + 1e-9));
  assert.deepEqual(
    r.shown,
    forward.map((v) => FRAMES - 1 - v),
  );
  assert.equal(layout(p).duration, 40);
});

test("D327: reversed copies are made in chunks that fit the memory budget", () => {
  const big: Pick<Media, "probe"> = { probe: { frames: 3600, fps: 60, width: 3840, height: 2160 } };
  const chunks = reverseChunks({ from: 0, to: 600 }, 60, big);
  const frames = Math.max(...chunks.map((c) => c.to - c.from));
  assert.ok(frames * 3840 * 2160 * BYTES_PER_PIXEL <= REVERSE_BUFFER_BYTES, `${frames} frames a chunk`);
  // No probe: sized as 4K.
  assert.deepEqual(reverseChunks({ from: 0, to: 600 }, 60, {}), chunks);
  assert.deepEqual(chunks[0]!.to, 600);
  assert.deepEqual(chunks.at(-1)!.from, 0);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i]!.to, chunks[i - 1]!.from);
  const args = chunkVideoArgs("in.mp4", { from: 60, to: 90 }, 60, 60, { bin: "ffmpeg", args: [] }, "out.mp4");
  assert.ok(args.includes("-threads"));
  assert.match(args.join(" "), /reverse/);
});
