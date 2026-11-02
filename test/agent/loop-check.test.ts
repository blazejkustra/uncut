// The opt-in loop check: brief.loop (old briefs decode without it), the seam measure on synthetic
// grey frames, and a review that checks the seam only when the brief marks the film as a loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Schema from "../../apps/server/node_modules/effect/dist/Schema.js";

import { Brief } from "../../packages/contracts/src/agent.ts";
import { normBrief } from "../../apps/server/src/brand/store.ts";
import { criticReview, criticText, type CriticAnswer, type CriticInput } from "../../apps/server/src/agent/agentCritic.ts";
import { motionFindings, motionIntent, motionLines, motionScan, seamBroken, seamFrames, type ScanFrame } from "../../apps/server/src/agent/criticMotion.ts";

const FPS = 30;
const SIZE = 64 * 80;
const BRIEF = { film: "A UI morph", audience: "devs", duration: "3 s", formats: ["4:5"], assets: [], visual: "", hardLines: [], deliverables: [] };

/** A film whose texture slides 3 grey levels a frame; `last` replaces its last frame. */
function film(n: number, last?: (first: Uint8Array) => Uint8Array): Array<ScanFrame> {
  const out: Array<ScanFrame> = [];
  for (let f = 0; f < n; f++) {
    const g = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) g[i] = (((i % 64) * 2 + f * 3) % 200) + 20;
    out.push({ frame: f, gray: g });
  }
  if (last) out[n - 1] = { frame: n - 1, gray: last(out[0]!.gray) };
  return out;
}

/** A frame held still for the whole film; `last` replaces its last frame. */
function still(n: number, last: (first: Uint8Array) => Uint8Array): Array<ScanFrame> {
  const g = new Uint8Array(SIZE).map((_, i) => 40 + (i % 64) * 3);
  return Array.from({ length: n }, (_, f) => ({ frame: f, gray: f === n - 1 ? last(g) : g }));
}

/** Up to ±3 grey levels of seeded noise, about what a JPEG round trip leaves on the same picture. */
function noisy(g: Uint8Array): Uint8Array {
  let x = 7;
  return g.map((v) => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return Math.max(0, Math.min(255, v + (x % 7) - 3));
  });
}

/** A box of a quarter of the frame moved off its first position. */
function boxMoved(g: Uint8Array): Uint8Array {
  const out = new Uint8Array(g);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 32; x++) out[y * 64 + x] = 250;
  return out;
}

const ANSWER: CriticAnswer = {
  scores: { hook: 9, readability: 9, motion: 9, variety: 9, sound: 9, brand: 9 },
  evidence: {},
  blockers: [],
  defects: [],
  fixes: [],
  summary: "",
  unproven: [],
};

function review(frames: Array<ScanFrame>, brief: Brief) {
  const scan = motionScan(frames, FPS);
  const intent = motionIntent({ skills: [], words: brief.film, loop: brief.loop });
  const checks = motionFindings(scan, FPS, intent);
  const input: CriticInput = {
    round: 1,
    canvas: { width: 1080, height: 1350, fps: FPS },
    frames: frames.length,
    brief,
    kit: [],
    claims: [],
    checks,
    determinism: { checked: [], differed: [] },
    images: [],
    motion: { lines: motionLines(scan, FPS, { consecutive: true, loop: intent.loop }), strips: 0 },
  };
  return {
    text: criticText(input),
    round: criticReview(ANSWER, {
      round: 1,
      claims: [],
      checks,
      determinism: { checked: [], differed: [] },
      looked: { sheet: true, phone: true },
      revision: 1,
      turnId: "t",
      fps: FPS,
    }),
  };
}

test("brief.loop is optional: old briefs decode without it, a loop decodes, the store keeps only true", () => {
  const decode = Schema.decodeUnknownSync(Brief);
  assert.equal(decode(BRIEF).loop, undefined);
  assert.equal(decode({ ...BRIEF, loop: true }).loop, true);
  assert.throws(() => decode({ ...BRIEF, loop: "yes" }));
  assert.equal(normBrief(BRIEF)!.loop, undefined);
  assert.equal(normBrief({ ...BRIEF, loop: true })!.loop, true);
  assert.equal("loop" in normBrief({ ...BRIEF, loop: false })!, false);
  assert.equal("loop" in normBrief({ ...BRIEF, loop: "yes" })!, false);
});

test("the seam measure: the same last frame passes, a clearly different one fails, JPEG-size noise passes", () => {
  assert.equal(
    seamBroken(
      motionScan(
        film(60, (g) => new Uint8Array(g)),
        FPS,
      ),
    ),
    false,
    "identical",
  );
  assert.equal(seamBroken(motionScan(film(60, noisy), FPS)), false, "noise on a moving film");
  assert.equal(seamBroken(motionScan(still(60, noisy), FPS)), false, "noise on a still film (no typical step to hide behind)");
  const moving = motionScan(film(60), FPS);
  assert.ok(moving.seam!.diff > 0.05 && seamBroken(moving), `a ramp that never comes back: ${moving.seam!.diff}`);
  assert.ok(seamBroken(motionScan(still(60, boxMoved), FPS)), "a box moved on a still film");
  assert.equal(moving.seam!.frame, 59, "measured at the edit's last frame");
});

test("the seam strip: the last 3 frames, then the first 3", () => {
  assert.deepEqual(seamFrames(90), [87, 88, 89, 0, 1, 2]);
  assert.deepEqual(seamFrames(4), [1, 2, 3, 0]);
  assert.deepEqual(seamFrames(1), [0]);
});

test("a review of a film not marked as a loop never reports its seam", () => {
  const { text, round } = review(film(90), BRIEF);
  assert.doesNotMatch(text, /seam|loop/i);
  assert.equal(round.passed, true);
  assert.deepEqual(round.blockers, []);
});

test("a marked loop whose last frame isn't the first fails the round with the seam at the end of the edit", () => {
  const { text, round } = review(film(90), { ...BRIEF, loop: true });
  assert.match(text, /<brief>[\s\S]*loop: yes, the film is meant to loop[\s\S]*<\/brief>/);
  assert.match(text, /<rubric>[\s\S]*- the loop seam \(motion; the brief marks the film as a loop\)[\s\S]*stops dead[\s\S]*<\/rubric>/);
  assert.match(text, /<motion>[\s\S]*Loop seam: the last frame differs from frame 0 by [\d.]+ %, a visible jump if it loops/);
  assert.equal(round.passed, false);
  const seam = round.blockers!.find((b) => b.kind === "motion");
  assert.ok(seam, JSON.stringify(round.blockers));
  assert.equal(seam!.at, 2.97, "the edit's last frame");
  assert.match(seam!.what, /The loop seam at the end of the edit \(f 89, 2\.97 s\)/);
  assert.match(seam!.what, /Make the last state match the first: the same elements at the same positions/);
});

test("a marked loop whose last frame matches the first passes", () => {
  const { text, round } = review(film(90, noisy), { ...BRIEF, loop: true });
  assert.match(text, /Loop seam: the last frame differs from frame 0 by [\d.]+ %, a clean loop/);
  assert.equal(round.passed, true, JSON.stringify(round.blockers));
});
