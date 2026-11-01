import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { FactoryPaths } from "./config.ts";

export const API_AUTH_VARS: ReadonlyArray<string> = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
];

const PASSED_THROUGH: ReadonlyArray<string> = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR"];
const FALSE_BIN = "/usr/bin/false";

export function apiAuthVarsIn(env: NodeJS.ProcessEnv) {
  return API_AUTH_VARS.filter((name) => env[name] !== undefined);
}

export function prepareIsolation(paths: FactoryPaths) {
  rmSync(paths.emptyGhConfig, { recursive: true, force: true });
  mkdirSync(paths.emptyGhConfig, { recursive: true });
  mkdirSync(dirname(paths.isolatedGitConfig), { recursive: true });
  writeFileSync(paths.isolatedGitConfig, "[credential]\n\thelper =\n[core]\n\thooksPath = /dev/null\n");
}

function picked(env: NodeJS.ProcessEnv, names: ReadonlyArray<string>) {
  return Object.fromEntries(names.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])));
}

/** For code the agents may have written: the gates and verify.ts. */
export function gateEnv(env: NodeJS.ProcessEnv, paths: FactoryPaths): NodeJS.ProcessEnv {
  return {
    ...picked(env, PASSED_THROUGH),
    GH_CONFIG_DIR: paths.emptyGhConfig,
    GIT_CONFIG_GLOBAL: paths.isolatedGitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: FALSE_BIN,
    SSH_ASKPASS: FALSE_BIN,
    GIT_SSH_COMMAND: FALSE_BIN,
  };
}

/** CLAUDE_CODE_OAUTH_TOKEN is the subscription's own token, so `claude` alone may see it. */
export function agentEnv(env: NodeJS.ProcessEnv, paths: FactoryPaths): NodeJS.ProcessEnv {
  return { ...gateEnv(env, paths), ...picked(env, ["CLAUDE_CODE_OAUTH_TOKEN"]) };
}
