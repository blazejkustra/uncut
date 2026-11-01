// Measures Uncut's agent loop on this Mac with its Claude Code sign-in. Needs `pnpm build` once.
//
//   node scripts/benchmark.ts seeded [--runs 1] [--only overflow,blank] [--model id]
//       The stand-in plays a scripted builder for each film in scripts/benchmark/seeds.ts, and
//       review_submit runs for real: Uncut's renders and checks, then the real critic.
//       Reports how many planted defects the critic caught and what clean films got.
//   node scripts/benchmark.ts agent [--runs 1] [--model id]
//       The real builder makes each prompt below, critic loop included. Reports tool failures,
//       rounds to a pass and spend.
//
// Each run's raw record goes to test-output/benchmark/. --write merges the mode's summary into
// spec/agent/benchmark.json. Spend is what Claude Code reports: list price, also on a subscription.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { BEATS, BRIEF, filmHtml, REQUEST, SEEDS, type Seed } from "./benchmark/seeds.ts";
import { caught, matcherNoise, seededSummary, spend, type Round, type SeededRun, type Usage } from "./benchmark/score.ts";
import { connect, startServer } from "../test/helpers/server.ts";

const RESULTS = resolve("spec/agent/benchmark.json");
const OUTPUT = resolve("test-output/benchmark");
const ROUTER = resolve("scripts/benchmark/claude-router.ts");
const FAKE = resolve("test/helpers/fake-claude.ts");
const TURN_MS = 20 * 60_000;
const DEFAULT_MODEL = "claude-sonnet-5-5";

const AGENT_PROMPTS = [
  "Make a 6 second launch title film for a CLI tool called Tidepool that syncs databases. Graphics only, no footage. No statistics or customers. Don't ask me anything, decide yourself, and run the critic until it passes or stops.",
  "Make an 8 second 9:16 teaser for a coffee subscription called Second Pour. Graphics and text only, no footage, no sound. Don't ask me anything, decide yourself, and run the critic until it passes or stops.",
];

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: "string", default: "1" },
    only: { type: "string" },
    model: { type: "string", default: DEFAULT_MODEL },
    write: { type: "boolean", default: false },
  },
});
const mode = positionals[0];

type Turn = {
  id: string;
  status: string;
  error?: string;
  seconds?: number;
  items: Array<{ kind: string; tool?: string; status?: string; text: string; error?: string }>;
};

interface Workspace {
  readonly root: string;
  readonly usageLog: string;
  readonly plan: string;
  readonly client: Awaited<ReturnType<typeof connect>>;
  readonly dir: string;
  readonly waitFor: (id: string) => Promise<Turn>;
  readonly reviews: () => Array<Round>;
  readonly close: () => Promise<void>;
}

/** A fresh server on a fresh project, with its own data folder. */
async function workspace(realBuilder: boolean): Promise<Workspace> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-benchmark-")));
  mkdirSync(join(root, "projects"));
  const usageLog = join(root, "usage.jsonl");
  const plan = join(root, "plan.json");
  writeFileSync(usageLog, "");
  writeFileSync(plan, "[]");
  const server = await startServer({
    captureStderr: true,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_CLAUDE: ROUTER,
      UNCUT_APPROVAL_MS: "8000",
      UNCUT_CRITIC_MS: String(10 * 60_000),
      FAKE_PLAN: plan,
      BENCH_FAKE_CLAUDE: FAKE,
      BENCH_REAL_CLAUDE: execFileSync("which", ["claude"], { encoding: "utf8" }).trim(),
      BENCH_BUILDER: realBuilder ? "real" : "fake",
      BENCH_USAGE_LOG: usageLog,
    },
  });
  const client = await connect(server.ready.port, server.ready.token);
  const agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(root, "projects"), name: "Benchmark" });
  await agent.until((s) => s?.dir === snap.dir);
  const turnOf = (id: string): Turn | undefined => agent.values.at(-1)?.turns.find((t: Turn) => t.id === id);
  return {
    root,
    usageLog,
    plan,
    client,
    dir: snap.dir,
    waitFor: async (id) => {
      await agent.until(() => turnOf(id) !== undefined && turnOf(id)!.status !== "running", TURN_MS);
      return turnOf(id)!;
    },
    reviews: () => agent.values.at(-1)?.plan?.reviews ?? [],
    close: async () => {
      client.close();
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const usageOf = (w: Workspace): Array<Usage> =>
  readFileSync(w.usageLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Usage);

function record(name: string, value: unknown) {
  mkdirSync(OUTPUT, { recursive: true });
  appendFileSync(join(OUTPUT, name), `${JSON.stringify(value)}\n`);
}

const builderSteps = (seed: Seed) => [
  { tool: "brief_write", args: BRIEF },
  { tool: "storyboard_propose", args: { summary: "Promise, proof, call to action", beats: BEATS } },
  { tool: "graphic_write", args: { name: "film.html", html: filmHtml(seed) } },
  { tool: "project_read" },
  {
    tool: "timeline_edit",
    args: {
      baseRevision: "$rev",
      summary: "The film",
      ops: [
        { op: "add_track", track: { id: "film", kind: "video", name: "Film", items: [] }, index: 0 },
        { op: "insert_item", track: "film", item: { id: "film-1", type: "graphic", src: "graphics/film.html", start: 0, duration: 180 } },
      ],
    },
  },
  { tool: "review_submit", args: {} },
  { text: "Reviewed." },
];

async function seededRun(seed: Seed, model: string): Promise<SeededRun & { spend: ReturnType<typeof spend>; round: Round }> {
  const w = await workspace(false);
  try {
    writeFileSync(w.plan, JSON.stringify([builderSteps(seed)]));
    const { turnId } = await w.client.ok("agent.send", { prompt: REQUEST, access: "auto", model });
    const turn = await w.waitFor(turnId);
    const round = w.reviews()[0];
    if (!round) throw new Error(`${seed.id}: no review (${turn.status}: ${turn.error ?? JSON.stringify(turn.items.at(-1))})`);
    const hit = seed.defect ? caught(seed, round) : { blocker: false, listed: false };
    const run = {
      id: seed.id,
      seeded: Boolean(seed.defect),
      passed: round.passed,
      blockers: round.blockers?.length ?? 0,
      caughtAsBlocker: hit.blocker,
      caughtListed: hit.listed,
      spend: spend(usageOf(w)),
      round,
    };
    record("seeded.jsonl", { ...run, model });
    return run;
  } finally {
    await w.close();
  }
}

/** Steps on Uncut's own tools, their failures, and the timeline edits among them. */
function toolCounts(turn: Turn, known: ReadonlySet<string>) {
  const steps = turn.items.filter((i) => i.kind === "step" && i.tool && known.has(i.tool.replace(/^mcp__uncut__/, "")));
  const failed = steps.filter((i) => i.status === "error");
  const edits = steps.filter((i) => i.tool!.endsWith("timeline_edit"));
  return {
    calls: steps.length,
    failed: failed.length,
    edits: edits.length,
    editsFailed: edits.filter((i) => i.status === "error").length,
    failures: failed.map((i) => `${i.tool}: ${(i.error ?? "").slice(0, 160)}`),
  };
}

async function agentRun(prompt: string, model: string, known: ReadonlySet<string>) {
  const w = await workspace(true);
  try {
    const { turnId } = await w.client.ok("agent.send", { prompt, access: "auto", model });
    const turn = await w.waitFor(turnId);
    const rounds = w.reviews();
    const firstPass = rounds.findIndex((r) => r.passed);
    const results = usageOf(w);
    const run = {
      prompt,
      status: turn.status,
      seconds: turn.seconds ?? null,
      rounds: rounds.length,
      passedOnRound: firstPass < 0 ? null : firstPass + 1,
      tools: toolCounts(turn, known),
      builder: spend(results.filter((r) => !(r as { critic?: boolean }).critic)),
      critic: spend(results.filter((r) => (r as { critic?: boolean }).critic)),
      total: spend(results),
    };
    record("agent.jsonl", { ...run, model, error: turn.error });
    return run;
  } finally {
    await w.close();
  }
}

/** Sequential on purpose: runs share this Mac's usage limits, and each one renders. */
async function eachRun<T>(count: number, list: ReadonlyArray<T>, run: (item: T) => Promise<unknown>) {
  for (let n = 0; n < count; n++) for (const item of list) await run(item);
}

function publish(section: string, summary: unknown) {
  const existing = JSON.parse(readFileSync(RESULTS, "utf8")) as Record<string, unknown>;
  writeFileSync(RESULTS, `${JSON.stringify({ ...existing, [section]: summary }, null, 2)}\n`);
}

const sumSpend = (runs: ReadonlyArray<ReturnType<typeof spend>>) =>
  runs.reduce(
    (a, b) => ({
      costUsd: Math.round((a.costUsd + b.costUsd) * 10000) / 10000,
      inputTokens: a.inputTokens + b.inputTokens,
      cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
      cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
      outputTokens: a.outputTokens + b.outputTokens,
    }),
    spend([]),
  );

async function seededMode(model: string, runs: number) {
  const only = flags.only?.split(",");
  const seeds = SEEDS.filter((s) => !only || only.includes(s.id));
  const done: Array<Awaited<ReturnType<typeof seededRun>>> = [];
  await eachRun(runs, seeds, async (seed) => {
    const run = await seededRun(seed, model).catch(() => seededRun(seed, model));
    done.push(run);
    console.log(JSON.stringify({ ...run, round: undefined }));
  });
  const noise = matcherNoise(
    seeds,
    done.filter((r) => !r.seeded).map((r) => r.round),
  );
  const perCase = seeds.map((s) => {
    const mine = done.filter((r) => r.id === s.id);
    return {
      id: s.id,
      defect: s.defect ?? null,
      runs: mine.length,
      asBlocker: mine.filter((r) => r.caughtAsBlocker).length,
      listed: mine.filter((r) => r.caughtListed).length,
      passed: mine.filter((r) => r.passed).length,
    };
  });
  return {
    measuredOn: new Date().toISOString().slice(0, 10),
    model,
    ...seededSummary(done),
    matcherNoise: noise,
    perCase,
    spend: sumSpend(done.map((r) => r.spend)),
  };
}

async function agentMode(model: string, runs: number) {
  const known = new Set((JSON.parse(readFileSync("spec/agent/tools.json", "utf8")) as { tools: Array<{ name: string }> }).tools.map((t) => t.name));
  const done: Array<Awaited<ReturnType<typeof agentRun>>> = [];
  await eachRun(runs, AGENT_PROMPTS, async (prompt) => {
    const run = await agentRun(prompt, model, known);
    done.push(run);
    console.log(JSON.stringify(run));
  });
  const calls = done.reduce((n, r) => n + r.tools.calls, 0);
  const failed = done.reduce((n, r) => n + r.tools.failed, 0);
  const edits = done.reduce((n, r) => n + r.tools.edits, 0);
  const editsFailed = done.reduce((n, r) => n + r.tools.editsFailed, 0);
  return {
    measuredOn: new Date().toISOString().slice(0, 10),
    model,
    runs: done.length,
    toolCalls: calls,
    toolFailures: failed,
    toolFailureRate: calls ? Math.round((failed / calls) * 1000) / 1000 : null,
    timelineEdits: edits,
    timelineEditFailures: editsFailed,
    passed: done.filter((r) => r.passedOnRound !== null).length,
    roundsToPass: done.map((r) => r.passedOnRound),
    roundsRun: done.map((r) => r.rounds),
    seconds: done.map((r) => r.seconds),
    spend: { builder: sumSpend(done.map((r) => r.builder)), critic: sumSpend(done.map((r) => r.critic)), total: sumSpend(done.map((r) => r.total)) },
  };
}

async function main() {
  const runs = Number(flags.runs);
  const model = flags.model!;
  if (mode !== "seeded" && mode !== "agent") throw new Error("Usage: node scripts/benchmark.ts seeded|agent [--runs n] [--only ids] [--model id] [--write]");
  const summary = mode === "seeded" ? await seededMode(model, runs) : await agentMode(model, runs);
  console.log(JSON.stringify(summary, null, 2));
  if (flags.write) publish(mode, summary);
}

await main();
process.exit(0);
