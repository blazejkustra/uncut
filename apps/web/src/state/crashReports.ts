// The window's uncaught errors and rejections go to the server's telemetry (issue #13, D223):
// only the error's class name and stack are sent over the local connection, and the server keeps
// nothing but the stack's fingerprint (never the message). At most 10 per window.
import { call } from "./store/server.ts";

const MAX = 10;

export function installCrashReports(): void {
  let sent = 0;
  const report = (error: unknown) => {
    if (sent >= MAX || !(error instanceof Error)) return;
    sent++;
    void call((c) => c["telemetry.crash"]({ name: error.name, stack: error.stack?.slice(0, 16_384) })).catch(() => {});
  };
  window.addEventListener("error", (e) => report(e.error));
  window.addEventListener("unhandledrejection", (e) => report(e.reason));
}
