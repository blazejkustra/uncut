// Issue #103 (D277), the legal pass, on the packaged app run invisibly:
// - the setup wizard: Claude Code signed in with an API key from Uncut's environment is Ready (the
//   key reaches claude), no "Codex you already use" or "subscription" copy, and the agent and key
//   rows show the providers' marks (Freesound keeps the key icon);
// - the Generate tab: "SVG drawing" / "Vector animation", "Uses your Claude Code", no "by Claude"
//   or "Anthropic", and no brand-named coming-soon models;
// - the Audio tab: no Epidemic Sound "coming soon".
// Screenshots: test-output/issue103-wizard.png, issue103-generate-picture.png, issue103-generate-video.png, issue103-audio.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;
const KEY = "sk-ant-test-issue103-not-a-key";

let root = "";
let app: LaunchedApp | undefined;

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue103-")));
  const dir = join(root, "Issue103.uncut");
  mkdirSync(dir);
  writeFileSync(join(dir, "project.json"), JSON.stringify({ format: "uncut/0", name: "Issue103", canvas: { width: 1920, height: 1080, fps: 30 }, textLooks: 1, media: [], tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [] }] }));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("issue #103: the setup wizard takes Claude Code's API key sign-in and shows the providers' marks", { skip, timeout: 120000 }, async () => {
  // This claude is signed in only if it can see the key: Ready means Uncut passed it through.
  const stubs = join(root, "stubs");
  mkdirSync(stubs, { recursive: true });
  writeFileSync(
    join(stubs, "claude"),
    `#!/bin/sh\ncase "$1" in --version) echo "2.1.296 (Claude Code)";; auth) if [ "$ANTHROPIC_API_KEY" = "${KEY}" ]; then echo '{"loggedIn":true,"authMethod":"api_key"}'; else echo '{"loggedIn":false}'; exit 1; fi;; esac\n`,
  );
  writeFileSync(join(stubs, "codex"), `#!/bin/sh\necho "codex-cli 0.50.0"\n`);
  for (const f of ["claude", "codex"]) chmodSync(join(stubs, f), 0o755);
  app = await launchApp({
    command: APP,
    cleanEnv: true,
    firstLaunch: true,
    env: { HOME: homedir(), USER: process.env.USER, TMPDIR: process.env.TMPDIR, PATH: `${stubs}:/usr/bin:/bin`, UNCUT_SHELL_ENV: "off", ANTHROPIC_API_KEY: KEY, UNCUT_DATA_DIR: join(root, "data-wizard") },
  });
  const { page } = app;
  await page.waitForSelector("[data-testid=check-claude][data-status=ready]", { timeout: 30000 });
  const wizard = await page.$eval("[data-testid=onboarding]", (el) => (el as HTMLElement).innerText);
  assert.match(wizard, /runs your installed Claude Code or Codex, with whatever sign-in each uses/);
  assert.doesNotMatch(wizard, /Codex you already use|subscription|No API keys needed|One agent is enough/i);
  assert.match(await page.$eval("[data-testid=check-claude]", (el) => (el as HTMLElement).innerText), /Signed in with an API key/);
  assert.ok(!wizard.includes(KEY) && !wizard.includes("sk-ant"), "the key is never shown");
  assert.equal(await page.$("[data-testid=api-key-warning]"), null);
  // The marks: Claude Code, Codex (OpenAI's), and the OpenAI, Google and ElevenLabs keys; Freesound has none.
  for (const id of ["claude", "codex", "openai", "google", "elevenlabs"]) assert.ok(await page.$(`svg[data-testid=row-mark-${id}]`), `${id} row shows its mark`);
  assert.ok(await page.$("[data-testid=check-claude] svg[data-testid=row-mark-claude]"));
  assert.ok(await page.$("[data-testid=key-openai] svg[data-testid=row-mark-openai]"));
  assert.equal(await page.$("[data-testid=key-freesound] [data-testid^=row-mark]"), null);
  assert.ok(await page.$("[data-testid=key-freesound] svg.lucide"), "Freesound keeps the key icon");
  const size = await page.$eval("svg[data-testid=row-mark-claude]", (el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height]);
  assert.deepEqual(size, [20, 20], "a mark is the size of the icons beside it");
  // The wizard may have moved on by itself once everything is ready; show the Agents step.
  await page.click("[data-testid=wizard-step-0]");
  await page.waitForSelector("svg[data-testid=row-mark-claude]");
  await page.screenshot({ path: "test-output/issue103-wizard.png" });
  assert.deepEqual(app.errors, []);
  await app.close();
  app = undefined;
});

test("issue #103: Generate names no Claude feature and lists no brand-named coming-soon model; Audio has no Epidemic Sound", { skip, timeout: 120000 }, async () => {
  app = await launchApp({
    command: APP,
    env: {
      UNCUT_DATA_DIR: join(root, "data"),
      UNCUT_PLUGINS_DIR: join(root, "no-user-plugins"),
      UNCUT_TEST_DIALOG: JSON.stringify([join(root, "Issue103.uncut")]),
      UNCUT_CLAUDE: FAKE,
      UNCUT_OPENAI_BASE: "http://127.0.0.1:9",
      UNCUT_GOOGLE_BASE: "http://127.0.0.1:9",
      UNCUT_ELEVENLABS_BASE: "http://127.0.0.1:9",
    },
  });
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click("[data-testid=rail-generate]");
  await page.waitForSelector("[data-testid=generator][data-id='generate.gpt-image']", { timeout: 15000 });
  const models = () => page.$$eval("[data-testid=generator]", (els) => els.map((e) => ({ id: (e as HTMLElement).dataset.id!, text: (e as HTMLElement).innerText, title: e.getAttribute("title") ?? "" })));
  const panel = () => page.$eval("[data-testid=generate-library]", (el) => (el as HTMLElement).innerText);
  const BRANDS = /Nano Banana|Imagen|Grok|Seedream|Seedance|Higgsfield|Sora|Lyria/;

  let rows = await models();
  assert.deepEqual(rows.map((r) => r.id), ["generate.svg", "generate.gpt-image"], "Picture: no coming-soon models");
  assert.match(rows[0]!.text, /SVG drawing\s*Uses your Claude Code/);
  assert.equal(rows[0]!.title, "SVG drawing, uses your Claude Code");
  assert.ok(await page.$("[data-testid=generator][data-id='generate.svg'] [data-testid=generator-mark] svg"), "the marks stay (user's call)");
  await page.click("[data-testid=generator][data-id='generate.svg']");
  assert.equal(await page.$eval("[data-testid=generate-estimate]", (el) => (el as HTMLElement).innerText.trim()), "Uses your Claude Code");
  let text = await panel();
  assert.doesNotMatch(text, /by Claude|Anthropic|subscription|Coming soon/);
  assert.doesNotMatch(text, BRANDS);
  await page.screenshot({ path: "test-output/issue103-generate-picture.png" });

  await page.click("[data-testid=generate-type-video]");
  await page.waitForSelector("[data-testid=generator][data-id='generate.veo']");
  rows = await models();
  assert.deepEqual(rows.map((r) => r.id), ["generate.svg", "generate.veo"], "Video: no coming-soon models");
  assert.match(rows[0]!.text, /Vector animation/);
  text = await panel();
  assert.doesNotMatch(text, /by Claude|Anthropic|Coming soon/);
  assert.doesNotMatch(text, BRANDS);
  await page.screenshot({ path: "test-output/issue103-generate-video.png" });

  await page.click("[data-testid=generate-type-audio]");
  await page.waitForSelector("[data-testid=generator][data-id='generate.sound']");
  assert.deepEqual((await models()).map((r) => r.id), ["generate.sound", "soon.music", "soon.voice"], "Sound keeps its generic ElevenLabs models");
  assert.doesNotMatch(await panel(), BRANDS);

  await page.click("[data-testid=rail-audio]");
  await page.waitForSelector("[data-testid=music-browser]", { timeout: 15000 });
  const sources = await page.$$eval("[data-testid=library-source] option", (els) => els.map((e) => (e as HTMLOptionElement).textContent ?? ""));
  assert.ok(sources.length > 0 && !sources.some((s) => /Epidemic/.test(s)), sources.join(", "));
  assert.equal(await page.$("[data-testid=epidemic-soon]"), null);
  assert.doesNotMatch(await page.$eval("[data-testid=audio-library]", (el) => (el as HTMLElement).innerText), /Epidemic|Coming soon/);
  await page.screenshot({ path: "test-output/issue103-audio.png" });
  assert.deepEqual(app.errors, []);
});
