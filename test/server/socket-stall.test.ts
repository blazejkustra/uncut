// Item 2 / 23 (2026-10-27): a window starved by a heavy export (or throttled in the background) mustn't
// drop a healthy socket. The ping deadline reads a clock that leaves out the time the page couldn't
// run (a 5 s stall used to drop it and reconnect); a server that stops answering is still noticed.
// A reconnecting window says why its last socket dropped, for server.log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BEAT_MS, stallClock } from "../../apps/web/src/state/stallClock.ts";
import { droppedBecause } from "../../apps/server/src/app/liveness.ts";

const fakeTime = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};
// Only its nanoseconds and sleep are passed through, which these tests don't use.
const base = {} as Parameters<typeof stallClock>[0];

test("time passes as usual while the page keeps running (a silent server still times out)", () => {
  const time = fakeTime();
  const stall = stallClock(base, time.now);
  const start = stall.clock.currentTimeMillisUnsafe();
  for (let i = 0; i < 28; i++) {
    time.advance(BEAT_MS);
    stall.beat();
  }
  assert.equal(stall.clock.currentTimeMillisUnsafe() - start, 7000);
  assert.equal(stall.takeLongest(), 0);
});

test("a page that couldn't run for 8 s sees almost none of it, before and after its next beat", () => {
  const time = fakeTime();
  const stall = stallClock(base, time.now);
  stall.beat();
  const start = stall.clock.currentTimeMillisUnsafe();
  time.advance(8000);
  const seenAtWake = stall.clock.currentTimeMillisUnsafe() - start;
  assert.ok(seenAtWake <= BEAT_MS + 1000, `the ping check at the end of the stall sees ${seenAtWake} ms`);
  stall.beat();
  assert.equal(stall.clock.currentTimeMillisUnsafe() - start, seenAtWake, "the beat doesn't move the clock");
  time.advance(BEAT_MS);
  stall.beat();
  assert.equal(stall.clock.currentTimeMillisUnsafe() - start, seenAtWake + BEAT_MS, "then it runs on");
  assert.equal(stall.takeLongest(), 8000 - BEAT_MS - 1000);
  assert.equal(stall.takeLongest(), 0, "forgotten once taken");
});

test("late timers within a second (a background window's 1 s timers) aren't stalls", () => {
  const time = fakeTime();
  const stall = stallClock(base, time.now);
  const start = stall.clock.currentTimeMillisUnsafe();
  for (let i = 0; i < 10; i++) {
    time.advance(1000);
    stall.beat();
  }
  assert.equal(stall.clock.currentTimeMillisUnsafe() - start, 10000);
});

test("the server logs a reconnecting window's reason, only as a short plain note", () => {
  assert.equal(droppedBecause("/ws?token=secret&dropped=window,stall=7.9s"), "window,stall=7.9s");
  assert.equal(droppedBecause("/ws?token=secret&dropped=close-1006,stall=0.0s"), "close-1006,stall=0.0s");
  assert.equal(droppedBecause("/ws?token=secret"), undefined);
  assert.equal(droppedBecause("/ws?dropped=%0A%5Buncut%5D%20forged"), undefined);
  assert.equal(droppedBecause(`/ws?dropped=${"x".repeat(65)}`), undefined);
});
