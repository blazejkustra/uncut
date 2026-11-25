// D195/D196 on the bundled server with fake-claude's session: the critic's review needs a look
// first, saves its rounds and checks graphics draw the same twice; an @time fix turn's round cap;
// several videos reviewed by marker; a critic that fails; the reminder when a built turn skips
// review_submit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BEATS, TITLE, jsonOf, productionServers, skip, textOf } from "../helpers/production-server.ts";

const setup = productionServers("uncut-agent-production-review-");

const ev = (score: number, k: string) => ({ score, evidence: `f 0, f 45: ${k}` });
const scoresOf = (score: number) => Object.fromEntries(["hook", "readability", "motion", "variety", "sound", "brand"].map((k) => [k, ev(score, k)]));

test(
  "D195/D196: Uncut's critic scores the review, blockers fail it, fixes are checked on fresh frames, and the critic never sees the builder",
  { skip, timeout: 240000 },
  async () => {
    const s = await setup("review");
    try {
      const html = `<canvas id="c"></canvas><script>const c=document.getElementById("c");window.render=(t,info)=>{c.width=info.width;c.height=info.height;const x=c.getContext("2d");x.fillStyle="#0b1d3a";x.fillRect(0,0,c.width,c.height);x.fillStyle="#f5a623";x.fillRect(40+t*200,40,120,120);};</script>`;
      // A centred title whose box is 40 px right of the frame's centre: Uncut's layout check.
      const title = {
        id: "title-1",
        type: "text",
        start: 0,
        duration: 60,
        text: "Argent Cloud",
        transform: { x: 500, y: 400, w: 1000 },
        style: { preset: "text.title", size: 90, weight: 700, align: "center" },
      };
      // The critic: round 1 an empty phone screen (the builder's own 10s are ignored), round 2 d2
      // fixed but d1 not, round 3 everything fixed.
      s.critic([
        {
          scores: scoresOf(9),
          blockers: [{ kind: "placeholder", what: "The phone screen is empty where the demo was planned", at: 0.5 }],
          defects: [{ at: 1, what: "The claim fades in linearly", fix: "spring.land" }],
          fixes: [],
          summary: "Empty phone.",
        },
        {
          scores: scoresOf(9),
          blockers: [],
          defects: [],
          fixes: [
            { defect: "d2", verified: true, note: "centred now" },
            { defect: "d1", verified: false, note: "the phone is still empty" },
          ],
          summary: "One fix holds.",
        },
        `Here it is:\n\`\`\`json\n${JSON.stringify({ scores: scoresOf(9), blockers: [], defects: [], fixes: [{ defect: "d1", verified: true, note: "the recording plays in the phone" }], summary: "Ready." })}\n\`\`\``,
      ]);
      const tenOutOfTen = { hook: 10, readability: 10, motion: 10, variety: 10, sound: 10, brand: 10 };
      const t = await s.ask(
        "BUILDER-SECRET-7 make the promo and review it",
        [
          {
            tool: "brief_write",
            args: {
              film: "Argent Cloud runs your app's QA in the cloud",
              audience: "RN teams",
              duration: "15 s",
              formats: ["4:5"],
              assets: ["demo recording"],
              visual: "Dark, amber accents",
              hardLines: ["Never invent UI"],
              deliverables: ["4:5 mp4"],
            },
          },
          { tool: "storyboard_propose", args: { summary: "Hook then demo", beats: BEATS } },
          { tool: "graphic_write", args: { name: "box.html", html } },
          { tool: "project_read" },
          {
            tool: "timeline_edit",
            args: {
              baseRevision: "$rev",
              summary: "Scene 1",
              ops: [
                { op: "add_track", track: { id: "v2", kind: "video", name: "Graphics", items: [] }, index: 0 },
                { op: "insert_item", track: "v2", item: { id: "g-1", type: "graphic", src: "graphics/box.html", start: 0, duration: 30 } },
                { op: "insert_item", track: "text", item: title },
              ],
            },
          },
          { tool: "contact_sheet", args: { max: 4 } },
          { tool: "render_frames", args: { frames: [0, 15], phone: true } },
          // 5: round 1, with the builder's own perfect scores.
          { tool: "review_submit", args: { scores: tenOutOfTen, defects: [] } },
          { tool: "contact_sheet", args: { max: 4 } },
          { tool: "render_frames", args: { frames: [0], phone: true } },
          // 8: nothing changed since round 1.
          { tool: "review_submit", args: {} },
          { tool: "project_read" },
          {
            tool: "timeline_edit",
            args: {
              baseRevision: "$rev",
              summary: "Centre the title",
              ops: [{ op: "update_item", item: "title-1", set: { transform: { x: 460, y: 400, w: 1000 } } }],
            },
          },
          // 11: an id that isn't in the last review.
          { tool: "review_submit", args: { fixes: [{ defect: "d9", what: "something" }] } },
          // 12: an off-centre fix with no position measured, then the measure that clears it.
          { tool: "review_submit", args: { fixes: [{ defect: "d2", what: "centred the title" }] } },
          { tool: "measure", args: { what: "position", frames: [20] } },
          { tool: "render_frames", args: { frames: [0, 20], phone: true } },
          // 15: round 2 (Uncut renders each claimed fix's moment itself).
          {
            tool: "review_submit",
            args: {
              fixes: [
                { defect: "d2", what: "centred the title" },
                { defect: "d1", what: "put the recording in the phone" },
              ],
            },
          },
          { tool: "project_read" },
          {
            tool: "timeline_edit",
            args: { baseRevision: "$rev", summary: "The demo in the phone", ops: [{ op: "update_item", item: "g-1", set: { duration: 45 } }] },
          },
          { tool: "contact_sheet", args: { max: 4 } },
          { tool: "render_frames", args: { frames: [0, 15], phone: true } },
          // 20: no round 3: d1 came back after its fix, so the user decides it.
          { tool: "review_submit", args: { fixes: [{ defect: "d1", what: "the recording plays in the phone" }] } },
        ],
        { access: "auto" },
      );
      assert.equal(t.status, "done", t.error);
      const r = s.results().slice(2);
      const round1 = jsonOf(r[5]!.result);
      assert.equal(round1.round, 1);
      assert.equal(round1.passed, false, "the builder's own 10s don't pass it");
      assert.match(round1.yourScores, /ignored/);
      assert.deepEqual(
        round1.blockers.map((b: any) => [b.id, b.kind, b.source]),
        [
          ["d1", "placeholder", "critic"],
          ["d2", "off-centre", "check"],
        ],
      );
      assert.match(round1.blockers[1].what, /40 px right of the frame's centre/);
      assert.equal(round1.scores.brand, 5, "a placeholder blocker caps brand");
      assert.equal(round1.scores.readability, 5, "an off-centre blocker caps readability");
      assert.equal(round1.scores.hook, 9);
      assert.equal(round1.defects[0].id, "d3");
      assert.match(round1.next, /Blockers \(any one fails the round\): d1 placeholder/);
      assert.ok(!("by" in round1) && !("facts" in round1.motion) && !("found" in round1.motion), "what the critic was told stays out of the answer");
      assert.equal(round1.determinism, "1 graphic drew the same twice");
      assert.match(textOf(r[8]!.result), /Nothing changed since round 1/);
      assert.match(textOf(r[11]!.result), /There's no d9 in the last review \(its ids: d1, d2, d3\)/);
      assert.match(textOf(r[12]!.result), /d2 is off-centre: measure with what "position"/);
      assert.ok(jsonOf(r[13]!.result).frames[0].box.width > 100, "the graphic's box on a real render");
      const round2 = jsonOf(r[15]!.result);
      assert.ok(
        round2.fixes.every((f: any) => !("what" in f)),
        "the agent's own claims aren't echoed",
      );
      assert.equal(round2.passed, false, "a fix the critic didn't see fails the round");
      assert.deepEqual(
        round2.fixes.map((f: any) => [f.defect, f.verified]),
        [
          ["d2", true],
          ["d1", false],
        ],
      );
      assert.deepEqual(
        round2.blockers.map((b: any) => [b.id, b.kind, b.unresolved]),
        [["d1", "unverified-fix", true]],
      );
      assert.match(round2.blockers[0].what, /the phone is still empty/);
      assert.match(
        round2.next,
        /the last one \(round 2 of at most 3: every blocker left came back unchanged after a fix \(d1\), so the user decides them[\s\S]*Unresolved[\s\S]*ask_user/,
      );
      assert.match(textOf(r[20]!.result), /No more review rounds in this turn \(round 2 of at most 3: every blocker left came back unchanged/);
      // Saved by the critic.
      const saved = JSON.parse(readFileSync(join(s.dir, "reviews", "review-1.json"), "utf8"));
      assert.equal(saved.by, "critic");
      assert.equal(saved.blockers.length, 2);
      assert.match(saved.evidence.hook, /f 0, f 45/);
      assert.deepEqual(saved.determinism, { checked: ["box.html"], differed: [] });
      // The critic: a separate claude with no tools, no MCP server, no session, none of the builder's conversation.
      const runs = s.criticRuns();
      assert.equal(runs.length, 2);
      const builder = s.prompts().at(-1)!;
      for (const run of runs) {
        assert.equal(run.resume, null);
        assert.equal(run.args[run.args.indexOf("--tools") + 1], "");
        assert.ok(!run.args.includes("--mcp-config") && !run.args.includes("--resume"), run.args.join(" "));
        assert.ok(run.args.includes("--no-session-persistence"));
        assert.ok(!run.env.includes("OPENAI_API_KEY"), "D277: no generator key for the critic");
        assert.notEqual(run.cwd, s.dir);
        // A2 vs A2r5: the user's own words reach the critic, verbatim and only in <request> (judged first); nothing the builder adds does.
        assert.ok(run.text.includes("<request>\nBUILDER-SECRET-7 make the promo and review it\n</request>"), "the user's request");
        assert.equal(run.text.split("BUILDER-SECRET-7").length, 2, "the user's words once, inside <request>");
        assert.ok(!run.text.includes("editing agent inside Uncut"), "no builder system prompt");
        assert.ok(!run.text.includes(builder.prompt.slice(0, 60)));
        assert.ok(!/centred the title/.test(run.text) || /<claimed-fixes>/.test(run.text), "the builder's words only as fix claims");
        assert.match(run.text, /<brief>\nfilm: Argent Cloud runs your app's QA in the cloud/);
        assert.match(run.text, /<rubric>/);
        assert.match(run.text, /<storyboard approved>/);
      }
      assert.match(runs[0]!.text, /<layout-checks>\nfails at f 0: "Argent Cloud" is centred in a box 40 px right/);
      assert.ok(runs[0]!.images >= 3, `a contact sheet and phone frames (${runs[0]!.images})`);
      assert.match(runs[1]!.text, /<last-round 1>\nd1 \(blocker, placeholder\) at 0.5 s: The phone screen is empty/);
      assert.match(runs[1]!.text, /<claimed-fixes>[\s\S]*d2 \(at 0 s\)[\s\S]*the editor: centred the title/);
      assert.match(runs[1]!.text, /Image \d+: frame 0 \(0.00 s\), the moment of claimed fix d2, rendered after the fix/);
      assert.ok(!/layout-checks/.test(runs[1]!.text), "the title is centred now");
      assert.equal(runs[1]!.images, runs[0]!.images + 2, "plus a fresh frame per claimed fix");
      // Cards inline in the conversation, in the order they happened.
      const kinds = t.items.flatMap((i: any, at: number) => (i.kind === "card" ? [[i.card.type, at]] : []));
      assert.deepEqual(
        kinds.map((k: any) => k[0]),
        ["brief", "storyboard", "review", "review"],
      );
      const stepAt = (n: number) => t.items.findIndex((i: any) => i.kind === "step" && i.tool === "review_submit" && --n === 0);
      assert.ok(kinds[2][1] > stepAt(1) && kinds[3][1] > stepAt(4), "each critic row right after its call");
      assert.ok(kinds[0][1] < kinds[1][1] && kinds[1][1] < kinds[2][1]);
      const rows = t.items.filter((i: any) => i.kind === "card" && i.card.type === "review").map((i: any) => i.card.critic);
      assert.deepEqual(
        rows.map((c: any) => [c.round, c.status]),
        [
          [1, "failed"],
          [2, "unresolved"],
        ],
      );
      assert.ok(rows.every((c: any) => Date.parse(c.endedAt) >= Date.parse(c.startedAt)));
      assert.deepEqual(
        s.latest().plan.reviews.map((x: any) => x.passed),
        [false, false],
      );
      // Kept with the history after a close and reopen.
      await s.client.ok("project.close", {});
      await s.agent.until((v) => v === null);
      await s.client.ok("project.open", { dir: s.dir });
      const reopened =
        (await s.agent.until((v) => v?.dir === s.dir && v.turns.some((x: any) => x.id === t.id))) ?? s.agent.values.findLast((v: any) => v?.dir === s.dir);
      const back = reopened.turns.find((x: any) => x.id === t.id);
      const kept = back.items.filter((i: any) => i.kind === "card" && i.card.type === "review");
      assert.equal(kept[0].card.review.blockers[0].kind, "placeholder");
      assert.equal(kept[1].card.review.fixes[1].verified, false);
      assert.equal(reopened.plan.reviews.length, 2);
    } finally {
      await s.stop();
    }
  },
);

test("an @time fix turn: one round, the cap says what is open and passes nothing; the critic's usage is saved", { skip, timeout: 180000 }, async () => {
  const s = await setup("round-cap");
  try {
    const nines = Object.fromEntries(["hook", "readability", "motion", "variety", "sound", "brand"].map((k) => [k, { score: 9, evidence: "f 0, f 30: fine" }]));
    s.critic([
      { scores: nines, blockers: [{ kind: "placeholder", what: "The phone screen is empty", at: 0.5, fix: "Put the recording in" }], summary: "One blocker." },
    ]);
    const title = { ...TITLE, duration: 30 };
    const edit = (text: string) => ({
      tool: "timeline_edit",
      args: { baseRevision: "$rev", summary: text, ops: [{ op: "update_item", item: "title-1", set: { text } }] },
    });
    await s.ask("Add the title", [
      { tool: "project_read" },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Title", ops: [{ op: "insert_item", track: "text", item: title }] } },
    ]);
    s.results();
    const t = await s.ask("@0:00.5 the phone is empty, fix it", [
      { tool: "contact_sheet", args: { max: 4 } },
      { tool: "render_frames", args: { frames: [0, 15], phone: true } },
      { tool: "review_submit", args: {} },
      { tool: "project_read" },
      edit("Changed"),
      { tool: "review_submit", args: {} },
    ]);
    const r = s.results();
    const round = jsonOf(r[2]!.result);
    assert.equal(round.passed, false);
    assert.deepEqual(round.roundLimit.openBlockers, ["d1 placeholder at 0.5 s: The phone screen is empty"]);
    assert.equal(round.roundLimit.passed, false);
    assert.match(round.next, /round 1 of at most 1: 1 round is the cap[^]*In your final reply[^]*round limit[^]*d1 placeholder at 0\.5 s/);
    assert.match(
      textOf(r[5]!.result),
      /No more review rounds in this turn \(round 1 of at most 1[^]*final reply[^]*d1 placeholder at 0\.5 s: The phone screen is empty/,
    );
    assert.equal(s.criticRuns().length, 1, "the second review_submit never reached the critic");
    const row = t.items.find((i: any) => i.kind === "card" && i.card.type === "review").card;
    assert.equal(row.critic.status, "failed");
    assert.match(row.critic.line, /^Round limit reached, not passed: 1 blocker still open\./);
    const saved = JSON.parse(readFileSync(join(s.dir, "reviews", "review-1.json"), "utf8"));
    assert.equal(saved.passed, false);
    assert.equal(saved.usage.costUsd, 0.25);
    assert.equal(saved.usage.cacheWriteTokens, 40000);
    assert.equal(saved.usage.outputTokens, 700);
  } finally {
    await s.stop();
  }
});

test("several videos: each marker's section is reviewed alone, with its own rounds, on the timeline's clock", { skip, timeout: 180000 }, async () => {
  const s = await setup("sections");
  try {
    const nines = Object.fromEntries(["hook", "readability", "motion", "variety", "sound", "brand"].map((k) => [k, { score: 9, evidence: "f 0, f 30: fine" }]));
    const blocked = (what: string) => ({
      scores: nines,
      blockers: [{ kind: "placeholder", what, at: 0.5, fix: "Put the recording in" }],
      summary: "One blocker.",
    });
    s.critic([blocked("Promo A's phone is empty"), blocked("Promo B's phone is empty")]);
    const promo = (id: string, start: number, text: string) => ({ op: "insert_item", track: "text", item: { ...TITLE, id, start, duration: 60, text } });
    await s.ask("Make two promos", [
      { tool: "project_read" },
      {
        tool: "timeline_edit",
        args: {
          baseRevision: "$rev",
          summary: "Two promos",
          ops: [
            promo("title-1", 0, "Promo A"),
            promo("title-2", 60, "Promo B"),
            {
              op: "update_project",
              set: {
                markers: [
                  { frame: 0, label: "Promo A" },
                  { frame: 60, label: "Promo B" },
                ],
              },
            },
          ],
        },
      },
    ]);
    s.results();
    const t = await s.ask("@0:00.5 the phones are empty, fix both", [
      { tool: "contact_sheet", args: { max: 4 } },
      { tool: "render_frames", args: { frames: [0, 15], phone: true } },
      { tool: "review_submit", args: { marker: "Promo A" } },
      { tool: "review_submit", args: { marker: "Promo A" } },
      { tool: "contact_sheet", args: { max: 4 } },
      { tool: "render_frames", args: { frames: [60, 75], phone: true } },
      { tool: "review_submit", args: { marker: "promo b" } },
      { tool: "review_submit", args: { marker: "Promo C" } },
    ]);
    assert.equal(t.status, "done");
    const r = s.results();
    const a = jsonOf(r[2]!.result);
    assert.deepEqual(a.range.from, 0);
    assert.deepEqual(
      a.blockers.map((b: any) => b.at),
      [0.5],
    );
    assert.match(textOf(r[3]!.result), /No more review rounds in this turn \(round 1 of at most 1[^]*Promo A's phone is empty/);
    const b = jsonOf(r[6]!.result);
    assert.deepEqual({ from: b.range.from, to: b.range.to, marker: b.range.marker }, { from: 60, to: 120, marker: "Promo B" });
    assert.deepEqual(
      b.blockers.map((x: any) => x.at),
      [2.5],
      "the critic's 0.5 s into Promo B is 2.5 s on the timeline",
    );
    assert.match(b.next, /f 75[^]*render_frames 69 to 81/);
    assert.match(textOf(r[7]!.result), /No marker is named "Promo C" \(the markers: "Promo A", "Promo B"\)/);
    const runs = s.criticRuns();
    assert.equal(runs.length, 2, "one critic run per video");
    for (const run of runs) assert.match(run.text, /, 2\.0 s \(60 frames\)\./, "the critic sees one 2 s video, not the 4 s timeline");
    const saved = JSON.parse(readFileSync(join(s.dir, "reviews", "review-2.json"), "utf8"));
    assert.deepEqual(saved.range, { from: 60, to: 120, marker: "Promo B" });
    assert.equal(saved.blockers[0].at, 2.5);
    assert.equal(saved.blockers[0].frame, 75);
  } finally {
    await s.stop();
  }
});

test("D195: a critic that fails or answers no JSON passes nothing and saves no round", { skip, timeout: 180000 }, async () => {
  const s = await setup("critic-fail");
  try {
    s.critic([
      { fail: "Overloaded" },
      "Looks great to me!",
      { scores: { hook: { score: 9 }, readability: 9, motion: 9, variety: 9, sound: 9, brand: 9 }, blockers: [], defects: [] },
    ]);
    const t = await s.ask("review", [
      { tool: "project_read" },
      {
        tool: "timeline_edit",
        args: {
          baseRevision: "$rev",
          summary: "Title",
          ops: [{ op: "insert_item", track: "text", item: { ...TITLE, style: { ...TITLE.style, color: "#ffffff" } } }],
        },
      },
      { tool: "contact_sheet", args: { max: 2 } },
      { tool: "render_frames", args: { frames: [0], phone: true } },
      { tool: "review_submit", args: {} },
      { tool: "review_submit", args: {} },
      { tool: "review_submit", args: {} },
    ]);
    assert.equal(t.status, "done", t.error);
    const r = s.results();
    assert.match(textOf(r[4]!.result), /critic couldn't review it: the critic stopped: Overloaded/);
    assert.match(textOf(r[5]!.result), /critic couldn't review it: no JSON object/);
    const round = jsonOf(r[6]!.result);
    assert.equal(round.passed, false, "scores without frames cited can't pass");
    assert.equal(round.scores.hook, 7);
    assert.equal(round.round, 1, "failed critic runs aren't rounds");
  } finally {
    await s.stop();
  }
});

test("round 2's A2: nobody can answer; a built turn without review_submit is reminded once and goes on", { skip, timeout: 120000 }, async () => {
  const s = await setup("unattended");
  try {
    const built = [
      { tool: "storyboard_propose", args: { summary: "Two beats", beats: BEATS } },
      { tool: "project_read" },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Scene 1", ops: [{ op: "insert_item", track: "text", item: TITLE }] } },
      { tool: "project_read" },
      {
        tool: "timeline_edit",
        args: { baseRevision: "$rev", summary: "Scene 2", ops: [{ op: "insert_item", track: "text", item: { ...TITLE, id: "title-2", start: 60 } }] },
      },
    ];
    const id = await s.start("Make a launch film. I can't answer questions, decide yourself.", built, { access: "auto" });
    // The reminder is a message of its own to the same claude: the fake plays the next turn for it.
    writeFileSync(join(s.base, "plan.json"), JSON.stringify([built, [{ text: "Running the critic loop now." }]]));
    const t = await s.done(id);
    assert.equal(t.status, "done", t.error);
    assert.equal(jsonOf(s.results()[0]!.result).recorded, true);
    const prompts = s.prompts();
    assert.equal(prompts.length, 2, "the message, then the reminder");
    assert.match(prompts[1]!.prompt, /Uncut's critic hasn't reviewed it; no review_submit ran[\s\S]*a run where nobody can answer still goes through it/);
    assert.match(
      t.items
        .filter((i: any) => i.kind === "text")
        .map((i: any) => i.text)
        .join(" "),
      /Running the critic loop now/,
    );
  } finally {
    await s.stop();
  }
});
