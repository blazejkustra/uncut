// Liveness notes on stderr (the desktop keeps them in <dataDir>/server.log): a server that stops
// answering without dying (the window says "Reconnecting to the server…") leaves no other trace.
// - A stall: the event loop came back late (synchronous work, GC thrash near the heap limit).
// - A heartbeat now and then with memory, so a log that stops shows when the server froze.
import { getHeapStatistics } from "node:v8";

const MB = 1024 * 1024;

export const memoryText = () => {
  const m = process.memoryUsage();
  const limit = getHeapStatistics().heap_size_limit;
  return `rss ${Math.round(m.rss / MB)} MB, heap ${Math.round(m.heapUsed / MB)}/${Math.round(limit / MB)} MB`;
};

export function watchLiveness(options: {
  readonly write: (line: string) => void;
  readonly tickMs?: number;
  /** A tick this much later than due is reported. */
  readonly stallMs?: number;
  /** 0: no heartbeat. */
  readonly heartbeatMs?: number;
  readonly now?: () => number;
}): () => void {
  const tickMs = options.tickMs ?? 1000;
  const stallMs = options.stallMs ?? 2000;
  const heartbeatMs = options.heartbeatMs ?? 0;
  const now = options.now ?? Date.now;
  let last = now();
  let lastBeat = last;
  const timer = setInterval(() => {
    const at = now();
    const late = at - last - tickMs;
    last = at;
    if (late >= stallMs) options.write(`[uncut] event loop stalled for ${(late / 1000).toFixed(1)} s (${memoryText()})`);
    if (heartbeatMs > 0 && at - lastBeat >= heartbeatMs) {
      lastBeat = at;
      options.write(`[uncut] alive (${memoryText()})`);
    }
  }, tickMs);
  timer.unref();
  return () => clearInterval(timer);
}
