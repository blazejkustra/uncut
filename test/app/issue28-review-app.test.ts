// Issues #28 and #36 (D195–D197) on the packaged app, run invisibly and muted, with the stand-in
// claude and its scripted critic:
// - the brief, storyboard and review appear as cards in the conversation where they happened, in
//   order; no tabs over the thread;
// - the agent asks for a review with its own perfect scores; Uncut's critic finds an empty phone and
//   Uncut's layout check an off-centre title: the review card shows the blockers and "2 blockers";
// - the pinned Plan chip lists the latest brief, storyboard and review and jumps to their cards;
// - the next turn fixes them; the critic confirms the fixes on fresh frames and passes it.
// Screenshots: test-output/issue28-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const out = (name: string) => resolve("test-output", `issue28-${name}.png`);
const plan = () => join(root, "plan.json");
const critic = () => join(root, "critic.json");
const turns: Array<unknown> = [];
const nextTurn = (steps: Array<unknown>) => {
  turns.push(steps);
  writeFileSync(plan(), JSON.stringify(turns));
};
const ev = (score: number, what: string) => ({ score, evidence: `f 0, f 45: ${what}` });
const scores = (n: number) => ({ hook: ev(n, "the claim lands on frame 0"), readability: ev(n, "the claim reads at 360 px"), motion: ev(n, "the rise settles"), variety: ev(n, "two looks in 3 s"), sound: ev(n, "hit on the downbeat"), brand: ev(n, "navy and amber from the kit") });

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue28-")));
  mkdirSync(join(root, "projects"));
  writeFileSync(plan(), "[]");
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(join(root, "critic.jsonl"), "");
  writeFileSync(
    critic(),
    JSON.stringify([
      { scores: scores(9), blockers: [{ kind: "placeholder", what: "The phone screen is empty where the dashboard recording was planned", at: 0.8 }], defects: [{ at: 1.5, what: "The claim fades in linearly", fix: "spring.land on the rise" }], summary: "A stranger sees an empty phone; the claim is fine." },
      { scores: scores(9), blockers: [], defects: [], fixes: [{ defect: "d1", verified: true, note: "the dashboard plays in the phone at f 24" }, { defect: "d2", verified: true, note: "the title is centred" }], summary: "Both fixes hold." },
    ]),
  );
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const text = (page: Page, selector: string) => page.$eval(selector, (el) => (el as HTMLElement).innerText.trim());
const BEATS = [
  { start: 0, end: 1, title: "Hook", entry: "The claim types in", exit: "The claim held", purpose: "Say what it does", assets: [], sound: "the first downbeat" },
  { start: 1, end: 2, title: "The dashboard", entry: "The phone slides up", exit: "A run goes green", purpose: "Show the real product", assets: ["dashboard recording"] },
];
const graphic = `<canvas id="c"></canvas><script>const c=document.getElementById("c");window.render=(t,info)=>{c.width=info.width;c.height=info.height;const x=c.getContext("2d");x.fillStyle="#0b1d3a";x.fillRect(0,0,c.width,c.height);x.strokeStyle="#ffffff";x.lineWidth=6;x.strokeRect(c.width*0.4,c.height*0.2,c.width*0.2,c.height*0.6);};</script>`;

test("issue #28/#36: inline brief, storyboard and review cards; the critic's blockers; the Plan chip jumps; fixes verified", { skip, timeout: 300000 }, async () => {
  const app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]), UNCUT_CLAUDE: FAKE, FAKE_PLAN: plan(), FAKE_PROMPT_LOG: join(root, "prompts.jsonl"), FAKE_CRITIC: critic(), FAKE_CRITIC_LOG: join(root, "critic.jsonl"), UNCUT_APPROVAL_MS: "120000" },
  });
  apps.add(app);
  const { page } = app;
  const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
  const send = async (prompt: string) => {
    await page.click("[data-testid=agent-input]");
    await page.keyboard.down("Meta");
    await page.keyboard.press("a");
    await page.keyboard.up("Meta");
    await page.keyboard.type(prompt);
    await page.keyboard.press("Enter");
  };
  const lastDone = () => page.waitForFunction(() => [...document.querySelectorAll("[data-testid=agent-turn]")].at(-1)?.getAttribute("data-status") === "done", { timeout: 90000 });
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=new-project]");
    await waitFor("[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor("[data-testid=agent-input]");

    // ---- Turn 1: brief, storyboard (approved on its card), build, the agent's own 10s, the critic's blockers ----
    const brief = { film: "Argent Cloud runs your app's QA on real devices in the cloud", audience: "React Native developers", duration: "2 s", formats: ["16:9"], assets: ["dashboard recording"], visual: "Dark navy, amber accent", hardLines: ["Never invent product UI"], deliverables: ["promo.mp4"] };
    const title = { id: "claim", type: "text", start: 0, duration: 60, text: "QA in the cloud", transform: { x: 500, y: 120, w: 1000 }, style: { preset: "text.title", size: 90, weight: 700, color: "#ffffff", align: "center" } };
    nextTurn([
      { tool: "brief_write", args: brief },
      { tool: "storyboard_propose", args: { summary: "The claim, then the real dashboard", beats: BEATS } },
      { tool: "graphic_write", args: { name: "phone.html", html: graphic } },
      { tool: "project_read" },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Scene 1: the claim and the phone", ops: [{ op: "add_track", track: { id: "v2", kind: "video", name: "Graphics", items: [] }, index: 1 }, { op: "insert_item", track: "v2", item: { id: "phone", type: "graphic", src: "graphics/phone.html", start: 0, duration: 60 } }, { op: "insert_item", track: "text", item: title }] } },
      { tool: "contact_sheet", args: { max: 4 } },
      { tool: "render_frames", args: { frames: [0, 30], phone: true } },
      { tool: "review_submit", args: { scores: { hook: 10, readability: 10, motion: 10, variety: 10, sound: 10, brand: 10 } } },
      { text: "The critic found an empty phone and an off-centre title; fixing both next." },
    ]);
    await send("make a 2 s promo for Argent Cloud");
    await waitFor("[data-testid=agent-storyboard]");
    await page.click("[data-testid=agent-storyboard-approve]");
    await lastDone();
    await waitFor("[data-testid=agent-card][data-type=review]");
    // The cards are in the conversation, in the order they happened; no tabs over the thread.
    const order = await page.$$eval("[data-testid=agent-thread] [data-testid=agent-card]", (els) => els.map((e) => e.getAttribute("data-type")));
    assert.deepEqual(order, ["brief", "storyboard", "review"]);
    assert.equal(await page.$(".plan-bar, .plan-tabs"), null, "no Plan bar tabs");
    const review = "[data-testid=agent-card][data-type=review]";
    assert.equal(await page.$eval(review, (el) => el.getAttribute("data-passed")), "false");
    assert.match(await text(page, `${review} .card-outcome`), /2 blockers/);
    assert.deepEqual(await page.$$eval(`${review} [data-testid=agent-review-blocker]`, (els) => els.map((e) => [e.getAttribute("data-kind"), e.getAttribute("data-source")])), [["placeholder", "critic"], ["off-centre", "check"]]);
    assert.equal(await text(page, `${review} [data-testid=agent-review-by]`), "Independent critic");
    assert.equal(await page.$eval(`${review} [data-testid=agent-review-score][data-score=brand]`, (el) => el.getAttribute("data-value")), "5", "the placeholder caps brand");
    // The cards in view for the screenshot: the brief and storyboard opened.
    await page.click("[data-testid=agent-card][data-type=storyboard] .card-head");
    await page.$eval("[data-testid=agent-card][data-type=brief]", (el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: out("cards") });
    await page.$eval(review, (el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: out("review-blocked") });
    // The Plan chip has its own strip above the thread: it never covers a card or a row.
    const [strip, threadTop] = await page.evaluate(() => [document.querySelector("[data-testid=agent-plan]")!.getBoundingClientRect().bottom, document.querySelector("[data-testid=agent-thread]")!.getBoundingClientRect().top]);
    assert.ok(strip! <= threadTop! + 0.5, `the chip's strip (bottom ${strip}) ends where the thread (top ${threadTop}) starts`);

    // ---- The Plan chip: the latest of each, and a jump to its card ----
    await page.$eval("[data-testid=agent-thread]", (el) => (el.scrollTop = el.scrollHeight));
    await page.click("[data-testid=plan-chip]");
    await waitFor("[data-testid=plan-menu]");
    assert.match(await text(page, "[data-testid=plan-chip]"), /Plan\s*2 blockers/);
    assert.match(await text(page, "[data-testid=plan-storyboard]"), /Approved/);
    assert.match(await text(page, "[data-testid=plan-review]"), /Review, round 1\s*2 blockers/);
    await page.screenshot({ path: out("chip") });
    await page.click("[data-testid=plan-brief]");
    await page.waitForFunction(() => {
      const card = document.querySelector("[data-testid=agent-card][data-type=brief]")!;
      const thread = document.querySelector("[data-testid=agent-thread]")!.getBoundingClientRect();
      const r = card.getBoundingClientRect();
      return card.hasAttribute("data-flash") && r.top >= thread.top - 2 && r.top < thread.top + 80 && !!card.querySelector("[data-testid=agent-brief-rows]");
    }, { timeout: 5000 });
    assert.equal(await page.$("[data-testid=plan-menu]"), null, "the menu closes on a jump");
    await page.screenshot({ path: out("jump") });

    // ---- Turn 2: fix both, look at the fixed moments, claim the fixes; the critic checks them on fresh frames ----
    nextTurn([
      { tool: "project_read" },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Centre the claim, the dashboard in the phone", ops: [{ op: "update_item", item: "claim", set: { transform: { x: 460, y: 120, w: 1000 } } }] } },
      { tool: "contact_sheet", args: { max: 4 } },
      { tool: "render_frames", args: { frames: [0, 24], phone: true } },
      { tool: "review_submit", args: { fixes: [{ defect: "d1", what: "the dashboard recording plays in the phone" }, { defect: "d2", what: "centred the claim's box" }] } },
      { text: "Both fixes check out; the critic passed it." },
    ]);
    await send("fix them");
    await lastDone();
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=agent-card][data-type=review]").length === 2, { timeout: 90000 });
    const passed = "[data-testid=agent-card][data-type=review][data-passed=true]";
    // The second card comes with the turn, its verdict with the critic's result (#89: a beat later on a slow runner).
    await page.waitForSelector(passed, { timeout: 30000 }).catch(() => {});
    assert.equal(await page.$$eval("[data-testid=agent-card][data-type=review]", (els) => els.map((e) => e.getAttribute("data-passed")).join()), "false,true");
    assert.deepEqual(await page.$$eval(`${passed} [data-testid=agent-review-fix]`, (els) => els.map((e) => e.getAttribute("data-verified"))), ["true", "true"]);
    await page.$eval(passed, (el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: out("review-passed") });
    // The second critic run saw the claims and the fresh frames, and of the conversation only the
    // user's words (8a6ccbd): the film's brief, then this turn's message, once each, inside <request>.
    // Never the agent's replies or anything else of the builder's conversation.
    const runs = readFileSync(join(root, "critic.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(runs.length, 2);
    assert.match(runs[1].text, /<claimed-fixes>[\s\S]*d2 \(at 0 s\)[\s\S]*centred the claim's box/);
    const request = runs[1].text.match(/<request>\n([\s\S]*?)\n<\/request>/)?.[1];
    assert.equal(request, "make a 2 s promo for Argent Cloud\n\nThen, this turn: fix them", "the user's words, in <request>");
    const outside = runs[1].text.replace(/<request>[\s\S]*?<\/request>/, "");
    assert.ok(!outside.includes("make a 2 s promo") && !outside.includes("fix them"), "the user's words only inside <request>");
    assert.ok(!runs[1].text.includes("fixing both next") && !runs[1].text.includes("Both fixes check out"), "no agent reply reaches the critic");
  } catch (error) {
    await page.screenshot({ path: out("failure") }).catch(() => {});
    throw error;
  }
});
