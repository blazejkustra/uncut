// The frames a critic round's findings point at, so the scorecard can show each finding's picture
// and jump to it.
import type { Review } from "@uncut/contracts";

/** The most frames one round keeps: blockers first, then defects. */
export const FINDING_STILLS = 6;

const frameOf = (at: number, fps: number, last: number) => Math.max(0, Math.min(last, Math.round(at * fps)));

/** The distinct frames to keep for a round's findings, in the order the scorecard lists them. */
export function findingFrames(review: Review, fps: number, last: number): Array<number> {
  const moments = [...(review.blockers ?? []), ...review.defects].flatMap((f) => (f.at === undefined ? [] : [frameOf(f.at, fps, last)]));
  return [...new Set(moments)].slice(0, FINDING_STILLS);
}

/** A kept frame's file name: a round's frames never overwrite another's. */
export const stillName = (review: Review, frame: number) => `${review.turnId ?? "review"}-c${review.round}-${frame}.jpg`;

/** The round with each timed finding's frame and, when it was kept, its still. */
export function withFrames(review: Review, fps: number, last: number, stills: ReadonlyMap<number, string>): Review {
  const framed = <F extends { readonly at?: number | undefined }>(finding: F): F => {
    if (finding.at === undefined) return finding;
    const frame = frameOf(finding.at, fps, last);
    const still = stills.get(frame);
    return { ...finding, frame, ...(still ? { still } : {}) };
  };
  return { ...review, defects: review.defects.map(framed), ...(review.blockers ? { blockers: review.blockers.map(framed) } : {}) };
}
