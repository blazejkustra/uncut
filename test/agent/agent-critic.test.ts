// D195–D196 pure parts: the critic's answer read strictly (evidence per score, blocker kinds), the
// round's verdict (blockers cap scores and fail it, Uncut's hard layout findings and unconfirmed fix
// claims are blockers), what the critic's message carries, its command line, and the layout checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectChecks, CHECK_IDS, LAYOUT_RULES, LAYOUT_HARD } from "../../packages/core/src/index.ts";
import {
  CRITIC_MARKER,
  CRITIC_SYSTEM,
  criticArgs,
  criticMessage,
  criticReview,
  criticText,
  parseCritic,
  reviewNext,
  type CriticInput,
} from "../../apps/server/src/agent/agentCritic.ts";
import { planContext } from "../../apps/server/src/agent/agentPlan.ts";

const ev = (score: number) => ({ score, evidence: "f 0, f 30: fine" });
const all = (n: number) => ({ hook: ev(n), readability: ev(n), motion: ev(n), variety: ev(n), sound: ev(n), brand: ev(n) });
const ctx = {
  round: 1,
  claims: [],
  checks: [],
  determinism: { checked: [], differed: [] },
  looked: { sheet: true, phone: true },
  revision: 4,
  turnId: "t1",
  fps: 30,
};

test("parseCritic: fenced or bare JSON, evidence required per score, unknown blocker kinds are other", () => {
  const a = parseCritic(
    `Sure.\n\`\`\`json\n${JSON.stringify({
      scores: all(9),
      blockers: [
        { kind: "font", what: "Falls back to Helvetica", at: 2 },
        { kind: "weird", what: "x" },
      ],
      defects: [{ at: 1, what: "slow" }],
      summary: "ok",
    })}\n\`\`\``,
  );
  assert.ok(!("problem" in a));
  assert.equal(a.scores.hook, 9);
  assert.deepEqual(
    a.blockers.map((b) => b.kind),
    ["font", "other"],
  );
  const noEvidence = parseCritic(JSON.stringify({ scores: { ...all(10), sound: { score: 10, evidence: "great" }, brand: 10 } }));
  assert.ok(!("problem" in noEvidence));
  assert.equal(noEvidence.scores.sound, 7, "no frames cited: under the bar");
  assert.equal(noEvidence.scores.brand, 7);
  assert.deepEqual(noEvidence.unproven, ["sound", "brand"]);
  assert.ok("problem" in parseCritic("Looks great!"));
  assert.ok("problem" in parseCritic(JSON.stringify({ scores: { hook: ev(9) } })), "a missing score is no answer");
});

test("criticReview: any blocker fails whatever the scores and caps its score; hard layout findings and unconfirmed fixes are blockers", () => {
  const clean = parseCritic(JSON.stringify({ scores: all(9) }));
  assert.ok(!("problem" in clean));
  assert.equal(criticReview(clean, ctx).passed, true);
  assert.equal(criticReview(clean, { ...ctx, determinism: { checked: ["g"], differed: ["g"] } }).passed, false, "a graphic that drew differently fails");
  const blocked = parseCritic(
    JSON.stringify({ scores: all(10), blockers: [{ kind: "placeholder", what: "Empty phone", at: 3 }], defects: [{ at: 1, what: "slow" }] }),
  );
  assert.ok(!("problem" in blocked));
  const r = criticReview(blocked, {
    ...ctx,
    checks: [
      { rule: "layout-off-centre", message: "off by 40 px", frame: 45, hard: true },
      { rule: "layout-word-overflow", message: "maybe", hard: false },
    ],
  });
  assert.equal(r.passed, false);
  assert.equal(r.by, "critic");
  assert.equal(r.scores.brand, 5);
  assert.equal(r.scores.readability, 5);
  assert.equal(r.scores.hook, 10);
  assert.deepEqual(
    r.blockers!.map((b) => [b.id, b.kind, b.source, b.at]),
    [
      ["d1", "placeholder", "critic", 3],
      ["d2", "off-centre", "check", 1.5],
    ],
  );
  assert.equal(r.defects[0]!.id, "d3");
  assert.match(reviewNext(r), /Blockers \(any one fails the round\): d1 placeholder at 3 s: Empty phone; d2 off-centre/);
  assert.match(reviewNext(r, 3), /in this turn, the last one[\s\S]*Don't say it passed/);
  // Claims: the one the critic confirmed holds, the one it didn't mention is a blocker.
  const fixes = parseCritic(JSON.stringify({ scores: all(9), fixes: [{ defect: "d1", verified: true }] }));
  assert.ok(!("problem" in fixes));
  const f = criticReview(fixes, {
    ...ctx,
    round: 2,
    claims: [
      { defect: "d1", what: "added the recording", at: 3 },
      { defect: "d2", what: "centred it", at: 1.5 },
    ],
  });
  assert.equal(f.passed, false);
  assert.deepEqual(
    f.fixes!.map((x) => [x.defect, x.verified]),
    [
      ["d1", true],
      ["d2", false],
    ],
  );
  assert.equal(f.blockers![0]!.kind, "unverified-fix");
  assert.match(f.blockers![0]!.what, /d2 isn't visible on the new frames: The critic didn't confirm it/);
});

test("the critic's message has the brief, kit, storyboard, rubric and claims only; its command line has no tools, MCP, session or settings", () => {
  const input: CriticInput = {
    round: 2,
    canvas: { width: 1080, height: 1350, fps: 30 },
    frames: 450,
    brief: {
      film: "Argent in 15 s",
      audience: "devs",
      duration: "15 s",
      formats: ["4:5"],
      assets: ["demo"],
      visual: "dark",
      hardLines: ["no fake UI"],
      deliverables: [],
    },
    kit: ['Kit "Argent"', "Fonts: DM Sans for headline"],
    previous: {
      round: 1,
      scores: { hook: 9, readability: 5, motion: 8, variety: 8, sound: 8, brand: 5 },
      defects: [{ id: "d2", at: 1, what: "slow" }],
      blockers: [{ id: "d1", kind: "font", what: "Helvetica", source: "critic" }],
      passed: false,
      at: "x",
    },
    claims: [{ defect: "d1", what: "loaded DM Sans", was: "Helvetica" }],
    checks: [],
    determinism: { checked: [], differed: [] },
    images: [
      { label: "contact sheet", jpeg: Buffer.from("a") },
      { label: "frame 0", jpeg: Buffer.from("b") },
    ],
  };
  const text = criticText(input);
  assert.match(text, /^Round 2\. The video: 1080×1350 at 30 fps, 15\.0 s/);
  assert.match(text, /<brief>\nfilm: Argent in 15 s/);
  assert.match(text, /Fonts: DM Sans for headline/);
  assert.match(text, /<last-round 1>\nd1 \(blocker, font\): Helvetica\nd2 at 1 s: slow/);
  assert.match(text, /<claimed-fixes>[\s\S]*d1, was: Helvetica; the editor: loaded DM Sans/);
  assert.match(text, /Image 1: contact sheet\nImage 2: frame 0/);
  assert.ok(!/[·•]/.test(text + CRITIC_SYSTEM));
  const msg = criticMessage(input);
  assert.deepEqual(
    msg.message.content.map((c) => c.type),
    ["text", "image", "image"],
  );
  const args = criticArgs("opus");
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.ok(args.includes("--strict-mcp-config") && args.includes("--no-session-persistence") && !args.includes("--mcp-config") && !args.includes("--resume"));
  assert.ok(args[args.indexOf("--system-prompt") + 1]!.startsWith(CRITIC_MARKER));
  assert.ok(!args.includes("--append-system-prompt"), "the critic's prompt replaces Claude Code's");
  assert.equal(args.at(-1), "opus");
  // The builder's next message lists the critic's findings by id.
  const plan = { reviews: [{ ...input.previous!, by: "critic" as const }] };
  assert.match(
    planContext({ files: {}, skills: [], others: [] }, plan),
    /Last review \(Uncut's critic\): round 1[\s\S]*\(not passed\)\.\nd1 blocker font: Helvetica\nd2 at 1 s: slow/,
  );
});

const project = (texts: Array<Record<string, unknown>>, clips: Array<Record<string, unknown>> = []) =>
  ({
    format: "uncut.project/1",
    canvas: { width: 1920, height: 1080, fps: 30 },
    media: [],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: texts.map((t, i) => ({ id: `t${i}`, type: "text", start: 0, duration: 60, ...t })) },
      {
        id: "v2",
        kind: "video",
        name: "V2",
        items: clips.map((c, i) => ({ id: `c${i}`, type: "graphic", src: "graphics/a.html", start: 0, duration: 60, ...c })),
      },
      { id: "main", kind: "video", role: "main", name: "Main", items: [] },
    ],
  }) as never;
const layoutOf = (p: never) => projectChecks(p, { rules: LAYOUT_RULES, disabled: CHECK_IDS });

test("layout checks: off-centre centred text, a round text box, a word wider than its box, a box off the canvas", () => {
  const found = layoutOf(
    project(
      [
        { text: "Argent Cloud", transform: { x: 500, y: 400, w: 1000 }, style: { size: 90, align: "center" } },
        { text: "Centred", transform: { x: 460, y: 600, w: 1000 }, style: { size: 90, align: "center" } },
        { text: "→", transform: { x: 900, y: 800 }, style: { size: 60, background: { color: "#fff", padding: 40, radius: 999 } } },
        { text: "Supercalifragilistic", transform: { x: 100, y: 100, w: 300 }, style: { size: 80 } },
        { text: "Edge", transform: { x: 1800, y: 100, w: 400 }, style: { size: 60 } },
        { text: "Gone", transform: { x: 2400, y: 100, w: 400 }, style: { size: 60 } },
      ],
      [{ transform: { x: -200, y: 0, w: 800, h: 600 } }],
    ),
  );
  const keys = found.map((c) => c.key);
  assert.ok(keys.includes("layout-off-centre:t0"));
  assert.ok(!keys.includes("layout-off-centre:t1"), "a centred box is fine");
  assert.match(found.find((c) => c.key === "layout-off-centre:t0")!.message, /40 px right of the frame's centre/);
  assert.match(found.find((c) => c.key === "layout-round-text-box:t2")!.message, /draws as an oval/);
  assert.ok(keys.includes("layout-word-overflow:t3"));
  assert.ok(keys.includes("layout-off-canvas:t4"));
  assert.ok(!keys.includes("layout-off-canvas:t5"), "entirely outside is an entrance, not a cut-off");
  assert.ok(keys.includes("layout-off-canvas:c0"));
  assert.ok(LAYOUT_HARD.has("layout-off-centre") && LAYOUT_HARD.has("layout-round-text-box") && !LAYOUT_HARD.has("layout-word-overflow"));
});

// Rehearsal 4: plain Claude iterates without limit; three rounds are a floor, six a ceiling, and
// past three a turn goes on only while the blockers shrink.
test("review rounds: past 3 only while the blockers go down or change, never past 6", async () => {
  const { mayReviewAgain, REVIEW_ROUNDS, REVIEW_ROUNDS_MAX } = await import("../../apps/server/src/agent/agentCritic.ts");
  const b = (n: number, passed = false) => ({ passed, blockers: Array.from({ length: n }, () => ({})) });
  assert.equal(REVIEW_ROUNDS, 3);
  assert.equal(REVIEW_ROUNDS_MAX, 6);
  assert.equal(mayReviewAgain([b(5), b(5)]), true, "under 3: always");
  assert.equal(mayReviewAgain([b(5), b(4), b(2)]), true, "shrinking");
  assert.equal(mayReviewAgain([b(5), b(4), b(4)]), false, "stalled");
  assert.equal(mayReviewAgain([b(5), b(2), b(3)]), false, "grew");
  assert.equal(mayReviewAgain([b(5), b(2), b(0)]), true, "blockers fell to 0 with scores under the bar: go on (round 4's A1)");
  assert.equal(mayReviewAgain([b(9), b(8), b(7), b(6), b(5)]), true);
  assert.equal(mayReviewAgain([b(9), b(8), b(7), b(6), b(5), b(4)]), false, "the ceiling");
  // The turn's own count rules (review): a round whose review couldn't be saved still counts.
  assert.equal(mayReviewAgain([b(9), b(8), b(7)], 6), false, "6 rounds run, 3 saved: the ceiling still holds");
  assert.equal(mayReviewAgain([b(9), b(8), b(7)], 4), false, "an unsaved round can't show the blockers going down");
  assert.equal(mayReviewAgain([b(5)], 2), true, "under 3 by the turn's count: always");
  assert.equal(mayReviewAgain([b(5), b(5)], 3), false, "3 run (one unsaved): past the floor, nothing shows it converging");
  assert.equal(mayReviewAgain([b(9), b(8), b(7), b(6)], 4), true, "all saved and shrinking");
  const r = criticReview(parseCritic(JSON.stringify({ scores: all(9), blockers: [{ kind: "blank", what: "Empty frame", at: 4.2 }] })) as never, ctx);
  assert.match(reviewNext(r, 3, true), /Not passed\. Another round is open \(round 3 of at most 6\)/);
  assert.match(reviewNext(r, 4, false), /round 4 in this turn, the last one \(round 4 of at most 6; past 3 rounds a turn goes on only while it converges/);
  assert.match(reviewNext(r, 3), /the last one/, "the default stays 3");
});

// Round 4's A1: blockers 4, 2, 0 with motion 7 < 8 stopped at round 3 and the agent said "the round 3 limit".
test("review rounds: no blockers left but under the bar goes on when blockers fell or scores rose, and says why", async () => {
  const { reviewOutlook } = await import("../../apps/server/src/agent/agentCritic.ts");
  const round = (n: number, motion: number) => ({
    passed: false,
    blockers: Array.from({ length: n }, (_, i) => ({ at: i })),
    scores: { hook: 8, readability: 8, motion, variety: 8, sound: 8, brand: 8 },
  });
  const a1 = reviewOutlook([round(4, 5), round(2, 6), round(0, 7)]);
  assert.equal(a1.more, true);
  assert.equal(a1.why, "round 3 of at most 6: the blockers fell to 0 but motion 7 < 8 is under the bar, so round 4 of 6 is available");
  const rose = reviewOutlook([round(4, 5), round(2, 6), round(0, 6), round(0, 7)]);
  assert.equal(rose.more, true, rose.why);
  assert.match(rose.why, /no blockers and the scores came closer to the bar \(motion 6 < 8 before, motion 7 < 8 now\), so round 5 of 6/);
  const flat = reviewOutlook([round(4, 5), round(2, 6), round(0, 7), round(0, 7)]);
  assert.deepEqual(flat, { more: false, why: "round 4 of at most 6: no blockers, but the scores under the bar didn't improve (motion 7 < 8)" });
  assert.match(reviewOutlook([round(3, 5), round(2, 5), round(2, 5)]).why, /the same blockers came back$/);
  assert.match(reviewOutlook([round(1, 5), round(2, 5), round(3, 5)]).why, /the blockers grew from 2 to 3$/);
  assert.match(reviewOutlook([round(0, 5), round(0, 6), round(0, 7), round(0, 7.5), round(0, 7.8), round(0, 7.9)]).why, /6 rounds is the cap$/);
  assert.match(reviewOutlook([round(4, 5)]).why, /the first 3 are always open, so round 2 is available/);
  // The why reaches the builder in next, both ways.
  const r = criticReview(parseCritic(JSON.stringify({ scores: { ...all(8), motion: ev(7) } })) as never, ctx);
  assert.match(
    reviewNext(r, 3, a1),
    /Another round is open \(round 3 of at most 6: the blockers fell to 0 but motion 7 < 8 is under the bar, so round 4 of 6 is available\)/,
  );
  assert.match(reviewNext(r, 4, flat), /the last one \(round 4 of at most 6: no blockers, but the scores under the bar didn't improve/);
});

// Round 4's A2: blockers 1, 2, 3, all text cut at the frame edge during pushes into the Export dialog.
test("reviewNext: a blocker of text cut at the frame edge names the safe inset and frameRect's keep", () => {
  const r = criticReview(
    parseCritic(
      JSON.stringify({
        scores: all(9),
        blockers: [
          { kind: "overflow", what: "The High preset card is cut at the left frame edge: 'igh'.", at: 22.8 },
          { kind: "blank", what: "Empty frame", at: 4 },
        ],
      }),
    ) as never,
    ctx,
  );
  const next = reviewNext(r, 1, true, undefined, { width: 1080, height: 1350, safe: 72 });
  assert.match(next, /Text cut at the frame edge \(d1\): the safe area is 72 px in from every edge \(x 72 to 1008, y 72 to 1278 on 1080x1350\)/);
  assert.match(next, /uncutMotion\.frameRect\(left, top, w, h, \{ width, height, safe: 72, keep: \[boxLeft, boxTop, boxW, boxH\] \}\)/);
  assert.doesNotMatch(reviewNext(r, 1, true), /safe area/, "no frame given, no hint");
  const other = criticReview(
    parseCritic(JSON.stringify({ scores: all(9), blockers: [{ kind: "overflow", what: "The headline runs out of its box", at: 2 }] })) as never,
    ctx,
  );
  assert.doesNotMatch(reviewNext(other, 1, true, undefined, { width: 1080, height: 1350, safe: 72 }), /safe area/, "only frame-edge cuts");
});

test("the critic's prompt: near-empty frames are blank; a wide shot of the whole editor is a readability defect", () => {
  // The night review: 0.2 s blocked the reference 2.mp4's 0.27 s black bleed and A2's Send; A1's 0.42 s cursor-only beat still blocks.
  assert.match(CRITIC_SYSTEM, /blank: a black or blank frame, or a nearly empty one \(bare canvas with at most a cursor or a speck\) for 0\.33 s or more/);
  assert.match(CRITIC_SYSTEM, /A shorter one \(a black bleed or a cursor-only beat between shots, 0\.2 to 0\.33 s\) is a motion defect, not this blocker/);
  assert.match(CRITIC_SYSTEM, /fine only while it fills a fair share of the frame and the next shape is already growing/);
  assert.doesNotMatch(CRITIC_SYSTEM, /on its way to the next state is not blank/);
  assert.match(CRITIC_SYSTEM, /A wide shot of a whole app window .* is a readability defect with its time range .*not a blocker/);
  // Round 5 (A1r5): a desktop-sized agent panel or export dialog the moment is about, its words tiny, passed as "texture".
  assert.match(
    CRITIC_SYSTEM,
    /In a UI-first film .* the panel, dialog or row the moment is about IS that line: a desktop-sized panel whose words are under about 3\.5 % of the frame's height .* is this blocker/,
  );
  assert.match(CRITIC_SYSTEM, /shown at desktop scale, its lines unreadable at 360 px, is an illegible blocker in a UI-first film/);
  // The live stage's exemption (the program blurred behind a hero, a short pull-back) never excuses a key moment seen only at stage scale.
  assert.match(
    CRITIC_SYSTEM,
    /is the stage, not the moment, but only while the hero or the next push-in carries what the moment is about: a step, clip, dialog or value seen only at stage scale still counts\) is this blocker/,
  );
});

// Round 3's A/B: A1r3 went 4, 1, 1 and A2r3 1, 2, 2; each later round had fixed the last one's
// blocker and found another, and both films shipped with known blockers after 3 rounds.
test("round 3: past 3 the loop goes on while the blockers change (one fixed, the next found), stops on the same ones again; each blocker comes with where to look and the critic's fix", async () => {
  const { mayReviewAgain } = await import("../../apps/server/src/agent/agentCritic.ts");
  const at = (...xs: Array<[string, number]>) => ({ passed: false, blockers: xs.map(([kind, t]) => ({ kind, what: kind, at: t })) });
  // A1r3: the headline at 2.0 s, then the fold at 22.75 s.
  assert.equal(
    mayReviewAgain([at(["invented", 19.25], ["motion", 2], ["motion", 11.6], ["motion", 12]), at(["unverified-fix", 2.02]), at(["unverified-fix", 22.75])]),
    true,
    "A1r3 goes on",
  );
  // A2r3: the invented Passed (twice at about 23 s), then the pan at 11.3 s.
  assert.equal(
    mayReviewAgain([at(["invented", 22.5]), at(["invented", 23], ["unverified-fix", 22.75]), at(["unverified-fix", 11.22], ["unverified-fix", 11.28])]),
    true,
    "A2r3 goes on",
  );
  assert.equal(mayReviewAgain([at(["invented", 22.5]), at(["motion", 11.3]), at(["unverified-fix", 11.28])]), false, "the same moment again: stalled");
  assert.equal(mayReviewAgain([at(["motion", 2]), at(["motion", 11.3]), at(["motion", 2], ["motion", 20])]), false, "more of them: stop");
  assert.equal(mayReviewAgain([at(["a", 1]), at(["a", 2]), at(["a", 3]), at(["a", 4]), at(["a", 5]), at(["a", 6])]), false, "never past 6");
  assert.equal(mayReviewAgain([at(["a", 1]), at(["a", 2]), at(["a", 3]), at(["a", 4]), at(["a", 5])]), true, "changing up to the ceiling");
  // A blocker carries the critic's fix; reviewNext names its frame, graphic and frames to render.
  const answer = parseCritic(
    JSON.stringify({
      scores: all(9),
      blockers: [{ kind: "invented", what: "The review card says Passed.", at: 22.75, fix: "Show 'Review, round 1' with no result." }],
    }),
  );
  assert.ok(!("problem" in answer));
  const r = criticReview(answer as never, ctx);
  assert.equal(r.blockers![0]!.fix, "Show 'Review, round 1' with no result.");
  const next = reviewNext(r, 1, true, (t) => `f ${Math.round(t * 60)}, film.html at ${t.toFixed(2)} s of it; render_frames 1359 to 1371`);
  assert.match(
    next,
    /d1 invented at 22\.75 s \(f 1365, film\.html at 22\.75 s of it; render_frames 1359 to 1371\): The review card says Passed\. Fix: Show 'Review, round 1' with no result\./,
  );
  // Two unverified claims on one moment (A2r3's d3 and d8, the same pan) are one blocker, with the last round's fix.
  const claims = [
    { defect: "d3", what: "Eased the pan", at: 11.22, fix: "Slow the pan's fastest frames." },
    { defect: "d8", what: "Same pan", at: 11.28 },
  ];
  const two = criticReview(
    parseCritic(
      JSON.stringify({
        scores: all(9),
        fixes: [
          { defect: "d3", verified: false, note: "still smeared" },
          { defect: "d8", verified: false },
        ],
      }),
    ) as never,
    { ...ctx, claims },
  );
  assert.equal(two.blockers!.length, 1, JSON.stringify(two.blockers));
  assert.match(two.blockers![0]!.what, /The fix for d3 and d8 isn't visible/);
  assert.equal(two.blockers![0]!.fix, "Slow the pan's fastest frames.");
});
