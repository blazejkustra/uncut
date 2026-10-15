// Issues #42, #44 and #45 (D217) on the packaged app, run invisibly and muted, with the stand-in
// claude and its scripted critic:
// - #45: a tutorial's brief suggests skills and turns none on; the Brief card shows the type, the
//   sound profile and the suggestions as chips: one click adds a skill, one click on its × takes
//   it off again;
// - #42: the tutorial's review has no hook score (greyed N/A) and passes without one;
// - #44: the brief changed to a meme: 16 loud clicks in 8 s are a finding from Uncut's sound check,
//   not a blocker; the user marks it Intended on the review card and the next round leaves it out.
// Screenshots: test-output/issue42-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const out = (name: string) => resolve("test-output", `issue42-${name}.png`);
const ev = (score: number, what: string) => ({ score, evidence: `f 0, f 45: ${what}` });

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue42-")));
  mkdirSync(join(root, "projects"), { recursive: true });
  for (const f of ["prompts.jsonl", "results.jsonl", "critic.jsonl"]) writeFileSync(join(root, f), "");
  const noHook = { readability: ev(9, "each step reads at 360 px"), motion: ev(7, "the cursor glides"), variety: ev(7, "two looks"), sound: ev(8, "quiet bed") };
  const meme = { hook: ev(9, "the joke lands on frame 0"), readability: ev(8, "the line reads"), motion: ev(8, "snappy"), variety: ev(8, "fast"), sound: ev(8, "loud on purpose") };
  writeFileSync(
    join(root, "critic.json"),
    JSON.stringify([
      { scores: noHook, blockers: [], defects: [{ kind: "motion", at: 1, what: "The step title fades in linearly", fix: "spring.land" }], summary: "Clear steps; no hook needed for a tutorial." },
      { scores: meme, blockers: [], defects: [], summary: "Loud on purpose." },
      { scores: meme, blockers: [], defects: [], summary: "Still loud on purpose." },
    ]),
  );
  writeFileSync(join(root, "plan.json"), "[]");
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issues #42/#44/#45: the brief suggests skills (chips add and remove), a tutorial passes without a hook, a meme's loud clicks are a finding marked Intended", { skip, timeout: 360000 }, async () => {
  const turns: Array<unknown> = [];
  const nextTurn = (steps: Array<unknown>) => (turns.push(steps), writeFileSync(join(root, "plan.json"), JSON.stringify(turns)));
  const app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]), UNCUT_CLAUDE: FAKE, FAKE_PLAN: join(root, "plan.json"), FAKE_PROMPT_LOG: join(root, "prompts.jsonl"), FAKE_RESULT_LOG: join(root, "results.jsonl"), FAKE_CRITIC: join(root, "critic.json"), FAKE_CRITIC_LOG: join(root, "critic.jsonl"), UNCUT_APPROVAL_MS: "120000" },
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
  const turnsDone = (n: number) => page.waitForFunction((k) => { const t = [...document.querySelectorAll("[data-testid=agent-turn]")]; return t.length >= k && t.at(-1)?.getAttribute("data-status") === "done"; }, { timeout: 90000 }, n);
  // The thread's "latest" jump button can sit over a chip near the bottom: centre it first.
  const clickChip = async (sel: string) => (await page.$eval(sel, (el) => el.scrollIntoView({ block: "center" })), await page.click(sel));
  const results = () => readFileSync(join(root, "results.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const reviews = () => page.$$("[data-testid=agent-card][data-type=review]");
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=new-project]");
    await waitFor("[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor("[data-testid=agent-input]");

    // ---- #45: a tutorial's brief suggests skills and turns none on ----
    const brief = { film: "Set up Argent in five minutes", type: "tutorial", audience: "React Native devs", duration: "40 s", formats: ["16:9"], assets: ["screen recording of the setup"], visual: "Calm, clear", hardLines: ["Never invent UI"], deliverables: ["16:9 mp4"] };
    nextTurn([{ tool: "brief_write", args: brief }, { text: "Brief saved. Pick the skills you want on its card." }]);
    await send("make a short tutorial on setting up Argent");
    await turnsDone(1);
    const wrote = JSON.parse(results().find((r) => r.tool === "brief_write").result.content[0].text);
    assert.deepEqual(wrote.skills, [], "nothing turned on");
    const card = "[data-testid=agent-card][data-type=brief]";
    await page.click(`${card} .card-head`);
    await waitFor("[data-testid=brief-skills]");
    const rows = await page.$eval(`${card} [data-testid=agent-brief-rows]`, (el) => (el as HTMLElement).innerText);
    assert.match(rows, /Type\s+Tutorial/);
    assert.match(rows, /Sound\s+Standard: at most 4 effects in any 10 s, 6 dB under the music; too many or too loud is a finding/);
    assert.equal(await page.$("[data-testid^=brief-skill-on-]"), null, "no skill on");
    await waitFor("[data-testid=brief-skill-add-builtin-product-demo]");
    assert.equal(await page.$("[data-testid=brief-skill-add-builtin-motion-craft]"), null, "Motion craft isn't forced on a tutorial");
    assert.equal(await page.$("[data-testid=brief-skill-add-builtin-sound-design]"), null, "nor Sound design");
    await page.$eval(card, (el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: out("brief-suggested") });
    // One click adds it, one click on its × takes it off.
    await clickChip("[data-testid=brief-skill-add-builtin-product-demo]");
    await waitFor("[data-testid=brief-skill-on-builtin-product-demo]");
    await page.screenshot({ path: out("brief-skill-on") });
    await clickChip("[data-testid=brief-skill-on-builtin-product-demo]");
    await waitFor("[data-testid=brief-skill-add-builtin-product-demo]");

    // ---- #42: the tutorial's review: no hook score, passes ----
    nextTurn([
      { tool: "storyboard_propose", args: { summary: "Install, then run", beats: [{ start: 0, end: 5, title: "Install", entry: "The command", exit: "Installed", purpose: "Show step 1", assets: [] }] } },
      { tool: "project_read" },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Step 1", ops: [{ op: "insert_item", track: "text", item: { id: "step", type: "text", start: 0, duration: 150, text: "Step 1: install", transform: { x: 160, y: 460 }, style: { preset: "text.title", size: 96, color: "#ffffff" } } }] } },
      { tool: "contact_sheet", args: { max: 4 } },
      { tool: "render_frames", args: { frames: [0, 60], phone: true } },
      { tool: "review_submit", args: {} },
      { text: "The critic passed it; a tutorial isn't judged on a hook." },
    ]);
    await send("build it and review");
    await waitFor("[data-testid=agent-storyboard]", 30000);
    await page.click("[data-testid=agent-storyboard-approve]");
    await turnsDone(2);
    await waitFor("[data-testid=agent-card][data-type=review]", 30000);
    const r1 = (await reviews())[0]!;
    assert.equal(await r1.evaluate((el) => el.getAttribute("data-passed")), "true");
    assert.equal(await r1.$eval("[data-testid=agent-review-score][data-score=hook]", (el) => el.getAttribute("data-applies")), "na");
    assert.match(await r1.$eval("[data-testid=agent-review-score][data-score=hook]", (el) => (el as HTMLElement).innerText), /N\/A/);
    assert.equal(await r1.$eval("[data-testid=agent-review-score][data-score=motion]", (el) => el.getAttribute("data-applies")), "optional");
    assert.match(await r1.$eval("[data-testid=agent-review-by]", (el) => (el as HTMLElement).innerText), /judged as tutorial/);
    await r1.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: out("tutorial-review") });

    // ---- #44: the brief becomes a meme; 16 loud clicks in 8 s are a finding, not a blocker ----
    nextTurn([
      { tool: "brief_write", args: { ...brief, film: "A meme edit of setting up Argent", type: "meme", visual: "Loud, fast", duration: "8 s" } },
      { tool: "library_add", args: { id: "sfx:ui-click" } },
      { text: "Now a meme." },
    ]);
    await send("make it a meme instead");
    await turnsDone(3);
    const media = JSON.parse(results().filter((r) => r.tool === "library_add").at(-1).result.content[0].text).media as string;
    const clicks = Array.from({ length: 16 }, (_, i) => ({ op: "insert_item", track: "audio", item: { id: `click-${i}`, type: "audio", media, in: 0, start: 6 + i * 15, duration: 6, gainDb: 6 } }));
    nextTurn([
      { tool: "project_read" },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Clicks everywhere", ops: clicks } },
      { tool: "contact_sheet", args: { max: 4 } },
      { tool: "render_frames", args: { frames: [0, 60], phone: true } },
      { tool: "review_submit", args: {} },
      { text: "Passed; the click storm is a finding you can keep." },
    ]);
    await send("clicks everywhere, then review");
    await turnsDone(4);
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=agent-card][data-type=review]").length >= 2, { timeout: 30000 });
    const r2 = (await reviews())[1]!;
    assert.equal(await r2.evaluate((el) => el.getAttribute("data-passed")), "true");
    assert.equal(await r2.$("[data-testid=agent-review-blocker]"), null, "no sound blocker in a meme");
    assert.equal(await r2.$eval("[data-testid=agent-review-score][data-score=brand]", (el) => el.getAttribute("data-applies")), "na", "no kit: no brand");
    const density = "[data-testid=agent-review-defect][data-rule='sound:density']";
    assert.match(await r2.$eval(density, (el) => (el as HTMLElement).innerText), /16 sound effects start .*Uncut's sound check/s);
    await r2.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: out("meme-finding") });
    await (await r2.$(`${density} [data-testid=agent-review-intended]`))!.click();
    await page.waitForFunction((sel) => [...document.querySelectorAll("[data-testid=agent-card][data-type=review]")][1]?.querySelector(sel)?.getAttribute("data-intended") === "true", { timeout: 10000 }, density);
    await page.screenshot({ path: out("intended") });

    // ---- The next round leaves it out ----
    nextTurn([
      { tool: "contact_sheet", args: { max: 4 } },
      { tool: "render_frames", args: { frames: [0, 60], phone: true } },
      { tool: "review_submit", args: {} },
      { text: "Reviewed again." },
    ]);
    await send("review it again");
    await turnsDone(5);
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=agent-card][data-type=review]").length >= 3, { timeout: 30000 });
    const r3 = (await reviews())[2]!;
    assert.equal(await r3.$(density), null, "the Intended finding is left out");
    assert.match(await r3.$eval("[data-testid=agent-review-by]", (el) => (el as HTMLElement).innerText), /1 finding you marked Intended left out/);
    const critic = readFileSync(join(root, "critic.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
    assert.match(critic.text, /<intended>\nThe user marked these as intended: don't raise them again\.\nsound:density at /);
    await r3.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: out("intended-next-round") });
  } catch (error) {
    await page.screenshot({ path: out("failure") }).catch(() => {});
    throw error;
  }
});
