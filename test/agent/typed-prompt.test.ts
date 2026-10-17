// A1-noskill4: "show me typing this prompt" and the film typed an invented prompt the critic
// didn't flag. The ask read from the user's own message (English, conservative), the composer's
// text read from the graphics' source, a mismatch a blocker with the user's words as the fix.
import { test } from "node:test";
import assert from "node:assert/strict";

import { asksTypedPrompt, composerTexts, quotedAsk, typedMatches, typedPromptAsk, typedPromptCheck } from "../../apps/server/src/agent/agentTypedPrompt.ts";
import { criticReview, criticText, parseCritic, CRITIC_SYSTEM } from "../../apps/server/src/agent/agentCritic.ts";

const A1 = "Make a 28s launch film for Uncut, this app: one take on the beat, show me typing this prompt and the agent editing the video.";

// Modeled on A1-noskill4's graphics/film-15.html (lines 40 and 131).
const FILM = `<script>
const W = 1080, H = 1350, M = uncutMotion;
const PROMPT = "Cut a travel film from the drone shots, on the beat";
const keys = [
    { at: 0, piece: "composer", y: 880, props: { text: PROMPT, caret: true }, typing: { at: 0, dur: 3.4, from: 9 } },
    { at: SEND, piece: "message", y: 700, props: { text: PROMPT } },
];
</script>`;

test("typed prompt: the request asks to show itself typed", () => {
  for (const yes of [
    A1,
    "Make a promo of me typing my prompt into Uncut",
    "Film the prompt I typed being entered, then the edit",
    "show what I just wrote being typed in the composer",
    "Type this exact request in the composer and send it.",
  ])
    assert.equal(asksTypedPrompt(yes), true, yes);
  for (const no of [
    "Make a launch film, one take, show me typing a prompt and the agent editing",
    "show someone typing any prompt",
    "Show typing the prompt and the agent editing the video",
    "Type this prompt: 'Cut my drone clips on the beat'",
    'show me typing this prompt "make it warm"',
    "Don't show my prompt being typed, just the edit",
    "Make a 28s launch film from my drone clips, on the beat",
    "Montre-moi en train de taper ce prompt",
    "Use my brand kit and the words from my brief",
  ])
    assert.equal(asksTypedPrompt(no), false, no);
  // The last message that asks is the one to type; "Your call." on a later turn changes nothing.
  assert.equal(typedPromptAsk([A1, "Your call.", undefined]), A1);
  assert.equal(typedPromptAsk(["Make a film", "faster please"]), undefined);
});

test("typed prompt: the same words, or the start cut with an ellipsis", () => {
  assert.equal(typedMatches(A1, A1), true);
  assert.equal(typedMatches("make a 28s launch film for Uncut, this app: one take on the beat, show me typing this prompt and the agent editing the video", A1), true);
  assert.equal(typedMatches("Make a 28s launch film for Uncut, this app…", A1), true);
  assert.equal(typedMatches("Make a 28s launch film for Uncut, this app", A1), false, "cut without an ellipsis");
  assert.equal(typedMatches("Make a 28s…", A1), false, "too little kept");
  assert.equal(typedMatches("Cut a travel film from the drone shots, on the beat", A1), false);
  assert.equal(typedMatches("Cut my drone clips into a reel on the beat, warm look", A1), false);
  assert.equal(typedMatches("Make it pop…", "Make it pop, please"), false, "a short request is typed whole");
  assert.equal(typedMatches("Make it pop!", "make it pop"), true);
  assert.equal(quotedAsk(A1), A1);
  assert.match(quotedAsk(`${A1} ${A1}`), /^Make a 28s .*…$/);
  assert.ok(quotedAsk(`${A1} ${A1}`).length <= 161);
});

test("typed prompt: the composer's text read from the graphic's source", () => {
  assert.deepEqual(composerTexts([FILM]), { texts: ["Cut a travel film from the drone shots, on the beat"], composer: true });
  assert.deepEqual(composerTexts([`uncutUI.editor({ composer: { text: 'It\\'s a reel', caret: true } })`]), { texts: ["It's a reel"], composer: true });
  assert.deepEqual(composerTexts([`const typedPrompt = \`Cut my drone clips on the beat\`; el.textContent = typedPrompt.slice(0, n);`]), { texts: ["Cut my drone clips on the beat"], composer: false });
  assert.deepEqual(composerTexts([`const PROMPT_Y = 880; const title = "Edit videos by talking";`]), { texts: [], composer: false });
});

test("typed prompt: a mismatch is an invented blocker with the user's words as the fix", () => {
  const bad = typedPromptCheck([A1], [FILM]);
  assert.equal(bad.findings.length, 1);
  const f = bad.findings[0]!;
  assert.equal(f.hard, true);
  assert.equal(f.rule, "typed-prompt");
  assert.match(f.message, /types "Cut a travel film from the drone shots, on the beat", not the user's words/);
  assert.ok(f.message.includes(`type the user's own words in the composer: "${A1}"`));
  const review = criticReview(parseCritic('{"scores":{"hook":8,"readability":8,"motion":8,"variety":8,"sound":8,"brand":8},"blockers":[],"defects":[],"fixes":[],"summary":"ok"}') as never, { round: 1, claims: [], checks: bad.findings, determinism: { checked: [], differed: [] }, looked: { sheet: true, phone: true }, revision: 1, turnId: "t", fps: 60 });
  assert.equal(review.passed, false);
  assert.equal(review.blockers?.[0]?.kind, "invented");
  const text = criticText({ round: 1, canvas: { width: 1080, height: 1350, fps: 60 }, frames: 1680, kit: [], claims: [], checks: bad.findings, determinism: { checked: [], differed: [] }, images: [], request: A1 });
  assert.match(text, /<layout-checks>\nfails: The request asks to show its own prompt being typed/);
  assert.match(CRITIC_SYSTEM, /asks to show its own prompt being typed/);

  const good = typedPromptCheck([A1], [FILM.replace("Cut a travel film from the drone shots, on the beat", "Make a 28s launch film for Uncut, this app: one take on the beat…")]);
  assert.deepEqual(good.findings, []);
  assert.match(good.facts[0]!, /measured in the graphics' source: the composer text is the user's message/);

  // Not asked: a made-up prompt is fine, nothing said.
  assert.deepEqual(typedPromptCheck(["Make a 28s launch film for Uncut, one take on the beat, show me typing a prompt"], [FILM]), { facts: [], findings: [] });
  // Nothing to read: the critic reads the frames.
  assert.match(typedPromptCheck([A1], []).facts[0]!, /no graphic source/);
  assert.match(typedPromptCheck([A1], ["<div>hello</div>"]).facts[0]!, /no composer text .* not the request's words either/);
});
