// The critic loop converges (user, 2026-10-27; argent-100s ran 9 rounds on the same defects): the
// user's own text size wins over the critic's 3.5 % (agentLegibility requestedTypePx, <sizes>); the
// loop seam only when the user asked for a loop (not "the loop diagram's style"); a finding back
// unchanged after a claimed fix is unresolved (the user decides it); the same blockers as the round
// before stop the loop at any round. And the critic's row in the thread (criticRow, critic.tsx).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Review } from "../../packages/contracts/src/index.ts";
import { criticReview, criticText, parseCritic, reviewNext, reviewOutlook, sameFinding, type CriticInput } from "../../apps/server/src/agent/agentCritic.ts";
import { asksLoop, motionIntent, motionLines, motionScan } from "../../apps/server/src/agent/criticMotion.ts";
import { requestedTypePx, textFloorPct, underFloor, legibilityFindings } from "../../apps/server/src/agent/agentLegibility.ts";
import { criticRow, criticStatus } from "../../apps/server/src/agent/tools/criticRow.ts";
import { criticLabel, elapsedText } from "../../apps/web/src/panels/agent/criticWords.ts";
import type { Running } from "../../apps/server/src/agent/session/types.ts";

const ev = (score: number) => ({ score, evidence: "f 0, f 30: fine" });
const all = (n: number) => ({ hook: ev(n), readability: ev(n), motion: ev(n), variety: ev(n), sound: ev(n), brand: ev(n) });
const ctx = {
  round: 2,
  claims: [],
  checks: [],
  determinism: { checked: [], differed: [] },
  looked: { sheet: true, phone: true },
  revision: 4,
  turnId: "t1",
  fps: 30,
};

test("asksLoop: the user's words asking for a loop, never a loop the film shows or mentions", () => {
  for (const yes of [
    "Make it a seamless loop for the site header.",
    "It should loop forever.",
    "A looping background video, 10 s.",
    "make it loop",
    "the last frame equals the first",
  ])
    assert.equal(asksLoop(yes), true, yes);
  for (const no of [
    "Use the loop diagram's style from the blog.",
    "Show the feedback loop: test, fix, ship.",
    "Keep me in the loop",
    "seamless transitions between scenes",
    "Don't make it loop.",
  ])
    assert.equal(asksLoop(no), false, no);
  const e2e = motionIntent({
    skills: [],
    words: "assets: the loop diagram's style (the blog's e2e-loop diagram)",
    request: "A 60 s explainer for X in the loop diagram's style",
  });
  assert.equal(e2e.loop, false, "argent-e2e: the brief's 'loop diagram' isn't a loop");
  assert.equal(motionIntent({ skills: [], words: "", request: "a seamless loop" }).loop, true);
});

test("motionLines: the seam line only for a film meant to loop", () => {
  const frame = (v: number) => new Uint8Array(64 * 36).fill(v);
  const scan = motionScan(
    Array.from({ length: 40 }, (_, i) => ({ frame: i, gray: frame(i < 39 ? 40 + i : 200) })),
    30,
  );
  assert.ok(scan.seam);
  assert.ok(!motionLines(scan, 30, { consecutive: true }).some((l) => /Loop seam/.test(l)));
  assert.ok(motionLines(scan, 30, { consecutive: true, loop: true }).some((l) => /Loop seam/.test(l)));
});

test("requestedTypePx and the floor: the user's 46 px wins over Uncut's 3 % and the critic's 3.5 %", () => {
  assert.equal(requestedTypePx("Make the prompt row 46 px. Logo top left at 120px wide."), 46);
  assert.equal(requestedTypePx("Text at least 46px, titles 80 px"), 46);
  assert.equal(requestedTypePx("A 1920 px wide canvas"), undefined, "a px number that isn't about text");
  assert.equal(requestedTypePx("no sizes here"), undefined);
  assert.equal(textFloorPct(1080), 3);
  assert.equal(textFloorPct(1080, 46), 2.8, "46 px letters are ~3.1 %, less 10 % for measuring");
  assert.equal(textFloorPct(1080, 80), 3, "a bigger ask never raises the floor");
  const census = [
    {
      frame: 10,
      measured: 4,
      small: [
        { text: "prompt row", share: 2.9 },
        { text: "tiny", share: 1.5 },
      ],
    },
  ];
  assert.deepEqual(
    underFloor(census, 2.8)[0]!.small!.map((x) => x.text),
    ["tiny"],
  );
  assert.deepEqual(legibilityFindings(underFloor(census, 2.8), 30, 1080, 2.8).length, 1);
  assert.match(legibilityFindings(underFloor(census, 2.8), 30, 1080, 2.8)[0]!.message, /under 2\.8 %/);
  const input: CriticInput = {
    round: 1,
    canvas: { width: 1920, height: 1080, fps: 30 },
    frames: 300,
    kit: [],
    claims: [],
    checks: [],
    determinism: { checked: [], differed: [] },
    images: [],
    typePx: 46,
  };
  assert.match(criticText(input), /<sizes>\nThe user asked for text at 46 px \(letters about 3\.1 % of the 1080 px height\)[^]*never ask for text larger/);
  assert.ok(!/<sizes>/.test(criticText({ ...input, typePx: undefined })));
});

test("sameFinding: the same kind at the same moment in near words, or nearly the same words anywhere", () => {
  const a = { kind: "readability", at: 12, what: "The Stride phone is about 20 % of the frame wide, its screen unreadable" };
  assert.ok(sameFinding(a, { kind: "readability", at: 12.2, what: "Stride phone about 20 % of the frame wide; the screen can't be read" }));
  assert.ok(sameFinding(a, { ...a, at: 40 }), "the same words elsewhere");
  assert.ok(!sameFinding(a, { kind: "motion", at: 12, what: a.what }), "another kind");
  assert.ok(!sameFinding(a, { kind: "readability", at: 12, what: "The end card's URL is cut at the right edge" }));
});

test("criticReview: a finding back after a claimed fix is unresolved, so is an unverified fix; reviewNext says to ask the user", () => {
  const previous = {
    round: 1,
    scores: {},
    defects: [{ id: "d2", at: 12, kind: "readability", what: "The Stride phone is about 20 % of the frame wide" }],
    blockers: [{ id: "d1", kind: "illegible", at: 3, what: "The prompt row's letters are 2.9 % tall", source: "critic" }],
    passed: false,
  } as unknown as Review;
  const answer = parseCritic(
    JSON.stringify({
      scores: all(7),
      blockers: [{ kind: "illegible", at: 3, what: "The prompt row's letters are 2.9 % tall" }],
      defects: [
        { at: 12, kind: "readability", what: "The Stride phone is about 20 % of the frame wide" },
        { at: 20, kind: "motion", what: "A new pop" },
      ],
      fixes: [{ defect: "d1", verified: false }],
    }),
  );
  assert.ok(!("problem" in answer));
  const claims = [
    { defect: "d1", what: "bigger", at: 3 },
    { defect: "d2", what: "zoomed", at: 12 },
  ];
  const review = criticReview(answer, { ...ctx, claims, previous });
  assert.deepEqual(
    review.blockers!.map((b) => [b.kind, !!b.unresolved]),
    [
      ["illegible", true],
      ["unverified-fix", true],
      ["unverified-fix", true],
    ],
    "d2 wasn't confirmed either",
  );
  assert.deepEqual(
    review.defects.map((d) => [d.what, !!d.unresolved]),
    [
      ["The Stride phone is about 20 % of the frame wide", true],
      ["A new pop", false],
    ],
  );
  assert.equal(criticStatus(review), "unresolved");
  const out = reviewOutlook([previous, review], 2);
  assert.equal(out.more, false, "only unresolved blockers left: no round 3 (it was always open before)");
  assert.match(out.why, /the user decides them/);
  assert.match(reviewNext(review, 2, out), /Unresolved \(back unchanged after your fix[^]*ask_user/);
  const fresh = criticReview(answer, { ...ctx, claims: [], previous });
  assert.ok(!fresh.blockers!.some((b) => b.unresolved), "no fix claimed: nothing is unresolved");
});

test("reviewOutlook: the same blockers stop the loop at any round, also against an earlier turn's last round", () => {
  const at = (...xs: Array<number>) => ({ passed: false, blockers: xs.map((x) => ({ kind: "illegible", at: x })), scores: { motion: 7 } });
  assert.equal(reviewOutlook([at(3, 9), at(3, 9)], 2).more, false);
  assert.match(reviewOutlook([at(3, 9), at(3, 9)], 2).why, /the same blockers came back/);
  assert.equal(reviewOutlook([at(3, 9), at(4)], 2).more, true, "changing: round 3 is open");
  assert.equal(reviewOutlook([at(3, 9)], 1, at(3, 9)).more, false, "argent-100s R8, R9: a follow-up turn's first round finding the same");
  assert.equal(reviewOutlook([at(3, 9)], 1, at(5)).more, true);
  const none = (motion: number) => ({ passed: false, blockers: [], scores: { motion } });
  assert.equal(reviewOutlook([none(7), none(7)], 2).more, false, "no blockers and no score gained");
  assert.equal(reviewOutlook([none(6), none(7)], 2).more, true, "scores rising");
});

test("criticRow: running with its step, then the result, persisted; a stopped turn ends it", () => {
  const items: Array<unknown> = [{ kind: "text", text: "Building" }];
  const r = { turn: { items }, cancelled: false } as unknown as Running;
  let saves = 0;
  let publishes = 0;
  const row = criticRow(
    r,
    2,
    () => saves++,
    () => publishes++,
  );
  const card = () => (items[1] as { card: { critic: { status: string; line: string; round: number; endedAt?: string }; review?: Review } }).card;
  assert.equal(card().critic.status, "running");
  assert.equal(card().critic.round, 2);
  row.step("Scanning the motion frame by frame");
  assert.equal(card().critic.line, "Scanning the motion frame by frame");
  const review = {
    round: 2,
    scores: {},
    defects: [],
    blockers: [{ kind: "font", what: "x", source: "critic" }],
    passed: false,
    notes: "1 blocker (font).",
  } as unknown as Review;
  row.done(review);
  assert.equal(card().critic.status, "failed");
  assert.equal(card().critic.line, "1 blocker (font).");
  assert.ok(card().critic.endedAt);
  assert.equal(card().review, review);
  row.settle();
  assert.equal(card().critic.status, "failed", "settle leaves a finished row alone");
  assert.ok(saves >= 2 && publishes >= 3);
  const stopped = { turn: { items: [] as Array<unknown> }, cancelled: true } as unknown as Running;
  const other = criticRow(
    stopped,
    3,
    () => {},
    () => {},
  );
  other.settle();
  assert.deepEqual(
    [
      (stopped.turn.items[0] as { card: { critic: { status: string; line: string } } }).card.critic.status,
      (stopped.turn.items[0] as { card: { critic: { line: string } } }).card.critic.line,
    ],
    ["error", "Stopped with the turn."],
  );
});

test("the row's words: status and elapsed time", () => {
  const review = (blockers: number, passed = false) =>
    ({
      round: 1,
      scores: {},
      defects: [],
      blockers: Array.from({ length: blockers }, () => ({ kind: "font", what: "x", source: "critic" })),
      passed,
    }) as unknown as Review;
  assert.equal(criticLabel("running", undefined), "Running");
  assert.equal(criticLabel("passed", review(0, true)), "Passed");
  assert.equal(criticLabel("failed", review(2)), "2 blockers");
  assert.equal(criticLabel("failed", review(1)), "1 blocker");
  assert.equal(criticLabel("failed", review(0)), "Below the bar");
  assert.equal(criticLabel("unresolved", review(2)), "2 unresolved, your call");
  assert.equal(criticLabel("error", undefined), "Didn't run");
  assert.equal(elapsedText(250_000), "4m 10s");
  assert.equal(elapsedText(38_400), "38s");
});
