// D105 on the packaged app: subtitles in the Library's import and the export dialog.
// - Without captions or subtitles the dialog has no subtitles section.
// - Importing a .srt (with a broken .vtt) from the Library: a Subtitles track on the timeline, the
//   broken file listed with its reason.
// - The dialog then shows "Captions and subtitles": Burn in captions (on), a file next to the video,
//   a soft track with a language, the format and the cue count; screenshot test-output/export-subtitles.png.
// - "Subtitles only" saves just the .vtt; an export with a .srt next to the video, a Polish soft
//   track and burn-in off makes all three (ffprobe shows mov_text/pol; no caption pixels drawn).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import type { Project } from "../../packages/core/src/timeline/types.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the test media") : `packaged app not built: run pnpm dist to create ${APP}`;

const W = 1280;
const H = 720;
const SRT = "1\n00:00:00,500 --> 00:00:01,500\nHello from the file\n\n2\n00:00:02,000 --> 00:00:03,500\nA second cue\non two lines\n";

let root = "";
let dir = "";
const apps = new Set<LaunchedApp>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const meta = async (page: Page, key: "e") => {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key);
  await page.keyboard.up("Meta");
};
const textOf = (page: Page, selector: string) => page.$eval(selector, (el) => el.textContent ?? "");

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-subtitles-app-")));
  mkdirSync(join(root, "out"));
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x203040:size=640x360:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=300:sample_rate=48000",
    "-t",
    "4",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    join(root, "Clip.mp4"),
  ]);
  writeFileSync(join(root, "talk.srt"), SRT);
  writeFileSync(join(root, "broken.vtt"), "1\n00:00:01,000 --> 00:00:02,000\nNo header\n");
  const project: Project = {
    format: "uncut/0",
    name: "Subtitled",
    canvas: { width: W, height: H, fps: 30 },
    textLooks: 1,
    media: [
      { id: "m-clip", kind: "video", name: "Clip.mp4", path: join(root, "Clip.mp4"), probe: { frames: 120, fps: 30, width: 640, height: 360, hasAudio: true } },
    ],
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-clip", in: 0, duration: 120 }] }],
  };
  dir = writeProject(root, "Subtitled", project);
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "subtitles: import a .srt from the Library; the export dialog's options; subtitles only; a soft track and a file without burn-in",
  { skip, timeout: 240000 },
  async () => {
    const saveAs = join(root, "out", "Talk.mp4");
    const app = await launchApp({
      command: APP,
      env: {
        UNCUT_DATA_DIR: join(root, "data"),
        UNCUT_TEST_DIALOG: JSON.stringify([dir, [join(root, "talk.srt"), join(root, "broken.vtt")], saveAs]),
        UNCUT_CLAUDE: resolve("test/helpers/fake-claude.ts"),
      },
    });
    apps.add(app);
    const { page } = app;
    await waitForWelcome(page);
    await page.click("[data-testid=open-project]");
    await waitFor(page, "[data-testid=editor]");

    // Nothing to subtitle yet: no section.
    await page.click("[data-testid=timeline]");
    await meta(page, "e");
    await waitFor(page, "[data-testid=export-form]");
    assert.equal(await page.$("[data-testid=export-subtitles]"), null);
    assert.equal(await page.$("[data-testid=export-subtitles-only]"), null);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-testid=export-modal]"));

    // Import from the Library: the .srt becomes a Subtitles track; the broken .vtt is listed with its reason.
    await page.click("[data-testid=import-plus]");
    await waitFor(page, "[data-testid=import-report]", 30000);
    assert.match(await textOf(page, "[data-testid=import-report]"), /broken\.vtt isn't a WebVTT file: it has to start with "WEBVTT"/);
    await page.waitForFunction(() => (document.querySelector("[data-testid=timeline]")?.textContent ?? "").includes("Subtitles"), { timeout: 15000 });
    const saved = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as Project;
    const track = saved.tracks.find((t) => t.name === "Subtitles")!;
    assert.deepEqual(
      track.items.map((i) => [i.start, i.duration, i.text]),
      [
        [15, 30, "Hello from the file"],
        [60, 45, "A second cue\non two lines"],
      ],
    );
    assert.equal(saved.media.length, 1, "no media for a subtitles file");

    // The dialog's section: burn-in on, the rest off; the cue count.
    await page.click("[data-testid=timeline]");
    await meta(page, "e");
    await waitFor(page, "[data-testid=export-subtitles]");
    assert.equal(await page.$eval("[data-testid=export-burn]", (el) => (el as HTMLInputElement).checked), true);
    assert.equal(await page.$eval("[data-testid=export-sub-file]", (el) => (el as HTMLInputElement).checked), false);
    assert.equal(await page.$eval("[data-testid=export-sub-track]", (el) => (el as HTMLInputElement).checked), false);
    assert.equal(await page.$eval("[data-testid=export-sub-language]", (el) => (el as HTMLSelectElement).disabled), true);
    assert.match(await textOf(page, "[data-testid=export-sub-count]"), /^2 cues, in the edit's time$/);
    const section = await textOf(page, "[data-testid=export-subtitles]");
    for (const words of ["Burn in captions", "Subtitles file (.srt / .vtt) next to the video", "Soft subtitle track in the video", "SRT", "WebVTT"])
      assert.ok(section.includes(words), words);
    assert.ok(!/[·•*]/.test(section), "no separators between words");
    await page.click("[data-testid=export-change]");
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>("[data-testid=export-name]")!.value === "Talk.mp4");

    // Burn-in off with nothing else: a note says the video will have none.
    await page.click("[data-testid=export-burn]");
    await waitFor(page, "[data-testid=export-no-captions-note]");

    // Subtitles only, as WebVTT.
    await page.click("[data-testid=export-sub-format-vtt]");
    await page.click("[data-testid=export-subtitles-only]");
    await waitFor(page, "[data-testid=export-subtitles-saved]");
    assert.equal(await textOf(page, "[data-testid=export-subtitles-saved]"), "Saved Talk.vtt (2 cues).");
    assert.equal(
      readFileSync(join(root, "out", "Talk.vtt"), "utf8"),
      "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nHello from the file\n\n00:00:02.000 --> 00:00:03.500\nA second cue\non two lines\n\n",
    );
    assert.ok(!existsSync(saveAs), "no video");
    // Again: it exists; Replace it writes it again.
    await page.click("[data-testid=export-subtitles-only]");
    await waitFor(page, "[data-testid=export-refused][data-reason=exists]");
    assert.match(await textOf(page, "[data-testid=export-refused]"), /Talk\.vtt already exists in that folder/);
    await page.click("[data-testid=export-replace]");
    await waitFor(page, "[data-testid=export-subtitles-saved]");

    // A .srt next to the video and a Polish soft track, burn-in off.
    await page.click("[data-testid=export-sub-format-srt]");
    await page.click("[data-testid=export-sub-file]");
    await page.click("[data-testid=export-sub-track]");
    await page.select("[data-testid=export-sub-language]", "pl");
    assert.equal(await page.$("[data-testid=export-no-captions-note]"), null);
    await (await page.$("[data-testid=export-modal] .modal"))!.screenshot({ path: out("export-subtitles.png") });
    await page.click("[data-testid=export-start]");
    await waitFor(page, "[data-testid=export-job]");
    await page.waitForFunction(() => ["done", "failed"].includes(document.querySelector<HTMLElement>("[data-testid=export-job]")?.dataset.phase ?? ""), {
      timeout: 120000,
    });
    assert.equal(
      await page.$eval("[data-testid=export-job]", (el) => (el as HTMLElement).dataset.phase),
      "done",
      await textOf(page, "[data-testid=export-job]"),
    );
    assert.equal(
      await textOf(page, "[data-testid=export-job-subtitles]"),
      "Subtitles in Talk.srt, a soft subtitle track (Polish), captions not drawn into the picture.",
    );
    await page.screenshot({ path: out("export-subtitles-done.png") });
    assert.equal(
      readFileSync(join(root, "out", "Talk.srt"), "utf8"),
      "1\n00:00:00,500 --> 00:00:01,500\nHello from the file\n\n2\n00:00:02,000 --> 00:00:03,500\nA second cue\non two lines\n",
    );
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", saveAs], { encoding: "utf8" })) as {
      streams: Array<{ codec_type: string; codec_name: string; tags?: { language?: string } }>;
    };
    const sub = probe.streams.find((s) => s.codec_type === "subtitle");
    assert.deepEqual([sub?.codec_name, sub?.tags?.language], ["mov_text", "pol"]);
    // No caption pixels while a cue is on (frame 30): the clip's flat colour only.
    const px = execFileSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      saveAs,
      "-vf",
      "select=eq(n\\,30),scale=320:180",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ]);
    let bright = 0;
    for (let i = 0; i < px.length; i += 3) if (px[i]! > 200 && px[i + 1]! > 200 && px[i + 2]! > 200) bright++;
    assert.equal(bright, 0, "burn-in off draws no caption text");
    await sleep(100);
  },
);
