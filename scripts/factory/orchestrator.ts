import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { BLOCKED_LABEL, FACTORY_LABEL, factoryPaths, type FactoryConfig, type FactoryPaths } from "./config.ts";
import { IMPLEMENTER, READ_ONLY, runAgent } from "./claude.ts";
import { apiAuthVarsIn, prepareIsolation } from "./env.ts";
import { Escalation, Halt } from "./errors.ts";
import { runGates, runSetup, type GateFailure } from "./gates.ts";
import {
  changedFiles,
  commitWork,
  copyPrivateDocs,
  createWorktree,
  fetchBase,
  forbiddenFiles,
  git,
  missingPrivateDocs,
  ownerScope,
  pushCommit,
  removeWorktree,
  repoConfigFingerprint,
  sweepWorktrees,
  worktreeScope,
  type GitScope,
} from "./git.ts";
import { commentOnIssue, listOpenIssues, openPullRequest, ownerLabelTime, postMacVerifySuccess, swapToBlocked, type GhClient, type Issue } from "./github.ts";
import { assertNoAttribution, buildPrBody, prBodyProblem } from "./pr.ts";
import { fixPrompt, implementPrompt, planPrompt, reviewPrompt } from "./prompts.ts";
import { newRunContext, step, type RunContext } from "./run-context.ts";
import { loadRiskyPaths, riskyFiles, runVerify, type VerifyReport } from "./risk.ts";
import { acquireLock, appendJsonl, isStopped, pausedUntil, readJsonl, releaseLock } from "./state.ts";
import { parseJsonObject, plainLine, slugOf, tail } from "./text.ts";

const MAX_DIFF_CHARS = 200_000;

export type RunOutcome = "refused" | "stopped" | "paused" | "locked" | "idle" | "pr-opened" | "blocked" | "usage-limit" | "failed";

export interface RunResult {
  readonly outcome: RunOutcome;
  readonly detail?: string;
  readonly issue?: number;
  readonly prUrl?: string;
}

export interface LedgerEntry extends RunResult {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly stage?: string;
  readonly branch?: string;
}

interface Plan {
  readonly summary: string;
  readonly text: string;
}

interface QualityResult {
  readonly head: string;
  readonly fixRounds: number;
  readonly risky: boolean;
  readonly verify: VerifyReport | undefined;
  readonly reviewer: string;
}

function ghClient(cfg: FactoryConfig): GhClient {
  return { bin: cfg.ghBin, env: cfg.env };
}

/** The checks both `factory:run` and `factory:triage` pass before doing anything. */
export function startRefusal(cfg: FactoryConfig, paths: FactoryPaths): RunResult | undefined {
  const authVars = apiAuthVarsIn(cfg.env);
  if (authVars.length > 0) return { outcome: "refused", detail: `the factory only runs on the subscription; unset ${authVars.join(", ")}` };
  if (isStopped(paths)) return { outcome: "stopped", detail: `${paths.stop} exists` };
  const until = pausedUntil(paths);
  if (until !== undefined) return { outcome: "paused", detail: `usage limit reached; paused until ${until.toISOString()}` };
  return undefined;
}

/** The label swap can fail, so the ledger also keeps a blocked issue out until the owner relabels it. */
function blockedSince(ledger: ReadonlyArray<LedgerEntry>, issue: number, labelledAt: string) {
  return ledger.some((entry) => entry.issue === issue && entry.outcome === "blocked" && entry.finishedAt > labelledAt);
}

async function pickIssue(ctx: RunContext) {
  const client = ghClient(ctx.cfg);
  const ledger = readJsonl<LedgerEntry>(ctx.paths.ledger);
  const published = new Set(ledger.filter((entry) => entry.branch !== undefined).map((entry) => entry.issue));
  const labelled = await listOpenIssues(client, FACTORY_LABEL);
  const candidates = labelled.filter((issue) => !published.has(issue.number) && !issue.labels.some((label) => label.name === BLOCKED_LABEL));
  for (const issue of candidates) {
    const labelledAt = await ownerLabelTime(client, issue.number, FACTORY_LABEL);
    if (labelledAt !== undefined && !blockedSince(ledger, issue.number, labelledAt)) return issue;
  }
  return undefined;
}

function parsePlan(text: string): Plan {
  const summary = parseJsonObject(text)?.summary;
  if (typeof summary !== "string" || summary.trim() === "") throw new Escalation("plan", "the plan had no usable summary");
  return { summary, text };
}

async function reviewVerdict(ctx: RunContext, scope: GitScope, issue: Issue, base: string, verification: string) {
  const diff = await git(scope, ["diff", `${base}..HEAD`]);
  if (diff.length > MAX_DIFF_CHARS) throw new Escalation("review", "the diff is too large to review whole");
  const answer = await runAgent(ctx, { name: "review", prompt: reviewPrompt(issue, diff, verification), profile: READ_ONLY, cwd: scope.cwd });
  const verdict = parseJsonObject(answer)?.verdict;
  return { passed: verdict === "pass", answer };
}

function verificationSummary(verify: VerifyReport | undefined, gates: ReadonlyArray<string>) {
  const gateLine = `Passed: ${gates.join(", ")}.`;
  return verify === undefined
    ? `${gateLine} No risky paths, so verify.ts did not run.`
    : `${gateLine} verify.ts: ${verify.outcome}.\n${tail(verify.output, 8000)}`;
}

function assertVerifyPassed(verify: VerifyReport) {
  if (verify.outcome !== "pass") throw new Escalation("verify", `verify.ts blocked this risky change (${verify.outcome})`);
}

async function commitAndCheck(scope: GitScope, issue: Issue, base: string) {
  await commitWork(scope, `Factory #${issue.number}: ${plainLine(issue.title, 72)}`);
  const files = await changedFiles(scope, base, "HEAD");
  if (files.length === 0) throw new Escalation("implement", "the agent changed nothing");
  if (forbiddenFiles(files).length > 0) throw new Escalation("implement", "the change touches paths the factory may not publish");
  return { files, head: await git(scope, ["rev-parse", "HEAD"]) };
}

interface Attempt {
  readonly problem?: { readonly stage: string; readonly text: string };
  readonly result?: Omit<QualityResult, "fixRounds">;
}

function gateProblem(failure: GateFailure): Attempt {
  return { problem: { stage: `gate ${failure.name}`, text: failure.output } };
}

async function attemptQuality(ctx: RunContext, scope: GitScope, issue: Issue, base: string, round: number): Promise<Attempt> {
  const worktree = scope.cwd;
  const failure = await runGates(ctx, worktree, round);
  if (failure !== undefined) return gateProblem(failure);
  const { files, head } = await step(ctx, `commit round ${round}`, () => commitAndCheck(scope, issue, base));
  const risky = riskyFiles(files, loadRiskyPaths(ctx.cfg.riskyPathsFile)).length > 0;
  const verify = risky ? await step(ctx, `verify round ${round}`, () => runVerify(ctx, worktree, base)) : undefined;
  if (verify !== undefined) assertVerifyPassed(verify);
  const summary = verificationSummary(
    verify,
    ctx.cfg.gates.map((gate) => gate.name),
  );
  const review = await step(ctx, `review round ${round}`, () => reviewVerdict(ctx, scope, issue, base, summary));
  if (!review.passed) return { problem: { stage: "review", text: review.answer } };
  return { result: { head, risky, verify, reviewer: "passed" } };
}

async function qualityLoop(ctx: RunContext, scope: GitScope, issue: Issue, base: string, plan: Plan): Promise<QualityResult> {
  const { maxFixRounds } = ctx.cfg;
  for (let round = 0; round <= maxFixRounds; round += 1) {
    const { problem, result } = await attemptQuality(ctx, scope, issue, base, round);
    if (result !== undefined) return { ...result, fixRounds: round };
    if (problem === undefined) break;
    if (round === maxFixRounds) throw new Escalation(problem.stage, `still failing after ${maxFixRounds} fix rounds`);
    await step(ctx, `fix round ${round + 1}`, () =>
      runAgent(ctx, { name: "fix", prompt: fixPrompt(issue, plan.text, problem.stage, problem.text), profile: IMPLEMENTER, cwd: scope.cwd }),
    );
  }
  throw new Escalation("quality", "the quality loop ended without a result");
}

interface Published {
  readonly issue: Issue;
  readonly base: string;
  readonly plan: Plan;
  readonly quality: QualityResult;
  readonly repoConfig: string;
}

/** Checks the commit itself from the owner's checkout: the worktree's git can't be trusted to report it. */
async function assertPublishable(ctx: RunContext, work: Published, prTitle: string, prBody: string) {
  const { base, quality, repoConfig } = work;
  if ((await repoConfigFingerprint(ctx.cfg)) !== repoConfig) throw new Escalation("publish", "the repository's git config changed during the run");
  const owner = ownerScope(ctx.cfg);
  if (forbiddenFiles(await changedFiles(owner, base, quality.head)).length > 0)
    throw new Escalation("publish", "the change touches paths the factory may not publish");
  const messages = await git(owner, ["log", "--format=%an %ae%n%B", `${base}..${quality.head}`]);
  assertNoAttribution("publish", [messages, prTitle, prBody].join("\n"));
  const bodyProblem = prBodyProblem(prBody);
  if (bodyProblem !== undefined) throw new Escalation("publish", `the pull request body was rejected: ${bodyProblem}`);
}

function verifyEvidence(quality: QualityResult) {
  return quality.risky ? "verify.ts passed" : "not needed, no risky paths changed";
}

async function publish(ctx: RunContext, work: Published) {
  const { issue, plan, quality } = work;
  const client = ghClient(ctx.cfg);
  const branch = `factory/${issue.number}-${slugOf(issue.title)}`;
  const prBody = buildPrBody({
    issue: issue.number,
    title: issue.title,
    summary: plan.summary,
    gates: ctx.cfg.gates.map((gate) => gate.args.join(" ")),
    fixRounds: quality.fixRounds,
    verify: verifyEvidence(quality),
    reviewer: quality.reviewer,
  });
  const prTitle = `Factory #${issue.number}: ${plainLine(issue.title, 72)}`;
  await step(ctx, "check before publishing", () => assertPublishable(ctx, work, prTitle, prBody));
  await step(ctx, "push", () => pushCommit(ctx.cfg, quality.head, branch));
  ctx.branch = branch;
  if (quality.risky) await step(ctx, "post mac-verify", () => postMacVerifySuccess(client, quality.head));
  ctx.prUrl = await step(ctx, "open pull request", () => openPullRequest(client, branch, prTitle, prBody));
  await step(ctx, "comment on issue", () => commentOnIssue(client, issue.number, `The factory opened ${ctx.prUrl} for review. Merging stays with the owner.`));
}

async function workOnIssue(ctx: RunContext, worktree: string, issue: Issue, base: string) {
  const { cfg, paths } = ctx;
  const repoConfig = await repoConfigFingerprint(cfg);
  await step(ctx, "create worktree", () => createWorktree(cfg, worktree, base));
  const scope = await worktreeScope(cfg, paths, worktree);
  await step(ctx, "copy private docs", () => copyPrivateDocs(cfg, scope));
  await runSetup(ctx, worktree);
  const planText = await step(ctx, "plan", () => runAgent(ctx, { name: "plan", prompt: planPrompt(issue), profile: READ_ONLY, cwd: worktree }));
  const plan = parsePlan(planText);
  await step(ctx, "implement", () => runAgent(ctx, { name: "implement", prompt: implementPrompt(issue, plan.text), profile: IMPLEMENTER, cwd: worktree }));
  const quality = await qualityLoop(ctx, scope, issue, base, plan);
  await publish(ctx, { issue, base, plan, quality, repoConfig });
}

function failureOf(error: unknown) {
  if (error instanceof Escalation) return { stage: error.stage, reason: error.message };
  return { stage: "internal", reason: "an unexpected error ended the run" };
}

async function attempt(work: () => Promise<void>) {
  try {
    await work();
    return [];
  } catch (error) {
    return [String(error)];
  }
}

function blockedComment(ctx: RunContext, stage: string, reason: string) {
  const pushed = ctx.branch === undefined ? "" : ` Branch ${ctx.branch} is on the remote.`;
  return `The factory stopped at ${stage}: ${reason}. Run ${ctx.runId}.${pushed}`;
}

async function reportBlocked(ctx: RunContext, issue: Issue, stage: string, reason: string) {
  if (isStopped(ctx.paths)) return ["STOP exists, so the issue was left untouched"];
  const client = ghClient(ctx.cfg);
  const commentProblems = await attempt(() => commentOnIssue(client, issue.number, blockedComment(ctx, stage, reason)));
  const swapProblems = await attempt(() => swapToBlocked(client, issue.number));
  return [...commentProblems, ...swapProblems];
}

interface Finished {
  readonly result: RunResult;
  readonly stage?: string;
  readonly notes: ReadonlyArray<string>;
}

async function settleIssue(ctx: RunContext, worktree: string, issue: Issue, base: string): Promise<Finished> {
  const prOpened = (notes: ReadonlyArray<string>): Finished => ({ result: { outcome: "pr-opened", issue: issue.number, prUrl: ctx.prUrl }, notes });
  try {
    await workOnIssue(ctx, worktree, issue, base);
    return prOpened([]);
  } catch (error) {
    if (ctx.prUrl !== undefined) return prOpened([String(error)]);
    if (error instanceof Halt) return { result: { outcome: error.kind, issue: issue.number }, notes: [] };
    const { stage, reason } = failureOf(error);
    const notifyProblems = await reportBlocked(ctx, issue, stage, reason);
    return { result: { outcome: "blocked", issue: issue.number, detail: reason }, stage, notes: [String(error), ...notifyProblems] };
  }
}

function recordRun(ctx: RunContext, startedAt: string, finished: Finished) {
  const entry: LedgerEntry = {
    ...finished.result,
    runId: ctx.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    stage: finished.stage,
    branch: ctx.branch,
  };
  appendJsonl(ctx.paths.ledger, entry);
  writeFileSync(join(ctx.runDir, "report.json"), `${JSON.stringify({ ...entry, notes: finished.notes, steps: ctx.steps }, null, 2)}\n`);
}

async function pickAndWork(ctx: RunContext): Promise<Finished> {
  const base = await step(ctx, "fetch origin", () => fetchBase(ctx.cfg));
  const issue = await step(ctx, "pick issue", () => pickIssue(ctx));
  if (issue === undefined) return { result: { outcome: "idle" }, notes: [] };
  const worktree = join(ctx.paths.worktrees, ctx.runId);
  const finished = await settleIssue(ctx, worktree, issue, base);
  const cleanupProblems = await attempt(() => removeWorktree(ctx.cfg, worktree));
  return { ...finished, notes: [...finished.notes, ...cleanupProblems] };
}

function unassignedFailure(error: unknown): Finished {
  if (error instanceof Halt) return { result: { outcome: error.kind }, notes: [] };
  return { result: { outcome: "failed", detail: failureOf(error).reason }, notes: [String(error)] };
}

async function runLocked(cfg: FactoryConfig): Promise<RunResult> {
  const ctx = newRunContext(cfg, "run");
  const startedAt = new Date().toISOString();
  prepareIsolation(ctx.paths);
  await sweepWorktrees(cfg, ctx.paths.worktrees);
  const finished = await pickAndWork(ctx).catch(unassignedFailure);
  recordRun(ctx, startedAt, finished);
  return finished.result;
}

export async function runOnce(cfg: FactoryConfig): Promise<RunResult> {
  const paths = factoryPaths(cfg.home);
  const refusal = startRefusal(cfg, paths);
  if (refusal !== undefined) return refusal;
  const missing = missingPrivateDocs(cfg);
  if (missing.length > 0) return { outcome: "refused", detail: `${cfg.repoDir} has no ${missing.join(", ")}; run the factory from the main checkout` };
  if (!acquireLock(paths.lock)) return { outcome: "locked" };
  try {
    return await runLocked(cfg);
  } finally {
    releaseLock(paths.lock);
  }
}
