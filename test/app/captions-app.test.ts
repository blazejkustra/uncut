// Phase 6 chunk 5 (D82) on the packaged app (background window), through the UI only. A generated
// 6 s talk is on the main track; its transcript is a fake one in the analysis cache (no whisper).
// - the Transcript tab's "Make captions" (mode and look in its popover) makes captions as one edit;
// - they show on the timeline as a caption track (one block per card) and in the preview at the
//   right frames (nothing between cards);
// - the Inspector fixes a word and switches to word by word (the speaking word accented);
// - a cut by text moves the captions with the speech (the cut words go); ⌘Z / ⇧⌘Z; History labels;
// - the preview vs a Standard export on a captioned frame (SSIM ≥ 0.97).
// Screenshots: test-output/captions-{panel,line,word}.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Item, Project } from "../../packages/core/src/index.ts";
import { fingerprint, writeCached } from "../../apps/server/src/analysis/analysis.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

// Words on round frames at 30 fps (as in test/core/text-cut.test.ts): w1 "um" is a hesitation.
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
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);

const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const captions = (): Item | undefined => onDisk().tracks.flatMap((t) => t.items).find((i) => i.type === "captions");
const mainOf = () => onDisk().tracks.find((t) => t.role === "main")!.items.map((i) => [i.id, i.in, i.duration]);
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) => page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r, { timeout: 30000 }, n);
const meta = async (key: Parameters<Page["keyboard"]["press"]>[0], shift = false) => {
  await page.keyboard.down("Meta");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
};
const historyLabels = () => {
  const db = new DatabaseSync(join(dir, "history.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT label FROM revisions WHERE kind = 'edit' ORDER BY revision").all() as Array<{ label: string }>).map((r) => r.label);
  } finally {
    db.close();
  }
};
async function tab(which: "timeline" | "transcript") {
  // The Transcript is a rail tab next to the timeline (U11).
  await page.click(which === "timeline" ? "[data-testid=bottom-timeline]" : "[data-testid=rail-transcript]");
  await page.waitForSelector(which === "timeline" ? "[data-testid=timeline]" : "[data-testid=transcript-panel]");
}
/** The playhead to `frame` with the keyboard (⇧→ a second, → a frame), from the Timeline tab. */
async function goTo(frame: number) {
  await tab("timeline");
  await page.click("[data-testid=ruler]");
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(frame / 30); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < frame % 30; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, frame);
  await sleep(300);
}
/** What the preview's captions show now: their text and HTML ("" when none). */
const shown = () => page.evaluate(() => {
  const el = document.querySelector<HTMLElement>('.pv-text[data-item="captions-1"]');
  return { text: el?.textContent ?? "", html: el?.innerHTML ?? "" };
});
async function selectCaptions() {
  await tab("timeline");
  const b = (await (await page.$('[data-testid=timeline-item][data-item="captions-1"]'))!.boundingBox())!;
  await page.mouse.click(b.x + 6, b.y + b.height / 2);
  await page.waitForSelector('[data-testid=inspector-item][data-item="captions-1"] [data-testid=captions-editor]');
}
const cardsOnTimeline = () => page.$$eval("[data-testid=caption-card]", (els) => els.map((e) => [Number((e as HTMLElement).dataset.from), Number((e as HTMLElement).dataset.to), e.textContent]));
const ssim = (a: string, b: string) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
};

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-captions-app-")));
  mkdirSync(join(root, "out"));
  const talk = join(root, "Talk.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x203040:size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", talk]);
  const project: Project = {
    format: "uncut/0",
    name: "Captions",
    canvas: { width: 1280, height: 720, fps: 30 },
    textLooks: 1,
    media: [{ id: "m-talk", kind: "video", name: "Talk.mp4", path: talk, probe: { frames: 180, fps: 30, width: 640, height: 360, hasAudio: true } }],
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 180 }] }],
  };
  dir = writeProject(root, "Captions", project);
  await writeCached(dir, await fingerprint(talk), "transcript", TRANSCRIPT);
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("captions: Make captions in the Transcript tab, timeline and preview, fix a word, word by word, a cut moves them, undo/redo, history, preview = export", { skip, timeout: 360000 }, async () => {
  const saveAs = join(root, "out", "Captions.mp4");
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]), UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts") } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });

  // Make captions from the Transcript tab: the popover offers the modes and the looks.
  await tab("transcript");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=tx-word]").length === 8, { timeout: 15000 });
  const r0 = await revision();
  await page.click("[data-testid=make-captions]");
  await page.waitForSelector("[data-testid=captions-menu]");
  assert.deepEqual(await page.$$eval("[data-testid^=captions-mode-]", (els) => els.map((e) => e.textContent)), ["Line by line", "Word by word", "One word at a time"]);
  assert.equal(await page.$eval("[data-testid=captions-look]", (el) => (el as HTMLSelectElement).value), "text.caption");
  await page.screenshot({ path: out("captions-panel.png") });
  await page.click("[data-testid=captions-make]");
  await waitRevision(r0 + 1);
  const made = captions()!;
  assert.deepEqual([made.id, made.source, made.mode, made.words!.length, made.start, made.duration], ["captions-1", "m-talk", "line", 8, 0, 180]);
  assert.equal(onDisk().tracks[0]!.name, "Captions");
  await page.waitForSelector('[data-testid=inspector-item][data-item="captions-1"] [data-testid=captions-editor]');

  // On the timeline: one block per card, where the words are.
  await tab("timeline");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=caption-card]").length === 2);
  assert.deepEqual(await cardsOnTimeline(), [[15, 99, "Hello um this is a test."], [120, 159, "Second part."]]);

  // In the preview at the right frames, nothing between the cards.
  for (const [f, text] of [[14, ""], [15, "Hello um this is a test."], [98, "Hello um this is a test."], [99, ""], [110, ""], [130, "Second part."]] as const) {
    await goTo(f);
    assert.equal((await shown()).text, text, `frame ${f}`);
  }
  await goTo(50);
  await selectCaptions();
  await page.screenshot({ path: out("captions-line.png") });

  // Fix "Second" in the Inspector (the card under the playhead), then word by word.
  await goTo(130);
  await selectCaptions();
  await page.waitForSelector('[data-testid=cap-word][data-index="6"]');
  const r1 = await revision();
  const input = (await page.$('[data-testid=cap-word][data-index="6"]'))!;
  await input.click({ clickCount: 3 });
  await page.keyboard.type("Argent");
  await page.keyboard.press("Enter");
  await waitRevision(r1 + 1);
  assert.deepEqual(captions()!.edits, [{ word: 6, text: "Argent" }]);
  await page.waitForFunction(() => document.querySelector('.pv-text[data-item="captions-1"]')?.textContent === "Argent part.");
  await page.click("[data-testid=cap-mode-word]");
  await waitRevision(r1 + 2);
  assert.equal(captions()!.mode, "word");
  await page.waitForFunction(() => document.querySelector('.pv-text[data-item="captions-1"] .accent')?.textContent === "Argent");
  await page.screenshot({ path: out("captions-word.png") });

  // Hide "um" (an empty fix) and show it again from the struck-out word in the card editor.
  await goTo(40);
  await selectCaptions();
  const r1b = await revision();
  const um = (await page.$('[data-testid=cap-word][data-index="1"]'))!;
  await um.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  await waitRevision(r1b + 1);
  assert.deepEqual(captions()!.edits, [{ word: 1, text: "" }, { word: 6, text: "Argent" }]);
  await page.waitForFunction(() => !document.querySelector('.pv-text[data-item="captions-1"]')?.textContent?.includes("um"));
  assert.equal(await page.$$eval('[data-testid=cap-restore][data-index="1"]', (els) => els.length), 2, "struck out in the card and in Hidden words");
  await page.click('[data-testid=cap-card] [data-testid=cap-restore][data-index="1"]');
  await waitRevision(r1b + 2);
  assert.deepEqual(captions()!.edits, [{ word: 6, text: "Argent" }]);

  // A cut by text: "this is a test." (w2–w5) goes, frames 50–90 (as in the Transcript test). The
  // captions follow: the cut words are gone, "Argent part." now starts at 80.
  await tab("transcript");
  await page.click("[data-testid=tx-word][data-index='2']");
  await page.keyboard.down("Shift");
  await page.click("[data-testid=tx-word][data-index='5']");
  await page.keyboard.up("Shift");
  const r2 = await revision();
  await page.keyboard.press("Backspace");
  await waitRevision(r2 + 1);
  assert.deepEqual(mainOf(), [["clip-1", 0, 50], ["clip-2", 90, 90]]);
  await tab("timeline");
  await page.waitForFunction(() => document.querySelector("[data-testid=caption-card]")?.textContent === "Hello um");
  assert.deepEqual(await cardsOnTimeline(), [[15, 54, "Hello um"], [80, 119, "Argent part."]]);
  await goTo(85);
  assert.equal((await shown()).html.includes('<span class="accent">Argent</span>'), true, "Argent speaks at 85");
  await goTo(100);
  assert.equal((await shown()).text, "Argent part.");
  assert.match((await shown()).html, /<span class="accent">part\.<\/span>/);

  // ⌘Z: the cut goes, the captions are back where they were; ⇧⌘Z: cut again.
  await meta("z");
  await waitRevision(r2 + 2);
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=caption-card]").length === 2 && document.querySelector("[data-testid=caption-card]")?.textContent === "Hello um this is a test.");
  assert.deepEqual(await cardsOnTimeline(), [[15, 99, "Hello um this is a test."], [120, 159, "Argent part."]]);
  await meta("z", true);
  await waitRevision(r2 + 3);
  await page.waitForFunction(() => document.querySelector("[data-testid=caption-card]")?.textContent === "Hello um");
  assert.deepEqual(mainOf(), [["clip-1", 0, 50], ["clip-2", 90, 90]]);

  const labels = historyLabels();
  console.log(`  history: ${labels.join(" | ")}`);
  assert.deepEqual(labels, ["Make captions", 'Fix caption word "Argent"', "Captions word by word", 'Hide caption word "um"', 'Restore caption word "um"', 'Cut "this is a test." (1.3 s)']);

  // The preview vs a Standard export, on "Argent" speaking (frame 85) and on "Hello um" (frame 30).
  await page.keyboard.press("Escape");
  const shots = new Map<number, string>();
  for (const f of [30, 85]) {
    await goTo(f);
    await page.keyboard.press("Escape");
    await sleep(200);
    const path = out(`captions-preview-${f}.png`);
    await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
    shots.set(f, path);
  }
  await meta("e");
  await page.waitForSelector("[data-testid=export-form]");
  await page.click("[data-testid=quality-standard]");
  await page.click("[data-testid=loudness-off]");
  await page.click("[data-testid=export-change]");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Captions.mp4");
  await page.click("[data-testid=export-start]");
  await page.waitForSelector("[data-testid=export-job]");
  let phase = "";
  for (let i = 0; i < 1800 && phase !== "done" && phase !== "failed"; i++) {
    phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
    await sleep(100);
  }
  assert.equal(phase, "done", await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? ""));
  for (const f of [30, 85]) {
    const exported = out(`captions-export-app-${f}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${f})`, "-frames:v", "1", "-update", "1", exported]);
    const score = ssim(shots.get(f)!, exported);
    console.log(`  frame ${f}: export vs preview SSIM ${score.toFixed(4)}`);
    assert.ok(score >= 0.97, `frame ${f}: SSIM ${score}`);
  }
  assert.deepEqual(app.errors, []);
});
