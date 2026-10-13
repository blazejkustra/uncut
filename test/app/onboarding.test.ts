// Phase 3 chunk 4: onboarding on the packaged app, launched with launchd's bare environment
// (as from Finder), so the statuses come from real detection through the login-shell PATH.
// Screenshots: test-output/onboarding-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;

let root: string, data: string;
// The speech model's download (D68) comes from here: a small fake, slowly, never the real 550 MB.
let modelServer: Server | undefined;
let modelUrl = "";
const modelRequests: Array<string> = [];
const apps = new Set<LaunchedApp>();
// Only what launchd sets for a GUI app: no Homebrew, nvm or ~/.local/bin on PATH.
const launch = async () => {
  const app = await launchApp({
    command: APP,
    cleanEnv: true,
    firstLaunch: true,
    env: {
      HOME: homedir(),
      USER: process.env.USER,
      LOGNAME: process.env.USER,
      TMPDIR: process.env.TMPDIR,
      SHELL: process.env.SHELL || "/bin/zsh",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      UNCUT_DATA_DIR: data,
      UNCUT_TEST_DIALOG: "[]",
      UNCUT_WHISPER_MODEL_URL: modelUrl,
    },
  });
  apps.add(app);
  return app;
};
const close = async (app: LaunchedApp) => {
  await app.close();
  apps.delete(app);
};
const shot = (app: LaunchedApp, name: string) => app.page.screenshot({ path: `test-output/onboarding-${name}.png` });
const text = (page: Page, id: string) => page.$eval(`[data-testid=${id}]`, (el) => el.textContent.trim());
const attr = (page: Page, id: string, name: string) => page.$eval(`[data-testid=${id}]`, (el, n) => el.getAttribute(n), name);
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-onboarding-")));
  data = join(root, "data");
  const body = Buffer.alloc(1024 * 1024, 7);
  modelServer = createServer(async (req, res) => {
    modelRequests.push(req.url ?? "");
    res.writeHead(200, { "content-length": String(body.length) });
    for (let at = 0; at < body.length && !res.destroyed; at += 64 * 1024) {
      res.write(body.subarray(at, at + 64 * 1024));
      await sleep(60);
    }
    res.end();
  });
  await new Promise<void>((r) => modelServer!.listen(0, "127.0.0.1", () => r()));
  modelUrl = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/models`;
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  modelServer?.closeAllConnections();
  modelServer?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("first launch shows the wizard with real statuses; finishing it is remembered; ⌘, and Setup reopen it", { skip, timeout: 240000 }, async () => {
  let app = await launch();
  let { page } = app;

  // Step 1: agents, detected for real. On a very busy machine a probe can time out (an
  // "Error" chip); that's what Check again is for, so use it before judging.
  await waitFor(page, "[data-testid=onboarding]");
  await waitFor(page, "[data-testid=check-claude]");
  const anyError = () => page.$$eval("[data-status=error]", (els) => els.length > 0);
  for (let i = 0; i < 2 && (await anyError()); i++) {
    await page.click("[data-testid=check-again]");
    await waitFor(page, "[data-testid=check-again]:not([disabled])", 30000);
  }
  const claude = await attr(page, "check-claude", "data-status");
  if (existsSync(join(homedir(), ".local/bin/claude"))) {
    assert.ok(["ready", "needs-login"].includes(claude!), `Claude Code: ${claude} (${await text(page, "check-claude")})`);
    assert.match(await text(page, "check-claude"), /Version \d+\.\d+/);
  }
  assert.equal(await attr(page, "check-codex", "data-status"), "missing");
  assert.equal(await text(page, "chip-codex"), "Not installed");
  await page.click("[data-testid=copy-codex]");
  for (let i = 0; i < 20 && !app.output().includes("[test] copied npm install -g @openai/codex"); i++) await sleep(100);
  assert.ok(app.output().includes("[test] copied npm install -g @openai/codex"));
  await page.click("[data-testid=check-again]");
  await waitFor(page, "[data-testid=check-again]:not([disabled])");
  await shot(app, "1-agents");

  // Step 2: capture and export tools.
  await page.click("[data-testid=wizard-continue]");
  await waitFor(page, "[data-testid=check-ffmpeg]");
  for (let i = 0; i < 2 && (await anyError()); i++) {
    await page.click("[data-testid=check-again]");
    await waitFor(page, "[data-testid=check-again]:not([disabled])", 30000);
  }
  if (existsSync("/opt/homebrew/bin/ffmpeg")) assert.equal(await text(page, "chip-ffmpeg"), "Ready");
  if (existsSync("/opt/homebrew/bin/argent")) assert.equal(await text(page, "chip-argent"), "Ready");
  // whisper.cpp and its speech model (D68): nothing downloaded until asked; a smaller model can be chosen.
  await waitFor(page, "[data-testid=check-whisper]");
  if (existsSync("/opt/homebrew/bin/whisper-cli")) assert.equal(await text(page, "chip-whisper"), "Ready");
  else assert.match(await text(page, "check-whisper"), /brew install whisper-cpp/);
  await waitFor(page, "[data-testid=whisper-model]");
  assert.equal(await attr(page, "whisper-model", "data-installed"), "false");
  assert.equal(await attr(page, "whisper-model", "data-model"), "large-v3-turbo-q5_0");
  assert.match(await text(page, "whisper-model-status"), /Not downloaded yet \(574 MB\)/);
  assert.deepEqual(await page.$$eval("[data-testid=whisper-model-select] option", (els) => els.map((e) => (e as HTMLOptionElement).value)), ["large-v3-turbo-q5_0", "small", "base"]);
  assert.deepEqual(modelRequests, [], "nothing downloaded at start");
  await page.select("[data-testid=whisper-model-select]", "base");
  await waitFor(page, "[data-testid=whisper-model][data-model=base]");
  assert.equal(JSON.parse(readFileSync(join(data, "settings.json"), "utf8")).whisperModel, "base");
  await page.click("[data-testid=whisper-download]");
  await waitFor(page, "[data-testid=whisper-download-progress]");
  assert.match(await text(page, "whisper-model-status"), /Downloading… \d+%/);
  await shot(app, "2-capture-downloading");
  await waitFor(page, "[data-testid=whisper-model][data-installed=true]", 30000);
  assert.equal(await text(page, "chip-whisper-model"), "Ready");
  assert.deepEqual(modelRequests, ["/models/ggml-base.bin"]);
  assert.ok(existsSync(join(data, "models", "ggml-base.bin")));
  await shot(app, "2-capture");

  // Step 3: first video → skip for now.
  await page.click("[data-testid=wizard-continue]");
  await waitFor(page, "[data-testid=wizard-skip]");
  await shot(app, "3-first-video");
  await page.click("[data-testid=wizard-skip]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=onboarding]"));
  await waitFor(page, "[data-testid=welcome]");
  const onboarded = () => existsSync(join(data, "settings.json")) && JSON.parse(readFileSync(join(data, "settings.json"), "utf8")).onboarded === true;
  for (let i = 0; i < 20 && !onboarded(); i++) await sleep(100);
  assert.equal(JSON.parse(readFileSync(join(data, "settings.json"), "utf8")).onboarded, true);
  assert.deepEqual(app.errors, []);
  await close(app);

  // Second launch: straight to welcome.
  app = await launch();
  page = app.page;
  await waitFor(page, "[data-testid=welcome]");
  await sleep(500);
  assert.equal(await page.$("[data-testid=onboarding]"), null);

  // ⌘, (Uncut → Settings…) reopens it; Escape closes it.
  await page.keyboard.down("Meta");
  await page.keyboard.press("Comma");
  await page.keyboard.up("Meta");
  await waitFor(page, "[data-testid=onboarding]");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=onboarding]"));

  // The welcome card's Setup entry too; "New project" on the last step leads into the form.
  await page.click("[data-testid=open-setup]");
  await waitFor(page, "[data-testid=onboarding]");
  await page.click("[data-testid=wizard-step-2]");
  await page.click("[data-testid=wizard-new-project]");
  await waitFor(page, "[data-testid=new-project-form]");
  assert.equal(await page.$("[data-testid=onboarding]"), null);
  assert.deepEqual(app.errors, []);
  await close(app);
});

test("at the minimum window size a tall step scrolls from its top; a failed check shows an error, not a spinner", { skip, timeout: 240000 }, async () => {
  // Stub tools: Claude signed out, no Codex, no ffmpeg, and a key in the environment: the tallest steps.
  const stubs = join(root, "stubs");
  mkdirSync(stubs, { recursive: true });
  writeFileSync(join(stubs, "claude"), `#!/bin/sh\ncase "$1" in --version) echo "2.1.296 (Claude Code)";; auth) echo '{"loggedIn":false}'; exit 1;; esac\n`);
  chmodSync(join(stubs, "claude"), 0o755);
  const app = await launchApp({
    command: APP,
    cleanEnv: true,
    firstLaunch: true,
    env: {
      HOME: homedir(),
      USER: process.env.USER,
      TMPDIR: process.env.TMPDIR,
      PATH: `${stubs}:/usr/bin:/bin`,
      UNCUT_SHELL_ENV: "off",
      ANTHROPIC_API_KEY: "sk-test-not-a-real-key",
      UNCUT_DATA_DIR: join(root, "data-small"),
      UNCUT_TEST_DIALOG: "[]",
    },
  });
  apps.add(app);
  const { page } = app;
  await page.evaluate(() => window.resizeTo(800, 500));
  await sleep(600);
  assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [1024, 640]);
  await waitFor(page, "[data-testid=check-claude][data-status=needs-login]");
  await waitFor(page, "[data-testid=api-key-warning]");
  assert.match(await text(page, "api-key-warning"), /in your environment/);

  // Taller than the window: it starts at the card's top (brand visible) and scrolls to the buttons.
  const layer = "[data-testid=onboarding]";
  const metrics = await page.$eval(layer, (el) => ({ scrollTop: el.scrollTop, overflow: el.scrollHeight > el.clientHeight }));
  assert.equal(metrics.scrollTop, 0);
  assert.ok(metrics.overflow, "this step should be taller than 640 px");
  const brand = await page.$eval(".wiz-brand", (el) => el.getBoundingClientRect().toJSON());
  assert.ok(brand.top >= 0 && brand.bottom <= 640, `brand at ${brand.top}`);
  await shot(app, "small-1-top");
  await page.$eval(layer, (el) => el.scrollTo(0, el.scrollHeight));
  await sleep(200);
  const cont = await page.$eval("[data-testid=wizard-continue]", (el) => el.getBoundingClientRect().toJSON());
  assert.ok(cont.top >= 0 && cont.bottom <= 640, `Continue at ${cont.top}-${cont.bottom}`);
  await shot(app, "small-2-bottom");

  // No agent ready: the Agents step is marked visited, not done.
  await page.click("[data-testid=wizard-continue]");
  await waitFor(page, "[data-testid=ffmpeg-callout]");
  assert.match(await page.$eval("[data-testid=wizard-step-mark-0]", (el) => el.className), /visited/);
  assert.doesNotMatch(await page.$eval("[data-testid=wizard-step-mark-0]", (el) => el.className), /done/);
  await shot(app, "small-3-capture");

  // The whole check failing (server frozen) shows an error with Check again, not a spinner forever.
  const pid = Number(execFileSync("pgrep", ["-P", String(app.proc.pid), "-f", "server/server.mjs"], { encoding: "utf8" }).trim());
  process.kill(pid, "SIGSTOP");
  try {
    await page.click("[data-testid=check-again]");
    await waitFor(page, "[data-testid=setup-error]", 30000);
    assert.equal(await page.$(".wiz-row.pending"), null);
    await shot(app, "small-4-check-failed");
  } finally {
    process.kill(pid, "SIGCONT");
  }
  // Back online, Check again brings the rows back.
  for (let i = 0; i < 40 && (await page.$("[data-testid=setup-error]")); i++) {
    await page.click("[data-testid=check-again]").catch(() => {});
    await sleep(1000);
  }
  await waitFor(page, "[data-testid=check-ffmpeg]", 20000);
  assert.equal(await page.$("[data-testid=setup-error]"), null);
  assert.deepEqual(app.errors, []);
  await close(app);
});
