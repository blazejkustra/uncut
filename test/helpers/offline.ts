// "Nothing left the machine" for packaged-app exit checks (D101's approach, D104): the renderer's
// requests are loopback or not network URLs, and the app's whole process tree never holds a
// connection to an address that isn't this machine (lsof, sampled every 300 ms). Limits as in D101:
// a connection shorter than a sample can be missed; UDP sends without connect aren't seen.
import { execFile, execFileSync } from "node:child_process";

/** Loopback, or not a network address at all. */
export const isLocalUrl = (u: string) => {
  try {
    const url = new URL(u);
    if (!/^(https?|wss?):$/.test(url.protocol)) return true;
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return true;
  }
};

/** Every process the app started (its whole tree), now. */
export const treeOf = (rootPid: number): Array<number> => {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number) as [number, number]);
  const pids = [rootPid];
  for (let i = 0; i < pids.length; i++) for (const [pid, ppid] of rows) if (ppid === pids[i] && !pids.includes(pid)) pids.push(pid);
  return pids;
};

/** Samples the tree's sockets every 300 ms until stopped; any connection off this machine goes into `remote`. */
export function watchSockets(rootPid: number, remote: Array<string>) {
  let on = true;
  void (async () => {
    while (on) {
      const pids = treeOf(rootPid);
      const listing = await new Promise<string>((done) => execFile("lsof", ["-nP", "-a", "-i", "-p", pids.join(",")], { encoding: "utf8" }, (_e, stdout) => done(stdout ?? "")));
      for (const line of listing.split("\n").slice(1)) {
        const m = /->(\S+)/.exec(line);
        if (m && !/^(127\.0\.0\.1|\[::1\]|localhost):/.test(m[1]!)) remote.push(line.trim());
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  })();
  return { stop: () => void (on = false) };
}
