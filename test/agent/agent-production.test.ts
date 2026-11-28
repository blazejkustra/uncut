// Round 3 J2 (U7–U9, U15–U17, U19; D186–D191) on the bundled server with fake-claude's session:
// brand kits and skills reach every message and brand_read / brand_write; ask_user's question card
// is answered (and skipped); brief_write saves brief.json; storyboard_propose records the plan and
// shows it in the thread, nobody approves it and nothing waits for it; the brand colours check;
// reference_frames on a file outside the project; beat_grid's downbeats and snaps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drums, writeWav } from "../helpers/beats-audio.ts";
import { BEATS, FFMPEG, TITLE, jsonOf, productionServers, skip, textOf } from "../helpers/production-server.ts";
import { beatGrid, dropOf, planContext, questionOf } from "../../apps/server/src/agent/agentPlan.ts";
import { mcpTools, stepLabel, SYSTEM_PROMPT, LOOK_TOOLS } from "../../apps/server/src/agent/agentTools.ts";
import { AGENT_TEXT } from "../helpers/agentText.ts";

// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const setup = productionServers("uncut-agent-production-");

test("the tools, labels, Look only set and the prompt's production process", () => {
  const names = mcpTools().map((t) => t.name);
  for (const n of ["ask_user", "brief_write", "storyboard_propose", "review_submit", "brand_read", "brand_write", "reference_frames", "beat_grid"])
    assert.ok(names.includes(n), n);
  assert.ok(
    (LOOK_TOOLS as ReadonlyArray<string>).includes("ask_user") &&
      (LOOK_TOOLS as ReadonlyArray<string>).includes("storyboard_propose") &&
      !(LOOK_TOOLS as ReadonlyArray<string>).includes("brand_write"),
  );
  assert.equal(stepLabel("ask_user", { question: "Which logo?" }), "Asked: Which logo?");
  assert.equal(stepLabel("storyboard_propose", { beats: BEATS }), "Proposed a storyboard of 2 beats");
  assert.equal(stepLabel("review_submit", { scores: { hook: 9, readability: 7 } }), "Asked the critic for a review");
  assert.equal(stepLabel("review_submit", { fixes: [{ defect: "d1", what: "x" }] }), "Asked the critic to check 1 fix");
  for (const want of [
    /ask_user/,
    /brief_write/,
    /storyboard_propose/,
    /review_submit/,
    /beat_grid/,
    /never invent a logo/i,
    /hard lines/,
    /You don't score your own work/,
    /back unchanged after you claimed its fix is unresolved: don't try it again, ask the user/,
    /The user's own numbers \(a text size, a timing\) win/,
    /At most 3 rounds in a turn for each video \(15 in all\), 1 on a turn whose message points at a moment[\s\S]*At the limit the film has not passed/,
    /Several videos in one project[^\n]*flat on Main one after another, each starting at a marker named after it/,
    /Never nest a video in a sequence unless the user asks for one/,
    /review_submit \{"marker":"Promo 1"\} reviews that video alone[^\n]*export_video \{"marker":"Promo 1"\} exports it alone/,
    /reference_frames/,
    /spring/,
  ])
    assert.match(AGENT_TEXT, want);
  assert.match(SYSTEM_PROMPT, /follows the production process: docs_read production first/);
  assert.ok(!/[·•]/.test(AGENT_TEXT.replace(/never ·, • or \*/, "")), "no dot separators in the prompt");
});

test("pure parts: question, verdict, context and the beat grid", () => {
  assert.deepEqual(questionOf({ question: "Length?", options: [{ label: "15 s" }, { label: "30 s" }], multi: true }), {
    question: "Length?",
    options: [{ label: "15 s" }, { label: "30 s" }],
    multi: true,
    freeText: true,
  });
  assert.ok("problem" in questionOf({ question: " " }));
  const plan = { brief: { film: "x", audience: "", duration: "", formats: [], assets: [], visual: "", hardLines: [], deliverables: [] }, reviews: [] };
  const ctx = planContext({ files: {}, skills: [], others: [{ id: "argent", name: "Argent" }] }, plan);
  assert.match(ctx, /No brand kit is chosen[\s\S]*"Argent" \(argent\)/);
  assert.doesNotMatch(ctx, /waits|approv/);
  // 120 bpm, beats at 0.2 + 0.5k s; the strongest every 4th from the 2nd beat.
  const beats = Array.from({ length: 16 }, (_, i) => 0.2 + i * 0.5);
  const onsets = beats.map((t, i) => ({ t, strength: i % 4 === 1 ? 1 : 0.4 }));
  const g = beatGrid(
    { hasAudio: true, bpm: 120, confidence: 0.9, beats, onsets },
    { id: "music-1", media: "m", start: 30, in: 0, duration: 300, speed: 1 },
    30,
    undefined,
    [50],
  );
  assert.deepEqual(g.beats.slice(0, 3), [36, 51, 66]);
  assert.deepEqual(g.downbeats.slice(0, 2), [51, 111], "every 4th beat, the accented phase");
  assert.deepEqual(g.snaps, [{ frame: 50, beat: 51, off: 1, downbeat: 51 }]);
  assert.equal(g.drop, null, "an even track has no drop");
  // D295: 4 quiet bars, then every beat hits hard: the drop is the first loud downbeat (beat 16, 8.2 s).
  const long = Array.from({ length: 32 }, (_, i) => 0.2 + i * 0.5);
  const build = long.map((t, i) => ({ t, strength: i < 16 ? (i % 4 === 0 ? 0.5 : 0.1) : 1 }));
  assert.deepEqual(dropOf(long, 0, build), { seconds: 8.2, rise: 5, beat: 16 });
  const d = beatGrid(
    { hasAudio: true, bpm: 120, confidence: 0.9, beats: long, onsets: build },
    { id: "music-1", media: "m", start: 0, in: 0, duration: 600, speed: 1 },
    30,
  );
  assert.deepEqual(d.drop, { frame: 246, rise: 5 });
  assert.ok(d.downbeats.includes(246));
});

test(
  "U8/U15/U9: ask_user is answered, the brief is saved, the storyboard is recorded at once and the build goes ahead",
  { skip, timeout: 120000 },
  async () => {
    const s = await setup("flow");
    try {
      // A question with options and free text; answered on the card.
      const q = await s.start("make a 20 s promo for Argent Cloud", [
        { tool: "ask_user", args: { question: "Which format?", options: [{ label: "9:16", detail: "Phone" }, { label: "16:9" }] } },
        { text: "Got it" },
      ]);
      const card = await s.card(q);
      assert.equal(card.question.question, "Which format?");
      assert.deepEqual(
        card.question.options.map((o: any) => o.label),
        ["9:16", "16:9"],
      );
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

      // The brief, then an edit right away: no storyboard needed first.
      const brief = {
        film: "Argent Cloud runs your app's QA in the cloud",
        audience: "React Native devs",
        duration: "20 s",
        formats: ["9:16 1080x1920"],
        assets: ["the dashboard recording", "Argent logo"],
        visual: "Dark, product first",
        hardLines: ["Never invent product UI or metrics"],
        deliverables: ["promo.mp4"],
      };
      const b = await s.ask("write the brief", [
        { tool: "brief_write", args: brief },
        { tool: "project_read" },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Scene 1: hook", ops: [{ op: "insert_item", track: "text", item: TITLE }] } },
      ]);
      assert.equal(b.status, "done", b.error);
      const [wrote] = s.results();
      assert.match(jsonOf(wrote!.result).next, /storyboard_propose, then build it/);
      assert.equal(b.edits.length, 1, "nothing waits for a storyboard");
      const saved = JSON.parse(readFileSync(join(s.dir, "brief.json"), "utf8"));
      assert.equal(saved.film, brief.film);
      assert.equal(saved.by, "agent");
      assert.equal(s.latest().plan.brief.film, brief.film, "the plan reaches the Agent tab");
      assert.equal(b.items.find((i: any) => i.kind === "card").card.type, "brief");

      // The storyboard: recorded at once, shown as a card in the thread, no approval card; the next edit goes through.
      const sb = await s.ask("storyboard", [
        { tool: "storyboard_propose", args: { summary: "Hook, then the demo", beats: BEATS } },
        { tool: "project_read" },
        {
          tool: "timeline_edit",
          args: { baseRevision: "$rev", summary: "Scene 2", ops: [{ op: "insert_item", track: "text", item: { ...TITLE, id: "title-2", start: 60 } }] },
        },
      ]);
      assert.equal(sb.status, "done", sb.error);
      assert.ok(!s.agent.values.some((v: any) => v?.approval?.turnId === sb.id), "no approval card");
      const [proposed] = s.results();
      const recorded = jsonOf(proposed!.result);
      assert.equal(recorded.recorded, true);
      assert.match(recorded.message, /Build it scene by scene/);
      assert.equal(sb.edits.length, 1, "the build right after goes through");
      const sbCard = sb.items.find((i: any) => i.kind === "card").card;
      assert.equal(sbCard.type, "storyboard");
      assert.equal(sbCard.outcome, undefined);
      assert.equal(sbCard.storyboard.beats.length, 2);
      const file = JSON.parse(readFileSync(join(s.dir, "storyboard.json"), "utf8"));
      assert.equal(file.status, "approved");
      assert.equal(file.approvedBy, "agent");
      // The next message carries the plan.
      await s.ask("next", [{ text: "ok" }]);
      const last = s.prompts().at(-1)!.prompt;
      assert.match(last, /<plan>[\s\S]*Brief:[\s\S]*film: Argent Cloud runs[\s\S]*Storyboard \(your plan\)[\s\S]*1\. 0–2 s Hook/);
      s.results();
    } finally {
      await s.stop();
    }
  },
);

test(
  "D295: storyboard_propose renders a still per beat for the card; a graphic's moment needs no placing; past 4 is a note, not a refusal",
  { skip, timeout: 120000 },
  async () => {
    const s = await setup("stills");
    try {
      // Before a brief there's no gate: the title goes on the timeline so the stills have something to show,
      // and a graphic is written but not placed (its still is drawn alone).
      const look =
        "<!doctype html><canvas id=c width=64 height=64></canvas><script>window.render=(t)=>{const x=document.getElementById('c').getContext('2d');x.fillStyle=t>0.4?'#f00':'#00f';x.fillRect(0,0,64,64);}</script>";
      const placed = await s.ask("place the title", [
        { tool: "graphic_write", args: { name: "look.html", html: look } },
        { tool: "project_read" },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "The title", ops: [{ op: "insert_item", track: "text", item: TITLE }] } },
      ]);
      assert.equal(placed.edits.length, 1, placed.error);
      s.results();
      const asked = [0, { graphic: "look.html", t: 0.5 }, 30, 10, 20, 40];
      const many = BEATS.concat(BEATS, BEATS).map((b, i) => ({ ...b, still: asked[i] }));
      const t = await s.ask("storyboard", [{ tool: "storyboard_propose", args: { summary: "Six beats with stills", beats: many } }]);
      assert.equal(t.status, "done", t.error);
      const card = t.items.find((i: any) => i.kind === "card").card;
      const stills = card.storyboard.beats.map((b: { still?: string }) => b.still);
      assert.equal(stills.filter(Boolean).length, 4, "the first 4 drawn");
      assert.deepEqual(stills.slice(4), [undefined, undefined]);
      for (const name of stills.filter(Boolean)) {
        assert.match(name, new RegExp(`^${t.id}-s1-\\d\\.jpg$`));
        const jpeg = readFileSync(join(s.dir, ".cache", "agent-images", name));
        assert.equal(jpeg.subarray(0, 2).toString("hex"), "ffd8", "a JPEG");
      }
      const [answer] = s.results();
      assert.match(jsonOf(answer!.result).stills, /beats 5, 6 asked for one too and were left out/);
      const file = JSON.parse(readFileSync(join(s.dir, "storyboard.json"), "utf8"));
      assert.deepEqual(
        file.beats.map((b: { still?: string }) => b.still),
        stills,
        "saved with the stills",
      );
      // A still that's neither a frame nor a graphic is refused, saying both forms.
      await s.ask("bad", [{ tool: "storyboard_propose", args: { summary: "Bad", beats: [{ ...BEATS[0], still: { graphic: "../x.html" } }] } }]);
      assert.match(textOf(s.results()[0]!.result), /timeline frame .* or a graphic and a moment of it/);
    } finally {
      await s.stop();
    }
  },
);

test("no storyboard lock: right after storyboard_propose, graphic_write and timeline_edit go through in the same turn", { skip, timeout: 120000 }, async () => {
  const s = await setup("no-lock");
  try {
    const html = "<!doctype html><body style=margin:0;background:#123><script>window.render=()=>{}</script>";
    await s.ask("brief", [
      {
        tool: "brief_write",
        args: { film: "A teaser", audience: "devs", duration: "10 s", formats: ["16:9"], assets: [], visual: "", hardLines: [], deliverables: [] },
      },
    ]);
    s.results();
    const scene = [1, 2, 3].map((n) => ({ op: "insert_item", track: "text", item: { ...TITLE, id: `scene-${n}`, start: n * 60 } }));
    const t = await s.ask("storyboard and build", [
      { tool: "storyboard_propose", args: { summary: "Two beats", beats: BEATS } },
      { tool: "graphic_write", args: { name: "after.html", html } },
      { tool: "project_read" },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Scenes 1 to 3", ops: scene } },
    ]);
    assert.equal(t.status, "done", t.error);
    const [propose, gw, , te] = s.results();
    assert.equal(jsonOf(propose!.result).recorded, true);
    assert.notEqual(gw!.result.isError, true, textOf(gw!.result));
    assert.notEqual(te!.result.isError, true, textOf(te!.result));
    assert.equal(t.edits.length, 1, "three scenes in one edit, nothing held");
  } finally {
    await s.stop();
  }
});

test("U15: the user's own brief edit on the Plan card is theirs and the next message says so", { skip, timeout: 120000 }, async () => {
  const s = await setup("gate");
  try {
    await s.ask("brief", [
      {
        tool: "brief_write",
        args: { film: "A teaser", audience: "devs", duration: "10 s", formats: ["16:9"], assets: [], visual: "", hardLines: [], deliverables: [] },
      },
    ]);
    s.results();
    const saved = s.latest().plan;
    const brief = await s.client.ok("agent.planSave", { brief: { ...saved.brief, audience: "React Native teams" } });
    assert.equal(brief.brief.by, "user");
    await s.ask("go on", [{ text: "ok" }]);
    assert.match(s.prompts().at(-1)!.prompt, /Brief \(edited by the user\):[\s\S]*audience: React Native teams/);
  } finally {
    await s.stop();
  }
});

test(
  "U7/U17: kits and skills reach every message; brand_read and its files; brand_write's style guide and new kit; the brand colours check; reference_frames",
  { skip, timeout: 180000 },
  async () => {
    const s = await setup("brand");
    try {
      // A global kit with a logo, a project skill; the project picks both.
      const logo = join(s.base, "argent-logo.png");
      writeFileSync(logo, Buffer.from(PNG, "base64"));
      const kit = {
        id: "argent",
        name: "Argent",
        scope: "global",
        logos: {},
        colors: [
          { hex: "#0B1D3A", role: "background" },
          { hex: "#f5a623", role: "accent" },
          { hex: "#ffffff", role: "text" },
        ],
        fonts: [{ family: "Inter", role: "headline", weight: 700 }],
        tone: "Plain, dev to dev",
        taglines: ["QA for your app, in the cloud"],
        urls: ["argent.dev"],
        dos: ["Show the real dashboard"],
        donts: ["No stock footage"],
        examples: [],
      };
      await s.client.ok("brand.saveKit", { kit });
      const added = await s.client.ok("brand.addFile", { kit: "argent", scope: "global", path: logo });
      assert.equal(added.name, "argent-logo.png");
      assert.ok(existsSync(join(s.data, "brand", "kits", "argent", "argent-logo.png")), "kept in the user's data folder");
      await s.client.ok("brand.saveKit", { kit: { ...kit, logos: { light: added.name } } });
      await s.client.ok("brand.saveSkill", {
        skill: {
          id: "promo-20s",
          name: "Launch promo 20 s",
          scope: "project",
          description: "Hook, demo, end card",
          body: "- Hook in 2 s\n- End card with the URL",
        },
      });
      const state = await s.client.ok("brand.setActive", { kit: "argent", skills: ["promo-20s"] });
      assert.equal(state.active.kit, "argent");
      assert.ok(existsSync(join(s.dir, "brand", "skills", "promo-20s.json")) && existsSync(join(s.dir, "brand", "active.json")));
      // The message has the kit and the skill; brand_read gives them, and the logo as an image.
      const t = await s.ask("make the promo", [{ tool: "brand_read" }, { tool: "brand_read", args: { file: "argent-logo.png" } }, { text: "ok" }]);
      assert.equal(t.status, "done", t.error);
      const prompt = s.prompts().at(-1)!.prompt;
      assert.match(
        prompt,
        /<brand>\nKit "Argent" \(argent, the user's\)\nColours: #0b1d3a background; #f5a623 accent; #ffffff text\nFonts: Inter for headline 700\nLogo on light backgrounds: argent-logo\.png \(/,
      );
      // D232: the skills the project uses by name (skill_read gives their instructions).
      assert.match(prompt, /Skills this project uses: Launch promo 20 s \(promo-20s\)\./);
      const [read, file] = s.results();
      const kitOut = jsonOf(read!.result);
      assert.equal(kitOut.logos.light.name, "argent-logo.png");
      assert.ok(kitOut.logos.light.path.endsWith("argent-logo.png"));
      assert.deepEqual([kitOut.skills[0].name, kitOut.skills[0].title], ["promo-20s", "Launch promo 20 s"]);
      assert.equal(file!.result.content[1]!.type, "image");
      // The brand colours check: a red title is off-brand, the fix moves it to the kit's nearest.
      const c = await s.ask("check", [
        { tool: "project_read" },
        { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Title", ops: [{ op: "insert_item", track: "text", item: TITLE }] } },
        { tool: "project_check" },
      ]);
      assert.equal(c.edits.length, 1);
      const checks = jsonOf(s.results()[2]!.result);
      const brandCheck =
        (checks.checks ?? checks.warnings ?? checks).find?.((x: any) => x.id === "brand-colours") ?? JSON.stringify(checks).includes("brand-colours");
      assert.ok(brandCheck, JSON.stringify(checks).slice(0, 600));
      assert.match(JSON.stringify(checks), /#ff0000, not a colour of the kit \\"Argent\\"/);
      // A style from a reference: reference_frames on a clip outside the project, brand_write the style.
      const ref = join(s.base, "reference.mp4");
      execFileSync(FFMPEG!, [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x180:rate=30",
        "-t",
        "3",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        ref,
      ]);
      const style = {
        palette: [
          { hex: "#101010", role: "background" },
          { hex: "#E8FF59", role: "accent" },
        ],
        type: "Grotesk, tight, all caps headlines",
        shotLengths: "0.8 to 1.5 s",
        transitions: "Hard cuts, a whip on the drop",
        camera: "Locked off, slow push",
        grain: "Light film grain",
      };
      const st = await s.ask(`Make a style guide for the kit "Argent" (argent) from this reference: ${ref}`, [
        { tool: "reference_frames", args: { path: ref, count: 6 } },
        { tool: "brand_write", args: { kit: "argent", style: { ...style, source: "reference.mp4" } } },
        { tool: "brand_write", args: { name: "Side project", colors: [{ hex: "#123456", role: "background" }] } },
      ]);
      assert.equal(st.status, "done", st.error);
      const [sheet, wroteStyle, newKit] = s.results();
      assert.match(textOf(sheet!.result), /The reference reference\.mp4: 3\.0 s, 320×180, 6 frames/);
      assert.equal(sheet!.result.content[1]!.type, "image");
      assert.ok(
        !existsSync(join(s.dir, "media")) || !readFileSync(join(s.dir, "project.json"), "utf8").includes("reference.mp4"),
        "the reference isn't imported",
      );
      assert.match(jsonOf(wroteStyle!.result).kit, /Style guide \(from reference\.mp4\):; palette: #101010 background; #e8ff59 accent/);
      const onDisk = JSON.parse(readFileSync(join(s.data, "brand", "kits", "argent", "kit.json"), "utf8"));
      assert.equal(onDisk.style.shotLengths, "0.8 to 1.5 s");
      assert.equal(onDisk.colors.length, 3, "the rest of the kit is kept");
      assert.equal(jsonOf(newKit!.result).saved, "side-project");
      // D199: a new kit from the agent goes in the user's library.
      assert.ok(existsSync(join(s.data, "brand", "kits", "side-project", "kit.json")), "a new kit from the agent is in the library");
      assert.ok(!existsSync(join(s.dir, "brand", "kits", "side-project")));
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
  },
);

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
      {
        tool: "timeline_edit",
        args: {
          baseRevision: "$rev",
          summary: "Music",
          ops: [{ op: "insert_item", track: "audio", item: { id: "music-1", type: "audio", media: "m-song", in: 0, start: 30, duration: 300 } }],
        },
      },
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
