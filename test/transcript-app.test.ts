// Phase 5 chunk 5 (D32, D69) on the packaged app, in the background: the Transcript tab of the
// bottom panel. A generated 6 s talk goes on the main track; its transcript is a fake one written
// into the analysis cache (no whisper runs). The tab shows the words (the filler and the long pause
// marked); clicking a word moves the playhead there; a ⇧-click selection + ⌫ cuts exactly the
// planned frames as one edit and ⌘Z restores it; Remove pauses cuts the pauses ≥ 0.5 s; the
// Timeline tab then shows the pieces; a clip of an untranscribed media, with whisper.cpp missing,
// points to Setup. Screenshots: test-output/transcript-selected.png and
// test-output/transcript-pauses.png, test-output/transcript-no-whisper.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { fingerprint, writeCached } from "../apps/server/src/analysis.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp } from "./helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const which = (name: string) => {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};
const FFMPEG = which("ffmpeg");
const FFPROBE = which("ffprobe");
const skip = !existsSync(APP) ? `packaged app not built: run pnpm dist to create ${APP}` : !FFMPEG || !FFPROBE ? "needs ffmpeg" : false;

// Words on round frames at 30 fps (as in test/text-cut.test.ts): w1 "um" is a hesitation, a 1 s pause after w5.
const WORDS = [
  { text: "Hello", start: 0.5, end: 1.0, p: 0.9 },
  { text: "um", start: 1.2, end: 1.5, p: 0.8 },
  { text: "this", start: 1.6, end: 2.0, p: 0.9 },
  { text: "is", start: 2.1, end: 2.3, p: 0.9 },
  { text: "a", start: 2.4, end: 2.5, p: 0.9 },
  { text: "test.", start: 2.6, end: 3.0, p: 0.9 },
  { text: "Second", start: 4.0, end: 4.5, p: 0.9 },
  { text: "part.", start: 4.6, end: 5.0, p: 0.9 },
];
const TRANSCRIPT = { hasAudio: true, seconds: 6, language: "en", requestedLanguage: "auto", model: "base", segments: [{ start: 0.5, end: 5, text: "Hello um this is a test. Second part.", words: [0, 8] }], words: WORDS };

let root = "";
let shimDir = "";
let app: LaunchedApp | undefined;
const waitFor = (page: Page, selector: string, timeout = 20000) => page.waitForSelector(selector, { timeout });
const ff = (...args: Array<string>) => execFileSync(FFMPEG!, ["-v", "error", "-y", ...args]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The main track as saved in project.json: [id, in, duration] per clip. */
const savedMain = (dir: string) => {
  const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  return project.tracks.find((t: any) => t.role === "main").items.map((i: any) => [i.id, i.in, i.duration]);
};
async function untilSaved(dir: string, expected: unknown, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const now = savedMain(dir);
    try {
      return assert.deepEqual(now, expected);
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    await sleep(100);
  }
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-transcript-app-")));
  mkdirSync(join(root, "projects"));
  for (const name of ["Talk", "Other"]) ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", `sine=frequency=${name === "Talk" ? 300 : 520}:sample_rate=48000`, "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(root, `${name}.mp4`));
  // PATH: ffmpeg and ffprobe only, so whisper.cpp is missing (the panel's Set up state).
  shimDir = join(root, "bin");
  mkdirSync(shimDir);
  symlinkSync(FFMPEG!, join(shimDir, "ffmpeg"));
  symlinkSync(FFPROBE!, join(shimDir, "ffprobe"));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("Transcript tab: words in edit order, click to seek, select + ⌫ cuts as one edit, ⌘Z restores, Remove pauses", { skip, timeout: 180000 }, async () => {
  app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_SHELL_ENV: "off", PATH: `${shimDir}:/usr/bin:/bin`, UNCUT_TEST_DIALOG: JSON.stringify([join(root, "projects"), [join(root, "Talk.mp4")], [join(root, "Other.mp4")]]) },
  });
  const { page } = app;
  await waitFor(page, "[data-testid=welcome]");
  await page.click("[data-testid=new-project]");
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction((dir: string) => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title === dir, {}, join(root, "projects"));
  await page.click("[data-testid=create]");
  await waitFor(page, "[data-testid=media-empty]");
  await page.click("[data-testid=import]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=media-tile]").length === 1, { timeout: 60000 });
  const dir = await page.$eval("[data-testid=project-dir]", (el) => (el as HTMLElement).title);
  await page.$eval("[data-testid=media-tile][data-id=m-talk] [data-testid=add-to-timeline]", (el) => (el as HTMLElement).click());
  await waitFor(page, "[data-testid=timeline-item][data-duration='180']");
  await untilSaved(dir, [["clip-1", 0, 180]]);
  await writeCached(dir, await fingerprint(join(root, "Talk.mp4")), "transcript", TRANSCRIPT);

  // The Transcript tab: the words, the hesitation and the long pause marked.
  await page.click("[data-testid=bottom-transcript]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=tx-word]").length === 8, { timeout: 15000 });
  const texts = await page.$$eval("[data-testid=tx-word]", (els) => els.map((el) => el.textContent));
  assert.deepEqual(texts, ["Hello", "um", "this", "is", "a", "test.", "Second", "part."]);
  assert.equal(await page.$eval("[data-testid=tx-word][data-index='1']", (el) => (el as HTMLElement).dataset.filler), "hesitation");
  assert.deepEqual(await page.$$eval("[data-testid=tx-pause]", (els) => els.map((el) => (el as HTMLElement).dataset.seconds)), ["1.00"], "only gaps of 0.3 s or more are marked");
  assert.equal(await page.$eval("[data-testid=remove-pauses]", (el) => (el as HTMLElement).dataset.count), "3");
  assert.equal(await page.$eval("[data-testid=remove-fillers]", (el) => (el as HTMLElement).dataset.count), "1");

  // Click a word: the playhead goes to it and it's marked as the current word.
  await page.click("[data-testid=tx-word][data-index='6']");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=tx-word][data-index='6']")?.dataset.current === "true");
  assert.equal(await page.$eval("[data-testid=tx-word][data-index='6']", (el) => (el as HTMLElement).dataset.start), "120");

  // Select "this is a test." (w2–w5) with a click and a ⇧-click, then ⌫: frames 48–90 go (42), one edit.
  await page.click("[data-testid=tx-word][data-index='2']");
  await page.keyboard.down("Shift");
  await page.click("[data-testid=tx-word][data-index='5']");
  await page.keyboard.up("Shift");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=tx-word].sel").length === 4);
  assert.match(await page.$eval("[data-testid=tx-status]", (el) => el.textContent ?? ""), /^4 words selected/);
  await page.screenshot({ path: "test-output/transcript-selected.png" });
  const revision = await page.$eval("[data-testid=saved]", (el) => (el as HTMLElement).title);
  await page.keyboard.press("Backspace");
  await untilSaved(dir, [["clip-1", 0, 48], ["clip-2", 90, 90]]);
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=tx-word]").length === 4);
  assert.deepEqual(await page.$$eval("[data-testid=tx-word]", (els) => els.map((el) => el.textContent)), ["Hello", "um", "Second", "part."]);
  assert.equal(await page.$$eval("[data-testid=tx-word].sel", (els) => els.length), 0, "the selection goes with the words");
  const rev = (title: string) => Number(/revision (\d+)/.exec(title)![1]);
  assert.equal(rev(await page.$eval("[data-testid=saved]", (el) => (el as HTMLElement).title)), rev(revision) + 1, "one edit");

  // ⌘Z: one step back to the whole clip and all the words.
  await page.keyboard.down("Meta");
  await page.keyboard.press("z");
  await page.keyboard.up("Meta");
  await untilSaved(dir, [["clip-1", 0, 180]]);
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=tx-word]").length === 8);

  // Remove pauses (≥ 0.5 s): the lead-in, the gap after "test." and the tail (13 + 26 + 28 frames).
  await page.click("[data-testid=remove-pauses]");
  await untilSaved(dir, [["clip-1", 13, 79], ["clip-2", 118, 34]]);
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=remove-pauses]")?.dataset.count === "0");
  assert.equal(await page.$$eval("[data-testid=tx-word]", (els) => els.length), 8, "every word stays");
  assert.equal(await page.$$eval("[data-testid=tx-block]", (els) => els.length), 2, "one block per clip");
  await page.screenshot({ path: "test-output/transcript-pauses.png" });

  // The Timeline tab shows the two pieces, back to back.
  await page.click("[data-testid=bottom-timeline]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=timeline-item]").length === 2);
  assert.deepEqual(await page.$$eval("[data-testid=timeline-item]", (els) => els.map((el) => [(el as HTMLElement).dataset.start, (el as HTMLElement).dataset.duration])), [["0", "79"], ["79", "34"]]);

  // A clip whose media has no transcript, with whisper.cpp missing: its block points to Setup.
  await page.click("[data-testid=import-plus]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=media-tile]").length === 2, { timeout: 60000 });
  await page.$eval("[data-testid=media-tile][data-id=m-other] [data-testid=add-to-timeline]", (el) => (el as HTMLElement).click());
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=timeline-item]").length === 3);
  await page.click("[data-testid=bottom-transcript]");
  // (Other.mp4's sound differs from Talk.mp4's: the same content would share the cached transcript.)
  await waitFor(page, "[data-testid=tx-block][data-media=m-other] [data-testid=tx-no-whisper]");
  assert.equal(await page.$$eval("[data-testid=tx-word]", (els) => els.length), 8, "the talk's words are still there");
  await page.screenshot({ path: "test-output/transcript-no-whisper.png" });
  assert.deepEqual(app.errors, []);
});
