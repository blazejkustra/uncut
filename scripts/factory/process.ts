import { spawn, type ChildProcess } from "node:child_process";

const MAX_OUTPUT_CHARS = 2_000_000;

export interface ChildOptions {
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly timeoutMs: number;
}

export interface ChildResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

const live = new Set<ChildProcess>();

function killGroup(child: ChildProcess) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
}

export function killLiveChildren() {
  for (const child of live) killGroup(child);
}

function keepTail(current: string, chunk: string) {
  const joined = current + chunk;
  return joined.length > MAX_OUTPUT_CHARS ? joined.slice(-MAX_OUTPUT_CHARS) : joined;
}

/** Never goes through a shell: arguments reach the child as they are. */
export function runChild(command: string, args: ReadonlyArray<string>, options: ChildOptions): Promise<ChildResult> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: "pipe" });
    live.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, options.timeoutMs);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      live.delete(child);
      done({ code, stdout, stderr, timedOut });
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout = keepTail(stdout, chunk)));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = keepTail(stderr, chunk)));
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");
    child.on("error", (error) => {
      stderr = keepTail(stderr, String(error));
      finish(127);
    });
    child.on("close", finish);
  });
}
