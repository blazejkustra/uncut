// The user's messages ride along word for word every turn (D341), and the prompt's rules for following them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { answerOut, DIRECTION_CHARS, DIRECTIONS_CHARS, directionsBlock } from "../../apps/server/src/agent/agentPlan.ts";
import { SYSTEM_PROMPT } from "../../apps/server/src/agent/agentTools.ts";
import { COMPACT_HOOKS } from "../../apps/server/src/agent/permissions/settings.ts";
import { EXTERNAL_PROMPT } from "../../apps/server/src/agent/session/types.ts";
import { HAND_EDITS_KEPT } from "../../packages/core/src/timeline/edit-log.ts";

type Prompted = Parameters<typeof directionsBlock>[0][number];
const turn = (prompt: string, day = 20, kind?: "compact"): Prompted => ({
  prompt,
  startedAt: `2026-11-${day}T10:00:00.000Z`,
  ...(kind ? { kind } : {}),
});

test("no earlier message: no block", () => {
  assert.equal(directionsBlock([]), "");
  assert.equal(directionsBlock([turn("/compact", 20, "compact")]), "");
});

test("each message is kept word for word with its turn number and date, newest last", () => {
  const block = directionsBlock([turn("you can use commercial music"), turn("  download some music that is viral\nand keep it loud  ", 21)]);
  assert.match(block, /^<directions>\n/);
  assert.match(block, /\n<\/directions>$/);
  assert.match(block, /Turn 1, 2026-11-20: you can use commercial music\nTurn 2, 2026-11-21: download some music that is viral\nand keep it loud\n/);
  assert.match(block, /never replace them/);
});

test("a /compact turn isn't a direction and doesn't take a turn number", () => {
  const block = directionsBlock([turn("no colour grading"), turn("/compact", 21, "compact"), turn("stop cropping", 22)]);
  assert.doesNotMatch(block, /\/compact/);
  assert.match(block, /Turn 1, 2026-11-20: no colour grading\nTurn 2, 2026-11-22: stop cropping/);
});

test("an outside agent's turns aren't the user's messages", () => {
  const block = directionsBlock([turn("no colour grading"), turn(EXTERNAL_PROMPT, 21), turn("stop cropping", 22)]);
  assert.doesNotMatch(block, /outside agent/);
  assert.match(block, /Turn 1, 2026-11-20: no colour grading\nTurn 2, 2026-11-22: stop cropping/);
  assert.equal(directionsBlock([turn(EXTERNAL_PROMPT)]), "");
});

test("a long message is cut, and past the total the oldest ones go first", () => {
  const long = "x".repeat(DIRECTION_CHARS + 500);
  const one = directionsBlock([turn(long)]);
  assert.ok(one.includes(`${"x".repeat(DIRECTION_CHARS)}…`));
  assert.ok(!one.includes("x".repeat(DIRECTION_CHARS + 1)));

  const many = Array.from({ length: 40 }, (_, i) => turn(`direction ${i + 1} ${"y".repeat(300)}`));
  const block = directionsBlock(many);
  const lines = block.split("\n").filter((l) => l.startsWith("Turn "));
  assert.ok(lines.join("\n").length <= DIRECTIONS_CHARS);
  assert.match(lines.at(-1)!, /^Turn 40, [^:]*: direction 40 /, "the newest is kept");
  assert.doesNotMatch(block, /Turn 1, /, "the oldest is left out");
  assert.match(block, new RegExp(`\\(${40 - lines.length} older ones left out\\)`));
});

test("a compaction mid-conversation loses nothing: the next turn's block still has every earlier message", () => {
  const before = [turn("make sure my camera is not hiding the cursor"), turn("simply finish editing this video", 21)];
  const after = [...before, turn("/compact", 22, "compact"), turn("fix the captions", 23)];
  for (const line of directionsBlock(before)
    .split("\n")
    .filter((l) => l.startsWith("Turn ")))
    assert.ok(directionsBlock(after).includes(line), `kept after the compaction: ${line}`);
  assert.match(directionsBlock(after), /Turn 3, 2026-11-23: fix the captions/);
  assert.match(COMPACT_HOOKS.SessionStart[0]!.hooks[0]!.command, /plan_read and brand_read, follow the messages of the user that plan_read lists/);
});

test("the system prompt says how to follow directions", () => {
  assert.match(SYSTEM_PROMPT, /If you don't do something the user asked \(can't, won't or chose otherwise\), the reply's first sentence says so and why/);
  assert.match(SYSTEM_PROMPT, /Never build a substitute they didn't pick: leave it empty/);
  assert.match(SYSTEM_PROMPT, /After a skipped question, never pick something you didn't offer/);
  assert.match(SYSTEM_PROMPT, /A complaint about something [^\n]*find its cause first[^\n]*never add more of it/);
  assert.match(SYSTEM_PROMPT, /A constraint the user states [^\n]*is never traded off; if it can't be met, the reply's first sentence says so/);
  assert.match(SYSTEM_PROMPT, /To call a check warning or critic finding wrong, first measure or render that exact range again and quote the result/);
  assert.match(SYSTEM_PROMPT, /A "why" or "how did this happen" question gets an answer and an offer, no edit/);
  assert.match(SYSTEM_PROMPT, /Ask once about one that looks like a mistake, then leave it/);
  assert.match(SYSTEM_PROMPT, /first anything asked that you didn't do, then what you changed/);
  assert.match(SYSTEM_PROMPT, /<directions> \(the user's earlier messages word for word/);
  assert.doesNotMatch(SYSTEM_PROMPT, /—/);
});

test("a skipped question never ends in an option that wasn't offered, and hand edits are asked about once", () => {
  const out = answerOut({ question: "Which music?", options: [{ label: "Your own track" }], multi: false, freeText: true }, "skipped");
  assert.equal(out.answered, false);
  assert.match(String((out as { next?: string }).next), /one of the options you offered[^\n]*Never pick something you didn't offer/);
  assert.match(HAND_EDITS_KEPT, /ask about it once; after that leave it and don't ask again/);
  assert.doesNotMatch(HAND_EDITS_KEPT, /question them/);
});
