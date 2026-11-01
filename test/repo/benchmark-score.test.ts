// What scripts/benchmark.ts counts: spec/agent/benchmark.json's numbers mean what these pin.
import { test } from "node:test";
import assert from "node:assert/strict";

import { caught, matcherNoise, seededSummary, spend } from "../../scripts/benchmark/score.ts";
import { filmHtml, SEEDS, type Seed } from "../../scripts/benchmark/seeds.ts";

const seed = SEEDS.find((s) => s.id === "overflow") as Seed;

test("a defect counts as caught by its kind or words near it, and a blocker outranks a listed defect", () => {
  assert.deepEqual(caught(seed, { passed: false, blockers: [{ kind: "overflow", what: "x", at: 3 }], defects: [] }), { blocker: true, listed: true });
  assert.deepEqual(caught(seed, { passed: false, defects: [{ kind: "readability", what: "the line is cut off at the edge", at: 2.5 }] }), {
    blocker: false,
    listed: true,
  });
  assert.deepEqual(
    caught(seed, { passed: false, defects: [{ kind: "readability", what: "the line is cut off", at: 5.5 }] }),
    { blocker: false, listed: false },
    "too far away",
  );
  assert.deepEqual(
    caught(seed, { passed: false, defects: [{ kind: "readability", what: "the type is a bit small", at: 3 }] }),
    { blocker: false, listed: false },
    "a category proves nothing",
  );
});

test("spend takes a process's last cost once and adds every result's tokens", () => {
  const total = spend([
    { pid: 1, cost: 0.1, usage: { input_tokens: 10, output_tokens: 5 } },
    { pid: 1, cost: 0.25, usage: { input_tokens: 20, output_tokens: 5 } },
    { pid: 2, cost: 0.05, usage: { input_tokens: 1 } },
  ]);
  assert.equal(total.costUsd, 0.3);
  assert.equal(total.inputTokens, 31);
  assert.equal(total.outputTokens, 10);
});

test("the summary keeps seeded and clean runs apart, and matcher noise is counted on clean rounds", () => {
  const run = (seeded: boolean, caughtAsBlocker: boolean, caughtListed: boolean, passed: boolean) => ({
    id: "x",
    seeded,
    passed,
    blockers: caughtAsBlocker ? 1 : 0,
    caughtAsBlocker,
    caughtListed,
  });
  const s = seededSummary([run(true, true, true, false), run(true, false, true, false), run(false, false, false, true)]);
  assert.deepEqual([s.seededRuns, s.caughtAsBlocker, s.caughtListed, s.blockerCatchRate, s.listedCatchRate], [2, 1, 2, 0.5, 1]);
  assert.deepEqual([s.cleanRuns, s.cleanPassed, s.cleanWithBlockers], [1, 1, 0]);
  const planted = SEEDS.filter((x) => x.defect).length;
  assert.deepEqual(matcherNoise(SEEDS, [{ passed: false, defects: [{ what: "the title is cut off", at: 3 }] }]), { pairs: planted, hits: 1 });
});

test("each seeded film differs from the clean film only by its script", () => {
  const clean = filmHtml({ id: "clean" });
  for (const s of SEEDS.filter((x) => x.defect)) assert.notEqual(filmHtml(s), clean, s.id);
});
