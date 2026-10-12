// Phase 5 chunk 2 (D66), in process: the analysis queue, the loudness analyzer and the cache.
// - A generated tone with silent gaps: silences within ±50 ms; integrated loudness of a tone at a
//   known level within ±0.5 LU of ffmpeg's own measurement (loudnorm, a separate code path).
// - A cached re-ask spawns no ffmpeg (counted through the queue's runner).
// - Cancel mid-job kills ffmpeg and leaves nothing in .cache/analysis; the job says cancelled.
// - Fingerprint: the same content under another name hits the cache, a modified file misses.
// - No job starts while an export is busy; it starts once the export is over.
// All media is generated here with ffmpeg's lavfi sources, in a temp folder.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AnalysisQueue,
  analysisDir,
  cacheFile,
  fingerprint,
  isResult,
  LoudnessLog,
  parseAnalyzers,
  spawnRunner,
  writeCached,
  type AnalysisTarget,
  type LoudnessResult,
  type Runner,
} from "../apps/server/src/analysis.ts";

type AnalysisJob = ReturnType<AnalysisQueue["list"]>[number];

const ffmpegPath = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
})();
const skip = ffmpegPath ? false : "ffmpeg isn't installed";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root = "";
let project = "";
const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
/** Every file under a folder (relative paths), or [] when it isn't there. */
const filesUnder = (dir: string): Array<string> => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as Array<string>) : []);

// 1 s tone, 0.8 s silence, 1.2 s tone, 0.5 s silence, 1 s tone, 0.6 s silence (to the end).
const GAPS = [
  [1.0, 1.8],
  [3.0, 3.5],
  [4.5, 5.1],
];
const gappedGraph = (amp: number) =>
  [
    `sine=frequency=440:sample_rate=48000:duration=1,volume=${amp}[a]`,
    "anullsrc=r=48000:cl=mono:d=0.8[s1]",
    `sine=frequency=440:sample_rate=48000:duration=1.2,volume=${amp}[b]`,
    "anullsrc=r=48000:cl=mono:d=0.5[s2]",
    `sine=frequency=440:sample_rate=48000:duration=1,volume=${amp}[c]`,
    "anullsrc=r=48000:cl=mono:d=0.6[s3]",
    "[a][s1][b][s2][c][s3]concat=n=6:v=0:a=1",
  ].join(";");

const target = (path: string, mediaId = "m-tone", extra: Partial<AnalysisTarget> = {}): AnalysisTarget => ({ dir: project, mediaId, path, kind: "audio", hasAudio: true, ...extra });
const queueWith = (runner: Runner, jobs?: Array<ReadonlyArray<AnalysisJob>>) => new AnalysisQueue({ ffmpeg: async () => ffmpegPath, runner, onChange: (j) => jobs?.push(j) });
const counting = (calls: Array<ReadonlyArray<string>>): Runner => (bin, args, options) => (calls.push(args), spawnRunner(bin, args, options));
const doneResult = async (q: AnalysisQueue, t: AnalysisTarget) => {
  const r = await q.request(t, "loudness");
  const outcome = await r.done;
  assert.equal(outcome.state, "done", JSON.stringify(outcome));
  return { ...(outcome as { result: LoudnessResult; cached: boolean }), job: r.job };
};

before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-analysis-")));
  project = join(root, "Test.uncut");
  mkdirSync(project);
  // 1/8 amplitude sine (sine's default) halved: well above the -40 dB silence threshold.
  ff("-f", "lavfi", "-i", gappedGraph(0.5), "-c:a", "pcm_s16le", join(root, "gaps.wav"));
  // A 997 Hz tone at -12 dBFS peak (amplitude 0.25) for 6 s: a known level.
  ff("-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000:duration=6,volume=2", "-c:a", "pcm_s16le", join(root, "level.wav"));
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("analyzers: none named = loudness (video is opt-in); silence is the loudness job, shots/motion/stability the video job; later and unknown ones are refused", () => {
  assert.deepEqual(parseAnalyzers(undefined), { analyzers: ["loudness"] });
  assert.deepEqual(parseAnalyzers(["silence", "loudness"]), { analyzers: ["loudness"] });
  assert.deepEqual(parseAnalyzers(["shots", "motion", "stability"]), { analyzers: ["video"] });
  assert.deepEqual(parseAnalyzers(["silence", "shots"]), { analyzers: ["loudness", "video"] });
  assert.match((parseAnalyzers(["beats"]) as { refused: string }).refused, /beats \(beats\) isn't available yet/);
  assert.match((parseAnalyzers(["toString"]) as { refused: string }).refused, /no analyzer "toString"/);
  assert.match((parseAnalyzers(["vibes"]) as { refused: string }).refused, /no analyzer "vibes"/);
  assert.match((parseAnalyzers([]) as { refused: string }).refused, /non-empty list/);
});

test("the ffmpeg log: silences, an open silence at the end, the loudness summary (the True peak section's Peak, not Sample peak's), -inf", () => {
  const log = new LoudnessLog();
  for (const line of [
    "  Duration: 00:01:02.50, start: 0.000000, bitrate: 768 kb/s",
    "[Parsed_silencedetect_0 @ 0x1] silence_start: -0.0213",
    "[Parsed_silencedetect_0 @ 0x1] silence_end: 1.25 | silence_duration: 1.27",
    "[Parsed_silencedetect_0 @ 0x1] silence_start: 60",
    "[Parsed_ebur128_1 @ 0x2] Summary:",
    "  Integrated loudness:",
    "    I:         -inf LUFS",
    "    Threshold: -70.0 LUFS",
    "  Loudness range:",
    "    LRA:         3.4 LU",
    "  True peak:",
    "    Peak:       -1.5 dBFS",
    "  Sample peak:",
    "    Peak:       -0.5 dBFS",
  ])
    log.line(line);
  assert.equal(log.duration, 62.5);
  assert.deepEqual(log.finish(62.5), {
    hasAudio: true,
    seconds: 62.5,
    integratedLufs: null,
    loudnessRangeLu: 3.4,
    truePeakDbtp: -1.5,
    silence: { thresholdDb: -40, minSeconds: 0.3, ranges: [{ start: 0, end: 1.25 }, { start: 60, end: 62.5 }] },
  });
});

test("a tone with silent gaps: silences within ±50 ms; a known-level tone's loudness within ±0.5 LU of ffmpeg's own measurement", { skip, timeout: 60000 }, async () => {
  const q = queueWith(spawnRunner);
  const { result } = await doneResult(q, target(join(root, "gaps.wav")));
  assert.equal(result.hasAudio, true);
  assert.ok(Math.abs(result.seconds! - 5.1) < 0.05, `decoded ${result.seconds} s`);
  const ranges = result.silence!.ranges;
  assert.equal(ranges.length, GAPS.length, JSON.stringify(ranges));
  for (const [i, [start, end]] of GAPS.entries()) {
    assert.ok(Math.abs(ranges[i]!.start - start!) <= 0.05 && Math.abs(ranges[i]!.end - end!) <= 0.05, `silence ${i}: ${JSON.stringify(ranges[i])} vs ${start}–${end}`);
  }
  assert.deepEqual([result.silence!.thresholdDb, result.silence!.minSeconds], [-40, 0.3], "the defaults are in the result");

  const level = (await doneResult(q, target(join(root, "level.wav"), "m-level"))).result;
  const loudnorm = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-i", join(root, "level.wav"), "-af", "loudnorm=print_format=json", "-f", "null", "-"], { encoding: "utf8" });
  const measured = JSON.parse([...loudnorm.stderr.matchAll(/\{[^{}]*\}/g)].at(-1)![0]) as { input_i: string; input_tp: string };
  assert.ok(Math.abs(level.integratedLufs! - Number(measured.input_i)) <= 0.5, `${level.integratedLufs} LUFS vs ffmpeg's ${measured.input_i}`);
  // And what a -12 dBFS mono sine is in theory (EBU R128: a 0 dBFS mono sine at 1 kHz is -3 LUFS).
  assert.ok(Math.abs(level.integratedLufs! - -15.04) <= 1, `${level.integratedLufs} LUFS`);
  assert.ok(Math.abs(level.truePeakDbtp! - -12.04) <= 0.5, `true peak ${level.truePeakDbtp}`);
  assert.equal(level.silence!.ranges.length, 0);
});

test("cache: a re-ask spawns no ffmpeg; the same content under another name hits; a modified file misses", { skip, timeout: 60000 }, async () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const q = queueWith(counting(calls));
  const file = join(root, "cache.wav");
  copyFileSync(join(root, "gaps.wav"), file);
  appendFileSync(file, Buffer.alloc(2)); // its own content (gaps.wav itself is cached by now)
  const first = await doneResult(q, target(file, "m-cache"));
  assert.equal(first.cached, false);
  assert.equal(calls.length, 1, "one ffmpeg run");
  assert.ok(calls[0]!.includes("0:a:0"), "the first audio stream, mapped explicitly");
  const fp = await fingerprint(file);
  assert.ok(existsSync(cacheFile(project, fp, "loudness")), "cached under the fingerprint");
  assert.deepEqual(filesUnder(join(analysisDir(project), fp)), ["loudness.json"], "no temp files left");

  const again = await doneResult(q, target(file, "m-cache"));
  assert.equal(again.cached, true);
  assert.equal(again.job, undefined, "a cached answer needs no job");
  assert.deepEqual(again.result, first.result);
  assert.equal(calls.length, 1, "no ffmpeg for a cached re-ask");

  // Renamed and moved: same content, same fingerprint, the cache answers (also for another media id).
  mkdirSync(join(root, "moved"));
  const moved = join(root, "moved", "renamed.wav");
  renameSync(file, moved);
  assert.equal(await fingerprint(moved), fp);
  const renamed = await doneResult(q, target(moved, "m-renamed"));
  assert.equal(renamed.cached, true);
  assert.equal(calls.length, 1, "no ffmpeg for the renamed file");

  // Modified: a byte changed inside the first megabyte (same size), then bytes appended.
  const fd = openSync(moved, "r+");
  writeSync(fd, Buffer.from([0x7f]), 0, 1, 100);
  closeSync(fd);
  assert.notEqual(await fingerprint(moved), fp, "a change inside a sample changes the fingerprint");
  const changed = await doneResult(q, target(moved, "m-renamed"));
  assert.equal(changed.cached, false);
  assert.equal(calls.length, 2, "a modified file is analysed again");
  appendFileSync(moved, Buffer.alloc(10));
  const grown = await fingerprint(moved);
  assert.notEqual(grown, fp);
  assert.equal((await doneResult(q, target(moved, "m-renamed"))).cached, false);
  assert.equal(calls.length, 3);

  // A file without sound is answered from its probe: no ffmpeg, no cache file.
  const silent = await doneResult(q, target(join(root, "nothing.mp4"), "m-video", { kind: "video", hasAudio: false }));
  assert.deepEqual([silent.result, silent.cached, calls.length], [{ hasAudio: false }, false, 3]);
});

test("a file whose probe didn't know: ffmpeg finds no audio stream, and that's a result, not an error", { skip, timeout: 60000 }, async () => {
  const file = join(root, "picture.mp4");
  // A picture-only file with a second, larger mjpeg stream (like a DJI cover picture).
  ff("-f", "lavfi", "-i", "color=red:size=160x90:rate=30", "-f", "lavfi", "-i", "color=blue:size=640x360:rate=30", "-t", "1", "-map", "0:v", "-map", "1:v", "-c:v:0", "libx264", "-pix_fmt:v:0", "yuv420p", "-c:v:1", "mjpeg", "-pix_fmt:v:1", "yuvj420p", file);
  const q = queueWith(spawnRunner);
  const { result } = await doneResult(q, target(file, "m-picture", { kind: "video", hasAudio: undefined }));
  assert.deepEqual(result, { hasAudio: false });
});

test("cancel mid-job: ffmpeg is killed, the job says cancelled, nothing is left in .cache/analysis", { skip, timeout: 60000 }, async () => {
  // An ffmpeg that takes its time (a shell shim sleeping before the real one), so the cancel lands mid-run.
  const bin = join(root, "slow-bin");
  mkdirSync(bin);
  const shim = join(bin, "ffmpeg");
  writeFileSync(shim, `#!/bin/sh\nsleep 30\nexec "${ffmpegPath}" "$@"\n`);
  chmodSync(shim, 0o755);
  const jobs: Array<ReadonlyArray<AnalysisJob>> = [];
  const q = new AnalysisQueue({ ffmpeg: async () => shim, onChange: (j) => jobs.push(j) });
  const file = join(root, "cancel.wav");
  copyFileSync(join(root, "level.wav"), file);
  appendFileSync(file, Buffer.alloc(6)); // not cached yet
  const r = await q.request(target(file, "m-cancel"), "loudness");
  assert.ok(r.job);
  const kids = () => spawnSync("pgrep", ["-P", String(process.pid), "-f", shim], { encoding: "utf8" }).stdout.trim();
  for (let i = 0; i < 50 && !kids(); i++) await sleep(50);
  assert.ok(kids(), "ffmpeg (the shim) is running");
  assert.equal(q.job(r.job!.id)!.phase, "running");
  q.cancel(r.job!.id);
  assert.deepEqual(await r.done, { state: "cancelled" });
  assert.equal(q.job(r.job!.id)!.phase, "cancelled");
  assert.ok(jobs.at(-1)!.some((j) => j.id === r.job!.id && j.phase === "cancelled" && j.finishedAt), "the change was published");
  for (let i = 0; i < 20 && kids(); i++) await sleep(50);
  assert.equal(kids(), "", "the process is gone");
  const fp = await fingerprint(file);
  assert.deepEqual(filesUnder(analysisDir(project)).filter((f) => f.includes(fp)), [], "no folder or file for it");
  assert.ok(!existsSync(cacheFile(project, fp, "loudness")));
  assert.deepEqual(filesUnder(analysisDir(project)).filter((f) => /tmp/.test(f)), [], "no temp files anywhere");

  // Cancelling a waiting job is immediate, and it never runs.
  const calls: Array<ReadonlyArray<string>> = [];
  const busy = new AnalysisQueue({ ffmpeg: async () => ffmpegPath, runner: counting(calls) });
  busy.setExportBusy(true);
  const waiting = await busy.request(target(file, "m-cancel"), "loudness");
  busy.cancel(waiting.job!.id);
  assert.deepEqual(await waiting.done, { state: "cancelled" });
  busy.setExportBusy(false);
  await sleep(200);
  assert.equal(calls.length, 0);
});

test("analysis waits while an export is busy, then runs; an equal request joins the waiting job", { skip, timeout: 60000 }, async () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const jobs: Array<ReadonlyArray<AnalysisJob>> = [];
  const q = queueWith(counting(calls), jobs);
  const file = join(root, "export-wait.wav");
  copyFileSync(join(root, "gaps.wav"), file);
  appendFileSync(file, Buffer.alloc(4)); // its own content, so it isn't cached yet
  q.setExportBusy(true);
  const r = await q.request(target(file, "m-wait"), "loudness");
  assert.equal(r.job!.phase, "queued");
  assert.equal(r.job!.waiting, "export");
  const joined = await q.request(target(file, "m-wait"), "loudness");
  assert.equal(joined.job!.id, r.job!.id, "joins the waiting job");
  await sleep(500);
  assert.equal(calls.length, 0, "no ffmpeg while the export runs");
  assert.equal(q.job(r.job!.id)!.phase, "queued");
  q.setExportBusy(false);
  const outcome = await r.done;
  assert.equal(outcome.state, "done");
  assert.equal(calls.length, 1);
  const states = jobs.map((list) => list.find((j) => j.id === r.job!.id)).filter(Boolean).map((j) => `${j!.phase}${j!.waiting ? `:${j!.waiting}` : ""}`);
  assert.deepEqual([...new Set(states)], ["queued:export", "queued", "running", "done"]);
});

test("a cache file without the result's shape is a miss: analysed again and rewritten", { skip, timeout: 60000 }, async () => {
  const file = join(root, "bad-cache.wav");
  copyFileSync(join(root, "gaps.wav"), file);
  appendFileSync(file, Buffer.alloc(8));
  const fp = await fingerprint(file);
  await writeCached(project, fp, "loudness", { hasAudio: "yes" } as unknown as LoudnessResult);
  assert.equal(isResult({ hasAudio: "yes" }), false);
  assert.equal(isResult({ hasAudio: true, silence: { thresholdDb: -40, minSeconds: 0.3, ranges: [{ start: "0" }] } }), false);
  assert.equal(isResult({ hasAudio: false }), true);
  const calls: Array<ReadonlyArray<string>> = [];
  const q = queueWith(counting(calls));
  const first = await doneResult(q, target(file, "m-bad"));
  assert.equal(first.cached, false);
  assert.equal(calls.length, 1, "the bad file isn't a hit");
  assert.equal((await doneResult(q, target(file, "m-bad"))).cached, true, "rewritten with a good result");
  assert.equal(calls.length, 1);
});

test("a project that closed while the file was read gets no job and no cache", { skip, timeout: 60000 }, async () => {
  const file = join(root, "closed.wav");
  copyFileSync(join(root, "gaps.wav"), file);
  appendFileSync(file, Buffer.alloc(10));
  const calls: Array<ReadonlyArray<string>> = [];
  let open = true;
  const q = new AnalysisQueue({ ffmpeg: async () => ffmpegPath, runner: counting(calls), isOpen: () => open });
  const pending = q.request(target(file, "m-closed"), "loudness");
  open = false; // closes during the fingerprint read
  const r = await pending;
  assert.equal(r.job, undefined);
  assert.deepEqual(await r.done, { state: "cancelled" });
  await sleep(200);
  assert.equal(calls.length, 0);
  assert.ok(!existsSync(cacheFile(project, await fingerprint(file), "loudness")));
});

test("a cancel after ffmpeg finished, before the result is kept, leaves nothing", { skip, timeout: 60000 }, async () => {
  const file = join(root, "late.wav");
  copyFileSync(join(root, "gaps.wav"), file);
  appendFileSync(file, Buffer.alloc(12));
  let jobId = "";
  let q: AnalysisQueue;
  const late: Runner = async (bin, args, options) => {
    const result = await spawnRunner(bin, args, options);
    q.cancel(jobId); // ffmpeg is done; the cancel lands before the result is kept
    return result;
  };
  q = queueWith(late);
  const r = await q.request(target(file, "m-late"), "loudness");
  jobId = r.job!.id;
  assert.deepEqual(await r.done, { state: "cancelled" });
  assert.equal(q.job(jobId)!.phase, "cancelled");
  const fp = await fingerprint(file);
  assert.deepEqual(filesUnder(analysisDir(project)).filter((f) => f.includes(fp)), []);
});

test("joining: a relinked media id (another path) gets its own job; the same content under another id joins and lists both ids", { skip, timeout: 60000 }, async () => {
  const a = join(root, "join-a.wav");
  const b = join(root, "join-b.wav");
  copyFileSync(join(root, "gaps.wav"), a);
  appendFileSync(a, Buffer.alloc(14));
  copyFileSync(join(root, "level.wav"), b);
  appendFileSync(b, Buffer.alloc(14));
  const copy = join(root, "join-a-copy.wav");
  copyFileSync(a, copy);
  const calls: Array<ReadonlyArray<string>> = [];
  let exporting = true;
  const q = new AnalysisQueue({ ffmpeg: async () => ffmpegPath, runner: counting(calls), exportBusy: () => exporting });
  const first = await q.request(target(a, "m-x"), "loudness");
  assert.equal(first.job!.waiting, "export", "the synchronous export check holds it back");
  const relinked = await q.request(target(b, "m-x"), "loudness");
  assert.notEqual(relinked.job!.id, first.job!.id, "m-x now points at another file: not the stale job");
  const twin = await q.request(target(copy, "m-twin"), "loudness");
  assert.equal(twin.job!.id, first.job!.id, "same content joins");
  assert.deepEqual(q.job(first.job!.id)!.mediaIds, ["m-x", "m-twin"]);
  await sleep(300);
  assert.equal(calls.length, 0, "nothing runs while the export is busy");
  exporting = false;
  q.setExportBusy(false);
  assert.equal((await first.done).state, "done");
  assert.equal((await relinked.done).state, "done");
  assert.equal(calls.length, 2);
});
