// Issues #40 and #41 (D215) on the packaged app (background window), through the UI only. A camera
// + microphone take (D211's placement: camera on a Camera track, mic on Voiceover, grouped) next to
// a short intro on Main, and a title on a Text track:
// - the Transcript tab lists the take as a source when its camera is selected (it reads the mic);
// - the camera's menu "Put on Main": the camera goes on Main after the intro, the mic stays on
//   Voiceover linked under it (its own in point kept), the empty Camera track goes;
// - Transcribe (the fake whisper-cli through the Whisper plugin) the take's mic from the Main view,
//   cut "um" by text: Main ripples, the mic follows as linked pieces with its offset; Make captions:
//   the cards follow (no "um"), drawn in the preview;
// - the title dragged onto the Main lane lands in the spine (no refusal), a crossfade dropped on
//   its cut; the preview vs a Standard export mid-crossfade (SSIM ≥ 0.97).
// Screenshots: test-output/issue40-source.png, issue40-transcript.png, issue40-captions.png,
// issue41-take-on-main.png, issue41-text-on-main.png, issue41-transition.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Item, Project } from "../../packages/core/src/index.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { whisperJson, type Token } from "../helpers/whisper-json.ts";
import { NO_REAL_GPU, check } from "../helpers/capabilities.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
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
const MODEL_FILE = "ggml-large-v3-turbo-q5_0.bin";

// The mic's speech (seconds of mic.m4a), as whisper.cpp's tokens.
const TOKENS: ReadonlyArray<ReadonlyArray<Token>> = [
  [
    [" Hello", 500, 1000, 0.9],
    [" um", 1200, 1500, 0.8],
    [" this", 1600, 2000, 0.9],
    [" is", 2100, 2300, 0.9],
    [" a", 2400, 2500, 0.9],
    [" test", 2600, 3000, 0.9],
    [".", 3000, 3000, 0.9],
  ],
  [
    [" Second", 4000, 4500, 0.9],
    [" part", 4600, 5000, 0.9],
    [".", 5000, 5000, 0.9],
  ],
];

let root = "";
let dir = "";
let shimDir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);
const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const itemsOf = (p: Project) => new Map(p.tracks.flatMap((t) => t.items.map((i) => [i.id, { ...i, track: t.id }] as const)));
const mainOf = () => onDisk().tracks.find((t) => t.role === "main")!.items;
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) =>
  page.waitForFunction(
    (r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) === r,
    { timeout: 30000 },
    n,
  );
const meta = async (key: Parameters<Page["keyboard"]["press"]>[0]) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key);
  await page.keyboard.up("Meta");
};
const box = async (selector: string) => {
  const b = await (await page.$(selector))?.boundingBox();
  assert.ok(b, `no box for ${selector}`);
  return b;
};
const itemSel = (id: string) => `[data-testid=timeline-item][data-item="${id}"]`;
const historyLabels = () => {
  const db = new DatabaseSync(join(dir, "history.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT label FROM revisions WHERE kind = 'edit' ORDER BY revision").all() as Array<{ label: string }>).map((r) => r.label);
  } finally {
    db.close();
  }
};
async function tab(which: "timeline" | "transcript") {
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
const txWords = () =>
  page.$$eval("[data-testid=tx-word]", (els) => els.map((e) => [Number((e as HTMLElement).dataset.index), (e.textContent ?? "").trim()] as const));
const ssim = (a: string, b: string) => {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
};

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue40-41-")));
  mkdirSync(join(root, "out"));
  shimDir = join(root, "bin");
  mkdirSync(shimDir);
  symlinkSync(FFMPEG!, join(shimDir, "ffmpeg"));
  symlinkSync(FFPROBE!, join(shimDir, "ffprobe"));
  symlinkSync(process.execPath, join(shimDir, "node"));
  writeFileSync(join(shimDir, "whisper-cli"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_WHISPER}" "$@"\n`);
  chmodSync(join(shimDir, "whisper-cli"), 0o755);
  mkdirSync(join(root, "data", "models"), { recursive: true });
  writeFileSync(join(root, "data", "models", MODEL_FILE), "a stand-in for the speech model, never downloaded");
  writeFileSync(join(root, "data", "settings.json"), JSON.stringify({ onboarded: true }));
  writeFileSync(join(root, "whisper.json"), whisperJson(TOKENS, "en"));
  writeFileSync(join(root, "whisper.jsonl"), "");
  const intro = join(root, "Intro.mp4");
  const camera = join(root, "camera.mp4");
  const mic = join(root, "mic.m4a");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x203860:size=1280x720:rate=30",
    "-t",
    "4",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    intro,
  ]);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=30",
    "-t",
    "8",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    camera,
  ]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000", "-t", "8", "-c:a", "aac", mic]);
  const project: Project = {
    format: "uncut/0",
    name: "Take",
    canvas: { width: 1280, height: 720, fps: 30 },
    textLooks: 1,
    media: [
      { id: "m-intro", kind: "video", name: "Intro.mp4", path: intro, probe: { frames: 120, fps: 30, width: 1280, height: 720, hasAudio: false } },
      { id: "m-cam", kind: "video", name: "Take camera", path: camera, probe: { frames: 240, fps: 30, width: 1280, height: 720, hasAudio: false } },
      { id: "m-mic", kind: "audio", name: "Take microphone", path: mic, probe: { frames: 240, hasAudio: true } },
    ],
    tracks: [
      {
        id: "text",
        kind: "text",
        name: "Text",
        items: [
          {
            id: "title",
            type: "text",
            text: "Chapter one",
            start: 400,
            duration: 60,
            style: { preset: "text.title", size: 110, color: "#FFFFFF" },
            transform: { x: 160, y: 300 },
          },
        ],
      },
      { id: "camera", kind: "video", name: "Camera", items: [{ id: "cam-1", type: "clip", media: "m-cam", in: 5, start: 30, duration: 150, group: "take-1" }] },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "intro", type: "clip", media: "m-intro", in: 0, duration: 90 }] },
      {
        id: "voice",
        kind: "audio",
        name: "Voiceover",
        items: [{ id: "mic-1", type: "audio", media: "m-mic", in: 12, start: 30, duration: 150, group: "take-1" }],
      },
    ],
  };
  dir = writeProject(root, "Take", project);
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "issues 40 and 41: a take's mic as a transcript source, Put on Main, transcribe, cut a word, captions; a title onto Main with a crossfade, preview = export",
  { skip, timeout: 480000 },
  async () => {
    const saveAs = join(root, "out", "Take.mp4");
    app = await launchApp({
      command: APP,
      env: {
        UNCUT_DATA_DIR: join(root, "data"),
        UNCUT_PLUGINS_DIR: join(root, "no-user-plugins"),
        UNCUT_SHELL_ENV: "off",
        PATH: `${shimDir}:/usr/bin:/bin`,
        FAKE_WHISPER_JSON: join(root, "whisper.json"),
        FAKE_WHISPER_LOG: join(root, "whisper.jsonl"),
        UNCUT_TEST_DIALOG: JSON.stringify([dir, saveAs]),
        UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts"),
      },
    });
    page = app.page;
    await waitForWelcome(page);
    await page.click("[data-testid=open-project]");
    await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });

    // #40: with the camera selected, the Transcript tab reads the take (its microphone).
    await tab("transcript");
    await page.waitForSelector("[data-testid=tx-source]");
    await tab("timeline");
    await page.click(itemSel("cam-1"));
    await tab("transcript");
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("[data-testid=tx-source]")?.value === "cam-1");
    assert.deepEqual(await page.$$eval("[data-testid=tx-source] option", (els) => els.map((e) => e.textContent)), ["Main track", "Take camera, Camera"]);
    await page.waitForSelector("[data-testid=tx-block][data-media=m-mic] [data-testid=tx-transcribe]", { timeout: 15000 });
    await page.screenshot({ path: out("issue40-source.png") });

    // #41: Put on Main from the camera's menu: it goes after the intro, the mic linked under it.
    await tab("timeline");
    const r0 = await revision();
    await page.click(itemSel("cam-1"), { button: "right" });
    await page.waitForSelector("[data-testid=menu-put-on-main]");
    await page.click("[data-testid=menu-put-on-main]");
    await waitRevision(r0 + 1);
    let p = onDisk();
    let by = itemsOf(p);
    assert.deepEqual(
      mainOf().map((i) => i.id),
      ["intro", "cam-1"],
    );
    assert.equal(by.get("cam-1")!.group, undefined);
    assert.deepEqual(
      [by.get("mic-1")!.track, by.get("mic-1")!.start, by.get("mic-1")!.in, by.get("mic-1")!.linkedTo, by.get("mic-1")!.group],
      ["voice", 90, 12, "cam-1", undefined],
    );
    assert.ok(!p.tracks.some((t) => t.id === "camera"), "the empty Camera track went");
    await page.waitForSelector(`[data-testid=lane][data-track=main] ${itemSel("cam-1")}`);
    await page.screenshot({ path: out("issue41-take-on-main.png") });

    // #40: from the Main view the take reads its mic; transcribe it (the fake whisper-cli, through the plugin).
    await tab("transcript");
    // Heard through Main now: the tab is back on the main track (the take isn't a source of its own any more).
    await page.waitForFunction(() => !document.querySelector("[data-testid=tx-source]"));
    await page.waitForSelector("[data-testid=tx-block][data-clip=cam-1][data-media=m-mic] [data-testid=tx-transcribe]", { timeout: 15000 });
    await page.waitForSelector("[data-testid=tx-block][data-clip=cam-1] [data-testid=tx-transcribe]:not([disabled])", { timeout: 15000 });
    await page.click("[data-testid=tx-block][data-clip=cam-1] [data-testid=tx-transcribe]");
    await page
      .waitForFunction(() => document.querySelectorAll("[data-testid=tx-word]").length === 8, { timeout: 60000 })
      .catch(async (e) => {
        await page.screenshot({ path: out("issue40-41-fail.png") });
        console.log(await page.$eval("[data-testid=transcript-panel]", (el) => el.textContent), readFileSync(join(root, "whisper.jsonl"), "utf8"));
        throw e;
      });
    assert.deepEqual(
      (await txWords()).map(([, t]) => t),
      ["Hello", "um", "this", "is", "a", "test.", "Second", "part."],
    );
    assert.equal(readFileSync(join(root, "whisper.jsonl"), "utf8").trim().split("\n").length, 1, "whisper ran once");
    await page.screenshot({ path: out("issue40-transcript.png") });

    // Cut "um": Main ripples, the mic follows as linked pieces with its own offset (in − camera's in = 7).
    await page.click("[data-testid=tx-word][data-index='1']");
    const r1 = await revision();
    await page.keyboard.press("Backspace");
    await waitRevision(r1 + 1);
    p = onDisk();
    by = itemsOf(p);
    const cams = mainOf().filter((i) => i.media === "m-cam");
    assert.deepEqual(
      cams.map((i) => i.id),
      ["cam-1", "cam-2"],
    );
    const { starts } = (await import("../../packages/core/src/index.ts")).layout(p);
    const mics = p.tracks.find((t) => t.id === "voice")!.items;
    assert.equal(mics.length, 2);
    for (const cam of cams) {
      const mic = mics.find((m) => m.linkedTo === cam.id)!;
      assert.ok(mic, `a mic piece follows ${cam.id}`);
      assert.deepEqual([mic.start, (mic.in ?? 0) - (cam.in ?? 0), mic.duration], [starts.get(cam.id), 7, cam.duration]);
    }
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=tx-word]").length === 7);
    assert.deepEqual(
      (await txWords()).map(([i]) => i),
      [0, 2, 3, 4, 5, 6, 7],
    );

    // Make captions: they follow the take on Main through its mic (no "um").
    const r2 = await revision();
    await page.click("[data-testid=make-captions]");
    await page.waitForSelector("[data-testid=captions-menu]");
    await page.click("[data-testid=captions-make]");
    await waitRevision(r2 + 1);
    const caps = onDisk()
      .tracks.flatMap((t) => t.items)
      .find((i) => i.type === "captions") as Item;
    assert.deepEqual([caps.source, caps.anyTrack], ["m-mic", undefined]);
    await tab("timeline");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=caption-card]").length >= 2);
    const cards = await page.$$eval("[data-testid=caption-card]", (els) =>
      els.map((e) => [Number((e as HTMLElement).dataset.from), e.textContent ?? ""] as const),
    );
    assert.ok(
      cards.every(([, t]) => !/\bum\b/.test(t)),
      JSON.stringify(cards),
    );
    // Cards are per clip (D82): "Hello" before the cut, the rest after it.
    assert.equal(cards.map(([, t]) => t).join(" "), "Hello this is a test. Second part.");
    await goTo(cards[1]![0] + 5);
    await page.waitForFunction((id, text) => document.querySelector(`.pv-text[data-item="${id}"]`)?.textContent === text, {}, caps.id, cards[1]![1]);
    await page.screenshot({ path: out("issue40-captions.png") });

    // #41: the title dragged onto the Main lane goes in the spine (at the end), no refusal. D224: it
    // lands where it's dropped, so it's dropped at the end of Main (⌘: no snapping) to meet cam-2.
    const r3 = await revision();
    const t = await box(itemSel("title"));
    const lane = await box("[data-testid=lane][data-track=main]");
    const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
    const mainEnd = mainOf().reduce((n, i) => n + (i.gap ?? 0) + i.duration, 0);
    const titleStart = itemsOf(onDisk()).get("title")!.start!;
    // A few frames early: it can't start before cam-2 ends, so it butts up to it.
    const dx = (mainEnd - titleStart - 3) * ppf;
    await page.keyboard.down("Meta");
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
    await page.mouse.down();
    await page.mouse.move(t.x + t.width / 2 + dx / 3, t.y + t.height / 2 + 20, { steps: 4 });
    await page.mouse.move(t.x + t.width / 2 + dx, lane.y + lane.height / 2, { steps: 10 });
    await sleep(150);
    assert.equal(await page.$("[data-testid=drag-tip][data-refused=true]"), null, "no refusal while over Main");
    await page.mouse.up();
    await page.keyboard.up("Meta");
    await waitRevision(r3 + 1);
    const main = mainOf();
    assert.deepEqual(
      main.map((i) => i.id),
      ["intro", "cam-1", "cam-2", "title"],
    );
    assert.equal(main.at(-1)!.start, undefined);
    assert.equal(main.at(-1)!.gap, undefined, "it meets cam-2: a cut, no gap");
    await page.waitForSelector(`[data-testid=lane][data-track=main] ${itemSel("title")}`);
    await page.screenshot({ path: out("issue41-text-on-main.png") });

    // A crossfade dropped on the cut into the title (no footage needed for a text).
    const cut = main.slice(0, 3).reduce((n, i) => n + i.duration, 0);
    await page.click("[data-testid=rail-transitions]");
    await page.waitForSelector("[data-testid=transitions-library]");
    const tile = await box("[data-testid=transition-tile][data-module='transition.crossfade']");
    const point = await box(`[data-testid=cut-point][data-frame='${cut}']`);
    const r4 = await revision();
    await page.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2);
    await page.mouse.down();
    await page.mouse.move(tile.x + tile.width / 2 + 20, tile.y + tile.height / 2 + 10, { steps: 3 });
    await page.waitForSelector("[data-testid=transition-drag-chip]");
    await page.mouse.move(point.x + point.width / 2 + 6, point.y + point.height / 2, { steps: 8 });
    await page.waitForSelector(`[data-testid=cut-point][data-frame='${cut}'].target`);
    await page.mouse.up();
    await waitRevision(r4 + 1);
    assert.deepEqual(mainOf().at(-1)!.transitionIn, { module: "transition.crossfade", duration: 15 });

    // The preview mid-crossfade (the title half in over the camera) vs a Standard export of that frame.
    const f = cut + 1;
    await goTo(f);
    await page.keyboard.press("Escape");
    await sleep(300);
    const preview = out("issue41-transition.png");
    await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path: preview });
    await meta("e");
    await page.waitForSelector("[data-testid=export-form]");
    await page.click("[data-testid=quality-standard]");
    await page.click("[data-testid=loudness-off]");
    await page.click("[data-testid=export-change]");
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Take.mp4");
    await page.click("[data-testid=export-start]");
    await page.waitForSelector("[data-testid=export-job]");
    let phase = "";
    for (let i = 0; i < 1800 && phase !== "done" && phase !== "failed"; i++) {
      phase = await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase ?? "");
      await sleep(100);
    }
    assert.equal(phase, "done", await page.$eval("[data-testid=export-job]", (el) => el.textContent ?? ""));
    const exported = out("issue41-transition-export.png");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", saveAs, "-vf", `select=eq(n\\,${f})`, "-frames:v", "1", "-update", "1", exported]);
    const score = ssim(preview, exported);
    console.log(`  preview vs export mid-crossfade into the title (frame ${f}): SSIM ${score.toFixed(4)}`);
    check(NO_REAL_GPU, score >= 0.97, `preview vs export SSIM ${score}`);

    const labels = historyLabels();
    console.log(`  history: ${labels.join(" | ")}`);
    assert.equal(labels[0], "Put cam-1 on Main");
    assert.match(labels[1]!, /^Cut "um" \(/);
    assert.equal(labels[2], "Make captions");
    assert.equal(labels[4], "Added crossfade");
  },
);
