// D217 (issues #42, #44, #45): the rubric fits the video. Pure parts: the type table (a tutorial has
// no hook, no brand without a kit, a meme's sound is loose), skills raise a category, the brief's
// words take one out; the critic's message lists only what applies; a tutorial passes without a hook;
// a meme's dense, loud effects are findings from the check, not blockers; a promo stays strict; a
// finding marked Intended is left out; style blockers (off-brand colour, "other") become findings
// unless the video asks for them; suggestSkills adds Motion craft and Sound design only where they fit.
// On the bundled server with fake-claude: brief_write records the type and suggests skills (D232:
// to read with skill_read, nobody picks); skill_read marks one used; a tutorial review passes without a hook; a meme's click storm is a finding; the user marks
// it Intended and the next round leaves it out (and tells the critic).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { BUILTIN_IDS, guessVideoType, intendedOf, isIntended, reviewRubric, soundProfileFor, suggestSkills } from "../../packages/core/src/skills/skills.ts";
import { projectChecks, CHECK_IDS, soundSheet, soundProfileText } from "../../packages/core/src/index.ts";
import { criticReview, criticText, parseCritic, reviewNext, scoredOf, type CriticFinding, type CriticInput } from "../../apps/server/src/agent/agentCritic.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = !existsSync(BUNDLE) || !existsSync(MCP) || !existsSync(MEDIA) ? "server bundle or media core not built (run pnpm build)" : false;

let root = "";
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-rubric-")));
});
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

const brief = (film: string, extra: Record<string, unknown> = {}) => ({ film, audience: "devs", duration: "30 s", formats: ["16:9"], assets: [], visual: "", hardLines: [], deliverables: [], ...extra });
const ev = (score: number) => ({ score, evidence: "f 0, f 30: fine" });
const ctx = { round: 1, claims: [], checks: [], determinism: { checked: [], differed: [] }, looked: { sheet: true, phone: true }, revision: 1, turnId: "t", fps: 30 };

test("the rubric: the type's table, no brand without a kit, skills make a category required, the brief's words take one out; no type judges as before", () => {
  const tutorial = reviewRubric(brief("Set up Argent in five minutes", { type: "tutorial" }), { hasKit: true });
  assert.deepEqual(tutorial.levels, { hook: "na", readability: "required", motion: "optional", variety: "optional", sound: "optional", brand: "optional" });
  assert.equal(tutorial.sound, "standard");
  assert.ok(!tutorial.hardKinds.includes("sound") && !tutorial.hardKinds.includes("brand-colour") && !tutorial.hardKinds.includes("other"));
  for (const k of ["placeholder", "invented", "blank", "illegible", "font", "overflow", "missing-asset", "unverified-fix"]) assert.ok(tutorial.hardKinds.includes(k), k);
  assert.equal(reviewRubric(brief("x", { type: "tutorial" })).levels.brand, "na", "no kit, no brand");
  const promo = reviewRubric(brief("Argent Cloud is here", { type: "launch-promo" }), { hasKit: true });
  assert.ok(Object.values(promo.levels).every((l) => l === "required"));
  assert.equal(promo.sound, "strict");
  assert.ok(promo.hardKinds.includes("sound") && promo.hardKinds.includes("brand-colour"));
  const meme = reviewRubric(brief("A meme edit of the outage", { type: "meme" }));
  assert.equal(meme.sound, "loose");
  assert.equal(meme.levels.brand, "na");
  assert.ok(!meme.hardKinds.includes("sound"));
  // Skills raise; words take out.
  const withSkills = reviewRubric(brief("x", { type: "talk" }), { skills: [BUILTIN_IDS.motion, BUILTIN_IDS.sound], hasKit: false });
  assert.equal(withSkills.levels.motion, "required");
  assert.equal(withSkills.levels.sound, "required");
  assert.equal(withSkills.sound, "strict", "the Sound design skill asks for subtle sound");
  assert.equal(reviewRubric(brief("x", { type: "launch-promo", notes: "No hook needed, it opens a keynote" }), { hasKit: true }).levels.hook, "na");
  assert.equal(soundProfileFor(brief("x", { type: "gaming", visual: "subtle sound design" })), "strict");
  assert.equal(soundProfileFor(brief("x", { type: "tutorial", notes: "silent, no music" })), "off");
  assert.equal(reviewRubric(brief("x", { type: "tutorial", notes: "silent" })).levels.sound, "na");
  // A brief from before D217: everything required, every kind a blocker, strict sound.
  const legacy = reviewRubric(brief("Argent Cloud runs your QA"));
  assert.ok(Object.values(legacy.levels).every((l) => l === "required"));
  assert.ok(legacy.hardKinds.includes("other") && legacy.hardKinds.includes("sound") && legacy.hardKinds.includes("brand-colour"));
  assert.equal(guessVideoType(brief("A tutorial: how to record a flow")), "tutorial");
  assert.equal(guessVideoType(brief("A 20 s launch teaser for Argent Cloud")), "launch-promo");
  assert.equal(guessVideoType(brief("Argent Cloud runs your app's QA in the cloud")), undefined);
});

test("suggestSkills: the type's kind of film; Motion craft and Sound design only where they fit; never a forced set", () => {
  assert.deepEqual(suggestSkills(brief("Set up Argent in five minutes", { type: "tutorial" }), { hasKit: true }), [BUILTIN_IDS.demo, BUILTIN_IDS.brand]);
  assert.deepEqual(suggestSkills(brief("Our CTO's conference talk", { type: "talk" })), [BUILTIN_IDS.talking]);
  assert.deepEqual(suggestSkills(brief("A meme edit of the outage", { type: "meme", formats: ["9:16"] })), [BUILTIN_IDS.social]);
  assert.deepEqual(suggestSkills(brief("Argent Cloud is here", { type: "launch-promo", formats: ["4:5"] }), { hasKit: true }), [BUILTIN_IDS.launch, BUILTIN_IDS.motion, BUILTIN_IDS.sound, BUILTIN_IDS.brand]);
  assert.deepEqual(suggestSkills(brief("The dashboard, click by click", { type: "product-demo" })), [BUILTIN_IDS.demo, BUILTIN_IDS.sound]);
});

test("the critic's message: only the categories that apply, the bar for each, the blocker kinds, the sound profile and what the user marked Intended", () => {
  const rubric = reviewRubric(brief("Set up Argent", { type: "tutorial" }));
  const input: CriticInput = { round: 1, canvas: { width: 1920, height: 1080, fps: 30 }, frames: 300, kit: [], claims: [], checks: [], determinism: { checked: [], differed: [] }, images: [], rubric, intended: [{ kind: "motion", what: "The cursor jumps", from: 2, to: 2, at: "x" }] };
  const text = criticText(input);
  assert.match(text, /<rubric Tutorial>\n- hook: not applicable to this video, don't score it\n- required, pass at 8: readability/);
  assert.match(text, /- optional, pass at 6: sound .*; sound profile standard: at most 4 effects in any 10 s, 6 dB under the music; too many or too loud is a finding/);
  assert.match(text, /Blockers for this video: placeholder, missing-asset, font, overflow, illegible, invented, blank, off-centre\. Anything else is a defect\./);
  assert.match(text, /<intended>\nThe user marked these as intended: don't raise them again\.\nmotion at 2 s: The cursor jumps\n<\/intended>/);
  assert.ok(!/[·•]/.test(text));
  assert.deepEqual(scoredOf(rubric), ["readability", "motion", "variety", "sound"]);
});

test("a tutorial passes without a hook; a hook score the critic sends anyway is ignored; an optional score passes at 6", () => {
  const rubric = reviewRubric(brief("Set up Argent", { type: "tutorial" }));
  const answer = parseCritic(JSON.stringify({ scores: { hook: ev(2), readability: ev(9), motion: ev(6.5), variety: ev(7), sound: ev(8) }, blockers: [], defects: [{ kind: "hook", at: 0, what: "No hook in the first 2 s" }] }), scoredOf(rubric));
  assert.ok(!("problem" in answer), JSON.stringify(answer));
  const r = criticReview(answer, { ...ctx, rubric });
  assert.equal(r.passed, true, reviewNext(r));
  assert.equal(r.scores.hook, undefined, "no hook score");
  assert.equal(r.rubric!.hook, "na");
  assert.equal(r.videoType, "tutorial");
  assert.match(reviewNext(r), /Not scored for this video: hook, brand/);
  // A required category under 8 still fails.
  const low = criticReview(parseCritic(JSON.stringify({ scores: { readability: ev(7), motion: ev(9), variety: ev(9), sound: ev(9) } }), scoredOf(rubric)) as never, { ...ctx, rubric });
  assert.equal(low.passed, false);
  assert.match(reviewNext(low), /Under the bar: readability \(8\)/);
  // A missing applicable score is still no answer; a missing na one is fine.
  assert.ok("problem" in parseCritic(JSON.stringify({ scores: { readability: ev(9) } }), scoredOf(rubric)));
});

test("style blockers become findings unless the video asks for them; real defects still fail", () => {
  const rubric = reviewRubric(brief("Set up Argent", { type: "tutorial" }), { hasKit: true });
  const answer = parseCritic(JSON.stringify({ scores: { readability: ev(9), motion: ev(9), variety: ev(9), sound: ev(9), brand: ev(9) }, blockers: [{ kind: "brand-colour", what: "A purple box", at: 3 }, { kind: "other", what: "Slow start", at: 0 }] }), scoredOf(rubric));
  assert.ok(!("problem" in answer));
  const r = criticReview(answer, { ...ctx, rubric });
  assert.equal(r.passed, true);
  assert.deepEqual(r.blockers, []);
  assert.deepEqual(r.defects.map((d) => [d.kind, d.what]), [["brand-colour", "A purple box"], ["other", "Slow start"]]);
  assert.equal(r.scores.brand, 9, "a finding caps nothing");
  const real = criticReview(parseCritic(JSON.stringify({ scores: { readability: ev(9), motion: ev(9), variety: ev(9), sound: ev(9), brand: ev(9) }, blockers: [{ kind: "placeholder", what: "Empty phone", at: 1 }] }), scoredOf(rubric)) as never, { ...ctx, rubric });
  assert.equal(real.passed, false);
  assert.equal(real.blockers![0]!.kind, "placeholder");
  // The same blockers fail a launch promo with a kit (brand required).
  const promo = reviewRubric(brief("x", { type: "launch-promo" }), { hasKit: true });
  const p = criticReview(parseCritic(JSON.stringify({ scores: Object.fromEntries(["hook", "readability", "motion", "variety", "sound", "brand"].map((k) => [k, ev(9)])), blockers: [{ kind: "brand-colour", what: "A purple box", at: 3 }] })) as never, { ...ctx, rubric: promo });
  assert.equal(p.passed, false);
  assert.equal(p.scores.brand, 5);
});

// 16 loud UI clicks in 8 s over a text: what the evidence looked like, now as a meme edit.
const clickStorm = () =>
  ({
    format: "uncut.project/1",
    canvas: { width: 1080, height: 1350, fps: 30 },
    media: [{ id: "click", kind: "audio", path: "/x/ui-click.wav", name: "ui-click", duration: 0.2 }],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [{ id: "claim", type: "text", start: 0, duration: 300, text: "When prod goes down", transform: { x: 100, y: 500 }, style: { preset: "text.title", size: 90 } }] },
      { id: "sfx", kind: "audio", name: "SFX", items: Array.from({ length: 16 }, (_, i) => ({ id: `c${i}`, type: "audio", media: "click", in: 0, start: i * 15, duration: 6, gainDb: 6 })) },
    ],
  }) as never;

test("sound limits follow the profile: strict fails on density, standard and loose find, off finds nothing", () => {
  const sound = (profile: "strict" | "standard" | "loose" | "off") => projectChecks(clickStorm(), { disabled: CHECK_IDS.filter((x) => x !== "sound"), sound: profile });
  const strict = sound("strict");
  assert.ok(strict.some((c) => c.key.startsWith("sound:density:")), strict.map((c) => c.key).join(", "));
  assert.match(strict.find((c) => c.key.startsWith("sound:density:"))!.message, /at most 4 in any 10\.0 s/);
  assert.ok(strict.some((c) => c.key.startsWith("sound:repeat:")));
  const loose = sound("loose");
  assert.ok(loose.some((c) => c.key.startsWith("sound:repeat:")), "16 times is a lot even for a meme");
  assert.match(loose.find((c) => c.key.startsWith("sound:density:"))!.message, /16 sound effects start .*; at most 12 in any 10\.0 s/);
  assert.equal(sound("off").length, 0);
  assert.match(soundSheet(clickStorm(), { sound: "loose" }).join("\n"), /the bar is at most 12\), 1 different\nSound profile loose: at most 12 effects in any 10 s, up to 3 dB over the music; too many or too loud is a finding\./);
});

test("a meme's dense, loud effects are findings from the check, not blockers; a promo's fail the round; Intended leaves a finding out", () => {
  const scores = Object.fromEntries(["hook", "readability", "motion", "variety", "sound", "brand"].map((k) => [k, ev(9)]));
  const checks = (profile: "strict" | "loose"): Array<CriticFinding> =>
    projectChecks(clickStorm(), { disabled: CHECK_IDS.filter((x) => x !== "sound"), sound: profile }).map((c) => ({ rule: c.id, key: c.key, message: c.message, ...(c.frame !== undefined ? { frame: c.frame } : {}), ...(c.range ? { range: c.range } : {}), hard: profile === "strict" && /^sound:(density|loud):/.test(c.key) }));
  const meme = reviewRubric(brief("A meme edit of the outage", { type: "meme" }));
  const answer = parseCritic(JSON.stringify({ scores }), scoredOf(meme));
  assert.ok(!("problem" in answer));
  const r = criticReview(answer, { ...ctx, checks: checks("loose"), rubric: meme });
  assert.equal(r.passed, true, reviewNext(r));
  assert.deepEqual(r.blockers, []);
  const density = r.defects.find((d) => d.rule === "sound:density")!;
  assert.ok(density, JSON.stringify(r.defects));
  assert.equal(density.source, "check");
  assert.equal(r.soundProfile, "loose");
  // The promo: the same storm fails on a sound blocker, as before D217.
  const promo = reviewRubric(brief("Argent Cloud is here", { type: "launch-promo" }));
  const p = criticReview(parseCritic(JSON.stringify({ scores }), scoredOf(promo)) as never, { ...ctx, checks: checks("strict"), rubric: promo });
  assert.equal(p.passed, false);
  assert.ok(p.blockers!.some((b) => b.kind === "sound" && b.source === "check" && b.rule === "sound:density"));
  // Intended: the density finding marked; the next round leaves it out (moved a little is the same one).
  const mark = { ...intendedOf(density), what: density.what, at: "now" };
  assert.equal(mark.kind, "sound:density");
  assert.ok(isIntended({ rule: "sound:density", kind: "sound", at: density.at + 0.5 }, [mark]));
  assert.ok(!isIntended({ rule: "sound:density", kind: "sound", at: density.at + 30 }, [mark]), "somewhere else");
  assert.ok(!isIntended({ rule: "sound:loud", kind: "sound", at: density.at }, [mark]), "another kind");
  const again = criticReview(answer, { ...ctx, checks: checks("loose"), rubric: meme, intended: [mark] });
  assert.ok(!again.defects.some((d) => d.rule === "sound:density"));
  assert.equal(again.intended, 1);
  // A critic finding marked Intended (by kind and time) is left out too, and so is a promo's sound blocker.
  const critic = parseCritic(JSON.stringify({ scores, defects: [{ kind: "motion", at: 2.2, what: "The cursor jumps" }] }), scoredOf(meme));
  const left = criticReview(critic as never, { ...ctx, rubric: meme, intended: [{ kind: "motion", from: 2, to: 2, what: "x", at: "now" }] });
  assert.deepEqual(left.defects, []);
  const pm = criticReview(parseCritic(JSON.stringify({ scores }), scoredOf(promo)) as never, { ...ctx, checks: checks("strict"), rubric: promo, intended: [{ ...intendedOf(p.blockers!.find((b) => b.rule === "sound:density")!), what: "x", at: "now" }, ...p.blockers!.filter((b) => b.rule === "sound:loud").map((b) => ({ ...intendedOf(b), what: "x", at: "now" }))] });
  assert.equal(pm.passed, true, JSON.stringify(pm.blockers));
});

type Content = Array<{ type: string; text?: string }>;
const textOf = (r: { content: Content }) => r.content.find((c) => c.type === "text")!.text!;
const jsonOf = (r: { content: Content }) => JSON.parse(textOf(r));

test("on the server: the brief suggests and turns nothing on, use only after the user picked it; a tutorial passes without a hook; a meme's click storm is a finding the user marks Intended", { skip, timeout: 300000 }, async () => {
  const base = join(root, "server");
  mkdirSync(join(base, "projects"), { recursive: true });
  const plan = join(base, "plan.json");
  const log = join(base, "prompts.jsonl");
  const results = join(base, "results.jsonl");
  const critic = join(base, "critic.json");
  const criticLog = join(base, "critic.jsonl");
  for (const f of [log, results, criticLog]) writeFileSync(f, "");
  const noHook = Object.fromEntries(["readability", "motion", "variety", "sound"].map((k) => [k, ev(9)]));
  const all = Object.fromEntries(["hook", "readability", "motion", "variety", "sound", "brand"].map((k) => [k, ev(9)]));
  writeFileSync(critic, JSON.stringify([{ scores: noHook, blockers: [], defects: [], summary: "Clear steps." }, { scores: all, blockers: [], defects: [], summary: "Loud on purpose." }, { scores: all, blockers: [], defects: [], summary: "Still loud." }]));
  const server = await startServer({ env: { UNCUT_DATA_DIR: join(base, "data"), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan, FAKE_PROMPT_LOG: log, FAKE_RESULT_LOG: results, FAKE_CRITIC: critic, FAKE_CRITIC_LOG: criticLog, UNCUT_APPROVAL_MS: "20000" } });
  const client = await connect(server.ready.port, server.ready.token);
  try {
    const agent = client.subscribe("agent.subscribe");
    const turns: Array<unknown> = [];
    let seen = 0;
    const fresh = () => {
      const lines = readFileSync(results, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const out = lines.slice(seen);
      seen = lines.length;
      return out as Array<{ tool: string; result: { isError?: boolean; content: Content } }>;
    };
    const turn = (id: string) => agent.values.at(-1)?.turns.find((t: { id: string }) => t.id === id);
    const start = async (prompt: string, steps: Array<unknown>) => {
      turns.push(steps);
      writeFileSync(plan, JSON.stringify(turns));
      return (await client.ok("agent.send", { prompt, access: "auto", skipStoryboard: true })).turnId as string;
    };
    const done = async (id: string) => (await agent.until(() => turn(id) && turn(id).status !== "running", 120000), turn(id));
    const runs = () => readFileSync(criticLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) as Array<{ text: string }>;

    // ---- A tutorial ----
    const tut = await client.ok("project.create", { parentDir: join(base, "projects"), name: "Tutorial" });
    await agent.until((s) => s?.dir === tut.dir);
    const tb = { film: "Set up Argent in five minutes", type: "tutorial", audience: "RN devs", duration: "40 s", formats: ["16:9"], assets: ["screen recording"], visual: "Calm, clear", hardLines: ["Never invent UI"], deliverables: ["16:9 mp4"] };
    const t1 = await start("make a tutorial", [
      { tool: "brief_write", args: tb },
      { tool: "skill_read", args: { name: BUILTIN_IDS.demo } },
      { tool: "brief_write", args: tb },
    ]);
    assert.equal((await done(t1)).status, "done");
    const [w1, read, w2] = fresh();
    const first = jsonOf(w1!.result);
    assert.equal(first.type, "tutorial");
    assert.deepEqual(first.skills, [], "nothing used yet");
    assert.deepEqual(first.suggestedSkills.map((x: { id: string }) => x.id), [BUILTIN_IDS.demo]);
    assert.match(first.skillsNote, /Read each suggested skill that fits with skill_read/);
    assert.equal(first.rubric.hook, "not scored");
    assert.match(first.sound, /^standard: at most 4 effects/);
    assert.equal(JSON.parse(readFileSync(join(tut.dir, "brief.json"), "utf8")).type, "tutorial");
    assert.equal(jsonOf(read!.result).name, BUILTIN_IDS.demo);
    const second = jsonOf(w2!.result);
    assert.deepEqual(second.skills.map((x: { id: string }) => x.id), [BUILTIN_IDS.demo], "read: used");
    assert.deepEqual(second.suggestedSkills, []);
    assert.deepEqual(JSON.parse(readFileSync(join(tut.dir, "brand", "active.json"), "utf8")).skills, [BUILTIN_IDS.demo]);
    // Its review: no hook score, passes.
    const t2 = await done(await start("build and review", [
      { tool: "project_read" },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Step 1", ops: [{ op: "insert_item", track: "text", item: { id: "step", type: "text", start: 0, duration: 150, text: "Step 1: install", transform: { x: 100, y: 400 }, style: { preset: "text.title", size: 90 } } }] } },
      { tool: "contact_sheet", args: { max: 4 } },
      { tool: "render_frames", args: { frames: [0, 60], phone: true } },
      { tool: "review_submit", args: {} },
    ]));
    assert.equal(t2.status, "done", t2.error);
    const tr = jsonOf(fresh()[4]!.result);
    assert.equal(tr.passed, true, tr.next);
    assert.equal(tr.scores.hook, undefined);
    assert.equal(tr.rubric.hook, "na");
    assert.match(runs()[0]!.text, /<rubric Tutorial>\n- hook: not applicable to this video/);
    const card = turn(t2.id).items.find((i: { kind: string; card?: { type: string } }) => i.kind === "card" && i.card?.type === "review").card.review;
    assert.equal(card.rubric.hook, "na");

    // ---- A meme ----
    const meme = await client.ok("project.create", { parentDir: join(base, "projects"), name: "Meme" });
    await agent.until((s) => s?.dir === meme.dir);
    const mb = { film: "A meme edit of our outage", type: "meme", audience: "devs on X", duration: "8 s", formats: ["9:16"], assets: [], visual: "Loud, fast", hardLines: [], deliverables: ["9:16 mp4"] };
    const m1 = await done(await start("meme it", [{ tool: "brief_write", args: mb }, { tool: "library_add", args: { id: "sfx:ui-click" } }]));
    assert.equal(m1.status, "done", m1.error);
    const [mw, added] = fresh();
    assert.match(jsonOf(mw!.result).sound, /^loose/);
    const media = jsonOf(added!.result).media as string;
    const clicks = Array.from({ length: 16 }, (_, i) => ({ op: "insert_item", track: "audio", item: { id: `click-${i}`, type: "audio", media, in: 0, start: 6 + i * 15, duration: 6, gainDb: 6 } }));
    const m2 = await done(await start("clicks everywhere and review", [
      { tool: "project_read" },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "The clicks", ops: [{ op: "insert_item", track: "text", item: { id: "claim", type: "text", start: 0, duration: 240, text: "When prod goes down", transform: { x: 100, y: 500 }, style: { preset: "text.title", size: 90 } } }, ...clicks] } },
      { tool: "project_check", args: { rules: ["sound"] } },
      { tool: "contact_sheet", args: { max: 4 } },
      { tool: "render_frames", args: { frames: [0, 60], phone: true } },
      { tool: "review_submit", args: {} },
    ]));
    assert.equal(m2.status, "done", m2.error);
    const mr = fresh();
    const check = jsonOf(mr[2]!.result);
    assert.match(check.soundProfile, /^loose: at most 12 effects/);
    assert.match(check.checks.map((c: { message: string }) => c.message).join("\n"), /16 sound effects start .*at most 9 in any 8\.0 s/, "the loose bar, pro rata (12 in 10 s)");
    const review = jsonOf(mr[5]!.result);
    assert.equal(review.passed, true, review.next);
    assert.deepEqual(review.blockers, [], "dense, loud effects aren't blockers in a meme");
    const density = review.defects.find((d: { rule?: string }) => d.rule === "sound:density");
    assert.ok(density && density.source === "check", JSON.stringify(review.defects));
    // The user marks it Intended on the card; the next round leaves it out and tells the critic.
    const marked = await client.ok("agent.planSave", { intended: [{ ...intendedOf(density), what: density.what, at: new Date().toISOString() }] });
    assert.equal(marked.intended.length, 1);
    assert.ok(existsSync(join(meme.dir, "intended.json")));
    const m3 = await done(await start("review again", [
      { tool: "project_check", args: { rules: ["sound"] } },
      { tool: "contact_sheet", args: { max: 4 } },
      { tool: "render_frames", args: { frames: [0, 60], phone: true } },
      { tool: "review_submit", args: {} },
    ]));
    assert.equal(m3.status, "done", m3.error);
    const again = fresh();
    const check2 = jsonOf(again[0]!.result);
    assert.ok(!check2.checks.some((c: { key?: string; message: string }) => /16 sound effects start/.test(c.message)), "project_check leaves it out too");
    assert.match(check2.intended, /1 sound finding the user marked Intended left out/);
    const round2 = jsonOf(again[3]!.result);
    assert.ok(!round2.defects.some((d: { rule?: string }) => d.rule === "sound:density"), JSON.stringify(round2.defects));
    assert.match(round2.intended, /finding.* the user marked Intended left out/);
    const text = runs().at(-1)!.text;
    assert.match(text, /<intended>\nThe user marked these as intended: don't raise them again\.\nsound:density at /);
    assert.ok(!/16 sound effects start/.test(text.split("<intended>")[0]!), "the check's finding isn't in the critic's sound block");
  } finally {
    client.close();
    await server.stop();
  }
});

// T2, A2r8: the user wrote "The song only, no sound effects unless asked" / "Music only, no added
// sound effects" in the request, which the profile never read (only the brief), and the critic
// scored the silence down and asked for clicks. The user's words set the profile, over any default.
test("music only in the request is the music profile, over the skills' and the type's defaults; no sound effects isn't silence", () => {
  const b = brief("A 28 s launch film", { type: "launch-promo" });
  assert.notEqual(soundProfileFor(b, ["motion-film"]), "music");
  assert.equal(soundProfileFor(b, ["sound-design"], "Music only, no added sound effects."), "music");
  assert.equal(soundProfileFor(b, ["motion-film"], "Cut the drone clips to the song. Music only, no added sound effects."), "music");
  assert.equal(soundProfileFor(b, ["motion-film"], "- The song only, no sound effects unless asked, mastered around -14 LUFS."), "music");
  assert.equal(soundProfileFor(brief("x", { type: "launch-promo" }), [], "no sound effects"), "music", "not off");
  assert.equal(soundProfileFor(brief("x", { type: "tutorial", notes: "silent, no music" })), "off");
  assert.equal(soundProfileFor(brief("x", { type: "tutorial", notes: "no sound at all" })), "off");
  const r = reviewRubric(b, { skills: ["motion-film"], request: "Music only, no added sound effects." });
  assert.equal(r.sound, "music");
  assert.equal(r.levels.sound === "na", false, "the music is still judged");
  assert.ok(!r.hardKinds.includes("sound"));
  assert.match(soundProfileText("music"), /music only .*never is/);
});

// D306: the user wanted keyboard and click sounds in a launch film; the agent wrote "Music only, no
// added sound effects" into its own brief and the profile ruled them out. Only the user's words do.
test("music only in the brief, a skill or the agent's plan alone isn't the music profile; the user's request still is", () => {
  const agentPlan = brief("A 28 s launch film for Uncut", { type: "launch-promo", notes: "Music only, no added sound effects.", visual: "the song only", hardLines: ["no sfx"] });
  assert.equal(soundProfileFor(agentPlan, ["motion-film", "sound-design"]), "strict", "the brief's music-only words are the agent's, not the user's");
  assert.equal(soundProfileFor(agentPlan, [], "Make a 28s launch film for Uncut, this app: one take on the beat, show me typing this prompt."), "strict", "a request that doesn't say it");
  assert.equal(reviewRubric(agentPlan, { skills: ["sound-design"], request: "Make a launch film with keyboard sounds." }).sound, "strict");
  assert.equal(soundProfileFor(agentPlan, [], "Make a launch film. Music only."), "music", "the user's own words still decide");
  assert.equal(soundProfileFor(brief("x", { type: "meme" }), [], "Use the song only, please"), "music");
});
