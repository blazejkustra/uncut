import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { Escalation } from "./errors.ts";
import { runChild } from "./process.ts";
import type { FactoryConfig } from "./config.ts";

const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const PRIVATE_DOCS = ["AGENTS.md", "planning/DECISIONS.md"];
const FORBIDDEN_PATHS: ReadonlyArray<RegExp> = [/\.md$/i, /\.(mp4|mov)$/i, /(^|\/)fixtures\//, /^\.github\//, /^scripts\/factory\//];

/** Agent code ran in this checkout, so its hooks and fsmonitor never run with the owner's credentials. */
function hardened(args: ReadonlyArray<string>) {
  return ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args];
}

export async function git(cfg: FactoryConfig, cwd: string, args: ReadonlyArray<string>) {
  const result = await runChild("git", hardened(args), { cwd, env: cfg.env, timeoutMs: GIT_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.slice(-500)}`);
  return result.stdout.trim();
}

async function gitSucceeds(cfg: FactoryConfig, cwd: string, args: ReadonlyArray<string>) {
  const result = await runChild("git", hardened(args), { cwd, env: cfg.env, timeoutMs: GIT_TIMEOUT_MS });
  return result.code === 0;
}

export async function fetchBase(cfg: FactoryConfig) {
  await git(cfg, cfg.repoDir, ["fetch", "origin", "main"]);
  return git(cfg, cfg.repoDir, ["rev-parse", "origin/main"]);
}

export async function createWorktree(cfg: FactoryConfig, worktree: string, base: string) {
  mkdirSync(dirname(worktree), { recursive: true });
  await git(cfg, cfg.repoDir, ["worktree", "add", "--detach", worktree, base]);
}

export async function removeWorktree(cfg: FactoryConfig, worktree: string) {
  if (existsSync(worktree)) await git(cfg, cfg.repoDir, ["worktree", "remove", "--force", worktree]);
  await git(cfg, cfg.repoDir, ["worktree", "prune"]);
}

export async function copyPrivateDocs(cfg: FactoryConfig, worktree: string) {
  for (const doc of PRIVATE_DOCS) {
    const source = join(cfg.repoDir, doc);
    if (!existsSync(source)) throw new Escalation("setup", `${doc} is missing from the local checkout`);
    if (!(await gitSucceeds(cfg, worktree, ["check-ignore", "-q", doc]))) throw new Escalation("setup", `${doc} would not stay ignored`);
    mkdirSync(dirname(join(worktree, doc)), { recursive: true });
    copyFileSync(source, join(worktree, doc));
  }
}

export async function commitWork(cfg: FactoryConfig, worktree: string, message: string) {
  await git(cfg, worktree, ["add", "--all"]);
  if (await gitSucceeds(cfg, worktree, ["diff", "--cached", "--quiet"])) return;
  await git(cfg, worktree, ["commit", "--no-verify", "--message", message]);
}

export async function changedFiles(cfg: FactoryConfig, worktree: string, base: string) {
  const stdout = await git(cfg, worktree, ["diff", "--name-only", "--no-renames", `${base}..HEAD`]);
  return stdout.split("\n").filter(Boolean);
}

export function forbiddenFiles(files: ReadonlyArray<string>) {
  return files.filter((file) => FORBIDDEN_PATHS.some((pattern) => pattern.test(file)));
}

export async function pushBranch(cfg: FactoryConfig, worktree: string, branch: string) {
  await git(cfg, worktree, ["push", "--no-verify", "origin", `HEAD:refs/heads/${branch}`]);
}
