// Round 3 J2 (U7–U9, U15–U17, U19; D186–D191) on the bundled server with fake-claude's session:
// brand kits and skills reach every message and brand_read / brand_write; ask_user's question card
// is answered (and skipped); brief_write saves brief.json; the build waits for the storyboard
// (refused, approved with edits, sent back with a note, approved by the setting); the critic's
// review needs a look first, saves its rounds and checks graphics draw the same twice; the brand
// colours check; reference_frames on a file outside the project; beat_grid's downbeats and snaps.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";
import { drums, writeWav } from "../helpers/beats-audio.ts";
import { beatGrid, gateOf, gateRefusal, planContext, questionOf, reviewVerdict } from "../../apps/server/src/agent/agentPlan.ts";
import { mcpTools, stepLabel, SYSTEM_PROMPT, LOOK_TOOLS } from "../../apps/server/src/agent/agentTools.ts";

const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const which = (name: string) => {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};
const FFMPEG = which("ffmpeg");
const skip = !existsSync(BUNDLE) || !existsSync(MCP) || !existsSync(MEDIA) ? "server bundle or media core not built (run pnpm build)" : !FFMPEG ? "ffmpeg isn't installed" : false;
type Content = Array<{ type: string; text?: string; mimeType?: string }>;
const textOf = (r: { content: Content }) => r.content.find((c) => c.type === "text")!.text!;
const jsonOf = (r: { content: Content }) => JSON.parse(textOf(r));
// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

let root = "";
after(() => {
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});
before(() => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-agent-production-")));
});

async function setup(name: string) {
  const base = join(root, name);
  mkdirSync(join(base, "projects"), { recursive: true });
  const plan = join(base, "plan.json");
  const log = join(base, "prompts.jsonl");
  const results = join(base, "results.jsonl");
  writeFileSync(log, "");
  writeFileSync(results, "");
  const data = join(base, "data");
  const server = await startServer({ env: { UNCUT_DATA_DIR: data, UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan, FAKE_PROMPT_LOG: log, FAKE_RESULT_LOG: results, UNCUT_APPROVAL_MS: "8000", UNCUT_ANALYZE_WAIT_MS: "20000" } });
  const client = await connect(server.ready.port, server.ready.token);
  const agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(base, "projects"), name: "Promo" });
  await agent.until((s) => s?.dir === snap.dir);
  const turns: Array<unknown> = [];
  const latest = () => agent.values.at(-1);
  const turn = (id: string) => latest()?.turns.find((t: { id: string }) => t.id === id);
  let seen = 0;
  const self = {
    base,
    data,
    client,
    agent,
    latest,
    dir: snap.dir as string,
    prompts: (): Array<{ prompt: string; system: string }> => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.refused),
    /** Tool results since the last call. */
    results: (): Array<{ tool: string; result: { isError?: boolean; content: Content } }> => {
      const all = readFileSync(results, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const out = all.slice(seen);
      seen = all.length;
      return out;
    },
    start: async (prompt: string, steps: Array<unknown>, extra: Record<string, unknown> = {}) => {
      turns.push(steps);
      writeFileSync(plan, JSON.stringify(turns));
      const { turnId } = await client.ok("agent.send", { prompt, ...extra });
      return turnId as string;
    },
    done: async (id: string) => {
      await agent.until(() => turn(id) && turn(id).status !== "running", 60000);
      return turn(id);
    },
    card: async (id: string) => (await agent.until((v) => v?.approval?.turnId === id, 15000), latest().approval),
    ask: async (prompt: string, steps: Array<unknown>, extra: Record<string, unknown> = {}) => self.done(await self.start(prompt, steps, extra)),
    stop: async () => {
      client.close();
      await server.stop();
    },
  };
  return self;
}

const BEATS = [
  { start: 0, end: 2, title: "Hook", entry: "Black, the claim types in", exit: "The claim held", purpose: "Say what it does", assets: ["logo"], sound: "the first downbeat" },
  { start: 2, end: 6, title: "Demo", entry: "The claim", exit: "The recording's last frame", purpose: "Show it working", assets: ["recording"] },
];
const TITLE = { id: "title-1", type: "text", start: 0, duration: 60, text: "Argent Cloud", transform: { x: 100, y: 100 }, style: { preset: "text.title", size: 90, weight: 700, color: "#ff0000" } };

test("the tools, labels, Look only set and the prompt's production process", () => {
  const names = mcpTools().map((t) => t.name);
  for (const n of ["ask_user", "brief_write", "storyboard_propose", "review_submit", "brand_read", "brand_write", "reference_frames", "beat_grid"]) assert.ok(names.includes(n), n);
  assert.ok((LOOK_TOOLS as ReadonlyArray<string>).includes("ask_user") && (LOOK_TOOLS as ReadonlyArray<string>).includes("storyboard_propose") && !(LOOK_TOOLS as ReadonlyArray<string>).includes("brand_write"));
  assert.equal(stepLabel("ask_user", { question: "Which logo?" }), "Asked: Which logo?");
  assert.equal(stepLabel("storyboard_propose", { beats: BEATS }), "Proposed a storyboard of 2 beats");
  assert.equal(stepLabel("review_submit", { scores: { hook: 9, readability: 7 } }), "Reviewed the video (lowest score 7)");
  for (const want of [/ask_user/, /brief_write/, /storyboard_propose/, /review_submit/, /beat_grid/, /never invent a logo/i, /hard lines/, /8 or more, at most 3 rounds/, /reference_frames/, /spring/]) assert.match(SYSTEM_PROMPT, want);
  assert.ok(!/[·•]/.test(SYSTEM_PROMPT.replace(/never ·, • or \*/, "")), "no dot separators in the prompt");
});

test("pure parts: question, gate, verdict, context and the beat grid", () => {
  assert.deepEqual(questionOf({ question: "Length?", options: [{ label: "15 s" }, { label: "30 s" }], multi: true }), { question: "Length?", options: [{ label: "15 s" }, { label: "30 s" }], multi: true, freeText: true });
  assert.ok("problem" in questionOf({ question: " " }));
  const plan = { brief: { film: "x", audience: "", duration: "", formats: [], assets: [], visual: "", hardLines: [], deliverables: [] }, reviews: [] };
  assert.match(gateRefusal(plan, gateOf(plan, false))!, /no storyboard yet/);
  assert.equal(gateRefusal(plan, gateOf(plan, true)), undefined, "the setting skips the gate");
  assert.equal(gateRefusal({ reviews: [] }, gateOf({ reviews: [] }, false)), undefined, "no brief, no gate (small edits)");
  const v = reviewVerdict({ hook: 9, readability: 7, motion: 8, variety: 8, sound: 8, brand: 9 }, 1, []);
  assert.equal(v.passed, false);
  assert.match(v.next, /round 2/);
  assert.match(reviewVerdict({ hook: 9, readability: 7, motion: 8, variety: 8, sound: 8, brand: 9 }, 3, []).next, /last one/);
  assert.equal(reviewVerdict({ hook: 9, readability: 9, motion: 9, variety: 9, sound: 9, brand: 9 }, 1, ["glow"]).passed, false, "a graphic that drew differently fails the round");
  const ctx = planContext({ files: {}, skills: [], others: [{ id: "argent", name: "Argent" }] }, plan, gateOf(plan, false));
  assert.match(ctx, /No brand kit is chosen[\s\S]*"Argent" \(argent\)/);
  assert.match(ctx, /waits for a storyboard/);
  // 120 bpm, beats at 0.2 + 0.5k s; the strongest every 4th from the 2nd beat.
  const beats = Array.from({ length: 16 }, (_, i) => 0.2 + i * 0.5);
  const onsets = beats.map((t, i) => ({ t, strength: i % 4 === 1 ? 1 : 0.4 }));
  const g = beatGrid({ hasAudio: true, bpm: 120, confidence: 0.9, beats, onsets }, { id: "music-1", media: "m", start: 30, in: 0, duration: 300, speed: 1 }, 30, undefined, [50]);
  assert.deepEqual(g.beats.slice(0, 3), [36, 51, 66]);
  assert.deepEqual(g.downbeats.slice(0, 2), [51, 111], "every 4th beat, the accented phase");
  assert.deepEqual(g.snaps, [{ frame: 50, beat: 51, off: 1, downbeat: 51 }]);
});

test("U8/U15/U9: ask_user is answered, the brief is saved, the build waits for the storyboard, approved with edits", { skip, timeout: 120000 }, async () => {
  const s = await setup("flow");
  try {
    // A question with options and free text; answered on the card.
    const q = await s.start("make a 20 s promo for Argent Cloud", [{ tool: "ask_user", args: { question: "Which format?", options: [{ label: "9:16", detail: "Phone" }, { label: "16:9" }] } }, { text: "Got it" }]);
    const card = await s.card(q);
    assert.equal(card.question.question, "Which format?");
    assert.deepEqual(card.question.options.map((o: any) => o.label), ["9:16", "16:9"]);
    assert.equal(card.question.freeText, true);
    assert.ok(Date.parse(card.until) - Date.now() <= 9000, "UNCUT_APPROVAL_MS shortens the wait in tests");
    await s.client.ok("agent.approve", { id: card.id, allow: true, answer: { choices: ["9:16"], text: "and a square cut" } });
    const qt = await s.done(q);
    assert.equal(qt.status, "done", qt.error);
    const [asked] = s.results();
    assert.deepEqual(jsonOf(asked!.result), { answered: true, choices: ["9:16"], text: "and a square cut" });
    const qcard = qt.items.find((i: any) => i.kind === "card");
    assert.equal(qcard.card.type, "question");
    assert.deepEqual(qcard.card.answer, { choices: ["9:16"], text: "and a square cut" });
    // Skip: the agent hears it was skipped, and not to invent.
    const q2 = await s.start("again", [{ tool: "ask_user", args: { question: "Logo file?" } }]);
    await s.client.ok("agent.approve", { id: (await s.card(q2)).id, allow: false });
    await s.done(q2);
    const skipped = jsonOf(s.results()[0]!.result);
    assert.equal(skipped.answered, false);
    assert.match(skipped.next, /Don't invent/);

    // The brief, then an edit before the storyboard is refused.
    const brief = { film: "Argent Cloud runs your app's QA in the cloud", audience: "React Native devs", duration: "20 s", formats: ["9:16 1080x1920"], assets: ["the dashboard recording", "Argent logo"], visual: "Dark, product first", hardLines: ["Never invent product UI or metrics"], deliverables: ["promo.mp4"] };
    const b = await s.ask("write the brief", [{ tool: "brief_write", args: brief }, { tool: "project_read" }, { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Scene 1: hook", ops: [{ op: "insert_item", track: "text", item: TITLE }] } }]);
    assert.equal(b.status, "done", b.error);
    const [wrote, , refused] = s.results();
    assert.match(jsonOf(wrote!.result).next, /storyboard_propose/);
    assert.equal(refused!.result.isError, true);
    assert.match(textOf(refused!.result), /no storyboard yet/);
    assert.equal(b.edits.length, 0);
    const saved = JSON.parse(readFileSync(join(s.dir, "brief.json"), "utf8"));
    assert.equal(saved.film, brief.film);
    assert.equal(saved.by, "agent");
    assert.equal(s.latest().plan.brief.film, brief.film, "the plan reaches the Agent tab");
    assert.equal(b.items.find((i: any) => i.kind === "card").card.type, "brief");

    // The storyboard card: the user edits a beat's title and approves; the build goes through.
    const sb = await s.start("storyboard", [{ tool: "storyboard_propose", args: { summary: "Hook, then the demo", beats: BEATS } }, { tool: "project_read" }, { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Scene 1: hook", ops: [{ op: "insert_item", track: "text", item: TITLE }] } }]);
    const sbCard = await s.card(sb);
    assert.equal(sbCard.storyboard.status, "proposed");
    assert.equal(sbCard.storyboard.beats.length, 2);
    assert.equal(JSON.parse(readFileSync(join(s.dir, "storyboard.json"), "utf8")).status, "proposed", "saved while it waits");
    const edited = [{ ...BEATS[0], title: "The claim" }, BEATS[1]];
    await s.client.ok("agent.approve", { id: sbCard.id, allow: true, beats: edited });
    const built = await s.done(sb);
    assert.equal(built.status, "done", built.error);
    const [proposed] = s.results();
    const approved = jsonOf(proposed!.result);
    assert.equal(approved.approved, true);
    assert.equal(approved.edited, true);
    assert.equal(approved.beats[0].title, "The claim");
    assert.equal(built.edits.length, 1, "approved: the build goes through");
    const file = JSON.parse(readFileSync(join(s.dir, "storyboard.json"), "utf8"));
    assert.equal(file.status, "approved");
    assert.equal(file.approvedBy, "user");
    assert.equal(file.beats[0].title, "The claim");
    // The next message carries the plan.
    await s.ask("next", [{ text: "ok" }]);
    const last = s.prompts().at(-1)!.prompt;
    assert.match(last, /<plan>[\s\S]*Brief:[\s\S]*film: Argent Cloud runs[\s\S]*Storyboard \(approved\)[\s\S]*1\. 0–2 s The claim/);
    s.results();
  } finally {
    await s.stop();
  }
});

test("U15: a storyboard sent back with a note keeps the build waiting; the Plan card approves it; the setting approves by itself", { skip, timeout: 120000 }, async () => {
  const s = await setup("gate");
  try {
    await s.ask("brief", [{ tool: "brief_write", args: { film: "A teaser", audience: "devs", duration: "10 s", formats: ["16:9"], assets: [], visual: "", hardLines: [], deliverables: [] } }]);
    const id = await s.start("storyboard", [{ tool: "storyboard_propose", args: { summary: "Two beats", beats: BEATS } }, { tool: "project_read" }, { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Scene 1", ops: [{ op: "insert_item", track: "text", item: TITLE }] } }]);
    await s.client.ok("agent.approve", { id: (await s.card(id)).id, allow: false, note: "Open on the dashboard, not the logo" });
    const t = await s.done(id);
    s.results();
    assert.equal(t.edits.length, 0);
    const sbStep = t.items.filter((i: any) => i.kind === "step");
    assert.match(sbStep.at(-1).error, /asked for changes to the storyboard \("Open on the dashboard, not the logo"\)/);
    assert.equal(t.items.find((i: any) => i.kind === "card").card.outcome, "declined");
    // The user approves it on the Plan card (agent.planSave): the build goes through.
    const plan = s.latest().plan;
    const saved = await s.client.ok("agent.planSave", { storyboard: { ...plan.storyboard, status: "approved" } });
    assert.equal(saved.storyboard.status, "approved");
    assert.equal(saved.storyboard.approvedBy, "user");
    const go = await s.ask("build", [{ tool: "project_read" }, { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Scene 1", ops: [{ op: "insert_item", track: "text", item: TITLE }] } }]);
    assert.equal(go.edits.length, 1, go.items.map((i: any) => i.error).join(" "));
    // The user edits the brief: saved as theirs, the next message says so.
    const brief = await s.client.ok("agent.planSave", { brief: { ...saved.brief, audience: "React Native teams" } });
    assert.equal(brief.brief.by, "user");
    await s.ask("go on", [{ text: "ok" }]);
    assert.match(s.prompts().at(-1)!.prompt, /Brief \(edited by the user\):[\s\S]*audience: React Native teams/);
    // Edit freely with the setting: the storyboard approves itself, no card.
    const auto = await s.ask("new storyboard", [{ tool: "storyboard_propose", args: { summary: "Again", beats: BEATS } }], { access: "edit", skipStoryboard: true });
    const out = jsonOf(s.results().at(-1)!.result);
    assert.equal(out.approved, true);
    assert.equal(out.by, "setting");
    assert.equal(auto.items.find((i: any) => i.kind === "card").card.outcome, "auto");
    assert.equal(JSON.parse(readFileSync(join(s.dir, "storyboard.json"), "utf8")).approvedBy, "setting");
  } finally {
    await s.stop();
  }
});

test("U16: the review needs a look first, saves rounds with scores and defects, and checks a graphic draws the same twice", { skip, timeout: 180000 }, async () => {
  const s = await setup("review");
  try {
    const html = `<canvas id="c"></canvas><script>const c=document.getElementById("c");window.render=(t,info)=>{c.width=info.width;c.height=info.height;const x=c.getContext("2d");x.fillStyle="#0b1d3a";x.fillRect(0,0,c.width,c.height);x.fillStyle="#f5a623";x.fillRect(40+t*200,40,120,120);};</script>`;
    const scores = { hook: 9, readability: 6, motion: 8, variety: 8, sound: 7, brand: 9 };
    const t = await s.ask("review it", [
      { tool: "graphic_write", args: { name: "box.html", html } },
      { tool: "project_read" },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Scene 1", ops: [{ op: "add_track", track: { id: "v2", kind: "video", name: "Graphics", items: [] }, index: 0 }, { op: "insert_item", track: "v2", item: { id: "g-1", type: "graphic", src: "graphics/box.html", start: 0, duration: 30 } }] } },
      { tool: "review_submit", args: { scores, defects: [{ at: 0.5, what: "Title too small on a phone" }] } },
      { tool: "contact_sheet", args: { max: 4 } },
      { tool: "render_frames", args: { frames: [0, 15], phone: true } },
      { tool: "review_submit", args: { scores, defects: [{ at: 0.5, what: "Title too small on a phone", fix: "Size 120" }, { at: 0.9, what: "Whoosh late" }] } },
      { tool: "review_submit", args: { scores, defects: [] } },
    ]);
    assert.equal(t.status, "done", t.error);
    const r = s.results();
    const early = r[3]!;
    assert.equal(early.result.isError, true);
    assert.match(textOf(early.result), /Look before you score: a contact_sheet of the edit .* and render_frames with phone true/);
    const phone = r[5]!;
    assert.match(textOf(phone.result), /at 360×202/, "phone true draws 360 px wide (a 16:9 canvas)");
    const round1 = jsonOf(r[6]!.result);
    assert.equal(round1.round, 1);
    assert.equal(round1.passed, false);
    assert.equal(round1.determinism, "1 graphic drew the same twice");
    assert.match(round1.next, /Under 8: readability, sound[\s\S]*round 2/);
    assert.match(textOf(r[7]!.result), /Look before you score/, "each round looks again");
    const saved = JSON.parse(readFileSync(join(s.dir, "reviews", "review-1.json"), "utf8"));
    assert.deepEqual(saved.scores, scores);
    assert.deepEqual(saved.determinism, { checked: ["box.html"], differed: [] });
    assert.deepEqual(saved.looked, { sheet: true, phone: true });
    assert.equal(saved.defects[0].fix, "Size 120");
    const card = t.items.find((i: any) => i.kind === "card" && i.card.type === "review");
    assert.equal(card.card.review.round, 1);
    assert.equal(s.latest().plan.reviews.length, 1);
    // Cards come back with the history after a close and reopen.
    await s.client.ok("project.close", {});
    await s.agent.until((v) => v === null);
    await s.client.ok("project.open", { dir: s.dir });
    const reopened = await s.agent.until((v) => v?.dir === s.dir && v.turns.some((x: any) => x.id === t.id));
    const state = reopened ?? s.agent.values.findLast((v: any) => v?.dir === s.dir);
    const back = state.turns.find((x: any) => x.id === t.id);
    const kept = back.items.find((i: any) => i.kind === "card" && i.card.type === "review");
    assert.deepEqual(kept.card.review.scores, scores, "the review card is kept in history.db");
    assert.equal(state.plan.reviews.length, 1, "the plan is read again on open");
  } finally {
    await s.stop();
  }
});

test("U7/U17: kits and skills reach every message; brand_read and its files; brand_write's style guide and new kit; the brand colours check; reference_frames", { skip, timeout: 180000 }, async () => {
  const s = await setup("brand");
  try {
    // A global kit with a logo, a project skill; the project picks both.
    const logo = join(s.base, "argent-logo.png");
    writeFileSync(logo, Buffer.from(PNG, "base64"));
    const kit = { id: "argent", name: "Argent", scope: "global", logos: {}, colors: [{ hex: "#0B1D3A", role: "background" }, { hex: "#f5a623", role: "accent" }, { hex: "#ffffff", role: "text" }], fonts: [{ family: "Inter", role: "headline", weight: 700 }], tone: "Plain, dev to dev", taglines: ["QA for your app, in the cloud"], urls: ["argent.dev"], dos: ["Show the real dashboard"], donts: ["No stock footage"], examples: [] };
    await s.client.ok("brand.saveKit", { kit });
    const added = await s.client.ok("brand.addFile", { kit: "argent", scope: "global", path: logo });
    assert.equal(added.name, "argent-logo.png");
    assert.ok(existsSync(join(s.data, "brand", "kits", "argent", "argent-logo.png")), "kept in the user's data folder");
    await s.client.ok("brand.saveKit", { kit: { ...kit, logos: { light: added.name } } });
    await s.client.ok("brand.saveSkill", { skill: { id: "launch-promo", name: "Launch promo 20 s", scope: "project", description: "Hook, demo, end card", body: "- Hook in 2 s\n- End card with the URL" } });
    const state = await s.client.ok("brand.setActive", { kit: "argent", skills: ["launch-promo"] });
    assert.equal(state.active.kit, "argent");
    assert.ok(existsSync(join(s.dir, "brand", "skills", "launch-promo.json")) && existsSync(join(s.dir, "brand", "active.json")));
    // The message has the kit and the skill; brand_read gives them, and the logo as an image.
    const t = await s.ask("make the promo", [{ tool: "brand_read" }, { tool: "brand_read", args: { file: "argent-logo.png" } }, { text: "ok" }]);
    assert.equal(t.status, "done", t.error);
    const prompt = s.prompts().at(-1)!.prompt;
    assert.match(prompt, /<brand>\nKit "Argent" \(argent, the user's\)\nColours: #0b1d3a background; #f5a623 accent; #ffffff text\nFonts: Inter for headline 700\nLogo on light backgrounds: argent-logo\.png \(/);
    assert.match(prompt, /Skill "Launch promo 20 s" \(Hook, demo, end card\):\n- Hook in 2 s/);
    const [read, file] = s.results();
    const kitOut = jsonOf(read!.result);
    assert.equal(kitOut.logos.light.name, "argent-logo.png");
    assert.ok(kitOut.logos.light.path.endsWith("argent-logo.png"));
    assert.equal(kitOut.skills[0].name, "Launch promo 20 s");
    assert.equal(file!.result.content[1]!.type, "image");
    // The brand colours check: a red title is off-brand, the fix moves it to the kit's nearest.
    const c = await s.ask("check", [{ tool: "project_read" }, { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Title", ops: [{ op: "insert_item", track: "text", item: TITLE }] } }, { tool: "project_check" }]);
    assert.equal(c.edits.length, 1);
    const checks = jsonOf(s.results()[2]!.result);
    const brandCheck = (checks.checks ?? checks.warnings ?? checks).find?.((x: any) => x.id === "brand-colours") ?? JSON.stringify(checks).includes("brand-colours");
    assert.ok(brandCheck, JSON.stringify(checks).slice(0, 600));
    assert.match(JSON.stringify(checks), /#ff0000, not a colour of the kit \\"Argent\\"/);
    // A style from a reference: reference_frames on a clip outside the project, brand_write the style.
    const ref = join(s.base, "reference.mp4");
    execFileSync(FFMPEG!, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", ref]);
    const style = { palette: [{ hex: "#101010", role: "background" }, { hex: "#E8FF59", role: "accent" }], type: "Grotesk, tight, all caps headlines", shotLengths: "0.8 to 1.5 s", transitions: "Hard cuts, a whip on the drop", camera: "Locked off, slow push", grain: "Light film grain" };
    const st = await s.ask(`Make a style guide for the kit "Argent" (argent) from this reference: ${ref}`, [{ tool: "reference_frames", args: { path: ref, count: 6 } }, { tool: "brand_write", args: { kit: "argent", style: { ...style, source: "reference.mp4" } } }, { tool: "brand_write", args: { name: "Side project", colors: [{ hex: "#123456", role: "background" }] } }]);
    assert.equal(st.status, "done", st.error);
    const [sheet, wroteStyle, newKit] = s.results();
    assert.match(textOf(sheet!.result), /The reference reference\.mp4: 3\.0 s, 320×180, 6 frames/);
    assert.equal(sheet!.result.content[1]!.type, "image");
    assert.ok(!existsSync(join(s.dir, "media")) || !readFileSync(join(s.dir, "project.json"), "utf8").includes("reference.mp4"), "the reference isn't imported");
    assert.match(jsonOf(wroteStyle!.result).kit, /Style guide \(from reference\.mp4\):; palette: #101010 background; #e8ff59 accent/);
    const onDisk = JSON.parse(readFileSync(join(s.data, "brand", "kits", "argent", "kit.json"), "utf8"));
    assert.equal(onDisk.style.shotLengths, "0.8 to 1.5 s");
    assert.equal(onDisk.colors.length, 3, "the rest of the kit is kept");
    assert.equal(jsonOf(newKit!.result).saved, "side-project");
    assert.ok(existsSync(join(s.dir, "brand", "kits", "side-project", "kit.json")), "a new kit from the agent is the project's");
    const cards = st.items.filter((i: any) => i.kind === "card").map((i: any) => i.card.text);
    assert.deepEqual(cards, ["Style guide written into Argent", "New kit Side project"]);
    // Without a kit, brand_read says not to invent and lists the kits.
    await s.client.ok("brand.setActive", { kit: null, skills: [] });
    await s.ask("logo?", [{ tool: "brand_read" }]);
    const none = jsonOf(s.results()[0]!.result);
    assert.equal(none.kit, null);
    assert.match(none.next, /Don't invent a logo/);
    assert.ok(none.kits.some((k: any) => k.id === "argent"));
  } finally {
    await s.stop();
  }
});

test("U19: beat_grid gives the music's beats, downbeats and snaps in timeline frames", { skip, timeout: 180000 }, async () => {
  const s = await setup("beats");
  try {
    const footage = join(s.base, "Footage");
    mkdirSync(footage);
    writeWav(join(footage, "Song.wav"), drums(120, 12, 0.2).buf);
    const t = await s.ask("music", [
      { tool: "media_import", args: { path: join(footage, "Song.wav") } },
      { tool: "beat_grid" },
      { tool: "project_read" },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Music", ops: [{ op: "insert_item", track: "audio", item: { id: "music-1", type: "audio", media: "m-song", in: 0, start: 30, duration: 300 } }] } },
      { tool: "beat_grid", args: { snap: [50, 100] } },
    ]);
    assert.equal(t.status, "done", t.error);
    const r = s.results();
    assert.equal(r[1]!.result.isError, true);
    assert.match(textOf(r[1]!.result), /no music on the timeline yet/);
    let grid = jsonOf(r[4]!.result);
    if (grid.note?.includes("still running")) {
      await s.ask("again", [{ tool: "beat_grid", args: { snap: [50, 100] } }]);
      grid = jsonOf(s.results()[0]!.result);
    }
    assert.ok(Math.abs(grid.bpm - 120) <= 1, JSON.stringify(grid).slice(0, 300));
    assert.equal(grid.beats[0], 36, "the first beat (0.2 s in the song) at timeline frame 30 + 6");
    assert.equal(grid.beats[1] - grid.beats[0], 15);
    assert.equal(grid.downbeats[1] - grid.downbeats[0], 60, "a downbeat every 4 beats");
    assert.equal(grid.snaps[0].beat, 51);
    assert.equal(grid.snaps[0].off, 1);
    assert.match(grid.note, /downbeats/);
    assert.equal(t.items.filter((i: any) => i.kind === "step").at(-1).text, "Put 2 moments on the beat");
  } finally {
    await s.stop();
  }
});
