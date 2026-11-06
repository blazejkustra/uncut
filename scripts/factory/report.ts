// The verify report: what scripts/factory/verify.ts promises its caller. Exit 0: every check meant
// to run ran and passed. Exit 1: at least one failed. Exit 2: nothing failed, but something meant
// to run didn't, so the commit is unproven.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REPORT_SCHEMA = 1;

export type CheckStatus = "pass" | "fail" | "skipped";

export interface Check {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  /** false only for what may be absent from this Mac (the user's footage): its skip doesn't change the verdict. */
  readonly required: boolean;
  readonly reason?: string;
  readonly problems?: ReadonlyArray<string>;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly evidence?: ReadonlyArray<string>;
  readonly durationMs: number;
}

export type ExitCode = 0 | 1 | 2;
export type Verdict = "pass" | "fail" | "environment";

export interface Report {
  readonly schema: number;
  readonly mode: "verify" | "bless";
  readonly sha: string;
  readonly base?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly worktree: string;
  readonly dirty: boolean;
  readonly goldensSha?: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly verdict: Verdict;
  readonly exitCode: ExitCode;
  readonly environment: Readonly<Record<string, unknown>>;
  readonly checks: ReadonlyArray<Check>;
}

const VERDICTS: Readonly<Record<ExitCode, Verdict>> = { 0: "pass", 1: "fail", 2: "environment" };

export const verdictOf = (code: ExitCode) => VERDICTS[code];

export function exitCodeOf(checks: ReadonlyArray<Check>): ExitCode {
  if (checks.some((c) => c.status === "fail")) return 1;
  if (checks.length === 0 || checks.some((c) => c.status === "skipped" && c.required)) return 2;
  return checks.some((c) => c.status === "pass") ? 0 : 2;
}

/** A check that could not run for a reason this Mac has to fix. Without `required`, it's meant to run. */
export const skippedCheck = (id: string, title: string, reason: string, required = true): Check => ({
  id,
  title,
  status: "skipped",
  required,
  reason,
  durationMs: 0,
});

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function checkLine(c: Check) {
  const optional = c.status === "skipped" && !c.required ? " (optional)" : "";
  const why = c.reason ? `: ${c.reason}` : "";
  return `${c.status.toUpperCase().padEnd(7)} ${c.id} (${seconds(c.durationMs)})${optional}${why}`;
}

export function summaryOf(report: Report) {
  const count = (status: CheckStatus) => report.checks.filter((c) => c.status === status).length;
  const lines = [
    `Verdict: ${report.verdict} (exit ${report.exitCode}) for ${report.sha}${report.dirty ? " with uncommitted changes" : ""}`,
    `Checks: ${count("pass")} passed, ${count("fail")} failed, ${count("skipped")} skipped, in ${seconds(report.durationMs)}`,
    "",
  ];
  for (const c of report.checks) {
    lines.push(checkLine(c));
    for (const p of c.problems ?? []) lines.push(`        ${p}`);
    for (const e of c.evidence ?? []) lines.push(`        evidence: ${e}`);
  }
  return `${lines.join("\n")}\n`;
}

export const reportDirName = (sha: string, dirty: boolean) => (dirty ? `${sha}-dirty` : sha);

const writeAtomically = (path: string, text: string) => {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
};

export function writeReport(dir: string, report: Report) {
  mkdirSync(dir, { recursive: true });
  writeAtomically(join(dir, "summary.txt"), summaryOf(report));
  writeAtomically(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
