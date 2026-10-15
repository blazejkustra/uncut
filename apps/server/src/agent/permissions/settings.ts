// claude's --settings for a session: deny rules for secrets and app data, Auto's ask rules.
import type { Access } from "./access.ts";

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
