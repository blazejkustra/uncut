// Shell commands for the permission rules: segments, words, destructive ones, the read-only allowlist.
import { homedir } from "node:os";
import { basename } from "node:path";
import { absolute, inside, owned } from "./paths.ts";


/** The commands of a shell line: split on ;, &&, ||, |, & and newlines (quotes kept together). */
export function shellSegments(command: string): Array<string> {
  const out: Array<string> = [];
  let cur = "";
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < command.length) cur += c + command[++i];
      else {
        cur += c;
        if (c === quote) quote = undefined;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      cur += c + command[++i];
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || c === "&") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      if ((c === "|" || c === "&") && command[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A command's words, quotes taken off (enough to read flags and paths; not a full shell parser). */
export function shellWords(segment: string): Array<string> {
  const words: Array<string> = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|((?:[^\s"'\\]|\\.)+)/g;
  for (let m = re.exec(segment); m; m = re.exec(segment)) words.push(m[1] ?? m[2] ?? m[3]!.replace(/\\(.)/g, "$1"));
  return words;
}

/** The program a segment runs, past env assignments, `command`, `exec`, `time`, `nohup`. */
function program(words: ReadonlyArray<string>): { name: string; args: ReadonlyArray<string> } {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || ["command", "exec", "time", "nohup", "env"].includes(words[i]!))) i++;
  const name = basename(words[i] ?? "");
  return { name, args: words.slice(i + 1) };
}

/**
 * Why a shell line is destructive (it always asks, never granted), or undefined: sudo/su/doas, rm
 * with -r or -f (or any rm) of a path outside the project, git push, uploads (curl/wget sending
 * data or files, scp, rsync/sftp to a host, nc), disk and system commands, and writing outside
 * the project with a redirect.
 */
export function destructive(command: string, project: string, roots: ReadonlyArray<string> = [], home = homedir()): string | undefined {
  // The folder relative paths are in: the project, moved by a `cd` earlier on the line.
  let cwd = project;
  // Inside the project (not the project folder itself) or a mentioned folder; a $VAR or `…` is unknown, so no.
  const ok = (p: string) => {
    if (!p || /[$`]/.test(p)) return false;
    const abs = absolute(p.replace(/\/?\*+$/, "") || ".", cwd, home);
    return abs !== project && [project, ...roots].some((d) => inside(abs, d));
  };
  for (const segment of shellSegments(command)) {
    const words = shellWords(segment);
    const { name, args } = program(words);
    if (name === "cd" || name === "pushd") {
      const to = args.find((a) => !a.startsWith("-")) ?? "~";
      cwd = /[$`]/.test(to) ? "/" : absolute(to, cwd, home);
      continue;
    }
    if (["sudo", "su", "doas"].includes(name)) return `${name} runs as another user`;
    // A shell running a line (bash -c "…", eval "…") is judged by that line; xargs by the command it runs.
    if (["bash", "sh", "zsh", "dash"].includes(name) && args.includes("-c")) {
      const inner = destructive(args[args.indexOf("-c") + 1] ?? "", project, roots, home);
      if (inner) return inner;
    }
    if (name === "eval") {
      const inner = destructive(args.join(" "), project, roots, home);
      if (inner) return inner;
    }
    if (name === "xargs" && args.some((a) => ["rm", "rmdir", "shred", "sudo", "mv", "chmod", "chown"].includes(basename(a)))) return "runs a command on files it can't see in advance";
    if (name === "rm" || name === "rmdir" || name === "shred" || name === "srm") {
      const targets = args.filter((a) => !a.startsWith("-"));
      const outside = targets.filter((t) => !ok(t));
      if (outside.length || !targets.length) return `deletes ${outside.length ? outside.slice(0, 2).join(", ") : "files"} outside the project`;
    }
    if (name === "git" && args.includes("push")) return "git push sends commits to a remote";
    if (name === "curl") {
      if (args.some((a) => /^(-d|--data.*|-F|--form.*|-T|--upload-file|--json)$/.test(a) || /^-[a-zA-Z]*[dFT]$/.test(a))) return "curl uploads data";
      const x = args.findIndex((a) => a === "-X" || a === "--request");
      if (x >= 0 && /^(POST|PUT|PATCH|DELETE)$/i.test(args[x + 1] ?? "")) return `curl sends a ${args[x + 1]!.toUpperCase()} request`;
    }
    if (name === "wget" && args.some((a) => /^--(post|put|body|method)/.test(a))) return "wget uploads data";
    if (["scp", "sftp", "ftp", "nc", "ncat", "netcat", "telnet", "ssh"].includes(name)) return `${name} talks to another machine`;
    if (name === "rsync" && args.some((a) => /^[^/\s]+:/.test(a) || a.startsWith("rsync://"))) return "rsync to another machine";
    if (["mkfs", "diskutil", "dd", "fdisk", "shutdown", "reboot", "halt", "launchctl", "csrutil", "spctl", "systemsetup", "defaults", "crontab", "chown"].includes(name) || name.startsWith("mkfs.")) return `${name} changes the system`;
    if ((name === "chmod" || name === "chflags") && args.some((a) => !a.startsWith("-") && /^[/~]/.test(a) && !ok(a))) return `${name} outside the project`;
    if (name === "mv" || name === "cp" || name === "ln" || name === "tee" || name === "install") {
      const t = args.findIndex((a) => a === "-t" || a === "--target-directory" || a.startsWith("--target-directory="));
      const target = t < 0 ? undefined : args[t]!.includes("=") ? args[t]!.split("=")[1]! : args[t + 1];
      const paths = args.filter((a, i) => !a.startsWith("-") && i !== t + 1);
      const dest = target !== undefined ? [target] : name === "tee" ? paths : paths.slice(-1);
      if (name === "mv" && paths.slice(0, -1).some((p) => !ok(p))) return "moves files from outside the project";
      if (dest.some((p) => !ok(p))) return `writes ${dest.find((p) => !ok(p))} outside the project`;
    }
    if (name === "find" && args.includes("-delete") && args.filter((a) => !a.startsWith("-")).slice(0, 1).some((p) => !ok(p))) return "deletes files outside the project";
    for (const m of segment.matchAll(/(?:^|[^<>&\d])>>?\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
      const target = m[1]!.replace(/^["']|["']$/g, "");
      if (target === "/dev/null" || target.startsWith("&")) continue;
      if (!ok(target)) return `writes ${target} outside the project`;
    }
  }
  return undefined;
}

/** Characters and words that make a command more than one simple program call. */
const COMPLEX = /[$`(){}<>|;&\n\r\\]|<<|\*\*|\bsudo\b/;

/**
 * A single simple command's words, or why it isn't one: no shell syntax ($, `, (, ), {, }, <, >,
 * |, ;, &, newlines, here-docs, backslashes), every quote a whole word ("my file", not r""m).
 */
export function simpleCommand(command: string): { words: Array<string> } | { complex: string } {
  const c = command.trim();
  if (!c) return { complex: "it's empty" };
  if (COMPLEX.test(c)) return { complex: "it uses shell syntax ($, `, pipes, redirects, ; or &)" };
  const words: Array<string> = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s"']+)/g;
  let last = 0;
  for (let m = re.exec(c); m; m = re.exec(c)) {
    const between = c.slice(last, m.index);
    // A quoted piece glued to another piece (r""m, "r"m, a"b") rebuilds a word the eye doesn't see.
    if (m.index > 0 && !/\s$/.test(between) && last > 0) return { complex: "it builds words out of quoted pieces" };
    if (m.index > 0 && between && !/^\s+$/.test(between)) return { complex: "it builds words out of quoted pieces" };
    words.push(m[1] ?? m[2] ?? m[3]!);
    last = m.index + m[0].length;
  }
  return { words };
}

/** The flags each auto-allowed command may carry (anything else, or a flag glued to a value, is a card). */
const FLAGS: Record<string, ReadonlySet<string>> = {
  ls: new Set(["-l", "-a", "-la", "-al", "-lh", "-hl", "-lah", "-alh", "-1", "-h"]),
  cat: new Set(),
  // -n and -c take a count (the next word, digits only).
  head: new Set(["-n", "-c"]),
  tail: new Set(["-n", "-c"]),
  stat: new Set(),
  mkdir: new Set(["-p"]),
};

/** Where an allowlisted command may read: the project, and (reads only) the sanctioned folders (D296). */
export interface ReadZones {
  readonly project: string;
  /** The active kit's folder and the bundled graphic libraries: read, never written. Real paths. */
  readonly sanctioned?: ReadonlyArray<string>;
}

/**
 * Auto's commands that run without a card when claude asks Uncut (D194, after two security reviews;
 * issue A/B 2026-10-17): ls, cat, head, tail and stat of paths inside the project or a sanctioned
 * folder (the active kit, the graphic libraries), and mkdir -p of paths inside the project only.
 * A path may be relative (to the project) or absolute; never ~, .., * ? [ ] { } or =; it is judged
 * by its real path (`real`, symlinks followed), so a link can't reach out. Only the flags in FLAGS
 * (head/tail: -n or -c and a number). Reading Uncut's own files (project.json, …) is fine; making a
 * folder there isn't. Media work goes through Uncut's tools; ffmpeg, ffprobe, file, wc and the rest
 * always get a card.
 */
export function allowlisted(name: string, args: ReadonlyArray<string>, real: (p: string) => string, zones: string | ReadZones): boolean {
  const { project, sanctioned = [] } = typeof zones === "string" ? { project: zones } : zones;
  const flags = FLAGS[name];
  if (!flags) return false;
  const paths: Array<string> = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      if (!flags.has(a)) return false;
      if (a === "-n" || a === "-c") {
        if (!/^\d{1,9}$/.test(args[i + 1] ?? "")) return false;
        i++;
      }
      continue;
    }
    paths.push(a);
  }
  const plain = (a: string) => a.length > 0 && !a.startsWith("~") && !/[*?[\]{}=\\$`]/.test(a) && !a.split("/").includes("..");
  const readable = (a: string) => {
    if (!plain(a)) return false;
    const r = real(a);
    return inside(r, project) || sanctioned.some((d) => inside(r, d));
  };
  if (name === "mkdir") {
    return paths.length > 0 && paths.every((a) => {
      if (!plain(a)) return false;
      const r = real(a);
      return inside(r, project) && r !== project && !owned(r, project);
    });
  }
  return paths.every(readable);
}

/** Stands for an escaped space (`Application\ Support`) while a read-only line is parsed. */
const SPACE = "\u0001";

/**
 * A line with each unquoted backslash-space (`Application\\ Support`, as shells and Finder copy it)
 * swapped for SPACE, or undefined when it has any other backslash or a SPACE of its own.
 */
function escapedSpaces(c: string): string | undefined {
  if (c.includes(SPACE)) return undefined;
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i]!;
    if (quote) {
      if (ch === "\\") return undefined;
      if (ch === quote) quote = undefined;
      out += ch;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    if (ch === "\\") {
      if (c[i + 1] !== " ") return undefined;
      out += SPACE;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * A read-only line pinned to the project: `cd '<project>' && {` the line `}`. readOnlyLine judges
 * relative paths against the project, but claude's shell keeps its folder between calls (a `cd`
 * into an added folder stays), so the line Uncut lets run is sent back (updatedInput) starting there.
 */
export function pinnedToProject(command: string, project: string): string {
  return `cd '${project.replaceAll("'", "'\\''")}' && {\n${command.trim()}\n}`;
}

/**
 * A line of read-only commands Auto runs without a card: simple commands joined by ;, && or
 * newlines (no other shell syntax: no pipes, redirects, $, `, subshells, globs or backslashes), each
 * one allowlisted (reads in the project or a sanctioned folder, mkdir -p in the project), `echo`
 * and `pwd`, or `cd` into the project or a folder in it (relative paths after it are read from
 * there). A space may be escaped (`Application\ Support`); no other backslash. `real(p, base)` is
 * a path's real path against `base`. The line is judged from the project: run it pinnedToProject.
 */
export function readOnlyLine(command: string, real: (p: string, base: string) => string, zones: ReadZones): boolean {
  const c = escapedSpaces(command.trim());
  if (c === undefined || !c || /[$`(){}<>|\\\r\0]|<<|\*\*|\bsudo\b/.test(c)) return false;
  // Only ; && and newlines join commands; a lone & (background) or || isn't taken.
  const pieces: Array<string> = [];
  let cur = "";
  let quote: string | undefined;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      pieces.push(cur);
      cur = "";
      continue;
    }
    if (ch === "&") {
      if (c[i + 1] !== "&") return false;
      i++;
      pieces.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quote) return false;
  pieces.push(cur);
  const segments = pieces.map((x) => x.trim());
  if (segments.length > 1 && !segments.at(-1)) segments.pop();
  if (segments.length > 12 || segments.some((x) => !x)) return false;
  let cwd = zones.project;
  for (const segment of segments) {
    const parsed = simpleCommand(segment);
    if ("complex" in parsed) return false;
    const [name = "", ...args] = parsed.words.map((w) => w.replaceAll(SPACE, " "));
    if (name === "echo" || name === "pwd") {
      if ((name === "pwd" && args.length) || args.some((a) => /[*?[\]{}~]/.test(a))) return false;
      continue;
    }
    if (name === "cd") {
      if (args.length !== 1 || args[0]!.startsWith("-") || args[0]!.startsWith("~") || /[*?[\]{}=]/.test(args[0]!)) return false;
      const to = real(args[0]!, cwd);
      // Only into the project: claude's shell keeps its folder between calls, and later calls are judged from the project.
      if (!inside(to, zones.project)) return false;
      cwd = to;
      continue;
    }
    if (!allowlisted(name, args, (p) => real(p, cwd), zones)) return false;
  }
  return true;
}
