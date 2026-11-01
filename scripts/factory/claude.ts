import { Escalation, Halt } from "./errors.ts";
import { agentEnv } from "./env.ts";
import { runChild, type ChildResult } from "./process.ts";
import { remainingMs, writeStepLog, type RunContext } from "./run-context.ts";
import { pauseForTheDay } from "./state.ts";

export interface ToolProfile {
  readonly tools: ReadonlyArray<string>;
  readonly allowed: ReadonlyArray<string>;
}

const READ_TOOLS = ["Read", "Glob", "Grep"];

export const NO_TOOLS: ToolProfile = { tools: [], allowed: [] };
export const READ_ONLY: ToolProfile = { tools: READ_TOOLS, allowed: READ_TOOLS };
export const IMPLEMENTER: ToolProfile = {
  tools: [...READ_TOOLS, "Edit", "Write", "Bash"],
  allowed: [
    ...READ_TOOLS,
    "Edit(./**)",
    "Write(./**)",
    "Bash(pnpm build)",
    "Bash(pnpm format)",
    "Bash(pnpm format:check)",
    "Bash(pnpm lint)",
    "Bash(pnpm test:fast)",
    "Bash(pnpm test:file *)",
    "Bash(pnpm typecheck)",
    "Bash(git diff *)",
    "Bash(git log *)",
    "Bash(git show *)",
    "Bash(git status *)",
  ],
};

export const DISALLOWED_TOOLS: ReadonlyArray<string> = [
  "WebFetch",
  "WebSearch",
  "Agent",
  "Bash(gh *)",
  "Bash(git push *)",
  "Bash(git remote *)",
  "Bash(git config *)",
  "Bash(git credential *)",
  "Bash(curl *)",
  "Bash(wget *)",
  "Bash(nc *)",
  "Bash(ncat *)",
  "Bash(ssh *)",
  "Bash(scp *)",
  "Bash(sftp *)",
  "Bash(rsync *)",
  "Bash(security *)",
  "Bash(pnpm dlx *)",
  "Bash(pnpm exec *)",
  "Bash(npx *)",
  "Read(~/.appstoreconnect/**)",
  "Read(~/.aws/**)",
  "Read(~/.config/gh/**)",
  "Read(~/.gitconfig)",
  "Read(~/.ssh/**)",
  "Edit(./.git)",
  "Write(./.git)",
];

export function claudeArgs(profile: ToolProfile, maxTurns: number): Array<string> {
  const args = ["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--setting-sources=", "--strict-mcp-config", "--no-session-persistence"];
  args.push("--max-turns", String(maxTurns), "--tools", profile.tools.join(","));
  if (profile.allowed.length > 0) args.push("--allowedTools", ...profile.allowed);
  args.push("--disallowedTools", ...DISALLOWED_TOOLS);
  return args;
}

interface ParsedResult {
  readonly text: string;
  readonly failed: boolean;
  readonly subtype?: string;
  readonly turns?: number;
}

interface ClaudeJsonResult {
  readonly type?: string;
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly num_turns?: number;
}

function lastResultMessage(stdout: string): ClaudeJsonResult | undefined {
  try {
    const value = JSON.parse(stdout) as ClaudeJsonResult | Array<ClaudeJsonResult>;
    return Array.isArray(value) ? value.findLast((entry) => entry.type === "result") : value;
  } catch {
    return undefined;
  }
}

export function parseClaudeOutput(child: ChildResult): ParsedResult {
  const message = lastResultMessage(child.stdout);
  if (message === undefined) return { text: `${child.stdout}\n${child.stderr}`, failed: true };
  const failed = child.code !== 0 || message.is_error === true || typeof message.result !== "string";
  return { text: message.result ?? "", failed, subtype: message.subtype, turns: message.num_turns };
}

const USAGE_LIMIT = /usage limit|limit reached|hit your (\w+ )*limit|rate.?limit|too many requests/i;

/** Only a failed run counts: a good one may well talk about limits in its summary. */
export function isUsageLimitFailure(parsed: ParsedResult, stderr: string) {
  return parsed.failed && USAGE_LIMIT.test(`${parsed.text}\n${stderr}`);
}

export interface AgentRequest {
  readonly name: string;
  readonly prompt: string;
  readonly profile: ToolProfile;
  readonly cwd: string;
}

export async function runAgent(ctx: RunContext, request: AgentRequest) {
  const { cfg, paths } = ctx;
  const child = await runChild(cfg.claudeBin, claudeArgs(request.profile, cfg.maxTurns), {
    cwd: request.cwd,
    env: agentEnv(cfg.env, paths),
    stdin: request.prompt,
    timeoutMs: remainingMs(ctx),
  });
  writeStepLog(ctx, request.name, `${child.stdout}\n${child.stderr}\n`);
  const parsed = parseClaudeOutput(child);
  if (child.timedOut) throw new Escalation(request.name, "the run's wall clock limit was reached");
  if (isUsageLimitFailure(parsed, child.stderr)) {
    pauseForTheDay(paths);
    throw new Halt("usage-limit");
  }
  if (parsed.subtype === "error_max_turns") throw new Escalation(request.name, "the agent reached its turn limit");
  if (parsed.failed) throw new Escalation(request.name, "the agent step failed");
  return parsed.text;
}
