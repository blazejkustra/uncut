// Stands in for `claude`, `gh` and `pnpm` in the factory tests. Child env is scrubbed, so the
// sandbox dir arrives as an argument from the shell wrapper factory-sandbox.ts writes.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [kind, sandbox, ...args] = process.argv.slice(2) as [string, string, ...Array<string>];

interface FakeAgentReply {
  result?: string;
  isError?: boolean;
  subtype?: string;
  exit?: number;
  writes?: Record<string, string>;
  touch?: string;
}

interface Scenario {
  issues?: Array<unknown>;
  timelines?: Record<string, unknown>;
  replies?: Record<string, Array<FakeAgentReply>>;
  gateFailures?: Record<string, number>;
  failGh?: string;
}

const scenario = JSON.parse(readFileSync(join(sandbox, "scenario.json"), "utf8")) as Scenario;
const stdin = readFileSync(0, "utf8");
appendFileSync(join(sandbox, "calls.jsonl"), `${JSON.stringify({ kind, args, stdin, env: process.env, cwd: process.cwd() })}\n`);

function nextCount(key: string) {
  const file = join(sandbox, "counters.json");
  const counters = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}) as Record<string, number>;
  const count = counters[key] ?? 0;
  writeFileSync(file, JSON.stringify({ ...counters, [key]: count + 1 }));
  return count;
}

const DEFAULT_REPLIES: Record<string, FakeAgentReply> = {
  plan: { result: JSON.stringify({ summary: "Adds a small helper with a test.", plan: "write it", doneChecks: ["pnpm test:fast"] }) },
  implement: { result: "done", writes: { "src/change.ts": "export const change = 1;\n" } },
  fix: { result: "fixed" },
  review: { result: JSON.stringify({ verdict: "pass", findings: [] }) },
  triage: { result: JSON.stringify({ summary: "A clear small bug.", labels: ["bug", "factory"], readiness: "ready" }) },
};

function fakeClaude() {
  const stepName = /^Factory step: (\w+)/.exec(stdin)?.[1] ?? "unknown";
  const queue = scenario.replies?.[stepName] ?? [];
  const reply = queue[nextCount(stepName)] ?? DEFAULT_REPLIES[stepName] ?? {};
  for (const [path, content] of Object.entries(reply.writes ?? {})) {
    mkdirSync(dirname(join(process.cwd(), path)), { recursive: true });
    writeFileSync(join(process.cwd(), path), content);
  }
  if (reply.touch !== undefined) writeFileSync(reply.touch, "");
  const isError = reply.isError ?? false;
  console.log(JSON.stringify({ type: "result", subtype: reply.subtype ?? "success", is_error: isError, result: reply.result ?? "", num_turns: 3 }));
  process.exit(reply.exit ?? 0);
}

function fakeGh() {
  const command = args.slice(0, 2).join(" ");
  if (scenario.failGh === command) {
    console.error("fake gh failure");
    process.exit(1);
  }
  if (command === "issue list") console.log(JSON.stringify(scenario.issues ?? []));
  else if (command === "pr create") console.log("https://github.com/blazejkustra/uncut/pull/999");
  else if (args[0] === "api" && args[1]?.includes("/timeline")) {
    const number = /issues\/(\d+)\//.exec(args[1])?.[1] ?? "";
    console.log(JSON.stringify([scenario.timelines?.[number] ?? []]));
  }
}

function fakePnpm() {
  const name = args[0] ?? "";
  const failures = scenario.gateFailures?.[name] ?? 0;
  if (nextCount(`gate ${name}`) < failures) {
    console.log(`${name} failed: fake error`);
    process.exit(1);
  }
}

if (kind === "claude") fakeClaude();
else if (kind === "gh") fakeGh();
else fakePnpm();
