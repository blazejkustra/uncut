// The critic row's words (critic.tsx). Pure, for the tests.
import { REVIEW_SCORES, type CriticRun, type Review } from "@uncut/contracts";

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

/** A round as its trail chip says it. */
export const roundOutcome = (review: Review): string => criticLabel(statusOf(review), review);

/** The rounds up to this one, the last ones when there are many. */
export const roundTrail = (reviews: ReadonlyArray<Review>, round: number, most = 4): ReadonlyArray<Review> =>
  reviews.filter((r) => r.round <= round).slice(-most);

/** What rose from the round before: "readability 5 to 9". */
function scoreRises(review: Review, previous: Review): Array<string> {
  return REVIEW_SCORES.flatMap((k) => {
    const was = previous.scores[k];
    const now = review.scores[k];
    return was !== undefined && now !== undefined && now > was ? [`${k} ${was} to ${now}`] : [];
  });
}

export interface RoundVerdict {
  readonly title: string;
  readonly detail?: string;
  /** This round turned a failed one into a pass. */
  readonly turned: boolean;
}

/** The scorecard's headline: what this round decided, and what changed since the last one. */
export function roundVerdict(review: Review, previous: Review | undefined): RoundVerdict {
  const blockers = review.blockers?.length ?? 0;
  if (!review.passed) {
    const open = blockers === 1 ? "1 blocker to fix" : blockers ? `${blockers} blockers to fix` : "Scores under the bar";
    return { title: `Failed round ${review.round}`, detail: open, turned: false };
  }
  if (!previous || previous.passed) return { title: `Passed on round ${review.round}`, turned: false };
  const cleared = previous.blockers?.length ?? 0;
  const moved = [...(cleared ? [cleared === 1 ? "1 blocker cleared" : `${cleared} blockers cleared`] : []), ...scoreRises(review, previous)];
  return { title: `Passed on round ${review.round}`, ...(moved.length ? { detail: moved.join(", ") } : {}), turned: true };
}

/** A finding's moment: "f 96, 3.2 s" (the frame when known). */
export const momentText = (at: number, frame: number | undefined): string => {
  const time = `${Math.round(at * 10) / 10} s`;
  return frame === undefined ? time : `f ${frame}, ${time}`;
};

/** "4m 10s", "38s". */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
