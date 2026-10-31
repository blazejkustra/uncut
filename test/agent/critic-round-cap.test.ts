// The review ceiling (3 rounds, 1 on an @time fix) and what it owes the user: a capped film never
// reads as passed, its open blockers reach the result, the builder's instructions and the critic
// row; the critic's usage reaches the log and the review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Review } from "../../packages/contracts/src/index.ts";
import {
  criticReview,
  criticUsage,
  criticUsageLine,
  noMoreRounds,
  openBlockers,
  parseCritic,
  reviewNext,
  reviewOutlook,
  REVIEW_ROUNDS,
  REVIEW_ROUNDS_FIX,
  roundLimit,
  roundLimitLine,
  runCritic,
} from "../../apps/server/src/agent/agentCritic.ts";
import { pointsAtTime, reviewCeiling } from "../../apps/server/src/agent/agentPlan.ts";
import { criticRow } from "../../apps/server/src/agent/tools/criticRow.ts";
import type { Running } from "../../apps/server/src/agent/session/types.ts";

const ev = (score: number) => ({ score, evidence: "f 0, f 30: fine" });
const all = (n: number) => ({ hook: ev(n), readability: ev(n), motion: ev(n), variety: ev(n), sound: ev(n), brand: ev(n) });
const ctx = {
  round: 1,
  claims: [],
  checks: [],
  determinism: { checked: [], differed: [] },
  looked: { sheet: true, phone: true },
  revision: 4,
  turnId: "t1",
  fps: 30,
};
const judged = (answer: unknown, extra = {}) => criticReview(parseCritic(JSON.stringify(answer)) as never, { ...ctx, ...extra });
const failed = () => judged({ scores: all(9), blockers: [{ kind: "blank", what: "Empty frame", at: 4.2 }] });

test("reviewCeiling: 1 on a message pointing at a moment, else 3", () => {
  assert.equal(REVIEW_ROUNDS, 3);
  assert.equal(REVIEW_ROUNDS_FIX, 1);
  for (const yes of ["@0:05.7 this is off", "move it @1:02 please", "@0:05.0–0:07.5 too fast"]) {
    assert.equal(pointsAtTime(yes), true, yes);
    assert.equal(reviewCeiling(yes), 1, yes);
  }
  for (const no of ["Make a 30 s promo", "mail me@1:02", "@Graphic panel-6.html the text is wrong", "at 0:05 it is off"]) {
    assert.equal(pointsAtTime(no), false, no);
    assert.equal(reviewCeiling(no), 3, no);
  }
});

test("reviewOutlook: a fix turn's one round is the cap, a pass at the cap isn't capped", () => {
  const blocked = { passed: false, blockers: [{ at: 1 }] };
  assert.deepEqual(reviewOutlook([], 0, undefined, 1).more, true, "the first round always runs");
  assert.deepEqual(reviewOutlook([blocked], 1, undefined, 1), { more: false, capped: true, why: "round 1 of at most 1: 1 round is the cap" });
  assert.deepEqual(reviewOutlook([{ passed: true }], 1, undefined, 1), { more: false, why: "round 1 of at most 1: it passed" });
  assert.equal(reviewOutlook([{ passed: true }], 2, undefined, 1).capped, true, "a later round wasn't saved: its verdict is unknown, so not a pass");
});

test("the cap on a failed round: the result lists the blockers, says it hasn't passed and tells the agent to say so", () => {
  const review = failed();
  const outlook = reviewOutlook([review], 1, undefined, 1);
  const limit = roundLimit(review, outlook, 1)!;
  assert.equal(review.passed, false, "the cap never touches the verdict");
  assert.deepEqual({ hit: limit.hit, rounds: limit.rounds, passed: limit.passed }, { hit: true, rounds: 1, passed: false });
  assert.deepEqual(limit.openBlockers, ["d1 blank at 4.2 s: Empty frame"]);
  assert.match(limit.tell, /has not passed[^]*final reply/);
  const next = reviewNext(review, 1, outlook);
  assert.match(next, /stop fixing/);
  assert.match(next, /In your final reply[^]*stopped at the round limit[^]*d1 blank at 4\.2 s/);
  assert.match(next, /Don't say it passed/);
});

test("the cap lists unresolved blockers too, and words a film with none left", () => {
  const unresolved = { ...failed(), blockers: failed().blockers!.map((b) => ({ ...b, unresolved: true })) };
  assert.deepEqual(roundLimit(unresolved, reviewOutlook([unresolved], 3), 3)!.openBlockers, ["d1 blank at 4.2 s: Empty frame"]);
  const low = judged({ scores: { ...all(8), motion: ev(7) } });
  assert.equal(low.passed, false);
  assert.deepEqual(roundLimit(low, reviewOutlook([low], 3), 3)!.openBlockers, []);
  assert.equal(roundLimitLine(low), "Round limit reached, not passed: scores still under the bar.");
  assert.equal(roundLimitLine(failed()), "Round limit reached, not passed: 1 blocker still open.");
  assert.deepEqual(openBlockers({}), []);
});

test("the refusal of another round: a pass says so, a failed film names what is open", () => {
  const passed = noMoreRounds("round 3 of at most 3: it passed", { passed: true });
  assert.match(passed, /critic passed it/);
  assert.doesNotMatch(passed, /still found|stop fixing/);
  assert.match(noMoreRounds("cap", failed()), /what the critic still found: d1 blank at 4\.2 s: Empty frame\.$/);
  assert.match(noMoreRounds("cap", undefined), /what the critic still found\.$/);
});

test("no notice without the cap: a pass, or a round that may go on or stopped for another reason", () => {
  const passed = judged({ scores: all(9) });
  assert.equal(passed.passed, true);
  assert.equal(roundLimit(passed, reviewOutlook([passed], 3), 3), undefined);
  const review = failed();
  assert.equal(roundLimit(review, reviewOutlook([review], 1), 1), undefined);
  const same = reviewOutlook([review, review], 2);
  assert.equal(same.more, false);
  assert.equal(roundLimit(review, same, 2), undefined);
});

test("the critic row leads with the limit, keeps the review's status and notes", () => {
  const turn = { items: [] as Array<{ card?: { critic?: { line: string; status: string } } }> };
  const row = criticRow(
    { turn, cancelled: false } as unknown as Running,
    2,
    () => {},
    () => {},
  );
  const review: Review = { ...failed(), notes: "1 blocker (blank)." };
  row.done(review, roundLimitLine(review));
  const critic = turn.items[0]!.card!.critic!;
  assert.equal(critic.status, "failed");
  assert.equal(critic.line, "Round limit reached, not passed: 1 blocker still open. 1 blocker (blank).");
});

const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.41235,
  duration_ms: 61200,
  usage: { input_tokens: 12, cache_read_input_tokens: 3000, cache_creation_input_tokens: 45000, output_tokens: 900 },
  modelUsage: { "claude-opus-5-5": {} },
};

test("criticUsage and its log line: claude's figures, and an honest line without them", () => {
  const usage = criticUsage(RESULT, "opus");
  assert.deepEqual(usage, {
    costUsd: 0.41235,
    inputTokens: 12,
    cacheReadTokens: 3000,
    cacheWriteTokens: 45000,
    outputTokens: 900,
    ms: 61200,
    model: "claude-opus-5-5",
  });
  assert.equal(criticUsageLine(2, usage), "[uncut] critic round 2: $0.4123, 12 in, 3000 cache read, 45000 cache write, 900 out, 61.2 s, claude-opus-5-5");
  const bare = criticUsage({}, undefined);
  assert.deepEqual(bare, { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  assert.equal(criticUsageLine(1, bare), "[uncut] critic round 1: cost unknown, 0 in, 0 cache read, 0 cache write, 0 out");
});

test("criticReview keeps the usage on the review; none when the run gave none", () => {
  const usage = criticUsage(RESULT, undefined);
  assert.deepEqual(judged({ scores: all(9) }, { usage }).usage, usage);
  assert.equal("usage" in judged({ scores: all(9) }), false);
});

function fakeClaude(dir: string, result: unknown) {
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '${JSON.stringify(result)}'\nsleep 5\n`);
  chmodSync(bin, 0o755);
  return bin;
}

async function logged<T>(run: () => Promise<T>) {
  const lines: Array<string> = [];
  const real = console.error;
  console.error = (line: string) => void lines.push(line);
  try {
    return { lines, out: await run().catch((e: Error) => e) };
  } finally {
    console.error = real;
  }
}

test("runCritic logs the usage and returns it; a failed run is logged too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-critic-usage-"));
  const run = (result: unknown) => () =>
    runCritic({
      bin: fakeClaude(dir, result),
      env: { PATH: process.env.PATH! },
      model: undefined,
      message: {},
      signal: new AbortController().signal,
      round: 3,
    });
  try {
    const good = await logged(run({ ...RESULT, result: "{}" }));
    assert.equal((good.out as { text: string }).text, "{}");
    assert.equal((good.out as { usage: { costUsd: number } }).usage.costUsd, 0.41235);
    assert.ok(good.lines.some((l) => l.startsWith("[uncut] critic round 3: $0.4123")));
    const bad = await logged(run({ ...RESULT, is_error: true, result: "boom" }));
    assert.ok(bad.out instanceof Error);
    assert.ok(bad.lines.some((l) => l.startsWith("[uncut] critic round 3: $0.4123")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
