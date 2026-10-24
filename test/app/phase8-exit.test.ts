// Phase 8 exit check (D104): a community plugin from start to removal, on the packaged app (background
// window, muted) with the scripted claude (helpers/fake-claude.ts). Never the real claude or argent.
// - `pnpm plugin:new acme.promo` on a temp copy of the repo's plugins/ (never into the repo), a
//   contribution added (a max-words rule next to the template's look), `pnpm plugin:check` passes.
// - Settings › Plugins: Add plugin… from that folder, the approval dialog, Allow; Browse, Enable…
//   the catalog's taste.extra, Allow.
// - One agent turn: media_import of a clip, then a text in the new plugin's look, the new plugin's
//   tool (acme_promo_word_count), project_check with both plugins' rules. Export.
// - Remove acme.promo and Disable taste.extra: project.json is unchanged (the look was copied into
//   the item, D103); quit, start again, open it from Recents, export again: the same video.
// - The repo's plugins/ is unchanged; nothing left the machine (helpers/offline.ts, as in D101).
// Output: test-output/phase8-exit-editor.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Project } from "../../packages/core/src/index.ts";
import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";
import { isLocalUrl, watchSockets } from "../helpers/offline.ts";
import { probe, ssimAt } from "../helpers/phase6-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const which = (name: string) => {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};
const FFMPEG = which("ffmpeg");
const FFPROBE = which("ffprobe");
const skip = !existsSync(APP) ? `packaged app not built: run pnpm dist to create ${APP}` : !FFMPEG || !FFPROBE ? "needs ffmpeg and ffprobe" : false;

const ID = "acme.promo";
const TOOL = "acme_promo_word_count";
const LOOK = "acme.promo.headline";
const RULE = "acme.promo.short-lines";
const LINE = "A revolutionary editor for your launch video";

type Content = Array<{ type: string; text?: string }>;
type Result = { tool: string; result: { isError?: boolean; content: Content; structuredContent?: unknown } };
let root = "";
let shimDir = "";
let pluginDir = "";
let clip = "";
let app: LaunchedApp | undefined;
let page: Page;
let dir = "";
let repoPlugins: Record<string, string> = {};
const rendererRequests: Array<string> = [];
const remoteSockets: Array<string> = [];
let sockets: { stop: () => void } | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plan = () => join(root, "plan.json");
const awaitPath = () => join(root, "place.json");
const resultLog = () => join(root, "results.jsonl");
const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const results = (): Array<Result> => lines(resultLog());
const textOf = (r: Result["result"]) => r.content.find((c) => c.type === "text")!.text!;
const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const waitFor = (selector: string, timeout = 20000) => page.waitForSelector(selector, { timeout });
const text = (selector: string) => page.$eval(selector, (el) => ((el as HTMLElement).innerText ?? "").trim());
const until = async (check: () => boolean, what: string, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
let t0 = Date.now();
const step = (what: string) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)} s] ${what}`);

/** The repo's plugins/ folder as path → size and content hash (to show the test never wrote into it). */
function snapshot(top: string) {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      const st = lstatSync(path);
      if (st.isDirectory()) walk(path);
      else out[path.slice(top.length + 1)] = `${st.size} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    }
  };
  walk(top);
  return out;
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  repoPlugins = snapshot(resolve("plugins"));
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-phase8-exit-")));
  mkdirSync(join(root, "projects"));
  mkdirSync(join(root, "out"));
  mkdirSync(join(root, "files"));
  shimDir = join(root, "bin");
  mkdirSync(shimDir);
  symlinkSync(FFMPEG!, join(shimDir, "ffmpeg"));
  symlinkSync(FFPROBE!, join(shimDir, "ffprobe"));
  symlinkSync(process.execPath, join(shimDir, "node"));
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "data", "settings.json"), JSON.stringify({ onboarded: true }));
  for (const f of [resultLog(), join(root, "prompts.jsonl"), join(root, "tools.jsonl")]) writeFileSync(f, "");
  // A flat 3 s clip, so the headline's pixels are easy to tell from the footage's.
  clip = join(root, "files", "backdrop.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x1E2A44:s=1920x1080:r=30:d=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:sample_rate=48000:duration=3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    clip,
  ]);
});
after(async () => {
  sockets?.stop();
  if (root && !existsSync(awaitPath())) writeFileSync(awaitPath(), JSON.stringify([{ fail: "aborted" }]));
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const env = (dialogs: Array<string>) => ({
  UNCUT_DATA_DIR: join(root, "data"),
  UNCUT_PLUGINS_DIR: join(root, "no-dev-plugins"),
  UNCUT_SHELL_ENV: "off",
  PATH: `${shimDir}:/usr/bin:/bin`,
  UNCUT_CLAUDE: FAKE,
  FAKE_PLAN: plan(),
  FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
  FAKE_RESULT_LOG: resultLog(),
  FAKE_TOOLS_LOG: join(root, "tools.jsonl"),
  UNCUT_GOOGLE_BASE: "http://127.0.0.1:9",
  UNCUT_OPENAI_BASE: "http://127.0.0.1:9",
  UNCUT_ELEVENLABS_BASE: "http://127.0.0.1:9",
  UNCUT_TEST_DIALOG: JSON.stringify(dialogs),
});

async function launch(dialogs: Array<string>) {
  app = await launchApp({ command: APP, env: env(dialogs) });
  page = app.page;
  page.on("request", (r) => rendererRequests.push(r.url()));
  sockets = watchSockets(app.proc.pid!, remoteSockets);
}
async function quit() {
  sockets?.stop();
  await app!.close();
  app = undefined;
}

async function openSettingsPlugins() {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down("Meta");
  await page.keyboard.press("Comma");
  await page.keyboard.up("Meta");
  // ⌘, opens Settings (G8, D119); the agents, capture and plugins setup is one click in.
  await waitFor("[data-testid=settings]");
  await page.click("[data-testid=settings-nav-app]");
  await page.click("[data-testid=settings-setup]");
  await waitFor("[data-testid=onboarding]");
  await page.click("[data-testid=wizard-step-1]");
  await waitFor("[data-testid=plugins]");
}

async function exportTo(name: string) {
  await page.click("[data-testid=export-button]");
  await waitFor("[data-testid=export-form]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction((n: string) => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === n, {}, name);
  await page.click("[data-testid=export-start]");
  await page.waitForFunction(() => ["done", "failed"].includes(document.querySelector<HTMLElement>("[data-testid=export-job]")?.dataset.phase ?? ""), {
    timeout: 300000,
  });
  assert.match(await text("[data-testid=export-status]"), /Saved/);
  await page.keyboard.press("Escape");
}

test(
  "phase 8 exit: plugin:new, plugin:check, install and allow it, enable a catalog plugin; the agent uses both; remove both and the project opens and exports the same; nothing leaves the machine",
  { skip, timeout: 600000 },
  async () => {
    const started = Date.now();
    try {
      await exitCheck();
    } catch (error) {
      await page?.screenshot({ path: "test-output/phase8-exit-failure.png" }).catch(() => {});
      const log = results()
        .map((r) => `${r.tool}${r.result.isError ? " (error)" : ""}: ${textOf(r.result).slice(0, 400)}`)
        .join("\n");
      throw Object.assign(error as Error, {
        message: `${(error as Error).message}\n--- tool results ---\n${log}\n--- app output ---\n${app?.output().slice(-4000)}`,
      });
    }
    console.log(`phase 8 exit check took ${((Date.now() - started) / 1000).toFixed(1)} s`);
  },
);

async function exitCheck() {
  t0 = Date.now();
  // 1. A contributor's plugin: plugin:new on a copy of plugins/, one more contribution, plugin:check.
  const plugins = join(root, "repo", "plugins");
  cpSync(resolve("plugins"), plugins, { recursive: true });
  const made = execFileSync(process.execPath, [resolve("scripts/plugin-new.ts"), ID, "--plugins", plugins], { encoding: "utf8" });
  assert.match(made, /Made Acme promo \(acme\.promo\)/);
  assert.match(made, /pnpm plugin:check/);
  pluginDir = join(plugins, "catalog", "acme-promo");
  const manifestFile = join(pluginDir, "uncut.module.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.description = "Acme's house style: a headline look, a short-lines rule and a word count for the agent.";
  manifest.contributes.rules = [
    { id: RULE, title: "Short lines", description: "At most 5 words on screen at once.", severity: "warn", rule: { type: "max-words", max: 5 } },
  ];
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.match(execFileSync(process.execPath, [resolve("scripts/plugin-check.ts"), pluginDir], { encoding: "utf8" }), /acme\.promo passes/);
  assert.ok(!existsSync(resolve("plugins/catalog/acme-promo")), "nothing written into the repo");
  step("plugin:new and plugin:check");

  // 2. Install it from its folder (approval dialog, Allow), then enable taste.extra from the catalog.
  const saveAs = join(root, "out", "Phase 8.mp4");
  await launch([pluginDir, join(root, "projects"), saveAs]);
  await waitForWelcome(page);
  await openSettingsPlugins();
  await page.click("[data-testid=plugin-add]");
  await page.click("[data-testid=plugin-add-folder]");
  await waitFor("[data-testid=plugin-dialog]");
  assert.match(await text("[data-testid=plugin-dialog-source]"), new RegExp(`Copied from ${pluginDir}`));
  assert.match(await text("[data-testid=plugin-dialog-tools-for-the-agent]"), new RegExp(TOOL));
  assert.match(await text("[data-testid=plugin-dialog-adds]"), /Headline/);
  await page.click("[data-testid=plugin-dialog-allow]");
  await waitFor(`[data-testid='plugin-${ID}'][data-status=ready]`);
  await page.click("[data-testid=plugin-browse]");
  const entry = "[data-testid=plugin-catalog-entry][data-id='taste.extra']";
  await waitFor(`${entry}[data-enabled=false]`);
  assert.equal(await page.$("[data-testid=plugin-catalog-entry][data-id='example.template']"), null, "the template isn't in the catalog");
  await page.click(`${entry} [data-testid=plugin-catalog-enable]`);
  await waitFor("[data-testid=plugin-dialog]");
  await page.click("[data-testid=plugin-dialog-allow]");
  await waitFor("[data-testid='plugin-taste.extra'][data-status=ready]");
  await waitFor(`${entry}[data-enabled=true]`);
  const settings = JSON.parse(readFileSync(join(root, "data", "settings.json"), "utf8"));
  assert.equal(settings.pluginInstalls[ID].kind, "folder");
  assert.equal(settings.pluginInstalls["taste.extra"].kind, "catalog");
  assert.ok(settings.pluginApprovals[ID] && settings.pluginApprovals["taste.extra"]);
  await page.keyboard.press("Escape");
  step("installed and enabled, both allowed");

  // 3. A project, and the agent's turn.
  await waitForWelcome(page);
  await page.click("[data-testid=new-project]");
  await waitFor("[data-testid=new-project-form]");
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction((d: string) => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title === d, {}, join(root, "projects"));
  await page.click("[data-testid=create]");
  await waitFor("[data-testid=editor]");
  dir = await page.$eval("[data-testid=project-title]", (el) => (el as HTMLElement).title);
  writeFileSync(plan(), JSON.stringify([[{ tool: "media_import", args: { path: clip } }, { await: awaitPath() }]]));
  await page.click("[data-testid=tab-agent]");
  await waitFor("[data-testid=agent-panel]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"), { timeout: 20000 });
  await page.click("[data-testid=agent-input]");
  await page.keyboard.type("Put a headline in the Acme look over my clip and check it against our house style");
  await page.keyboard.press("Enter");
  await until(() => results().some((r) => r.tool === "media_import"), "media_import", 60000);
  const media = onDisk().media.find((m) => m.path === clip)!;
  assert.ok(media, JSON.stringify(onDisk().media));
  const ops = [
    { op: "insert_item", track: "main", item: { id: "backdrop", type: "clip", media: media.id, in: 0, duration: 90 } },
    { op: "insert_text", look: LOOK, text: LINE, start: 0, duration: 90, id: "headline" },
  ];
  writeFileSync(
    awaitPath(),
    JSON.stringify([
      { tool: "project_read", args: {} },
      { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "The clip and an Acme headline", ops } },
      { tool: "project_check", args: {} },
      { tool: TOOL, args: {} },
      { text: "Placed the headline; the house style flags the hype word and the long line." },
    ]),
  );
  await page.waitForFunction(
    () => ["done", "failed", "cancelled"].includes(document.querySelector<HTMLElement>("[data-testid=agent-turn]")?.dataset.status ?? ""),
    { timeout: 120000 },
  );
  assert.equal(await page.$eval("[data-testid=agent-turn]", (el) => (el as HTMLElement).dataset.status), "done", await text("[data-testid=agent-turn]"));
  for (const r of results()) assert.ok(!r.result.isError, `${r.tool}: ${textOf(r.result)}`);
  assert.ok(lines(join(root, "tools.jsonl"))[0].includes(TOOL), "the agent sees the new plugin's tool");
  const steps = await page.$$eval("[data-testid=agent-step]", (els) => els.map((e) => e.textContent ?? ""));
  assert.ok(steps.includes(`Used ${TOOL} from Acme promo`), steps.join(" | "));
  // The look, copied into the item (no preset: nothing in the project names the plugin).
  const p1 = onDisk();
  const headline = p1.tracks.flatMap((t) => t.items).find((i) => i.id === "headline") as unknown as { text: string; style: Record<string, unknown> };
  assert.equal(headline.text, LINE);
  assert.equal(headline.style.preset, undefined);
  assert.equal(headline.style.weight, 800);
  assert.equal(String(headline.style.color).toUpperCase(), "#FFFFFF");
  assert.ok(!JSON.stringify(p1).includes(ID) && !JSON.stringify(p1).includes("taste.extra"), "project.json names neither plugin");
  // project_check: both plugins' rules.
  const check = JSON.parse(textOf(results().find((r) => r.tool === "project_check")!.result)) as { checks: Array<{ rule: string; message: string }> };
  const rules = check.checks.map((c) => c.rule);
  for (const rule of [RULE, "taste.extra.banned-phrases", "taste.extra.end-card"]) assert.ok(rules.includes(rule), `${rule} in ${rules.join(", ")}`);
  assert.match(check.checks.find((c) => c.rule === RULE)!.message, /7 words/);
  // The new plugin's tool, on the saved project.
  const count = JSON.parse(textOf(results().find((r) => r.tool === TOOL)!.result));
  assert.deepEqual({ texts: count.texts, words: count.words }, { texts: 1, words: 7 });
  step("turn done: look, tool, both plugins' checks");

  // K1 (D121): the plugins' rules reach the agent's project_check (above); the editor has no Checks tab.
  assert.equal(await page.$("[data-testid=tab-checks]"), null);
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Home");
  // Past the headline's fade-in.
  await page.keyboard.down("Shift");
  for (let i = 0; i < 2; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await sleep(1000);
  await page.screenshot({ path: "test-output/phase8-exit-editor.png" });

  // 4. Export.
  await exportTo("Phase 8.mp4");
  const first = probe(saveAs);
  assert.equal(first.frames, 90);
  step("exported");

  // 5. Remove the new plugin, disable the catalog one: the project is untouched.
  await openSettingsPlugins();
  await page.click(`[data-testid='plugin-remove-${ID}']`);
  await page.waitForFunction((id: string) => !document.querySelector(`[data-testid='plugin-${id}']`), {}, ID);
  await page.click("[data-testid=plugin-browse]");
  await waitFor(`${entry}[data-enabled=true]`);
  await page.click(`${entry} [data-testid=plugin-catalog-disable]`);
  await waitFor(`${entry}[data-enabled=false]`);
  await page.waitForFunction(() => !document.querySelector("[data-testid='plugin-taste.extra']"));
  await page.keyboard.press("Escape");
  assert.deepEqual(
    readdirSync(join(root, "data", "plugins")).filter((n) => !n.startsWith(".")),
    [],
    "both copies removed",
  );
  const after = JSON.parse(readFileSync(join(root, "data", "settings.json"), "utf8"));
  assert.equal(after.pluginInstalls?.[ID], undefined);
  assert.equal(after.pluginApprovals?.["taste.extra"], undefined);
  assert.deepEqual(onDisk(), p1, "removing the plugins doesn't touch the project");
  assert.deepEqual(app!.errors, []);
  await quit();
  step("removed and disabled");

  // 6. Start again, open it from Recents, export again: the same video.
  const again = join(root, "out", "Phase 8 again.mp4");
  await launch([again]);
  await waitFor("[data-testid=recent]");
  await page.click("[data-testid=recent]");
  await waitFor("[data-testid=editor]");
  assert.deepEqual(onDisk(), p1, "it opens unchanged");
  await exportTo("Phase 8 again.mp4");
  const second = probe(again);
  assert.deepEqual({ ...second, duration: 0 }, { ...first, duration: 0 });
  // The headline drawn the same, and drawn at all (the footage alone is flat there).
  const { width: w, height: h } = first;
  const crop: [number, number, number, number] = [Math.round(w * 0.1), Math.round(h * 0.36), Math.round(w * 0.8), Math.round(h * 0.28)];
  for (const t of [1, 2.5]) {
    const same = ssimAt(saveAs, t, again, t, { cropA: crop, cropB: crop });
    assert.ok(same >= 0.99, `the headline at ${t} s is the same in both exports (SSIM ${same})`);
    const all = ssimAt(saveAs, t, again, t);
    assert.ok(all >= 0.99, `the frame at ${t} s is the same in both exports (SSIM ${all})`);
  }
  const drawn = ssimAt(saveAs, 1, clip, 1, { cropA: crop, cropB: [192, 389, 1536, 302] });
  assert.ok(drawn < 0.95, `the headline is in the export (SSIM against the bare clip ${drawn})`);
  assert.deepEqual(app!.errors, []);
  await quit();
  step("reopened and exported the same");

  // 7. The repo's plugins/ is as it was; nothing left the machine.
  assert.deepEqual(snapshot(resolve("plugins")), repoPlugins, "the repo's plugins/ is unchanged");
  assert.deepEqual(
    rendererRequests.filter((u) => !isLocalUrl(u)),
    [],
    "the renderer only talked to this machine",
  );
  assert.deepEqual(remoteSockets, [], "no process of the app had a connection off this machine");
  console.log(`  renderer requests: ${rendererRequests.length} (all local); socket samples clean`);
}
