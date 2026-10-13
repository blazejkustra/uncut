// Runs a local tool for detection and gives back what it printed, whatever the tool does.
// It never throws or rejects: a program that can't start (no #!, zero bytes, no permission),
// one that floods its output, hangs, or exits but leaves a child holding the pipe all end
// up as a result value. Node's child_process is used directly because the Effect spawner
// waits for EOF and has no output cap; both matter here.
import { spawn } from "node:child_process";

export type ProbeResult =
  | { readonly kind: "done"; readonly code: number; readonly stdout: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "overflow" }
  | { readonly kind: "failed"; readonly message: string };

export interface ProbeOptions {
  readonly timeoutMs: number;
  readonly env: Record<string, string>;
  /** Stop reading (and kill the tool) past this many bytes of stdout. */
  readonly maxBytes?: number;
  /** After the tool exits, how long to wait for output still in the pipe. */
  readonly drainMs?: number;
}

/** Why a program couldn't start, in words. */
const startError = (error: NodeJS.ErrnoException) =>
  error.code === "ENOEXEC"
    ? "it isn't a valid program"
    : error.code === "EACCES"
      ? "it isn't allowed to run"
      : error.code === "ENOENT"
        ? "it doesn't exist"
        : (error.message ?? String(error));

export function runProbe(command: string, args: ReadonlyArray<string>, options: ProbeOptions): Promise<ProbeResult> {
  const { timeoutMs, env, maxBytes = 64 * 1024, drainMs = 200 } = options;
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const chunks: Array<Buffer> = [];
    let bytes = 0;
    let timer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;

    // Its own process group, so a kill also reaches anything it started (a `sleep`, a pager).
    const killAll = () => {
      try {
        if (child?.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child?.kill("SIGKILL");
        } catch {}
      }
    };
    const finish = (result: ProbeResult, kill: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      if (kill) killAll();
      child?.stdout?.destroy();
      resolve(result);
    };

    try {
      child = spawn(command, [...args], { env, stdio: ["ignore", "pipe", "ignore"], detached: true });
    } catch (error) {
      return resolve({ kind: "failed", message: startError(error as NodeJS.ErrnoException) });
    }
    child.on("error", (error) => finish({ kind: "failed", message: startError(error) }, true));
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) return finish({ kind: "overflow" }, true);
      chunks.push(chunk);
    });
    // Resolve on exit (plus a short drain), not on EOF: a leftover child can keep the pipe open.
    child.on("exit", (code, signal) => {
      drainTimer = setTimeout(
        () => finish({ kind: "done", code: code ?? (signal ? 128 : 1), stdout: Buffer.concat(chunks).toString("utf8") }, true),
        drainMs,
      );
    });
    child.stdout?.on("end", () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        finish({ kind: "done", code: child.exitCode ?? 128, stdout: Buffer.concat(chunks).toString("utf8") }, false);
      }
    });
    timer = setTimeout(() => finish({ kind: "timeout" }, true), timeoutMs);
  });
}
