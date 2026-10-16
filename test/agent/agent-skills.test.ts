// D207 (issues #30, #31), D232 (issue #60): Uncut's own skills and the sound review. Pure parts:
// the bundled uncut.skills plugin's skills (shape, checklist, size, no dots between words),
// skillChecklist on any body, suggestSkills from a brief, the store (plugin skills listed read-only,
// never saved or shadowed; old builtin- ids still read), planContext, the critic's message (skill
// checklists, the sound sheet, the blindfold instruction) and a hard sound finding as a "sound"
// blocker. On the bundled server with fake-claude: the system prompt lists every skill; brief_write
// suggests skills to read (D232: nobody picks); /launch-promo in a message brings its instructions
// and skill_read another's; project_check reports a click spam, and review_submit gives the critic
// the used skills' checklists and the sound sheet and fails the round on the density blocker.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { BUILTIN_IDS, skillChecklist, suggestSkills } from "../../packages/core/src/skills/skills.ts";
import { readBrand, saveSkill, deleteSkill, writeActive } from "../../apps/server/src/brand/store.ts";
import { gateOf, planContext } from "../../apps/server/src/agent/agentPlan.ts";
import { bundledSkill, bundledSkills } from "../helpers/skills.ts";
import { CRITIC_SYSTEM, criticReview, criticText, parseCritic, type CriticInput } from "../../apps/server/src/agent/agentCritic.ts";
import { ALL_DOCS, SYSTEM_PROMPT } from "../../apps/server/src/agent/agentTools.ts";
import { AGENT_TEXT } from "../helpers/agentText.ts";

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

test("Uncut's own skills (the bundled uncut.skills plugin): names, a review checklist each, short bodies, no dots or stars between words", () => {
  const all = bundledSkills();
  assert.deepEqual(all.map((s) => s.name), Object.values(BUILTIN_IDS));
  assert.equal(all.length, 11);
  for (const s of all) {
    assert.ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.name) && s.title && s.description && s.plugin === "uncut.skills", s.name);
    const list = skillChecklist(s.instructions);
    assert.ok(list.length >= 4 && list.length <= 12, `${s.name}: ${list.length} checklist lines`);
    assert.ok(s.instructions.length <= 2600, `${s.name} is ${s.instructions.length} characters`);
    for (const head of ["Review checklist"]) assert.match(s.instructions, new RegExp(`\\n${head}\\n`), s.name);
    // On-screen copy rules apply to the recipes too (D207): commas or line breaks, never ·, • or *.
    assert.ok(!/[·•]/.test(s.instructions) && !/\S \* \S/.test(s.instructions), s.name);
  }
  const sound = bundledSkill(BUILTIN_IDS.sound).instructions;
  for (const want of [/at most 4 in any 10 s/, /6 to 12 dB under the music/, /No UI clicks on text/, /No meme sounds/, /beat_grid/, /audio\.duck/, /-14 LUFS/]) assert.match(sound, want);
  const motion = bundledSkill(BUILTIN_IDS.motion).instructions;
  for (const want of [/snap/, /settle/, /land/, /centred gradient title/i, /Everything fading in/i, /Glow/, /Corner labels/]) assert.match(motion, want);
  // D232: the kit maker asks, takes a link or dropped files, and builds with the brand tools.
  const kit = bundledSkill(BUILTIN_IDS.brandKit).instructions;
  for (const want of [/ask_user/, /link/, /drop/, /\.cache\/agent-images/, /brand_write/, /brand_read/, /Never invent a logo/]) assert.match(kit, want);
});

test("skillChecklist: the lines after a checklist heading, any of its names; none without one", () => {
  assert.deepEqual(skillChecklist("Intro\n\nCheck before handing it over\n- Frame 1 is interesting\n- Every beat says one thing\n\nMore text\n- not this"), ["Frame 1 is interesting", "Every beat says one thing"]);
  assert.deepEqual(skillChecklist("Review checklist\n\n- one\n- two"), ["one", "two"]);
  assert.deepEqual(skillChecklist("Rules\n- a rule"), []);
});

test("suggestSkills, a brief with no type (as before D217): a kind of film from the brief's words, formats and length, then Motion craft and Sound design, Brand application with a kit", () => {
  const b = (film: string, extra: Record<string, unknown> = {}) => ({ film, audience: "devs", duration: "20 s", formats: ["4:5"], assets: [], visual: "", deliverables: [], ...extra });
  assert.deepEqual(suggestSkills(b("A 20 s launch teaser for Argent Cloud"), { hasKit: true }), [BUILTIN_IDS.launch, BUILTIN_IDS.motion, BUILTIN_IDS.sound, BUILTIN_IDS.brand]);
  assert.deepEqual(suggestSkills(b("Our founder talks to camera about v2", { formats: ["9:16"] })), [BUILTIN_IDS.talking, BUILTIN_IDS.launch, BUILTIN_IDS.motion, BUILTIN_IDS.sound]);
  assert.deepEqual(suggestSkills(b("Walkthrough of the dashboard", { assets: ["screen recording of the app"] })), [BUILTIN_IDS.demo, BUILTIN_IDS.motion, BUILTIN_IDS.sound]);
  assert.deepEqual(suggestSkills(b("How it works under the hood", { duration: "60 s" })), [BUILTIN_IDS.explainer, BUILTIN_IDS.motion, BUILTIN_IDS.sound]);
  assert.deepEqual(suggestSkills(b("A kinetic typography opener")), [BUILTIN_IDS.titles, BUILTIN_IDS.motion, BUILTIN_IDS.sound]);
  assert.deepEqual(suggestSkills(b("Announcing the release", { formats: ["9:16 1080x1920", "16:9", "4:5"] })), [BUILTIN_IDS.launch, BUILTIN_IDS.social, BUILTIN_IDS.motion, BUILTIN_IDS.sound]);
  assert.deepEqual(suggestSkills(b("Our relationship with users")), [BUILTIN_IDS.launch, BUILTIN_IDS.motion, BUILTIN_IDS.sound], "no kind found: a launch promo");
});

test("the store (D232): a plugin's skills listed read-only, never saved, deleted or shadowed; the user's own beside them; old builtin- ids read as their names", async () => {
  const dataDir = join(root, "store-data");
  const projectDir = join(root, "store-project");
  mkdirSync(join(dataDir, "brand", "skills"), { recursive: true });
  mkdirSync(join(projectDir, "brand"), { recursive: true });
  const skills = bundledSkills();
  const dirs = { dataDir, projectDir, skills };
  // A file with an old built-in's id on disk is ignored; one with a plugin skill's id is the user's
  // own from before D232, renamed to a free id (D248) instead of shadowing or vanishing.
  writeFileSync(join(dataDir, "brand", "skills", "sound-design.json"), JSON.stringify({ id: "sound-design", name: "Hacked", description: "", body: "boom everywhere" }));
  writeFileSync(join(dataDir, "brand", "skills", "builtin-sound-design.json"), JSON.stringify({ id: "builtin-sound-design", name: "Hacked", description: "", body: "boom everywhere" }));
  await saveSkill(dirs, { id: "my-promo", name: "My promo", scope: "global", description: "", body: "Review checklist\n- Mine" });
  const state = await readBrand(dirs);
  assert.equal(state.skills.filter((s) => s.plugin === "uncut.skills").length, 11);
  const sound = state.skills.find((s) => s.id === BUILTIN_IDS.sound)!;
  assert.equal(sound.name, "Sound design");
  assert.equal(sound.builtin, true);
  assert.equal(sound.pluginName, "Uncut skills");
  assert.match(sound.body, /Review checklist/);
  assert.ok(state.skills.some((s) => s.id === "my-promo" && !s.plugin));
  assert.ok(!state.skills.some((s) => s.id === "builtin-sound-design"));
  assert.equal(state.skills.find((s) => s.id === "sound-design-2")?.name, "Hacked");
  await assert.rejects(saveSkill(dirs, { ...sound }), /A plugin's skills can't be changed/);
  // D248: a new skill named like a plugin's gets a free id of its own.
  assert.equal((await saveSkill(dirs, { id: "", name: "Sound design", scope: "global", description: "", body: "" })).id, "sound-design-3");
  await assert.rejects(deleteSkill(dirs, BUILTIN_IDS.sound, "global"), /can't be deleted here/);
  // Without the plugin (not allowed, or removed) its skills aren't there; the user's own are.
  const alone = await readBrand({ dataDir, projectDir });
  assert.ok(!alone.skills.some((s) => s.plugin));
  assert.equal(alone.skills.find((s) => s.id === "sound-design-2")?.name, "Hacked");
  // An old project's choice (before D232) reads as the skills' names now.
  writeFileSync(join(projectDir, "brand", "active.json"), JSON.stringify({ kit: null, skills: ["builtin-launch-promo", "my-promo", "builtin-sound-design"] }));
  assert.deepEqual((await readBrand(dirs)).active.skills, [BUILTIN_IDS.launch, "my-promo", BUILTIN_IDS.sound]);
  await writeActive(projectDir, { kit: null, skills: [BUILTIN_IDS.launch, "my-promo"] });
  assert.deepEqual((await readBrand(dirs)).active.skills, [BUILTIN_IDS.launch, "my-promo"]);
});

test("planContext (D232): the skills the project uses by name, no bodies and no picking", () => {
  const plan = { reviews: [] };
  const gate = gateOf(plan, false);
  const used = [BUILTIN_IDS.launch, BUILTIN_IDS.sound].map((id) => ({ id, name: bundledSkill(id).title }));
  const text = planContext({ files: {}, skills: used, others: [] }, plan, gate);
  assert.match(text, /Skills this project uses: Launch promo \(launch-promo\), Sound design \(sound-design\)\. Follow every rule in them \(skill_read gives one's instructions again\); the critic checks their review checklists\./);
  assert.ok(!text.includes(bundledSkill(BUILTIN_IDS.launch).instructions.slice(0, 60)), "no bodies in every message");
  const none = planContext({ files: {}, skills: [], others: [] }, plan, gate);
  assert.ok(!/Skills this project uses|No skills are on/.test(none));
  assert.match(AGENT_TEXT, /the critic checks its review checklist/);
  assert.match(AGENT_TEXT, /read it with skill_read before you start/);
  assert.ok(!/ask which to use|brief_write again with use/.test(SYSTEM_PROMPT + ALL_DOCS));
  assert.match(AGENT_TEXT, /4 in any 10 s/);
  assert.ok(!/cozy music/.test(SYSTEM_PROMPT + ALL_DOCS));
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
    skills: [{ name: "Sound design", checklist: skillChecklist(bundledSkill(BUILTIN_IDS.sound).instructions) }, { name: "Empty", checklist: [] }],
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

test("on the server (D232): the system prompt lists the skills; brief_write suggests skills to read; /launch-promo brings its instructions and skill_read another's; project_check and the critic see a click spam and a promo fails on it", { skip, timeout: 240000 }, async () => {
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

    // Turn 1: every installed skill is in the system prompt; the brief suggests a set to read, nothing is picked (D232).
    const brief = { film: "A 10 s launch teaser for Argent Cloud", audience: "React Native devs", duration: "10 s", formats: ["4:5"], assets: ["demo recording"], visual: "Dark, amber", hardLines: ["Never invent UI"], deliverables: ["4:5 mp4"] };
    const t1 = await ask("make a launch teaser", [{ tool: "brief_write", args: brief }, { tool: "library_add", args: { id: "sfx:ui-click" } }]);
    assert.equal(t1.status, "done", t1.error);
    const system = (prompts()[0] as { system?: string }).system ?? "";
    assert.match(system, /\n\nSkills \(installed in Uncut; skill_read \{"name": …\} gives one's instructions; the user calls one with \/name\):\n- launch-promo: A 15 to 30 s launch film/);
    assert.match(system, /\n- sound-design: Few, quiet, synced sound effects/);
    assert.match(system, /\n- make-brand-kit: Builds a brand kit from a link or dropped logos/);
    assert.ok(!/No skills are on/.test(prompts()[0]!.prompt));
    const [wrote, added] = fresh();
    const out = jsonOf(wrote!.result);
    assert.equal(out.type, "launch-promo", "the brief's words say launch teaser");
    assert.deepEqual(out.suggestedSkills.map((x: { id: string }) => x.id), [BUILTIN_IDS.launch, BUILTIN_IDS.demo, BUILTIN_IDS.motion, BUILTIN_IDS.sound], "a launch teaser with a demo recording");
    assert.deepEqual(out.skills, [], "none used yet");
    assert.match(out.skillsNote, /Read each suggested skill that fits with skill_read before you build \(no need to ask the user/);
    assert.equal(out.refused, undefined);
    assert.match(out.sound, /^strict/);
    assert.deepEqual(JSON.parse(readFileSync(join(snap.dir, "brief.json"), "utf8")).skills, [BUILTIN_IDS.launch, BUILTIN_IDS.demo, BUILTIN_IDS.motion, BUILTIN_IDS.sound]);
    assert.ok(!existsSync(join(snap.dir, "brand", "active.json")), "nothing used yet");
    const media = jsonOf(added!.result).media as string;

    // Turn 2: /launch-promo calls that skill (its instructions come with the message), skill_read
    // loads Sound design; both are used from then on; a text and 8 clicks in 8 s; the critic's round.
    const clicks = Array.from({ length: 8 }, (_, i) => ({ op: "insert_item", track: "audio", item: { id: `click-${i}`, type: "audio", media, in: 0, start: 6 + i * 30, duration: 6 } }));
    const t2 = await ask("/launch-promo add the clicks and review (see /tmp/launch-promo and /no-such-skill)", [
      { tool: "skill_read", args: { name: "sound-design" } },
      { tool: "skill_read", args: { name: "nope" } },
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
    assert.match(p2, /^\(skill launch-promo\) add the clicks and review \(see \/tmp\/launch-promo and \/no-such-skill\)/, "never a slash command for claude");
    assert.match(p2, /<skill name="launch-promo" title="Launch promo">\nThe user called the skill launch-promo \(\/launch-promo\) for this message: follow its instructions\.\nA launch film of 15 to 30 s/);
    assert.equal(p2.match(/<skill /g)?.length, 1, "a path or an unknown /word isn't a skill");
    assert.match(p2, /Skills this project uses: Launch promo \(launch-promo\)\./);
    const r = fresh();
    const read = jsonOf(r[0]!.result);
    assert.equal(read.name, BUILTIN_IDS.sound);
    assert.equal(read.from, "the plugin Uncut skills");
    assert.match(read.instructions, /Review checklist\n- Every sound effect lands on something that changes on screen/);
    assert.equal(r[1]!.result.isError, true);
    assert.match(textOf(r[1]!.result), /There's no skill "nope"\. The installed ones: .*launch-promo/);
    assert.deepEqual(JSON.parse(readFileSync(join(snap.dir, "brand", "active.json"), "utf8")).skills, [BUILTIN_IDS.launch, BUILTIN_IDS.sound], "called and read: used");
    const kept = jsonOf(r[2]!.result);
    assert.deepEqual(kept.skills.map((x: { id: string }) => x.id), [BUILTIN_IDS.launch, BUILTIN_IDS.sound]);
    assert.deepEqual(kept.suggestedSkills.map((x: { id: string }) => x.id), [BUILTIN_IDS.titles]);
    const checks = jsonOf(r[5]!.result).checks as Array<{ key?: string; id: string; message: string }>;
    const messages = checks.map((c) => c.message).join("\n");
    assert.match(messages, /8 sound effects start between 0\.2 s and 7\.2 s; at most 4 in any 10\.0 s/);
    assert.match(messages, /ui-click plays 8 times/);
    const review = jsonOf(r[8]!.result);
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
