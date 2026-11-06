import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compareExport,
  hashProblems,
  levelProblems,
  ssimProblems,
  streamProblems,
  syncOffsetsMs,
  syncProblems,
  type CompareRule,
  type Measured,
} from "../../scripts/factory/golden-compare.ts";
import { risingEdges, type Probe } from "../../scripts/factory/media.ts";

const probe: Probe = {
  durationS: 3,
  video: { codec: "h264", width: 1280, height: 720, fps: 30, frames: 90, durationS: 3, startS: 0 },
  audio: { codec: "aac", sampleRate: 48000, channels: 2, durationS: 3, startS: 0 },
};
const rule: CompareRule = { compare: "hash", expectedFrames: 90, hasAudio: true };
const golden: Measured = { probe, frameHashes: ["a", "b", "c"], audioLevelsDb: [-20, -21] };

test("an export equal to its golden has no problems", () => {
  assert.deepEqual(compareExport(golden, golden, rule), []);
});

test("streamProblems: lost audio, a lost video stream, frame count, size, codec and A/V length", () => {
  assert.match(streamProblems({ durationS: 3, video: probe.video! }, probe, rule)[0]!, /no audio stream/);
  assert.deepEqual(streamProblems({ durationS: 3, audio: probe.audio! }, probe, rule), ["the export has no video stream"]);
  assert.match(streamProblems(probe, probe, { ...rule, expectedFrames: 91 })[0]!, /90 video frames, expected 91/);
  const small = { ...probe, video: { ...probe.video!, width: 640 } };
  assert.match(streamProblems(small, probe, rule)[0]!, /640x720/);
  const hevc = { ...probe, video: { ...probe.video!, codec: "hevc" } };
  assert.match(streamProblems(hevc, probe, rule)[0]!, /codec hevc/);
  const short = { ...probe, audio: { ...probe.audio!, durationS: 2 } };
  assert.match(streamProblems(short, probe, rule)[0]!, /audio 2 s against video 3 s/);
});

test("hashProblems counts the frames that differ and names the first; a short file differs too", () => {
  assert.deepEqual(hashProblems(["a", "x", "y"], ["a", "b", "c"]), ["2 of 3 frames differ from the golden, first at frame 1"]);
  assert.equal(hashProblems(["a", "b"], ["a", "b", "c"]).length, 1);
  assert.equal(hashProblems(["a", "b", "c", "d"], ["a", "b", "c"]).length, 1);
});

test("the SSIM rule ignores hashes, the hash rule doesn't", () => {
  const other = { ...golden, frameHashes: ["x", "y", "z"] };
  assert.deepEqual(compareExport(other, golden, { ...rule, compare: "ssim" }), []);
  assert.equal(compareExport(other, golden, rule).length, 1);
});

test("levelProblems allows 1 dB and names where the mix moved, or a sound that ends early", () => {
  assert.deepEqual(levelProblems([-20.5, -21.9], [-20, -21]), []);
  assert.deepEqual(levelProblems([-20, -25], [-20, -21]), ["sound level at 0.5 s is -25 dB, golden -21 dB"]);
  assert.equal(levelProblems([-20], [-20, -21]).length, 1);
});

test("syncOffsetsMs is beep minus flash, with each stream's start", () => {
  assert.deepEqual(syncOffsetsMs([15, 45], [0.5, 1.51], 30), [0, 10]);
  assert.deepEqual(syncOffsetsMs([15], [0.5], 30, 0, 0.1), [100]);
  assert.deepEqual(syncOffsetsMs([15, 45], [0.5], 30), [0]);
});

test("syncProblems: within a frame is fine, a late sound or a missing pair isn't", () => {
  assert.deepEqual(syncProblems([3, -20, 33], 3), []);
  assert.match(syncProblems([3, 50], 2)[0]!, /50 ms/);
  assert.match(syncProblems([3], 2)[0]!, /1 flash and beep pairs, expected 2/);
});

test("compareExport holds a sync item to its pairs", () => {
  const sync = { ...rule, compare: "ssim" as const, expectedFlashes: 2 };
  assert.deepEqual(compareExport({ ...golden, syncMs: [1, 2] }, golden, sync), []);
  assert.equal(compareExport({ ...golden, syncMs: [1, 90] }, golden, sync).length, 1);
  assert.equal(compareExport(golden, golden, sync).length, 1);
});

test("ssimProblems names each frame under the bar", () => {
  assert.deepEqual(ssimProblems({ 20: 0.99, 75: 0.9 }, 0.97), ["frame 75: SSIM 0.9 against the golden, needs 0.97"]);
});

test("risingEdges finds each rise once, including one at the start", () => {
  assert.deepEqual(risingEdges([0, 1, 1, 0, 1], 0.5), [1, 4]);
  assert.deepEqual(risingEdges([1, 0], 0.5), [0]);
});
