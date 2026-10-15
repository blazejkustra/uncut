// D194: what Claude Code's built-in tools may do in each of the composer's access modes. claude runs
// with `--permission-prompt-tool stdio` (the SDK's canUseTool): every built-in call claude would
// ask about reaches Uncut as a can_use_tool control request, and this decides it. Uncut's own MCP
// tools never come here (--allowedTools mcp__uncut; agent.ts `allowed` gates them).
// D214: Auto runs claude with `--permission-mode auto` (Claude Code's own classifier approves routine
// calls, like t3code's Auto); what still reaches Uncut there is decided by the same rules as
// Edit freely was, and the auto-only --settings rules below send every file and web call here.
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { expandHome } from "../paths.ts";

export type Access = "look" | "ask" | "auto";

export type Decision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly message: string }
  // A card: `title` ("Run a command"), `target` (the command or path), `grant`: the key "Always for
  // this session" remembers (undefined: it can't be granted, a destructive command always asks).
  | { readonly kind: "ask"; readonly title: string; readonly target: string; readonly why?: string; readonly grant?: string };

/** D214: the composer's names for the access modes (on cards' refusals and in the agent's context). */
export const ACCESS_NAME: Record<Access, string> = { look: "Look only", ask: "Ask first", auto: "Auto" };

/** D214: claude's --permission-mode per access: Auto is Claude Code's own auto mode; the others ask Uncut. */
export const permissionMode = (access: Access): "auto" | "default" => (access === "auto" ? "auto" : "default");

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

const str = (x: unknown) => (typeof x === "string" ? x : "");

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
const toolPath = (input: Record<string, unknown>) => str(input.file_path) || str(input.notebook_path) || str(input.path);

// ---- shell ----

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

/** The whole command for the card (every line), at most 4,000 characters. */
const shownCommand = (s: string) => (s.length > 4000 ? `${s.slice(0, 3997)}...` : s);

// ---- the allowlist (D194, after the security review) ----

/** Tools that touch nothing on disk or the network by themselves: allowed in every mode. */
const SAFE_TOOLS = new Set(["TodoWrite", "TodoRead", "Task", "Agent", "Skill", "BashOutput", "KillShell", "KillBash", "ExitPlanMode", "EnterPlanMode", "ToolSearch"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const WEB_TOOLS = new Set(["WebSearch", "WebFetch"]);

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

/** Uncut's own files in a project (compared without case: APFS isn't case-sensitive). */
const OWNED_RE = [/^project\.json$/, /^history\.db/, /^agent(\/|$)/, /^brand\/active\.json$/];
export function owned(real: string, project: string): boolean {
  if (!inside(real.toLowerCase(), project.toLowerCase())) return false;
  const rel = relative(project.toLowerCase(), real.toLowerCase()).split(sep).join("/");
  return OWNED_RE.some((re) => re.test(rel));
}

export interface PermissionContext {
  readonly access: Access;
  /** The project folder (claude's cwd), as its real path. */
  readonly project: string;
  /** Folders the user confirmed on a card (a mentioned folder): Read, Write and Edit there are like the project's. */
  readonly roots: ReadonlyArray<string>;
  /** Folders the user pasted in this chat and hasn't confirmed yet (a card offers them). */
  readonly candidates?: ReadonlyArray<string>;
  /** "Always for this session" answers so far (grant keys). */
  readonly grants: ReadonlySet<string>;
  readonly home?: string;
  /** The turn used WebSearch or WebFetch: anything outside the project asks from then on. */
  readonly webUsed?: boolean;
  /** Secret-looking strings read from files in this turn: a WebFetch URL carrying one asks. */
  readonly tainted?: ReadonlySet<string>;
  readonly realpath?: (p: string) => string;
}

type Zone = "cache" | "project" | "root" | "outside";

/** A secret-looking string: 20+ letters, digits and token characters, with both letters and digits. */
export const SECRETISH = /(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{20,}/;

/** D219: well-known credential shapes (API keys, tokens, JWTs, private keys). */
const KNOWN_SECRET = /(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}|-----BEGIN|ssh-(?:rsa|ed25519) AAAA)/;

/**
 * D219: a run that reads as encoded data: 40+ token characters (between slashes, dots and the
 * like) mixing upper case, lower case and digits, with few dashes. Hex (a commit SHA), UUIDs and
 * slugs ("React-Native-0-74-Release-Notes") aren't.
 */
const encodedRun = (text: string) =>
  (text.match(/[A-Za-z0-9+=_-]{40,}/g) ?? []).some((run) => /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run) && !/^[0-9a-f-]+$/i.test(run) && (run.match(/-/g)?.length ?? 0) <= run.length / 8);

/**
 * D219: why a WebFetch address may carry data out (a card), or undefined for an ordinary page. Only
 * what's sent counts (host, path and query; not the #fragment), decoded: longer than 200
 * characters, a credential-shaped string, a run of encoded data (a commit SHA, a UUID or a
 * slug isn't one), or a host name with a long encoded label (DNS exfiltration). Docs, repos,
 * videos and package pages pass.
 */
export function webAddressProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
      return s;
    }
  };
  const sent = `${url.host}${url.pathname}${url.search}`;
  const text = decode(`${url.pathname}${url.search}`);
  if (sent.length > 200) return "The address is unusually long; it could carry data out.";
  if (KNOWN_SECRET.test(text) || KNOWN_SECRET.test(sent)) return "The address carries a secret-looking string.";
  // A Google Docs/Drive/Sheets file id (/d/<44 characters>/) is an id, not data (the query still counts).
  const ids = /(^|\.)google\.com$/i.test(url.hostname) ? decode(url.pathname).replace(/\/d\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, "/d/id") + decode(url.search) : text;
  if (encodedRun(ids)) return "The address carries a long run of encoded data.";
  const labels = url.hostname.split(".").slice(0, -2);
  // A long label of letters and digits (hex, base32), not a dashed name like my-bucket-2024-prod.
  if (labels.some((l) => l.length >= 40 || (l.length >= 24 && !l.includes("-") && /\d/.test(l) && /[a-z]/i.test(l)))) return "The address's host name carries a long encoded part.";
  return undefined;
}

/** Characters and words that make a command more than one simple program call. */
const COMPLEX = /[$`(){}<>|;&\n\r\\]|<<|\*\*|\bsudo\b/;
/** Commands whose options read or write arbitrary files (the second security review): always a card, never remembered. */
const FILE_TOOLS = new Set(["ffmpeg", "ffprobe", "ffplay", "file", "wc", "tar", "zip", "unzip", "cp", "mv", "ln", "rsync", "curl", "wget", "tee", "dd", "install", "sips", "convert", "magick"]);
const WRAPPERS = new Set(["env", "time", "command", "exec", "nice", "nohup", "timeout", "builtin", "xargs", "sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh", "source", ".", "eval", "python", "python3", "node", "perl", "ruby", "php", "osascript", "open", "deno", "bun", "npx", "pnpm", "npm", "yarn", "make", "awk", "sed", "find", "git", "sudo", "su", "doas", "watch", "parallel", "script", "expect", "tclsh", "lua", "swift", "java"]);

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

/** D194: allow, deny or ask, for one built-in tool call in this chat's access mode. */
export function decide(tool: string, rawInput: unknown, ctx: PermissionContext): Decision {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  const home = ctx.home ?? homedir();
  const real = (p: string, base = ctx.project) => realPath(p, base, home, ctx.realpath);
  const project = ctx.project;
  const zone = (r: string): Zone =>
    inside(r, join(project, ".cache")) ? "cache" : inside(r, project) ? "project" : ctx.roots.some((d) => r !== d && inside(r, d)) ? "root" : "outside";
  const mode = ACCESS_NAME[ctx.access];
  // D214 (user): the web taint (after WebSearch/WebFetch, confirmed folders and every command ask)
  // is Ask first's and Look only's; in Auto, Claude Code's auto mode handles those actions.
  const webUsed = ctx.webUsed === true && ctx.access !== "auto";
  // A path in a folder the user pasted but hasn't confirmed: the card offers to use it for this chat.
  const candidateOf = (r: string) => (ctx.candidates ?? []).find((d) => r !== d && inside(r, d) && !ctx.roots.includes(d));
  const outsideCard = (title: string, r: string, grant: string | undefined): Decision => {
    const cand = candidateOf(r);
    if (cand) return { kind: "ask", title: "Use a folder you mentioned", target: shownPath(cand, project, home), why: `${title}: ${shownPath(r, project, home)}. Always lets this chat read files in that folder (writing there still asks).`, grant: `Root:${cand}` };
    return { kind: "ask", title, target: shownPath(r, project, home), why: webUsed ? "It's outside the project, and this turn has read the web." : "It's outside the project folder.", ...(grant ? { grant } : {}) };
  };
  if (tool.startsWith("mcp__uncut__")) return { kind: "allow" };
  if (SAFE_TOOLS.has(tool)) return { kind: "allow" };

  if (WEB_TOOLS.has(tool)) {
    if (tool === "WebSearch") {
      const q = str(input.query);
      const leak = [...(ctx.tainted ?? [])].find((t) => q.includes(t)) ?? q.match(SECRETISH)?.[0];
      if (q.length > 200 || leak) return { kind: "ask", title: "Search the web", target: q.slice(0, 2000), why: leak ? "The search carries a secret-looking string." : "The search is very long." };
    }
    if (tool === "WebFetch") {
      const url = str(input.url);
      const leak = [...(ctx.tainted ?? [])].find((t) => url.includes(t));
      const why = leak ? "The address carries text read from a file in this turn." : webAddressProblem(url);
      if (why) return { kind: "ask", title: "Open a web address", target: url.slice(0, 2000), why };
    }
    return { kind: "allow" };
  }

  if (READ_TOOLS.has(tool)) {
    const paths: Array<string> = [];
    const p = toolPath(input);
    paths.push(p || ".");
    // A Glob pattern (and Grep's glob) may itself point anywhere: its folder part before the first wildcard.
    for (const g of [str(input.pattern), tool === "Grep" ? str(input.glob) : ""]) {
      if (!g || (tool === "Grep" && g === str(input.pattern))) continue;
      const head = g.split("/").findIndex((seg) => /[*?[{]/.test(seg));
      const fixed = head < 0 ? g : g.split("/").slice(0, head).join("/");
      if (fixed || g.startsWith("/")) paths.push(fixed || "/");
    }
    const base = p ? real(p) : project;
    for (const raw of paths) {
      const r = raw === p || raw === "." ? real(raw) : real(raw, base);
      const z = zone(r);
      if (z === "cache" || z === "project") continue;
      if (z === "root" && !webUsed) continue;
      if (ctx.grants.has(`Read:${r}`)) continue;
      return outsideCard(tool === "Read" ? "Read a file" : "Look in a folder", r, `Read:${r}`);
    }
    return { kind: "allow" };
  }

  if (WRITE_TOOLS.has(tool)) {
    if (ctx.access === "look") return { kind: "deny", message: `Not done: this chat is set to "${mode}", so files can't be written or edited. Say what you would change; the user can switch the access in the composer.` };
    const p = toolPath(input);
    if (!p) return { kind: "deny", message: "Not done: no file path." };
    const r = real(p);
    if (owned(r, project)) return { kind: "deny", message: `Not done: ${shownPath(r, project, home)} is Uncut's own file; writing it by hand would fight the open project. Change the project with timeline_edit and the other Uncut tools.` };
    const z = zone(r);
    if (z === "cache") return { kind: "allow" };
    const title = tool === "Write" ? "Write a file" : "Edit a file";
    // "Always" covers this exact file, and only inside the project.
    if (z === "project") {
      if (ctx.access === "auto") return { kind: "allow" };
      if (ctx.grants.has(`Write:${r}`)) return { kind: "allow" };
      return { kind: "ask", title, target: shownPath(r, project, home), grant: `Write:${r}` };
    }
    // A confirmed folder is for reading: a write there always asks, and never into another Uncut
    // project or a hidden folder (.git, …) inside it.
    const root = ctx.roots.find((d) => inside(r, d));
    if (root) {
      const segs = relative(root, r).split(sep);
      if (segs.some((seg) => seg.startsWith(".") || /\.uncut$/i.test(seg))) return { kind: "deny", message: `Not done: ${shownPath(r, project, home)} is inside a hidden folder or another Uncut project; files there aren't written.` };
      return { kind: "ask", title, target: shownPath(r, project, home), why: "It's in a folder you mentioned, outside the project." };
    }
    return outsideCard(title, r, undefined);
  }

  if (SHELL_TOOLS.has(tool)) {
    const command = str(input.command);
    if (ctx.access === "look") return { kind: "deny", message: `Not done: this chat is set to "${mode}", so commands don't run. Read with Read, Glob, Grep and the web tools instead, or say what you would run; the user can switch the access in the composer.` };
    const target = shownCommand(command);
    const parsed = simpleCommand(command);
    const hint = destructive(command, project, [], home);
    if ("complex" in parsed) return { kind: "ask", title: "Run a command", target, why: hint ? `It ${hint}.` : `It can't be checked: ${parsed.complex}.` };
    const [name = "", ...args] = parsed.words;
    if (FILE_TOOLS.has(name)) return { kind: "ask", title: "Run a command", target, why: hint ? `It ${hint}.` : `${name} can read and write files anywhere through its options; media work goes through Uncut's tools.` };
    if (name.includes("/") || WRAPPERS.has(name)) return { kind: "ask", title: "Run a command", target, why: hint ? `It ${hint}.` : `It runs ${name.includes("/") ? "a program by its path" : name}, which can do anything.` };
    if (hint) return { kind: "ask", title: "Run a command", target, why: `It ${hint}.` };
    const grant = `Bash:${command.trim()}`;
    const fine = ctx.access === "auto" && allowlisted(name, args, (a) => real(a), project);
    if (fine || ctx.grants.has(grant)) return { kind: "allow" };
    return { kind: "ask", title: "Run a command", target, grant };
  }

  // Anything else (a tool this list doesn't know yet).
  if (ctx.access === "look") return { kind: "deny", message: `Not done: this chat is set to "${mode}" (${tool} refused). Say what you would do instead.` };
  if (ctx.grants.has(`Tool:${tool}`)) return { kind: "allow" };
  return { kind: "ask", title: `Use ${tool}`, target: JSON.stringify(input).slice(0, 2000), grant: `Tool:${tool}` };
}

/** The flags each auto-allowed command may carry (anything else, or a flag glued to a value, is a card). */
const FLAGS: Record<string, ReadonlySet<string>> = {
  ls: new Set(["-l", "-a", "-la", "-al", "-lh", "-hl", "-lah", "-alh", "-1", "-h"]),
  cat: new Set(),
  head: new Set(["-n"]),
  tail: new Set(["-n"]),
  stat: new Set(),
  mkdir: new Set(["-p"]),
};

/**
 * Auto's commands that run without a card when claude asks Uncut (D194, after two security reviews): ls, cat, head,
 * tail and stat of, and mkdir -p of, plain relative paths inside the project (no leading / or ~, no
 * .., no * ? [ ] { } or =), with only the flags in FLAGS (head/tail: -n and a number), never on
 * Uncut's own files. Media work goes through Uncut's tools; ffmpeg, ffprobe, file, wc and the rest
 * always get a card.
 */
function allowlisted(name: string, args: ReadonlyArray<string>, real: (p: string) => string, project: string): boolean {
  const flags = FLAGS[name];
  if (!flags) return false;
  const paths: Array<string> = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      if (!flags.has(a)) return false;
      if (a === "-n") {
        if (!/^\d{1,6}$/.test(args[i + 1] ?? "")) return false;
        i++;
      }
      continue;
    }
    paths.push(a);
  }
  const plain = (a: string) => !/^[/~]/.test(a) && !/[*?[\]{}=\\]/.test(a) && !a.split("/").includes("..");
  const ok = (a: string) => {
    if (!plain(a)) return false;
    const r = real(a);
    return inside(r, project) && !owned(r, project);
  };
  if (name === "mkdir") return paths.length > 0 && paths.every((a) => ok(a) && real(a) !== project);
  return paths.every(ok);
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
export function mentionedDirs(text: string, project: string, exists: (p: string) => "dir" | "file" | undefined, home = homedir(), real: (p: string) => string = realpathSync.native): Array<string> {
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
export function namedFolders(text: string, project: string, exists: (p: string) => "dir" | "file" | undefined, home = homedir(), real: (p: string) => string = realpathSync.native): Array<NamedFolder> {
  const out = new Map<string, NamedFolder>();
  let usable = 0;
  for (const m of text.matchAll(/(?:^|[\s"'`(<\[])((?:~|\$HOME|\$\{HOME\}|\/)(?:\\ |[^\s"'`)<>\]])*)/g)) {
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

/**
 * D194: claude's own deny rules (a --settings flag setting, applied even with --setting-sources ""
 * and before its read-only auto-allow): secrets in the home folder can't be read, edited or named
 * in a command, whatever the access. Rule syntax as claude 2.1.299 documents it ("Read(~/.zshrc)", gitignore-style paths, "//" for absolute ones, "*" as a wildcard in Bash rules).
 */
export const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".config/gh", ".config/gcloud", ".kube", ".docker", "Library/Keychains", ".claude", ".password-store"] as const;
export const SECRET_FILES = [".netrc", ".npmrc", ".git-credentials", ".claude.json", ".pypirc"] as const;
export function denyRules(dataDir?: string): Array<string> {
  const rules: Array<string> = [];
  for (const d of SECRET_DIRS) {
    for (const tool of ["Read", "Edit"]) rules.push(`${tool}(~/${d}/**)`);
    rules.push(`Bash(*/${d}/*)`, `Bash(*/${d})`, `Bash(*~/${d}*)`);
  }
  for (const f of SECRET_FILES) {
    for (const tool of ["Read", "Edit"]) rules.push(`${tool}(~/${f})`);
    rules.push(`Bash(*${f}*)`);
  }
  // .env files anywhere (Read and Edit), and a command naming one (after a space or a slash, so `process.env` isn't caught).
  for (const tool of ["Read", "Edit"]) rules.push(`${tool}(//**/.env)`, `${tool}(//**/.env.*)`);
  rules.push("Bash(* .env*)", "Bash(*/.env*)");
  // A backstop under Uncut's own allowlist: claude refuses these before anyone is asked.
  for (const prefix of ["rm", "rmdir", "shred", "sudo", "su", "doas", "git push", "scp", "sftp", "ssh", "nc", "ncat", "telnet", "dd", "mkfs", "diskutil", "launchctl", "osascript", "chown", "crontab", "defaults write", "security"]) rules.push(`Bash(${prefix}:*)`);
  for (const flag of [" -d ", " --data", " -F ", " --form", " -T ", " --upload-file", " --json"]) rules.push(`Bash(curl*${flag}*)`);
  rules.push(...appDataRules(dataDir));
  return rules;
}

/** A path as a piece of a Bash rule (claude's matcher: `\*` is a literal star, `\\` a literal backslash). */
const bashSafe = (p: string) => p.replace(/[\\*]/g, (c) => `\\${c}`);

/**
 * D219: apps' data, Uncut's first. Uncut's data folder holds what a session must never change
 * (settings.json with the plugin approvals, plugins/, brand kits) and the app's server token: no
 * file tool writes anywhere in it, the token isn't read, and no command names it. The same for
 * every app's data in ~/Library/Application Support (browsers' cookies, other apps' tokens): no
 * writes, no command naming it (the Read tool there gets Uncut's card, like anything outside the
 * project). Brand kit files stay readable with a card: the agent is shown their paths.
 */
export function appDataRules(dataDir?: string): Array<string> {
  const rules = ["Edit(~/Library/Application Support/**)", "Bash(*Application Support*)", "Bash(*Application\\ Support*)"];
  if (!dataDir) return rules;
  const dir = dataDir.replace(/\/+$/, "");
  rules.push(`Edit(/${globSafe(dir)}/**)`, `Read(/${globSafe(dir)}/server-token)`);
  // A data folder elsewhere (UNCUT_DATA_DIR) isn't caught by the Application Support rules.
  // (The folder itself, not a sibling that starts with its name.)
  if (!/\/Library\/Application Support(\/|$)/.test(dir)) rules.push(...["/", " ", '"', "'"].map((end) => `Bash(*${bashSafe(dir)}${end}*)`), `Bash(*${bashSafe(dir)})`);
  return rules;
}

/** A path as a gitignore-style pattern piece (claude's file rules): its wildcard characters escaped. */
const globSafe = (p: string) => p.replace(/[\\*?[\]{}!]/g, (c) => `\\${c}`);

/**
 * D214: Auto only. claude's classifier would allow "local file operations within project scope"
 * itself, so Uncut's own files get claude-side deny rules too: Edit (claude's Edit rules cover every
 * file-writing tool) of project.json, history.db*, agent/ and brand/active.json at the project's
 * absolute paths (`//` + the path; the real path and the opened one when they differ), and a command
 * naming one of them.
 */
export function ownFileRules(projects: ReadonlyArray<string>): Array<string> {
  const rules: Array<string> = [];
  for (const dir of [...new Set(projects)]) {
    const base = globSafe(dir.replace(/\/+$/, ""));
    for (const rel of ["project.json", "history.db*", "agent/**", "brand/active.json"]) rules.push(`Edit(/${base}/${rel})`);
  }
  rules.push("Bash(*project.json*)", "Bash(*history.db*)", "Bash(*brand/active.json*)", "Bash(*agent/turns*)");
  return rules;
}

/**
 * D214: Auto only, claude-side ask rules. An ask rule is checked before the classifier, so these calls
 * never go to it and come to Uncut over stdio as can_use_tool instead, decided by `decide` as before:
 * every file write (outside the project and in confirmed folders: a card; in the project: no card;
 * Uncut's own files: refused), every read, glob and grep (outside the project: a card; confirmed
 * folders: no card), and the web tools (a secret-looking string: a card). Commands stay with the
 * classifier, also after the web (D214: no web taint in Auto, the user's call).
 */
export function autoAskRules(): Array<string> {
  return ["Edit", "Write", "NotebookEdit", "Read", "Glob", "Grep", "WebFetch", "WebSearch"];
}

/**
 * D194, D214: the --settings JSON a session gets: claude's deny rules in every access; in Auto also
 * Uncut's own files (deny) and the calls that must still reach Uncut (ask).
 */
export function sessionSettings(o: { readonly access?: Access | undefined; readonly projects?: ReadonlyArray<string> | undefined; readonly dataDir?: string | undefined } = {}): string {
  if (o.access !== "auto") return JSON.stringify({ permissions: { deny: denyRules(o.dataDir) } });
  return JSON.stringify({ permissions: { deny: [...denyRules(o.dataDir), ...ownFileRules(o.projects ?? [])], ask: autoAskRules() } });
}

/** D194: tools a Look only session starts without (--disallowedTools): claude can't even auto-allow a read-only command. */
export const LOOK_DISALLOWED = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"] as const;
