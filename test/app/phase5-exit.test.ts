// Phase 5 exit check: "the agent can cut a long video from its transcript and pick the clean drone
// take". The packaged app (background window), its real MCP server, and the scripted stand-in for
// claude (helpers/fake-claude.ts; never the real one). The footage is made here
// (helpers/phase5-fixture.ts): a minute of real speech from macOS `say` (13 sentences, an "um", an
// "uh", long pauses) over bars, and three 6 s takes of one pan: smooth, jittered, blurred.
// - Turn 1 imports the folder. Turn 2, from the Agent tab: the talk on the main track,
//   media_analyze (loudness, transcript), transcript_read, then (decided from what it read, through
//   the fake's `await` step) one transcript_edit cutting the fillers, the pauses ≥ 0.5 s and one
//   sentence, media_rank of the takes, and timeline_edit appending the top one; ui_show shows it.
// - The main track is the talk's pieces (cut where D69's rules say, within 2 frames; no piece under
//   3 frames) followed by the smooth take; media_rank put smooth > jittered > blurred.
// - A Draft export: its length is the timeline's, and the frames at the appended take match the
//   smooth take better than the jittered or blurred one (SSIM against the source files).
// - Quit, start again, reopen from Recents: ⌘Z takes turn 2 back (one step, D7) to exactly the
//   project before it, ⇧⌘Z brings it back; then Undo turn restores the pre-turn project exactly.
// Transcription: a transcript written into the analysis cache (whisper-cli isn't even on PATH), so
// the test is deterministic. UNCUT_WHISPER_IT=1 runs real whisper-cli instead, with the tiny.en
// model from test-output/whisper-models (as test/analysis/whisper-it.test.ts gets it), and checks the cut
// more loosely (whisper's word times and fillers vary).
// Screenshots: test-output/phase5-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { fingerprint, writeCached } from "../../apps/server/src/analysis/analysis.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { CUT_SENTENCE, expectedCuts, FPS, makeFixture, talkTranscript, type Fixture } from "../helpers/phase5-fixture.ts";

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
const WHISPER_IT = process.env.UNCUT_WHISPER_IT === "1";
const WHISPER = WHISPER_IT ? which("whisper-cli") : undefined;
const TINY = resolve(process.env.UNCUT_WHISPER_IT_MODELS ?? "test-output/whisper-models", "ggml-tiny.en.bin");
const skip = !existsSync(APP)
  ? `packaged app not built: run pnpm dist to create ${APP}`
  : !FFMPEG || !FFPROBE || !which("say")
    ? "needs ffmpeg, ffprobe and macOS say"
    : WHISPER_IT && !WHISPER
      ? "UNCUT_WHISPER_IT=1 needs whisper-cli (brew install whisper-cpp)"
      : WHISPER_IT && !existsSync(TINY)
        ? `UNCUT_WHISPER_IT=1 needs ${TINY} (run UNCUT_WHISPER_IT=1 node --test test/analysis/whisper-it.test.ts once to download it)`
        : false;

type Content = Array<{ type: string; text?: string }>;
type Result = { tool: string; result: { isError?: boolean; content: Content } };
let root = "";
let fixture: Fixture;
let shimDir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);
const plan = () => join(root, "plan.json");
const promptLog = () => join(root, "prompts.jsonl");
const resultLog = () => join(root, "results.jsonl");
const turns: Array<unknown> = [];
const nextTurn = (steps: Array<unknown>) => {
  turns.push(steps);
  writeFileSync(plan(), JSON.stringify(turns));
};
/** The fake's { await } files, written or not: after() ends any turn still waiting on one. */
const awaited = new Set<string>();
/** Steps for the fake's { await } (written whole, so it never reads half a file). */
const decide = (path: string, steps: Array<unknown>) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(steps));
  renameSync(`${path}.tmp`, path);
};
const results = (): Array<Result> => (existsSync(resultLog()) ? readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const textOf = (r: Result["result"]) => r.content.find((c) => c.type === "text")!.text!;
const jsonOf = (r: Result["result"]) => JSON.parse(textOf(r));
/** The n-th result of `tool` from the start of the log (waits for it). */
async function resultOf(tool: string, nth = 0, timeout = 180000) {
  const end = Date.now() + timeout;
  for (;;) {
    const r = results().filter((x) => x.tool === tool)[nth];
    if (r) {
      assert.ok(!r.result.isError, `${tool}: ${textOf(r.result)}`);
      return jsonOf(r.result);
    }
    if (Date.now() > end) throw new Error(`no ${tool} result after ${timeout} ms`);
    await sleep(100);
  }
}
const waitFor = (selector: string, timeout = 20000) => page.waitForSelector(selector, { timeout });
let dir = "";
const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const mainOf = (project: any) => project.tracks.find((t: any) => t.role === "main").items as Array<{ id: string; media: string; in?: number; duration: number }>;
const until = async (check: () => boolean, what: string, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
const same = (a: unknown, b: unknown) => {
  try {
    assert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
};
const cmdZ = async (shift = false) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down("Meta");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press("KeyZ");
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
};
async function send(prompt: string) {
  const before = await page.$$eval("[data-testid=agent-turn]", (els) => els.length);
  await page.click("[data-testid=agent-input]");
  await page.keyboard.type(prompt);
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll("[data-testid=agent-turn]").length === n + 1, {}, before);
  return before + 1;
}
/** The n-th turn card (1-based). */
const turnCard = async (n: number) => (await page.$$("[data-testid=agent-turn]"))[n - 1]!;
const turnDone = (n: number, timeout: number) =>
  page.waitForFunction((k) => ["done", "failed", "cancelled"].includes(document.querySelectorAll<HTMLElement>("[data-testid=agent-turn]")[k - 1]?.dataset.status ?? ""), { timeout }, n);
const turnStatus = async (n: number) => (await turnCard(n)).evaluate((el) => [(el as HTMLElement).dataset.status, (el as HTMLElement).innerText] as const);
const ssim = (a: string, b: string) => {
  const r = spawnSync(FFMPEG!, ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=640:360,format=gray[a];[1]scale=640:360,format=gray[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
};
const frameOf = (file: string, n: number, png: string) => {
  execFileSync(FFMPEG!, ["-v", "error", "-y", "-i", file, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-update", "1", png]);
  return png;
};
const norm = (w: string) => w.toLowerCase().replace(/[^a-z']/g, "");

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-phase5-exit-")));
  mkdirSync(join(root, "projects"));
  mkdirSync(join(root, "out"));
  const t0 = Date.now();
  fixture = makeFixture(join(root, "Footage"), { ffmpeg: FFMPEG!, ffprobe: FFPROBE! });
  console.log(`footage made in ${((Date.now() - t0) / 1000).toFixed(1)} s: talk ${fixture.seconds.toFixed(2)} s`);
  // PATH: ffmpeg, ffprobe and node (the fake claude's runtime); whisper-cli only in the whisper run.
  shimDir = join(root, "bin");
  mkdirSync(shimDir);
  symlinkSync(FFMPEG!, join(shimDir, "ffmpeg"));
  symlinkSync(FFPROBE!, join(shimDir, "ffprobe"));
  symlinkSync(process.execPath, join(shimDir, "node"));
  if (WHISPER) symlinkSync(WHISPER, join(shimDir, "whisper-cli"));
  const data = join(root, "data");
  mkdirSync(join(data, "models"), { recursive: true });
  writeFileSync(join(data, "settings.json"), JSON.stringify(WHISPER_IT ? { onboarded: true, whisperModel: "tiny.en" } : { onboarded: true }));
  if (WHISPER_IT) symlinkSync(TINY, join(data, "models", "ggml-tiny.en.bin"));
  writeFileSync(promptLog(), "");
  writeFileSync(resultLog(), "");
});
after(async () => {
  // A failed test leaves the fake waiting at an { await }: end its turn instead of a 5-minute wait.
  for (const path of awaited) if (!existsSync(path)) decide(path, [{ fail: "aborted" }]);
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const env = (dialogs: Array<string> = []) => ({
  UNCUT_DATA_DIR: join(root, "data"),
  UNCUT_SHELL_ENV: "off",
  PATH: `${shimDir}:/usr/bin:/bin`,
  UNCUT_CLAUDE: FAKE,
  FAKE_PLAN: plan(),
  FAKE_PROMPT_LOG: promptLog(),
  FAKE_RESULT_LOG: resultLog(),
  UNCUT_TEST_DIALOG: JSON.stringify(dialogs),
});

test("phase 5 exit: the agent cuts a talk from its transcript and appends the clean take; export, undo, reopen", { skip, timeout: 900000 }, async () => {
  const started = Date.now();
  try {
    await exitCheck();
  } catch (error) {
    const panel = await page?.$eval("[data-testid=agent-panel]", (e) => (e as HTMLElement).innerText).catch(() => "(no agent panel)");
    await page?.screenshot({ path: out("phase5-failure.png") }).catch(() => {});
    const log = results().map((r) => `${r.tool}: ${textOf(r.result).slice(0, 400)}`).join("\n");
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- agent tab ---\n${panel}\n--- tool results ---\n${log}\n--- app output ---\n${app?.output().slice(-4000)}` });
  }
  console.log(`exit check took ${((Date.now() - started) / 1000).toFixed(1)} s (plus making the footage)`);
});

async function exitCheck() {
  const saveAs = join(root, "out", "Talk cut.mp4");
  app = await launchApp({ command: APP, env: env([join(root, "projects"), saveAs]) });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=new-project]");
  await waitFor("[data-testid=new-project-form]");
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction((d: string) => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title === d, {}, join(root, "projects"));
  await page.click("[data-testid=create]");
  await waitFor("[data-testid=editor]");
  dir = await page.$eval("[data-testid=project-title]", (el) => (el as HTMLElement).title);
  const transcript = talkTranscript(fixture);
  if (!WHISPER_IT) await writeCached(dir, await fingerprint(fixture.talk), "transcript", transcript);

  // Turn 1: import the folder (the talk and the three takes, referenced in place).
  await page.click("[data-testid=tab-agent]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"), { timeout: 20000 });
  nextTurn([{ tool: "media_import", args: { path: fixture.folder } }, { text: "Imported the talk and three takes." }]);
  const t1 = await send(`Import ${fixture.folder}`);
  await turnDone(t1, 120000);
  assert.equal((await turnStatus(t1))[0], "done", (await turnStatus(t1))[1]);
  const imported = await resultOf("media_import");
  const byId = new Map<string, { frames: number; path: string }>(imported.imported.map((m: any) => [m.id, m]));
  assert.deepEqual([...byId.keys()].sort(), ["m-blurred", "m-jittered", "m-smooth", "m-talk"]);
  const talkFrames = byId.get("m-talk")!.frames;
  assert.ok(Math.abs(talkFrames - fixture.seconds * FPS) <= 1, `talk ${talkFrames} frames for ${fixture.seconds} s`);
  const p1 = onDisk();
  assert.deepEqual(mainOf(p1), []);

  // Turn 2: the cut and the take. What it cuts and which take it appends are decided from the
  // tool results, as claude would (the fake waits at each { await }).
  const cutSteps = join(root, "cut.json");
  const appendSteps = join(root, "append.json");
  awaited.add(cutSteps).add(appendSteps);
  nextTurn([
    { tool: "project_read" },
    { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Put the talk on the timeline", ops: [{ op: "insert_item", track: "main", item: { id: "talk-1", type: "clip", media: "m-talk", in: 0, duration: talkFrames } }] } },
    { tool: "media_analyze", args: { media: "m-talk", analyzers: ["loudness", "transcript"] } },
    { tool: "transcript_read", args: { media: "m-talk", format: "words" } },
    { await: cutSteps },
  ]);
  const prompt = "Cut the talk tight from its transcript: remove fillers, long pauses and the sentence about deleting a take. Then append the cleanest drone take.";
  const t2 = await send(prompt);

  const analyzed = await resultOf("media_analyze");
  assert.equal(analyzed.transcript?.state, "done", JSON.stringify(analyzed));
  assert.equal(analyzed.loudness?.state, "done", JSON.stringify(analyzed));
  const read = await resultOf("transcript_read");
  assert.equal(read.next, undefined, "all the words in one page");
  const words = read.list as Array<{ i: number; text: string; start: number; end: number; filler?: string }>;
  const target = CUT_SENTENCE.split(" ").map(norm);
  const from = words.findIndex((_, k) => target.slice(0, 3).every((t, j) => norm(words[k + j]?.text ?? "") === t));
  assert.ok(from >= 0, `"${CUT_SENTENCE}" in: ${words.map((w) => w.text).join(" ")}`);
  const to = words.findIndex((w, k) => k > from && norm(w.text) === "problem");
  assert.ok(to > from);
  if (!WHISPER_IT) {
    assert.equal(words.length, transcript.words.length);
    assert.deepEqual(read.fillers.map((f: any) => [f.text, f.kind]), [["um", "hesitation"], ["uh", "hesitation"]]);
    assert.equal(to - from + 1, target.length);
  }
  decide(cutSteps, [
    { tool: "transcript_edit", args: { media: "m-talk", remove: [{ from: `w${words[from]!.i}`, to: `w${words[to]!.i}` }], fillers: true, pauses: { min: 0.5 } } },
    { tool: "media_rank", args: { media: ["m-smooth", "m-jittered", "m-blurred"] } },
    { await: appendSteps },
  ]);

  const cut = await resultOf("transcript_edit");
  assert.equal(cut.applied, true, JSON.stringify(cut));
  const rank = await resultOf("media_rank");
  const ranked = rank.ranked.map((r: any) => r.media);
  console.log(`media_rank: ${rank.ranked.map((r: any) => `${r.media} ${r.cleanScore?.toFixed?.(3)}`).join(" > ")}`);
  assert.deepEqual(ranked, ["m-smooth", "m-jittered", "m-blurred"], JSON.stringify(rank.ranked));
  const top = ranked[0] as string;
  const cutMain = mainOf(onDisk());
  const takeStart = cutMain.reduce((s, i) => s + i.duration, 0);
  decide(appendSteps, [
    { tool: "project_read" },
    { tool: "timeline_edit", args: { baseRevision: "$rev", summary: "Append the cleanest take", ops: [{ op: "insert_item", track: "main", item: { id: "take-1", type: "clip", media: top, in: 0, duration: byId.get(top)!.frames } }] } },
    { tool: "ui_show", args: { frame: takeStart, select: ["take-1"] } },
    { text: `Cut the talk to ${(takeStart / FPS).toFixed(1)} s and appended ${top}, the steadiest and sharpest take.` },
  ]);
  await turnDone(t2, 300000);
  assert.equal((await turnStatus(t2))[0], "done", (await turnStatus(t2))[1]);
  const p2 = onDisk();

  // The main track: the talk's pieces, then the smooth take.
  const main = mainOf(p2);
  const talk = main.slice(0, -1);
  assert.deepEqual([main.at(-1)!.id, main.at(-1)!.media, main.at(-1)!.in ?? 0, main.at(-1)!.duration], ["take-1", "m-smooth", 0, byId.get("m-smooth")!.frames]);
  assert.ok(talk.every((i) => i.media === "m-talk"), JSON.stringify(main));
  assert.ok(main.every((i) => i.duration >= 3), `no sliver under 3 frames: ${JSON.stringify(main.map((i) => i.duration))}`);
  for (let k = 1; k < talk.length; k++) assert.ok((talk[k]!.in ?? 0) > (talk[k - 1]!.in ?? 0) + talk[k - 1]!.duration, "pieces in order with a cut between each");
  const kept = talk.reduce((s, i) => s + i.duration, 0);
  const removed = talkFrames - kept;
  const cuts = expectedCuts(fixture, { frames: talkFrames });
  const expectedRemoved = cuts.reduce((s, [a, b]) => s + b - a, 0);
  const sentence = fixture.layout.find((p) => p.text === CUT_SENTENCE)!;
  console.log(`talk ${talkFrames} → ${kept} frames: removed ${removed} (${(removed / FPS).toFixed(2)} s; from the layout ${expectedRemoved}) in ${talk.length} pieces; the sentence alone is ${((sentence.end - sentence.start) * FPS).toFixed(1)} frames`);
  console.log(`  pieces [in, duration]: ${JSON.stringify(talk.map((i) => [i.in ?? 0, i.duration]))}`);
  console.log(`  expected cuts [from, to): ${JSON.stringify(cuts)}`);
  if (!WHISPER_IT) {
    // Every cut where D69's rules put it from the layout, within 3 frames at each end, the total within
    // 2 frames per cut. Pauses snap to the loudness analyzer's silences (D69), whose threshold sits
    // above the −50 dB the fixture trims speech at, so a silence can start a frame or so into a word's
    // quiet tail, and its edges move with ffmpeg's frame of analysis; measured ≤ 1 frame per edge.
    const keptExpected: Array<[number, number]> = [];
    let at = 0;
    for (const [a, b] of cuts) {
      if (a > at) keptExpected.push([at, a]);
      at = b;
    }
    if (at < talkFrames) keptExpected.push([at, talkFrames]);
    assert.equal(talk.length, keptExpected.length, `pieces: ${JSON.stringify(talk.map((i) => [i.in, i.duration]))} vs ${JSON.stringify(keptExpected)}`);
    let worst = 0;
    talk.forEach((piece, k) => {
      const [a, b] = keptExpected[k]!;
      const pin = piece.in ?? 0;
      worst = Math.max(worst, Math.abs(pin - a), Math.abs(pin + piece.duration - b));
      assert.ok(Math.abs(pin - a) <= 3 && Math.abs(pin + piece.duration - b) <= 3, `piece ${k}: [${pin}, ${pin + piece.duration}) vs [${a}, ${b})`);
    });
    console.log(`  largest edge difference from the layout: ${worst} frame(s)`);
    assert.ok(Math.abs(removed - expectedRemoved) <= 2 * cuts.length, `removed ${removed} vs ${expectedRemoved}`);
    assert.equal(cut.framesRemoved, removed);
  } else {
    // Real whisper: its word times and fillers vary, so: the sentence and the long pauses went.
    const longPauses = fixture.layout.filter((p) => p.kind === "silence" && p.end - p.start >= 0.5).reduce((s, p) => s + (p.end - p.start) * FPS, 0);
    assert.ok(removed >= ((sentence.end - sentence.start) * FPS + longPauses) * 0.7 && removed <= expectedRemoved * 1.4, `removed ${removed}, expected about ${expectedRemoved}`);
  }

  // The turn: three edits as one, Undo turn available, ui_show's pill (D235) jumps to the take and selects it.
  await page.waitForSelector(`[data-testid=agent-change][data-from="${takeStart}"] [data-testid=agent-change-jump]`, { timeout: 10000 });
  await page.click("[data-testid=agent-change-jump]");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")?.dataset.frame) === f, { timeout: 10000 }, takeStart);
  await page.waitForFunction(() => document.querySelector("[data-testid=timeline-item][data-item=take-1]")?.classList.contains("selected"), { timeout: 10000 });
  const card = await turnCard(t2);
  const steps = await card.$$eval("[data-testid=agent-step]", (els) => els.map((e) => e.textContent));
  console.log(`turn 2 steps: ${steps.join(" | ")}`);
  assert.equal(steps.length, 9);
  const edits = await card.$eval("[data-testid=agent-edits]", (el) => el.textContent ?? "");
  assert.match(edits, /3 edits/);
  // A cut of words and the pause after them gives the whole cut's length, not the pause's (D72).
  assert.match(edits, /Cut "(uh+,? )?I almost deleted that take before I noticed [^"]*" and (a pause|\d+ pauses) \(\d+\.\d s in all\)/i);
  await page.screenshot({ path: out("phase5-agent.png") });

  // The Transcript tab after the cut: the cut words are gone, one block per piece.
  await page.click("[data-testid=rail-transcript]");
  await page.waitForFunction((n) => document.querySelectorAll("[data-testid=tx-block]").length === n, { timeout: 20000 }, talk.length);
  const wordsLeft = WHISPER_IT ? 1 : transcript.words.length - 2 - target.length;
  await page.waitForFunction((n) => document.querySelectorAll("[data-testid=tx-word]").length >= n, { timeout: 20000 }, wordsLeft);
  const shown = await page.$$eval("[data-testid=tx-word]", (els) => els.map((el) => el.textContent ?? ""));
  assert.ok(!shown.map(norm).includes("almost"), "the cut sentence isn't in the edit");
  if (!WHISPER_IT) assert.equal(shown.length, wordsLeft);
  assert.equal(await page.$eval("[data-testid=remove-pauses]", (el) => (el as HTMLElement).dataset.count), "0", "no pause ≥ 0.5 s left");
  await page.screenshot({ path: out("phase5-transcript.png") });
  await page.click("[data-testid=bottom-timeline]");
  await page.waitForFunction((n) => document.querySelectorAll("[data-testid=timeline-item]").length === n, {}, main.length);
  await page.screenshot({ path: out("phase5-timeline.png") });
  await page.click("[data-testid=tab-history]");
  await waitFor("[data-testid=history-panel]");
  await page.screenshot({ path: out("phase5-history.png") });

  // A Draft export (1280×720): as long as the timeline; at the appended take, the smooth take's frames.
  const total = main.reduce((s, i) => s + i.duration, 0);
  await page.click("[data-testid=export-button]");
  await waitFor("[data-testid=export-form]");
  await page.click("[data-testid=quality-draft]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Talk cut.mp4");
  const e0 = Date.now();
  await page.click("[data-testid=export-start]");
  await page.waitForFunction(() => ["done", "failed"].includes(document.querySelector<HTMLElement>("[data-testid=export-job]")?.dataset.phase ?? ""), { timeout: 300000 });
  assert.match(await page.$eval("[data-testid=export-status]", (el) => el.textContent ?? ""), /Saved/);
  console.log(`export (${total} frames, Draft): ${((Date.now() - e0) / 1000).toFixed(1)} s`);
  await page.keyboard.press("Escape");
  const probe = JSON.parse(execFileSync(FFPROBE!, ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=width,height,nb_read_packets:format=duration", "-of", "json", saveAs], { encoding: "utf8" }));
  const stream = probe.streams[0];
  assert.deepEqual([stream.width, stream.height], [1280, 720]);
  assert.equal(Number(stream.nb_read_packets), total, "one frame per timeline frame");
  assert.ok(Math.abs(Number(probe.format.duration) - total / FPS) < 0.1, `duration ${probe.format.duration} vs ${total / FPS}`);
  // Frames well into the take (at frame 0 the jitter is 0, so the jittered take matches there too).
  const shift = (n: number) => Math.hypot(3 * Math.sin(n * 2.7) + 2 * Math.sin(n * 5.3), 2 * Math.sin(n * 3.1) + 2 * Math.sin(n * 7.7));
  const probes = Array.from({ length: 170 }, (_, k) => k + 5).filter((n) => shift(n) >= 3).slice(0, 3);
  for (const n of probes) {
    const exported = frameOf(saveAs, takeStart + n, out(`phase5-export-take-${n}.png`));
    const scores = Object.fromEntries((["smooth", "jittered", "blurred"] as const).map((k) => [k, ssim(exported, frameOf(fixture.takes[k], n, join(root, `${k}-${n}.png`)))]));
    console.log(`  exported frame ${takeStart + n} (take frame ${n}, jitter ${shift(n).toFixed(1)} px) SSIM: ${JSON.stringify(scores)}`);
    // The test pattern's flat areas keep every SSIM high, so compare how unlike each one is: the
    // smooth take at least 3× closer than either other take (measured ~5×).
    assert.ok(scores.smooth! > 0.97 && 1 - Math.max(scores.jittered!, scores.blurred!) >= 3 * (1 - scores.smooth!), JSON.stringify(scores));
  }
  const before = frameOf(saveAs, takeStart - 3, out("phase5-export-talk.png"));
  assert.ok(ssim(before, join(root, `smooth-${probes[0]}.png`)) < 0.6, "the frames before the take are the talk's");

  // Quit, start again, reopen from Recents: ⌘Z takes turn 2 back as one step, ⇧⌘Z redoes it.
  await app.close();
  app = undefined;
  app = await launchApp({ command: APP, env: env() });
  page = app.page;
  await waitFor("[data-testid=recent]");
  await page.click("[data-testid=recent]");
  await waitFor("[data-testid=editor]");
  assert.deepEqual(onDisk(), p2, "reopening changes nothing");
  await page.waitForFunction(() => !(document.querySelector("[data-testid=undo]") as HTMLButtonElement).disabled, { timeout: 10000 });
  await cmdZ();
  await until(() => same(onDisk(), p1), "⌘Z after reopening to restore the project before turn 2");
  await page.waitForFunction(() => !(document.querySelector("[data-testid=redo]") as HTMLButtonElement | null)?.disabled, { timeout: 10000 }).catch(() => {});
  await cmdZ(true);
  await until(() => same(onDisk(), p2), "⇧⌘Z to bring turn 2 back");
  await page.click("[data-testid=tab-history]");
  await waitFor("[data-testid=history-panel]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=history-entry]").length >= 2, { timeout: 10000 });
  await page.screenshot({ path: out("phase5-history-reopened.png") });

  // Undo turn on turn 2, after the reopen: exactly the project before the turn.
  await page.click("[data-testid=tab-agent]");
  await page.waitForFunction((n) => document.querySelectorAll("[data-testid=agent-turn]").length >= n, { timeout: 10000 }, t2);
  const undo = (await (await turnCard(t2)).$("[data-testid=agent-undo-turn]"))!;
  assert.ok(undo, "turn 2 has Undo turn after reopening");
  await page.waitForFunction((b) => !(b as HTMLButtonElement).disabled, { timeout: 10000 }, undo).catch(() => {});
  const [disabled, title] = await undo.evaluate((b) => [(b as HTMLButtonElement).disabled, (b as HTMLButtonElement).title] as const);
  assert.equal(disabled, false, `Undo turn after reopening: ${title}`);
  await undo.click();
  await until(() => same(onDisk(), p1), "Undo turn to restore the project before turn 2");
  assert.deepEqual(onDisk(), p1);
  await page.screenshot({ path: out("phase5-undo-turn.png") });
  assert.deepEqual(app.errors, []);
}
