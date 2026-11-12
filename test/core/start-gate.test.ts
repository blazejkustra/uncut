// The playback clock's start gate, without the app: after play, or a jump while playing, the clock
// waits at its frame while the preview says a clip on screen has no picture yet, then runs from that
// frame; it never waits longer than START_HOLD_MS, and shuttling never waits.
import { test } from "node:test";
import assert from "node:assert/strict";

const frames: Array<FrameRequestCallback> = [];
let now = 0;
Object.assign(globalThis, { requestAnimationFrame: (cb: FrameRequestCallback) => frames.push(cb), cancelAnimationFrame: () => {} });
Object.defineProperty(globalThis, "performance", { value: { now: () => now }, configurable: true });
const { playback, getPlayback, START_HOLD_MS } = await import("../../apps/web/src/preview/playback.ts");

/** Runs the pending animation frames at `ms` from the clock's zero. */
function frameAt(ms: number) {
  now = ms;
  for (const cb of frames.splice(0)) cb(ms);
}

let ready = false;
playback.setStartGate(() => !ready);

function start(rate = 1) {
  frames.length = 0;
  now = 0;
  ready = false;
  playback.reset();
  playback.setProject(3001, 30, 3000);
  playback.seek(100);
  playback.play(rate);
}

test("the clock waits at its frame until the pictures are there, then runs from it", () => {
  start();
  assert.equal(getPlayback().waiting, true);
  frameAt(200);
  frameAt(400);
  assert.equal(getPlayback().frame, 100, "held while a picture is missing");
  ready = true;
  frameAt(500);
  assert.equal(getPlayback().waiting, false);
  assert.equal(getPlayback().frame, 100, "starts from its frame, not where the wall clock got to");
  frameAt(1500);
  assert.equal(getPlayback().frame, 130);
  playback.pause();
});

test("the clock stops waiting after START_HOLD_MS", () => {
  start();
  frameAt(START_HOLD_MS - 10);
  assert.equal(getPlayback().frame, 100);
  frameAt(START_HOLD_MS + 10);
  assert.equal(getPlayback().waiting, false);
  frameAt(START_HOLD_MS + 1010);
  assert.equal(Math.round(getPlayback().frame), 130);
  playback.pause();
});

test("a jump while playing waits again; pausing ends the wait", () => {
  start();
  ready = true;
  frameAt(100);
  frameAt(1100);
  assert.equal(getPlayback().frame, 130);
  ready = false;
  now = 1100;
  playback.seek(500);
  assert.equal(getPlayback().waiting, true);
  frameAt(1600);
  assert.equal(getPlayback().frame, 500);
  playback.pause();
  assert.equal(getPlayback().waiting, false);
});

test("shuttling never waits", () => {
  start(2);
  assert.equal(getPlayback().waiting, false);
  frameAt(500);
  assert.equal(getPlayback().frame, 130);
  playback.pause();
});
