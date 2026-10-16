// Phase 6 exit check (D93): "the next Argent promo is made in Uncut". The packaged app (background
// window, muted), its real MCP server and the scripted stand-in for claude (helpers/fake-claude.ts;
// never the real one) rebuild the promo "Haiku 4.5 vs Haiku 5.5 on the same Argent test" from the
// reference's own files (helpers/phase6-fixture.ts), and the export is compared with the reference mp4.
// - Turn 1 (Agent tab): media_import of the recordings, the sky, a dark logo and the
//   music (the studio library's cozy-3, by path), modules_list, four timeline_edits (title card over the sky; the race: two device
//   frames whose footage holds its last frame, two agent logs, the wordmark, task line, footnote and a
//   callout; the compare table; the end card wiping in, the music, a −16 LUFS target), project_check
//   (three texts under 28 px), ui_show.
// - By hand: the title's letter spacing in the Style tab, the
//   music's fader in the Mixer.
// - Turn 2: the checks fixed (the task line and the footnotes at 28 px, the long one moved up), project_check: 0 (K1: no Checks tab).
// - Export (Standard, Quieter −16 LUFS) vs the reference: length, format, the scene at a dozen times,
//   SSIM per scene, the phone screens against their source recordings, the held last frames, loudness.
// - Quit, start again, reopen: ⌘Z takes turn 2 back, ⇧⌘Z redoes it, Undo turn restores the project before it.
// Skipped (with the reason) when the reference isn't on this machine: UNCUT_ARGENT_REF=<dir>,
// UNCUT_ARGENT_LOGO=<svg>. The reference is never written to (its files' size and mtime are compared).
// Outputs: test-output/phase6-exit-{sheet.jpg,compare.jpg,editor.png}.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { projectChecks, type Project } from "../../packages/core/src/index.ts";
import { levelY } from "../../apps/web/src/audio/sound.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import {
  buildTurn,
  compareSheet,
  contactSheet,
  END_URL,
  fixTurn,
  IDS,
  loudness,
  makeBrandFolder,
  probe,
  REF,
  REF_SCREENS,
  referenceElements,
  referenceMissing,
  sceneOf,
  signature,
  ssimAt,
  stampReference,
  TOTAL,
} from "../helpers/phase6-fixture.ts";

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
const skip = !existsSync(APP) ? `packaged app not built: run pnpm dist to create ${APP}` : !FFMPEG || !FFPROBE ? "needs ffmpeg and ffprobe" : referenceMissing();

type Content = Array<{ type: string; text?: string }>;
type Result = { tool: string; result: { isError?: boolean; content: Content } };
let root = "";
let shimDir = "";
let brand: { logo: string };
let stamped: ReturnType<typeof stampReference> = [];
let app: LaunchedApp | undefined;
let page: Page;
let dir = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);
const plan = () => join(root, "plan.json");
const resultLog = () => join(root, "results.jsonl");
const turns: Array<unknown> = [];
const nextTurn = (steps: Array<unknown>) => {
  turns.push(steps);
  writeFileSync(plan(), JSON.stringify(turns));
};
const results = (): Array<Result> => (existsSync(resultLog()) ? readFileSync(resultLog(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const textOf = (r: Result["result"]) => r.content.find((c) => c.type === "text")!.text!;
const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const itemOf = (p: Project, id: string) => p.tracks.flatMap((t) => t.items).find((i) => i.id === id);
const waitFor = (selector: string, timeout = 20000) => page.waitForSelector(selector, { timeout });
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
async function send(prompt: string) {
  await page.click("[data-testid=tab-agent]");
  await waitFor("[data-testid=agent-panel]");
  const before = await page.$$eval("[data-testid=agent-turn]", (els) => els.length);
  await page.click("[data-testid=agent-input]");
  await page.keyboard.type(prompt);
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll("[data-testid=agent-turn]").length === n + 1, {}, before);
  return before + 1;
}
const turnCard = async (n: number) => (await page.$$("[data-testid=agent-turn]"))[n - 1]!;
/** Waits for turn n to end. The turn's ui_show may switch the side panel to Checks, so the Agent tab is brought back while waiting. */
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

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-phase6-exit-")));
  mkdirSync(join(root, "projects"));
  mkdirSync(join(root, "out"));
  stamped = stampReference();
  brand = makeBrandFolder(join(root, "Brand"));
  shimDir = join(root, "bin");
  mkdirSync(shimDir);
  symlinkSync(FFMPEG!, join(shimDir, "ffmpeg"));
  symlinkSync(FFPROBE!, join(shimDir, "ffprobe"));
  symlinkSync(process.execPath, join(shimDir, "node"));
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "data", "settings.json"), JSON.stringify({ onboarded: true }));
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(resultLog(), "");
});
after(async () => {
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
  FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
  FAKE_RESULT_LOG: resultLog(),
  UNCUT_TEST_DIALOG: JSON.stringify(dialogs),
});

test("phase 6 exit: the Argent promo made in Uncut by the agent and by hand, exported and compared with the reference; undo, reopen", { skip, timeout: 900000 }, async () => {
  const started = Date.now();
  try {
    await exitCheck();
  } catch (error) {
    const panel = await page?.$eval("[data-testid=agent-panel]", (e) => (e as HTMLElement).innerText).catch(() => "(no agent panel)");
    await page?.screenshot({ path: out("phase6-exit-failure.png") }).catch(() => {});
    const log = results().map((r) => `${r.tool}${r.result.isError ? " (error)" : ""}: ${textOf(r.result).slice(0, 400)}`).join("\n");
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- agent tab ---\n${panel}\n--- tool results ---\n${log}\n--- app output ---\n${app?.output().slice(-4000)}` });
  }
  console.log(`phase 6 exit check took ${((Date.now() - started) / 1000).toFixed(1)} s`);
});

let t0 = Date.now();
/** Where the run is (printed, with the time since the start), so a failure says what it was waiting for. */
const step = (what: string) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)} s] ${what}`);

async function exitCheck() {
  t0 = Date.now();
  const saveAs = join(root, "out", "Argent promo.mp4");
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
  assert.deepEqual(onDisk().canvas, { width: 1920, height: 1080, fps: 30 });

  // Turn 1: the whole promo, scene by scene.
  step("project created");
  await page.click("[data-testid=tab-agent]");
  await page.waitForFunction(() => !document.querySelector("[data-testid=agent-input]")!.hasAttribute("disabled"), { timeout: 20000 });
  nextTurn(buildTurn(brand));
  const t1 = await send("Make the Haiku 4.5 vs Haiku 5.5 Argent promo from the reference's files");
  await turnDone(t1, 240000);
  assert.equal((await turnStatus(t1))[0], "done", (await turnStatus(t1))[1]);
  step("turn 1 done");
  const r1 = results();
  for (const r of r1) assert.ok(!r.result.isError, `${r.tool}: ${textOf(r.result)}`);
  const imported = JSON.parse(textOf(r1.find((r) => r.tool === "media_import")!.result));
  assert.deepEqual(imported.imported.map((m: { id: string }) => m.id), [IDS.sky, IDS.h45, IDS.h55, IDS.logo, IDS.music]);
  assert.deepEqual(imported.imported.slice(0, 3).map((m: { path: string }) => m.path), [REF.sky, REF.h45, REF.h55], "the recordings are referenced in place");
  const check1 = JSON.parse(textOf(r1.filter((r) => r.tool === "project_check").at(-1)!.result));
  console.log(`turn 1 project_check: ${check1.checks.map((c: { rule: string; items?: Array<string> }) => `${c.rule}(${c.items?.join(",") ?? ""})`).join(" ")}`);
  assert.deepEqual(check1.checks.filter((c: { severity: string }) => c.severity === "warn").map((c: { rule: string; items: Array<string> }) => `${c.rule}:${c.items.join()}`).sort(), ["small-text:footnote", "small-text:sum-note", "small-text:task"]);
  const p1 = onDisk();
  // What the agent built: the footage held (not looped), the logs and table from the reference's data, the domain swapped.
  const ref = referenceElements();
  for (const [clip, inS] of [["screen-45", ref.get("phone-opus")!.props!.in], ["screen-55", ref.get("phone-haiku")!.props!.in]] as const) {
    const c = itemOf(p1, clip)!;
    assert.equal(c.hold, true, `${clip} holds its last frame`);
    assert.equal(c.loop, undefined, `${clip} doesn't loop`);
    assert.equal(c.in, Math.round(inS * 30));
  }
  assert.equal((itemOf(p1, "log-45")!.props!.lines as Array<unknown>).length, ref.get("log-opus")!.props!.lines.length);
  assert.deepEqual(itemOf(p1, "table")!.props!.rows, ref.get("sum-table")!.props!.rows);
  assert.equal(itemOf(p1, "end-url")!.text, END_URL);
  assert.ok(!JSON.stringify(p1).includes("argent.example.com"), "the reference's URL is nowhere in the project");
  assert.equal(p1.master?.loudness?.targetLufs, -16);
  // K1 (D121): no Checks tab; the three warnings are what core projectChecks finds on disk too.
  assert.equal(projectChecks(onDisk()).filter((c) => c.severity === "warn").length, 3);
  assert.equal(await page.$("[data-testid=tab-checks]"), null);

  step("turn 1 checked");
  // By hand 1: the title's letter spacing in the Style tab (−0.015 em, the reference's tracking).
  await page.click("[data-testid=bottom-timeline]");
  const tb = (await (await page.$('[data-testid=timeline-item][data-item="title"]'))!.boundingBox())!;
  await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await page.click("[data-testid=tab-inspector]");
  await waitFor('[data-testid=inspector-item][data-item="title"] [data-testid=text-editor]');
  const tracking = (await page.$("[data-testid=insp-tracking]"))!;
  await tracking.click({ clickCount: 3 });
  await page.keyboard.type("-0.015");
  await page.keyboard.press("Enter");
  await until(() => itemOf(onDisk(), "title")!.style!.tracking === -0.015, "the title's letter spacing from the Style tab");

  step("Style tab done");
  // By hand 2: the music's fader in the Mixer, down to about −2 dB (the reference's volume 0.8).
  await page.click("[data-testid=bottom-mixer]");
  await waitFor("[data-testid=mixer-panel]");
  const fader = '[data-testid=mixer-strip][data-track="audio"] [data-testid=mixer-fader]';
  const h = await page.$eval(fader, (el) => (el as HTMLElement).clientHeight);
  const thumb = (await (await page.$(`${fader} [data-testid=mixer-fader-thumb]`))!.boundingBox())!;
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2 + (levelY(-2) - levelY(0)) * h, { steps: 8 });
  await page.mouse.up();
  await until(() => typeof onDisk().tracks.find((t) => t.id === "audio")!.mixer?.gainDb === "number", "the Mixer fader");
  const musicDb = onDisk().tracks.find((t) => t.id === "audio")!.mixer!.gainDb!;
  assert.ok(Math.abs(musicDb + 2) <= 0.75, `music fader at ${musicDb} dB`);
  await page.click("[data-testid=bottom-timeline]");
  const pUi = onDisk();

  step("Mixer done");
  // Turn 2: the checks left (the task line and the footnotes; the Checks tab's Fix is gone, K1), from what project_check says.
  const left = projectChecks(pUi).filter((c) => c.severity === "warn");
  assert.deepEqual(left.map((c) => c.key).sort(), ["small-text:footnote", "small-text:sum-note", "small-text:task"]);
  nextTurn(fixTurn(left.map((c) => ({ rule: c.id, items: [...(c.itemIds ?? [])], fix: c.fix }))));
  const before2 = results().length;
  const t2 = await send("Fix the remaining checks");
  await turnDone(t2, 120000);
  assert.equal((await turnStatus(t2))[0], "done", (await turnStatus(t2))[1]);
  const r2 = results().slice(before2);
  for (const r of r2) assert.ok(!r.result.isError, `${r.tool}: ${textOf(r.result)}`);
  const check2 = JSON.parse(textOf(r2.filter((r) => r.tool === "project_check").at(-1)!.result));
  assert.equal(check2.warnings, 0, JSON.stringify(check2.checks));
  const p2 = onDisk();
  assert.equal(projectChecks(p2).filter((c) => c.severity === "warn").length, 0);
  assert.deepEqual([itemOf(p2, "task")!.style!.size, itemOf(p2, "footnote")!.style!.size, itemOf(p2, "sum-note")!.style!.size], [28, 28, 28]);
  // D235: the agent's ui_show is a pill; its click jumps there.
  await page.waitForSelector('[data-testid=agent-change][data-from="840"] [data-testid=agent-change-jump]', { timeout: 10000 });
  await page.click("[data-testid=agent-change-jump]");
  await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")?.dataset.frame) === 840, { timeout: 10000 });
  // The race on screen for the editor's screenshot.
  await page.click("[data-testid=tab-agent]");
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")?.dataset.frame) === 360, { timeout: 10000 });
  await sleep(1500);
  await page.screenshot({ path: out("phase6-exit-editor.png") });
  // The preview past the recordings' ends (frame 720, 24 s): both paused on their last frame, shown.
  await page.keyboard.down("Shift");
  for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")?.dataset.frame) === 720, { timeout: 10000 });
  await sleep(1000);
  const held = await page.$$eval("video[data-item^=screen-]", (els) => els.map((e) => { const v = e as HTMLVideoElement; return { id: v.dataset.item, t: v.currentTime, d: v.duration, paused: v.paused, opacity: Number(v.style.opacity), ready: v.readyState }; }));
  console.log(`  preview at frame 720: ${JSON.stringify(held)}`);
  for (const id of ["screen-45", "screen-55"]) {
    const v = held.find((h) => h.id === id)!;
    assert.ok(v && v.opacity === 1 && v.ready >= 2 && v.d - v.t < 0.1, `${id} shows its last frame in the preview: ${JSON.stringify(v)}`);
  }
  // Playing into the held stretch (from 20 s, frame 600): the recordings end and stay paused on their last frame, never restarting.
  await page.keyboard.down("Shift");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.up("Shift");
  await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")?.dataset.frame) === 600, { timeout: 10000 });
  await page.keyboard.press("Space");
  const seen: Array<string> = [];
  for (let i = 0; i < 12; i++) {
    await sleep(250);
    seen.push(JSON.stringify(await page.$$eval("video[data-item^=screen-]", (els) => els.map((e) => [(e as HTMLVideoElement).dataset.item, Math.round((e as HTMLVideoElement).currentTime * 30)]))));
  }
  await page.keyboard.press("Space");
  const playedTo = await page.$eval("[data-testid=preview-frame]", (el) => Number((el as HTMLElement).dataset.frame));
  const after = await page.$$eval("video[data-item^=screen-]", (els) => els.map((e) => { const v = e as HTMLVideoElement; return { id: v.dataset.item, t: v.currentTime, d: v.duration, paused: v.paused }; }));
  console.log(`  played 600 → ${playedTo}: source frames ${seen.join(" ")}; then ${JSON.stringify(after)}`);
  assert.ok(playedTo >= 680, `the preview played past both recordings' ends (to ${playedTo})`);
  for (const v of after) assert.ok(v.paused && v.d - v.t < 0.1, `${v.id} sits on its last frame after playing into the held stretch: ${JSON.stringify(v)}`);
  // Never back to the start: every sample is at or past the source frame it had at 600.
  for (const sample of seen) for (const [, f] of JSON.parse(sample) as Array<[string, number]>) assert.ok(f >= 600, `a held recording restarted: ${sample}`);

  step("turn 2 done");
  // Export: Standard (1920×1080), Quieter (−16 LUFS, the project's target).
  await page.click("[data-testid=export-button]");
  await waitFor("[data-testid=export-form]");
  await page.click("[data-testid=quality-standard]");
  await page.click("[data-testid=loudness-quiet]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Argent promo.mp4");
  const e0 = Date.now();
  await page.click("[data-testid=export-start]");
  await page.waitForFunction(() => ["done", "failed"].includes(document.querySelector<HTMLElement>("[data-testid=export-job]")?.dataset.phase ?? ""), { timeout: 400000 });
  assert.match(await page.$eval("[data-testid=export-status]", (el) => el.textContent ?? ""), /Saved/);
  console.log(`export (Standard, ${TOTAL} frames): ${((Date.now() - e0) / 1000).toFixed(1)} s`);
  await page.keyboard.press("Escape");
  step("exported");
  compare(saveAs, p2);
  step("compared");

  // Quit, start again, reopen from Recents: ⌘Z takes turn 2 back, ⇧⌘Z redoes it; Undo turn too.
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
  await until(() => same(onDisk(), pUi), "⌘Z after reopening to restore the project before turn 2");
  await cmdZ(true);
  await until(() => same(onDisk(), p2), "⇧⌘Z to bring turn 2 back");
  await page.click("[data-testid=tab-agent]");
  await page.waitForFunction((n) => document.querySelectorAll("[data-testid=agent-turn]").length >= n, { timeout: 10000 }, t2);
  const undo = (await (await turnCard(t2)).$("[data-testid=agent-undo-turn]"))!;
  assert.ok(undo, "turn 2 has Undo turn after reopening");
  await page.waitForFunction((b) => !(b as HTMLButtonElement).disabled, { timeout: 10000 }, undo).catch(() => {});
  await undo.click();
  await until(() => same(onDisk(), pUi), "Undo turn to restore the project before turn 2");
  assert.deepEqual(app.errors, []);
  assert.deepEqual(stampReference(), stamped, "the reference folder is unchanged");
}

/** The export against the reference video (D93's measured thresholds). */
function compare(file: string, project: Project) {
  const p = probe(file);
  const r = probe(REF.out);
  console.log(`export: ${p.width}×${p.height} ${p.codec} ${p.fps}, ${p.frames} frames, ${p.duration.toFixed(3)} s (reference ${r.duration.toFixed(3)} s), audio ${p.audio}`);
  assert.deepEqual([p.width, p.height, p.fps, p.codec, p.audio], [1920, 1080, "30/1", "h264", "aac"]);
  assert.equal(p.frames, TOTAL);
  assert.ok(Math.abs(p.duration - r.duration) <= 0.2, `duration ${p.duration} vs the reference's ${r.duration}`);

  // The scene at each time, in the reference and the export: same structure.
  const times: Array<[number, string]> = [[1.5, "title"], [5, "race"], [12, "race"], [20, "race"], [24, "race"], [27.5, "table"], [30, "table"], [33, "table"], [37, "end"], [38.5, "end"]];
  for (const [t, want] of times) {
    const [a, b] = [sceneOf(signature(REF.out, t)), sceneOf(signature(file, t))];
    const s480 = ssimAt(file, t, REF.out, t);
    console.log(`  ${t.toFixed(1)} s: reference ${a}, export ${b}, SSIM (480×270 gray) ${s480.toFixed(3)}`);
    assert.equal(a, want, `the reference at ${t} s`);
    assert.equal(b, want, `the export at ${t} s`);
    // Measured: title 0.52 (the reference blurs the race under its card; Uncut dims it), race 0.88–0.91, table 0.97, end 0.96.
    const min = { title: 0.4, race: 0.82, table: 0.93, end: 0.9 }[want]!;
    assert.ok(s480 >= min, `SSIM at ${t} s: ${s480} < ${min}`);
  }

  // The phone screens: each crop (inset past the rounded corners) against its source recording at that moment.
  const screens = ["screen-45", "screen-55"].map((id) => itemOf(project, id)!);
  const inset = (x: number, y: number, w: number, h: number): [number, number, number, number] => [x + 10, y + 40, w - 20, h - 80];
  const sources = [REF.h45, REF.h55];
  const lengths = [project.media.find((m) => m.id === IDS.h45)!.probe!.frames!, project.media.find((m) => m.id === IDS.h55)!.probe!.frames!];
  const srcCrop = (s: { w: number; h: number }): [number, number, number, number] => [Math.round((10 * 510) / s.w), Math.round((40 * 1108) / s.h), 510 - Math.round((20 * 510) / s.w), 1108 - Math.round((80 * 1108) / s.h)];
  for (const t of [5, 12, 18, 23.5]) {
    screens.forEach((s, i) => {
      const tr = s.transform as { x: number; y: number; w: number; h: number };
      const src = Math.min(lengths[i]! - 1, (s.in ?? 0) + t * 30) / 30;
      const vsSource = ssimAt(file, t, sources[i]!, src, { w: 160, h: 320, cropA: inset(tr.x, tr.y, tr.w, tr.h), cropB: srcCrop(tr) });
      const vsRef = ssimAt(file, t, REF.out, t, { w: 160, h: 320, cropA: inset(tr.x, tr.y, tr.w, tr.h), cropB: inset(...REF_SCREENS[i]!) });
      console.log(`  ${s.id} at ${t} s: SSIM vs its recording ${vsSource.toFixed(3)}, vs the reference's screen ${vsRef.toFixed(3)}`);
      // Measured 0.94–0.98 vs the source (the reference's own screens score 0.79–0.92), 0.89–0.95 vs the reference.
      assert.ok(vsSource >= 0.9, `${s.id} at ${t} s vs its recording: ${vsSource}`);
      assert.ok(vsRef >= 0.84, `${s.id} at ${t} s vs the reference: ${vsRef}`);
    });
  }
  // Held: both recordings have ended by 22.5 s; their last frames stay on screen to the race's end.
  for (const s of screens) {
    const tr = s.transform as { x: number; y: number; w: number; h: number };
    const held = ssimAt(file, 22.6, file, 25.0, { w: 160, h: 320, cropA: inset(tr.x, tr.y, tr.w, tr.h), cropB: inset(tr.x, tr.y, tr.w, tr.h) });
    console.log(`  ${s.id} held: SSIM 22.6 s vs 25.0 s ${held.toFixed(4)}`);
    assert.ok(held >= 0.99, `${s.id} holds its last frame: ${held}`);
  }

  const l = loudness(file);
  console.log(`  loudness ${l.lufs} LUFS, true peak ${l.truePeak} dBTP (reference: ${JSON.stringify(loudness(REF.out))})`);
  assert.ok(Math.abs(l.lufs + 16) <= 1, `loudness ${l.lufs}`);
  assert.ok(l.truePeak <= -1, `true peak ${l.truePeak}`);

  contactSheet(file, out("phase6-exit-sheet.jpg"));
  compareSheet(REF.out, file, [1.5, 5, 11, 20, 24, 27.5, 33, 38.5], out("phase6-exit-compare.jpg"));
}
