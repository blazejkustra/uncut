// Paths for the permission rules: absolute, inside, shown, real, Uncut's own files, named folders.
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve, relative, sep, join, dirname, basename } from "node:path";
import { expandHome } from "../../paths.ts";

export const str = (x: unknown) => (typeof x === "string" ? x : "");

/** `p` with ~ expanded, made absolute against the project. */
export function absolute(p: string, project: string, home = homedir()): string {
  // D198: ~ and $HOME (and ${HOME}) the same way everywhere (paths.ts expandHome).
  const t = expandHome(p, home, true);
  return isAbsolute(t) ? resolve(t) : resolve(project, t);
}

/** Whether `p` is `dir` or inside it. */
export function inside(p: string, dir: string): boolean {
  const rel = relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** A path for people: inside the project relative to it, else ~/… for the home folder. */
export function shownPath(p: string, project?: string, home = homedir()): string {
  if (!p) return p;
  const abs = project ? absolute(p, project, home) : p;
  if (project && inside(abs, project) && abs !== project) return relative(project, abs);
  if (inside(abs, home) && abs !== home) return `~${sep}${relative(home, abs)}`;
  return abs;
}

/** The file a built-in tool reads or writes, if it names one. */
export const toolPath = (input: Record<string, unknown>) => str(input.file_path) || str(input.notebook_path) || str(input.path);

/**
 * A path as it really is: ~ expanded, absolute against `base`, symlinks resolved for the part that
 * exists (a file not written yet resolves through its folder).
 */
export function realPath(p: string, base: string, home = homedir(), real: (p: string) => string = realpathSync.native): string {
  let abs = absolute(p, base, home);
  const tail: Array<string> = [];
  for (;;) {
    try {
      return join(real(abs), ...tail.reverse());
    } catch {
      const parent = dirname(abs);
      if (parent === abs) return join(abs, ...tail.reverse());
      tail.push(basename(abs));
      abs = parent;
    }
  }
}

/**
 * CLAUDE_CONFIG_DIR when the user set it (Claude Code's folder instead of ~/.claude): the folder as
 * set (~ expanded, absolute) and its real path when that differs; empty when it isn't set.
 */
export function claudeConfigDirs(env: NodeJS.ProcessEnv = process.env, home = homedir(), real: (p: string) => string = realpathSync.native): Array<string> {
  const v = env.CLAUDE_CONFIG_DIR?.trim();
  if (!v) return [];
  const abs = absolute(v, home, home);
  return [...new Set([abs, realPath(abs, home, home, real)])];
}

/** Uncut's own files in a project (compared without case: APFS isn't case-sensitive). */
const OWNED_RE = [/^project\.json$/, /^history\.db/, /^agent(\/|$)/, /^brand\/active\.json$/];
export function owned(real: string, project: string): boolean {
  if (!inside(real.toLowerCase(), project.toLowerCase())) return false;
  const rel = relative(project.toLowerCase(), real.toLowerCase()).split(sep).join("/");
  return OWNED_RE.some((re) => re.test(rel));
}

/**
 * Why a pasted folder can't become a root (D194), or undefined: it must be a real folder under the
 * home folder, at least one level down, not ~/Library, not a dot-folder anywhere on the way.
 */
export function rootProblem(dir: string, home = homedir()): string | undefined {
  if (!inside(dir, home) || dir === home) return "it isn't inside your home folder";
  const rel = relative(home, dir).split(sep);
  if (rel[0] === "Library") return "it's in ~/Library";
  if (rel.length === 1 && ["Documents", "Desktop", "Downloads"].includes(rel[0]!)) return `it's all of ~/${rel[0]}; paste a folder inside it`;
  if (rel.some((seg) => seg.startsWith("."))) return "it's a hidden folder";
  return undefined;
}

/**
 * Folders a message points at (D194, --add-dir): absolute or ~/ paths in its text that exist, a
 * file's own folder, the project and the root folder left out. At most 8.
 */
export function mentionedDirs(
  text: string,
  project: string,
  exists: (p: string) => "dir" | "file" | undefined,
  home = homedir(),
  real: (p: string) => string = realpathSync.native,
): Array<string> {
  return namedFolders(text, project, exists, home, real).flatMap((f) => (f.problem ? [] : [f.dir]));
}

/** A folder a message names (D198): the folder (its real path), whether the message named it or a file in it, and why it can't be a root. */
export interface NamedFolder {
  readonly dir: string;
  readonly named: "folder" | "file";
  readonly problem?: string;
}

/**
 * Every folder a message names (D194, D198): absolute, ~/ or $HOME/ paths in its text that exist
 * (a file gives its folder), each once, the project's own folder and anything in it left out. A
 * folder that can't be a root (rootProblem) comes with why; a file's folder that can't be is left
 * out (the file itself is what was meant). At most 8 usable ones.
 */
export function namedFolders(
  text: string,
  project: string,
  exists: (p: string) => "dir" | "file" | undefined,
  home = homedir(),
  real: (p: string) => string = realpathSync.native,
): Array<NamedFolder> {
  const out = new Map<string, NamedFolder>();
  let usable = 0;
  for (const m of text.matchAll(/(?:^|[\s"'`(<[])((?:~|\$HOME|\$\{HOME\}|\/)(?:\\ |[^\s"'`)<>\]])*)/g)) {
    let p = m[1]!.replace(/\\ /g, " ").replace(/[.,;:!?]+$/, "");
    if (!/^(?:\/|~\/|\$HOME\/|\$\{HOME\}\/)./.test(p)) continue;
    p = absolute(p, project, home);
    const kind = exists(p);
    const found = kind === "dir" ? p : kind === "file" ? dirname(p) : undefined;
    if (!found) continue;
    // The folder as it really is (a symlink to / or ~/Library is that), then the root rules.
    const dir = realPath(found, project, home, real);
    if (inside(dir, project) || out.has(dir)) continue;
    const problem = rootProblem(dir, home);
    if (problem && kind === "file") continue;
    out.set(dir, { dir, named: kind === "dir" ? "folder" : "file", ...(problem ? { problem } : {}) });
    if (!problem && ++usable >= 8) break;
  }
  return [...out.values()];
}
