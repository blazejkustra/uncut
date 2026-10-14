// Paths relative to the server's own file. This module stays at the root of src/ so the URL it
// resolves against sits at the same depth as the bundle (apps/server/dist/server.mjs): a path
// like "../../../assets" means the same place whether the server runs from source or bundled.
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `rel` resolved against src/ (from source) or dist/ (bundled), as a file path. */
export const besideServer = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/**
 * D198 (issue #37): a path from the user or the agent with the home folder written out. `~`, `~/…`,
 * `$HOME`, `$HOME/…`, `${HOME}` and `${HOME}/…` become the home folder; quotes around the whole path
 * and Terminal's backslash-escaped spaces are taken off (not with `exact`, for permission checks,
 * which must judge the very string a tool gets). Anything else comes back trimmed.
 */
export function expandHome(path: string, home = homedir(), exact = false): string {
  let p = path.trim();
  if (!exact) {
    if (p.length >= 2 && (p[0] === '"' || p[0] === "'") && p.at(-1) === p[0]) p = p.slice(1, -1).trim();
    p = p.replace(/\\ /g, " ");
  }
  const m = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)(.*)$/s.exec(p);
  if (!m) return p;
  const rest = m[1]!.replace(/^\/+/, "");
  return rest ? join(home, rest) : home;
}
