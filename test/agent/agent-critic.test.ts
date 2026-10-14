// D195–D196 pure parts: the critic's answer read strictly (evidence per score, blocker kinds), the
// round's verdict (blockers cap scores and fail it, Uncut's hard layout findings and unconfirmed fix
// claims are blockers), what the critic's message carries, its command line, and the layout checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectChecks, CHECK_IDS, LAYOUT_RULES, LAYOUT_HARD } from "../../packages/core/src/index.ts";
import { CRITIC_MARKER, CRITIC_SYSTEM, criticArgs, criticMessage, criticReview, criticText, parseCritic, reviewNext, type CriticInput } from "../../apps/server/src/agent/agentCritic.ts";
import { gateOf, planContext } from "../../apps/server/src/agent/agentPlan.ts";

const ev = (score: number) => ({ score, evidence: "f 0, f 30: fine" });
const all = (n: number) => ({ hook: ev(n), readability: ev(n), motion: ev(n), variety: ev(n), sound: ev(n), brand: ev(n) });
const ctx = { round: 1, claims: [], checks: [], determinism: { checked: [], differed: [] }, looked: { sheet: true, phone: true }, revision: 4, turnId: "t1", fps: 30 };

test("parseCritic: fenced or bare JSON, evidence required per score, unknown blocker kinds are other", () => {
  const a = parseCritic(`Sure.\n\`\`\`json\n${JSON.stringify({ scores: all(9), blockers: [{ kind: "font", what: "Falls back to Helvetica", at: 2 }, { kind: "weird", what: "x" }], defects: [{ at: 1, what: "slow" }], summary: "ok" })}\n\`\`\``);
  assert.ok(!("problem" in a));
  assert.equal(a.scores.hook, 9);
  assert.deepEqual(a.blockers.map((b) => b.kind), ["font", "other"]);
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
  const blocked = parseCritic(JSON.stringify({ scores: all(10), blockers: [{ kind: "placeholder", what: "Empty phone", at: 3 }], defects: [{ at: 1, what: "slow" }] }));
  assert.ok(!("problem" in blocked));
  const r = criticReview(blocked, { ...ctx, checks: [{ rule: "layout-off-centre", message: "off by 40 px", frame: 45, hard: true }, { rule: "layout-word-overflow", message: "maybe", hard: false }] });
  assert.equal(r.passed, false);
  assert.equal(r.by, "critic");
  assert.equal(r.scores.brand, 5);
  assert.equal(r.scores.readability, 5);
  assert.equal(r.scores.hook, 10);
  assert.deepEqual(r.blockers!.map((b) => [b.id, b.kind, b.source, b.at]), [["d1", "placeholder", "critic", 3], ["d2", "off-centre", "check", 1.5]]);
  assert.equal(r.defects[0]!.id, "d3");
  assert.match(reviewNext(r), /Blockers \(any one fails the round\): d1 placeholder at 3 s: Empty phone; d2 off-centre/);
  assert.match(reviewNext(r, 3), /in this turn, the last one[\s\S]*Don't say it passed/);
  // Claims: the one the critic confirmed holds, the one it didn't mention is a blocker.
  const fixes = parseCritic(JSON.stringify({ scores: all(9), fixes: [{ defect: "d1", verified: true }] }));
  assert.ok(!("problem" in fixes));
  const f = criticReview(fixes, { ...ctx, round: 2, claims: [{ defect: "d1", what: "added the recording", at: 3 }, { defect: "d2", what: "centred it", at: 1.5 }] });
  assert.equal(f.passed, false);
  assert.deepEqual(f.fixes!.map((x) => [x.defect, x.verified]), [["d1", true], ["d2", false]]);
  assert.equal(f.blockers![0]!.kind, "unverified-fix");
  assert.match(f.blockers![0]!.what, /d2 isn't visible on the new frames: The critic didn't confirm it/);
});

test("the critic's message has the brief, kit, storyboard, rubric and claims only; its command line has no tools, MCP, session or settings", () => {
  const input: CriticInput = {
    round: 2,
    canvas: { width: 1080, height: 1350, fps: 30 },
    frames: 450,
    brief: { film: "Argent in 15 s", audience: "devs", duration: "15 s", formats: ["4:5"], assets: ["demo"], visual: "dark", hardLines: ["no fake UI"], deliverables: [] },
    kit: ['Kit "Argent"', "Fonts: DM Sans for headline"],
    previous: { round: 1, scores: { hook: 9, readability: 5, motion: 8, variety: 8, sound: 8, brand: 5 }, defects: [{ id: "d2", at: 1, what: "slow" }], blockers: [{ id: "d1", kind: "font", what: "Helvetica", source: "critic" }], passed: false, at: "x" },
    claims: [{ defect: "d1", what: "loaded DM Sans", was: "Helvetica" }],
    checks: [],
    determinism: { checked: [], differed: [] },
    images: [{ label: "contact sheet", jpeg: Buffer.from("a") }, { label: "frame 0", jpeg: Buffer.from("b") }],
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
  assert.deepEqual(msg.message.content.map((c) => c.type), ["text", "image", "image"]);
  const args = criticArgs("opus");
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.ok(args.includes("--strict-mcp-config") && args.includes("--no-session-persistence") && !args.includes("--mcp-config") && !args.includes("--resume"));
  assert.ok(args[args.indexOf("--system-prompt") + 1]!.startsWith(CRITIC_MARKER));
  assert.ok(!args.includes("--append-system-prompt"), "the critic's prompt replaces Claude Code's");
  assert.equal(args.at(-1), "opus");
  // The builder's next message lists the critic's findings by id.
  const plan = { reviews: [{ ...input.previous!, by: "critic" as const }] };
  assert.match(planContext({ files: {}, skills: [], others: [] }, plan, gateOf(plan, false)), /Last review \(Uncut's critic\): round 1[\s\S]*\(not passed\)\.\nd1 blocker font: Helvetica\nd2 at 1 s: slow/);
});

const project = (texts: Array<Record<string, unknown>>, clips: Array<Record<string, unknown>> = []) =>
  ({
    format: "uncut.project/1",
    canvas: { width: 1920, height: 1080, fps: 30 },
    media: [],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: texts.map((t, i) => ({ id: `t${i}`, type: "text", start: 0, duration: 60, ...t })) },
      { id: "v2", kind: "video", name: "V2", items: clips.map((c, i) => ({ id: `c${i}`, type: "graphic", src: "graphics/a.html", start: 0, duration: 60, ...c })) },
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
