// Liveness notes on stderr (the desktop keeps them in <dataDir>/server.log): a server that stops
// answering without dying (the window says "Reconnecting to the server…") leaves no other trace.
// - A stall: the event loop came back late while this process burned CPU (synchronous work, GC
//   thrash near the heap limit). A late tick with hardly any CPU is the machine sleeping, or the
//   process paused or blocked on the OS, and is logged as that.
// - A heartbeat now and then with memory, so a log that stops shows when the server froze.
import { getHeapStatistics } from "node:v8";

import { DROPPED_QUERY_PARAM } from "@uncut/contracts";

const MB = 1024 * 1024;

export const memoryText = () => {
  const m = process.memoryUsage();
  const limit = getHeapStatistics().heap_size_limit;
  return `rss ${Math.round(m.rss / MB)} MB, heap ${Math.round(m.heapUsed / MB)}/${Math.round(limit / MB)} MB`;
};

/** Below this share of a late tick's time spent on CPU, the process wasn't running. */
const BUSY_SHARE = 0.2;

const cpuMs = () => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

export function watchLiveness(options: {
  readonly write: (line: string) => void;
  readonly tickMs?: number;
  /** A tick this much later than due is reported. */
  readonly stallMs?: number;
  /** 0: no heartbeat. */
  readonly heartbeatMs?: number;
  readonly now?: () => number;
  /** This process's CPU time so far (ms). */
  readonly cpu?: () => number;
}): () => void {
  const tickMs = options.tickMs ?? 1000;
  const stallMs = options.stallMs ?? 2000;
  const heartbeatMs = options.heartbeatMs ?? 0;
  // performance.now() is immune to clock steps but keeps counting while a Mac sleeps
  // (mach_continuous_time), so only the CPU time tells a sleep from a stall.
  const now = options.now ?? (() => performance.now());
  const cpu = options.cpu ?? cpuMs;
  let last = now();
  let lastCpu = cpu();
  let lastBeat = last;
  const timer = setInterval(() => {
    const at = now();
    const late = at - last - tickMs;
    const usedCpu = cpu() - lastCpu;
    last = at;
    lastCpu += usedCpu;
    if (late >= stallMs) options.write(lateTickLine(late, usedCpu));
    if (heartbeatMs > 0 && at - lastBeat >= heartbeatMs) {
      lastBeat = at;
      options.write(`[uncut] alive (${memoryText()})`);
    }
  }, tickMs);
  timer.unref();
  return () => clearInterval(timer);
}

function lateTickLine(lateMs: number, cpuUsedMs: number) {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  return cpuUsedMs >= lateMs * BUSY_SHARE
    ? `[uncut] event loop stalled for ${seconds(lateMs)} (${memoryText()}, cpu ${seconds(cpuUsedMs)})`
    : `[uncut] not running for ${seconds(lateMs)}: the machine slept or the process was paused (${memoryText()}, cpu ${seconds(cpuUsedMs)})`;
}

/** Why a reconnecting window's last socket dropped (DROPPED_QUERY_PARAM), when it's a short plain note. */
export const droppedBecause = (requestUrl: string) => {
  const value = new URL(requestUrl, "http://localhost").searchParams.get(DROPPED_QUERY_PARAM);
  return value && /^[\w.,=-]{1,64}$/.test(value) ? value : undefined;
};
