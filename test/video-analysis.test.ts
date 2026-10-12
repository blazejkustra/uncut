// Phase 5 chunk 3 (D67), in process: the video analyzer (one ffmpeg pass, phase correlation in
// TS), its scores and the queue/cache around it.
// - Synthetic takes made here with ffmpeg lavfi: a smooth pan over a still, the same pan with
//   per-frame jitter, and the smooth pan blurred: ranked smooth > jittered > blurred, clearly apart.
// - Hard cuts at known frames: found within ±1 frame. A hold in a pan: a frozen stretch.
// - Through the AnalysisQueue: cached at .cache/analysis/<fp>/video.json; a re-ask runs no ffmpeg.
// - The maths: phase correlation finds a known sub-pixel shift, smoothing keeps a steady pan,
//   the best stretch stays inside one shot.
// - Speed on a real DJI clip (≥ 4× realtime): only with UNCUT_DJI_PERF=1 and the user's footage
//   folder present (read only, never copied); it takes about a minute.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { AnalysisQueue, cacheFile, fingerprint, spawnRunner, type AnalysisTarget, type Runner } from "../apps/server/src/analysis.ts";
import { analyzeVideo, PhaseCorrelator, smooth, windowsOf, type VideoResult } from "../apps/server/src/videoAnalysis.ts";
import { bestStretch, cleanOf, meanScores, shotsOf, stabilityOf, sharpnessOf } from "../apps/server/src/videoScores.ts";
import { framesFor, videoOut } from "../apps/server/src/agentVideo.ts";

const ffmpegPath = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
})();
const skip = ffmpegPath ? false : "ffmpeg isn't installed";
const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
const FPS = 30;

let root = "";
const clip = (name: string) => join(root, name);
const signal = () => new AbortController().signal;
const results = new Map<string, VideoResult>();
const analyze = async (name: string) => {
  const known = results.get(name);
  if (known) return known;
  const r = await analyzeVideo(ffmpegPath!, clip(name), { signal: signal() });
  results.set(name, r);
  return r;
};

/** A pan over a still: crop x/y expressions (n = frame, t = seconds), 640×360 at 30 fps for 6 s, then extra filters. */
const pan = (out: string, x: string, y: string, extra = "") =>
  ff("-loop", "1", "-framerate", String(FPS), "-i", clip("still.png"), "-t", "6", "-vf", `crop=640:360:x='${x}':y='${y}'${extra}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", clip(out));

before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-video-analysis-")));
  // A 1600×900 still with edges and texture to pan over.
  ff("-f", "lavfi", "-i", "testsrc2=s=1600x900:d=1", "-frames:v", "1", clip("still.png"));
  // 60 px/s right and 20 px/s down; the jittered take adds a few pixels of per-frame shake.
  pan("smooth.mp4", "100+t*60", "80+t*20");
  pan("jittered.mp4", "100+t*60+3*sin(n*2.7)+2*sin(n*5.3)", "80+t*20+2*sin(n*3.1)+2*sin(n*7.7)");
  pan("blurred.mp4", "100+t*60", "80+t*20", ",gblur=sigma=4");
  // Dropped frames: the smooth pan with frames 60–66 missing (their time stays a gap), like DJI files.
  ff("-i", clip("smooth.mp4"), "-vf", "select='not(between(n,60,66))'", "-fps_mode", "passthrough", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip("dropped.mp4"));
  // A whole second with no frames (frames 55–95 gone, 1.83–3.17 s): second 2 is empty.
  ff("-i", clip("smooth.mp4"), "-vf", "select='not(between(n,55,95))'", "-fps_mode", "passthrough", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip("hole.mp4"));
  // Portrait (360×640) shaking only sideways, and only up and down, by the same amount, over a
  // texture with structure both ways (blobs of smoothed noise; testsrc2's bars have none vertically).
  ff("-f", "lavfi", "-i", "nullsrc=s=400x225,geq=lum='random(1)*255':cb=128:cr=128", "-vf", "scale=1600:900:flags=bicubic", "-frames:v", "1", clip("blobs.png"));
  for (const [name, x, y] of [["portrait-x.mp4", "500+4*sin(n*2.7)+3*sin(n*5.3)", "100"], ["portrait-y.mp4", "500", "100+4*sin(n*2.7)+3*sin(n*5.3)"]] as const) {
    ff("-loop", "1", "-framerate", String(FPS), "-i", clip("blobs.png"), "-t", "4", "-vf", `crop=360:640:x='${x}':y='${y}'`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", clip(name));
  }
  // The resolution changes mid-file (640×360, then 480×360): MPEG-TS segments joined end to end,
  // the second 2 s later. ffmpeg rebuilds its filter graph there.
  ff("-loop", "1", "-framerate", String(FPS), "-i", clip("still.png"), "-t", "2", "-vf", "crop=640:360:x='100+t*60':y=80", "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-muxdelay", "0", "-muxpreload", "0", "-f", "mpegts", clip("part1.ts"));
  ff("-loop", "1", "-framerate", String(FPS), "-i", clip("still.png"), "-t", "2", "-vf", "crop=480:360:x='220+t*60':y=80", "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-muxdelay", "0", "-muxpreload", "0", "-output_ts_offset", "2", "-f", "mpegts", clip("part2.ts"));
  writeFileSync(clip("resized.ts"), Buffer.concat([readFileSync(clip("part1.ts")), readFileSync(clip("part2.ts"))]));
  // A hold: the pan stops from 2 s to 3.5 s.
  pan("hold.mp4", "100+60*min(t,2)+60*max(0,t-3.5)", "80");
  // Hard cuts at frames 45 and 100: test pattern, bars, a fractal (5 s at 30 fps).
  ff(
    "-f", "lavfi", "-i", `testsrc2=s=640x360:r=${FPS}:d=1.5`,
    "-f", "lavfi", "-i", `smptehdbars=s=640x360:r=${FPS}:d=1.8333333`,
    "-f", "lavfi", "-i", `mandelbrot=s=640x360:r=${FPS}`,
    "-filter_complex", "[2]trim=end_frame=50,setpts=PTS-STARTPTS[m];[0][1][m]concat=n=3:v=1:a=0,format=yuv420p",
    "-c:v", "libx264", "-g", "300", clip("cuts.mp4"),
  );
  // DJI-like: a larger default mjpeg stream next to the footage, and a sound.
  ff(
    "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=${FPS}`,
    "-f", "lavfi", "-i", `color=blue:size=1280x720:rate=${FPS}`,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "2", "-map", "0:v", "-map", "1:v", "-map", "2:a",
    "-c:v:0", "libx264", "-pix_fmt:v:0", "yuv420p", "-c:v:1", "mjpeg", "-pix_fmt:v:1", "yuvj420p", "-disposition:v:0", "0", "-disposition:v:1", "default", "-c:a", "aac",
    clip("covered.mp4"),
  );
  ff("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-c:a", "pcm_s16le", clip("tone.wav"));
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("phase correlation finds a known sub-pixel shift; smoothing keeps a steady pan and acceleration exactly", () => {
  // Texture shifted by (5, -2) px at 4× the size, then averaged down 4×4 (as ffmpeg's area
  // scaling does): (1.25, -0.5) px apart at 160×90.
  const W = 160;
  const H = 90;
  const big = (x: number, y: number) => {
    // Value noise: a hash per 3-px cell, bilinear between cells.
    const hash = (i: number, j: number) => {
      const h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
      return h - Math.floor(h);
    };
    const gx = x / 3;
    const gy = y / 3;
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const fx = gx - i;
    const fy = gy - j;
    return (hash(i, j) * (1 - fx) + hash(i + 1, j) * fx) * (1 - fy) + (hash(i, j + 1) * (1 - fx) + hash(i + 1, j + 1) * fx) * fy;
  };
  const frame = (ox: number, oy: number) => {
    const px = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0;
        for (let v = 0; v < 4; v++) for (let u = 0; u < 4; u++) sum += big(x * 4 + u - ox, y * 4 + v - oy);
        px[y * W + x] = Math.round((sum / 16) * 255);
      }
    }
    return px;
  };
  const pc = new PhaseCorrelator();
  assert.equal(pc.push(frame(0, 0), W, H), undefined, "the first frame has nothing to compare with");
  const m = pc.push(frame(5, -2), W, H)!;
  assert.ok(Math.abs(m.dx - 1.25) < 0.15 && Math.abs(m.dy + 0.5) < 0.15, JSON.stringify(m));
  assert.ok(m.peak > 0.3, `a confident match: ${m.peak}`);

  // A steady pan and a steady acceleration (a yaw speeding up) are camera moves, not shake.
  const ramp = Array.from({ length: 50 }, (_, i) => 3 + 0.7 * i);
  const curve = Array.from({ length: 50 }, (_, i) => 1 + 0.2 * i + 0.05 * i * i);
  for (const path of [ramp, curve]) {
    const s = smooth(path, 4.5);
    for (let i = 0; i < path.length; i++) assert.ok(Math.abs(s[i]! - path[i]!) < 1e-6, `unchanged at ${i}: ${s[i]} vs ${path[i]}`);
  }
});

test("synthetic takes: smooth > jittered > blurred, clearly apart; the shake, pan speed and blur behind it", { skip, timeout: 120000 }, async () => {
  const [smoothR, jitterR, blurR] = [await analyze("smooth.mp4"), await analyze("jittered.mp4"), await analyze("blurred.mp4")];
  for (const r of [smoothR, jitterR, blurR]) {
    assert.equal(r.hasVideo, true);
    assert.equal(r.frames, 180);
    assert.ok(Math.abs(r.seconds! - 6) < 0.05, `${r.seconds}`);
    assert.deepEqual(r.cuts, []);
    assert.deepEqual(r.frozen, []);
    assert.equal(r.windows!.length, 6);
  }
  const [a, b, c] = [meanScores(smoothR.windows!), meanScores(jitterR.windows!), meanScores(blurR.windows!)];
  const show = JSON.stringify({ smooth: a, jittered: b, blurred: c });
  assert.ok(a.cleanScore > b.cleanScore + 0.15, show);
  assert.ok(b.cleanScore > c.cleanScore + 0.1, show);
  assert.ok(a.cleanScore > 0.85, show);
  // Each one loses on its own component.
  assert.ok(a.stability! > 0.8 && b.stability! < 0.5 && c.stability! > 0.8, show);
  assert.ok(a.sharpness! > 0.85 && b.sharpness! > 0.85 && c.sharpness! < 0.4, show);
  // The pan is (60, 20) px/s on a 640 px frame: 0.099 widths per second, measured from the motion.
  const speeds = smoothR.windows!.slice(1, -1).map((w) => w.motion!);
  for (const v of speeds) assert.ok(Math.abs(v - Math.hypot(60, 20) / 640) < 0.012, `pan speed ${speeds}`);
  // Injected shake: RMS about 4 px (of 640) left after smoothing; the smooth pan's is under 1 px.
  const shake = (r: VideoResult) => Math.max(...r.windows!.map((w) => w.jitter!));
  assert.ok(shake(smoothR) < 0.0015, `smooth: ${shake(smoothR)}`);
  assert.ok(jitterR.windows!.every((w) => w.jitter! > 0.003 && w.jitter! < 0.01), JSON.stringify(jitterR.windows!.map((w) => w.jitter)));
  assert.ok(Math.min(...blurR.windows!.map((w) => w.blur!)) > Math.max(...smoothR.windows!.map((w) => w.blur!)) + 2, "blur measures blurrier");
});

test("hard cuts are found within ±1 frame; a still stretch and a hold in a pan are frozen", { skip, timeout: 120000 }, async () => {
  const r = await analyze("cuts.mp4");
  assert.equal(r.frames, 150);
  const frames = r.cuts!.map((c) => c.time * FPS);
  assert.equal(frames.length, 2, JSON.stringify(r.cuts));
  assert.ok(Math.abs(frames[0]! - 45) <= 1 && Math.abs(frames[1]! - 100) <= 1, JSON.stringify(r.cuts));
  assert.deepEqual(shotsOf(r).map((s) => [Math.round(s.start * FPS), Math.round(s.end * FPS)]), [[0, 45], [45, 100], [100, 150]]);
  // The bars don't move: frozen from the first cut to the second.
  assert.equal(r.frozen!.length, 1, JSON.stringify(r.frozen));
  assert.ok(Math.abs(r.frozen![0]!.start - 1.5) <= 0.05 && Math.abs(r.frozen![0]!.end - 100 / FPS) <= 0.05, JSON.stringify(r.frozen));
  // The best 5 s can't cross a cut: it's inside one shot (and not the frozen one).
  const best = bestStretch(r)!;
  assert.ok(!r.cuts!.some((c) => c.time > best.start + 0.01 && c.time < best.end - 0.01), JSON.stringify(best));
  assert.equal(best.frozen, 0, JSON.stringify(best));

  const hold = await analyze("hold.mp4");
  assert.deepEqual(hold.cuts, [], "a hold isn't a cut");
  assert.equal(hold.frozen!.length, 1, JSON.stringify(hold.frozen));
  assert.ok(Math.abs(hold.frozen![0]!.start - 2) <= 0.1 && Math.abs(hold.frozen![0]!.end - 3.5) <= 0.1, JSON.stringify(hold.frozen));
  const scores = hold.windows!.map((w) => w.frozen);
  assert.ok(scores[2]! > 0.9 && scores[0] === 0 && scores[5] === 0, `${scores}`);
  // A frozen second scores 0 clean.
  assert.ok(meanScores(hold.windows!.slice(2, 3)).cleanScore < 0.1);
});

test("dropped frames are a gap in the recording, not a cut or motion; the best stretch doesn't cross one", { skip, timeout: 60000 }, async () => {
  const r = await analyze("dropped.mp4");
  assert.equal(r.frames, 173);
  assert.deepEqual(r.cuts, []);
  assert.equal(r.drops!.length, 1, JSON.stringify(r.drops));
  assert.ok(Math.abs(r.drops![0]!.time - 67 / FPS) < 0.01 && Math.abs(r.drops![0]!.missing - 7 / FPS) < 0.01, JSON.stringify(r.drops));
  // The jump isn't shake: the pan is as stable as without the gap.
  assert.ok(meanScores(r.windows!).stability! > 0.85, JSON.stringify(meanScores(r.windows!)));
  const best = bestStretch(r, 3)!;
  assert.ok(best.end <= 67 / FPS + 0.01 || best.start >= 67 / FPS - 0.01, JSON.stringify(best));
});

test("portrait footage: the same shake sideways and up and down reads the same (one scale for both axes)", { skip, timeout: 60000 }, async () => {
  const [x, y] = [await analyze("portrait-x.mp4"), await analyze("portrait-y.mp4")];
  const shake = (r: VideoResult) => r.windows!.reduce((sum, w) => sum + w.jitter!, 0) / r.windows!.length;
  const ratio = shake(y) / shake(x);
  assert.ok(ratio > 0.75 && ratio < 1.33, `vertical ${shake(y)} vs sideways ${shake(x)}`);
  // About 5 px RMS on a 360 px wide frame, in frame widths.
  assert.ok(shake(x) > 0.006 && shake(x) < 0.02, `${shake(x)}`);
});

test("a resolution change mid-file keeps every frame's time in order", { skip, timeout: 60000 }, async () => {
  const r = await analyze("resized.ts");
  assert.equal(r.frames, 120);
  assert.deepEqual(r.windows!.map((w) => w.frames), [30, 30, 30, 30]);
  assert.ok(Math.abs(r.seconds! - 4) < 0.1, `${r.seconds}`);
  assert.deepEqual(r.drops, []);
});

test("a second with no frames is null in perSecond, not shifted; stretches and the best stretch don't bridge it", { skip, timeout: 60000 }, async () => {
  const r = await analyze("hole.mp4");
  assert.deepEqual(r.windows!.map((w) => w.start), [0, 1, 3, 4, 5]);
  const out = videoOut(r, false, framesFor(FPS, 180), undefined, FPS) as any;
  assert.equal(out.perSecond.firstSecond, 0);
  assert.equal(out.perSecond.cleanScore.length, 6);
  assert.equal(out.perSecond.cleanScore[2], null);
  assert.ok(out.perSecond.cleanScore[3] !== null && out.perSecond.panPerSecond[2] === null);
  assert.ok(out.stretches.every((s: any) => s.endSeconds <= 2 || s.startSeconds >= 3), JSON.stringify(out.stretches));
  const best = bestStretch(r, 3)!;
  assert.ok(best.end <= 2 || best.start >= 3, JSON.stringify(best));
});

test("the first video stream (not a DJI-like mjpeg cover); sound files and images have no picture to measure", { skip, timeout: 60000 }, async () => {
  const r = await analyze("covered.mp4");
  assert.equal(r.hasVideo, true);
  assert.equal(r.frames, 60);
  // Blue would be a flat 0.16 or so; the test pattern is brighter and textured.
  assert.ok(r.windows!.every((w) => w.blur !== null && w.brightness > 0.25), JSON.stringify(r.windows));
  const tone = await analyzeVideo(ffmpegPath!, clip("tone.wav"), { signal: signal() });
  assert.deepEqual(tone, { hasVideo: false });
});

test("through the queue: cached as video.json by content; a re-ask runs no ffmpeg; no job for sound or images", { skip, timeout: 120000 }, async () => {
  const project = join(root, "Project");
  mkdirSync(project, { recursive: true });
  const runs: Array<ReadonlyArray<string>> = [];
  const runner: Runner = (bin, args, options) => {
    runs.push(args);
    return spawnRunner(bin, args, options);
  };
  const queue = new AnalysisQueue({ ffmpeg: async () => ffmpegPath, runner });
  const target: AnalysisTarget = { dir: project, mediaId: "m-smooth", path: clip("smooth.mp4"), kind: "video", hasAudio: false, seconds: 6 };
  const first = await queue.request(target, "video");
  assert.ok(first.job, "a job");
  const done = await first.done;
  assert.equal(done.state, "done");
  assert.equal(runs.length, 1);
  assert.ok(runs[0]!.includes("0:V:0") && runs[0]!.join(" ").includes("blurdetect"), runs[0]!.join(" "));
  const fp = await fingerprint(clip("smooth.mp4"));
  assert.ok(existsSync(cacheFile(project, fp, "video")));
  // Again: from the cache, no job, no ffmpeg, the same result.
  const again = await queue.request(target, "video");
  assert.equal(again.job, undefined);
  const outcome = await again.done;
  assert.equal(outcome.state, "done");
  assert.equal(outcome.state === "done" && outcome.cached, true);
  assert.deepEqual(outcome.state === "done" && outcome.result, done.state === "done" && done.result);
  assert.equal(runs.length, 1, "no ffmpeg for the cached re-ask");
  // Loudness of the same silent clip: answered from the probe, no job either.
  assert.equal((await queue.request(target, "loudness")).job, undefined);
  for (const kind of ["audio", "image"] as const) {
    const other = await queue.request({ ...target, mediaId: `m-${kind}`, kind }, "video");
    assert.equal(other.job, undefined);
    const o = await other.done;
    assert.deepEqual(o.state === "done" && o.result, { hasVideo: false });
  }
  assert.equal(runs.length, 1);
  assert.deepEqual(readdirSync(join(project, ".cache", "analysis", fp)), ["video.json"]);
});

test("scores: each component falls as its measure worsens; an unmeasured one is left out; windows split at unmatched frames", () => {
  assert.ok(stabilityOf(0)! > 0.99 && stabilityOf(0.003)! === 0.5 && stabilityOf(0.01)! < 0.1);
  assert.ok(sharpnessOf(4)! === 1 && sharpnessOf(8.5)! === 0.5 && sharpnessOf(12)! < 0.2);
  assert.equal(stabilityOf(null), null);
  assert.ok(Math.abs(cleanOf(null, 1, 1, 0) - 1) < 1e-9, "no stability measured: the rest decide");
  assert.ok(cleanOf(1, 1, 1, 0.5) <= 0.5 + 1e-9, "half frozen halves it");
  // Two runs of motion separated by an unmatched pair: neither run's path leaks into the other.
  const samples = Array.from({ length: 60 }, (_, i) => ({ time: i / 30, brightness: 0.5, dark: 0, bright: 0, blur: 5, ...(i === 0 || i === 30 ? {} : { dx: i < 30 ? 1 : -1, dy: 0 }) }));
  const ws = windowsOf(samples, [], 128, 2);
  assert.equal(ws.length, 2);
  assert.ok(ws.every((w) => w.jitter! < 1e-6), JSON.stringify(ws));
  assert.ok(ws.every((w) => Math.abs(w.motion! - 30 / 128) < 1e-3), JSON.stringify(ws));
  assert.deepEqual(ws.map((w) => w.tracked), [1, 0.967]);
});

// The user's footage, read only (never copied or written next to). Slow (about a minute), so it
// runs only when asked: UNCUT_DJI_PERF=1 node --test test/video-analysis.test.ts
const DRONE = join(homedir(), "Documents", "devrel", "drone");
const DJI = join(DRONE, "DJI_20261010132228_0005_D.MP4");
const perfSkip = skip || (!process.env.UNCUT_DJI_PERF ? "set UNCUT_DJI_PERF=1 to time a real DJI clip" : !existsSync(DJI) ? "the DJI clip isn't here" : false);
test("speed: at least 4× realtime on a real DJI clip (4K HEVC 10-bit)", { skip: perfSkip, timeout: 600000 }, async () => {
  const t0 = performance.now();
  const r = await analyzeVideo(ffmpegPath!, DJI, { signal: signal() });
  const elapsed = (performance.now() - t0) / 1000;
  const speed = r.seconds! / elapsed;
  console.log(`DJI clip: ${r.seconds} s (${r.frames} frames) analysed in ${elapsed.toFixed(1)} s = ${speed.toFixed(2)}× realtime; cuts ${r.cuts!.length}, frozen ${r.frozen!.length}, clean ${meanScores(r.windows!).cleanScore}`);
  assert.equal(r.hasVideo, true);
  assert.ok(speed >= 4, `${speed.toFixed(2)}× realtime`);
  // One continuous take: no cuts (fast pans over busy ground and gaps in the recording aren't cuts),
  // and mostly clean (a gimbal footage; a smooth yaw that speeds up isn't shake).
  assert.deepEqual(r.cuts, []);
  assert.ok(meanScores(r.windows!).cleanScore > 0.9);
});
