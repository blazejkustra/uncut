import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runOnce } from "../../scripts/factory/orchestrator.ts";
import { findAttribution, prBodyProblem } from "../../scripts/factory/pr.ts";
import { readJsonl } from "../../scripts/factory/state.ts";
import { ghCalls, issue, makeSandbox, ownerTimeline, type Sandbox } from "../helpers/factory-sandbox.ts";

function withBox(name: string, body: (box: Sandbox) => Promise<void>) {
  test(name, async () => {
    const box = makeSandbox();
    try {
      await body(box);
    } finally {
      box.cleanup();
    }
  });
}

const RISKY_WRITE = { replies: { implement: [{ result: "done", writes: { "native/media/src/x.rs": "fn x() {}\n" } }] } };

function assertBlocked(box: Sandbox, expectedComment: RegExp) {
  const comment = ghCalls(box, "issue comment").at(-1);
  assert.match(comment?.stdin ?? "", expectedComment);
  const edit = ghCalls(box, "issue edit").at(-1);
  assert.deepEqual(edit?.args.slice(3), ["--repo", "blazejkustra/uncut", "--add-label", "factory-blocked", "--remove-label", "factory"]);
  assert.deepEqual(box.remoteBranches(), ["main"]);
  assert.equal(ghCalls(box, "pr create").length, 0);
}

withBox("a clean run pushes a branch, opens a PR with evidence and comments on the issue", async (box) => {
  const result = await runOnce(box.cfg);
  assert.equal(result.outcome, "pr-opened");
  assert.deepEqual(box.claudeSteps(), ["plan", "implement", "review"]);
  assert.deepEqual(box.remoteBranches(), ["factory/1-fix-the-thing-1", "main"]);

  const [pr] = ghCalls(box, "pr create");
  assert.ok(pr);
  assert.equal(prBodyProblem(pr.stdin), undefined);
  assert.match(pr.stdin, /Adds a small helper/);
  assert.match(pr.stdin, /`pnpm test:fast` passed/);
  assert.match(pr.stdin, /Reviewer in a fresh context: passed/);
  assert.ok(!findAttribution(pr.stdin));
  assert.match(ghCalls(box, "issue comment")[0]?.stdin ?? "", /pull\/999/);
  assert.equal(ghCalls(box, "issue edit").length, 0);
  assert.equal(ghCalls(box, "api").filter((call) => call.args[1]?.includes("statuses")).length, 0);

  const [entry] = readJsonl<{ outcome: string; runId: string; prUrl: string }>(box.paths.ledger);
  assert.equal(entry?.outcome, "pr-opened");
  assert.ok(existsSync(join(box.paths.runs, entry?.runId ?? "", "report.json")));
  assert.deepEqual(readdirSync(box.paths.worktrees), []);
  assert.ok(!existsSync(box.paths.lock));
});

withBox("private docs reach the worktree and stay out of the commit", async (box) => {
  await runOnce(box.cfg);
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "refs/heads/factory/1-fix-the-thing-1"], { cwd: box.originDir, encoding: "utf8" });
  assert.deepEqual(files.trim().split("\n").sort(), [".gitignore", "readme.txt", "src/change.ts"]);
  const plan = box.calls().find((call) => call.kind === "claude");
  assert.ok(plan?.cwd.startsWith(box.paths.worktrees));
});

withBox("private docs that would not stay ignored block the run", async (box) => {
  writeFileSync(join(box.repoDir, ".gitignore"), "planning/\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: box.repoDir });
  execFileSync("git", ["commit", "-q", "-m", "ignore less"], { cwd: box.repoDir });
  execFileSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: box.repoDir });
  const result = await runOnce(box.cfg);
  assert.equal(result.outcome, "blocked");
  assert.deepEqual(box.claudeSteps(), []);
});

withBox("an issue with a PR from an earlier run is not picked again", async (box) => {
  await runOnce(box.cfg);
  const again = await runOnce(box.cfg);
  assert.equal(again.outcome, "idle");
  assert.equal(ghCalls(box, "pr create").length, 1);
});

withBox("the label must come from the owner; the oldest accepted issue wins", async (box) => {
  box.setScenario({
    issues: [issue(3), issue(1), issue(2)],
    timelines: {
      1: [{ event: "labeled", created_at: "2026-10-01T00:00:00Z", actor: { login: "stranger" }, label: { name: "factory" } }],
      2: ownerTimeline,
      3: ownerTimeline,
    },
  });
  const result = await runOnce(box.cfg);
  assert.equal(result.issue, 2);
});

withBox("nothing happens when no owner-labelled issue exists", async (box) => {
  box.setScenario({ issues: [issue(1)], timelines: { 1: [{ event: "labeled", actor: { login: "stranger" }, label: { name: "factory" } }] } });
  const result = await runOnce(box.cfg);
  assert.equal(result.outcome, "idle");
  assert.deepEqual(box.claudeSteps(), []);
  assert.equal(ghCalls(box, "issue comment").length, 0);
});

withBox("a failing gate gets at most two fix rounds, then the issue is blocked", async (box) => {
  box.setScenario({ issues: [issue(1)], timelines: { 1: ownerTimeline }, gateFailures: { lint: 99 } });
  const result = await runOnce(box.cfg);
  assert.equal(result.outcome, "blocked");
  assert.deepEqual(box.claudeSteps(), ["plan", "implement", "fix", "fix"]);
  assertBlocked(box, /stopped at gate lint: still failing after 2 fix rounds/);
});

withBox("gate output reaches the fixer, and a pass inside the cap publishes", async (box) => {
  box.setScenario({ issues: [issue(1)], timelines: { 1: ownerTimeline }, gateFailures: { "test:fast": 2 } });
  const result = await runOnce(box.cfg);
  assert.equal(result.outcome, "pr-opened");
  const fix = box.calls().find((call) => call.kind === "claude" && call.stdin.startsWith("Factory step: fix"));
  assert.match(fix?.stdin ?? "", /test:fast failed: fake error/);
  assert.match(ghCalls(box, "pr create")[0]?.stdin ?? "", /Fix rounds used: 2/);
});

withBox("reviewer rejections share the fix cap", async (box) => {
  const fail = { result: JSON.stringify({ verdict: "fail", findings: [{ severity: "High", where: "a.ts:1", problem: "breaks" }] }) };
  box.setScenario({ issues: [issue(1)], timelines: { 1: ownerTimeline }, replies: { review: [fail, fail, fail] } });
  const result = await runOnce(box.cfg);
  assert.equal(result.outcome, "blocked");
  assert.deepEqual(box.claudeSteps(), ["plan", "implement", "review", "fix", "review", "fix", "review"]);
  assertBlocked(box, /stopped at review/);
});

withBox("a reviewer answer that can't be parsed counts as a rejection", async (box) => {
  box.setScenario({ issues: [issue(1)], timelines: { 1: ownerTimeline }, replies: { review: [{ result: "looks fine to me" }] } });
  const result = await runOnce(box.cfg);
  assert.equal(result.outcome, "pr-opened");
  assert.deepEqual(box.claudeSteps(), ["plan", "implement", "review", "fix", "review"]);
});

withBox("the reviewer sees the goal, the diff and the verification report, in a separate process", async (box) => {
  await runOnce(box.cfg);
  const review = box.calls().find((call) => call.kind === "claude" && call.stdin.startsWith("Factory step: review"));
  assert.match(review?.stdin ?? "", /Fix the thing 1/);
  assert.match(review?.stdin ?? "", /export const change = 1/);
  assert.match(review?.stdin ?? "", /untrusted_verification_report_/);
  assert.ok(review?.args.includes("--no-session-persistence"));
  assert.ok(!review?.args.includes("--resume"));
  assert.equal(review?.args[review.args.indexOf("--tools") + 1], "Read,Glob,Grep");
});

withBox("an agent that changes nothing blocks the issue", async (box) => {
  box.setScenario({ issues: [issue(1)], timelines: { 1: ownerTimeline }, replies: { implement: [{ result: "nothing to do" }] } });
  const result = await runOnce(box.cfg);
  assert.equal(result.outcome, "blocked");
  assertBlocked(box, /the agent changed nothing/);
});

withBox("changes to workflows or the factory itself are never published", async (box) => {
  box.setScenario({
    issues: [issue(1)],
    timelines: { 1: ownerTimeline },
    replies: { implement: [{ result: "done", writes: { ".github/workflows/x.yml": "on: push\n" } }] },
  });
  const result = await runOnce(box.cfg);
  assert.equal(result.outcome, "blocked");
  assertBlocked(box, /paths the factory may not publish/);
});

withBox("a risky change passes verify.ts, then mac-verify lands on the pushed SHA", async (box) => {
  box.writeVerify(0);
  box.setScenario({ issues: [issue(1)], timelines: { 1: ownerTimeline }, ...RISKY_WRITE });
  const result = await runOnce(box.cfg);
  assert.equal(result.outcome, "pr-opened");
  const head = execFileSync("git", ["rev-parse", "refs/heads/factory/1-fix-the-thing-1"], { cwd: box.originDir, encoding: "utf8" }).trim();
  const status = ghCalls(box, "api").find((call) => call.args[1]?.includes("statuses"));
  assert.equal(status?.args[1], `repos/blazejkustra/uncut/statuses/${head}`);
  assert.ok(status?.args.includes("context=mac-verify"));
  assert.ok(status?.args.includes("state=success"));
  const verifyArgs = JSON.parse(readFileSync(join(box.dir, "verify-args.json"), "utf8")) as Array<string>;
  assert.ok(verifyArgs[0]?.startsWith(box.paths.worktrees));
  assert.equal(verifyArgs[1], "--base");
  assert.match(verifyArgs[2] ?? "", /^[0-9a-f]{40}$/);
});

for (const exitCode of [1, 2, 7]) {
  withBox(`verify.ts exit ${exitCode} blocks a risky change`, async (box) => {
    box.writeVerify(exitCode);
    box.setScenario({ issues: [issue(1)], timelines: { 1: ownerTimeline }, ...RISKY_WRITE });
    const result = await runOnce(box.cfg);
    assert.equal(result.outcome, "blocked");
    assertBlocked(box, /stopped at verify/);
  });
}

withBox("a missing verify.ts blocks a risky change", async (box) => {
  box.setScenario({ issues: [issue(1)], timelines: { 1: ownerTimeline }, ...RISKY_WRITE });
  const result = await runOnce(box.cfg);
  assert.equal(result.outcome, "blocked");
  assertBlocked(box, /verify\.ts blocked this risky change \(missing\)/);
  assert.ok(!box.claudeSteps().includes("review"));
});

withBox("a missing verify.ts leaves other changes alone", async (box) => {
  assert.equal((await runOnce(box.cfg)).outcome, "pr-opened");
});

withBox("a published list overrides the fallback paths", async (box) => {
  writeFileSync(box.cfg.riskyPathsFile, JSON.stringify(["src/**"]));
  const result = await runOnce(box.cfg);
  assert.equal(result.outcome, "blocked");
  assertBlocked(box, /verify\.ts blocked/);
});

withBox("attribution in the plan summary stops the run before anything is pushed", async (box) => {
  const plan = { result: JSON.stringify({ summary: "Generated with Claude Code", plan: "x" }) };
  box.setScenario({ issues: [issue(1)], timelines: { 1: ownerTimeline }, replies: { plan: [plan] } });
  const result = await runOnce(box.cfg);
  assert.equal(result.outcome, "blocked");
  assertBlocked(box, /attribution text/);
});

withBox("an attribution trailer smuggled through the issue title never reaches a commit on the remote", async (box) => {
  box.setScenario({ issues: [issue(1, { title: "Fix Co-Authored-By: Claude please" })], timelines: { 1: ownerTimeline } });
  const result = await runOnce(box.cfg);
  assert.equal(result.outcome, "blocked");
  assertBlocked(box, /attribution text/);
});

withBox("a failed issue comment never hides the outcome", async (box) => {
  box.setScenario({ issues: [issue(1)], timelines: { 1: ownerTimeline }, gateFailures: { lint: 99 }, failGh: "issue comment" });
  const result = await runOnce(box.cfg);
  assert.equal(result.outcome, "blocked");
  const [entry] = readJsonl<{ runId: string }>(box.paths.ledger);
  const report = JSON.parse(readFileSync(join(box.paths.runs, entry?.runId ?? "", "report.json"), "utf8")) as { notes: Array<string> };
  assert.ok(report.notes.some((note) => note.includes("issue comment failed")));
  assert.equal(ghCalls(box, "issue edit").length, 1);
});

withBox("a blocked issue whose label swap failed waits for the owner to relabel it", async (box) => {
  box.setScenario({ issues: [issue(1)], timelines: { 1: ownerTimeline }, gateFailures: { lint: 99 }, failGh: "issue edit" });
  assert.equal((await runOnce(box.cfg)).outcome, "blocked");
  const stepsBefore = box.claudeSteps().length;
  assert.equal((await runOnce(box.cfg)).outcome, "idle");
  assert.equal(box.claudeSteps().length, stepsBefore);
  const relabelled = [{ ...ownerTimeline[0], created_at: "2099-01-01T00:00:00Z" }];
  box.setScenario({ issues: [issue(1)], timelines: { 1: relabelled } });
  assert.equal((await runOnce(box.cfg)).outcome, "pr-opened");
});

withBox("a failed comment after the PR exists still records the PR", async (box) => {
  box.setScenario({ issues: [issue(1)], timelines: { 1: ownerTimeline }, failGh: "issue comment" });
  const result = await runOnce(box.cfg);
  assert.equal(result.outcome, "pr-opened");
  assert.match(result.prUrl ?? "", /pull\/999/);
  assert.equal(ghCalls(box, "issue edit").length, 0);
});

withBox("STOP after the push records the branch, and the issue isn't redone", async (box) => {
  box.writeVerify(0);
  writeFileSync(box.cfg.riskyPathsFile, JSON.stringify(["src/**"]));
  box.setScenario({
    issues: [issue(1)],
    timelines: { 1: ownerTimeline },
    touchOnGh: { command: "api repos/blazejkustra/uncut/statuses", path: box.paths.stop },
  });
  assert.equal((await runOnce(box.cfg)).outcome, "stopped");
  const [entry] = readJsonl<{ branch: string }>(box.paths.ledger);
  assert.equal(entry?.branch, "factory/1-fix-the-thing-1");
  rmSync(box.paths.stop);
  assert.equal((await runOnce(box.cfg)).outcome, "idle");
});

withBox("a failed PR create names the pushed branch", async (box) => {
  box.setScenario({ issues: [issue(1)], timelines: { 1: ownerTimeline }, failGh: "pr create" });
  assert.equal((await runOnce(box.cfg)).outcome, "blocked");
  assert.match(ghCalls(box, "issue comment")[0]?.stdin ?? "", /Branch factory\/1-fix-the-thing-1 is on the remote/);
});

withBox("a non-ASCII path can't slip past the forbidden paths", async (box) => {
  box.setScenario({
    issues: [issue(1)],
    timelines: { 1: ownerTimeline },
    replies: { implement: [{ result: "done", writes: { ".github/workflows/\u00e9.yml": "on: push\n" } }] },
  });
  assert.equal((await runOnce(box.cfg)).outcome, "blocked");
  assertBlocked(box, /paths the factory may not publish/);
});

withBox("a non-ASCII risky path still needs verify.ts", async (box) => {
  box.setScenario({
    issues: [issue(1)],
    timelines: { 1: ownerTimeline },
    replies: { implement: [{ result: "done", writes: { "native/\u00e9.rs": "fn x() {}\n" } }] },
  });
  assert.equal((await runOnce(box.cfg)).outcome, "blocked");
  assertBlocked(box, /verify\.ts blocked/);
});

withBox("worktree git runs without owner credentials, and a swapped .git can't reach the push", async (box) => {
  const hooked = join(box.dir, "owner-saw-it");
  const script = join(box.dir, "gpg.sh");
  writeFileSync(script, `#!/bin/sh\n[ -n "$GH_TOKEN" ] && touch ${hooked}\nexit 1\n`, { mode: 0o755 });
  const fakeGit = join(box.dir, "fake-gitdir");
  execFileSync("git", ["init", "-q", fakeGit]);
  writeFileSync(join(fakeGit, ".git/config"), `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${script}\n`);
  const cfg = { ...box.cfg, env: { ...box.cfg.env, GH_TOKEN: "owner" } };
  box.setScenario({
    issues: [issue(1)],
    timelines: { 1: ownerTimeline },
    replies: { implement: [{ result: "done", writes: { "src/a.ts": "1\n", ".git": `gitdir: ${fakeGit}/.git\n` } }] },
  });
  assert.equal((await runOnce(cfg)).outcome, "blocked");
  assert.ok(!existsSync(hooked));
  assert.deepEqual(box.remoteBranches(), ["main"]);
  assert.deepEqual(readdirSync(box.paths.worktrees), []);
});

withBox("a repository config changed during the run stops the push", async (box) => {
  const config = join(box.repoDir, ".git/config");
  box.setScenario({
    issues: [issue(1)],
    timelines: { 1: ownerTimeline },
    replies: { implement: [{ result: "done", writes: { "src/a.ts": "1\n" }, append: { path: config, text: "[core]\n\tsshCommand = /tmp/evil\n" } }] },
  });
  assert.equal((await runOnce(box.cfg)).outcome, "blocked");
  assertBlocked(box, /git config changed/);
});

withBox("a diff over the limit is never reviewed in part", async (box) => {
  const big = "x".repeat(210_000);
  box.setScenario({ issues: [issue(1)], timelines: { 1: ownerTimeline }, replies: { implement: [{ result: "done", writes: { "src/big.ts": big } }] } });
  assert.equal((await runOnce(box.cfg)).outcome, "blocked");
  assert.ok(!box.claudeSteps().includes("review"));
  assertBlocked(box, /too large/);
});

withBox("leftover worktrees are swept at the start of a run", async (box) => {
  mkdirSync(join(box.paths.worktrees, "old-run"), { recursive: true });
  await runOnce(box.cfg);
  assert.deepEqual(readdirSync(box.paths.worktrees), []);
});
