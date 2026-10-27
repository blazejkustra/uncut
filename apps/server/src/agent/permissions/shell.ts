// Shell commands for the permission rules: segments, words, destructive ones, the read-only allowlist.
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { absolute, inside, owned } from "./paths.ts";

/** Whether the & at `i` belongs to a redirect (`2>&1`, `<&3`, `&>file`), not a background or `&&`. */
const redirectAmp = (line: string, i: number) => line[i - 1] === ">" || line[i - 1] === "<" || (line[i + 1] === ">" && line[i - 1] !== "&");

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
    if (c === "&" && redirectAmp(command, i)) {
      cur += c;
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
    if (name === "xargs" && args.some((a) => ["rm", "rmdir", "shred", "sudo", "mv", "chmod", "chown"].includes(basename(a))))
      return "runs a command on files it can't see in advance";
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
    if (
      [
        "mkfs",
        "diskutil",
        "dd",
        "fdisk",
        "shutdown",
        "reboot",
        "halt",
        "launchctl",
        "csrutil",
        "spctl",
        "systemsetup",
        "defaults",
        "crontab",
        "chown",
      ].includes(name) ||
      name.startsWith("mkfs.")
    )
      return `${name} changes the system`;
    if ((name === "chmod" || name === "chflags") && args.some((a) => !a.startsWith("-") && /^[/~]/.test(a) && !ok(a))) return `${name} outside the project`;
    if (name === "mv" || name === "cp" || name === "ln" || name === "tee" || name === "install") {
      const t = args.findIndex((a) => a === "-t" || a === "--target-directory" || a.startsWith("--target-directory="));
      const target = t < 0 ? undefined : args[t]!.includes("=") ? args[t]!.split("=")[1]! : args[t + 1];
      const paths = args.filter((a, i) => !a.startsWith("-") && i !== t + 1);
      const dest = target !== undefined ? [target] : name === "tee" ? paths : paths.slice(-1);
      if (name === "mv" && paths.slice(0, -1).some((p) => !ok(p))) return "moves files from outside the project";
      if (dest.some((p) => !ok(p))) return `writes ${dest.find((p) => !ok(p))} outside the project`;
    }
    if (
      name === "find" &&
      args.includes("-delete") &&
      args
        .filter((a) => !a.startsWith("-"))
        .slice(0, 1)
        .some((p) => !ok(p))
    )
      return "deletes files outside the project";
    for (const m of segment.matchAll(/(?:^|[^<>&\d])(?:\d+|&)?>>?\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
      const target = m[1]!.replace(/^["']|["']$/g, "");
      if (target === "/dev/null" || target.startsWith("&")) continue;
      if (!ok(target)) return `writes ${target} outside the project`;
    }
  }
  return undefined;
}

/**
 * A line with what quotes keep literal blanked out (to test it for shell syntax): everything inside
 * '…', and inside "…" everything but $, `, \ and the closing quote (the shell still expands those).
 * Round 9's A2: `grep -o '"[a-z]*":"[^"]*\.\(MP4\|mp4\)"' project.json` was refused for the
 * pattern's \ ( | inside single quotes.
 */
export function quotedBlanked(c: string): string {
  let out = "";
  let quote: string | undefined;
  for (const ch of c) {
    if (quote) {
      if (ch === quote) {
        quote = undefined;
        out += ch;
      } else out += quote === '"' && /[$`\\]/.test(ch) ? ch : "x";
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    out += ch;
  }
  return out;
}

/** Characters and words that make a command more than one simple program call. */
const COMPLEX = /[$`(){}<>|;&\n\r\\]|<<|\*\*|\bsudo\b/;

/**
 * A single simple command's words, or why it isn't one: no shell syntax ($, `, (, ), {, }, <, >,
 * |, ;, &, newlines, here-docs, backslashes), every quote a whole word ("my file", not r""m).
 */
export function simpleCommand(command: string, opaqueQuotes = false): { words: Array<string> } | { complex: string } {
  const c = command.trim();
  if (!c) return { complex: "it's empty" };
  if (COMPLEX.test(opaqueQuotes ? quotedBlanked(c) : c)) return { complex: "it uses shell syntax ($, `, pipes, redirects, ; or &)" };
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

/** wc's flags when it reads files (allowlisted): counts only, never --files0-from. */
const WC_FLAGS: ReadonlySet<string> = new Set(["-l", "-w", "-c", "-m", "-lc", "-cl", "-wc", "-cw", "-lw", "-wl", "-lwc"]);

/** Where an allowlisted command may read: the project, and (reads only) the sanctioned folders (D296). */
export interface ReadZones {
  readonly project: string;
  /** The brand kits and the bundled graphic libraries: read, never written. Real paths. */
  readonly sanctioned?: ReadonlyArray<string>;
  /** Further real paths that may be read (Claude Code's saved tool output of this project, another project's plan and graphics, confirmed folders). */
  readonly readable?: (real: string) => boolean;
  /** Further real paths that may only be listed (ls) or entered (cd): another project's folder and its media/. */
  readonly listable?: (real: string) => boolean;
  /** A folder's entries (its real path), for a cp source's * or ? (copyIntoProject); without it a glob isn't taken. */
  readonly list?: (realDir: string) => ReadonlyArray<string>;
}

/**
 * Auto's commands that run without a card when claude asks Uncut (D194, after two security reviews;
 * issue A/B 2026-10-17): ls, cat, head, tail and stat of paths inside the project or a sanctioned
 * folder (the brand kits, the graphic libraries), and mkdir -p of paths inside the project only.
 * A path may be relative (to the project) or absolute; never ~, .., * ? [ ] { } or =; it is judged
 * by its real path (`real`, symlinks followed), so a link can't reach out. Only the flags in FLAGS
 * (head/tail: -n or -c and a number). Reading Uncut's own files (project.json, …) is fine; making a
 * folder there isn't. wc -l/-w/-c/-m of such files counts what cat would print (Auto's A/B: a
 * `cat f | head -c 300; echo; wc -c f` line was refused for its wc; `echo` was already a read),
 * never --files0-from or another flag. Media work goes through Uncut's tools; ffmpeg, ffprobe, file
 * and the rest always get a card (a cp only runs without one as copyIntoProject judges it).
 */
export function allowlisted(name: string, args: ReadonlyArray<string>, real: (p: string) => string, zones: string | ReadZones): boolean {
  const {
    project,
    sanctioned = [],
    readable: extra,
    listable,
  } = typeof zones === "string" ? { project: zones, readable: undefined, listable: undefined } : zones;
  const flags = FLAGS[name];
  if (!flags && name !== "grep" && name !== "wc") return false;
  const paths: Array<string> = [];
  for (let i = 0; i < args.length && flags; i++) {
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
    return inside(r, project) || sanctioned.some((d) => inside(r, d)) || extra?.(r) === true;
  };
  // grep of files (round 3's A2: `grep -o '"path": *"[^"]*"' project.json` was refused): a pattern
  // (the first word, or -e's), then one or more files; no flag that reads more files (-r, -f, …).
  // With an -e anywhere every other word is a file (grep permutes its options), so all are judged.
  if (name === "grep") {
    const words: Array<string> = [];
    let e = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "-e") {
        if (args[i + 1] === undefined) return false;
        e = true;
        i++;
      } else if (/^-[ivncwxEFohHlLsq]+$/.test(a)) continue;
      else if (/^-[mABC]$/.test(a)) {
        if (!/^\d{1,9}$/.test(args[i + 1] ?? "")) return false;
        i++;
      } else if (a.startsWith("-")) return false;
      else words.push(a);
    }
    const files = e ? words : words.slice(1);
    return files.length > 0 && files.every(readable);
  }
  // wc of files: its counting flags only (-c here is bytes, not head's count), then one or more files.
  if (name === "wc") {
    const files = args.filter((a) => !WC_FLAGS.has(a));
    return files.length > 0 && files.every((a) => !a.startsWith("-") && readable(a));
  }
  if (name === "mkdir") {
    return (
      paths.length > 0 &&
      paths.every((a) => {
        if (!plain(a)) return false;
        const r = real(a);
        return inside(r, project) && r !== project && !owned(r, project);
      })
    );
  }
  if (name === "ls") return paths.every((a) => readable(a) || (plain(a) && listable?.(real(a)) === true));
  return paths.every(readable);
}

/**
 * Round 9's A2: `cp <this project's tool-results>/mcp-uncut-blob-17922490*.jpg .work/sheets/` was
 * refused. A cp that only reads the project or this project's saved tool output (not a sanctioned
 * folder: apps' data is only read in place) and writes into the project, like the Write tool there: no flag but
 * -p (no -R, -L, …); the last word is the destination, a plain path whose real path is in the
 * project; for each source the file it lands on (the destination, or the destination/its name)
 * must be in the project and not Uncut's own (project.json, history.db, agent/, brand/active.json),
 * judged by real path so a link there can't send the write out. A source may end in one glob
 * segment with only * and ? (the folder part plain): every entry of that folder it could match,
 * dot-files too, is judged by its real path, and none is no copy (`list` reads the folder).
 */
export function copyIntoProject(args: ReadonlyArray<string>, real: (p: string) => string, zones: ReadZones): boolean {
  // Sources: the project and the saved tool output, not apps' data (a kit is read where it is; D219).
  const { project, readable: extra, list } = zones;
  const words: Array<string> = [];
  for (const a of args) {
    if (a.startsWith("-")) {
      if (a !== "-p") return false;
      continue;
    }
    words.push(a);
  }
  if (words.length < 2) return false;
  const dest = words.at(-1)!;
  const plain = (a: string) => a.length > 0 && !a.startsWith("~") && !/[*?[\]{}=\\$`]/.test(a) && !a.split("/").includes("..");
  if (!plain(dest)) return false;
  const lands = (r: string) => inside(r, project) && !owned(r, project);
  if (!lands(real(dest))) return false;
  const readable = (r: string) => inside(r, project) || extra?.(r) === true;
  for (const src of words.slice(0, -1)) {
    let files: Array<string>;
    if (plain(src)) files = [src];
    else {
      const folder = src.includes("/") ? src.slice(0, src.lastIndexOf("/")) || "/" : ".";
      const name = src.slice(src.lastIndexOf("/") + 1);
      if (!list || !plain(folder) || !/^[^[\]{}=\\$`~]+$/.test(name) || !/[*?]/.test(name)) return false;
      const dir = real(folder);
      // A ? judged like a * (review of 6dc1722): the shell's ? is one character (an emoji, or one
      // byte of it in the C locale), not one UTF-16 unit, so every name it could match is judged.
      const re = new RegExp(
        `^${name
          .replace(/[.+^$()|\\]/g, "\\$&")
          .replaceAll("*", ".*")
          .replaceAll("?", ".*")}$`,
        "s",
      );
      let entries: ReadonlyArray<string>;
      try {
        entries = list(dir);
      } catch {
        return false;
      }
      const matched = entries.filter((e) => re.test(e));
      // A match starting with - would reach cp as a flag (`cp * sub/ <project>/` with a file named -R
      // copied sub's contents over project.json; review of 6dc1722).
      if (!matched.length || matched.some((e) => e.startsWith("-"))) return false;
      files = matched.map((e) => join(dir, e));
    }
    for (const f of files) {
      if (!readable(real(f))) return false;
      if (!lands(real(join(dest, basename(f))))) return false;
    }
  }
  return true;
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
      // Literal inside '…' (round 9: a grep pattern's \\( \\|); live inside "…".
      if (ch === "\\" && quote === '"') return undefined;
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
 * A read-only line pinned to the project: `cd '<project>' && (` the line `)`. readOnlyLine judges
 * relative paths against the project, but claude's shell keeps its folder between calls (a `cd`
 * into an added folder stays), so the line Uncut lets run is sent back (updatedInput) starting there;
 * the subshell keeps a `cd` on the line (into the kit) from outlasting it, and a cd that fails ends it.
 */
export function pinnedToProject(command: string, project: string): string {
  return `cd '${project.replaceAll("'", "'\\''")}' && (\n${PIN_CD}\n${command.trim()}\n)`;
}

/**
 * Review of 223cd14: a cd on the line that fails (`cd missing; cat link/x`) must stop it, or the
 * reads run from the folder before, judged against one that isn't there; and CDPATH mustn't send a
 * relative cd elsewhere. Defined before the line, in the subshell (bash and zsh).
 */
const PIN_CD = 'unset CDPATH; cd() { builtin cd "$@" || exit 1; }';

/**
 * The filters a read may pipe into (round 2's A2: `cat x | head` of the kit and project.json were
 * denied): each reads only its standard input and writes only to the pipe. No file arguments at all
 * (a positional word is a pattern or a jq path, never a file), no flags that read or write a file
 * (grep -f/-r, sort -o/-T/--compress-program, jq -f/--rawfile/--slurpfile, uniq's output file), and
 * no unquoted glob (which the shell would turn into file names).
 */
const FILTER_FLAGS: Record<string, { readonly flags: ReadonlySet<string>; readonly valued: Readonly<Record<string, RegExp>>; readonly positional: 0 | 1 }> = {
  head: { flags: new Set(), valued: { "-n": /^\d{1,9}$/, "-c": /^\d{1,9}$/ }, positional: 0 },
  tail: { flags: new Set(), valued: { "-n": /^\+?\d{1,9}$/, "-c": /^\+?\d{1,9}$/ }, positional: 0 },
  wc: { flags: new Set(["-l", "-w", "-c", "-m"]), valued: {}, positional: 0 },
  sort: { flags: new Set(["-n", "-r", "-u", "-f", "-h", "-V", "-nr", "-rn"]), valued: { "-k": /^\d{1,3}(,\d{1,3})?$/ }, positional: 0 },
  uniq: { flags: new Set(["-c", "-d", "-u", "-i"]), valued: {}, positional: 0 },
  grep: {
    flags: new Set(["-i", "-v", "-n", "-c", "-w", "-x", "-E", "-F", "-o", "-in", "-ni", "-iv", "-vi", "-io", "-oi"]),
    valued: { "-m": /^\d{1,9}$/, "-A": /^\d{1,4}$/, "-B": /^\d{1,4}$/, "-C": /^\d{1,4}$/ },
    positional: 1,
  },
  // A jq path only (.a.b[0], .media[].id): no pipes, objects, $variables or functions in the filter.
  jq: { flags: new Set(["-r", "-c", "-S", "--raw-output", "--compact-output", "--sort-keys"]), valued: {}, positional: 1 },
};
const JQ_PATH = /^\.(?:[A-Za-z0-9_.]|\[\d{0,6}\])*$/;

/** Whether a pipeline stage (after the first) is a pure filter (FILTER_FLAGS); `raw` its text, quotes kept. */
function pureFilter(raw: string): boolean {
  // An unquoted glob or tilde would become file names.
  if (/[*?[\]{}~]/.test(raw.replace(/"[^"]*"|'[^']*'/g, ""))) return false;
  const parsed = simpleCommand(raw, true);
  if ("complex" in parsed) return false;
  const [name = "", ...args] = parsed.words.map((w) => w.replaceAll(SPACE, " "));
  const f = FILTER_FLAGS[name];
  if (!f) return false;
  const positional: Array<string> = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-") && a !== "-") {
      if (f.flags.has(a)) continue;
      // head -5, tail -20: the count as the flag.
      if ((name === "head" || name === "tail") && /^-\d{1,9}$/.test(a)) continue;
      const v = f.valued[a];
      if (!v || !v.test(args[i + 1] ?? "")) return false;
      i++;
      continue;
    }
    positional.push(a);
  }
  if (positional.length !== f.positional) return false;
  if (name === "jq") return JQ_PATH.test(positional[0]!) || positional[0] === ".";
  return true;
}

/**
 * A line of read-only commands Auto runs without a card: simple commands joined by ;, && or
 * newlines (no other shell syntax: no redirects, $, `, subshells, globs or backslashes), each
 * one allowlisted (reads in the project or a sanctioned folder, mkdir -p in the project), `echo`
 * and `pwd`, `grep` of files (allowlisted), or `cd` into the project, a sanctioned folder or a
 * folder in them (relative paths after it are read from there). A read (or echo) may pipe into pure filters (head, tail, grep, wc, sort, uniq, jq with a
 * path; see FILTER_FLAGS): never a file argument, never a redirect. A space may be escaped
 * (`Application\ Support`); no other backslash. `real(p, base)` is a path's real path against
 * `base`. The line is judged from the project: run it pinnedToProject.
 */
export function readOnlyLine(command: string, real: (p: string, base: string) => string, zones: ReadZones): boolean {
  return notReadOnly(command, real, zones) === undefined;
}

/**
 * Why a line isn't one readOnlyLine runs: the first piece that isn't a plain read (its text), or
 * "the line" for shell syntax around them; undefined when it is one. For the refusal's message.
 */
export function notReadOnly(command: string, real: (p: string, base: string) => string, zones: ReadZones): string | undefined {
  return nonReads(command, real, zones)[0];
}

/** Redirects that write no file: errors thrown away, or sent along with the output. */
const HARMLESS_REDIRECTS = ["2>/dev/null", "2>&1"];

/**
 * A line without each unquoted `2>/dev/null` or `2>&1` word (errors thrown away or joined to the
 * output: it writes nowhere). The line still runs as typed; this is only what is judged.
 */
function devNullDropped(c: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      out += ch;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (i === 0 || /\s/.test(c[i - 1]!)) {
      const word = HARMLESS_REDIRECTS.find((w) => c.startsWith(w, i) && /^(?:[\s;|&]|$)/.test(c.slice(i + w.length, i + w.length + 1)));
      if (word) {
        i += word.length - 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/** A line without its here-documents' bodies (a script written with cat > x <<'EOF' is one piece, not one per line). */
function withoutHeredocs(command: string): string {
  const out: Array<string> = [];
  let end: { word: string; tabs: boolean } | undefined;
  for (const line of command.split("\n")) {
    if (end) {
      if ((end.tabs ? line.replace(/^\t+/, "") : line) === end.word) end = undefined;
      continue;
    }
    out.push(line);
    const m = line.match(/<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
    if (m) end = { word: m[3]!, tabs: m[1] === "-" };
  }
  return out.join("\n");
}

/**
 * Every piece of a line that isn't a plain read (round 9: a refusal named only the first, an `ls`,
 * while the python after it was what kept the line from running), in order; ["the line"] for shell
 * syntax around them; empty when readOnlyLine runs it.
 */
export function nonReads(command: string, real: (p: string, base: string) => string, zones: ReadZones): Array<string> {
  const escaped = escapedSpaces(command.trim());
  const c = escaped === undefined ? undefined : devNullDropped(escaped);
  const SYNTAX = /[$`(){}<>\\\r\0]|<<|\*\*|\bsudo\b/;
  const syntax = (x: string) => SYNTAX.test(quotedBlanked(x));
  if (c === undefined || !c.trim() || syntax(c)) {
    // Each piece with shell syntax, and each other piece that isn't a read on its own.
    const pieces = shellSegments(withoutHeredocs(command)).filter((p) => {
      if (/^(?:done|fi|esac|then|else|do)$/.test(p)) return false;
      const x = escapedSpaces(p);
      const y = x === undefined ? undefined : devNullDropped(x);
      return y === undefined || syntax(y) || nonReads(p, real, zones).length > 0;
    });
    return pieces.length ? pieces : ["the line"];
  }
  // Only ; && and newlines join commands, | pipes one into the next; a lone & (background) or || isn't taken.
  const pieces: Array<Array<string>> = [];
  let pipe: Array<string> = [];
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
    if (ch === "|") {
      if (c[i + 1] === "|") return ["the line"];
      pipe.push(cur);
      cur = "";
      continue;
    }
    if (ch === ";" || ch === "\n") {
      pieces.push([...pipe, cur]);
      pipe = [];
      cur = "";
      continue;
    }
    if (ch === "&") {
      if (c[i + 1] !== "&") return ["the line"];
      i++;
      pieces.push([...pipe, cur]);
      pipe = [];
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quote) return ["the line"];
  pieces.push([...pipe, cur]);
  const segments = pieces.map((p) => p.map((x) => x.trim()));
  if (segments.length > 1 && segments.at(-1)!.length === 1 && !segments.at(-1)![0]) segments.pop();
  if (segments.length > 12 || segments.some((p) => p.length > 6 || p.some((x) => !x))) return ["the line"];
  const out: Array<string> = [];
  let cwd = zones.project;
  for (const [segment, ...filters] of segments) {
    const shown = [segment, ...filters].join(" | ").replaceAll(SPACE, "\\ ");
    const parsed = simpleCommand(segment!, true);
    if ("complex" in parsed) {
      out.push(shown);
      continue;
    }
    const [name = "", ...args] = parsed.words.map((w) => w.replaceAll(SPACE, " "));
    if (filters.length && (name === "cd" || name === "mkdir" || name === "pwd" || name === "cp")) {
      out.push(shown);
      continue;
    }
    // A stage after the pipe that isn't a pure filter is named by itself (`python3 -c "…"`, not the cat before it).
    const badFilters = filters.filter((f) => !pureFilter(f));
    if (badFilters.length) {
      out.push(...badFilters.map((f) => f.replaceAll(SPACE, "\\ ")));
      continue;
    }
    if (name === "echo" || name === "pwd") {
      if ((name === "pwd" && args.length) || args.some((a) => /[*?[\]{}~]/.test(a))) out.push(shown);
      continue;
    }
    if (name === "cd") {
      // No .. (review of 223cd14): the shell's cd is logical (a .. after a symlinked folder goes back
      // up the link's own path) while this judges the real path, so `cd S; cd ../../..` got out.
      if (args.length !== 1 || /^[-+~]/.test(args[0]!) || /[*?[\]{}=]/.test(args[0]!) || args[0]!.split("/").includes("..")) {
        out.push(shown);
        continue;
      }
      const to = real(args[0]!, cwd);
      // Into the project or a sanctioned folder (round 3's A1: `cd <kit>; head -c 600 a.svg`). The line
      // runs pinnedToProject, in a subshell, so the cd doesn't outlast it.
      if (!inside(to, zones.project) && !(zones.sanctioned ?? []).some((d) => inside(to, d)) && !zones.readable?.(to) && !zones.listable?.(to)) out.push(shown);
      else cwd = to;
      continue;
    }
    // A cp into the project of what a plain read may read (round 9).
    if (name === "cp") {
      if (!copyIntoProject(args, (p) => real(p, cwd), zones)) out.push(shown);
      continue;
    }
    // A grep pattern the shell would turn into file names (unquoted * ? [ ] { } ~).
    if (name === "grep" && /[*?[\]{}~]/.test(segment!.replace(/"[^"]*"|'[^']*'/g, ""))) out.push(shown);
    else if (!allowlisted(name, args, (p) => real(p, cwd), zones)) out.push(shown);
  }
  return out;
}
