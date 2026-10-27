// Round 3 J2 (planning/FEEDBACK.md U7–U9, U15–U17, U19; D186–D191) on the packaged app, run
// invisibly and muted, with the stand-in claude:
// - U7: the Brand tab: a new kit (name, colours) and the project's kit; D232: the Skills tab's copy
//   of Launch promo, called with /launch-promo-copy; the next message carries them.
// - U8: the agent's question card: pick an option, write a line, Send; the turn keeps the answer.
// - U15/U9: the brief card; the storyboard card in the thread (its beats and still, nobody approves
//   it); the build goes through; the Plan chip (D197) shows the storyboard and opens the brief card.
// - U16: the review card with its scores and defects.
// Screenshots: test-output/round3-j2-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const out = (name: string) => resolve("test-output", `round3-j2-${name}.png`);
const plan = () => join(root, "plan.json");
// D195: the critic's answer (the review is Uncut's critic's, not the agent's).
const critic = () => join(root, "critic.json");
const ev = (score: number) => ({ score, evidence: "f 0, f 30" });
const turns: Array<unknown> = [];
const nextTurn = (steps: Array<unknown>) => {
  turns.push(steps);
  writeFileSync(plan(), JSON.stringify(turns));
};
const runs = () =>
  readFileSync(join(root, "prompts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => !r.refused);

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-round3-j2-")));
  mkdirSync(join(root, "projects"));
  writeFileSync(plan(), "[]");
  writeFileSync(
    critic(),
    JSON.stringify([
      {
        scores: { hook: ev(8), readability: ev(7), motion: ev(6), variety: ev(8), sound: ev(5), brand: ev(9) },
        blockers: [],
        defects: [
          { at: 0.4, what: "The claim is under 60 px at phone size", fix: "Size 120, two lines" },
          { at: 1, what: "No sound on the first downbeat", fix: "A soft hit at frame 30" },
          { at: 1.5, what: "The claim fades in linearly", fix: "spring.land on the rise" },
        ],
      },
    ]),
  );
  writeFileSync(join(root, "prompts.jsonl"), "");
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const text = (page: Page, selector: string) => page.$eval(selector, (el) => (el as HTMLElement).innerText.trim());
const BEATS = [
  {
    start: 0,
    end: 2,
    title: "Hook",
    entry: "Dark frame, the claim types in",
    exit: "The claim held over the logo",
    purpose: "Say what it does in 2 s",
    assets: ["Argent logo"],
    sound: "the first downbeat",
  },
  {
    start: 2,
    end: 7,
    title: "The dashboard",
    entry: "The claim slides up",
    exit: "A test run goes green",
    purpose: "Show the real product working",
    assets: ["dashboard recording"],
  },
  {
    start: 7,
    end: 10,
    title: "End card",
    entry: "Green run",
    exit: "Logo and argent.dev",
    purpose: "Where to get it",
    assets: ["Argent logo"],
    sound: "the last downbeat",
  },
];

test("round 3 J2: brand kit and skill, question card, brief, storyboard card, review card", { skip, timeout: 300000 }, async () => {
  const app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]),
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: plan(),
      FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      FAKE_CRITIC: critic(),
      UNCUT_APPROVAL_MS: "120000",
    },
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
  const lastDone = () =>
    page.waitForFunction(() => [...document.querySelectorAll("[data-testid=agent-turn]")].at(-1)?.getAttribute("data-status") === "done", { timeout: 30000 });
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=new-project]");
    await waitFor("[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor("[data-testid=agent-panel]");

    // ---- U7: the Brand tab: a kit with colours, a skill from a template, picked for the project ----
    await page.click("[data-testid=rail-brand]");
    await waitFor("[data-testid=brand-library]");
    await page.click("[data-testid=brand-new-kit]");
    await page.type("[data-testid=brand-new-kit-name]", "Argent");
    await page.click("[data-testid=brand-new-kit-create]");
    await waitFor("[data-testid=brand-kit-editor]");
    for (const [i, hex, role] of [
      [0, "#0b1d3a", "background"],
      [1, "#f5a623", "accent"],
      [2, "#ffffff", "text"],
    ] as const) {
      await page.click("[data-testid=brand-color-add]");
      await waitFor(`[data-testid=brand-color-hex-${i}]`);
      await page.click(`[data-testid=brand-color-hex-${i}]`, { clickCount: 3 });
      await page.type(`[data-testid=brand-color-hex-${i}]`, hex);
      await page.select(`[data-testid=brand-color-role-${i}]`, role);
    }
    await page.type("[data-testid=brand-kit-tone]", "Plain, dev to dev. Short sentences.");
    await page.type("[data-testid=brand-kit-donts]", "Never invent dashboard screens");
    await page.screenshot({ path: out("brand-kit-editor") });
    await page.click("[data-testid=brand-save]");
    await page.waitForFunction(() => !document.querySelector("[data-testid=brand-kit-editor]"), { timeout: 10000 }).catch(() => {});
    if (await page.$("[data-testid=brand-back]")) await page.click("[data-testid=brand-back]");
    await waitFor("[data-testid=brand-kit-argent]");
    await page.select("[data-testid=brand-kit-select]", "argent");
    await page.screenshot({ path: out("brand-panel") });
    // D232: the user's copy of Uncut's Launch promo, made in the Skills tab (Duplicate).
    await page.click("[data-testid=rail-skills]");
    await waitFor("[data-testid=skill-launch-promo]");
    await page.click("[data-testid=skill-launch-promo]");
    await waitFor("[data-testid=brand-duplicate]");
    await page.click("[data-testid=brand-duplicate]");
    await waitFor("[data-testid=brand-skill-editor]");
    await page.click("[data-testid=brand-save]");
    await waitFor("[data-testid=skill-launch-promo-copy]");
    await page.click("[data-testid=rail-brand]");
    const kitFile = JSON.parse(readFileSync(join(root, "data", "brand", "kits", "argent", "kit.json"), "utf8"));
    assert.deepEqual(
      kitFile.colors.map((c: { hex: string }) => c.hex),
      ["#0b1d3a", "#f5a623", "#ffffff"],
    );

    // ---- U8: the question card ----
    await waitFor("[data-testid=agent-input]");
    nextTurn([
      { tool: "brand_read" },
      {
        tool: "ask_user",
        args: {
          question: "Which format is it for?",
          options: [
            { label: "9:16", detail: "Phone feeds, Reels, Shorts" },
            { label: "16:9", detail: "YouTube, the site" },
            { label: "4:5", detail: "X and LinkedIn" },
          ],
        },
      },
      { text: "Got it, 9:16 first." },
    ]);
    await send("/launch-promo-copy make a 10 s launch promo for Argent Cloud");
    await waitFor("[data-testid=agent-question]");
    assert.equal(await text(page, "[data-testid=agent-question] .approval-text"), "Which format is it for?");
    const options = await page.$$("[data-testid=agent-question-option]");
    assert.equal(options.length, 3);
    await options[0]!.click();
    await page.type("[data-testid=agent-question-text]", "and a 16:9 cut later");
    await page.screenshot({ path: out("question") });
    await page.click("[data-testid=agent-question-send]");
    await lastDone();
    assert.equal(await text(page, "[data-testid=agent-card][data-type=question] [data-testid=agent-card-answer]"), "9:16, and a 16:9 cut later");
    const first = runs().at(-1);
    assert.match(first.prompt, /<brand>\nKit "Argent" \(argent, the user's\)\nColours: #0b1d3a background; #f5a623 accent; #ffffff text/);
    assert.match(first.prompt, /^\(skill launch-promo-copy\) make a 10 s launch promo/);
    assert.match(first.prompt, /<skill name="launch-promo-copy" title="Launch promo copy">/);
    assert.match(first.prompt, /Skills this project uses: Launch promo copy \(launch-promo-copy\)/);

    // ---- U15/U9: brief, then the storyboard card in the thread; the build goes through ----
    const brief = {
      film: "Argent Cloud runs your app's QA on real devices in the cloud",
      audience: "React Native developers",
      duration: "10 s",
      formats: ["9:16 1080x1920", "16:9 later"],
      assets: ["Argent logo (kit)", "dashboard recording"],
      visual: "Dark navy, amber accent, product first, springy UI motion",
      hardLines: ["Never invent product UI, metrics or logos", "Only the real dashboard recording"],
      deliverables: ["promo-9x16.mp4"],
    };
    const title = {
      id: "claim",
      type: "text",
      start: 0,
      duration: 60,
      text: "QA on real devices, in the cloud",
      transform: { x: 80, y: 400 },
      style: { preset: "text.title", size: 90, weight: 700, color: "#ffffff" },
    };
    nextTurn([
      { tool: "brief_write", args: brief },
      { tool: "storyboard_propose", args: { summary: "Claim, the real dashboard, end card", beats: BEATS.map((b, i) => (i === 0 ? { ...b, still: 0 } : b)) } },
      { tool: "project_read" },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Scene 1: the claim", ops: [{ op: "insert_item", track: "text", item: title }] } },
      { tool: "contact_sheet", args: { max: 4 } },
      { tool: "render_frames", args: { frames: [0, 30], phone: true } },
      { tool: "review_submit", args: {} },
      { text: "Built scene 1; the review asks for a bigger claim and a hit on the downbeat." },
    ]);
    await send("go ahead");
    await lastDone();
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=timeline-item]").length === 1, { timeout: 15000 });
    assert.equal(await page.$("[data-testid=agent-storyboard]"), null, "no approval card");
    const sbCard = "[data-testid=agent-card][data-type=storyboard]";
    await waitFor(sbCard);
    await page.click(`${sbCard} .card-head`);
    assert.equal(await page.$$eval(`${sbCard} [data-testid=agent-storyboard-beat]`, (els) => els.length), 3);
    // D295: the first beat's still, rendered by Uncut and shown on its numbered beat.
    await page.waitForFunction(
      (sel) => (document.querySelector<HTMLImageElement>(`${sel} [data-testid=agent-storyboard-still]`)?.naturalWidth ?? 0) > 0,
      { timeout: 15000 },
      sbCard,
    );
    assert.equal(await page.$$eval(`${sbCard} [data-testid=agent-storyboard-still]`, (els) => els.length), 1);
    assert.match(await text(page, `${sbCard} [data-testid=agent-storyboard-beat] .beat-time`), /^1\. 0 s to 2 s/);
    assert.equal(await page.$(`${sbCard} button.btn.primary`), null, "no Approve on the card");
    await page.$eval(sbCard, (el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: out("storyboard") });
    const sb = JSON.parse(readFileSync(join(root, "projects", readdirFirst(), "storyboard.json"), "utf8"));
    assert.equal(sb.approvedBy, "agent");

    // ---- U16: the review card ----
    await waitFor("[data-testid=agent-card][data-type=review]");
    assert.equal(await page.$$eval("[data-testid=agent-card][data-type=review] [data-testid=agent-review-score]", (els) => els.length), 6);
    assert.match(await text(page, "[data-testid=agent-card][data-type=review] [data-testid=agent-review-defects]"), /The claim is under 60 px at phone size/);
    await page.$eval("[data-testid=agent-card][data-type=review]", (el) => el.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: out("review") });
    // D197: the Plan chip: the storyboard; the brief card opened from it, edited on the card.
    await page.click("[data-testid=plan-chip]");
    await waitFor("[data-testid=plan-menu]");
    assert.match(await text(page, "[data-testid=plan-storyboard]"), /Planned/);
    await page.click("[data-testid=plan-brief]");
    await waitFor("[data-testid=agent-card][data-type=brief] [data-testid=agent-brief-rows]");
    await page.screenshot({ path: out("plan-brief") });
    await page.click("[data-testid=plan-brief-edit]");
    await waitFor("[data-testid=plan-brief-form]");
    await page.click("[data-testid=plan-brief-audience]", { clickCount: 3 });
    await page.type("[data-testid=plan-brief-audience]", "React Native teams shipping weekly");
    await page.click("[data-testid=plan-brief-save]");
    await page.waitForFunction(() => /shipping weekly/.test(document.querySelector("[data-testid=agent-brief-rows]")?.textContent ?? ""), { timeout: 10000 });
    const briefFile = JSON.parse(readFileSync(join(root, "projects", readdirFirst(), "brief.json"), "utf8"));
    assert.equal(briefFile.by, "user");
  } catch (error) {
    await page.screenshot({ path: out("failure") }).catch(() => {});
    throw error;
  }
});

/** The one project folder made in this run. */
function readdirFirst(): string {
  const names = readdirSync(join(root, "projects")).filter((n) => !n.startsWith("."));
  return names[0]!;
}
