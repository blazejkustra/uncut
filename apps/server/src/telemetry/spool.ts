// Crashes that end a process can't be sent by it (issue #13, D223): the desktop's main process
// and a dying server append one line each to <dataDir>/telemetry-crashes.jsonl, already reduced
// to the crash event's fields (never a message or a stack), and the server sends them on its next
// start (and every minute while it runs). Reading empties the file whatever happens next, so
// with telemetry off or no token the lines are simply dropped.
import { appendFileSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { crashFingerprint, errorCodeOf, errorNameOf } from "./fingerprint.ts";

export const SPOOL_FILE = "telemetry-crashes.jsonl";
const MAX_BYTES = 64 * 1024;
const MAX_LINES = 50;

export interface SpooledCrash {
  readonly process: string;
  readonly error_name: string;
  readonly crash_fingerprint?: string;
  readonly code?: string;
  readonly fatal?: boolean;
}

/** The crash event's fields for an error: its class name, err.code and the stack's fingerprint. */
export const crashOf = (process: string, error: unknown, fatal?: boolean): SpooledCrash => {
  const error_name = errorNameOf(error);
  const code = errorCodeOf(error);
  const stack = (error as { stack?: unknown } | null)?.stack;
  return { process, error_name, crash_fingerprint: crashFingerprint(error_name, typeof stack === "string" ? stack : undefined), ...(code ? { code } : {}), ...(fatal !== undefined ? { fatal } : {}) };
};

/** Appends one crash (synchronously: the process may be about to die). Never throws. */
export function spoolCrash(dataDir: string, crash: SpooledCrash): void {
  try {
    const file = join(dataDir, SPOOL_FILE);
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {}
    if (size > MAX_BYTES) return;
    appendFileSync(file, `${JSON.stringify(crash)}\n`, { mode: 0o600 });
  } catch {}
}

/** Takes the spooled crashes (the file is gone afterwards). Never throws. */
export function takeSpooledCrashes(dataDir: string): Array<Record<string, unknown>> {
  const file = join(dataDir, SPOOL_FILE);
  const taken = `${file}.${process.pid}.reading`;
  try {
    // Renamed first so a line appended meanwhile lands in a fresh file, not in one being deleted.
    renameSync(file, taken);
  } catch {
    return [];
  }
  let text = "";
  try {
    if (statSync(taken).size <= MAX_BYTES * 2) text = readFileSync(taken, "utf8");
  } catch {}
  try {
    unlinkSync(taken);
  } catch {}
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n").slice(0, MAX_LINES)) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) out.push(value as Record<string, unknown>);
    } catch {}
  }
  return out;
}
