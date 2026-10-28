// The critic row's words (critic.tsx). Pure, for the tests.
import type { CriticRun, Review } from "@uncut/contracts";

/** A round saved before the live row: its status from the review. */
export const statusOf = (review: Review): CriticRun["status"] => {
  if (review.passed) return "passed";
  const blockers = review.blockers ?? [];
  return blockers.length && blockers.every((b) => b.unresolved) ? "unresolved" : "failed";
};

/** The status as the row says it. */
export function criticLabel(status: CriticRun["status"], review: Review | undefined): string {
  if (status === "running") return "Running";
  if (status === "passed") return "Passed";
  if (status === "error") return "Didn't run";
  const blockers = review?.blockers ?? [];
  if (status === "unresolved") return `${blockers.length} unresolved, your call`;
  return blockers.length ? (blockers.length === 1 ? "1 blocker" : `${blockers.length} blockers`) : "Below the bar";
}

/** "4m 10s", "38s". */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
