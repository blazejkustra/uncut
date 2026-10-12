// Running an analysis tool (ffmpeg) to the end as a child process, killable (D66). Shared by the
// analyzers; children still running are killed if the server goes away.
import { spawn, type ChildProcess } from "node:child_process";

import { withoutApiKey } from "./shellEnv.ts";

/** ffmpeg's ways of saying the file has no audio stream for 0:a:0. */
export const NO_AUDIO_STREAM = /matches no streams|does not contain any stream|Failed to set value '0:a:0' for option 'map'/i;

/** The last useful lines of a tool's stderr, for an error message. */
export const ffmpegError = (stderr: string) =>
  stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(size=|frame=|Press \[q\])/.test(l))
    .slice(-3)
    .join(" ")
    .slice(0, 400);

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

export interface RunOptions {
  readonly signal: AbortSignal;
  readonly onStdout?: (line: string) => void;
  /** Raw stdout bytes (instead of lines), for tools that write frames there. */
  readonly onStdoutData?: (chunk: Buffer) => void;
  readonly onStderr?: (line: string) => void;
  readonly timeoutMs?: number;
}
/** Runs a tool to the end; rejects with Cancelled when `signal` aborts (the process is SIGKILLed). */
export type Runner = (bin: string, args: ReadonlyArray<string>, options: RunOptions) => Promise<{ readonly code: number | null; readonly stderrTail: string }>;

// Children still running, killed if the server goes away.
const children = new Set<ChildProcess>();
process.on("exit", () => {
  for (const child of children) child.kill("SIGKILL");
});

const lineSplitter = (onLine: ((line: string) => void) | undefined) => {
  let partial = "";
  return {
    push: (chunk: Buffer) => {
      if (!onLine) return;
      const lines = (partial + chunk.toString()).split(/\r?\n|\r/);
      partial = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    },
    end: () => {
      if (onLine && partial) onLine(partial);
      partial = "";
    },
  };
};

export const spawnRunner: Runner = (bin, args, { signal, onStdout, onStdoutData, onStderr, timeoutMs }) =>
  new Promise((resolvePromise, reject) => {
    if (signal.aborted) return reject(new Cancelled());
    const child = spawn(bin, [...args], { env: withoutApiKey(process.env), stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    const out = lineSplitter(onStdout);
    const err = lineSplitter(onStderr);
    let tail = "";
    child.stdout.on("data", (d: Buffer) => (onStdoutData ? onStdoutData(d) : out.push(d)));
    child.stderr.on("data", (d: Buffer) => {
      tail = (tail + d.toString()).slice(-16384);
      err.push(d);
    });
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => ((timedOut = true), child.kill("SIGKILL")), timeoutMs) : undefined;
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      children.delete(child);
    };
    child.once("error", (error) => {
      if (settled) return;
      cleanup();
      reject(signal.aborted ? new Cancelled() : error);
    });
    // Killed: done once the process is gone, without waiting for its pipes to close (a child it
    // left behind could hold them open).
    child.once("exit", () => {
      if (settled || !signal.aborted) return;
      cleanup();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Cancelled());
    });
    child.once("close", (code) => {
      if (settled) return;
      cleanup();
      out.end();
      err.end();
      if (signal.aborted) return reject(new Cancelled());
      if (timedOut) return reject(new Error("The analysis took too long and was stopped."));
      resolvePromise({ code, stderrTail: tail });
    });
  });
