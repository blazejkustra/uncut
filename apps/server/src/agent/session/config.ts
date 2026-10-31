import { AGENT_IMAGE_TYPES, AGENT_MODELS, type AgentProvider } from "@uncut/contracts";
import { type Access, ALWAYS_DISALLOWED, claudeConfigDirs, permissionMode, sessionSettings, LOOK_DISALLOWED } from "../agentPermissions.ts";
import { SYSTEM_PROMPT, skillsPrompt } from "../agentTools.ts";
import type { PluginSkill } from "@uncut/core";
import { type ClaudeSkill, claudeSkillsPrompt } from "../claudeSkills.ts";
import { which } from "../../app/setup.ts";
import { claudeEnv } from "../../app/shellEnv.ts";

// How the agent runs claude: its command line, environment and timings.
export const PROVIDER = "Claude Code";

/** How long an approval card waits for the user (D99). */
export const APPROVAL_MS = 120_000;
export const KILL_AFTER_MS = 1500;
/** After closing claude's input, how long it may take to exit. */
export const GRACEFUL_MS = 5000;
const envMs = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
/** How long a Stop waits for claude to answer its interrupt before killing the session (UNCUT_AGENT_INTERRUPT_MS). */
export const interruptMs = () => envMs("UNCUT_AGENT_INTERRUPT_MS", 3000);
/** A session with no turn for this long is closed; the next message resumes it (UNCUT_AGENT_IDLE_MS). */
export const idleMs = () => envMs("UNCUT_AGENT_IDLE_MS", 15 * 60_000);
/** D194: how long the first message waits for claude to answer the initialize request (UNCUT_AGENT_INIT_MS). */
export const initMs = () => envMs("UNCUT_AGENT_INIT_MS", 10_000);
/** JSON with sorted keys: the same args however claude ordered them. */
export const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(value ?? null);
/** Live text and thinking are published at most this often. */
export const STREAM_PUBLISH_MS = 80;

/** The claude binary: UNCUT_CLAUDE (tests, or a custom install), else the first on PATH. */
export const findClaude = async (env: NodeJS.ProcessEnv = process.env) => env.UNCUT_CLAUDE || (await which("claude", env.PATH ?? ""));

export const IMAGE_EXT: Record<(typeof AGENT_IMAGE_TYPES)[number], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Claude Code's built-in tools a session gets. MCP tools and a configured advisor aren't filtered by --tools. */
const BUILTIN_TOOLS = ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch", "Skill"] as const;

/**
 * The session's command line (D139, D181, D194): BUILTIN_TOOLS plus only Uncut's MCP server, none of the user's own Claude Code settings
 * (--setting-sources "": no hooks, plugins, permissions, MCP servers or rules from ~/.claude; flag
 * and managed settings still apply) except their skills: `pluginDirs` are skills-only plugins
 * (claudeSkills.ts writeSkillPlugins) for the user's, the project's and the enabled plugins' skills. Opus/Sonnet/… and effort from the composer
 * (D184). Permissions (D214): Auto is `--permission-mode auto` (Claude Code's classifier approves
 * routine calls, like t3code's Auto), Ask first and Look only the default mode; in every access each
 * prompt comes to Uncut over stdio as a can_use_tool control request (the SDK's canUseTool), decided
 * per the turn's access (agentPermissions.ts). Uncut's own tools are pre-allowed and gated in
 * `allowed`. `addDirs`: folders the user mentioned in this chat. `projects`: the project folder (as
 * opened and its real path) for Auto's deny rules. `dataDir`: Uncut's data folder (D219's deny rules).
 * `settings` (D277): the --settings value when it isn't just Uncut's own rules (settingsArg: a 0600
 * file that adds the user's sign-in commands, which --setting-sources "" would otherwise drop).
 */
export function sessionArgs(o: {
  readonly cfg: string;
  readonly settings?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly resume?: string | undefined;
  readonly thinking?: string | undefined;
  readonly promptSnapshot?: "off" | undefined;
  readonly addDirs?: ReadonlyArray<string> | undefined;
  readonly access?: Access | undefined;
  readonly projects?: ReadonlyArray<string> | undefined;
  readonly dataDir?: string | undefined;
  readonly skills?: ReadonlyArray<Pick<PluginSkill, "name" | "description">> | undefined;
  readonly claudeSkills?: ReadonlyArray<ClaudeSkill> | undefined;
  readonly pluginDirs?: ReadonlyArray<string> | undefined;
}) {
  const access = o.access ?? "auto";
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools",
    BUILTIN_TOOLS.join(","),
    "--strict-mcp-config",
    "--mcp-config",
    o.cfg,
    "--setting-sources",
    "",
    "--allowedTools",
    "mcp__uncut",
    "--permission-mode",
    permissionMode(access),
    "--permission-prompt-tool",
    "stdio",
    // Secrets stay out whatever the access, before claude's own read-only auto-allow and its classifier.
    // D219: Uncut's data folder (and other apps' data) too.
    "--settings",
    o.settings ?? sessionSettings({ access, projects: o.projects, dataDir: o.dataDir, claudeConfig: claudeConfigDirs() }),
    // D232 (issue #60): every installed skill by name and description; skill_read loads one.
    "--append-system-prompt",
    `${SYSTEM_PROMPT}${skillsPrompt(o.skills ?? [])}${claudeSkillsPrompt(o.claudeSkills ?? [])}`,
  ];
  // D260 amended: Claude Code records the system prompt on a conversation's first request and reuses
  // that record on --resume (until compaction), ignoring the text passed later; off renders the current
  // prompt (and skills list) on every request, so a respawned session gets this build's prompt.
  if (o.promptSnapshot) args.push("--system-prompt-snapshot", o.promptSnapshot);
  // Look only: no shell or file-writing tools at all (claude would auto-allow a read-only command).
  args.push("--disallowedTools", [...ALWAYS_DISALLOWED, ...(access === "look" ? LOOK_DISALLOWED : [])].join(","));
  for (const dir of o.addDirs ?? []) args.push("--add-dir", dir);
  for (const dir of o.pluginDirs ?? []) args.push("--plugin-dir", dir);
  if (o.model) args.push("--model", o.model);
  if (o.effort) args.push("--effort", o.effort);
  // D218: as the Agent SDK turns t3code's `thinking: { type: "adaptive", display: "summarized" }` into argv.
  if (o.thinking) args.push("--thinking", "adaptive", "--thinking-display", o.thinking);
  if (o.resume) args.push("--resume", o.resume);
  return args;
}

/** Claude Code compacts 33k below this window, so a conversation is summarised at about 250k instead of near 1M. */
export const AUTO_COMPACT_WINDOW = 283_000;
const BASH_OUTPUT_CHARS = "8000";

/**
 * The session's environment (D181, D277): claudeEnv (Claude Code's own sign-in, whatever it is; no
 * generator keys or other secrets; no CLAUDE_CODE_* from outside), plus the sign-in variables from
 * Claude Code's user settings `env` (--setting-sources "" skips that file), then tool search off
 * (every Uncut tool in the prompt, none deferred), no CLAUDE.md or rules files, no auto memory,
 * none of the skills that ship with Claude Code (config, keybindings, code review: none for a video editor) and
 * a command's output past BASH_OUTPUT_CHARS saved to a file, with a preview of it in the conversation.
 * The keychain login is untouched (no --bare, same CLAUDE_CONFIG_DIR).
 */
export const sessionEnv = (env: NodeJS.ProcessEnv): Record<string, string> => ({
  // D218: claudeEnv adds Uncut's honest client id (CLAUDE_AGENT_SDK_CLIENT_APP) and drops NODE_OPTIONS/DEBUG.
  // D277: including the sign-in variables of Claude Code's settings.json env (claudeEnv).
  ...claudeEnv(env),
  ENABLE_TOOL_SEARCH: "false",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(AUTO_COMPACT_WINDOW),
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
  BASH_MAX_OUTPUT_LENGTH: BASH_OUTPUT_CHARS,
});

/**
 * The composer's model choice as the CLI takes it: one of AGENT_MODELS for that provider, else the
 * CLI's default (claude: or UNCUT_AGENT_MODEL; Codex: its config.toml's model, issue #106).
 */
export const modelFor = (asked: string | undefined, provider: AgentProvider = "claude") =>
  asked && AGENT_MODELS.some((m) => m.id === asked && m.provider === provider)
    ? asked
    : provider === "claude"
      ? process.env.UNCUT_AGENT_MODEL || undefined
      : undefined;
