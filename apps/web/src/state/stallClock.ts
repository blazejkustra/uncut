// The clock the socket's ping deadline reads (Effect RpcClient: no frame for pingTimeout means a
// dropped socket). Time this page couldn't run (a long task, a renderer starved by an export, a
// throttled background window) is left out: the server's frames wait in the page's queue meanwhile,
// so that time says nothing about the server. Without this, a 5 s stall dropped a healthy socket.
import type * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

/** How often `beat` should run (ms). */
export const BEAT_MS = 250;
/** How late a beat may be before the gap counts as a stall (ms): timer jitter and 1 s background timers aren't stalls. */
const SLACK_MS = 1000;

export interface StallClock {
  readonly clock: Clock.Clock;
  /** Call every BEAT_MS. */
  readonly beat: () => void;
  /** The longest stall seen since the last call (ms), then forgotten. */
  readonly takeLongest: () => number;
}

export function stallClock(base: Clock.Clock, now: () => number = Date.now): StallClock {
  let lastBeat = now();
  let stalled = 0;
  let longest = 0;
  const excess = (t: number) => Math.max(0, t - lastBeat - BEAT_MS - SLACK_MS);
  const millis = () => {
    const t = now();
    return t - stalled - excess(t);
  };
  return {
    clock: {
      currentTimeMillisUnsafe: millis,
      currentTimeMillis: Effect.sync(millis),
      currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
      currentTimeNanos: base.currentTimeNanos,
      monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: base.monotonicTimeNanos,
      sleep: (duration) => base.sleep(duration),
    },
    beat: () => {
      const t = now();
      const gap = excess(t);
      stalled += gap;
      longest = Math.max(longest, gap);
      lastBeat = t;
    },
    takeLongest: () => {
      const value = Math.max(longest, excess(now()));
      longest = 0;
      return value;
    },
  };
}
