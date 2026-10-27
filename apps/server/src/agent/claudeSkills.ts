// The user's own Claude Code skills for the agent's session: found where Claude Code keeps them
// and handed to claude as small skills-only plugins (--plugin-dir), so --setting-sources "" still
// keeps the user's settings, hooks, permissions, MCP servers and CLAUDE.md out.
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { claudeConfigDirs } from "./agentPermissions.ts";

export interface ClaudeSkill {
  /** What the user types after / (a user or project skill by its name; others as plugin:name). */
  readonly id: string;
  /** The plugin claude loads it under; claude names it `${plugin}:${name}`. */
  readonly plugin: string;
  readonly name: string;
  readonly description: string;
  /** The skill's folder (with SKILL.md), as found. */
  readonly dir: string;
}

export interface InstalledPlugin {
  readonly name: string;
  readonly installPath: string;
}

/** The skill as claude's Skill tool names it. */
export const claudeSkillName = (s: Pick<ClaudeSkill, "plugin" | "name">) => `${s.plugin}:${s.name}`;

const USER_PLUGIN = "user";
const PROJECT_PLUGIN = "project";
/** Claude Code's name for the skills synced from the user's claude.ai account. */
const SYNCED_PLUGIN = "anthropic-skills";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DESCRIPTION_CHARS = 300;

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** A YAML block's lines: those after `at` while they are indented (or blank), trimmed. */
function indentedAfter(lines: ReadonlyArray<string>, at: number): Array<string> {
  const out: Array<string> = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    if (line.trim()) out.push(line.trim());
  }
  return out;
}

/** The front matter's description: on its line, or a folded/literal block (`>` or `|`) under it. */
export function skillDescription(text: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const lines = front.split(/\r?\n/);
  const at = lines.findIndex((l) => /^description:/.test(l));
  if (at < 0) return "";
  const first = lines[at]!.slice("description:".length).trim();
  const value = (/^[>|][+-]?$/.test(first) ? indentedAfter(lines, at).join(" ") : first).replace(/^(["'])(.*)\1$/, "$2").trim();
  return value.length > DESCRIPTION_CHARS ? `${value.slice(0, DESCRIPTION_CHARS - 3)}...` : value;
}

/** The skills in one skills folder: each child folder with a SKILL.md (dot folders left out). */
function skillsIn(dir: string, plugin: string): Array<Omit<ClaudeSkill, "id">> {
  let names: Array<string>;
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: Array<Omit<ClaudeSkill, "id">> = [];
  for (const name of names) {
    if (!NAME.test(name)) continue;
    const skillDir = join(dir, name);
    let text: string;
    try {
      text = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    out.push({ plugin, name, description: skillDescription(text), dir: skillDir });
  }
  return out;
}

/** The project's skills folders, nearest first: <dir>/.claude/skills from the project up to (not including) the home folder. */
function projectSkillDirs(projectDir: string, home: string): Array<string> {
  const out: Array<string> = [];
  let dir = projectDir;
  while (dir !== home && dir !== dirname(dir)) {
    out.push(join(dir, ".claude", "skills"));
    dir = dirname(dir);
  }
  return out;
}

/** Claude Code's folder for the claude.ai account's synced skills: skills/synced/<organization>_<account>. */
function syncedSkillsDir(configDir: string, home: string, env: NodeJS.ProcessEnv): string | undefined {
  const file = env.CLAUDE_CONFIG_DIR?.trim() ? join(configDir, ".claude.json") : join(home, ".claude.json");
  try {
    const account = (JSON.parse(readFileSync(file, "utf8")) as { oauthAccount?: { organizationUuid?: unknown; accountUuid?: unknown } }).oauthAccount;
    const org = account?.organizationUuid;
    const user = account?.accountUuid;
    return typeof org === "string" && typeof user === "string" && NAME.test(org) && NAME.test(user)
      ? join(configDir, "skills", "synced", `${org}_${user}`)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every skill Claude Code would load for this folder from the user's machine: the project's
 * (.claude/skills up the tree), the user's (~/.claude/skills or CLAUDE_CONFIG_DIR), the claude.ai
 * account's synced ones and the enabled plugins'. The first of a name in a plugin wins.
 */
export function findClaudeSkills(o: {
  readonly projectDir?: string | undefined;
  readonly plugins: ReadonlyArray<InstalledPlugin>;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Array<ClaudeSkill> {
  const home = o.home ?? homedir();
  const env = o.env ?? process.env;
  const configDir = claudeConfigDirs(env, home)[0] ?? join(home, ".claude");
  const found = [
    ...(o.projectDir ? projectSkillDirs(o.projectDir, home).flatMap((d) => skillsIn(d, PROJECT_PLUGIN)) : []),
    ...skillsIn(join(configDir, "skills"), USER_PLUGIN),
    ...[syncedSkillsDir(configDir, home, env)].flatMap((d) => (d ? skillsIn(d, SYNCED_PLUGIN) : [])),
    ...o.plugins
      .filter((p) => NAME.test(p.name) && ![USER_PLUGIN, PROJECT_PLUGIN, SYNCED_PLUGIN].includes(p.name))
      .flatMap((p) => skillsIn(join(p.installPath, "skills"), p.name)),
  ];
  const seen = new Set<string>();
  const out: Array<ClaudeSkill> = [];
  for (const s of found) {
    const full = claudeSkillName(s);
    if (seen.has(full)) continue;
    seen.add(full);
    const short = s.plugin === USER_PLUGIN || s.plugin === PROJECT_PLUGIN;
    out.push({ ...s, id: short && !out.some((x) => x.id === s.name) ? s.name : full });
  }
  return out;
}

/**
 * The skills as plugins claude loads with --plugin-dir: in `root`, one folder per plugin with its
 * manifest and a skills/ folder of links to the skill folders (nothing else of a plugin: no hooks,
 * MCP servers, agents or commands). The plugin folders, for the command line.
 */
export function writeSkillPlugins(root: string, skills: ReadonlyArray<ClaudeSkill>): Array<string> {
  rmSync(root, { recursive: true, force: true });
  const dirs: Array<string> = [];
  for (const plugin of [...new Set(skills.map((s) => s.plugin))]) {
    const dir = join(root, plugin);
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(dir, "skills"));
    writeFileSync(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: plugin, description: "The user's Claude Code skills, for Uncut's agent." }),
    );
    for (const s of skills.filter((x) => x.plugin === plugin)) symlinkSync(s.dir, join(dir, "skills", s.name), "dir");
    dirs.push(dir);
  }
  return dirs;
}

/** The skill folders' real paths: the agent reads files there (a skill's references and scripts) without a card. */
export const skillReadDirs = (skills: ReadonlyArray<ClaudeSkill>): Array<string> =>
  skills.flatMap((s) => {
    try {
      return [realpathSync.native(s.dir)];
    } catch {
      return [];
    }
  });

const PLUGINS_TTL_MS = 60_000;
const PLUGINS_TIMEOUT_MS = 5000;
let pluginsCache: { readonly bin: string; readonly at: number; readonly plugins: ReadonlyArray<InstalledPlugin> } | undefined;

/** `claude plugin list --json` read as the enabled plugins' names and folders. */
export function parsePluginList(stdout: string): Array<InstalledPlugin> {
  try {
    const list = JSON.parse(stdout) as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((p: { id?: unknown; enabled?: unknown; installPath?: unknown }) =>
      p && p.enabled === true && typeof p.id === "string" && typeof p.installPath === "string" && isDir(p.installPath)
        ? [{ name: p.id.split("@")[0]!, installPath: p.installPath }]
        : [],
    );
  } catch {
    return [];
  }
}

/** The user's enabled Claude Code plugins, as claude lists them (kept a minute; none when it fails). */
export function enabledPlugins(bin: string, env: NodeJS.ProcessEnv): Promise<ReadonlyArray<InstalledPlugin>> {
  if (pluginsCache && pluginsCache.bin === bin && Date.now() - pluginsCache.at < PLUGINS_TTL_MS) return Promise.resolve(pluginsCache.plugins);
  return new Promise((resolve) => {
    execFile(bin, ["plugin", "list", "--json"], { env, timeout: PLUGINS_TIMEOUT_MS, maxBuffer: 1 << 20 }, (error, stdout) => {
      const plugins = error ? [] : parsePluginList(stdout);
      pluginsCache = { bin, at: Date.now(), plugins };
      resolve(plugins);
    });
  });
}

/** Every skill of the user's for a session of `bin` in `projectDir` (findClaudeSkills with the enabled plugins). */
export const claudeSkillsFor = (bin: string, projectDir: string | undefined, env: NodeJS.ProcessEnv): Promise<Array<ClaudeSkill>> =>
  enabledPlugins(bin, env).then((plugins) => findClaudeSkills({ projectDir, plugins }));

/** The system prompt's few lines on the user's own Claude Code skills (empty when there are none). */
export function claudeSkillsPrompt(skills: ReadonlyArray<ClaudeSkill>): string {
  if (!skills.length) return "";
  return `\n\nThe user's own Claude Code skills (from this machine) are loaded too: Claude Code's Skill tool lists and runs them (names like user:<name>, project:<name> or <plugin>:<name>). Use one when the user asks for it or it clearly fits the task; Uncut's own skills (skill_read) still come first for video work.`;
}

/** A /id in a message (after a space, a ( or the start; not a path like /tmp/x). */
const CLAUDE_SKILL_CALL = /(?<![^\s(])\/([A-Za-z0-9][A-Za-z0-9._:-]*)(?![\w/.-]*[\w/])/g;

/** The user's Claude Code skills a message calls by /id, in order, without repeats; `taken`: ids Uncut's own skills answer. */
export function calledClaudeSkills(text: string, skills: ReadonlyArray<ClaudeSkill>, taken: ReadonlyArray<string> = []): Array<ClaudeSkill> {
  const out: Array<ClaudeSkill> = [];
  for (const m of text.matchAll(CLAUDE_SKILL_CALL)) {
    const id = m[1]!.replace(/[.:]+$/, "");
    const skill = taken.includes(id) ? undefined : skills.find((s) => s.id === id);
    if (skill && !out.includes(skill)) out.push(skill);
  }
  return out;
}

/** The block for a message that called one of the user's Claude Code skills by its /id. */
export function claudeSkillCallBlock(called: ReadonlyArray<ClaudeSkill>): string {
  return called
    .map(
      (s) =>
        `<claude-skill name="${claudeSkillName(s)}">\nThe user called their Claude Code skill /${s.id} for this message: run it with the Skill tool (skill "${claudeSkillName(s)}") and follow it.\n</claude-skill>`,
    )
    .join("\n\n");
}
