// The keynote T3 / A1-noskill3 findings: small words measured and named with their fix (render_frames'
// note, review_submit's finding, facts and the illegible blocker's hint), cuts failing the round when
// the user's own request asks for one take (skills off too), a long still frame in a motion film as a
// finding, and the bare tool name's failed call reported on the next Uncut result.
import { test } from "node:test";
import assert from "node:assert/strict";

import { censusOf, censusList } from "../../packages/core/src/index.ts";
import { censusNear, legibilityFacts, legibilityFindings, legibilityNote, minType } from "../../apps/server/src/agent/agentLegibility.ts";
import { criticReview, parseCritic, reviewNext } from "../../apps/server/src/agent/agentCritic.ts";
import { motionFindings, motionIntent, motionScan, STILL_MAX_S } from "../../apps/server/src/agent/criticMotion.ts";
import { withBareNote } from "../../apps/server/src/agent/agent.ts";

const T3 = [
  { text: "Create a promo video for Uncut from this drone footage", share: 2.9 },
  { text: "Read the brand kit", share: 2.7 },
  { text: "Found the song's beats, 120 BPM", share: 2.7 },
  { text: "Ranked the 6 drone clips", share: 2.7 },
  { text: "Wrote the brief", share: 2.7 },
  { text: "Proposed a storyboard of 6 beats", share: 2.7 },
];

test("census: a reply is checked, listed biggest first and cut", () => {
  assert.equal(censusOf(undefined), undefined);
  assert.equal(censusOf({ small: "x", measured: 1 }), undefined);
  const c = censusOf({ small: [{ text: "a".repeat(80), share: 1.2 }, { text: 3, share: 1 }], measured: 4 });
  assert.deepEqual(c, { small: [{ text: "a".repeat(60), share: 1.2 }], measured: 4 });
  assert.match(censusList(T3, 2), /^"Create a promo video for Uncut from thi…" 2\.9 %, "Read the brand kit" 2\.7 % and 4 more$/);
});

test("render_frames' note names each frame's small words, the floor and the one-call fixes", () => {
  assert.equal(minType(1350), 57);
  const note = legibilityNote([{ frame: 300, small: T3, measured: 8 }, { frame: 600, small: [], measured: 5 }], 1350)!;
  assert.match(note, /words a viewer must read need 3 %\): frame 300: .*"Read the brand kit" 2\.7 %/);
  assert.doesNotMatch(note, /frame 600/);
  assert.match(note, /type under 57 px on this 1350 px canvas/);
  assert.match(note, /"turn\.steps" key/);
  assert.match(note, /uncutUI\.frameText\(el, world, \{ width, height \}\)/);
  assert.equal(legibilityNote([{ frame: 1, small: [], measured: 3 }, { frame: 2 }], 1350), undefined, "nothing small, no note; no census, no note");
});

test("review_submit: one finding with every small frame (never a blocker), the critic's facts, the census near a blocker", () => {
  const list = [{ frame: 315, small: T3, measured: 8 }, { frame: 420, small: [], measured: 9 }, { frame: 1260, small: [{ text: "Hook in 2 s", share: 1.9 }], measured: 12 }];
  const [f, ...rest] = legibilityFindings(list, 60, 1350);
  assert.equal(rest.length, 0);
  assert.equal(f!.hard, false);
  assert.equal(f!.rule, "legibility");
  assert.match(f!.message, /Small text in 2 of the contact sheet's frames .*f 315 \(5\.3 s\): .*f 1260 \(21\.0 s\): "Hook in 2 s" 1\.9 %/);
  assert.match(f!.message, /fix them all in this round, not one per round/);
  assert.match(legibilityFacts(list, 60)[0]!, /Words measured on the graphics .*f 315 \(5\.3 s\)/);
  assert.match(legibilityFacts([{ frame: 1, small: [], measured: 4 }], 60)[0]!, /none under 3 % among the DOM words of the 1 contact-sheet frames measured\./);
  assert.match(legibilityFacts([{ frame: 1, small: [], measured: 4, unseen: 1 }], 60)[0]!, /1 frames also show canvases, images or unmeasured graphics: their words are unknown/);
  assert.match(legibilityFacts([{ frame: 1, measured: 0, unseen: 2 }], 60)[0]!, /weren't measured.*canvas/, "only a canvas: said, never 'none under'");
  assert.equal(censusNear([{ frame: 420, small: [], measured: 0 }], 7, 60), undefined, "nothing measured is no claim");
  assert.match(censusNear([{ frame: 420, small: [], measured: 3, unseen: 1 }], 7, 60)!, /no graphic word under 3 % \(text drawn on a canvas/);
  assert.match(legibilityNote([{ frame: 9, unseen: 1 }], 1350)!, /^On frame 9, text drawn on a canvas/);
  assert.deepEqual(legibilityFacts([{ frame: 1 }], 60), [], "no graphics measured: no fact");
  assert.deepEqual(legibilityFindings([{ frame: 1, small: [], measured: 4 }], 60, 1350), []);
  assert.match(censusNear(list, 21.1, 60)!, /measured at f 1260: "Hook in 2 s" 1\.9 %/);
  assert.match(censusNear(list, 7, 60)!, /measured at f 420: no graphic word under 3 %/);
  assert.equal(censusNear(list, 12, 60), undefined, "nothing measured within half a second");
});

test("reviewNext: an illegible blocker gets the measured place and the one-call fix", () => {
  const all = { hook: 9, readability: 9, motion: 9, variety: 9, sound: 9, brand: 9 };
  const scores = Object.fromEntries(Object.entries(all).map(([k, n]) => [k, { score: n, evidence: "f 1" }]));
  const ctx = { round: 1, claims: [], checks: [], determinism: { checked: [], differed: [] }, looked: { sheet: true, phone: true }, revision: 4, turnId: "t1", fps: 60 };
  const r = criticReview(parseCritic(JSON.stringify({ scores, blockers: [{ kind: "illegible", what: "The review card is desktop scale, 2 % tall.", at: 21 }] })) as never, ctx);
  const next = reviewNext(r, 1, true, () => "f 1260; measured at f 1260: \"Hook in 2 s\" 1.9 %", { width: 1080, height: 1350, safe: 72 });
  assert.match(next, /d1 illegible at 21 s \(f 1260; measured at f 1260: "Hook in 2 s" 1\.9 %\)/);
  assert.match(next, /Text too small \(d1\): .*uncutUI\.frameText\(el, world/);
  assert.match(next, /fix every moment it lists, not only the one blocked/);
  const edge = criticReview(parseCritic(JSON.stringify({ scores, blockers: [{ kind: "blank", what: "Empty", at: 4 }] })) as never, ctx);
  assert.doesNotMatch(reviewNext(edge, 1, true, undefined, { width: 1080, height: 1350, safe: 72 }), /Text too small/);
});

/** Grey frames moving every frame, with hard cuts and still stretches ([from, to]) where asked. */
function frames(n: number, o: { cuts?: ReadonlyArray<number>; still?: ReadonlyArray<readonly [number, number]> }) {
  const size = 64 * 80;
  const out: Array<{ frame: number; gray: Uint8Array }> = [];
  for (let f = 0; f < n; f++) {
    const shot = (o.cuts ?? []).filter((c) => f >= c).length;
    const hold = (o.still ?? []).find(([a, b]) => f >= a && f <= b);
    const k = hold ? hold[0] : f;
    const g = new Uint8Array(size);
    for (let i = 0; i < size; i++) g[i] = ((((i % 64) * (3 + shot * 2) + Math.floor(i / 64) * shot * 5 + k) % 100) + 20);
    out.push({ frame: f, gray: g });
  }
  return out;
}

test("A1-noskill3: the user's own 'one take' makes cuts fail the round with the skill off", () => {
  const asked = motionIntent({ skills: [], words: "A launch film.", request: "Make a 28s launch film for Uncut, this app: one take on the beat." });
  assert.equal(asked.asked, true);
  assert.equal(asked.oneTake, true);
  const brief = motionIntent({ skills: [], words: "One continuous graphic, no cuts in the UI", request: "Make a launch film." });
  assert.equal(brief.asked, false, "the brief's words make it one take, not the user's ask");
  assert.equal(brief.oneTake, true);
  const fps = 60;
  const scan = motionScan(frames(600, { cuts: [200, 260, 320] }), fps);
  assert.ok(scan.jumps.length >= 3);
  const hard = motionFindings(scan, fps, { ...asked, hard: false || asked.asked }).filter((x) => x.key?.startsWith("motion:jump"));
  assert.ok(hard.length >= 3 && hard.every((x) => x.hard), "cuts block");
  const soft = motionFindings(scan, fps, { ...brief, hard: false || brief.asked }).filter((x) => x.key?.startsWith("motion:jump"));
  assert.ok(soft.length >= 3 && soft.every((x) => !x.hard), "without the ask or the skill, cuts are findings");
});

test("one take in the request: asked conservatively, negations, alternatives and crops aren't", () => {
  const ask = (request: string) => motionIntent({ skills: [], words: "", request }).asked;
  for (const yes of ["one take on the beat", "One-take launch film", "a single continuous shot", "one unbroken camera move", "no cuts", "never cut, keep it flowing", "without any cuts", "do not cut between scenes", "with no hard cuts", "single take", "Make a film.\n\nThen, this turn: make it one take"])
    assert.equal(ask(yes), true, yes);
  for (const no of ["not one take", "It doesn't need to be one take", "one take or cuts, your call", "cuts or one take, up to you", "never cut off the text at the edge", "don't cut out the logo", "One take. Actually, cuts are fine.", "one take\n\nThen, this turn: add a hard cut at the drop", "fast cuts on the beat", "the Uncut launch film", "one-shot a promo for Uncut", "no cutscenes", "jedno ujęcie"])
    assert.equal(ask(no), false, no);
  assert.equal(motionIntent({ skills: [], words: "Cuts on the beat, not one take" }).oneTake, false, "the brief's words read the same way");
});

test("a still frame over STILL_MAX_S in a motion film is a finding, the longest holds listed first", () => {
  const fps = 30;
  assert.equal(STILL_MAX_S, 4);
  // A 2 s hold early (time order would list it first; a third later one too), then a 5 s end card.
  const scan = motionScan(frames(300, { still: [[20, 80], [100, 140], [148, 299]] }), fps);
  const holds = [...scan.holds].sort((a, b) => b.end - b.start - (a.end - a.start));
  assert.ok(holds.length >= 1 && (holds[0]!.end - holds[0]!.start) / fps >= STILL_MAX_S, JSON.stringify(scan.holds));
  for (const oneTake of [true, false]) {
    const still = motionFindings(scan, fps, { oneTake, still: STILL_MAX_S }).filter((x) => x.key?.startsWith("motion:still"));
    assert.equal(still.length, 1, `oneTake ${oneTake}`);
    assert.equal(still[0]!.hard, false);
    assert.match(still[0]!.message, /One still frame from f 148 to f 299 .*nothing on screen moves for over 4 s/);
  }
  assert.equal(motionFindings(scan, fps, { oneTake: false }).filter((x) => x.key?.startsWith("motion:still")).length, 0, "not a motion film: no finding");
});

test("a bare-name call's failure is reported once on the next Uncut result, with the full name", () => {
  const r: { bareCalls?: Array<string> } = { bareCalls: ["graphic_write", "graphic_write"] };
  const out = withBareNote(r, { content: [{ type: "text" as const, text: "ok" }] });
  assert.equal(out.content.length, 2);
  assert.match((out.content[1] as { text: string }).text, /your call to graphic_write by the short name failed \("No such tool available"\) and did nothing\. .*mcp__uncut__graphic_write/);
  assert.deepEqual(r.bareCalls, []);
  const again = withBareNote(r, { content: [{ type: "text" as const, text: "ok" }] });
  assert.equal(again.content.length, 1, "said once");
});
