// Issue #60 (D232) on the packaged app, run invisibly and muted, with the stand-in claude:
// - the Skills tab lists the skills of the bundled uncut.skills plugin (nothing to pick) and links
//   to plugins for more;
// - / in the composer offers the installed skills with autocomplete; picking one puts /name in the
//   message, and the message reaches the agent with that skill's instructions;
// - the Brand tab leads with Make from reference, which prefills the composer with /make-brand-kit
//   (and sends nothing).
// Screenshots: test-output/issue60-*.png.
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
const out = (name: string) => resolve("test-output", `issue60-${name}.png`);

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue60-")));
  mkdirSync(join(root, "projects"), { recursive: true });
  for (const f of ["prompts.jsonl", "results.jsonl"]) writeFileSync(join(root, f), "");
  writeFileSync(join(root, "plan.json"), JSON.stringify([[{ text: "Whooshes it is." }]]));
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const OWN = ["launch-promo", "product-demo", "talking-head", "social-cutdown", "explainer", "title-sequence", "motion-craft", "sound-design", "brand-application", "make-brand-kit", "motion-film"];

test("issue #60: the Skills tab lists the bundled skills; / in the composer autocompletes and calls one; Make from reference prefills the composer", { skip, timeout: 240000 }, async () => {
  const app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]), UNCUT_CLAUDE: FAKE, FAKE_PLAN: join(root, "plan.json"), FAKE_PROMPT_LOG: join(root, "prompts.jsonl"), FAKE_RESULT_LOG: join(root, "results.jsonl") },
  });
  apps.add(app);
  const { page } = app;
  const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
  const draft = () => page.$eval("[data-testid=agent-input]", (el) => (el as HTMLTextAreaElement).value);
  // Empties the composer key by key (from the end), as a user would.
  const clear = async () => {
    await page.click("[data-testid=agent-input]");
    await page.$eval("[data-testid=agent-input]", (el) => {
      const t = el as HTMLTextAreaElement;
      t.setSelectionRange(t.value.length, t.value.length);
    });
    for (let i = 0; i < 200 && (await draft()) !== ""; i++) await page.keyboard.press("Backspace");
    assert.equal(await draft(), "");
  };
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=new-project]");
    await waitFor("[data-testid=new-project-form]");
    await page.click("[data-testid=choose-folder]");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
    await page.click("[data-testid=create]");
    await waitFor("[data-testid=agent-input]");

    // ---- The Skills tab: Uncut's own skills, from the bundled plugin ----
    await page.click("[data-testid=rail-skills]");
    await waitFor("[data-testid=skills-library] [data-testid=skills-group]");
    const listed = await page.$$eval("[data-testid=skills-group] .brand-row", (els) => els.map((e) => e.getAttribute("data-testid")));
    assert.deepEqual([...listed].sort(), OWN.map((n) => `skill-${n}`).sort());
    assert.match(await page.$eval("[data-testid=skills-group]", (el) => (el as HTMLElement).innerText), /^uncut skills/i);
    assert.match(await page.$eval("[data-testid=skill-sound-design]", (el) => (el as HTMLElement).innerText), /Sound design\s+\/sound-design\s+Few, quiet, synced sound effects/);
    assert.equal(await page.$("[data-testid^=brand-skill-check-]"), null, "nothing to tick");
    assert.match(await page.$eval("[data-testid=skills-intro]", (el) => (el as HTMLElement).innerText), /always on.*type \/ in the chat/s);
    await waitFor("[data-testid=skills-get-more]");
    await page.screenshot({ path: out("skills") });
    // A skill's own view: its instructions, read-only, Use in chat.
    await page.click("[data-testid=skill-launch-promo]");
    await waitFor("[data-testid=skill-view]");
    assert.match(await page.$eval("[data-testid=skill-view-body]", (el) => (el as HTMLElement).innerText), /^A launch film of 15 to 30 s/);
    await page.click("[data-testid=skill-use]");
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("[data-testid=agent-input]")?.value === "/launch-promo ", { timeout: 10000 });
    await page.click("[data-testid=brand-back]");

    // ---- / in the composer: the installed skills, narrowed as you type ----
    await clear();
    await page.keyboard.type("/");
    await waitFor("[data-testid=skill-picker]");
    const all = await page.$$eval("[data-testid=skill-option]", (els) => els.map((e) => e.getAttribute("data-skill")));
    assert.deepEqual([...all].sort(), [...OWN].sort());
    await page.screenshot({ path: out("slash-all") });
    await page.keyboard.type("sou");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=skill-option]").length === 1, { timeout: 5000 });
    assert.equal(await page.$eval("[data-testid=skill-option]", (el) => el.getAttribute("data-skill")), "sound-design");
    await page.screenshot({ path: out("slash-sound") });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector("[data-testid=skill-picker]"), { timeout: 5000 });
    assert.equal(await draft(), "/sound-design ");
    // A path isn't a skill: no picker.
    await page.keyboard.type("add whooshes from /U");
    assert.equal(await page.$("[data-testid=skill-picker]"), null);
    await page.keyboard.type("sers/me/sfx");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll("[data-testid=agent-turn]")].at(-1)?.getAttribute("data-status") === "done", { timeout: 60000 });
    const sent = readFileSync(join(root, "prompts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.refused).at(-1) as { prompt: string; system?: string };
    assert.match(sent.prompt, /^\(skill sound-design\) add whooshes from \/Users\/me\/sfx/);
    assert.match(sent.prompt, /<skill name="sound-design" title="Sound design">\nThe user called the skill sound-design/);
    assert.match(sent.system ?? "", /\n- make-brand-kit: Builds a brand kit/);

    // ---- The Brand tab: Make from reference first; it prefills the composer ----
    await page.click("[data-testid=rail-brand]");
    await waitFor("[data-testid=brand-hero]");
    const first = await page.$eval("[data-testid=brand-library] .brand-body > .lib-section", (el) => !!el.querySelector("[data-testid=brand-make-from-reference]"));
    assert.ok(first, "Make from reference is the first thing in the Brand tab");
    assert.equal(await page.$("[data-testid=brand-skill-new]"), null, "no skills in the Brand tab");
    await page.screenshot({ path: out("brand") });
    await clear();
    await page.keyboard.type("for acme.dev");
    await page.click("[data-testid=brand-make-from-reference]");
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("[data-testid=agent-input]")?.value === "/make-brand-kit for acme.dev", { timeout: 10000 });
    // Focus follows the prefill (a frame later on a slow runner, #89).
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "agent-input", { timeout: 5000 }).catch(() => {});
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "agent-input");
    const turns = await page.$$eval("[data-testid=agent-turn]", (els) => els.length);
    assert.equal(turns, 1, "nothing sent");
    await page.screenshot({ path: out("make-from-reference") });
  } catch (error) {
    await page.screenshot({ path: out("failure") }).catch(() => {});
    throw error;
  }
});
