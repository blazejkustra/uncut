// claude's --settings for a session: deny rules for secrets and app data, Auto's ask rules.
import type { Access } from "./access.ts";

/**
 * D194: claude's own deny rules (a --settings flag setting, applied even with --setting-sources ""
 * and before its read-only auto-allow): secrets in the home folder can't be read, edited or named
 * in a command, whatever the access. Rule syntax as claude 2.1.299 documents it ("Read(~/.zshrc)", gitignore-style paths, "//" for absolute ones, "*" as a wildcard in Bash rules).
 */
export const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".config/gh", ".config/gcloud", ".kube", ".docker", "Library/Keychains", ".password-store"] as const;
/**
 * Claude Code's own folder: never edited (deny), and reads or commands naming it are ask rules
 * (CLAUDE_ASK_RULES) so they come to Uncut, which lets this project's saved tool output
 * (projects/<project>/<session>/tool-results/, where claude puts a large result and tells the agent
 * to read it) be read and refuses the rest (other conversations, settings). Round 2's A2: the deny
 * rules refused claude's own saved output twice.
 */
export const CLAUDE_DIR = ".claude";
// A command naming any .claude folder (the project's own included, `mkdir -p .claude/skills`) comes to Uncut too.
const CLAUDE_ASK_RULES = [
  `Read(~/${CLAUDE_DIR}/**)`,
  `Bash(*/${CLAUDE_DIR}/*)`,
  `Bash(*/${CLAUDE_DIR})`,
  `Bash(*~/${CLAUDE_DIR}*)`,
  `Bash(*${CLAUDE_DIR}/*)`,
  `Bash(*${CLAUDE_DIR})`,
];
export const SECRET_FILES = [".netrc", ".npmrc", ".git-credentials", ".claude.json", ".pypirc"] as const;
/** A secret file as a file rule's pattern: Claude Code's own config with its backups (.claude.json.backup, …). */
const secretPattern = (f: string) => (f === ".claude.json" ? `${f}*` : f);
/**
 * CLAUDE_CONFIG_DIR (Claude Code's folder when the user moved it from ~/.claude; its .claude.json
 * is in it too): the same rules as ~/.claude at its absolute paths, the folder as set and its real
 * path when they differ (claudeConfigDirs). ~/.claude's rules stay.
 */
const configDirDenyRules = (dirs: ReadonlyArray<string>) =>
  dirs.flatMap((d) => {
    const base = globSafe(d.replace(/\/+$/, ""));
    return [`Edit(/${base}/**)`, `Read(/${base}/.claude.json*)`];
  });
const configDirAskRules = (dirs: ReadonlyArray<string>) =>
  dirs.flatMap((d) => {
    const dir = d.replace(/\/+$/, "");
    return [`Read(/${globSafe(dir)}/**)`, ...["/", " ", '"', "'"].map((end) => `Bash(*${bashSafe(dir)}${end}*)`), `Bash(*${bashSafe(dir)})`];
  });
export function denyRules(dataDir?: string, claudeConfig: ReadonlyArray<string> = []): Array<string> {
  const rules: Array<string> = [];
  for (const d of SECRET_DIRS) {
    for (const tool of ["Read", "Edit"]) rules.push(`${tool}(~/${d}/**)`);
    rules.push(`Bash(*/${d}/*)`, `Bash(*/${d})`, `Bash(*~/${d}*)`);
  }
  rules.push(`Edit(~/${CLAUDE_DIR}/**)`);
  rules.push(...configDirDenyRules(claudeConfig));
  for (const f of SECRET_FILES) {
    for (const tool of ["Read", "Edit"]) rules.push(`${tool}(~/${secretPattern(f)})`);
    rules.push(`Bash(*${f}*)`);
  }
  // .env files anywhere (Read and Edit), and a command naming one (after a space or a slash, so `process.env` isn't caught).
  for (const tool of ["Read", "Edit"]) rules.push(`${tool}(//**/.env)`, `${tool}(//**/.env.*)`);
  rules.push("Bash(* .env*)", "Bash(*/.env*)");
  // A backstop under Uncut's own allowlist: claude refuses these before anyone is asked.
  for (const prefix of [
    "rm",
    "rmdir",
    "shred",
    "sudo",
    "su",
    "doas",
    "git push",
    "scp",
    "sftp",
    "ssh",
    "nc",
    "ncat",
    "telnet",
    "dd",
    "mkfs",
    "diskutil",
    "launchctl",
    "osascript",
    "chown",
    "crontab",
    "defaults write",
    "security",
  ])
    rules.push(`Bash(${prefix}:*)`);
  for (const flag of [" -d ", " --data", " -F ", " --form", " -T ", " --upload-file", " --json"]) rules.push(`Bash(curl*${flag}*)`);
  rules.push(...appDataRules(dataDir));
  return rules;
}

/** A path as a piece of a Bash rule (claude's matcher: `\*` is a literal star, `\\` a literal backslash). */
const bashSafe = (p: string) => p.replace(/[\\*]/g, (c) => `\\${c}`);

/**
 * D219: apps' data, Uncut's first. Uncut's data folder holds what a session must never change
 * (settings.json with the plugin approvals, plugins/, brand kits) and the app's server token: no
 * file tool writes anywhere in it and the token isn't read or named by a command (deny rules). The
 * same for every app's data in ~/Library/Application Support (browsers' cookies, other apps'
 * tokens): no writes. A command naming apps' data goes to Uncut (appDataAskRules), which runs only
 * a plain read of the brand kits or the graphic libraries and refuses the rest (decide).
 */
export function appDataRules(dataDir?: string): Array<string> {
  const rules = ["Edit(~/Library/Application Support/**)"];
  if (!dataDir) return rules;
  const dir = dataDir.replace(/\/+$/, "");
  rules.push(`Edit(/${globSafe(dir)}/**)`, `Read(/${globSafe(dir)}/server-token)`, "Bash(*server-token*)");
  return rules;
}

/**
 * D219 (issue A/B 2026-10-17): commands naming apps' data are ask rules, not deny rules, in every
 * access: an ask rule is checked before claude's read-only auto-allow and its classifier, so the
 * command comes to Uncut over stdio and `decide` lets a plain read of the brand kits' files run
 * (claude's deny rules refused `cat` of a kit SVG silently, with no card) and refuses the rest.
 */
export function appDataAskRules(dataDir?: string, claudeConfig: ReadonlyArray<string> = []): Array<string> {
  const rules = ["Bash(*Application Support*)", "Bash(*Application\\ Support*)", ...CLAUDE_ASK_RULES, ...configDirAskRules(claudeConfig)];
  const dir = dataDir?.replace(/\/+$/, "");
  // A data folder elsewhere (UNCUT_DATA_DIR) isn't caught by the Application Support rules.
  // (The folder itself, not a sibling that starts with its name.)
  if (dir && !/\/Library\/Application Support(\/|$)/.test(dir))
    rules.push(...["/", " ", '"', "'"].map((end) => `Bash(*${bashSafe(dir)}${end}*)`), `Bash(*${bashSafe(dir)})`);
  return rules;
}

/** A path as a gitignore-style pattern piece (claude's file rules): its wildcard characters escaped. */
const globSafe = (p: string) => p.replace(/[\\*?[\]{}!]/g, (c) => `\\${c}`);

/**
 * D214: Auto only. claude's classifier would allow "local file operations within project scope"
 * itself, so Uncut's own files get claude-side deny rules too: Edit (claude's Edit rules cover every
 * file-writing tool) of project.json, history.db*, agent/ and brand/active.json at the project's
 * absolute paths (`//` + the path; the real path and the opened one when they differ). A command
 * naming one of them is an ask rule (ownFileAskRules): Uncut runs a plain read (`cat project.json`)
 * and refuses the rest.
 */
export function ownFileRules(projects: ReadonlyArray<string>): Array<string> {
  const rules: Array<string> = [];
  for (const dir of [...new Set(projects)]) {
    const base = globSafe(dir.replace(/\/+$/, ""));
    for (const rel of ["project.json", "history.db*", "agent/**", "brand/active.json"]) rules.push(`Edit(/${base}/${rel})`);
  }
  return rules;
}

/** D214: Auto only, commands naming Uncut's own files: to Uncut, which runs only a plain read of them. */
export const ownFileAskRules = (): Array<string> => ["Bash(*project.json*)", "Bash(*history.db*)", "Bash(*brand/active.json*)", "Bash(*agent/turns*)"];

/**
 * D214: Auto only, claude-side ask rules. An ask rule is checked before the classifier, so these calls
 * never go to it and come to Uncut over stdio as can_use_tool instead, decided by `decide` as before:
 * every file write (outside the project and in confirmed folders: a card; in the project: no card;
 * Uncut's own files: refused), every read, glob and grep (outside the project: a card; confirmed
 * folders: no card), and the web tools (a secret-looking string: a card). Commands stay with the
 * classifier, also after the web (D214: no web taint in Auto, the user's call), except those naming
 * apps' data or Uncut's own files (appDataAskRules, ownFileAskRules).
 */
export function autoAskRules(): Array<string> {
  return ["Edit", "Write", "NotebookEdit", "Read", "Glob", "Grep", "WebFetch", "WebSearch"];
}

/**
 * D194, D214: the --settings JSON a session gets: claude's deny rules in every access; in Auto also
 * Uncut's own files (deny) and the calls that must still reach Uncut (ask). The user's Claude Code
 * skills don't run their inline shell commands (those would skip Uncut's approvals).
 */
export function sessionSettings(
  o: {
    readonly access?: Access | undefined;
    readonly projects?: ReadonlyArray<string> | undefined;
    readonly dataDir?: string | undefined;
    readonly claudeConfig?: ReadonlyArray<string> | undefined;
  } = {},
): string {
  const cc = o.claudeConfig ?? [];
  if (o.access !== "auto")
    return JSON.stringify({ disableSkillShellExecution: true, permissions: { deny: denyRules(o.dataDir, cc), ask: appDataAskRules(o.dataDir, cc) } });
  return JSON.stringify({
    disableSkillShellExecution: true,
    permissions: {
      deny: [...denyRules(o.dataDir, cc), ...ownFileRules(o.projects ?? [])],
      ask: [...autoAskRules(), ...appDataAskRules(o.dataDir, cc), ...ownFileAskRules()],
    },
  });
}

/** D194: tools a Look only session starts without (--disallowedTools): claude can't even auto-allow a read-only command. */
export const LOOK_DISALLOWED = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"] as const;
