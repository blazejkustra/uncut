// Issues #30 and #31 (D207) on the packaged app, run invisibly and muted, with the stand-in claude
// and its scripted critic:
// - the first brief suggests Uncut's own skills and the agent reads them with skill_read (D232:
//   nobody picks); the Skills tab lists them under Uncut skills, the plugin that ships them;
// - one opens read-only; Duplicate makes an editable copy that lands under Yours;
// - a click spam (8 UI clicks in 8 s) fails the critic's round on a "Sound" blocker from Uncut's
//   sound check, even with the critic's 9s.
// Screenshots: test-output/issue30-*.png.
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
const out = (name: string) => resolve("test-output", `issue30-${name}.png`);

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue30-")));
  mkdirSync(join(root, "projects"), { recursive: true });
  for (const f of ["prompts.jsonl", "results.jsonl", "critic.jsonl"]) writeFileSync(join(root, f), "");
  const evidence = Object.fromEntries(
    ["hook", "readability", "motion", "variety", "sound", "brand"].map((k) => [k, { score: 9, evidence: "f 0, f 45: fine" }]),
  );
  writeFileSync(
    join(root, "critic.json"),
    JSON.stringify([
      {
        scores: evidence,
        blockers: [],
        defects: [{ at: 0.2, what: "Clicks on nothing a viewer sees", fix: "Delete them" }],
        fixes: [],
        summary: "Looks fine, sounds like a click track.",
      },
    ]),
  );
  writeFileSync(join(root, "plan.json"), "[]");
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "issues #30/#31 (D232): Uncut's skills suggested by the brief and read by the agent, listed in the Skills tab read-only with Duplicate; a click spam fails a promo's critic on sound",
  { skip, timeout: 300000 },
  async () => {
    const turns: Array<unknown> = [];
    const nextTurn = (steps: Array<unknown>) => (turns.push(steps), writeFileSync(join(root, "plan.json"), JSON.stringify(turns)));
    const app = await launchApp({
      command: APP,
      env: {
        UNCUT_DATA_DIR: join(root, "data"),
        UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]),
        UNCUT_CLAUDE: FAKE,
        FAKE_PLAN: join(root, "plan.json"),
        FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
        FAKE_RESULT_LOG: join(root, "results.jsonl"),
        FAKE_CRITIC: join(root, "critic.json"),
        FAKE_CRITIC_LOG: join(root, "critic.jsonl"),
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
      page.waitForFunction(() => [...document.querySelectorAll("[data-testid=agent-turn]")].at(-1)?.getAttribute("data-status") === "done", { timeout: 90000 });
    try {
      await waitForWelcome(page);
      await page.click("[data-testid=new-project]");
      await waitFor("[data-testid=new-project-form]");
      await page.click("[data-testid=choose-folder]");
      await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
      await page.click("[data-testid=create]");
      await waitFor("[data-testid=agent-input]");

      // ---- Turn 1: the brief suggests skills; the agent reads them (D232); a bundled click comes in ----
      const brief = {
        film: "A 10 s launch teaser for Argent Cloud",
        audience: "React Native devs",
        duration: "10 s",
        formats: ["4:5"],
        assets: ["the logo"],
        visual: "Dark, amber",
        hardLines: ["Never invent UI"],
        deliverables: ["4:5 mp4"],
      };
      nextTurn([
        { tool: "brief_write", args: brief },
        ...["launch-promo", "motion-craft", "sound-design"].map((name) => ({ tool: "skill_read", args: { name } })),
        { tool: "library_add", args: { id: "sfx:ui-click" } },
        { text: "Brief saved; I read the skills that fit." },
      ]);
      await send("make a 10 s launch teaser for Argent Cloud");
      await lastDone();
      const results = readFileSync(join(root, "results.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const media = JSON.parse(results.find((r) => r.tool === "library_add").result.content[0].text).media as string;
      assert.equal(results.filter((r) => r.tool === "skill_read" && !r.result.isError).length, 3);

      // ---- The Skills tab: Uncut's own, from its plugin ----
      await page.click("[data-testid=rail-skills]");
      await waitFor("[data-testid=skills-group]");
      assert.match(await page.$eval("[data-testid=skills-group]", (el) => (el as HTMLElement).innerText), /^Uncut skills/i);
      assert.equal((await page.$$("[data-testid=skills-group] [data-testid^=skill-]")).length, 11);
      await page.screenshot({ path: out("skills") });

      // One opens read-only; Duplicate makes the user's copy.
      await page.click("[data-testid=skill-sound-design]");
      await waitFor("[data-testid=skill-view]");
      assert.match(
        await page.$eval("[data-testid=skill-view-body]", (el) => (el as HTMLElement).innerText),
        /Review checklist\n- Every sound effect lands on something that changes on screen/,
      );
      assert.equal(await page.$("[data-testid=brand-save]"), null, "no Save on a plugin's skill");
      assert.equal(await page.$("[data-testid=brand-delete]"), null, "no Delete on a plugin's skill");
      await page.screenshot({ path: out("builtin-skill") });
      await page.click("[data-testid=brand-duplicate]");
      await waitFor("[data-testid=brand-skill-editor]");
      assert.equal(await page.$eval("[data-testid=brand-skill-name]", (el) => (el as HTMLInputElement).value), "Sound design copy");
      await page.click("[data-testid=brand-save]");
      await waitFor("[data-testid=skill-sound-design-copy]");
      assert.ok(existsSync(join(root, "data", "brand", "skills", "sound-design-copy.json")));
      await page.screenshot({ path: out("duplicate") });

      // ---- Turn 2: a text and 8 clicks in 8 s; the critic's round fails on the sound check ----
      await page.click("[data-testid=rail-agent]").catch(() => {});
      const clicks = Array.from({ length: 8 }, (_, i) => ({
        op: "insert_item",
        track: "audio",
        item: { id: `click-${i}`, type: "audio", media, in: 0, start: 6 + i * 30, duration: 6 },
      }));
      nextTurn([
        {
          tool: "storyboard_propose",
          args: {
            summary: "The claim",
            beats: [{ start: 0, end: 10, title: "Claim", entry: "The claim", exit: "The claim held", purpose: "Say what it does", assets: [] }],
          },
        },
        { tool: "project_read" },
        {
          tool: "timeline_edit",
          args: {
            baseRevision: "$rev",
            summary: "Scene 1: the claim, a click on every beat",
            ops: [
              {
                op: "insert_item",
                track: "text",
                item: {
                  id: "claim",
                  type: "text",
                  start: 0,
                  duration: 300,
                  text: "QA on real devices",
                  transform: { x: 100, y: 560 },
                  style: { preset: "text.title", size: 96, color: "#ffffff" },
                },
              },
              ...clicks,
            ],
          },
        },
        { tool: "project_check", args: { rules: ["sound"] } },
        { tool: "contact_sheet", args: { max: 4 } },
        { tool: "render_frames", args: { frames: [0, 60], phone: true } },
        { tool: "review_submit", args: {} },
        { text: "The critic failed it on sound: 8 clicks in 8 s. Cutting them down next." },
      ]);
      await waitFor("[data-testid=agent-input]");
      await send("build it and review");
      await waitFor("[data-testid=agent-storyboard]", 30000);
      await page.click("[data-testid=agent-storyboard-approve]");
      await lastDone();
      const review = "[data-testid=agent-card][data-type=review]";
      await waitFor(review, 30000);
      assert.equal(await page.$eval(review, (el) => el.getAttribute("data-passed")), "false");
      const kinds = await page.$$eval(`${review} [data-testid=agent-review-blocker]`, (els) =>
        els.map((e) => [e.getAttribute("data-kind"), e.getAttribute("data-source")]),
      );
      assert.ok(
        kinds.some(([k, s]) => k === "sound" && s === "check"),
        JSON.stringify(kinds),
      );
      assert.equal(
        await page.$eval(`${review} [data-testid=agent-review-score][data-score=sound]`, (el) => el.getAttribute("data-value")),
        "5",
        "the sound blocker caps sound",
      );
      const critic = readFileSync(join(root, "critic.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .at(-1);
      assert.match(critic.text, /<skill-checklists>\nLaunch promo:/);
      assert.match(critic.text, /<sound>\nsound effect 0\.2 s \(f 6\): ui-click/);
      await page.$eval(review, (el) => el.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: out("sound-review") });
    } catch (error) {
      await page.screenshot({ path: out("failure") }).catch(() => {});
      throw error;
    }
  },
);
