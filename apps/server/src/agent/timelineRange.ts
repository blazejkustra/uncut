// The part of the timeline review_submit and export_video work on when one project holds several
// videos one after another on Main: a marker's section (that marker to the next one, or the end) or
// a frame range. A review of a range sees that part as a video of its own (core sliceProject, as
// its export renders it); its times are moved back onto the timeline's clock before anyone sees them.
import type { IntendedFinding, Review, Storyboard } from "@uncut/contracts";
import { layout, type Project } from "@uncut/core";

import { REVIEW_ROUNDS_TURN, reviewOutlook, type ReviewOutlook } from "./agentCritic.ts";

export interface TimelineRange {
  readonly from: number;
  readonly to: number;
  readonly marker?: string;
}

type Problem = { readonly problem: string };

const sameLabel = (label: string | undefined, asked: string) => (label ?? "").trim().toLowerCase() === asked.trim().toLowerCase();

const namedMarkers = (markers: ReadonlyArray<{ readonly label?: string }>) =>
  markers.flatMap((m) => (m.label?.trim() ? [`"${m.label.trim()}"`] : [])).join(", ");

/** The section a marker starts: from its frame to the next marker's, or to the end of the timeline. */
export function markerSection(project: Pick<Project, "tracks" | "markers">, label: string): TimelineRange | Problem {
  const markers = [...(project.markers ?? [])].sort((a, b) => a.frame - b.frame);
  const named = markers.filter((m) => sameLabel(m.label, label));
  const asked = label.trim();
  if (!named.length) {
    const known = namedMarkers(markers);
    return { problem: `No marker is named "${asked}" (${known ? `the markers: ${known}` : "the timeline has no named markers"}).` };
  }
  if (named.length > 1) return { problem: `${named.length} markers are named "${asked}": give each video's marker its own name.` };
  const start = named[0]!;
  const end = layout(project).duration;
  const next = markers.find((m) => m.frame > start.frame);
  const to = Math.min(end, next?.frame ?? end);
  if (to <= start.frame) return { problem: `The marker "${asked}" is at the end of the timeline: its section is empty.` };
  return { from: start.frame, to, marker: start.label!.trim() };
}

/** The range the args name (marker, or from and to in frames); none means the whole timeline. */
export function rangeArgs(project: Pick<Project, "tracks" | "markers">, args: Record<string, unknown>): { readonly range?: TimelineRange } | Problem {
  const { marker, from, to } = args;
  const framed = from !== undefined || to !== undefined;
  if (marker !== undefined && framed) return { problem: "Pass marker or from and to, not both." };
  if (marker !== undefined) {
    if (typeof marker !== "string" || !marker.trim()) return { problem: "marker must be a marker's label." };
    const section = markerSection(project, marker);
    return "problem" in section ? section : { range: section };
  }
  if (!framed) return {};
  if (!Number.isInteger(from) || !Number.isInteger(to)) return { problem: "from and to must both be frame numbers." };
  const end = layout(project).duration;
  const range = { from: Math.max(0, from as number), to: Math.min(end, to as number) };
  if (range.to <= range.from) return { problem: `Frames ${from} to ${to} hold nothing: the timeline is ${end} frames long.` };
  return { range };
}

/** What review rounds are counted by: a marker's name, else the frames, else the whole timeline. */
export const rangeKey = (range: TimelineRange | undefined) =>
  !range ? "all" : range.marker ? `marker:${range.marker.toLowerCase()}` : `frames:${range.from}-${range.to}`;

/**
 * A turn's review budget for one part of the timeline: `cap` rounds of its own (`done` so far, the
 * turn's count, which includes a round whose review couldn't be saved) within REVIEW_ROUNDS_TURN
 * for the whole turn (`turnDone`). Also the part's rounds in this turn, the last one of an earlier
 * turn (a first round that finds the same again stops there) and the part's last round (its ids
 * are what a fix claims).
 */
export function rangeBudget(
  reviews: ReadonlyArray<Review>,
  o: { readonly turnId: string; readonly range: TimelineRange | undefined; readonly done: number; readonly turnDone: number; readonly cap: number },
): { readonly outlook: ReviewOutlook; readonly rounds: ReadonlyArray<Review>; readonly earlier?: Review; readonly last?: Review } {
  const key = rangeKey(o.range);
  const mine = reviews.filter((x) => rangeKey(x.range) === key);
  const rounds = mine.filter((x) => x.turnId === o.turnId);
  const earlier = mine.filter((x) => x.turnId !== o.turnId).at(-1);
  const last = mine.at(-1);
  const found = { rounds, ...(earlier ? { earlier } : {}), ...(last ? { last } : {}) };
  if (o.turnDone >= REVIEW_ROUNDS_TURN)
    return { ...found, outlook: { more: false, capped: true, why: `${o.turnDone} rounds in this turn: ${REVIEW_ROUNDS_TURN} across its videos is the cap` } };
  return { ...found, outlook: reviewOutlook(rounds, o.done, earlier, o.cap) };
}

const moved = (seconds: number, by: number) => Number((seconds + by).toFixed(3));

const timed = <F extends { readonly at?: number | undefined; readonly to?: number | undefined }>(finding: F, by: number): F => ({
  ...finding,
  ...(finding.at !== undefined ? { at: moved(finding.at, by) } : {}),
  ...(finding.to !== undefined ? { to: moved(finding.to, by) } : {}),
});

/** The review's finding and fix times moved by `seconds`, between a range's own clock and the timeline's. */
export function shiftReview(review: Review, seconds: number): Review {
  if (!seconds) return review;
  return {
    ...review,
    defects: review.defects.map((d) => timed(d, seconds)),
    ...(review.blockers ? { blockers: review.blockers.map((b) => timed(b, seconds)) } : {}),
    ...(review.fixes ? { fixes: review.fixes.map((f) => timed(f, seconds)) } : {}),
  };
}

/** The findings the user marked Intended, on a range's own clock (one before it ends up before 0 and never matches). */
export const shiftIntended = (list: ReadonlyArray<IntendedFinding>, seconds: number): Array<IntendedFinding> =>
  list.map((x) => ({
    ...x,
    ...(x.from !== undefined ? { from: moved(x.from, seconds) } : {}),
    ...(x.to !== undefined ? { to: moved(x.to, seconds) } : {}),
  }));

/** The storyboard's beats inside the range, on its own clock; none when no beat falls in it. */
export function rangeStoryboard(storyboard: Storyboard | undefined, range: TimelineRange, fps: number): Storyboard | undefined {
  if (!storyboard) return undefined;
  const from = range.from / fps;
  const to = range.to / fps;
  const beats = storyboard.beats
    .filter((b) => b.end > from && b.start < to)
    .map((b) => ({ ...b, start: moved(Math.max(from, b.start), -from), end: moved(Math.min(to, b.end), -from) }));
  return beats.length ? { ...storyboard, beats } : undefined;
}
