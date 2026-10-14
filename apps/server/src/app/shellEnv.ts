// A macOS app started from Finder or the Dock gets launchd's bare environment: PATH is
// /usr/bin:/bin:/usr/sbin:/sbin, so Homebrew, nvm and ~/.local/bin tools (claude, ffmpeg,
// argent) are invisible. Like t3code's DesktopShellEnvironment, ask the user's login shell
// once at startup, with markers around the values and a timeout, and fall back to the usual
// install locations if the shell hangs, fails or prints nonsense.
import { homedir } from "node:os";

import { runProbe } from "../media/probe.ts";

const SHELL_TIMEOUT_MS = 4000;
const START = "__UNCUT_PATH_START__";
const END = "__UNCUT_PATH_END__";
const KEY_SET = "__UNCUT_ANTHROPIC_KEY_SET__";

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

/** Pulls PATH (between markers) and whether ANTHROPIC_API_KEY is set out of the shell's output. */
export const parseShellOutput = (output: string): { path?: string; apiKeySet: boolean } => {
  const start = output.indexOf(START);
  const end = start === -1 ? -1 : output.indexOf(END, start + START.length);
  const path = start !== -1 && end !== -1 ? output.slice(start + START.length, end).trim() : undefined;
  // Only absolute, colon-separated entries count; anything else is noise from a chatty rc file.
  const valid = path && path.split(":").every((d) => d === "" || d.startsWith("/")) ? path : undefined;
  return { path: valid || undefined, apiKeySet: output.includes(KEY_SET) };
};

/** The environment minus ANTHROPIC_API_KEY (D41: Uncut never hands the key on). */
export const withoutApiKey = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== "ANTHROPIC_API_KEY") out[k] = v;
  return out;
};

export interface ShellEnvironment {
  readonly path: string;
  readonly source: "login-shell" | "fallback";
  // The key's presence only; its value is never read into this process.
  readonly apiKeySetInShell: boolean;
}

/**
 * Runs `$SHELL -ilc` once and returns the PATH to use. Never fails: a shell that can't start,
 * hangs (4 s), floods its output (64 KB) or prints nonsense gives the fallback PATH.
 */
export const resolveShellEnvironment = (env: NodeJS.ProcessEnv = process.env): Promise<ShellEnvironment> => {
  const shell = env.SHELL && env.SHELL.startsWith("/") ? env.SHELL : "/bin/zsh";
  const script = `printf '%s' '${START}'; printenv PATH; printf '%s\\n' '${END}'; [ -n "$ANTHROPIC_API_KEY" ] && printf '%s\\n' '${KEY_SET}'; true`;
  const fallback = (): ShellEnvironment => ({
    path: mergePath(env.PATH, fallbackPathDirs(env.HOME || homedir()).join(":")),
    source: "fallback",
    apiKeySetInShell: false,
  });
  return runProbe(shell, ["-ilc", script], { timeoutMs: SHELL_TIMEOUT_MS, env: withoutApiKey(env) })
    .then((result): ShellEnvironment => {
      if (result.kind !== "done") return fallback();
      const parsed = parseShellOutput(result.stdout);
      return {
        path: mergePath(parsed.path, env.PATH, fallbackPathDirs(env.HOME || homedir()).join(":")),
        source: parsed.path ? "login-shell" : "fallback",
        apiKeySetInShell: parsed.apiKeySet,
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
 * The agent's environment: the server's, minus anything that would bill an API account instead
 * of the user's Claude subscription (a stray ANTHROPIC_API_KEY did, once: "Credit balance is too
 * low"), the generators' keys (D97), anything else that looks like a secret (the agent runs with
 * no tools of its own, so it needs none), and what would make claude think it runs inside another
 * Claude Code session.
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
