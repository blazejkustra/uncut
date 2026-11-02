import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { totalmem } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);
const FOOTPRINT = "/usr/bin/footprint";
const UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

/** How much memory one export ffmpeg may hold: 40 % of this Mac's, so the rest of the system keeps running. */
export const ffmpegMemoryLimit = (total = totalmem()) => Math.round(total * 0.4);

/** `footprint -p`'s figure in bytes (what macOS's memory pressure counts, compressed pages included). */
export const parseFootprint = (out: string) => {
  const m = /Footprint:\s*([\d.]+)\s*(B|KB|MB|GB)\b/.exec(out);
  return m ? Number(m[1]) * UNITS[m[2]!]! : undefined;
};

const footprintOf = (pid: number) => exec(FOOTPRINT, ["-p", String(pid)], { timeout: 5000 }).then((r) => parseFootprint(r.stdout));
const rssOf = (pid: number) => exec("ps", ["-o", "rss=", "-p", String(pid)], { timeout: 5000 }).then((r) => Number(r.stdout.trim()) * 1024 || undefined);

/** A process's memory in bytes: its footprint on macOS, else its resident size; undefined once it's gone. */
export const memoryOf = (pid: number): Promise<number | undefined> =>
  (process.platform === "darwin" && existsSync(FOOTPRINT) ? footprintOf(pid) : rssOf(pid)).catch(() => undefined);

export class MemoryLimitExceeded extends Error {
  readonly used: number;
  readonly limit: number;
  constructor(used: number, limit: number) {
    const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
    super(`ffmpeg was stopped at ${gb(used)} GB of memory, over the ${gb(limit)} GB one job may use on this Mac. Try fewer clips at once or a shorter range.`);
    this.used = used;
    this.limit = limit;
  }
}

/** Calls `over` once when `pid` holds more than `limit` bytes, checked every `everyMs`; returns the stop. */
export function watchMemory(pid: number, limit: number, over: (used: number) => void, everyMs = 1000, measure = memoryOf) {
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    const used = await measure(pid);
    checking = false;
    if (used !== undefined && used > limit) {
      clearInterval(timer);
      over(used);
    }
  };
  const timer = setInterval(check, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
