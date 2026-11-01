// Search across footage on the packaged app: a clip with a cached transcript is searchable without
// any run, a result shows its frame and timecode and drops on the timeline as that stretch of the
// clip, another project's moment is added first, and with the speech model in test-output a real
// run shows progress and makes a real clip searchable (skipped without the model).
// Screenshots: test-output/footage-search-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { fingerprint, writeCached } from "../../apps/server/src/analysis/analysis.ts";
import { launchApp, lockApps, unlockApps, waitForWelcome, type LaunchedApp } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const MODEL = resolve("test-output/whisper-models/ggml-large-v3-turbo-q5_0.bin");
const skip = existsSync(APP) ? false : `packaged app not built: run pnpm dist to create ${APP}`;
const FPS = 30;

let root = "";
let dir = "";
const apps = new Set<LaunchedApp>();
const shot = (name: string) => resolve("test-output", `footage-search-${name}.png`);

function makeClip(path: string, colour: string, withSay?: string) {
  const speech = `${path}.aiff`;
  if (withSay) execFileSync("say", ["-o", speech, withSay]);
  const audio = withSay ? ["-i", speech] : ["-f", "lavfi", "-i", "sine=frequency=330:duration=20"];
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${colour}:size=640x360:rate=${FPS}:duration=20`,
    ...audio,
    "-t",
    "20",
    "-af",
    "apad",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    path,
  ]);
}

const transcript = (words: ReadonlyArray<string>, from: number) => ({
  hasAudio: true,
  language: "en",
  model: "test",
  seconds: 20,
  segments: [],
  words: words.map((text, i) => ({ text, start: from + i * 0.5, end: from + i * 0.5 + 0.4, p: 0.9 })),
});

function writeProject(folder: string, name: string, media: ReadonlyArray<{ id: string; file: string; name: string }>) {
  writeFileSync(
    join(folder, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name,
      canvas: { width: 1280, height: 720, fps: FPS },
      media: media.map((m) => ({
        id: m.id,
        kind: "video",
        name: m.name,
        path: m.file,
        source: { module: "media.import" },
        probe: { frames: 20 * FPS, fps: FPS, width: 640, height: 360, hasAudio: true },
      })),
      tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [] }],
    }),
  );
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-footage-app-")));
  dir = join(root, "Launch.uncut");
  const other = join(root, "Interviews.uncut");
  mkdirSync(join(dir, "media"), { recursive: true });
  mkdirSync(join(other, "media"), { recursive: true });
  makeClip(join(dir, "media", "talk.mp4"), "steelblue");
  makeClip(join(dir, "media", "said.mp4"), "seagreen", "The purple lighthouse opens at noon on Friday.");
  makeClip(join(other, "media", "interview.mp4"), "indianred");
  writeProject(dir, "Launch", [
    { id: "m-talk", file: "media/talk.mp4", name: "Talk" },
    { id: "m-said", file: "media/said.mp4", name: "Said" },
  ]);
  writeProject(other, "Interviews", [{ id: "m-interview", file: "media/interview.mp4", name: "Interview" }]);
  await writeCached(
    dir,
    await fingerprint(join(dir, "media", "talk.mp4")),
    "transcript",
    transcript(["we", "moved", "the", "render", "pipeline", "to", "the", "gpu"], 12),
  );
  await writeCached(other, await fingerprint(join(other, "media", "interview.mp4")), "transcript", transcript(["the", "render", "farm", "was", "loud"], 6));
  const data = join(root, "data");
  mkdirSync(join(data, "models"), { recursive: true });
  if (existsSync(MODEL)) linkSync(MODEL, join(data, "models", "ggml-large-v3-turbo-q5_0.bin"));
  writeFileSync(
    join(data, "recents.json"),
    JSON.stringify([
      { dir, name: "Launch", openedAt: "2026-10-30T09:00:00.000Z" },
      { dir: other, name: "Interviews", openedAt: "2026-10-29T09:00:00.000Z" },
    ]),
  );
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

const setQuery = async (page: Page, text: string) => {
  await page.click("[data-testid=footage-query]", { count: 3 });
  await page.keyboard.press("Backspace");
  await page.type("[data-testid=footage-query]", text);
};

const dropFirstHitOnMain = (page: Page) =>
  page.evaluate(() => {
    const hit = document.querySelector<HTMLElement>("[data-testid=footage-hit]")!;
    const lane = document.querySelector<HTMLElement>("[data-testid=lane]")!;
    const box = lane.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    hit.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
    const at = { bubbles: true, cancelable: true, dataTransfer, clientX: box.left + 40, clientY: box.top + box.height / 2 };
    lane.dispatchEvent(new DragEvent("dragover", at));
    lane.dispatchEvent(new DragEvent("drop", at));
  });

const mainItems = (page: Page) =>
  page.$$eval("[data-testid=timeline-item]", (items) => items.map((item) => ({ duration: Number((item as HTMLElement).dataset.duration) })));

test("search footage, see the moment, drop that stretch on the timeline, add one from another project", { skip, timeout: 240000 }, async () => {
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data") } });
  apps.add(app);
  const { page } = app;
  const waitFor = (selector: string, timeout = 20000) => page.waitForSelector(selector, { timeout });
  await waitForWelcome(page);
  await waitFor("[data-testid=recent]");
  await page.click("[data-testid=recent]");
  await waitFor("[data-testid=footage-search]");
  await page.waitForFunction(() => document.querySelector("[data-testid=footage-state]")?.textContent?.includes("1 of 2 clips searchable"), { timeout: 20000 });

  await setQuery(page, "render pipeline");
  await waitFor("[data-testid=footage-hit]");
  assert.equal(await page.$eval("[data-testid=footage-time]", (el) => el.textContent), "0:13");
  assert.equal(await page.$eval(".footage-text mark", (el) => el.textContent), "render pipeline");
  await page.waitForFunction(() => (document.querySelector<HTMLImageElement>(".footage-thumb img")?.naturalWidth ?? 0) > 0, { timeout: 20000 });
  await page.screenshot({ path: shot("results") });

  await dropFirstHitOnMain(page);
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=timeline-item]").length === 1, { timeout: 15000 });
  const [item] = await mainItems(page);
  assert.equal(item!.duration, Math.ceil((14.4 + 0.5) * FPS) - Math.floor((13.5 - 0.5) * FPS), "the words and their handles");

  await setQuery(page, "farm");
  await waitFor("[data-testid=footage-none]");
  await page.select("[data-testid=footage-scope]", "all");
  await waitFor("[data-testid=footage-add]");
  assert.equal(await page.$eval("[data-testid=footage-hit]", (el) => (el as HTMLElement).draggable), false);
  await page.screenshot({ path: shot("other-project") });
  await page.click("[data-testid=footage-add]");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=footage-hit]")?.draggable === true, { timeout: 20000 });

  await setQuery(page, "lighthouse");
  await waitFor("[data-testid=footage-none]");
  if (existsSync(MODEL)) {
    await page.click("[data-testid=footage-index]");
    await waitFor("[data-testid=footage-progress]");
    await page.screenshot({ path: shot("progress") });
    await page.waitForFunction(() => !document.querySelector("[data-testid=footage-progress]"), { timeout: 120000 });
    await waitFor("[data-testid=footage-hit]", 30000);
    assert.match(await page.$eval(".footage-text mark", (el) => el.textContent ?? ""), /lighthouse/i);
    await page.screenshot({ path: shot("indexed") });
  }
  assert.deepEqual(app.errors, []);
  await app.close();
  apps.delete(app);
});
