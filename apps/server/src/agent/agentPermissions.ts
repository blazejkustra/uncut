// D194: what Claude Code's built-in tools may do in each of the composer's access modes. claude runs
// with `--permission-prompt-tool stdio` (the SDK's canUseTool): every built-in call claude would
// ask about reaches Uncut as a can_use_tool control request, and this decides it. Uncut's own MCP
// tools never come here (--allowedTools mcp__uncut; agent.ts `allowed` gates them).
// D214: Auto runs claude with `--permission-mode auto` (Claude Code's own classifier approves routine
// calls, like t3code's Auto); what still reaches Uncut there is decided by the same rules as
// Edit freely was, and the auto-only --settings rules below send every file and web call here.
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

import { type Access, ACCESS_NAME } from "./permissions/access.ts";
import { realPath, inside, shownPath, str, toolPath, owned, referencePart } from "./permissions/paths.ts";
import { SECRETISH, webAddressProblem } from "./permissions/web.ts";
import { simpleCommand, destructive, nonReads, pinnedToProject, shellSegments, shellWords } from "./permissions/shell.ts";
import { CLAUDE_DIR } from "./permissions/settings.ts";
export { ACCESS_NAME, permissionMode } from "./permissions/access.ts";
export type { Access } from "./permissions/access.ts";
export {
  absolute,
  inside,
  shownPath,
  realPath,
  owned,
  rootProblem,
  mentionedDirs,
  namedFolders,
  claudeConfigDirs,
  referencePart,
} from "./permissions/paths.ts";
export type { NamedFolder } from "./permissions/paths.ts";
export {
  shellSegments,
  shellWords,
  destructive,
  simpleCommand,
  readOnlyLine,
  notReadOnly,
  nonReads,
  allowlisted,
  copyIntoProject,
  quotedBlanked,
  pinnedToProject,
} from "./permissions/shell.ts";
export { SECRETISH, webAddressProblem } from "./permissions/web.ts";
export {
  SECRET_DIRS,
  SECRET_FILES,
  denyRules,
  appDataRules,
  appDataAskRules,
  ownFileRules,
  ownFileAskRules,
  autoAskRules,
  sessionSettings,
  LOOK_DISALLOWED,
} from "./permissions/settings.ts";

export type Decision =
  // `updatedInput`: the input claude runs instead (a read-only line pinned to the project).
  | { readonly kind: "allow"; readonly updatedInput?: Record<string, unknown> }
  | { readonly kind: "deny"; readonly message: string }
  // A card: `title` ("Run a command"), `target` (the command or path), `grant`: the key "Always for
  // this session" remembers (undefined: it can't be granted, a destructive command always asks).
  // `turnKey`: what the card's answer covers for the rest of the turn (a read of that path), so the same read never asks twice in one turn.
  | {
      readonly kind: "ask";
      readonly title: string;
      readonly target: string;
      readonly why?: string;
      readonly grant?: string;
      readonly turnKey?: string;
      readonly updatedInput?: Record<string, unknown>;
    };

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/** The whole command for the card (every line), at most 4,000 characters. */
const shownCommand = (s: string) => (s.length > 4000 ? `${s.slice(0, 3997)}...` : s);

// ---- the allowlist (D194, after the security review) ----

/**
 * Tools that touch nothing on disk or the network by themselves: allowed in every mode. Not Skill:
 * claude asks for a skill only when its front matter grants tools or runs hooks, and that gets a card.
 */
const SAFE_TOOLS = new Set(["TodoWrite", "TodoRead", "Task", "Agent", "BashOutput", "KillShell", "KillBash", "ExitPlanMode", "EnterPlanMode", "ToolSearch"]);
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
   * the bundled graphic libraries, and the user's Claude Code skills the session loads. Real paths.
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
  /** A folder's entries (a cp source's glob, judged file by file); readdirSync by default. */
  readonly readdir?: (dir: string) => ReadonlyArray<string>;
  /** CLAUDE_CONFIG_DIR (claudeConfigDirs: as set and its real path): Claude Code's folder there is judged like ~/.claude. */
  readonly claudeConfig?: ReadonlyArray<string>;
  /** Uncut's data folder (D219): a command naming it, or any app's data, is refused unless it only reads a sanctioned folder. */
  readonly dataDir?: string;
}

/** D219: a command naming apps' data (~/Library/Application Support, as typed or escaped) or Uncut's data folder. */
export const namesAppData = (command: string, dataDir?: string) =>
  /Application\\?\s+Support/i.test(command) || (!!dataDir && command.includes(dataDir.replace(/\/+$/, "")));
/** A command naming any .claude folder, in any case (APFS isn't case-sensitive). */
const ANY_CLAUDE = /(^|[\s"'=/~])\.claude(\/|[\s"';|&)]|$)/i;
/** The command without its mentions of ~/.claude (copying this project's saved tool output out of it is a read there). */
const withoutHomeClaude = (command: string, home: string) =>
  command
    .split(`${home.replace(/\/+$/, "")}/${CLAUDE_DIR}`)
    .join("")
    .replace(/(?:~|\$HOME|\$\{HOME\})\/\.claude/gi, "");
/** A command (or word) naming ~/.claude. */
const CLAUDE_NAMED = /(^|[\s"'=/~])\.claude(\/|[\s"';|&)]|$)/;

/** The refusal's "`a` and `b` aren't one" for the pieces nonReads found (at most four, each cut at 200 characters). */
function offendingText(pieces: ReadonlyArray<string>): string {
  if (pieces[0] === "the line") return "the line uses other shell syntax";
  const shown = pieces.slice(0, 4).map((p) => `\`${p.slice(0, 200)}\``);
  const more = pieces.length > 4 ? ` (and ${pieces.length - 4} more)` : "";
  if (shown.length === 1) return `${shown[0]} isn't one`;
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}${more} aren't`;
}

/**
 * The paths a command names that `named` picks (words naming Claude Code's folder): a VAR= taken
 * off the front, each cut at its first $, glob or `:` count (`$D/x.jpg:0`), empty ones left out.
 */
function claudePaths(command: string, named: (word: string) => boolean): Array<string> {
  return shellSegments(command)
    .flatMap((seg) => shellWords(seg))
    .filter(named)
    .map((w) =>
      w
        .replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "")
        .split(/[$*?[{]/)[0]!
        .replace(/\/+$/, ""),
    )
    .filter((p) => p.length > 0);
}

/** D214: a command naming Uncut's own files in a project (Auto's ask rules send it here). */
const NAMES_OWN = /project\.json|history\.db|brand\/active\.json|agent\/turns/i;
/** A command hunting for a speech model or whisper (in apps' data). */
const SPEECH_HUNT = /whisper|ggml|\.bin\b|\/models\b/i;
const SPEECH_REFUSAL =
  "Not done: Uncut's speech models in its data folder are for Uncut's own transcription, so there is no whisper to find or run by hand. transcript_read gives a clip's words with their times (Uncut transcribes it first when needed), transcript_edit cuts by words and captions_make makes captions.";
/** Where plain reads may happen, for the refusals (the rule nonReads applies). */
const PLAIN =
  "ls, cat, head, tail, stat, wc or grep (paths written out: no ~, .., globs or $) of files in this project, another Uncut project (its project.json, brief.json, storyboard.json, graphics/, brand/ and reviews/; ls of its folder and media/), a folder you were given, Uncut's brand kits or its graphic libraries, piped into head, tail, grep, wc, sort, uniq or a jq path at most, or cp of such files (not a kit's) into the project; joined by ; or && (cd allowed), no redirects but 2>/dev/null and 2>&1";

type Zone = "cache" | "project" | "root" | "sanctioned" | "outside";
/** Commands whose options read or write arbitrary files (the second security review): always a card, never remembered (a cp copyIntoProject passes is a plain read's, round 9). */
const FILE_TOOLS = new Set([
  "ffmpeg",
  "ffprobe",
  "ffplay",
  "file",
  "wc",
  "tar",
  "zip",
  "unzip",
  "cp",
  "mv",
  "ln",
  "rsync",
  "curl",
  "wget",
  "tee",
  "dd",
  "install",
  "sips",
  "convert",
  "magick",
]);
const WRAPPERS = new Set([
  "env",
  "time",
  "command",
  "exec",
  "nice",
  "nohup",
  "timeout",
  "builtin",
  "xargs",
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "source",
  ".",
  "eval",
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
  "php",
  "osascript",
  "open",
  "deno",
  "bun",
  "npx",
  "pnpm",
  "npm",
  "yarn",
  "make",
  "awk",
  "sed",
  "find",
  "git",
  "sudo",
  "su",
  "doas",
  "watch",
  "parallel",
  "script",
  "expect",
  "tclsh",
  "lua",
  "swift",
  "java",
]);

/** D194: allow, deny or ask, for one built-in tool call in this chat's access mode. */
export function decide(tool: string, rawInput: unknown, ctx: PermissionContext): Decision {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  const home = ctx.home ?? homedir();
  const real = (p: string, base = ctx.project) => realPath(p, base, home, ctx.realpath);
  const project = ctx.project;
  const zone = (r: string): Zone =>
    inside(r, join(project, ".cache"))
      ? "cache"
      : inside(r, project)
        ? "project"
        : ctx.roots.some((d) => r !== d && inside(r, d))
          ? "root"
          : (ctx.sanctioned ?? []).some((d) => inside(r, d))
            ? "sanctioned"
            : "outside";
  const mode = ACCESS_NAME[ctx.access];
  // D214 (user): the web taint (after WebSearch/WebFetch, confirmed folders and every command ask)
  // is Ask first's and Look only's; in Auto, Claude Code's auto mode handles those actions.
  const webUsed = ctx.webUsed === true && ctx.access !== "auto";
  // A path in a folder the user pasted but hasn't confirmed: the card offers to use it for this chat.
  const candidateOf = (r: string) => (ctx.candidates ?? []).find((d) => r !== d && inside(r, d) && !ctx.roots.includes(d));
  const outsideCard = (title: string, r: string, grant: string | undefined, turnKey?: string): Decision => {
    const cand = candidateOf(r);
    const remembered = turnKey ? { turnKey } : {};
    if (cand)
      return {
        kind: "ask",
        title: "Use a folder you mentioned",
        target: shownPath(cand, project, home),
        why: `${title}: ${shownPath(r, project, home)}. Always lets this chat read files in that folder (writing there still asks).`,
        grant: `Root:${cand}`,
        ...remembered,
      };
    return {
      kind: "ask",
      title,
      target: shownPath(r, project, home),
      why: webUsed ? "It's outside the project, and this turn has read the web." : "It's outside the project folder.",
      ...(grant ? { grant } : {}),
      ...remembered,
    };
  };
  // Another project read as a reference, and folders the user gave this chat (confirmed, or in Auto
  // just pasted): read like the sanctioned folders, never after the web outside Auto.
  const dataReal = ctx.dataDir ? real(ctx.dataDir, home) : undefined;
  const reference = (r: string) => (webUsed ? undefined : referencePart(r, project, home, dataReal));
  const given = (r: string) =>
    !webUsed && !(dataReal && inside(r, dataReal)) && [...ctx.roots, ...(ctx.access === "auto" ? (ctx.candidates ?? []) : [])].some((d) => inside(r, d));
  const speechModels = (r: string) => !!dataReal && inside(r, join(dataReal, "models"));
  // Claude Code's own folder (CLAUDE_DIR): only this project's saved tool output is read (claude
  // saves a large result there and tells the agent to read it); the rest is other conversations and
  // settings. Claude names a project's folder by its path with every other character a dash.
  // By its real path, as the paths it's compared with are (a ~/.claude linked from a dotfiles folder).
  // CLAUDE_CONFIG_DIR, when set, is Claude Code's folder (its projects/ too); ~/.claude is judged the same either way.
  const configDirs = [...new Set((ctx.claudeConfig ?? []).map((d) => real(d, home)))];
  const claudeDirs = [real(join(home, CLAUDE_DIR), home), ...configDirs];
  const inClaude = (r: string) => claudeDirs.some((d) => inside(r, d));
  const resultDirs = claudeDirs.map((d) => join(d, "projects", project.replace(/[^A-Za-z0-9]/g, "-")));
  const toolOutput = (r: string) =>
    resultDirs.some((results) => {
      if (!inside(r, results)) return false;
      const segs = relative(results, r).split(sep);
      return segs.length >= 2 && segs[1] === "tool-results" && !segs.includes("..");
    });
  const configNamed = (command: string) => [...(ctx.claudeConfig ?? []), ...configDirs].some((d) => command.includes(d.replace(/\/+$/, "")));
  const claudeRefusal: Decision = {
    kind: "deny",
    message: `Not done: ${configDirs.length ? `Claude Code's folder (~/${CLAUDE_DIR}, and CLAUDE_CONFIG_DIR)` : `~/${CLAUDE_DIR}`} holds Claude Code's settings and other conversations. Only this project's saved tool output (its tool-results folders) is read there.`,
  };
  if (tool.startsWith("mcp__uncut__")) return { kind: "allow" };
  if (SAFE_TOOLS.has(tool)) return { kind: "allow" };

  if (WEB_TOOLS.has(tool)) {
    if (tool === "WebSearch") {
      const q = str(input.query);
      const leak = [...(ctx.tainted ?? [])].find((t) => q.includes(t)) ?? q.match(SECRETISH)?.[0];
      if (q.length > 200 || leak)
        return {
          kind: "ask",
          title: "Search the web",
          target: q.slice(0, 2000),
          why: leak ? "The search carries a secret-looking string." : "The search is very long.",
        };
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
      if (inClaude(r)) {
        if (toolOutput(r) || (!webUsed && zone(r) === "sanctioned")) continue;
        return claudeRefusal;
      }
      const z = zone(r);
      if (z === "cache" || z === "project") continue;
      // A confirmed folder or the brand kits (and the bundled libraries): like the project, until the turn reads the web.
      if ((z === "root" || z === "sanctioned") && !webUsed) continue;
      if (given(r)) continue;
      const part = reference(r);
      if (part === "read" || (part === "list" && (tool === "Glob" || tool === "LS"))) continue;
      if (speechModels(r)) return { kind: "deny", message: SPEECH_REFUSAL };
      if (ctx.grants.has(`Read:${r}`)) continue;
      return outsideCard(tool === "Read" ? "Read a file" : "Look in a folder", r, `Read:${r}`, `Read:${r}`);
    }
    return { kind: "allow" };
  }

  if (WRITE_TOOLS.has(tool)) {
    if (ctx.access === "look")
      return {
        kind: "deny",
        message: `Not done: this chat is set to "${mode}", so files can't be written or edited. Say what you would change; the user can switch the access in the composer.`,
      };
    const p = toolPath(input);
    if (!p) return { kind: "deny", message: "Not done: no file path." };
    const r = real(p);
    if (owned(r, project))
      return {
        kind: "deny",
        message: `Not done: ${shownPath(r, project, home)} is Uncut's own file; writing it by hand would fight the open project. Change the project with timeline_edit and the other Uncut tools.`,
      };
    if (inClaude(r))
      return {
        kind: "deny",
        message: `Not done: ${shownPath(r, project, home)} is in Claude Code's own folder (settings and other conversations), which is never written.`,
      };
    // A .claude folder anywhere (the project's own too) holds skills, hooks and settings Claude Code runs: always a card, never remembered.
    if (r.toLowerCase().split(sep).includes(".claude"))
      return {
        kind: "ask",
        title: tool === "Write" ? "Write a file" : "Edit a file",
        target: shownPath(r, project, home),
        why: "It's in a .claude folder, where Claude Code reads skills, hooks and settings from.",
      };
    const z = zone(r);
    if (z === "cache") return { kind: "allow" };
    // The brand kits and the bundled libraries are only read (D296): never written, not even on a card.
    if (z === "sanctioned")
      return {
        kind: "deny",
        message: `Not done: ${shownPath(r, project, home)} is in the brand kit's folder, Uncut's graphic libraries or one of the user's Claude Code skills, which are only read. Change a kit with brand_write; write your own files in the project.`,
      };
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
      if (segs.some((seg) => seg.startsWith(".") || /\.uncut$/i.test(seg)))
        return {
          kind: "deny",
          message: `Not done: ${shownPath(r, project, home)} is inside a hidden folder or another Uncut project; files there aren't written.`,
        };
      return { kind: "ask", title, target: shownPath(r, project, home), why: "It's in a folder you mentioned, outside the project." };
    }
    return outsideCard(title, r, undefined);
  }

  if (SHELL_TOOLS.has(tool)) {
    const command = str(input.command);
    if (ctx.access === "look")
      return {
        kind: "deny",
        message: `Not done: this chat is set to "${mode}", so commands don't run. Read with Read, Glob, Grep and the web tools instead, or say what you would run; the user can switch the access in the composer.`,
      };
    const target = shownCommand(command);
    // Issue A/B 2026-10-17: reads in the project, the sanctioned folders (the brand kits, the graphic
    // libraries), another project (its plan, graphics, brand, reviews; its folder and media listed)
    // and folders the user gave (none of those after the web outside Auto), and mkdir -p in the
    // project, also a few joined by ; or && after a cd, run in Auto without a card; Ask first asks.
    const zones = {
      project,
      sanctioned: webUsed ? [] : (ctx.sanctioned ?? []),
      // Claude Code's folder only for this project's saved output, as Read judges it (a pasted folder may hold a linked ~/.claude).
      readable: (r: string) => toolOutput(r) || (!inClaude(r) && (given(r) || reference(r) === "read")),
      listable: (r: string) => !inClaude(r) && reference(r) === "list",
      list: ctx.readdir ?? ((dir: string) => readdirSync(dir)),
    };
    const notRead = tool === "Bash" ? nonReads(command, (p, base) => real(p, base), zones) : ["the line"];
    const reads = notRead.length === 0;
    // Round 3: the refusals below name the pieces that kept the line from being a plain read (round 9: every one, not just the first).
    const offending = offendingText(notRead);
    const grant = `Bash:${command.trim()}`;
    // It was judged from the project; claude's shell may sit in another folder (a cd into an added
    // folder stays between calls), so it runs from the project (review of 0039421).
    if (reads) {
      const updatedInput = { ...input, command: pinnedToProject(command, project) };
      // mkdir or cp into a .claude folder (skills, hooks, settings) is a write there: a card every time.
      if (ANY_CLAUDE.test(withoutHomeClaude(command, home)) && /\b(?:mkdir|cp)\b/.test(command))
        return {
          kind: "ask",
          title: "Run a command",
          target,
          why: "It writes into a .claude folder, where Claude Code reads skills, hooks and settings from.",
          updatedInput,
        };
      return ctx.access === "auto" || ctx.grants.has(grant)
        ? { kind: "allow", updatedInput }
        : { kind: "ask", title: "Run a command", target, grant, updatedInput };
    }
    // Anything else naming Claude Code's folder: refused (its deny rules did that before they became ask rules).
    // Round 9's A2: a python run on this project's saved contact sheets got the refusal that says
    // they are read; when every path there is this project's saved output, say how they can be used.
    if (CLAUDE_NAMED.test(command) || configNamed(command)) {
      const named = claudePaths(command, (w) => CLAUDE_NAMED.test(w) || configNamed(w));
      if (named.length && named.every((p) => toolOutput(real(p))))
        return {
          kind: "deny",
          message: `Not done: this project's saved tool output (its tool-results folder) is used only by plain reads (${PLAIN}); ${offending}. Copy the files into the project first (cp <files> .cache/work/…) and run other programs on the copies.`,
        };
      return { kind: "deny", message: `${claudeRefusal.message} Commands there run only as plain reads (${PLAIN}); ${offending}.` };
    }
    // D219: anything else naming apps' data (Uncut's settings, plugins, the server token; browsers'
    // cookies) is refused, as claude's deny rules did before they became ask rules.
    if (namesAppData(command, ctx.dataDir)) {
      if (SPEECH_HUNT.test(command)) return { kind: "deny", message: SPEECH_REFUSAL };
      return {
        kind: "deny",
        message: `Not done: commands don't touch apps' data (~/Library/Application Support) except plain reads of Uncut's brand kits and graphic libraries (${PLAIN}); ${offending}. Run the reads on their own, or use Read for those files, and Uncut's tools for the rest.`,
      };
    }
    // D214: in Auto, a command naming Uncut's own files that isn't a plain read is refused (it would fight the open project).
    if (ctx.access === "auto" && NAMES_OWN.test(command))
      return {
        kind: "deny",
        message: `Not done: a command naming Uncut's own files (project.json, history.db, agent/, brand/active.json) runs only as a plain read (${PLAIN}); ${offending}. Run the read on its own or use Read; to run another program on a project.json, copy it first (cp <path>/project.json .cache/work/) and use the copy; change the project with timeline_edit and the other Uncut tools.`,
      };
    const parsed = simpleCommand(command);
    const hint = destructive(command, project, [], home);
    if ("complex" in parsed) return { kind: "ask", title: "Run a command", target, why: hint ? `It ${hint}.` : `It can't be checked: ${parsed.complex}.` };
    const [name = ""] = parsed.words;
    if (FILE_TOOLS.has(name))
      return {
        kind: "ask",
        title: "Run a command",
        target,
        why: hint ? `It ${hint}.` : `${name} can read and write files anywhere through its options; media work goes through Uncut's tools.`,
      };
    if (name.includes("/") || WRAPPERS.has(name))
      return {
        kind: "ask",
        title: "Run a command",
        target,
        why: hint ? `It ${hint}.` : `It runs ${name.includes("/") ? "a program by its path" : name}, which can do anything.`,
      };
    if (hint) return { kind: "ask", title: "Run a command", target, why: `It ${hint}.` };
    if (ctx.grants.has(grant)) return { kind: "allow" };
    return { kind: "ask", title: "Run a command", target, grant };
  }

  // Anything else (a tool this list doesn't know yet).
  if (ctx.access === "look") return { kind: "deny", message: `Not done: this chat is set to "${mode}" (${tool} refused). Say what you would do instead.` };
  if (ctx.grants.has(`Tool:${tool}`)) return { kind: "allow" };
  return { kind: "ask", title: `Use ${tool}`, target: JSON.stringify(input).slice(0, 2000), grant: `Tool:${tool}` };
}
