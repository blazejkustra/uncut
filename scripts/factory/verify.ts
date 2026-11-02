// Runs on this Mac what CI can't: node scripts/factory/verify.ts <worktree> [--base <sha>] [--bless]
//
// Writes report.json and summary.txt to ~/.uncut-factory/verify/<sha>/ (<sha>-dirty when the
// worktree has uncommitted changes) and exits 0 on pass, 1 on a failure, 2 when the environment
// couldn't run everything that was meant to run. --bless records the goldens in
// ~/.uncut-factory/goldens/ from the worktree's commit instead of checking against them;
// --quarantine "<test file>=<why>" with it names a test file that already fails on that commit.
// Each step waits for memory, disk and no other ffmpeg, and a step's process tree over the memory
// cap (--memory-cap-gb, else memory-guard.ts's defaults) is killed and fails as "blocked: memory".
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { gatedFiles, runGatedFile } from "./app-tests.ts";
import { Blocked, ensureRoom, GB, guardLimits, type GuardLimits } from "./memory-guard.ts";
import { probeCapabilities } from "./capability-probe.ts";
import { footageDir, factoryHome, goldensDir, scrubEnvironment, toolchain, verifyDir } from "./verify-env.ts";
import { GATED_FILES } from "./gated-files.ts";
import { blessGoldens, checkGoldens, goldensProblem, goldensSha, quarantinedFiles, startExporter } from "./goldens.ts";
import { exitCodeOf, REPORT_SCHEMA, reportDirName, skippedCheck, summaryOf, verdictOf, writeReport, type Check, type Report } from "./report.ts";

const APP_FILE_TIMEOUT_MS = 8 * 60 * 1000;
const APP_FILE_ATTEMPTS = 2;
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

scrubEnvironment();

const log = (line: string) => console.error(`[verify] ${line}`);

function git(worktree: string, ...args: ReadonlyArray<string>) {
  return spawnSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
}

function runStep(id: string, title: string, cwd: string, command: string, args: ReadonlyArray<string>, logFile: string): Check {
  const started = Date.now();
  const r = spawnSync(command, args, { cwd, encoding: "utf8", timeout: BUILD_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
  writeFileSync(logFile, `${r.stdout}\n${r.stderr}`);
  const base = { id, title, required: true, durationMs: Date.now() - started, evidence: [logFile] };
  if (r.error) return { ...base, status: "skipped", reason: String(r.error) };
  return r.status === 0
    ? { ...base, status: "pass" }
    : { ...base, status: "fail", problems: [`${command} ${args.join(" ")} exited ${r.status}`, r.stderr.slice(-800)] };
}

function buildApp(worktree: string, outDir: string): Array<Check> {
  rmSync(join(worktree, "dist"), { recursive: true, force: true });
  const install = runStep("install", "pnpm install", worktree, "pnpm", ["install", "--frozen-lockfile"], join(outDir, "install.log"));
  if (install.status !== "pass") return [{ ...install, status: "skipped", reason: "dependencies could not be installed", required: true }];
  return [install, runStep("build", "The packaged app (pnpm dist)", worktree, "pnpm", ["dist"], join(outDir, "build.log"))];
}

/** A required skip saying what keeps a step from starting, or undefined once there's room for it. */
async function roomFor(id: string, limits: GuardLimits, path: string): Promise<Check | undefined> {
  try {
    await ensureRoom(limits, path);
    return undefined;
  } catch (error) {
    if (!(error instanceof Blocked)) throw error;
    return skippedCheck(id, `Room on this Mac for ${id}`, error.message);
  }
}

async function appTestChecks(worktree: string, limits: GuardLimits) {
  const checks: Array<Check> = [];
  const quarantined = quarantinedFiles(goldensDir());
  const options = {
    worktree,
    env: process.env,
    timeoutMs: APP_FILE_TIMEOUT_MS,
    attempts: APP_FILE_ATTEMPTS,
    quarantined,
    capBytes: limits.capBytes,
    onLine: log,
  };
  for (const file of gatedFiles(worktree, GATED_FILES)) {
    const blocked = checks.some((c) => c.values?.memoryBreach)
      ? skippedCheck(`app-test:${file}`, file, "not started: an earlier run was over its memory cap")
      : await roomFor(`app-test:${file}`, limits, worktree);
    checks.push(blocked ?? (await runGatedFile(file, options)));
  }
  return checks;
}

async function goldenChecks(appBundle: string, outDir: string, sha: string, options: Options): Promise<Array<Check>> {
  const { bless, quarantine } = options;
  const goldens = goldensDir();
  const problem = bless ? undefined : goldensProblem(goldens);
  if (problem) return [skippedCheck("goldens", "Export goldens", problem)];
  const exporter = await startExporter(appBundle, footageDir(), options.limits);
  try {
    if (bless) return await blessGoldens({ exporter, goldens, footageDir: footageDir() }, sha, quarantine);
    return await checkGoldens({ exporter, goldens, evidenceDir: join(outDir, "evidence"), footageDir: footageDir() });
  } finally {
    await exporter.stop();
  }
}

const crashCheck = (id: string, error: unknown): Check => skippedCheck(id, `The ${id} step`, String(error).slice(0, 1500));

async function guarded(id: string, step: () => Promise<Array<Check>>) {
  try {
    return await step();
  } catch (error) {
    return [crashCheck(id, error)];
  }
}

interface Options {
  readonly worktree: string;
  readonly base: string | undefined;
  readonly bless: boolean;
  readonly skipAppTests: boolean;
  readonly quarantine: Readonly<Record<string, string>>;
  readonly limits: GuardLimits;
}

async function runChecks(options: Options, outDir: string, sha: string) {
  const { worktree, bless, skipAppTests } = options;
  const tools = toolchain();
  if (tools.missing.length) return [skippedCheck("toolchain", "Tools this Mac needs", tools.missing.join("; "))];
  const noRoom = await roomFor("build", options.limits, worktree);
  if (noRoom) return [noRoom];
  const checks = buildApp(worktree, outDir);
  if (checks.some((c) => c.status !== "pass")) return checks;
  const appBundle = join(worktree, "dist/mac-arm64/Uncut.app");
  const binary = join(appBundle, "Contents/MacOS/Uncut");
  if (!existsSync(binary)) return [...checks, skippedCheck("packaged-app", "The packaged app", `${binary} was not built`)];
  checks.push(probeCapabilities(binary));
  if (!checks.every((c) => c.status === "pass")) return checks;
  checks.push(...(await guarded("goldens", () => goldenChecks(appBundle, outDir, sha, options))));
  if (!bless && !skipAppTests) checks.push(...(await guarded("app-tests", () => appTestChecks(worktree, options.limits))));
  return checks;
}

const changedFilesSince = (worktree: string, base: string | undefined) => {
  if (!base) return undefined;
  const r = git(worktree, "diff", "--name-only", `${base}...HEAD`);
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : undefined;
};

function holdDisplayAwake(): ChildProcess {
  return spawn("caffeinate", ["-dimsu"], { stdio: "ignore" });
}

const splitOnce = (text: string, separator: string) => {
  const at = text.indexOf(separator);
  return [text.slice(0, at), text.slice(at + 1)] as const;
};

function parseOptions(): Options {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string" },
      bless: { type: "boolean", default: false },
      quarantine: { type: "string", multiple: true, default: [] },
      "memory-cap-gb": { type: "string" },
      "skip-app-tests": { type: "boolean", default: false },
    },
  });
  const [path] = positionals;
  if (!path || !existsSync(join(path, ".git"))) {
    console.error("usage: verify.ts <worktreePath> [--base <sha>] [--bless [--quarantine <file>=<why>]...] [--memory-cap-gb <n>]");
    process.exit(2);
  }
  const quarantine = Object.fromEntries(values.quarantine.map((entry) => splitOnce(entry, "=")));
  const defaults = guardLimits();
  const capGb = Number(values["memory-cap-gb"]);
  const limits = capGb > 0 ? { ...defaults, capBytes: capGb * GB } : defaults;
  return { worktree: realpathSync(path), base: values.base, bless: values.bless, skipAppTests: values["skip-app-tests"], quarantine, limits };
}

async function main() {
  const options = parseOptions();
  const { worktree, base, bless, skipAppTests } = options;
  const sha = git(worktree, "rev-parse", "HEAD").stdout.trim();
  const dirty = git(worktree, "status", "--porcelain").stdout.trim() !== "";
  if (bless && dirty) {
    console.error("verify.ts: goldens are blessed from a commit: this worktree has uncommitted changes");
    process.exit(2);
  }
  const outDir = bless ? join(factoryHome(), "bless", sha) : join(verifyDir(), reportDirName(sha, dirty));
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const startedAt = new Date();
  const awake = holdDisplayAwake();
  const checks = await guarded("verify", () => runChecks(options, outDir, sha));
  awake.kill();
  const code = exitCodeOf(skipAppTests ? [...checks, skippedCheck("app-tests", "Capability-gated app tests", "left out with --skip-app-tests")] : checks);
  const blessedFrom = goldensSha(goldensDir());
  const changedFiles = changedFilesSince(worktree, base);
  const report: Report = {
    schema: REPORT_SCHEMA,
    mode: bless ? "bless" : "verify",
    sha,
    ...(base && { base }),
    ...(changedFiles && { changedFiles }),
    worktree,
    dirty,
    ...(blessedFrom && { goldensSha: blessedFrom }),
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    verdict: verdictOf(code),
    exitCode: code,
    environment: {
      ...toolchain().values,
      memoryCapGb: options.limits.capBytes / GB,
      minFreePercent: options.limits.minFreePercent,
      loadAverage: loadavg(),
      footageDir: footageDir(),
    },
    checks,
  };
  writeReport(outDir, report);
  console.log(summaryOf(report));
  console.log(`Report: ${join(outDir, "report.json")}`);
  process.exit(code);
}

await main();
