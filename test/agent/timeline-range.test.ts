// Several videos in one project, one after another on Main, each at its own marker: review_submit
// and export_video take a marker's section or a frame range; review rounds count per part of the
// timeline within a cap for the whole turn; a part's review is moved onto the timeline's clock.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Review, Storyboard } from "../../packages/contracts/src/index.ts";
import { REVIEW_ROUNDS, REVIEW_ROUNDS_TURN } from "../../apps/server/src/agent/agentCritic.ts";
import { normReview } from "../../apps/server/src/brand/store.ts";
import { markerSection, rangeArgs, rangeBudget, rangeKey, rangeStoryboard, shiftIntended, shiftReview } from "../../apps/server/src/agent/timelineRange.ts";
import { exportRange } from "../../apps/server/src/agent/tools/exportVideo.ts";
import { planOnly } from "../../apps/server/src/agent/agentPlan.ts";

const solid = (id: string, duration: number) => ({ id, type: "component", module: "component.solid", duration, props: { color: "#000" } });
const project = {
  tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [solid("a", 300), solid("b", 300), solid("c", 300)] }],
  markers: [{ frame: 600, label: "Promo 3" }, { frame: 0, label: "Promo 1" }, { frame: 300, label: " Promo 2 " }, { frame: 450 }],
} as never;

test("markerSection: a marker to the next marker (labelled or not) or the end, by its label in any case", () => {
  assert.deepEqual(markerSection(project, "Promo 1"), { from: 0, to: 300, marker: "Promo 1" });
  assert.deepEqual(markerSection(project, "promo 2"), { from: 300, to: 450, marker: "Promo 2" });
  assert.deepEqual(markerSection(project, "PROMO 3"), { from: 600, to: 900, marker: "Promo 3" });
  assert.deepEqual(markerSection(project, "Promo 4"), { problem: 'No marker is named "Promo 4" (the markers: "Promo 1", "Promo 2", "Promo 3").' });
  const bare = { tracks: (project as { tracks: unknown }).tracks } as never;
  assert.deepEqual(markerSection(bare, "Promo 1"), { problem: 'No marker is named "Promo 1" (the timeline has no named markers).' });
  const twice = {
    ...(project as object),
    markers: [
      { frame: 0, label: "Promo" },
      { frame: 300, label: "promo" },
    ],
  } as never;
  assert.match((markerSection(twice, "Promo") as { problem: string }).problem, /2 markers are named "Promo"/);
  const atEnd = { ...(project as object), markers: [{ frame: 900, label: "End" }] } as never;
  assert.match((markerSection(atEnd, "End") as { problem: string }).problem, /at the end of the timeline/);
});

test("rangeArgs: a marker, or whole frames from and to clamped to the timeline, never both; nothing is the whole timeline", () => {
  assert.deepEqual(rangeArgs(project, {}), {});
  assert.deepEqual(rangeArgs(project, { marker: "Promo 2" }), { range: { from: 300, to: 450, marker: "Promo 2" } });
  assert.deepEqual(rangeArgs(project, { from: 120, to: 240 }), { range: { from: 120, to: 240 } });
  assert.deepEqual(rangeArgs(project, { from: -5, to: 5000 }), { range: { from: 0, to: 900 } });
  assert.match((rangeArgs(project, { marker: "Promo 1", from: 0, to: 30 }) as { problem: string }).problem, /not both/);
  assert.match((rangeArgs(project, { marker: " " }) as { problem: string }).problem, /marker must be/);
  for (const bad of [{ from: 10 }, { to: 10 }, { from: 1.5, to: 30 }, { from: "0", to: "30" }])
    assert.match((rangeArgs(project, bad) as { problem: string }).problem, /from and to must both be frame numbers/, JSON.stringify(bad));
  assert.match((rangeArgs(project, { from: 950, to: 1000 }) as { problem: string }).problem, /hold nothing: the timeline is 900 frames long/);
  assert.equal(rangeKey(undefined), "all");
  assert.equal(rangeKey({ from: 0, to: 300, marker: "Promo 1" }), "marker:promo 1");
  assert.equal(rangeKey({ from: 0, to: 300 }), "frames:0-300");
});

const round = (turnId: string, range: Review["range"], at: number, passed = false): Review => ({
  round: 1,
  scores: {},
  defects: [],
  blockers: passed ? [] : [{ id: "d1", kind: "blank", what: `Empty frame at ${at}`, at, source: "critic" }],
  passed,
  at: "2026-11-25T10:00:00.000Z",
  turnId,
  ...(range ? { range } : {}),
});
const promo = (n: number) => ({ from: (n - 1) * 300, to: n * 300, marker: `Promo ${n}` });

test("rangeBudget: each video has its own 3 rounds in a turn, and the turn stops at 15 in all", () => {
  assert.equal(REVIEW_ROUNDS, 3);
  assert.equal(REVIEW_ROUNDS_TURN, 15);
  const first = [round("t1", promo(1), 1), round("t1", promo(1), 3), round("t1", promo(1), 5)];
  const of = (range: Review["range"], done: number, turnDone = 3) => rangeBudget(first, { turnId: "t1", range, done, turnDone, cap: REVIEW_ROUNDS });
  assert.deepEqual(of(promo(1), 3).outlook, { more: false, capped: true, why: "round 3 of at most 3: 3 rounds is the cap" });
  assert.deepEqual(of(promo(2), 0).outlook, { more: true, why: "round 0 of at most 3: round 1 is available" }, "the next video still has its rounds");
  assert.deepEqual(of(undefined, 0).outlook.more, true, "the whole timeline is a part of its own");
  assert.equal(of(promo(2), 0).rounds.length, 0);
  assert.equal(of(promo(1), 3).last?.blockers?.[0]?.at, 5, "a fix claims the video's own last round");
  assert.equal(of(promo(2), 0).last, undefined, "never another video's ids");
  const capped = of(promo(5), 0, REVIEW_ROUNDS_TURN).outlook;
  assert.deepEqual(capped, { more: false, capped: true, why: "15 rounds in this turn: 15 across its videos is the cap" });
  // A marker's rounds follow its name, whatever its frames are now; an earlier turn's last round of the same video counts as "earlier".
  const moved = { from: 330, to: 660, marker: "promo 2" };
  const history = [round("t0", promo(2), 2), round("t0", promo(1), 9), ...first];
  const next = rangeBudget(history, { turnId: "t1", range: moved, done: 0, turnDone: 3, cap: REVIEW_ROUNDS });
  assert.equal(next.earlier?.blockers?.[0]?.at, 2);
  assert.equal(next.last?.blockers?.[0]?.at, 2);
  const fix = rangeBudget(history, { turnId: "t1", range: promo(3), done: 0, turnDone: 3, cap: 1 });
  assert.equal(fix.outlook.more, true, "a fix turn's ceiling is per video too");
});

test("shiftReview: a part's finding and fix times onto the timeline's clock and back; Intended findings and beats on the part's clock", () => {
  const review: Review = {
    ...round("t1", promo(2), 4.2),
    defects: [
      { at: 1.5, what: "hold drags", to: 3 },
      { at: 0, what: "no hook" },
    ],
    fixes: [
      { defect: "d1", what: "filled", at: 2, verified: true },
      { defect: "d2", what: "x", verified: false },
    ],
  };
  const placed = shiftReview(review, 10);
  assert.deepEqual(
    placed.blockers!.map((b) => b.at),
    [14.2],
  );
  assert.deepEqual(placed.defects, [
    { at: 11.5, what: "hold drags", to: 13 },
    { at: 10, what: "no hook" },
  ]);
  assert.deepEqual(
    placed.fixes!.map((f) => f.at),
    [12, undefined],
  );
  assert.deepEqual(shiftReview(placed, -10), review);
  assert.equal(shiftReview(review, 0), review);
  assert.deepEqual(
    shiftIntended(
      [
        { kind: "hook", what: "slow open", from: 12, to: 13, at: "x" },
        { kind: "brand", what: "no logo", at: "x" },
      ],
      -10,
    ),
    [
      { kind: "hook", what: "slow open", from: 2, to: 3, at: "x" },
      { kind: "brand", what: "no logo", at: "x" },
    ],
  );
  const beat = (start: number, end: number) => ({ start, end, title: `${start}`, entry: "", exit: "", purpose: "", assets: [] });
  const sb: Storyboard = { summary: "Five promos", status: "approved", beats: [beat(0, 4), beat(4, 10), beat(10, 14), beat(14, 20), beat(20, 30)] };
  assert.deepEqual(
    rangeStoryboard(sb, promo(2), 30)!.beats.map((b) => [b.start, b.end]),
    [
      [0, 4],
      [4, 10],
    ],
  );
  assert.deepEqual(
    rangeStoryboard(sb, { from: 270, to: 450 }, 30)!.beats.map((b) => [b.start, b.end]),
    [
      [0, 1],
      [1, 5],
      [5, 6],
    ],
  );
  assert.equal(rangeStoryboard(sb, { from: 900, to: 960 }, 30), undefined);
});

test("a review's range is kept on disk and read back; a broken one is dropped", () => {
  const saved = normReview({ ...round("t1", promo(2), 1), range: { from: 300, to: 600, marker: "Promo 2" } })!;
  assert.deepEqual(saved.range, { from: 300, to: 600, marker: "Promo 2" });
  assert.deepEqual(normReview({ ...round("t1", undefined, 1), range: { from: 0, to: 90 } })!.range, { from: 0, to: 90 });
  for (const range of [{ from: 300, to: 300 }, { from: "0", to: 30 }, "Promo 2"])
    assert.equal(normReview({ ...round("t1", undefined, 1), range })!.range, undefined, JSON.stringify(range));
});

test("exportRange: the marks and selection as before, a marker's section or frames, one way at a time", () => {
  const ranges = { marks: { from: 10, to: 40 }, selection: { from: 30.4, to: 90 } };
  assert.deepEqual(exportRange(project, {}, ranges), {});
  assert.deepEqual(exportRange(project, { range: "all" }, ranges), {});
  assert.deepEqual(exportRange(project, { range: "selection" }, ranges), { range: { from: 30, to: 90 } });
  assert.deepEqual(exportRange(project, { range: "marks" }, ranges), { range: { from: 10, to: 40 } });
  assert.deepEqual(exportRange(project, { marker: "Promo 3" }, ranges), { range: { from: 600, to: 900, marker: "Promo 3" } });
  assert.deepEqual(exportRange(project, { range: "all", from: 300, to: 450 }, undefined), { range: { from: 300, to: 450 } });
  assert.match(
    (exportRange(project, { range: "marks", marker: "Promo 1" }, ranges) as { problem: string }).problem,
    /Pass range "marks" or a marker or frames, not both/,
  );
  assert.match((exportRange(project, { range: "marks" }, undefined) as { problem: string }).problem, /No In\/Out marks were set/);
  assert.match((exportRange(project, { range: "selection" }, {}) as { problem: string }).problem, /Nothing was selected/);
  assert.match((exportRange(project, { range: "whole" }, ranges) as { problem: string }).problem, /range must be/);
  assert.match((exportRange(project, { marker: "Promo 9" }, ranges) as { problem: string }).problem, /No marker is named "Promo 9"/);
  assert.deepEqual(exportRange(project, { range: "marks" }, { marks: { from: 40, to: 40 } }), { problem: "That range is empty." });
});

test("the plan's last review names the video or frames it reviewed", () => {
  const round = (range?: Review["range"]) =>
    ({ round: 2, by: "critic", scores: { hook: 8 }, defects: [], passed: true, at: "", ...(range ? { range } : {}) }) as unknown as Review;
  const line = (review: Review) => /Last review[^\n]*/.exec(planOnly({ reviews: [review] } as never))![0];
  assert.match(line(round({ from: 300, to: 450, marker: "Promo 2" })), /round 2 of "Promo 2", hook 8 \(passed\)/);
  assert.match(line(round({ from: 30, to: 60 })), /round 2 of frames 30 to 60, hook 8/);
  assert.match(line(round()), /round 2, hook 8/);
});
