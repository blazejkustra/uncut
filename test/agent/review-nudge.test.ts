// Round 2's A2: a turn that built a video without a review_submit is reminded once (agentPlan
// reviewNudge); a small request, a Look-only turn or a reviewed turn isn't.
import { test } from "node:test";
import assert from "node:assert/strict";

import { asksNoQuestions, reviewNudge, REVIEW_BUILD } from "../../apps/server/src/agent/agentPlan.ts";

const base = { access: "auto", reviewRounds: 0, graphicWrites: 0, edits: 0, planned: false };

test("a built turn without a review is reminded once; small, look-only, reviewed or stopped turns aren't", () => {
  // A2r2: five revisions of one graphic, no brief, no storyboard.
  assert.match(reviewNudge({ ...base, graphicWrites: 5, unattended: true }) ?? "", /5 graphic writes[\s\S]*review_submit/);
  assert.ok(reviewNudge({ ...base, edits: REVIEW_BUILD.edits }));
  assert.ok(reviewNudge({ ...base, planned: true, edits: 2, storyboard: true }), "a planned video's build");
  assert.equal(reviewNudge({ ...base, planned: true, edits: 1, storyboard: true }), undefined, "one edit");
  assert.equal(reviewNudge({ ...base, planned: true, edits: 2 }), undefined, "a brief and a sound, no storyboard");
  assert.equal(reviewNudge({ ...base, edits: 1 }), undefined, "a small request");
  assert.equal(reviewNudge({ ...base, graphicWrites: 1, edits: 2 }), undefined, "a lower third");
  assert.equal(reviewNudge({ ...base, graphicWrites: 5, nudged: true }), undefined, "once");
  assert.equal(reviewNudge({ ...base, graphicWrites: 5, reviewRounds: 1 }), undefined, "reviewed");
  assert.equal(reviewNudge({ ...base, graphicWrites: 5, access: "look" }), undefined);
  assert.equal(reviewNudge({ ...base, graphicWrites: 5, cancelled: true }), undefined);
  assert.equal(reviewNudge({ ...base, planned: true }), undefined, "planned, nothing built");
  assert.ok(reviewNudge({ ...base, planned: true, graphicWrites: 1, edits: 1, storyboard: true }));
});

test("the nudge says the critic runs anyway when the prompt or brief says nobody can answer; nobody approves a storyboard", () => {
  const attended = reviewNudge({ ...base, graphicWrites: 5 }) ?? "";
  assert.match(attended, /review_submit/);
  assert.doesNotMatch(attended, /nobody can answer|approve/);
  const unattended = reviewNudge({ ...base, graphicWrites: 5, unattended: true }) ?? "";
  assert.match(unattended, /a run where nobody can answer still goes through it/);
  assert.doesNotMatch(unattended, /approve/);
  for (const yes of [
    "Make a launch film. I can't answer questions, decide yourself.",
    "I won’t be around to answer",
    "Nobody will answer, go ahead",
    "Don't ask me anything.",
    "Build it without asking",
    "Run unattended",
    "No questions, please.",
  ])
    assert.ok(asksNoQuestions(yes), yes);
  for (const no of ["Make a launch film", "Answer the FAQ questions in the film", "There are no questions about pricing here", "Ask me before you export"])
    assert.ok(!asksNoQuestions(no), no);
  assert.ok(asksNoQuestions(undefined, "a teaser", "decide yourself on the colours"), "the brief counts");
});
