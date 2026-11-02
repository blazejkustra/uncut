// Keeps an unattended run from taking the Mac down: an export's ffmpeg once grew past 20 GB on a
// 24 GB Mac until the kernel rebooted it. Nothing starts while memory or disk is short or another
// ffmpeg is running, and a child process tree over its memory cap is killed at once.
import { spawnSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { totalmem } from "node:os";

export const GB = 1024 ** 3;

export interface GuardLimits {
  readonly capBytes: number;
  readonly minFreePercent: number;
  readonly minDiskBytes: number;
  readonly waitMs: number;
}

const DEFAULT_CAP_FRACTION = 0.25;
const DEFAULT_MIN_FREE_PERCENT = 30;
const DEFAULT_MIN_DISK_GB = 5;
const DEFAULT_WAIT_MS = 5 * 60 * 1000;

const envNumber = (name: string) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

/** UNCUT_FACTORY_MEMORY_CAP_GB, UNCUT_FACTORY_MIN_FREE_PERCENT and UNCUT_FACTORY_MIN_DISK_GB override the defaults. */
export function guardLimits(): GuardLimits {
  return {
    capBytes: (envNumber("UNCUT_FACTORY_MEMORY_CAP_GB") ?? (totalmem() * DEFAULT_CAP_FRACTION) / GB) * GB,
    minFreePercent: envNumber("UNCUT_FACTORY_MIN_FREE_PERCENT") ?? DEFAULT_MIN_FREE_PERCENT,
    minDiskBytes: (envNumber("UNCUT_FACTORY_MIN_DISK_GB") ?? DEFAULT_MIN_DISK_GB) * GB,
    waitMs: DEFAULT_WAIT_MS,
  };
}

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
  readonly command: string;
}

export function parsePs(text: string): Array<ProcessRow> {
  return text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024, command: match[4]! }] : [];
  });
}

export const listProcesses = () => parsePs(spawnSync("ps", ["-Ao", "pid=,ppid=,rss=,comm="], { encoding: "utf8" }).stdout);

/** `root` and everything it started, however deep. */
export function treeOf(rows: ReadonlyArray<ProcessRow>, root: number) {
  const ids = new Set([root]);
  let grew = true;
  while (grew) {
    const before = ids.size;
    for (const row of rows) if (ids.has(row.ppid)) ids.add(row.pid);
    grew = ids.size > before;
  }
  return rows.filter((row) => ids.has(row.pid));
}

const isVideoToolboxService = (row: ProcessRow) => row.command.endsWith("VTDecoderXPCService") || row.command.endsWith("VTEncoderXPCService");

/** The video services serve the whole Mac, so only what they grew by since `baseline` counts against a run. */
export const videoServiceBytes = (rows: ReadonlyArray<ProcessRow>) => rows.filter(isVideoToolboxService).reduce((sum, row) => sum + row.rssBytes, 0);

export function treeBytes(rows: ReadonlyArray<ProcessRow>, root: number, serviceBaseline: number) {
  const own = treeOf(rows, root).reduce((sum, row) => sum + row.rssBytes, 0);
  return own + Math.max(0, videoServiceBytes(rows) - serviceBaseline);
}

export function killTree(root: number, rows: ReadonlyArray<ProcessRow> = listProcesses()) {
  const pids = treeOf(rows, root).map((row) => row.pid);
  for (const target of [-root, ...pids]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {}
  }
}

export interface Breach {
  readonly peakBytes: number;
  readonly capBytes: number;
}

export const breachReason = ({ peakBytes, capBytes }: Breach) =>
  `blocked: memory, the process tree reached ${(peakBytes / GB).toFixed(1)} GB over its ${(capBytes / GB).toFixed(1)} GB cap and was killed`;

const SAMPLE_MS = 500;

export interface TreeWatch {
  readonly breach: () => Breach | undefined;
  readonly peakBytes: () => number;
  readonly stop: () => void;
}

/** Samples the tree under `root` every half second and kills all of it the moment it's over `capBytes`. */
export function watchTree(root: number, capBytes: number, sample: () => ReadonlyArray<ProcessRow> = listProcesses): TreeWatch {
  const serviceBaseline = videoServiceBytes(sample());
  let peak = 0;
  let breach: Breach | undefined;
  const timer = setInterval(() => {
    const rows = sample();
    peak = Math.max(peak, treeBytes(rows, root, serviceBaseline));
    if (peak <= capBytes || breach) return;
    breach = { peakBytes: peak, capBytes };
    killTree(root, rows);
  }, SAMPLE_MS);
  return { breach: () => breach, peakBytes: () => peak, stop: () => clearInterval(timer) };
}

export interface Room {
  readonly freePercent: number | undefined;
  readonly diskFreeBytes: number;
  readonly otherFfmpeg: ReadonlyArray<number>;
}

const FREE_PERCENT = /memory free percentage:\s*(\d+)%/;

export function memoryFreePercent() {
  const match = FREE_PERCENT.exec(spawnSync("memory_pressure", [], { encoding: "utf8", timeout: 20000 }).stdout ?? "");
  return match ? Number(match[1]) : undefined;
}

const isFfmpeg = (row: ProcessRow) => /(^|\/)ffmpeg$/.test(row.command);

export function measureRoom(path: string): Room {
  const rows = listProcesses();
  const mine = new Set(treeOf(rows, process.pid).map((row) => row.pid));
  const fs = statfsSync(path);
  return {
    freePercent: memoryFreePercent(),
    diskFreeBytes: fs.bavail * fs.bsize,
    otherFfmpeg: rows.filter((row) => isFfmpeg(row) && !mine.has(row.pid)).map((row) => row.pid),
  };
}

export function roomProblems(room: Room, limits: GuardLimits) {
  const problems: Array<string> = [];
  if (room.freePercent === undefined) problems.push("blocked: memory, memory_pressure gave no free percentage");
  else if (room.freePercent < limits.minFreePercent) problems.push(`blocked: memory, ${room.freePercent}% free, needs ${limits.minFreePercent}%`);
  if (room.diskFreeBytes < limits.minDiskBytes)
    problems.push(`blocked: disk, ${(room.diskFreeBytes / GB).toFixed(1)} GB free, needs ${limits.minDiskBytes / GB} GB`);
  if (room.otherFfmpeg.length) problems.push(`blocked: another ffmpeg is running (pid ${room.otherFfmpeg.join(", ")})`);
  return problems;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const POLL_MS = 10000;

/** Waits up to `limits.waitMs` for room; resolves to what still stands in the way, or [] once there's room. */
export async function waitForRoom(limits: GuardLimits, measure: () => Room, pollMs = POLL_MS) {
  const end = Date.now() + limits.waitMs;
  let problems = roomProblems(measure(), limits);
  while (problems.length && Date.now() < end) {
    await sleep(pollMs);
    problems = roomProblems(measure(), limits);
  }
  return problems;
}

/** Thrown when a step can't start for want of room, or was killed over its memory cap: never retried. */
export class Blocked extends Error {
  readonly breach: Breach | undefined;
  constructor(reason: string, breach?: Breach) {
    super(reason);
    this.breach = breach;
  }
}

/** Resolves once there's room for a step, or throws Blocked with what stands in the way. */
export async function ensureRoom(limits: GuardLimits, path: string) {
  const problems = await waitForRoom(limits, () => measureRoom(path));
  if (problems.length) throw new Blocked(problems.join("; "));
}
