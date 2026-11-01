import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const OWNER = "blazejkustra";
export const REPO_SLUG = "blazejkustra/uncut";
export const FACTORY_LABEL = "factory";
export const BLOCKED_LABEL = "factory-blocked";
export const MAC_VERIFY_CONTEXT = "mac-verify";

const HOUR_MS = 60 * 60 * 1000;

export interface Command {
  readonly name: string;
  readonly args: ReadonlyArray<string>;
}

export interface FactoryConfig {
  readonly repoDir: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly claudeBin: string;
  readonly ghBin: string;
  readonly pnpmBin: string;
  readonly nodeBin: string;
  readonly verifyScript: string;
  readonly riskyPathsFile: string;
  readonly wallClockMs: number;
  readonly maxTurns: number;
  readonly maxFixRounds: number;
  readonly triageLimit: number;
  readonly setup: ReadonlyArray<Command>;
  readonly gates: ReadonlyArray<Command>;
}

export const FALLBACK_RISKY_PATHS: ReadonlyArray<string> = [
  "apps/desktop/src/**",
  "apps/server/src/agent/**",
  "apps/server/src/capture/**",
  "apps/server/src/export/**",
  "apps/server/src/plugins/**",
  "apps/server/src/project/**",
  "packages/core/src/export.ts",
  "packages/core/src/plugins/**",
  "native/**",
  "infra/**",
  "package.json",
  "pnpm-lock.yaml",
];

const SETUP: ReadonlyArray<Command> = [{ name: "install", args: ["install", "--frozen-lockfile", "--prefer-offline"] }];

const GATES: ReadonlyArray<Command> = [
  { name: "format", args: ["format:check"] },
  { name: "lint", args: ["lint"] },
  { name: "typecheck", args: ["typecheck"] },
  { name: "build", args: ["build"] },
  { name: "test:fast", args: ["test:fast"] },
];

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): FactoryConfig {
  const scriptDir = import.meta.dirname;
  return {
    repoDir: resolve(scriptDir, "../.."),
    home: join(homedir(), ".uncut-factory"),
    env,
    claudeBin: "claude",
    ghBin: "gh",
    pnpmBin: "pnpm",
    nodeBin: process.execPath,
    verifyScript: join(scriptDir, "verify.ts"),
    riskyPathsFile: join(scriptDir, "risky-paths.json"),
    wallClockMs: 3 * HOUR_MS,
    maxTurns: 80,
    maxFixRounds: 2,
    triageLimit: 5,
    setup: SETUP,
    gates: GATES,
  };
}

export interface FactoryPaths {
  readonly stop: string;
  readonly pausedUntil: string;
  readonly lock: string;
  readonly ledger: string;
  readonly triageLedger: string;
  readonly runs: string;
  readonly worktrees: string;
  readonly emptyGhConfig: string;
  readonly isolatedGitConfig: string;
}

export function factoryPaths(home: string): FactoryPaths {
  return {
    stop: join(home, "STOP"),
    pausedUntil: join(home, "PAUSED_UNTIL"),
    lock: join(home, "run.lock"),
    ledger: join(home, "runs.jsonl"),
    triageLedger: join(home, "triage.jsonl"),
    runs: join(home, "runs"),
    worktrees: join(home, "worktrees"),
    emptyGhConfig: join(home, "isolation", "gh"),
    isolatedGitConfig: join(home, "isolation", "gitconfig"),
  };
}
