// Phase 5 chunk 6 (D70), in process: the beats analyzer (TS DSP on PCM decoded like the waveform's).
// - Click tracks at 90, 120 and 128 BPM and a drum pattern (kick, snare, eighth hats) over noise at
//   the same tempos, written here as WAV files and decoded by ffmpeg: bpm within ±1 (no octave
//   errors), every beat within ±30 ms of the truth and no extra ones, an onset for every click.
// - Silence and white noise: no steady beat (bpm null, no beats).
// - Speed of a 4-minute track: the DSP alone and ffmpeg + DSP end to end (printed as diagnostics).
// - The queue: a cached re-ask spawns nothing; cancel mid-job kills ffmpeg and leaves nothing.
// - The cache's shape check, aliases and the agent's view in frames.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnalysisQueue, analysisDir, cacheFile, fingerprint, parseAnalyzers, readCached, spawnRunner, type AnalysisTarget, type Runner } from "../apps/server/src/analysis.ts";
import { beatsOut, FIRST_BEATS } from "../apps/server/src/agentBeats.ts";
import { framesFor } from "../apps/server/src/agentVideo.ts";
import { clickTrack, drums, noise, pop, RATE, waltz, writeWav as wav } from "./helpers/beats-audio.ts";
import { analyzeBeats, beatsArgs, beatsFromSamples, isBeatsResult, SAMPLE_RATE, type BeatsResult } from "../apps/server/src/beats.ts";

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
const filesUnder = (dir: string): Array<string> => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as Array<string>) : []);

let root = "";
let project = "";

/** How the found beats compare with the truth. */
function compare(found: ReadonlyArray<number>, truth: ReadonlyArray<number>, tolerance = 0.03) {
  const nearest = (t: number, list: ReadonlyArray<number>) => list.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), Infinity);
  const errors = found.map((b) => b - nearest(b, truth));
  return {
    missed: truth.filter((t) => Math.abs(nearest(t, found) - t) > tolerance),
    extra: found.filter((b) => Math.abs(nearest(b, truth) - b) > tolerance),
    meanMs: Math.round((errors.reduce((s, e) => s + e, 0) / (errors.length || 1)) * 10000) / 10,
    maxMs: Math.round(Math.max(0, ...errors.map(Math.abs)) * 10000) / 10,
  };
}

const target = (path: string, mediaId: string): AnalysisTarget => ({ dir: project, mediaId, path, kind: "audio", hasAudio: true });
const counting = (calls: Array<ReadonlyArray<string>>): Runner => (bin, args, options) => (calls.push(args), spawnRunner(bin, args, options));

before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-beats-")));
  project = join(root, "Test.uncut");
  mkdirSync(project);
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const TRACKS = [90, 120, 128].flatMap((bpm) => [
  { name: `click-${bpm}`, bpm, make: () => clickTrack(bpm, 30, 0.37) },
  { name: `drums-${bpm}`, bpm, make: () => drums(bpm, 30, 0.5) },
]);

for (const track of TRACKS) {
  test(`${track.name}: bpm within ±1, every beat within ±30 ms, an onset for every hit (decoded by ffmpeg)`, { skip, timeout: 60000 }, async (t) => {
    const { buf, truth } = track.make();
    const file = join(root, `${track.name}.wav`);
    wav(file, buf);
    const r = await analyzeBeats(ffmpegPath!, file, { signal: new AbortController().signal });
    assert.ok(isBeatsResult(r), JSON.stringify(r).slice(0, 300));
    assert.equal(r.hasAudio, true);
    assert.ok(Math.abs(r.seconds! - 30) < 0.01, `seconds ${r.seconds}`);
    assert.ok(r.bpm !== null && Math.abs(r.bpm! - track.bpm) <= 1, `bpm ${r.bpm}, wanted ${track.bpm}`);
    const c = compare(r.beats!, truth);
    t.diagnostic(`${track.name}: bpm ${r.bpm} (truth ${track.bpm}), confidence ${r.confidence}, ${r.beats!.length}/${truth.length} beats, mean error ${c.meanMs} ms, max ${c.maxMs} ms, ${r.onsets!.length} onsets`);
    assert.deepEqual(c.missed, [], "every true beat found");
    assert.deepEqual(c.extra, [], "no extra beats");
    assert.ok(c.maxMs <= 30, `max error ${c.maxMs} ms`);
    // Every click (or kick/snare) is an onset; the drums also have hats between the beats.
    const onsets = r.onsets!.map((o) => o.t);
    assert.deepEqual(compare(onsets, truth).missed, [], "an onset for every beat's hit");
    if (track.name.startsWith("click")) assert.equal(onsets.length, truth.length, "one onset per click, nothing else");
    assert.ok(r.onsets!.every((o) => o.strength > 0 && o.strength <= 1));
    assert.ok(r.confidence! >= 0.5, `a clear pulse: ${r.confidence}`);
  });
}

// Review fixes: eighth hats as loud (after the log) as the beats used to double the tempo, most of
// all after digital silence. Checked in process at the analyzer's own rate (no decode needed).
const HARD = [
  ...[70, 80, 95, 100].flatMap((bpm) => [
    { name: `pop ${bpm} (silence between hits)`, bpm, make: () => pop(bpm, 30, { rate: SAMPLE_RATE }) },
    { name: `pop ${bpm} (noise floor)`, bpm, make: () => pop(bpm, 30, { floor: 0.05, rate: SAMPLE_RATE }) },
  ]),
  { name: "pop 120 swung", bpm: 120, make: () => pop(120, 30, { swing: 2 / 3, rate: SAMPLE_RATE }) },
  { name: "drums 150 (kick/snare)", bpm: 150, make: () => drums(150, 30, 0.5, SAMPLE_RATE) },
  { name: "waltz 90", bpm: 90, make: () => waltz(90, 30, SAMPLE_RATE) },
  { name: "waltz 150", bpm: 150, make: () => waltz(150, 30, SAMPLE_RATE) },
];
for (const track of HARD) {
  test(`${track.name}: no octave error, every beat within ±30 ms`, (t) => {
    const { buf, truth } = track.make();
    const r = beatsFromSamples(buf);
    const c = compare(r.beats ?? [], truth);
    t.diagnostic(`${track.name}: bpm ${r.bpm} (truth ${track.bpm}), confidence ${r.confidence}, ${r.beats!.length}/${truth.length} beats, mean error ${c.meanMs} ms, max ${c.maxMs} ms`);
    assert.ok(r.bpm !== null && Math.abs(r.bpm! - track.bpm) <= 1, `bpm ${r.bpm}, wanted ${track.bpm}`);
    assert.deepEqual(c.missed, []);
    assert.deepEqual(c.extra, []);
  });
}

test("beats.ts can be the first module imported (no import cycle through the HTTP side)", () => {
  const r = spawnSync(process.execPath, ["-e", "import('./apps/server/src/beats.ts').then((m) => console.log(m.BEATS_VERSION))"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "1");
});

test("silence and white noise: no steady beat (bpm null, no beats)", () => {
  const silent = beatsFromSamples(new Float64Array(10 * SAMPLE_RATE));
  assert.deepEqual({ bpm: silent.bpm, beats: silent.beats, onsets: silent.onsets }, { bpm: null, beats: [], onsets: [] });
  const rnd = noise(3);
  const hiss = Float64Array.from({ length: 30 * SAMPLE_RATE }, () => 0.3 * rnd());
  const r = beatsFromSamples(hiss);
  assert.equal(r.bpm, null, `confidence ${r.confidence}`);
  assert.deepEqual(r.beats, []);
  assert.ok(isBeatsResult(r));
});

test("speed: a 4-minute track, the DSP alone and ffmpeg + DSP end to end", { skip, timeout: 120000 }, async (t) => {
  const { buf, truth } = drums(128, 240, 0.25, SAMPLE_RATE, 11);
  let t0 = performance.now();
  const pure = beatsFromSamples(buf);
  const dspMs = Math.round(performance.now() - t0);
  assert.ok(Math.abs(pure.bpm! - 128) <= 1, `bpm ${pure.bpm}`);
  assert.deepEqual(compare(pure.beats!, truth).missed, []);
  const file = join(root, "four-minutes.wav");
  wav(file, drums(128, 240, 0.25, RATE, 11).buf);
  t0 = performance.now();
  const full = await analyzeBeats(ffmpegPath!, file, { signal: new AbortController().signal });
  const fullMs = Math.round(performance.now() - t0);
  t.diagnostic(`4-minute track: DSP ${dspMs} ms (${Math.round(240000 / dspMs)}× realtime), ffmpeg decode + DSP ${fullMs} ms (${Math.round(240000 / fullMs)}× realtime), bpm ${full.bpm}, ${full.beats!.length} beats, ${full.onsets!.length} onsets`);
  assert.ok(Math.abs(full.bpm! - 128) <= 1);
  assert.ok(fullMs < 24000, `at least 10× realtime end to end (${fullMs} ms)`);
  assert.ok(dspMs < 6000, `the DSP at least 40× realtime (${dspMs} ms)`);
});

test("the queue: a cached re-ask spawns nothing; the args decode the first audio stream as mono PCM", { skip, timeout: 60000 }, async () => {
  const file = join(root, "cache-120.wav");
  wav(file, clickTrack(120, 10, 0.2).buf);
  const calls: Array<ReadonlyArray<string>> = [];
  const q = new AnalysisQueue({ ffmpeg: async () => ffmpegPath, runner: counting(calls) });
  const first = await q.request(target(file, "m-click"), "beats");
  assert.ok(first.job, "a job");
  const outcome = await first.done;
  assert.equal(outcome.state, "done", JSON.stringify(outcome));
  const result = (outcome as { result: BeatsResult }).result;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], beatsArgs(file));
  assert.ok(calls[0]!.join(" ").includes(`-map 0:a:0 -vn -sn -dn -ac 1 -ar ${SAMPLE_RATE} -f s16le`));
  const fp = await fingerprint(file);
  assert.ok(existsSync(cacheFile(project, fp, "beats")));
  assert.deepEqual(await readCached(project, fp, "beats"), result);
  // Asked again (also under another name): from the cache, no job, no ffmpeg.
  const again = await q.request(target(file, "m-click"), "beats");
  assert.equal(again.job, undefined);
  assert.deepEqual(await again.done, { state: "done", result, cached: true });
  assert.equal(calls.length, 1, "no ffmpeg for the cached re-ask");
  // A media without sound: answered at once, no job, no file.
  const silent = await q.request({ ...target(file, "m-still"), kind: "video", hasAudio: false }, "beats");
  assert.equal(silent.job, undefined);
  assert.deepEqual(await silent.done, { state: "done", result: { hasAudio: false }, cached: false });
  assert.equal(calls.length, 1);
  // A cache file of the wrong shape is a miss (and is redone).
  writeFileSync(cacheFile(project, fp, "beats"), JSON.stringify({ format: "uncut.analysis/0", analyzer: "beats", version: 1, fingerprint: fp, createdAt: "", result: { hasAudio: true, bpm: "fast" } }));
  assert.equal(await readCached(project, fp, "beats"), undefined);
});

test("cancel mid-job: ffmpeg is killed, the job says cancelled, nothing is left in .cache/analysis", { skip, timeout: 60000 }, async () => {
  const bin = join(root, "slow-bin");
  mkdirSync(bin);
  const shim = join(bin, "ffmpeg");
  writeFileSync(shim, `#!/bin/sh\nsleep 30\nexec "${ffmpegPath}" "$@"\n`);
  chmodSync(shim, 0o755);
  const jobs: Array<ReadonlyArray<AnalysisJob>> = [];
  const q = new AnalysisQueue({ ffmpeg: async () => shim, onChange: (j) => jobs.push(j) });
  const file = join(root, "cancel.wav");
  wav(file, clickTrack(100, 5, 0.1).buf);
  const r = await q.request(target(file, "m-cancel"), "beats");
  assert.ok(r.job);
  const kids = () => spawnSync("pgrep", ["-P", String(process.pid), "-f", shim], { encoding: "utf8" }).stdout.trim();
  for (let i = 0; i < 50 && !kids(); i++) await sleep(50);
  assert.ok(kids(), "ffmpeg (the shim) is running");
  q.cancel(r.job!.id);
  assert.deepEqual(await r.done, { state: "cancelled" });
  assert.equal(q.job(r.job!.id)!.phase, "cancelled");
  for (let i = 0; i < 20 && kids(); i++) await sleep(50);
  assert.equal(kids(), "", "the process is gone");
  const fp = await fingerprint(file);
  assert.deepEqual(filesUnder(analysisDir(project)).filter((f) => f.includes(fp)), [], "no folder or file for it");
  // The same file analysed for real afterwards (a copy, so the cancelled one stays uncached).
  const copy = join(root, "cancel-copy.wav");
  copyFileSync(file, copy);
  appendFileSync(copy, Buffer.alloc(2));
  const q2 = new AnalysisQueue({ ffmpeg: async () => ffmpegPath });
  assert.equal((await (await q2.request(target(copy, "m-copy"), "beats")).done).state, "done");
});

test("names: beats, rhythm, onsets and tempo are one job; the agent's view is in project frames", () => {
  assert.deepEqual(parseAnalyzers(["beats", "rhythm", "onsets", "tempo"]), { analyzers: ["beats"] });
  assert.deepEqual(parseAnalyzers(["silence", "tempo"]), { analyzers: ["loudness", "beats"] });
  assert.match((parseAnalyzers(["description"]) as { refused: string }).refused, /description \(descriptions\) isn't available yet/);
  const beats = Array.from({ length: 60 }, (_, i) => Math.round((0.5 + i * 0.5) * 1000) / 1000);
  const result: BeatsResult = { hasAudio: true, seconds: 30.5, bpm: 120, confidence: 0.9, beats, onsets: beats.map((t) => ({ t, strength: 0.8 })) };
  const frames = framesFor(30, 915);
  const all = beatsOut(result, false, frames, undefined, 30) as Record<string, any>;
  assert.equal(all.beatCount, 60);
  assert.equal(all.beatFrames, 15);
  assert.deepEqual(all.firstBeat, { frame: 15, seconds: 0.5 });
  assert.equal(all.beats.frames.length, FIRST_BEATS);
  assert.deepEqual(all.beats.frames.slice(0, 3), [15, 30, 45]);
  assert.match(all.beats.truncated, /first 32 of 60/);
  assert.equal(all.onsets, undefined, "onsets only with a range");
  const ranged = beatsOut(result, true, frames, { start: 100, end: 160 }, 30) as Record<string, any>;
  assert.deepEqual(ranged.beats.frames, [105, 120, 135, 150]);
  assert.equal(ranged.onsets.count, 4);
  assert.deepEqual(ranged.onsets.list[0], { frame: 105, seconds: 3.5, strength: 0.8 });
  const none = beatsOut({ ...result, bpm: null, beats: [] }, false, frames, undefined, 30) as Record<string, any>;
  assert.equal(none.beatCount, 0);
  assert.match(none.note, /No steady beat/);
  assert.deepEqual(beatsOut({ hasAudio: false }, false, frames, undefined, 30), { state: "done", cached: false, hasAudio: false, note: "This media has no sound, so there are no beats." });
});
