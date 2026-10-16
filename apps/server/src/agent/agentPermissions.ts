// D194: what Claude Code's built-in tools may do in each of the composer's access modes. claude runs
// with `--permission-prompt-tool stdio` (the SDK's canUseTool): every built-in call claude would
// ask about reaches Uncut as a can_use_tool control request, and this decides it. Uncut's own MCP
// tools never come here (--allowedTools mcp__uncut; agent.ts `allowed` gates them).
// D214: Auto runs claude with `--permission-mode auto` (Claude Code's own classifier approves routine
// calls, like t3code's Auto); what still reaches Uncut there is decided by the same rules as
// Edit freely was, and the auto-only --settings rules below send every file and web call here.
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

import { type Access, ACCESS_NAME } from "./permissions/access.ts";
import { realPath, inside, shownPath, str, toolPath, owned } from "./permissions/paths.ts";
import { SECRETISH, webAddressProblem } from "./permissions/web.ts";
import { simpleCommand, destructive, allowlisted } from "./permissions/shell.ts";
export { ACCESS_NAME, permissionMode } from "./permissions/access.ts";
export type { Access } from "./permissions/access.ts";
export { absolute, inside, shownPath, realPath, owned, rootProblem, mentionedDirs, namedFolders } from "./permissions/paths.ts";
export type { NamedFolder } from "./permissions/paths.ts";
export { shellSegments, shellWords, destructive, simpleCommand } from "./permissions/shell.ts";
export { SECRETISH, webAddressProblem } from "./permissions/web.ts";
export { SECRET_DIRS, SECRET_FILES, denyRules, appDataRules, ownFileRules, autoAskRules, sessionSettings, LOOK_DISALLOWED } from "./permissions/settings.ts";

export type Decision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly message: string }
  // A card: `title` ("Run a command"), `target` (the command or path), `grant`: the key "Always for
  // this session" remembers (undefined: it can't be granted, a destructive command always asks).
  | { readonly kind: "ask"; readonly title: string; readonly target: string; readonly why?: string; readonly grant?: string };

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/** The whole command for the card (every line), at most 4,000 characters. */
const shownCommand = (s: string) => (s.length > 4000 ? `${s.slice(0, 3997)}...` : s);

// ---- the allowlist (D194, after the security review) ----

/** Tools that touch nothing on disk or the network by themselves: allowed in every mode. */
const SAFE_TOOLS = new Set(["TodoWrite", "TodoRead", "Task", "Agent", "Skill", "BashOutput", "KillShell", "KillBash", "ExitPlanMode", "EnterPlanMode", "ToolSearch"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const WEB_TOOLS = new Set(["WebSearch", "WebFetch"]);

export interface PermissionContext {
  readonly access: Access;
  /** The project folder (claude's cwd), as its real path. */
  readonly project: string;
  /** Folders the user confirmed on a card (a mentioned folder): Read, Write and Edit there are like the project's. */
  readonly roots: ReadonlyArray<string>;
  /**
   * D296: folders Uncut itself points the agent at, read without a card (never written): the
   * project's active brand kit (the sanctioned source of the product's look and screenshots) and
   * the bundled graphic libraries. Real paths.
   */
  readonly sanctioned?: ReadonlyArray<string>;
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

type Zone = "cache" | "project" | "root" | "sanctioned" | "outside";
/** Commands whose options read or write arbitrary files (the second security review): always a card, never remembered. */
const FILE_TOOLS = new Set(["ffmpeg", "ffprobe", "ffplay", "file", "wc", "tar", "zip", "unzip", "cp", "mv", "ln", "rsync", "curl", "wget", "tee", "dd", "install", "sips", "convert", "magick"]);
const WRAPPERS = new Set(["env", "time", "command", "exec", "nice", "nohup", "timeout", "builtin", "xargs", "sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh", "source", ".", "eval", "python", "python3", "node", "perl", "ruby", "php", "osascript", "open", "deno", "bun", "npx", "pnpm", "npm", "yarn", "make", "awk", "sed", "find", "git", "sudo", "su", "doas", "watch", "parallel", "script", "expect", "tclsh", "lua", "swift", "java"]);

/** D194: allow, deny or ask, for one built-in tool call in this chat's access mode. */
export function decide(tool: string, rawInput: unknown, ctx: PermissionContext): Decision {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  const home = ctx.home ?? homedir();
  const real = (p: string, base = ctx.project) => realPath(p, base, home, ctx.realpath);
  const project = ctx.project;
  const zone = (r: string): Zone =>
    inside(r, join(project, ".cache")) ? "cache" : inside(r, project) ? "project" : ctx.roots.some((d) => r !== d && inside(r, d)) ? "root" : (ctx.sanctioned ?? []).some((d) => inside(r, d)) ? "sanctioned" : "outside";
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
      // A confirmed folder or the active kit (and the bundled libraries): like the project, until the turn reads the web.
      if ((z === "root" || z === "sanctioned") && !webUsed) continue;
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
