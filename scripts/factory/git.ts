import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { Escalation } from "./errors.ts";
import { gateEnv } from "./env.ts";
import { runChild } from "./process.ts";
import type { FactoryConfig, FactoryPaths } from "./config.ts";

const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const PRIVATE_DOCS = ["AGENTS.md", "planning/DECISIONS.md"];
const FORBIDDEN_PATHS: ReadonlyArray<RegExp> = [/\.md$/i, /\.(mp4|mov)$/i, /(^|\/)fixtures\//, /^\.github\//, /^scripts\/factory\//];

export interface GitScope {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly config: ReadonlyArray<string>;
}

const PINNED_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

export function ownerScope(cfg: FactoryConfig): GitScope {
  return { cwd: cfg.repoDir, env: cfg.env, config: PINNED_CONFIG };
}

/** The worktree's .git is agent-writable and can redirect git anywhere, so this scope holds no owner credentials. */
export async function worktreeScope(cfg: FactoryConfig, paths: FactoryPaths, worktree: string): Promise<GitScope> {
  const owner = ownerScope(cfg);
  const name = await git(owner, ["config", "user.name"]);
  const email = await git(owner, ["config", "user.email"]);
  return { cwd: worktree, env: gateEnv(cfg.env, paths), config: [...PINNED_CONFIG, "-c", `user.name=${name}`, "-c", `user.email=${email}`] };
}

function runGit(scope: GitScope, args: ReadonlyArray<string>) {
  return runChild("git", [...scope.config, ...args], { cwd: scope.cwd, env: scope.env, timeoutMs: GIT_TIMEOUT_MS });
}

export async function git(scope: GitScope, args: ReadonlyArray<string>) {
  const result = await runGit(scope, args);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.slice(-500)}`);
  return result.stdout.trim();
}

async function gitSucceeds(scope: GitScope, args: ReadonlyArray<string>) {
  return (await runGit(scope, args)).code === 0;
}

export async function fetchBase(cfg: FactoryConfig) {
  const owner = ownerScope(cfg);
  await git(owner, ["fetch", "origin", "main"]);
  return git(owner, ["rev-parse", "origin/main"]);
}

export async function createWorktree(cfg: FactoryConfig, worktree: string, base: string) {
  mkdirSync(dirname(worktree), { recursive: true });
  await git(ownerScope(cfg), ["worktree", "add", "--detach", worktree, base]);
}

export async function removeWorktree(cfg: FactoryConfig, worktree: string) {
  rmSync(worktree, { recursive: true, force: true });
  await git(ownerScope(cfg), ["worktree", "prune"]);
}

export async function sweepWorktrees(cfg: FactoryConfig, worktreesDir: string) {
  if (!existsSync(worktreesDir)) return;
  for (const name of readdirSync(worktreesDir)) await removeWorktree(cfg, join(worktreesDir, name));
}

export function missingPrivateDocs(cfg: FactoryConfig) {
  return PRIVATE_DOCS.filter((doc) => !existsSync(join(cfg.repoDir, doc)));
}

export async function copyPrivateDocs(cfg: FactoryConfig, scope: GitScope) {
  for (const doc of PRIVATE_DOCS) {
    if (!(await gitSucceeds(scope, ["check-ignore", "-q", doc]))) throw new Escalation("setup", `${doc} would not stay ignored`);
    mkdirSync(dirname(join(scope.cwd, doc)), { recursive: true });
    copyFileSync(join(cfg.repoDir, doc), join(scope.cwd, doc));
  }
}

export async function commitWork(scope: GitScope, message: string) {
  await git(scope, ["add", "--all"]);
  if (await gitSucceeds(scope, ["diff", "--cached", "--quiet"])) return;
  await git(scope, ["commit", "--no-verify", "--message", message]);
}

export async function changedFiles(scope: GitScope, base: string, head: string) {
  const stdout = await git(scope, ["diff", "-z", "--name-only", "--no-renames", `${base}..${head}`]);
  return stdout.split("\0").filter(Boolean);
}

export function forbiddenFiles(files: ReadonlyArray<string>) {
  return files.filter((file) => FORBIDDEN_PATHS.some((pattern) => pattern.test(file)));
}

export async function repoConfigFingerprint(cfg: FactoryConfig) {
  const commonDir = await git(ownerScope(cfg), ["rev-parse", "--git-common-dir"]);
  const config = readFileSync(join(resolve(cfg.repoDir, commonDir), "config"));
  return createHash("sha256").update(config).digest("hex");
}

export async function pushCommit(cfg: FactoryConfig, sha: string, branch: string) {
  await git(ownerScope(cfg), ["push", "--no-verify", "origin", `${sha}:refs/heads/${branch}`]);
}
