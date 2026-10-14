// Phase 7 exit check (D101): capture, generators and a local model as plugins, on the packaged app
// (background window, muted) with the scripted claude (helpers/fake-claude.ts), the fake argent
// (helpers/fake-argent.ts via ARGENT_BIN: never the real CLI), the fake whisper-cli (through the
// bundled Whisper plugin, D100) and a stub OpenAI images API on this machine. Never the real claude,
// argent, whisper or a provider.
// - The Capture tab records the simulator (one take, a user edit).
// - Settings › Keys: an OpenAI key saved (UNCUT_TEST_KEYS=standin: no Keychain item).
// - One agent turn: argent_record replays a saved flow, generate_media writes an SVG title card
//   (free) and a GPT Image picture through the stub (cents, so no approval card), media_import of a
//   voiceover; then one timeline_edit places them all, transcript_read gets the voice's words through
//   the Whisper plugin, project_check has 0 warnings.
// - Export, contact sheet; quit, start again, Recents: ⌘Z / ⇧⌘Z and Undo turn restore exact projects.
// - The fake argent's log never shows a server stop, stop-all or boot; no connection left the machine
//   (the renderer's requests, the app's process tree sampled with lsof, the stub's log, the model file).
// Outputs: test-output/phase7-exit-editor.png, test-output/phase7-exit-sheet.jpg.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { projectChecks, type Project } from "../../packages/core/src/index.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { probe } from "../helpers/phase6-fixture.ts";
import { DEVICE, FLOW, FLOW_YAML, makeFiles, PICTURE_PROMPT, placeSteps, recordSteps } from "../helpers/phase7-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const FAKE_ARGENT = resolve("test/helpers/fake-argent/argent");
const FAKE_WHISPER = resolve("test/helpers/fake-whisper.ts");
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
const OPENAI_KEY = "sk-test-phase7-0123456789abcdef";
const MODEL_FILE = "ggml-large-v3-turbo-q5_0.bin";
const MODEL_BYTES = "a stand-in for the speech model, never downloaded";

type Content = Array<{ type: string; text?: string }>;
type Result = { tool: string; result: { isError?: boolean; content: Content } };
let root = "";
let shimDir = "";
let files: ReturnType<typeof makeFiles>;
let app: LaunchedApp | undefined;
let page: Page;
let dir = "";
let stub: Server | undefined;
let stubPort = 0;
const stubRequests: Array<{ method: string; url: string; host: string; auth: boolean }> = [];
const rendererRequests: Array<string> = [];
const remoteSockets: Array<string> = [];
let sampling = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);
const plan = () => join(root, "plan.json");
const awaitPath = () => join(root, "place.json");
const resultLog = () => join(root, "results.jsonl");
const argentLog = () => join(root, "argent.jsonl");
const whisperLog = () => join(root, "whisper.jsonl");
const results = (): Array<Result> => (existsSync(resultLog()) ? readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
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
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const cmdZ = async (shift = false) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down("Meta");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press("KeyZ");
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
};
const turnCard = async (n: number) => (await page.$$("[data-testid=agent-turn]"))[n - 1]!;
async function turnDone(n: number, timeout: number) {
  const end = Date.now() + timeout;
  for (;;) {
    const status = await page.evaluate((k) => (document.querySelector("[data-testid=agent-panel]") ? (document.querySelectorAll<HTMLElement>("[data-testid=agent-turn]")[k - 1]?.dataset.status ?? "") : "hidden"), n);
    if (["done", "failed", "cancelled"].includes(status)) return;
    if (status === "hidden") await page.click("[data-testid=tab-agent]");
    if (Date.now() > end) throw new Error(`turn ${n} didn't end within ${timeout / 1000} s (status ${status})`);
    await sleep(250);
  }
}
const turnStatus = async (n: number) => (await turnCard(n)).evaluate((el) => [(el as HTMLElement).dataset.status, (el as HTMLElement).innerText] as const);

/** Loopback, or not a network address at all. */
const isLocalUrl = (u: string) => {
  try {
    const url = new URL(u);
    if (!/^(https?|wss?):$/.test(url.protocol)) return true;
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return true;
  }
};

/** Every process the app started (its whole tree), now. */
const treeOf = (rootPid: number): Array<number> => {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number) as [number, number]);
  const pids = [rootPid];
  for (let i = 0; i < pids.length; i++) for (const [pid, ppid] of rows) if (ppid === pids[i] && !pids.includes(pid)) pids.push(pid);
  return pids;
};
/** Samples the app's sockets every 300 ms: any connection to an address that isn't this machine is recorded. */
async function sampleSockets(rootPid: number) {
  sampling = true;
  while (sampling) {
    const pids = treeOf(rootPid);
    const listing = await new Promise<string>((done) => execFile("lsof", ["-nP", "-a", "-i", "-p", pids.join(",")], { encoding: "utf8" }, (_e, stdout) => done(stdout ?? "")));
    for (const line of listing.split("\n").slice(1)) {
      const m = /->(\S+)/.exec(line);
      if (!m) continue;
      const remote = m[1]!;
      if (!/^(127\.0\.0\.1|\[::1\]|localhost):/.test(remote)) remoteSockets.push(line.trim());
    }
    await sleep(300);
  }
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-phase7-exit-")));
  mkdirSync(join(root, "projects"));
  mkdirSync(join(root, "out"));
  files = makeFiles(join(root, "files"));
  shimDir = join(root, "bin");
  mkdirSync(shimDir);
  symlinkSync(FFMPEG!, join(shimDir, "ffmpeg"));
  symlinkSync(FFPROBE!, join(shimDir, "ffprobe"));
  symlinkSync(process.execPath, join(shimDir, "node"));
  writeFileSync(join(shimDir, "whisper-cli"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_WHISPER}" "$@"\n`);
  chmodSync(join(shimDir, "whisper-cli"), 0o755);
  // The speech model is already there (Setup downloaded it once): nothing is fetched.
  mkdirSync(join(root, "data", "models"), { recursive: true });
  writeFileSync(join(root, "data", "models", MODEL_FILE), MODEL_BYTES);
  writeFileSync(join(root, "data", "settings.json"), JSON.stringify({ onboarded: true }));
  for (const f of [resultLog(), argentLog(), whisperLog(), join(root, "prompts.jsonl")]) writeFileSync(f, "");
  // The stub OpenAI images API: a real PNG back for /v1/images/generations.
  const png = join(root, "files", "desk.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "gradients=s=1536x1024:c0=0x3B2A1E:c1=0xD9B27C:speed=0", "-frames:v", "1", png]);
  const pngB64 = readFileSync(png).toString("base64");
  stub = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      stubRequests.push({ method: req.method ?? "", url: req.url ?? "", host: req.headers.host ?? "", auth: req.headers.authorization === `Bearer ${OPENAI_KEY}` });
      if (req.url === "/v1/images/generations" && JSON.parse(body || "{}").prompt === PICTURE_PROMPT) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ data: [{ b64_json: pngB64 }], usage: { input_tokens: 12, output_tokens: 1584 } }));
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not stubbed" } }));
    });
  });
  await new Promise<void>((r) => stub!.listen(0, "127.0.0.1", r));
  stubPort = (stub.address() as AddressInfo).port;
});
after(async () => {
  sampling = false;
  // A turn left waiting for its second half ends at once.
  if (root && !existsSync(awaitPath())) writeFileSync(awaitPath(), JSON.stringify([{ fail: "aborted" }]));
  await app?.close();
  unlockApps();
  stub?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const env = (dialogs: Array<string> = []) => ({
  UNCUT_DATA_DIR: join(root, "data"),
  UNCUT_PLUGINS_DIR: join(root, "no-user-plugins"),
  UNCUT_SHELL_ENV: "off",
  PATH: `${shimDir}:/usr/bin:/bin`,
  UNCUT_CLAUDE: FAKE,
  FAKE_PLAN: plan(),
  FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
  FAKE_RESULT_LOG: resultLog(),
  ARGENT_BIN: FAKE_ARGENT,
  FAKE_ARGENT_NODE: process.execPath,
  FAKE_ARGENT_LOG: argentLog(),
  FAKE_WHISPER_JSON: files.whisper,
  FAKE_WHISPER_LOG: whisperLog(),
  UNCUT_TEST_KEYS: "standin",
  UNCUT_OPENAI_BASE: `http://127.0.0.1:${stubPort}`,
  UNCUT_GOOGLE_BASE: "http://127.0.0.1:9",
  UNCUT_ELEVENLABS_BASE: "http://127.0.0.1:9",
  UNCUT_TEST_DIALOG: JSON.stringify(dialogs),
});

let t0 = Date.now();
const step = (what: string) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)} s] ${what}`);

async function launch(dialogs: Array<string> = []) {
  app = await launchApp({ command: APP, env: env(dialogs) });
  page = app.page;
  page.on("request", (r) => rendererRequests.push(r.url()));
  void sampleSockets(app.proc.pid!);
}

test("phase 7 exit: a take from the Capture tab, the agent records a flow, generates a card and a keyed picture, places all, transcribes through the Whisper plugin; export, undo, reopen; nothing leaves the machine", { skip, timeout: 600000 }, async () => {
  const started = Date.now();
  try {
    await exitCheck();
  } catch (error) {
    const panel = await page?.$eval("[data-testid=agent-panel]", (e) => (e as HTMLElement).innerText).catch(() => "(no agent panel)");
    await page?.screenshot({ path: out("phase7-exit-failure.png") }).catch(() => {});
    const log = results().map((r) => `${r.tool}${r.result.isError ? " (error)" : ""}: ${textOf(r.result).slice(0, 400)}`).join("\n");
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- agent tab ---\n${panel}\n--- tool results ---\n${log}\n--- app output ---\n${app?.output().slice(-4000)}` });
  }
  console.log(`phase 7 exit check took ${((Date.now() - started) / 1000).toFixed(1)} s`);
});

async function exitCheck() {
  t0 = Date.now();
  const saveAs = join(root, "out", "Phase 7.mp4");
  await launch([join(root, "projects"), saveAs]);
  await waitForWelcome(page);
  await page.click("[data-testid=new-project]");
  await waitFor("[data-testid=new-project-form]");
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction((d: string) => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title === d, {}, join(root, "projects"));
  await page.click("[data-testid=create]");
  await waitFor("[data-testid=editor]");
  dir = await page.$eval("[data-testid=project-title]", (el) => (el as HTMLElement).title);
  mkdirSync(join(dir, "flows"), { recursive: true });
  writeFileSync(join(dir, "flows", `${FLOW}.yaml`), FLOW_YAML);
  step("project created");

  // 1. The Capture tab records the simulator.
  await page.click("[data-testid=rail-capture]");
  await waitFor("[data-testid=capture-devices]", 30000);
  const row = `[data-testid=capture-device][data-id=${DEVICE}]`;
  await page.click(`${row} [data-testid=capture-record]`);
  await waitFor(`${row} [data-testid=capture-stop]`);
  await page.waitForFunction((r) => /0:0[1-9]/.test(document.querySelector(`${r} [data-testid=capture-timer]`)?.textContent ?? ""), { timeout: 10000 }, row);
  await sleep(800);
  await page.click(`${row} [data-testid=capture-stop]`);
  await waitFor("[data-testid=capture-saved]", 30000);
  await until(() => onDisk().media.length === 1, "the Capture tab's take in the project");
  const capture = onDisk().media[0]!;
  assert.equal(capture.source?.module, "argent.capture");
  step(`Capture tab take: ${capture.name} (${capture.probe?.frames} frames)`);

  // 2. Settings › Keys: the OpenAI key (the stand-in crypter; never the Keychain).
  await page.click("[data-testid=rail-generate]");
  await waitFor("[data-testid=generator][data-id='generate.gpt-image']");
  await page.click("[data-testid=generator][data-id='generate.gpt-image']");
  await waitFor("[data-testid=generate-open-keys]");
  await page.click("[data-testid=generate-open-keys]");
  await waitFor("[data-testid=onboarding] [data-testid=key-openai][data-set=false]");
  await page.type("[data-testid=key-input-openai]", OPENAI_KEY);
  await page.click("[data-testid=key-save-openai]");
  await waitFor("[data-testid=onboarding] [data-testid=key-openai][data-set=true]");
  await page.keyboard.press("Escape");
  const keysFile = readFileSync(join(root, "data", "keys.json"), "utf8");
  assert.ok(!keysFile.includes(OPENAI_KEY), "keys.json holds only the wrapped key");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=generator][data-id='generate.gpt-image']")?.dataset.ready === "true", { timeout: 10000 });
  step("OpenAI key saved");

  // 3. The agent's turn, first half: record the flow, generate the card and the picture, import the voice.
  const p0 = onDisk();
  writeFileSync(plan(), JSON.stringify([recordSteps(files.voice, awaitPath())]));
  await page.click("[data-testid=tab-agent]");
  await waitFor("[data-testid=agent-panel]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"), { timeout: 20000 });
  await page.click("[data-testid=agent-input]");
  await page.keyboard.type("Record the demo flow, make a title card and a desk picture, and put them with my take and the voiceover");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=agent-turn]").length === 1);
  await until(() => results().some((r) => r.tool === "media_import"), "the first half of the turn", 120000);
  const first = results();
  for (const r of first) assert.ok(!r.result.isError, `${r.tool}: ${textOf(r.result)}`);
  const mid = onDisk();
  const byPath = (re: RegExp) => mid.media.find((m) => re.test(m.path))!;
  const demo = byPath(/^media\/captures\/demo take\.mp4$/);
  const card = byPath(/^media\/generated\/title card\.svg$/);
  const picture = byPath(/^media\/generated\/desk\.png$/);
  const voice = mid.media.find((m) => m.path === files.voice)!;
  assert.ok(demo && card && picture && voice, JSON.stringify(mid.media.map((m) => m.path)));
  assert.deepEqual(demo.source, { module: "argent.capture", device: DEVICE, flow: `flows/${FLOW}.yaml` });
  assert.equal((card.source as { model?: string }).model, "written by the agent");
  assert.equal(picture.source?.module, "generate.gpt-image");
  const gen = first.filter((r) => r.tool === "generate_media").map((r) => JSON.parse(textOf(r.result)));
  assert.equal(gen[0].estimatedCost, 0, "the SVG card is free");
  assert.ok(gen[1].estimatedCost > 0 && gen[1].estimatedCost < 1, `the picture is cheap (${gen[1].estimatedCost}), so no approval card`);
  writeFileSync(awaitPath(), JSON.stringify(placeSteps({ capture: capture.id, captureFrames: capture.probe!.frames!, demo: demo.id, demoFrames: demo.probe!.frames!, card: card.id, picture: picture.id, voice: voice.id })));
  await turnDone(1, 180000);
  assert.equal((await turnStatus(1))[0], "done", (await turnStatus(1))[1]);
  step("turn done");
  const r1 = results();
  for (const r of r1) assert.ok(!r.result.isError, `${r.tool}: ${textOf(r.result)}`);
  const p1 = onDisk();
  const items = p1.tracks.flatMap((t) => t.items);
  assert.deepEqual(p1.tracks.find((t) => t.role === "main")!.items.map((i) => i.media), [card.id, capture.id, demo.id, picture.id], "everything placed on main in order");
  assert.equal(items.find((i) => i.id === "voice")!.media, voice.id);

  // 4. The transcript, through the Whisper plugin: the words, and whisper started by the plugin (no UNCUT_* in its env).
  const transcript = JSON.parse(textOf(r1.find((r) => r.tool === "transcript_read")!.result));
  assert.ok(/w0 /.test(transcript.text ?? JSON.stringify(transcript)), JSON.stringify(transcript).slice(0, 400));
  assert.equal(transcript.words, 16);
  const runs = lines(whisperLog());
  assert.equal(runs.length, 1, "whisper ran once");
  assert.equal(runs[0].uncutEnv, 0, "whisper-cli was started by the plugin (plugins get none of Uncut's own variables)");
  assert.deepEqual(runs[0].env, [], "no ANTHROPIC_* handed on");

  // 5. project_check: 0 warnings.
  const check = JSON.parse(textOf(r1.filter((r) => r.tool === "project_check").at(-1)!.result));
  assert.equal(check.warnings, 0, JSON.stringify(check.checks));
  assert.equal(projectChecks(p1).filter((c) => c.severity === "warn").length, 0);
  const cardText = (await turnStatus(1))[1];
  assert.ok(!/\S[·•∙⋅*]\S|\s[·•∙⋅*]\s/.test(cardText), "no dots or stars between words on the turn card");

  // The editor, the playhead in the flow's take.
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Home");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.down("Shift");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await sleep(1200);
  await page.screenshot({ path: out("phase7-exit-editor.png") });

  // 6. Export, then a contact sheet.
  await page.click("[data-testid=export-button]");
  await waitFor("[data-testid=export-form]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Phase 7.mp4");
  await page.click("[data-testid=export-start]");
  await page.waitForFunction(() => ["done", "failed"].includes(document.querySelector<HTMLElement>("[data-testid=export-job]")?.dataset.phase ?? ""), { timeout: 300000 });
  assert.match(await text("[data-testid=export-status]"), /Saved/);
  await page.keyboard.press("Escape");
  const p = probe(saveAs);
  const frames = p1.tracks.find((t) => t.role === "main")!.items.reduce((s, i) => s + i.duration, 0);
  console.log(`export: ${p.width}×${p.height} ${p.codec} ${p.fps}, ${p.frames} frames (timeline ${frames}), audio ${p.audio}`);
  assert.equal(p.frames, frames);
  assert.equal(p.audio, "aac");
  // Two frames a second, tiled 4 wide, as many rows as it takes.
  const tiles = Math.ceil(p.duration * 2);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `fps=2,scale=480:-2,tile=4x${Math.ceil(tiles / 4)}`, "-frames:v", "1", "-update", "1", out("phase7-exit-sheet.jpg")]);
  step("exported");

  // 7. Quit, start again, Recents: ⌘Z takes the turn back, ⇧⌘Z redoes it, Undo turn restores the project before it.
  sampling = false;
  await app!.close();
  app = undefined;
  await launch();
  await waitFor("[data-testid=recent]");
  await page.click("[data-testid=recent]");
  await waitFor("[data-testid=editor]");
  assert.deepEqual(onDisk(), p1, "reopening changes nothing");
  await page.waitForFunction(() => !(document.querySelector("[data-testid=undo]") as HTMLButtonElement).disabled, { timeout: 10000 });
  await cmdZ();
  await until(() => same(onDisk(), p0), "⌘Z after reopening to restore the project before the turn");
  await cmdZ(true);
  await until(() => same(onDisk(), p1), "⇧⌘Z to bring the turn back");
  await page.click("[data-testid=tab-agent]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=agent-turn]").length >= 1, { timeout: 10000 });
  const undo = (await (await turnCard(1)).$("[data-testid=agent-undo-turn]"))!;
  assert.ok(undo, "the turn has Undo turn after reopening");
  await page.waitForFunction((b) => !(b as HTMLButtonElement).disabled, { timeout: 10000 }, undo).catch(() => {});
  await undo.click();
  await until(() => same(onDisk(), p0), "Undo turn to restore the project before the turn");
  assert.deepEqual(app!.errors, []);
  step("undo and reopen checked");
  sampling = false;
  await app!.close();
  app = undefined;

  // 8. Argent was never asked to stop its server, stop all simulators or boot anything.
  const argent = lines(argentLog());
  assert.ok(argent.length > 0);
  assert.deepEqual(argent.filter((e) => e.forbidden || /^(server|stop-all-simulator-servers|stop-simulator-server|boot-device|shutdown)$/.test(e.argv[1] ?? e.argv[0] ?? "")), []);
  assert.equal(argent.filter((e) => e.argv[1] === "screen-recording-start").length, 2, "two takes");
  assert.equal(argent.filter((e) => e.argv[0] === "flow" && e.argv[1] === "run").length, 1, "one flow replayed");

  // 9. No request left the machine.
  assert.deepEqual(stubRequests.map((r) => [r.method, r.url, r.host, r.auth]), [["POST", "/v1/images/generations", `127.0.0.1:${stubPort}`, true]], "one keyed request, to the stub");
  assert.deepEqual(rendererRequests.filter((u) => !isLocalUrl(u)), [], "the renderer only talked to this machine");
  assert.deepEqual(remoteSockets, [], "no process of the app had a connection off this machine");
  assert.equal(readFileSync(join(root, "data", "models", MODEL_FILE), "utf8"), MODEL_BYTES, "the speech model wasn't downloaded again");
  assert.deepEqual(readdirSync(join(root, "data", "models")), [MODEL_FILE], "no partial download");
  const claudeEnvs: Array<string> = lines(join(root, "prompts.jsonl")).flatMap((e) => e.env ?? []);
  assert.deepEqual(claudeEnvs.filter((k) => /^(OPENAI|GOOGLE|GEMINI|ELEVENLABS)_API_KEY$/.test(k)), [], "no generator key variable in claude's environment (D99)");
  assert.ok(!readFileSync(join(root, "prompts.jsonl"), "utf8").includes(OPENAI_KEY) && !readFileSync(resultLog(), "utf8").includes(OPENAI_KEY), "the key never reached the agent");
  console.log(`  renderer requests: ${rendererRequests.length} (all local); socket samples clean`);
}
