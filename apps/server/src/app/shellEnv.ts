// A macOS app started from Finder or the Dock gets launchd's bare environment: PATH is
// /usr/bin:/bin:/usr/sbin:/sbin, so Homebrew, nvm and ~/.local/bin tools (claude, ffmpeg,
// argent) are invisible. Like t3code's DesktopShellEnvironment, ask the user's login shell
// once at startup, with markers around the values and a timeout, and fall back to the usual
// install locations if the shell hangs, fails or prints nonsense.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { runProbe } from "../media/probe.ts";

const SHELL_TIMEOUT_MS = 4000;
const START = "__UNCUT_PATH_START__";
const END = "__UNCUT_PATH_END__";
const AUTH_START = "__UNCUT_AUTH_START__";
const AUTH_END = "__UNCUT_AUTH_END__";

/** Where developer tools live on a Mac even when no shell told us. Appended last. */
export const fallbackPathDirs = (home = homedir()) => [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  `${home}/.local/bin`,
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

export const mergePath = (...parts: ReadonlyArray<string | undefined>) => {
  const seen = new Set<string>();
  const out: Array<string> = [];
  for (const part of parts) {
    for (const dir of (part ?? "").split(":")) {
      const d = dir.trim();
      if (d && d.startsWith("/") && !seen.has(d)) {
        seen.add(d);
        out.push(d);
      }
    }
  }
  return out.join(":");
};

/**
 * D277: the variables Claude Code signs in with, whichever way the user set it up: a Claude login
 * token, an Anthropic API key or gateway (ANTHROPIC_*), Amazon Bedrock (and Mantle), Google Cloud's
 * Agent Platform (Vertex) or Microsoft Foundry. Anthropic's terms for products that run Claude Code
 * forbid removing or restricting any of its sign-in methods, so claude gets these as they are.
 */
export const isClaudeAuthVar = (k: string) =>
  k.startsWith("ANTHROPIC_") ||
  k === "CLAUDE_CODE_OAUTH_TOKEN" ||
  /^CLAUDE_CODE_(USE|SKIP)_(BEDROCK|VERTEX|FOUNDRY|MANTLE)(_AUTH)?$/.test(k) ||
  k === "CLAUDE_CODE_SKIP_AWS_CRED_CACHE" ||
  k === "CLAUDE_CODE_AWS_CHAIN_RESOLVE_TIMEOUT_MS" ||
  k === "CLAUDE_CODE_API_KEY_HELPER_TTL_MS" ||
  k.startsWith("AWS_") ||
  k === "CLOUD_ML_REGION" ||
  k.startsWith("VERTEX_REGION_") ||
  k === "GOOGLE_APPLICATION_CREDENTIALS" ||
  k === "GOOGLE_CLOUD_PROJECT" ||
  k === "GCLOUD_PROJECT" ||
  k === "CLOUDSDK_CONFIG" ||
  k.startsWith("AZURE_");

/** Only the Claude Code sign-in variables of an environment (isClaudeAuthVar). */
export const pickClaudeAuth = (env: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== "" && isClaudeAuthVar(k)) out[k] = v;
  return out;
};

/**
 * Pulls PATH (between markers) and the Claude Code sign-in variables (`env -0` between markers,
 * filtered by isClaudeAuthVar) out of the shell's output. Nothing else of the shell's environment is kept.
 */
export const parseShellOutput = (output: string): { path?: string; auth: Record<string, string> } => {
  const start = output.indexOf(START);
  const end = start === -1 ? -1 : output.indexOf(END, start + START.length);
  const path = start !== -1 && end !== -1 ? output.slice(start + START.length, end).trim() : undefined;
  // Only absolute, colon-separated entries count; anything else is noise from a chatty rc file.
  const valid = path && path.split(":").every((d) => d === "" || d.startsWith("/")) ? path : undefined;
  const authStart = output.indexOf(AUTH_START);
  const authEnd = authStart === -1 ? -1 : output.indexOf(AUTH_END, authStart + AUTH_START.length);
  const vars: Record<string, string> = {};
  if (authStart !== -1 && authEnd !== -1) {
    for (const entry of output.slice(authStart + AUTH_START.length, authEnd).split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) vars[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  }
  return { path: valid || undefined, auth: pickClaudeAuth(vars) };
};

/** The environment minus ANTHROPIC_API_KEY: for the media tools and other non-claude processes. */
export const withoutApiKey = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== "ANTHROPIC_API_KEY") out[k] = v;
  return out;
};

export interface ShellEnvironment {
  readonly path: string;
  readonly source: "login-shell" | "fallback";
  // D277: the login shell's Claude Code sign-in variables (an app started from Finder doesn't have
  // them). Held in memory for claude's environment only; never logged, shown or sent anywhere.
  readonly auth: Record<string, string>;
}

// D277: the sign-in variables held for claude alone. "launch": the API key and auth token Uncut was
// started with, taken out of process.env (bin.ts) so no other child inherits them by accident;
// "shell": the login shell's, once it answers. claudeEnv layers shell < launch < its own env.
const heldAuth: { launch: Record<string, string>; shell: Record<string, string> } = { launch: {}, shell: {} };
export const holdClaudeAuth = (from: "launch" | "shell", vars: Readonly<Record<string, string | undefined>>) => {
  heldAuth[from] = pickClaudeAuth(vars);
};

/**
 * Runs `$SHELL -ilc` once and returns the PATH to use. Never fails: a shell that can't start,
 * hangs (4 s), floods its output (1 MB) or prints nonsense gives the fallback PATH.
 */
export const resolveShellEnvironment = (env: NodeJS.ProcessEnv = process.env): Promise<ShellEnvironment> => {
  const shell = env.SHELL && env.SHELL.startsWith("/") ? env.SHELL : "/bin/zsh";
  const script = `printf '%s' '${START}'; printenv PATH; printf '%s\\n' '${END}'; printf '%s' '${AUTH_START}'; env -0; printf '%s\\n' '${AUTH_END}'; true`;
  const fallback = (): ShellEnvironment => ({
    path: mergePath(env.PATH, fallbackPathDirs(env.HOME || homedir()).join(":")),
    source: "fallback",
    auth: {},
  });
  // A whole environment can be large; 1 MB still bounds a shell that floods its output.
  return runProbe(shell, ["-ilc", script], { timeoutMs: SHELL_TIMEOUT_MS, env: withoutApiKey(env), maxBytes: 1024 * 1024 })
    .then((result): ShellEnvironment => {
      if (result.kind !== "done") return fallback();
      const parsed = parseShellOutput(result.stdout);
      return {
        path: mergePath(parsed.path, env.PATH, fallbackPathDirs(env.HOME || homedir()).join(":")),
        source: parsed.path ? "login-shell" : "fallback",
        auth: parsed.auth,
      };
    })
    .catch(fallback);
};

/** Keys for paid services (D41, D97): no child process Uncut starts gets them. */
const isKeyName = (k: string) =>
  k === "ANTHROPIC_API_KEY" ||
  k === "ANTHROPIC_AUTH_TOKEN" ||
  k === "OPENAI_API_KEY" ||
  k === "GOOGLE_API_KEY" ||
  k === "GEMINI_API_KEY" ||
  k === "ELEVENLABS_API_KEY" ||
  k === "FREESOUND_API_KEY" ||
  k === "FAL_KEY" ||
  k === "REPLICATE_API_TOKEN" ||
  k === "HF_TOKEN";

/** Names that look like secrets: *_KEY, *_TOKEN, *_SECRET, *_PASSWORD, cloud credentials. */
const looksSecret = (k: string) => /(_KEY|_TOKEN|_SECRET|_PASSWORD)$/i.test(k) || /^(AWS|AZURE|GOOGLE_APPLICATION)_/i.test(k) || /^(GH|GITHUB|HF|NPM)_TOKEN$/i.test(k);

/**
 * The environment for the processes around the agent (no claude): the server's, minus API keys
 * (Anthropic's and the generators', D97), anything else that looks like a secret, and what would
 * make a claude think it runs inside another Claude Code session. claudeEnv adds Claude Code's own
 * sign-in back for claude.
 */
export const agentEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isKeyName(k) || looksSecret(k) || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    out[k] = v;
  }
  return out;
};

declare const __UNCUT_SERVER_VERSION__: string | undefined;

/**
 * Every `claude` Uncut starts (the agent session, the critic, the SVG generator, the setup probes)
 * gets this environment (D218, D277): agentEnv, plus whatever Claude Code signs in with (D277,
 * isClaudeAuthVar: a Claude login token, ANTHROPIC_API_KEY or a gateway, Bedrock, Vertex, Foundry;
 * from Uncut's own environment, the one it was launched with and the login shell's), minus what
 * would make claude misreport who started it (an inherited CLAUDE_AGENT_SDK_VERSION /
 * CLAUDE_AGENT_SDK_CLIENT_APP, CLAUDE_CODE_ENTRYPOINT, so claude names its own entrypoint) and the
 * Node/debug switches the Agent SDK also removes (NODE_OPTIONS, DEBUG), plus
 * CLAUDE_AGENT_SDK_CLIENT_APP=uncut/<version>, the way Anthropic's SDK docs ask an app to identify
 * itself (it becomes claude's x-client-app header). The generators' keys (OPENAI_API_KEY and the
 * rest) and other secrets stay out. Every other process (plugins, ffmpeg, the rasteriser) gets no
 * sign-in variable at all.
 */
export const claudeEnv = (env: NodeJS.ProcessEnv, version: string = typeof __UNCUT_SERVER_VERSION__ === "string" ? __UNCUT_SERVER_VERSION__ : "0.0.0-dev"): Record<string, string> => {
  const out: Record<string, string> = { ...agentEnv(env), ...heldAuth.shell, ...heldAuth.launch, ...pickClaudeAuth(env) };
  for (const k of Object.keys(out)) if (k.startsWith("CLAUDE_AGENT_SDK_") || k === "NODE_OPTIONS" || k === "DEBUG") delete out[k];
  out.CLAUDE_AGENT_SDK_CLIENT_APP = `uncut/${version}`;
  return out;
};

/** D277: the settings Claude Code signs in through (a key helper script, cloud credential refresh). */
const AUTH_SETTINGS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh"] as const;

/**
 * D277: the agent session and the critic run with --setting-sources "" (no hooks, rules or
 * permissions of the user's), which would also drop a sign-in set up in Claude Code's user
 * settings: the Bedrock and Vertex wizards write their variables to its `env` block, and an API
 * key can come from `apiKeyHelper`. This reads just those parts of <CLAUDE_CONFIG_DIR or
 * ~/.claude>/settings.json: `env` filtered to isClaudeAuthVar (for the child's environment, never
 * argv) and the AUTH_SETTINGS commands (for --settings). A missing or broken file gives nothing.
 */
export const userAuthSettings = (env: NodeJS.ProcessEnv): { env: Record<string, string>; settings: Record<string, string> } => {
  const none = { env: {}, settings: {} };
  const home = env.HOME || homedir();
  const dir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  } catch {
    return none;
  }
  if (!parsed || typeof parsed !== "object") return none;
  const file = parsed as Record<string, unknown>;
  const vars: Record<string, string> = {};
  if (file.env && typeof file.env === "object") for (const [k, v] of Object.entries(file.env as Record<string, unknown>)) if (typeof v === "string") vars[k] = v;
  const settings: Record<string, string> = {};
  for (const k of AUTH_SETTINGS) if (typeof file[k] === "string" && file[k]) settings[k] = file[k] as string;
  return { env: pickClaudeAuth(vars), settings };
};

/**
 * A plugin's environment (D97): the agent's, minus anything that looks like a secret (*_KEY,
 * *_TOKEN, *_SECRET, *_PASSWORD, AWS_* and other cloud credentials), Uncut's own variables (the
 * app token, test switches, the data dir) and ELECTRON_RUN_AS_NODE. A process plugin runs with
 * the user's rights; it just isn't handed secrets on top.
 */
export const pluginEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(agentEnv(env))) {
    if (looksSecret(k) || k.startsWith("ANTHROPIC_") || k.startsWith("UNCUT_") || k === "ELECTRON_RUN_AS_NODE") continue;
    out[k] = v;
  }
  return out;
};
