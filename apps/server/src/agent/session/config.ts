import { AGENT_IMAGE_TYPES, AGENT_MODELS } from "@uncut/contracts";
import { type Access, permissionMode, sessionSettings, LOOK_DISALLOWED } from "../agentPermissions.ts";
import { SYSTEM_PROMPT, skillsPrompt } from "../agentTools.ts";
import type { PluginSkill } from "@uncut/core";
import { which } from "../../app/setup.ts";
import { claudeEnv, userAuthSettings } from "../../app/shellEnv.ts";

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
  Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(value ?? null);
/** Live text and thinking are published at most this often. */
export const STREAM_PUBLISH_MS = 80;

/** The claude binary: UNCUT_CLAUDE (tests, or a custom install), else the first on PATH. */
export const findClaude = async (env: NodeJS.ProcessEnv = process.env) => env.UNCUT_CLAUDE || (await which("claude", env.PATH ?? ""));

export const IMAGE_EXT: Record<(typeof AGENT_IMAGE_TYPES)[number], string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/**
 * The session's command line (D139, D181, D194): Claude Code's default built-in tools (web, files,
 * shell, subagents) plus only Uncut's MCP server, none of the user's own Claude Code settings
 * (--setting-sources "": no hooks, plugins, permissions, skills, MCP servers or rules from
 * ~/.claude; flag and managed settings still apply), Opus/Sonnet/… and effort from the composer
 * (D184). Permissions (D214): Auto is `--permission-mode auto` (Claude Code's classifier approves
 * routine calls, like t3code's Auto), Ask first and Look only the default mode; in every access each
 * prompt comes to Uncut over stdio as a can_use_tool control request (the SDK's canUseTool), decided
 * per the turn's access (agentPermissions.ts). Uncut's own tools are pre-allowed and gated in
 * `allowed`. `addDirs`: folders the user mentioned in this chat. `projects`: the project folder (as
 * opened and its real path) for Auto's deny rules. `dataDir`: Uncut's data folder (D219's deny rules).
 * `authSettings` (D277): Claude Code's sign-in settings (apiKeyHelper and the cloud refresh commands),
 * by default the user's (userAuthSettings), which --setting-sources "" would otherwise drop.
 */
export function sessionArgs(o: { readonly cfg: string; readonly authSettings?: Readonly<Record<string, string>> | undefined; readonly model?: string | undefined; readonly effort?: string | undefined; readonly resume?: string | undefined; readonly thinking?: string | undefined; readonly promptSnapshot?: "off" | undefined; readonly addDirs?: ReadonlyArray<string> | undefined; readonly access?: Access | undefined; readonly projects?: ReadonlyArray<string> | undefined; readonly dataDir?: string | undefined; readonly skills?: ReadonlyArray<Pick<PluginSkill, "name" | "description">> | undefined }) {
  const access = o.access ?? "auto";
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools", "default",
    "--strict-mcp-config",
    "--mcp-config", o.cfg,
    "--setting-sources", "",
    "--allowedTools", "mcp__uncut",
    "--permission-mode", permissionMode(access),
    "--permission-prompt-tool", "stdio",
    // Secrets stay out whatever the access, before claude's own read-only auto-allow and its classifier.
    // D219: Uncut's data folder (and other apps' data) too.
    "--settings", JSON.stringify({ ...(o.authSettings ?? userAuthSettings(process.env).settings), ...JSON.parse(sessionSettings({ access, projects: o.projects, dataDir: o.dataDir })) }),
    // D232 (issue #60): every installed skill by name and description; skill_read loads one.
    "--append-system-prompt", `${SYSTEM_PROMPT}${skillsPrompt(o.skills ?? [])}`,
  ];
  // D260 amended: Claude Code records the system prompt on a conversation's first request and reuses
  // that record on --resume (until compaction), ignoring the text passed later; off renders the current
  // prompt (and skills list) on every request, so a respawned session gets this build's prompt.
  if (o.promptSnapshot) args.push("--system-prompt-snapshot", o.promptSnapshot);
  // Look only: no shell or file-writing tools at all (claude would auto-allow a read-only command).
  if (access === "look") args.push("--disallowedTools", LOOK_DISALLOWED.join(","));
  for (const dir of o.addDirs ?? []) args.push("--add-dir", dir);
  if (o.model) args.push("--model", o.model);
  if (o.effort) args.push("--effort", o.effort);
  // D218: as the Agent SDK turns t3code's `thinking: { type: "adaptive", display: "summarized" }` into argv.
  if (o.thinking) args.push("--thinking", "adaptive", "--thinking-display", o.thinking);
  if (o.resume) args.push("--resume", o.resume);
  return args;
}

/**
 * The session's environment (D181, D277): claudeEnv (Claude Code's own sign-in, whatever it is; no
 * generator keys or other secrets; no CLAUDE_CODE_* from outside), plus the sign-in variables from
 * Claude Code's user settings `env` (--setting-sources "" skips that file), then tool search off
 * (every Uncut tool in the prompt, none deferred), no CLAUDE.md or rules files and no auto memory.
 * The keychain login is untouched (no --bare, same CLAUDE_CONFIG_DIR).
 */
export const sessionEnv = (env: NodeJS.ProcessEnv): Record<string, string> => ({
  // D218: claudeEnv adds Uncut's honest client id (CLAUDE_AGENT_SDK_CLIENT_APP) and drops NODE_OPTIONS/DEBUG.
  ...claudeEnv(env),
  // Claude Code applies its settings' env over the environment it was started with; so does this.
  ...userAuthSettings(env).env,
  ENABLE_TOOL_SEARCH: "false",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
});

/** The composer's model choice as claude takes it: one of AGENT_MODELS, else Claude Code's default (or UNCUT_AGENT_MODEL). */
export const modelFor = (asked: string | undefined) => (asked && AGENT_MODELS.some((m) => m.id === asked) ? asked : process.env.UNCUT_AGENT_MODEL || undefined);
