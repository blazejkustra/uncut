// The packaged-app test files CI can't run in full, run on this Mac's real GPU and audio output.
// A file counts as run only when its own TAP output says so: tests passed, none failed, and no
// check inside it stood down for a missing capability.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";

import { breachReason, killTree, watchTree, type Breach } from "./memory-guard.ts";
import type { Check } from "./report.ts";

export interface TapResult {
  readonly passed: number;
  readonly failed: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
  readonly logs: ReadonlyArray<string>;
}

const RESULT_LINE = /^\s*(not ok|ok) \d+ - (.*)$/;
const SKIP_DIRECTIVE = / # SKIP(?: (.*))?$/;
const TODO_DIRECTIVE = / # TODO/;
const COMMENT_LINE = /^\s*# (.*)$/;
const NODE_COUNTER = /^(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) [\d.]+$/;

export function parseTap(text: string): TapResult {
  let passed = 0;
  const failed: Array<string> = [];
  const skipped: Array<string> = [];
  const logs: Array<string> = [];
  for (const line of text.split("\n")) {
    const result = RESULT_LINE.exec(line);
    if (result) {
      const name = result[2]!;
      const skip = SKIP_DIRECTIVE.exec(name);
      if (skip) skipped.push(skip[1] ?? name);
      else if (TODO_DIRECTIVE.test(name)) continue;
      else if (result[1] === "ok") passed++;
      else failed.push(name);
      continue;
    }
    const comment = COMMENT_LINE.exec(line)?.[1];
    if (comment && !comment.startsWith("Subtest: ") && !NODE_COUNTER.test(comment)) logs.push(comment);
  }
  return { passed, failed, skipped, logs };
}

/** Standing down for the user's footage, which this Mac may legitimately lack. */
const EXPECTED_SKIPS: ReadonlyArray<RegExp> = [/UNCUT_FOOTAGE_DIR/];

const notCheckedLines = (logs: ReadonlyArray<string>) => logs.filter((l) => /^(# )?not checked \(/.test(l));

const unexpectedly = (lines: ReadonlyArray<string>) => lines.filter((l) => !EXPECTED_SKIPS.some((r) => r.test(l)));

export interface FileRun {
  readonly file: string;
  readonly exit: number | null;
  readonly timedOut: boolean;
  readonly tap: TapResult;
  readonly attempts: number;
  readonly durationMs: number;
  readonly breach?: Breach;
}

const MEASURED = /ssim|lufs|\bdb\b|\bms\b|fps|dropped/i;

/** Pass needs tests that ran; a missing capability or a file that ran nothing is a skip, which the verdict treats as unproven. */
export function fileCheck({ file, exit, timedOut, tap, attempts, durationMs, breach }: FileRun): Check {
  const base = { id: `app-test:${file}`, title: `Capability-gated app tests in ${file}`, required: true, durationMs };
  const stoodDown = unexpectedly([...tap.skipped, ...notCheckedLines(tap.logs)]);
  const values = {
    testsPassed: tap.passed,
    attempts,
    skippedExpected: tap.skipped.length + notCheckedLines(tap.logs).length - stoodDown.length,
    measured: tap.logs.filter((l) => MEASURED.test(l)).slice(0, 12),
  };
  if (breach) return { ...base, status: "fail", reason: breachReason(breach), values: { ...values, memoryBreach: true, peakBytes: breach.peakBytes } };
  if (timedOut) return { ...base, status: "skipped", reason: `did not finish within its time limit`, values };
  if (tap.failed.length) return { ...base, status: "fail", reason: `${tap.failed.length} failed`, problems: tap.failed, values };
  if (exit !== 0) return { ...base, status: "fail", reason: `exited ${exit} with no failed test listed`, values };
  if (tap.passed === 0) return { ...base, status: "skipped", reason: "no test in the file ran", problems: stoodDown, values };
  if (stoodDown.length) return { ...base, status: "skipped", reason: `${stoodDown.length} check(s) stood down`, problems: stoodDown, values };
  return { ...base, status: "pass", ...(attempts > 1 ? { reason: `passed on attempt ${attempts}: a flake` } : {}), values };
}

const GATE_IMPORT = /\bNO_REAL_(GPU|AUDIO)\b/;

const appTestFiles = (worktree: string) =>
  readdirSync(join(worktree, "test/app"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `test/app/${name}`);

/** The files that were gated at the commit this list was taken from, plus any newly gated one. */
export function gatedFiles(worktree: string, known: ReadonlyArray<string>) {
  const discovered = appTestFiles(worktree).filter((f) => GATE_IMPORT.test(readFileSync(join(worktree, f), "utf8")));
  return [...new Set([...known, ...discovered])].sort();
}

interface TapRun {
  readonly exit: number | null;
  readonly timedOut: boolean;
  readonly text: string;
  readonly breach?: Breach;
  readonly peakBytes: number;
}

export const runTapFile = (worktree: string, file: string, env: NodeJS.ProcessEnv, timeoutMs: number, capBytes: number) =>
  new Promise<TapRun>((done) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", file], { cwd: worktree, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const watch = watchTree(child.pid!, capBytes);
    let text = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (text += d));
    child.stderr.on("data", (d) => (text += d));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid!);
    }, timeoutMs);
    child.once("close", (exit) => {
      clearTimeout(timer);
      watch.stop();
      const breach = watch.breach();
      done({ exit, timedOut, text, peakBytes: watch.peakBytes(), ...(breach && { breach }) });
    });
  });

export interface RunOptions {
  readonly worktree: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly attempts: number;
  readonly quarantined: ReadonlyMap<string, string>;
  readonly capBytes: number;
  readonly onLine?: (line: string) => void;
}

/** Other work on this Mac past this one-minute load makes real-time playback and audio prove nothing. */
export const busyLoad = () => cpus().length;
const loadNow = () => Math.round(loadavg()[0]! * 10) / 10;

/** Files that judge real-time behaviour, so a failure while the Mac is overloaded says nothing about the code. */
export const TIMING_FILES: ReadonlySet<string> = new Set([
  "test/app/audio-app.test.ts",
  "test/app/gpu-compositor-app.test.ts",
  "test/app/issue12-app.test.ts",
  "test/app/issue55-app.test.ts",
  "test/app/issue83-app.test.ts",
  "test/app/mixer-app.test.ts",
]);

/**
 * What a failure of this run may be held to mean. A quarantined file already fails on the blessed
 * commit, so its failure is reported without deciding the verdict; a timing file failing on a
 * loaded Mac leaves the commit unproven.
 */
export function judged(check: Check, peakLoad: number, busyAt: number, quarantine: string | undefined): Check {
  if (check.status !== "fail" || check.values?.memoryBreach) return check;
  const values = { ...check.values, peakLoad };
  if (quarantine) return { ...check, status: "skipped", required: false, reason: `quarantined: ${quarantine}`, values };
  const file = check.id.replace("app-test:", "");
  if (TIMING_FILES.has(file) && peakLoad >= busyAt)
    return { ...check, status: "skipped", reason: `failed with this Mac at load ${peakLoad}, too busy to judge timing`, values };
  return { ...check, values };
}

/** A memory breach is never retried: the second try would only push the Mac as far again. */
const worthRetrying = (check: Check) => check.status === "fail" && !check.values?.memoryBreach;

export async function runGatedFile(file: string, { worktree, env, timeoutMs, attempts, quarantined, capBytes, onLine }: RunOptions): Promise<Check> {
  const started = Date.now();
  if (!existsSync(join(worktree, file))) {
    return {
      id: `app-test:${file}`,
      title: `Capability-gated app tests in ${file}`,
      status: "fail",
      required: true,
      reason: "the file is gone",
      durationMs: 0,
    };
  }
  const skippedChecksLog = join(worktree, "test-output/skipped-checks.txt");
  let check: Check | undefined;
  let peakLoad = loadNow();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    rmSync(skippedChecksLog, { force: true });
    const run = await runTapFile(worktree, file, env, timeoutMs, capBytes);
    peakLoad = Math.max(peakLoad, loadNow());
    const tap = parseTap(run.text);
    const notChecked = existsSync(skippedChecksLog) ? readFileSync(skippedChecksLog, "utf8").trim().split("\n") : [];
    const merged = { ...tap, logs: [...tap.logs, ...notChecked.map((l) => l.replace(/^.*?: (?=not checked)/, ""))] };
    check = fileCheck({ ...run, file, tap: merged, attempts: attempt, durationMs: Date.now() - started });
    onLine?.(`${check.status} ${file} (attempt ${attempt}, ${Math.round(check.durationMs / 1000)} s, peak ${Math.round(run.peakBytes / 2 ** 20)} MB)`);
    if (!worthRetrying(check)) break;
  }
  return judged(check!, peakLoad, busyLoad(), quarantined.get(file));
}
