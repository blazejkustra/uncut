import { BLOCKED_LABEL, FACTORY_LABEL, MAC_VERIFY_CONTEXT, OWNER, REPO_SLUG } from "./config.ts";
import { runChild } from "./process.ts";

const GH_TIMEOUT_MS = 120_000;

export interface GhClient {
  readonly bin: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly createdAt: string;
  readonly labels: ReadonlyArray<{ readonly name: string }>;
}

export interface TimelineEvent {
  readonly event?: string;
  readonly created_at?: string;
  readonly actor?: { readonly login?: string } | null;
  readonly label?: { readonly name?: string };
}

const TIMELINE_PATH = new RegExp(`^repos/${REPO_SLUG}/issues/\\d+/timeline\\?per_page=100$`);
const STATUS_PATH = new RegExp(`^repos/${REPO_SLUG}/statuses/[0-9a-f]{40}$`);

function isAllowedLabelEdit(args: ReadonlyArray<string>) {
  const [, , number, ...rest] = args;
  const expected = ["--repo", REPO_SLUG, "--add-label", BLOCKED_LABEL, "--remove-label", FACTORY_LABEL];
  return /^\d+$/.test(number ?? "") && rest.length === expected.length && rest.every((value, i) => value === expected[i]);
}

function isAllowedApiCall(args: ReadonlyArray<string>) {
  const path = args[1] ?? "";
  if (TIMELINE_PATH.test(path)) return args.length === 4 && args[2] === "--paginate" && args[3] === "--slurp";
  return STATUS_PATH.test(path) && args[2] === "--method" && args[3] === "POST" && args.includes(`context=${MAC_VERIFY_CONTEXT}`);
}

/** Every gh call the factory can make. There is deliberately no merge shape here. */
export function isAllowedGhCall(args: ReadonlyArray<string>) {
  const command = args.slice(0, 2).join(" ");
  if (command === "issue list" || command === "issue comment" || command === "pr create") return true;
  if (command === "issue edit") return isAllowedLabelEdit(args);
  return args[0] === "api" && isAllowedApiCall(args);
}

async function gh(client: GhClient, args: ReadonlyArray<string>, stdin?: string) {
  if (!isAllowedGhCall(args)) throw new Error(`gh call refused: ${args.slice(0, 2).join(" ")}`);
  const result = await runChild(client.bin, args, { env: client.env, stdin, timeoutMs: GH_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr.slice(-500)}`);
  return result.stdout;
}

export async function listOpenIssues(client: GhClient, label?: string) {
  const labelArgs = label === undefined ? [] : ["--label", label];
  const stdout = await gh(client, [
    "issue",
    "list",
    "--repo",
    REPO_SLUG,
    "--state",
    "open",
    ...labelArgs,
    "--limit",
    "200",
    "--json",
    "number,title,body,createdAt,labels",
  ]);
  const issues = JSON.parse(stdout) as Array<Issue>;
  return issues.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The newest application decides: an older approval doesn't survive a relabel by someone else. */
export function lastLabelEvent(events: ReadonlyArray<TimelineEvent>, label: string) {
  const applied = events.filter((event) => event.event === "labeled" && event.label?.name === label);
  const newestLast = applied.toSorted((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  return newestLast.at(-1);
}

async function issueTimeline(client: GhClient, issue: number) {
  const stdout = await gh(client, ["api", `repos/${REPO_SLUG}/issues/${issue}/timeline?per_page=100`, "--paginate", "--slurp"]);
  return (JSON.parse(stdout) as Array<Array<TimelineEvent>>).flat();
}

export async function ownerLabelTime(client: GhClient, issue: number, label: string) {
  const event = lastLabelEvent(await issueTimeline(client, issue), label);
  return event?.actor?.login === OWNER ? (event.created_at ?? "") : undefined;
}

export async function commentOnIssue(client: GhClient, issue: number, body: string) {
  await gh(client, ["issue", "comment", String(issue), "--repo", REPO_SLUG, "--body-file", "-"], body);
}

export async function swapToBlocked(client: GhClient, issue: number) {
  await gh(client, ["issue", "edit", String(issue), "--repo", REPO_SLUG, "--add-label", BLOCKED_LABEL, "--remove-label", FACTORY_LABEL]);
}

export async function postMacVerifySuccess(client: GhClient, sha: string) {
  await gh(client, [
    "api",
    `repos/${REPO_SLUG}/statuses/${sha}`,
    "--method",
    "POST",
    "-f",
    "state=success",
    "-f",
    `context=${MAC_VERIFY_CONTEXT}`,
    "-f",
    "description=verify.ts passed on the Mac",
  ]);
}

export async function openPullRequest(client: GhClient, branch: string, title: string, body: string) {
  const stdout = await gh(client, ["pr", "create", "--repo", REPO_SLUG, "--base", "main", "--head", branch, "--title", title, "--body-file", "-"], body);
  return stdout.trim();
}
