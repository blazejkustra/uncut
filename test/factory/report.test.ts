import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exitCodeOf, reportDirName, skippedCheck, summaryOf, verdictOf, writeReport, type Check, type Report } from "../../scripts/factory/report.ts";

const check = (status: Check["status"], required = true, id = "x"): Check => ({ id, title: id, status, required, durationMs: 1000 });
const pass = check("pass");

const report = (checks: ReadonlyArray<Check>): Report => {
  const exitCode = exitCodeOf(checks);
  return {
    schema: 1,
    mode: "verify",
    sha: "abc",
    worktree: "/w",
    dirty: false,
    startedAt: "2026-11-01T00:00:00.000Z",
    durationMs: 2000,
    verdict: verdictOf(exitCode),
    exitCode,
    environment: {},
    checks,
  };
};

test("all checks passing exits 0", () => {
  assert.equal(exitCodeOf([pass, pass]), 0);
  assert.equal(verdictOf(0), "pass");
});

test("a failed check exits 1, even beside a skip", () => {
  assert.equal(exitCodeOf([pass, check("fail")]), 1);
  assert.equal(exitCodeOf([check("skipped"), check("fail")]), 1);
  assert.equal(verdictOf(1), "fail");
});

test("a skip of something meant to run exits 2, never 0", () => {
  assert.equal(exitCodeOf([pass, check("skipped")]), 2);
  assert.equal(verdictOf(2), "environment");
});

test("an optional skip doesn't change a pass, but alone proves nothing", () => {
  assert.equal(exitCodeOf([pass, check("skipped", false)]), 0);
  assert.equal(exitCodeOf([check("skipped", false)]), 2);
});

test("no checks at all exits 2", () => {
  assert.equal(exitCodeOf([]), 2);
});

test("skippedCheck is required unless told otherwise", () => {
  assert.equal(skippedCheck("a", "A", "why").required, true);
  assert.equal(skippedCheck("a", "A", "why", false).required, false);
});

test("the summary names the verdict, each check, its problems and evidence", () => {
  const failed: Check = { ...check("fail", true, "golden:one"), problems: ["3 of 90 frames differ"], evidence: ["/e/f0001.png"] };
  const text = summaryOf(report([pass, failed, { ...skippedCheck("golden:footage", "F", "not here", false) }]));
  assert.match(text, /Verdict: fail \(exit 1\) for abc/);
  assert.match(text, /1 passed, 1 failed, 1 skipped/);
  assert.match(text, /FAIL\s+golden:one/);
  assert.match(text, /3 of 90 frames differ/);
  assert.match(text, /evidence: \/e\/f0001.png/);
  assert.match(text, /SKIPPED golden:footage \(0.0 s\) \(optional\): not here/);
});

test("a dirty worktree never shares a report folder with its commit", () => {
  assert.equal(reportDirName("abc", false), "abc");
  assert.equal(reportDirName("abc", true), "abc-dirty");
});

test("writeReport leaves report.json and summary.txt, no temp files", () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-report-"));
  try {
    const written = report([pass]);
    writeReport(dir, written);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")), written);
    assert.match(readFileSync(join(dir, "summary.txt"), "utf8"), /Verdict: pass/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
