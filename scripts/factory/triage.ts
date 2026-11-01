import { BLOCKED_LABEL, FACTORY_LABEL, defaultConfig, factoryPaths, type FactoryConfig } from "./config.ts";
import { NO_TOOLS, runAgent } from "./claude.ts";
import { prepareIsolation } from "./env.ts";
import { Escalation, Halt } from "./errors.ts";
import { commentOnIssue, listOpenIssues, type Issue } from "./github.ts";
import { startRefusal } from "./orchestrator.ts";
import { assertNoAttribution } from "./pr.ts";
import { triagePrompt } from "./prompts.ts";
import { newRunContext, step, type RunContext } from "./run-context.ts";
import { acquireLock, appendJsonl, readJsonl, releaseLock } from "./state.ts";
import { parseJsonObject, plainLine } from "./text.ts";

const SUGGESTABLE_LABELS: ReadonlySet<string> = new Set(["bug", "enhancement", "documentation", "question"]);
const MAX_SUMMARY_CHARS = 500;

interface TriageEntry {
  readonly issue: number;
}

export interface TriageResult {
  readonly outcome: string;
  readonly detail?: string;
  readonly commented: ReadonlyArray<number>;
}

export function triageComment(answer: string) {
  const draft = parseJsonObject(answer);
  if (typeof draft?.summary !== "string") return undefined;
  const labels = Array.isArray(draft.labels) ? draft.labels.filter((label) => SUGGESTABLE_LABELS.has(String(label))) : [];
  const readiness = draft.readiness === "ready" ? "ready" : "needs more information";
  const suggestion = labels.length > 0 ? labels.join(", ") : "none";
  return [
    `Triage draft, read from the issue text alone: ${plainLine(draft.summary, MAX_SUMMARY_CHARS)}`,
    `Readiness: ${readiness}. Suggested labels: ${suggestion}.`,
  ].join("\n\n");
}

async function triageOne(ctx: RunContext, issue: Issue) {
  const answer = await step(ctx, `triage ${issue.number}`, () =>
    runAgent(ctx, { name: "triage", prompt: triagePrompt(issue), profile: NO_TOOLS, cwd: ctx.runDir }),
  );
  const comment = triageComment(answer);
  if (comment === undefined) return false;
  assertNoAttribution("triage", comment);
  await step(ctx, `comment ${issue.number}`, () => commentOnIssue({ bin: ctx.cfg.ghBin, env: ctx.cfg.env }, issue.number, comment));
  appendJsonl(ctx.paths.triageLedger, { issue: issue.number, at: new Date().toISOString() });
  return true;
}

function needsTriage(issue: Issue, done: ReadonlySet<number>) {
  const handled = issue.labels.some((label) => label.name === FACTORY_LABEL || label.name === BLOCKED_LABEL);
  return !handled && !done.has(issue.number);
}

async function triageOpenIssues(ctx: RunContext) {
  const done = new Set(readJsonl<TriageEntry>(ctx.paths.triageLedger).map((entry) => entry.issue));
  const issues = await step(ctx, "list issues", () => listOpenIssues({ bin: ctx.cfg.ghBin, env: ctx.cfg.env }));
  const queue = issues.filter((issue) => needsTriage(issue, done)).slice(0, ctx.cfg.triageLimit);
  const commented: Array<number> = [];
  for (const issue of queue) {
    if (await triageOne(ctx, issue)) commented.push(issue.number);
  }
  return commented;
}

export async function runTriage(cfg: FactoryConfig): Promise<TriageResult> {
  const paths = factoryPaths(cfg.home);
  const refusal = startRefusal(cfg, paths);
  if (refusal !== undefined) return { ...refusal, commented: [] };
  if (!acquireLock(paths.lock)) return { outcome: "locked", commented: [] };
  try {
    const ctx = newRunContext(cfg, "triage");
    prepareIsolation(paths);
    return { outcome: "done", commented: await triageOpenIssues(ctx) };
  } catch (error) {
    if (error instanceof Halt) return { outcome: error.kind, commented: [] };
    if (error instanceof Escalation) return { outcome: "failed", detail: error.message, commented: [] };
    throw error;
  } finally {
    releaseLock(paths.lock);
  }
}

if (import.meta.main) {
  const result = await runTriage(defaultConfig());
  console.log(JSON.stringify(result));
  if (result.outcome === "refused") process.exitCode = 1;
}
