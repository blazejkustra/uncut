// The benchmark's arithmetic, pure so the tests can pin what each published number means.
import type { Seed } from "./seeds.ts";

export interface Finding {
  readonly kind?: string;
  readonly what: string;
  readonly at?: number;
}
export interface Round {
  readonly passed: boolean;
  readonly blockers?: ReadonlyArray<Finding>;
  readonly defects: ReadonlyArray<Finding>;
}
export interface Usage {
  readonly cost?: number;
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly pid?: number;
}

/** A finding's time may sit this far outside the seeded stretch: critics cite the nearest frame they saw. */
const NEAR_S = 1;

function matches(seed: Seed, finding: Finding) {
  const near = finding.at === undefined || (finding.at >= seed.from! - NEAR_S && finding.at <= seed.to! + NEAR_S);
  return near && (seed.kinds!.includes(finding.kind ?? "") || seed.words!.test(finding.what));
}

/** Whether a round caught the seeded defect: as a blocker, or at least as a listed defect. */
export function caught(seed: Seed, round: Round) {
  const blocker = (round.blockers ?? []).some((b) => matches(seed, b));
  return { blocker, listed: blocker || round.defects.some((d) => matches(seed, d)) };
}

/** Token and dollar totals of a run's result messages. A process's cost is cumulative, so its last one counts. */
export function spend(results: ReadonlyArray<Usage>) {
  const count = (key: string) => results.reduce((n, r) => n + (typeof r.usage?.[key] === "number" ? (r.usage[key] as number) : 0), 0);
  const costs = new Map<number | undefined, number>();
  for (const r of results) if (typeof r.cost === "number") costs.set(r.pid, r.cost);
  return {
    costUsd: Math.round([...costs.values()].reduce((a, b) => a + b, 0) * 10000) / 10000,
    inputTokens: count("input_tokens"),
    cacheReadTokens: count("cache_read_input_tokens"),
    cacheWriteTokens: count("cache_creation_input_tokens"),
    outputTokens: count("output_tokens"),
  };
}

/** How often a defect's matcher fires on a film without that defect: the noise under the listed catch rate. */
export function matcherNoise(seeds: ReadonlyArray<Seed>, cleanRounds: ReadonlyArray<Round>) {
  const planted = seeds.filter((s) => s.defect);
  const hits = planted.flatMap((s) => cleanRounds.filter((r) => caught(s, r).listed));
  const pairs = planted.length * cleanRounds.length;
  return { pairs, hits: hits.length };
}

export interface SeededRun {
  readonly id: string;
  readonly seeded: boolean;
  readonly passed: boolean;
  readonly blockers: number;
  readonly caughtAsBlocker: boolean;
  readonly caughtListed: boolean;
}

/** Catch rate over seeded runs; false alarms over clean runs. */
export function seededSummary(runs: ReadonlyArray<SeededRun>) {
  const seeded = runs.filter((r) => r.seeded);
  const clean = runs.filter((r) => !r.seeded);
  const share = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 1000 : null);
  return {
    seededRuns: seeded.length,
    caughtAsBlocker: seeded.filter((r) => r.caughtAsBlocker).length,
    caughtListed: seeded.filter((r) => r.caughtListed).length,
    roundFailed: seeded.filter((r) => !r.passed).length,
    blockerCatchRate: share(seeded.filter((r) => r.caughtAsBlocker).length, seeded.length),
    listedCatchRate: share(seeded.filter((r) => r.caughtListed).length, seeded.length),
    cleanRuns: clean.length,
    cleanPassed: clean.filter((r) => r.passed).length,
    cleanWithBlockers: clean.filter((r) => r.blockers > 0).length,
  };
}
