// D207 (issues #30, #31): Uncut's built-in skills and the sound review. Pure parts: the nine
// built-ins (shape, checklist, size, no dots between words), skillChecklist on any body,
// suggestSkills from a brief, the store (built-ins listed read-only, never shadowed or saved),
// planContext's budget, the critic's message (skill checklists, the sound sheet, the blindfold
// instruction) and a hard sound finding as a "sound" blocker. On the bundled server with
// fake-claude: the first brief_write turns on the suggested skills and returns their text, the
// next message carries them, project_check reports a click spam, and review_submit gives the
// critic the checklists and the sound sheet and fails the round on the density blocker.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { BUILTIN_IDS, BUILTIN_SKILLS, skillChecklist, suggestSkills } from "../../packages/core/src/skills/skills.ts";
import { readBrand, saveSkill, deleteSkill, writeActive } from "../../apps/server/src/brand/store.ts";
import { gateOf, planContext, SKILLS_CHARS } from "../../apps/server/src/agent/agentPlan.ts";
import { CRITIC_SYSTEM, criticReview, criticText, parseCritic, type CriticInput } from "../../apps/server/src/agent/agentCritic.ts";
import { SYSTEM_PROMPT } from "../../apps/server/src/agent/agentTools.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = !existsSync(BUNDLE) || !existsSync(MCP) || !existsSync(MEDIA) ? "server bundle or media core not built (run pnpm build)" : false;

let root = "";
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-skills-")));
});
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the nine built-in skills: ids, a review checklist each, short bodies, no dots or stars between words", () => {
  assert.deepEqual(BUILTIN_SKILLS.map((s) => s.id), Object.values(BUILTIN_IDS));
  assert.equal(BUILTIN_SKILLS.length, 9);
  for (const s of BUILTIN_SKILLS) {
    assert.ok(s.id.startsWith("builtin-") && s.name && s.description, s.id);
    const list = skillChecklist(s.body);
    assert.ok(list.length >= 4 && list.length <= 12, `${s.id}: ${list.length} checklist lines`);
    assert.ok(s.body.length <= 2600, `${s.id} is ${s.body.length} characters`);
    for (const head of ["Review checklist"]) assert.match(s.body, new RegExp(`\\n${head}\\n`), s.id);
    // On-screen copy rules apply to the recipes too (D207): commas or line breaks, never ·, • or *.
    assert.ok(!/[·•]/.test(s.body) && !/\S \* \S/.test(s.body), s.id);
  }
  const sound = BUILTIN_SKILLS.find((s) => s.id === BUILTIN_IDS.sound)!.body;
  for (const want of [/at most 4 in any 10 s/, /6 to 12 dB under the music/, /No UI clicks on text/, /No meme sounds/, /beat_grid/, /audio\.duck/, /-14 LUFS/]) assert.match(sound, want);
  const motion = BUILTIN_SKILLS.find((s) => s.id === BUILTIN_IDS.motion)!.body;
  for (const want of [/snap/, /settle/, /land/, /centred gradient title/i, /Everything fading in/i, /Glow/, /Corner labels/]) assert.match(motion, want);
  // A typical set fits the message budget whole, checklists included.
  const typical = [BUILTIN_IDS.launch, BUILTIN_IDS.demo, BUILTIN_IDS.motion, BUILTIN_IDS.sound, BUILTIN_IDS.brand].map((id) => BUILTIN_SKILLS.find((s) => s.id === id)!.body.length);
  assert.ok(typical.reduce((a, b) => a + b, 0) < SKILLS_CHARS);
});

test("skillChecklist: the lines after a checklist heading, any of its names; none without one", () => {
  assert.deepEqual(skillChecklist("Intro\n\nCheck before handing it over\n- Frame 1 is interesting\n- Every beat says one thing\n\nMore text\n- not this"), ["Frame 1 is interesting", "Every beat says one thing"]);
  assert.deepEqual(skillChecklist("Review checklist\n\n- one\n- two"), ["one", "two"]);
  assert.deepEqual(skillChecklist("Rules\n- a rule"), []);
});

test("suggestSkills: a kind of film from the brief's words, formats and length, then Motion craft and Sound design, Brand application with a kit", () => {
  const b = (film: string, extra: Record<string, unknown> = {}) => ({ film, audience: "devs", duration: "20 s", formats: ["4:5"], assets: [], visual: "", deliverables: [], ...extra });
  assert.deepEqual(suggestSkills(b("A 20 s launch teaser for Argent Cloud"), { hasKit: true }), [BUILTIN_IDS.launch, BUILTIN_IDS.motion, BUILTIN_IDS.sound, BUILTIN_IDS.brand]);
  assert.deepEqual(suggestSkills(b("Our founder talks to camera about v2", { formats: ["9:16"] })), [BUILTIN_IDS.talking, BUILTIN_IDS.launch, BUILTIN_IDS.motion, BUILTIN_IDS.sound]);
  assert.deepEqual(suggestSkills(b("Walkthrough of the dashboard", { assets: ["screen recording of the app"] })), [BUILTIN_IDS.demo, BUILTIN_IDS.motion, BUILTIN_IDS.sound]);
  assert.deepEqual(suggestSkills(b("How it works under the hood", { duration: "60 s" })), [BUILTIN_IDS.explainer, BUILTIN_IDS.motion, BUILTIN_IDS.sound]);
  assert.deepEqual(suggestSkills(b("A kinetic typography opener")), [BUILTIN_IDS.titles, BUILTIN_IDS.motion, BUILTIN_IDS.sound]);
  assert.deepEqual(suggestSkills(b("Announcing the release", { formats: ["9:16 1080x1920", "16:9", "4:5"] })), [BUILTIN_IDS.launch, BUILTIN_IDS.social, BUILTIN_IDS.motion, BUILTIN_IDS.sound]);
  assert.deepEqual(suggestSkills(b("Our relationship with users")), [BUILTIN_IDS.launch, BUILTIN_IDS.motion, BUILTIN_IDS.sound], "no kind found: a launch promo");
});

test("the store: built-ins listed read-only first, never saved, deleted or shadowed; the user's own beside them", async () => {
  const dataDir = join(root, "store-data");
  const projectDir = join(root, "store-project");
  mkdirSync(join(dataDir, "brand", "skills"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  // A file with a built-in's id on disk is ignored.
  writeFileSync(join(dataDir, "brand", "skills", "builtin-sound-design.json"), JSON.stringify({ id: "builtin-sound-design", name: "Hacked", description: "", body: "boom everywhere" }));
  await saveSkill({ dataDir, projectDir }, { id: "my-promo", name: "My promo", scope: "global", description: "", body: "Review checklist\n- Mine" });
  const state = await readBrand({ dataDir, projectDir });
  assert.equal(state.skills.filter((s) => s.builtin).length, 9);
  const sound = state.skills.find((s) => s.id === BUILTIN_IDS.sound)!;
  assert.equal(sound.name, "Sound design");
  assert.equal(sound.builtin, true);
  assert.ok(state.skills.some((s) => s.id === "my-promo" && !s.builtin));
  await assert.rejects(saveSkill({ dataDir, projectDir }, { ...sound }), /built-in skills can't be changed/);
  await assert.rejects(saveSkill({ dataDir, projectDir }, { id: "", name: "Builtin launch", scope: "global", description: "", body: "" }), /built-in skills can't be changed/, "a name that slugs to a built-in id");
  await assert.rejects(deleteSkill({ dataDir, projectDir }, BUILTIN_IDS.sound, "global"), /can't be deleted/);
  // Selectable per project like any skill.
  await writeActive(projectDir, { kit: null, skills: [BUILTIN_IDS.launch, "my-promo"] });
  assert.deepEqual((await readBrand({ dataDir, projectDir })).active.skills, [BUILTIN_IDS.launch, "my-promo"]);
});

test("planContext: the chosen skills whole; with none chosen, the skills there are and how brief_write turns them on", () => {
  const plan = { reviews: [] };
  const gate = gateOf(plan, false);
  const chosen = BUILTIN_SKILLS.filter((s) => [BUILTIN_IDS.launch, BUILTIN_IDS.motion, BUILTIN_IDS.sound, BUILTIN_IDS.brand].includes(s.id as never)).map((s) => ({ ...s, scope: "global" as const, builtin: true }));
  const text = planContext({ files: {}, skills: chosen, others: [] }, plan, gate);
  for (const s of chosen) assert.ok(text.includes(s.body), `${s.name} is whole`);
  const none = planContext({ files: {}, skills: [], others: [], available: BUILTIN_SKILLS.map((s) => ({ ...s })) }, plan, gate);
  assert.match(none, /No skills are on for this project\. Uncut's: builtin-launch-promo, builtin-product-demo, /);
  assert.match(none, /brief_write turns on the ones that fit the brief/);
  assert.match(SYSTEM_PROMPT, /the critic checks their review checklists/);
  assert.match(SYSTEM_PROMPT, /4 in any 10 s/);
  assert.ok(!/cozy music/.test(SYSTEM_PROMPT));
});

test("the critic gets the skills' checklists and the sound sheet, reads it blindfold, and a hard sound finding is a sound blocker", () => {
  const input: CriticInput = {
    round: 1,
    canvas: { width: 1080, height: 1350, fps: 30 },
    frames: 300,
    kit: [],
    claims: [],
    checks: [{ rule: "sound", message: "8 sound effects start between 0.2 s and 7.2 s", frame: 6, hard: true }, { rule: "layout-off-canvas", message: "runs off", hard: false }],
    determinism: { checked: [], differed: [] },
    images: [],
    skills: [{ name: "Sound design", checklist: skillChecklist(BUILTIN_SKILLS.find((s) => s.id === BUILTIN_IDS.sound)!.body) }, { name: "Empty", checklist: [] }],
    sound: ["sound effect 0.2 s (f 6): ui-click (ui), 0.2 s, at 0 dB; lands on nothing that changes on screen", "8 sound effects in 10.0 s (8.0 per 10 s; the bar is at most 4), 1 different"],
  };
  const text = criticText(input);
  assert.match(text, /<skill-checklists>\nSound design:\n- Every sound effect lands on something that changes on screen\./);
  assert.ok(!text.includes("Empty:"), "a skill without a checklist adds nothing");
  assert.match(text, /<sound>\nsound effect 0\.2 s \(f 6\): ui-click/);
  assert.match(text, /<sound>[\s\S]*\nfails at f 6: 8 sound effects start between 0\.2 s and 7\.2 s\n<\/sound>/, "sound findings go with the sheet");
  assert.match(text, /<layout-checks>\ncheck: runs off\n<\/layout-checks>/);
  assert.match(CRITIC_SYSTEM, /blindfold/i);
  assert.match(CRITIC_SYSTEM, /- sound: from the <sound> sheet/);
  const answer = parseCritic(JSON.stringify({ scores: Object.fromEntries(["hook", "readability", "motion", "variety", "sound", "brand"].map((k) => [k, { score: 9, evidence: "f 0, f 30" }])) }));
  assert.ok(!("problem" in answer));
  const r = criticReview(answer, { round: 1, claims: [], checks: [{ rule: "sound", message: "8 sound effects start between 0.2 s and 8.2 s", frame: 6, hard: true }], determinism: { checked: [], differed: [] }, looked: { sheet: true, phone: true }, revision: 1, turnId: "t", fps: 30 });
  assert.equal(r.passed, false);
  assert.deepEqual(r.blockers!.map((b) => [b.kind, b.source]), [["sound", "check"]]);
  assert.equal(r.scores.sound, 5);
  assert.equal(r.scores.readability, 9, "a sound blocker caps sound only");
});

type Content = Array<{ type: string; text?: string }>;
const textOf = (r: { content: Content }) => r.content.find((c) => c.type === "text")!.text!;
const jsonOf = (r: { content: Content }) => JSON.parse(textOf(r));

test("on the server: brief_write turns on the suggested skills, the next message carries them, project_check and the critic see a click spam", { skip, timeout: 240000 }, async () => {
  const base = join(root, "server");
  mkdirSync(join(base, "projects"), { recursive: true });
  const plan = join(base, "plan.json");
  const log = join(base, "prompts.jsonl");
  const results = join(base, "results.jsonl");
  const critic = join(base, "critic.json");
  const criticLog = join(base, "critic.jsonl");
  for (const f of [log, results, criticLog]) writeFileSync(f, "");
  const evidence = Object.fromEntries(["hook", "readability", "motion", "variety", "sound", "brand"].map((k) => [k, { score: 9, evidence: "f 0, f 45: fine" }]));
  writeFileSync(critic, JSON.stringify([{ scores: evidence, blockers: [], defects: [], fixes: [], summary: "Fine to look at." }]));
  const server = await startServer({ env: { UNCUT_DATA_DIR: join(base, "data"), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan, FAKE_PROMPT_LOG: log, FAKE_RESULT_LOG: results, FAKE_CRITIC: critic, FAKE_CRITIC_LOG: criticLog, UNCUT_APPROVAL_MS: "8000" } });
  const client = await connect(server.ready.port, server.ready.token);
  try {
    const agent = client.subscribe("agent.subscribe");
    const snap = await client.ok("project.create", { parentDir: join(base, "projects"), name: "Promo" });
    await agent.until((s) => s?.dir === snap.dir);
    const turn = (id: string) => agent.values.at(-1)?.turns.find((t: { id: string }) => t.id === id);
    const turns: Array<unknown> = [];
    let seen = 0;
    const fresh = () => {
      const all = readFileSync(results, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const out = all.slice(seen);
      seen = all.length;
      return out as Array<{ tool: string; result: { isError?: boolean; content: Content } }>;
    };
    const ask = async (prompt: string, steps: Array<unknown>) => {
      turns.push(steps);
      writeFileSync(plan, JSON.stringify(turns));
      const { turnId } = await client.ok("agent.send", { prompt, access: "auto", skipStoryboard: true });
      await agent.until(() => turn(turnId) && turn(turnId).status !== "running", 120000);
      return turn(turnId);
    };
    const prompts = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.refused) as Array<{ prompt: string }>;

    // Turn 1: no skills on yet (the message lists them); the brief turns on the suggestion.
    const brief = { film: "A 10 s launch teaser for Argent Cloud", audience: "React Native devs", duration: "10 s", formats: ["4:5"], assets: ["demo recording"], visual: "Dark, amber", hardLines: ["Never invent UI"], deliverables: ["4:5 mp4"] };
    const t1 = await ask("make a launch teaser", [{ tool: "brief_write", args: brief }, { tool: "library_add", args: { id: "sfx:ui-click" } }]);
    assert.equal(t1.status, "done", t1.error);
    assert.match(prompts()[0]!.prompt, /No skills are on for this project\. Uncut's: builtin-brand-application, .*builtin-launch-promo/);
    const [wrote, added] = fresh();
    const out = jsonOf(wrote!.result);
    assert.deepEqual(out.skills.map((x: { id: string }) => x.id), [BUILTIN_IDS.launch, BUILTIN_IDS.demo, BUILTIN_IDS.motion, BUILTIN_IDS.sound], "a launch teaser with a demo recording");
    assert.match(out.skills[0].body, /Review checklist/);
    assert.match(out.skillsNote, /Uncut turned these skills on for this brief/);
    assert.deepEqual(JSON.parse(readFileSync(join(snap.dir, "brand", "active.json"), "utf8")).skills, [BUILTIN_IDS.launch, BUILTIN_IDS.demo, BUILTIN_IDS.motion, BUILTIN_IDS.sound]);
    const media = jsonOf(added!.result).media as string;

    // Turn 2: the skills ride along; a text and 8 clicks in 8 s; project_check; the critic's round.
    const clicks = Array.from({ length: 8 }, (_, i) => ({ op: "insert_item", track: "audio", item: { id: `click-${i}`, type: "audio", media, in: 0, start: 6 + i * 30, duration: 6 } }));
    const t2 = await ask("add the clicks and review", [
      { tool: "brief_write", args: { ...brief, skills: [BUILTIN_IDS.titles] } },
      { tool: "project_read" },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Scene 1", ops: [{ op: "insert_item", track: "text", item: { id: "claim", type: "text", start: 0, duration: 300, text: "QA on real devices", transform: { x: 100, y: 500 }, style: { preset: "text.title", size: 90 } } }, ...clicks] } },
      { tool: "project_check", args: { rules: ["sound"] } },
      { tool: "contact_sheet", args: { max: 4 } },
      { tool: "render_frames", args: { frames: [0, 60], phone: true } },
      { tool: "review_submit", args: {} },
    ]);
    assert.equal(t2.status, "done", t2.error);
    const p2 = prompts().at(-1)!.prompt;
    assert.match(p2, /Skill "Launch promo" \(A 15 to 30 s launch film/);
    assert.match(p2, /Skill "Sound design"/);
    const r = fresh();
    const kept = jsonOf(r[0]!.result);
    assert.match(kept.skillsNote, /already on for this project/, "the second brief keeps the project's choice");
    assert.ok(!kept.skills.some((x: { id: string }) => x.id === BUILTIN_IDS.titles));
    const checks = jsonOf(r[3]!.result).checks as Array<{ key?: string; id: string; message: string }>;
    const messages = checks.map((c) => c.message).join("\n");
    assert.match(messages, /8 sound effects start between 0\.2 s and 7\.2 s; at most 4 in any 10\.0 s/);
    assert.match(messages, /ui-click plays 8 times/);
    const review = jsonOf(r[6]!.result);
    assert.equal(review.passed, false, "a density blocker fails the round even with 9s");
    assert.ok(review.blockers.some((b: { kind: string; source: string }) => b.kind === "sound" && b.source === "check"), JSON.stringify(review.blockers));
    assert.equal(review.scores.sound, 5);
    const runs = readFileSync(criticLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) as Array<{ text: string }>;
    const text = runs.at(-1)!.text;
    assert.match(text, /<skill-checklists>\nLaunch promo:\n- Frame 0 shows motion/);
    assert.match(text, /Sound design:\n- Every sound effect lands on something that changes on screen/);
    assert.match(text, /<sound>\nsound effect 0\.2 s \(f 6\): ui-click \(ui\)/);
    assert.match(text, /8 sound effects in 10\.0 s \(8\.0 per 10 s; the bar is at most 4\), 1 different/);
  } finally {
    client.close();
    await server.stop();
  }
});
