import { existsSync, readFileSync } from "node:fs";

import { FALLBACK_RISKY_PATHS } from "./config.ts";
import { gateEnv } from "./env.ts";
import { runChild } from "./process.ts";
import { remainingMs, writeStepLog, type RunContext } from "./run-context.ts";

function isPathList(value: unknown): value is Array<string> {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

/** Read from the orchestrator's own checkout, so an agent can't shrink the list in its worktree. */
export function loadRiskyPaths(file: string): ReadonlyArray<string> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    const list = isPathList(value) ? value : (value as { paths?: unknown }).paths;
    return isPathList(list) ? list : FALLBACK_RISKY_PATHS;
  } catch {
    return FALLBACK_RISKY_PATHS;
  }
}

function globToRegExp(glob: string) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\*\*\/?|\*/g, (star) => (star === "*" ? "[^/]*" : ".*"));
  return new RegExp(`^${pattern}$`);
}

export function riskyFiles(files: ReadonlyArray<string>, patterns: ReadonlyArray<string>) {
  const matchers = patterns.map(globToRegExp);
  return files.filter((file) => matchers.some((matcher) => matcher.test(file)));
}

export type VerifyOutcome = "pass" | "fail" | "could-not-run" | "missing";

const OUTCOME_BY_EXIT = new Map<number | null, VerifyOutcome>([
  [0, "pass"],
  [1, "fail"],
]);

export interface VerifyReport {
  readonly outcome: VerifyOutcome;
  readonly output: string;
}

/** verify.ts runs from the orchestrator's checkout: the one in the worktree is agent-writable. */
export async function runVerify(ctx: RunContext, worktree: string, base: string): Promise<VerifyReport> {
  const { cfg, paths } = ctx;
  if (!existsSync(cfg.verifyScript)) return { outcome: "missing", output: "verify.ts is not installed" };
  const child = await runChild(cfg.nodeBin, [cfg.verifyScript, worktree, "--base", base], { env: gateEnv(cfg.env, paths), timeoutMs: remainingMs(ctx) });
  writeStepLog(ctx, "verify", `${child.stdout}\n${child.stderr}\n`);
  const outcome = child.timedOut ? "could-not-run" : (OUTCOME_BY_EXIT.get(child.code) ?? "could-not-run");
  return { outcome, output: `${child.stdout}\n${child.stderr}` };
}
