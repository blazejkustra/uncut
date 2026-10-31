// The composer's / menu with Claude Code skills whose commands are long
// (/anthropic-skills:argent-comparison-page): every row still shows the skill's name, the command
// is cut with an ellipsis and the menu never scrolls sideways. The skills come from a fake
// CLAUDE_CONFIG_DIR (the account's synced folder), never the real user's.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";
import { clickWhenStill } from "../helpers/wait.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;
const SKILLS = ["argent-comparison-page", "artifact-emulator", "built-in-browser", "chrome-browser", "computer-use", "deep-research", "devrel", "docs"];

let root = "";
let app: LaunchedApp | undefined;

function syncedSkills(config: string) {
  writeFileSync(join(config, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: "org-1", accountUuid: "acc-2" } }));
  for (const name of SKILLS) {
    const dir = join(config, "skills", "synced", "org-1_acc-2", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill.\n---\nDo ${name}.\n`);
  }
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-slash-long-")));
  mkdirSync(join(root, "projects"), { recursive: true });
  mkdirSync(join(root, "claude"), { recursive: true });
  syncedSkills(join(root, "claude"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("the / menu's Claude Code skills with long commands: names shown, commands cut, no sideways scroll", { skip, timeout: 180000 }, async () => {
  app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects")]),
      UNCUT_CLAUDE: FAKE,
      CLAUDE_CONFIG_DIR: join(root, "claude"),
    },
  });
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=new-project]");
  await page.waitForSelector("[data-testid=new-project-form]", { timeout: 15000 });
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title !== "");
  await page.click("[data-testid=create]");
  await page.waitForSelector("[data-testid=agent-input]", { timeout: 15000 });
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  await page.$eval("[data-testid=side-dock]", (el) => (el as HTMLElement).click());
  await page.waitForSelector("[data-testid=side-staged]", { hidden: true, timeout: 10000 });
  await clickWhenStill(page, "[data-testid=agent-input]");
  await page.keyboard.type("/");
  await page.waitForSelector("[data-testid=claude-skill-group]", { timeout: 15000 });
  await page.$eval("[data-testid=claude-skill-group]", (el) => el.scrollIntoView());
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), { timeout: 10000 });

  await page.screenshot({ path: resolve("test-output", "slash-menu-long-skills.png") });
  const picker = await page.$eval("[data-testid=skill-picker]", (el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  assert.ok(picker.scroll <= picker.client, `the menu scrolls sideways: ${picker.scroll} > ${picker.client}`);
  const rows = await page.$$eval("[data-testid=claude-skill-option]", (els) =>
    els.map((el) => {
      const name = el.querySelector<HTMLElement>(".skill-name")!;
      const call = el.querySelector<HTMLElement>(".skill-call")!;
      return {
        id: el.getAttribute("data-skill"),
        name: name.textContent,
        nameCut: name.scrollWidth > name.clientWidth,
        callCut: call.scrollWidth > call.clientWidth,
        callEnd: call.getBoundingClientRect().right,
        rowEnd: el.getBoundingClientRect().right,
      };
    }),
  );
  assert.equal(rows.length, SKILLS.length);
  for (const r of rows) {
    assert.equal(r.nameCut, false, `${r.id}: the name is cut`);
    assert.ok(r.callEnd <= r.rowEnd, `${r.id}: the command runs past its row`);
  }
  assert.ok(rows.find((r) => r.name === "argent-comparison-page")?.callCut, "the longest command ends in an ellipsis");
});
