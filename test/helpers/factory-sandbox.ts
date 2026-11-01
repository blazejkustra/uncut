import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { defaultConfig, factoryPaths, type FactoryConfig } from "../../scripts/factory/config.ts";

const FAKE_BIN = resolve("test/helpers/fake-factory-bin.ts");

export interface FakeCall {
  kind: "claude" | "gh" | "pnpm";
  args: Array<string>;
  stdin: string;
  env: Record<string, string>;
  cwd: string;
}

export interface Sandbox {
  dir: string;
  cfg: FactoryConfig;
  originDir: string;
  repoDir: string;
  paths: ReturnType<typeof factoryPaths>;
  calls: () => Array<FakeCall>;
  claudeSteps: () => Array<string>;
  remoteBranches: () => Array<string>;
  setScenario: (scenario: object) => void;
  writeVerify: (exitCode: number) => void;
  cleanup: () => void;
}

const run = (cwd: string, ...args: Array<string>) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

function writeWrapper(dir: string, kind: string, sandbox: string) {
  const path = join(dir, kind);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_BIN}" ${kind} "${sandbox}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

function seedRepo(dir: string) {
  const originDir = join(dir, "origin.git");
  const repoDir = join(dir, "repo");
  mkdirSync(originDir);
  run(originDir, "init", "--bare", "--initial-branch=main");
  run(dir, "clone", "--quiet", originDir, repoDir);
  run(repoDir, "config", "user.name", "Factory Test");
  run(repoDir, "config", "user.email", "factory@example.com");
  writeFileSync(join(repoDir, ".gitignore"), "*.md\nplanning/\n");
  writeFileSync(join(repoDir, "readme.txt"), "seed\n");
  run(repoDir, "add", "--all");
  run(repoDir, "commit", "--quiet", "-m", "seed");
  run(repoDir, "push", "--quiet", "origin", "HEAD:main");
  mkdirSync(join(repoDir, "planning"));
  writeFileSync(join(repoDir, "AGENTS.md"), "agents\n");
  writeFileSync(join(repoDir, "planning/DECISIONS.md"), "decisions\n");
  return { originDir, repoDir };
}

export const ownerTimeline = [{ event: "labeled", created_at: "2026-10-01T00:00:00Z", actor: { login: "blazejkustra" }, label: { name: "factory" } }];

export const issue = (number: number, overrides: object = {}) => ({
  number,
  title: `Fix the thing ${number}`,
  body: "The thing is broken.",
  createdAt: `2026-10-${String(number).padStart(2, "0")}T00:00:00Z`,
  labels: [{ name: "factory" }],
  ...overrides,
});

export function makeSandbox(env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME }): Sandbox {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "uncut-factory-")));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const { originDir, repoDir } = seedRepo(dir);
  const home = join(dir, "home");
  mkdirSync(home);
  const callsFile = join(dir, "calls.jsonl");
  const defaults = defaultConfig(env);
  const cfg: FactoryConfig = {
    ...defaults,
    repoDir,
    home,
    claudeBin: writeWrapper(binDir, "claude", dir),
    ghBin: writeWrapper(binDir, "gh", dir),
    pnpmBin: writeWrapper(binDir, "pnpm", dir),
    verifyScript: join(dir, "verify.ts"),
    riskyPathsFile: join(dir, "risky-paths.json"),
  };
  const setScenario = (scenario: object) => writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
  setScenario({ issues: [issue(1)], timelines: { 1: ownerTimeline } });
  const calls = () =>
    existsSync(callsFile)
      ? readFileSync(callsFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FakeCall)
      : [];
  return {
    dir,
    cfg,
    originDir,
    repoDir,
    paths: factoryPaths(home),
    calls,
    claudeSteps: () =>
      calls()
        .filter((call) => call.kind === "claude")
        .map((call) => /^Factory step: (\w+)/.exec(call.stdin)?.[1] ?? "unknown"),
    remoteBranches: () =>
      run(repoDir, "ls-remote", "--heads", "origin")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("refs/heads/")[1] ?? ""),
    setScenario,
    writeVerify: (exitCode) =>
      writeFileSync(
        cfg.verifyScript,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(dir, "verify-args.json"))}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(${exitCode});\n`,
      ),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export const ghCalls = (box: Sandbox, command: string) => box.calls().filter((call) => call.kind === "gh" && call.args.join(" ").startsWith(command));
