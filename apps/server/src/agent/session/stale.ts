import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each session's --mcp-config (claude) lives in tmpdir/uncut-agent-<server pid>-XXXXXX (0600, removed when
// the turn ends).
export const TURN_DIR_PREFIX = "uncut-agent-";
/** Issue #106: a Codex session's folder holds its app-server's pid. */
export const CODEX_PID = "codex.pid";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Turn folders whose server is gone (it was SIGKILLed or crashed): stop a claude still running
 * from one (found by its --mcp-config path on the command line, so no unrelated process with a
 * reused pid is touched), or a Codex app-server (issue #106: the pid in the folder's codex.pid, if
 * that process is still a `codex app-server`), then remove the folder.
 */
export function cleanStaleTurns(dir = tmpdir()) {
  let names: Array<string>;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = new RegExp(`^${TURN_DIR_PREFIX}(\\d+)-`).exec(name);
    if (!m || alive(Number(m[1]))) continue;
    const folder = join(dir, name);
    let codexPid: number | undefined;
    try {
      codexPid = Number(readFileSync(join(folder, CODEX_PID), "utf8").trim()) || undefined;
    } catch {}
    try {
      const ps = execFileSync("ps", ["-axo", "pid=,pgid=,args="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      for (const line of ps.split("\n")) {
        const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (row && (row[3]!.includes(join(folder, "mcp.json")) || (codexPid === Number(row[1]) && /codex/.test(row[3]!) && row[3]!.includes("app-server")))) {
          try {
            process.kill(-Number(row[2]), "SIGKILL");
          } catch {}
        }
      }
    } catch {}
    rmSync(folder, { recursive: true, force: true });
  }
}
