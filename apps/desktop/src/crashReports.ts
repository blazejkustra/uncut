// Crash reports from the desktop's main process (issue #13, D223). Main doesn't talk to the
// telemetry endpoint itself: it appends each crash, already reduced to the crash event's fields
// (an error's class name, err.code and stack fingerprint; a process's gone reason and exit code),
// to the server's spool, and the server sends them under the user's telemetry choice (or drops
// them: no token, opted out). Never a message, a stack or a path.
import { app } from "electron";

import { crashFingerprint } from "../../server/src/telemetry/fingerprint.ts";
import { crashOf, spoolCrash, type SpooledCrash } from "../../server/src/telemetry/spool.ts";

/** A process that went away: no stack, so the fingerprint is that of the process kind and reason. */
const gone = (process: string, reason: string, code: string | undefined): SpooledCrash => ({
  process,
  error_name: reason,
  crash_fingerprint: crashFingerprint(`${process}/${reason}`, undefined),
  ...(code ? { code } : {}),
  fatal: true,
});

/** Reasons a Chromium child process leaves that aren't crashes. */
const NOT_CRASHES = new Set(["clean-exit", "killed"]);

export function installCrashReports(dataDir: string): void {
  // A monitor only: Electron's own handling of the error (its dialog) is unchanged.
  process.on("uncaughtExceptionMonitor", (error) => spoolCrash(dataDir, crashOf("main", error)));
  app.on("render-process-gone", (_event, _contents, details) => {
    if (NOT_CRASHES.has(details.reason)) return;
    spoolCrash(dataDir, gone("renderer", details.reason, String(details.exitCode)));
  });
  app.on("child-process-gone", (_event, details) => {
    if (NOT_CRASHES.has(details.reason)) return;
    spoolCrash(dataDir, gone(details.type === "GPU" ? "gpu" : "utility", details.reason, String(details.exitCode)));
  });
}

/** The local server died on its own ("server exited unexpectedly (code 1)" / "(SIGSEGV)"). */
export function reportServerExit(dataDir: string, reason: string): void {
  const how = /\((?:code )?([^)]+)\)\s*$/.exec(reason)?.[1];
  spoolCrash(dataDir, gone("server", "exited", how));
}
