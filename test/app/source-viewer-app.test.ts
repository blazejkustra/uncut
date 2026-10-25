// D311 on the packaged app (background window), through the UI: the source viewer.
// - Space over a media tile opens it in the preview and plays it; Space over it again pauses;
// - I and O mark the file in the viewer, and Add puts In to Out at the end of the main track;
// - Esc, the Timeline button and a press on the timeline go back to the timeline's preview;
// - Space over a timeline clip, or anywhere but a tile or the viewer, plays the timeline as before;
// - a double click opens a tile (a sound shows its waveform, a picture itself);
// - Space typed in the composer stays text, even with the pointer over a tile.
// Screenshots: test-output/source-viewer-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import type { Project } from "../../packages/core/src/index.ts";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";

const APP = resolve(process.env.UNCUT_TEST_APP ?? "dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 30;
let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (name: string) => resolve("test-output", `source-viewer-${name}.png`);
const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const mainOf = (p: Project) => p.tracks.find((t) => t.role === "main")!.items;
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) =>
  page.waitForFunction(
    (r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) >= r,
    { timeout: 10000 },
    n,
  );
const viewerMedia = () => page.$eval("[data-testid=source-viewer]", (el) => (el as HTMLElement).dataset.media).catch(() => undefined);
const viewerPlaying = () => page.$eval("[data-testid=source-play]", (el) => (el as HTMLElement).dataset.playing === "true");
const timelinePlaying = () => page.$eval("[data-testid=preview-frame]", (el) => (el as HTMLElement).dataset.playing === "true");
const sourceTime = () => page.$eval("[data-testid=source-video]", (el) => (el as HTMLVideoElement).currentTime);
const waitViewer = (media: string) => page.waitForSelector(`[data-testid=source-viewer][data-media="${media}"]`, { timeout: 5000 });
const waitNoViewer = () => page.waitForFunction(() => !document.querySelector("[data-testid=source-viewer]"), { timeout: 5000 });

async function hoverTile(id: string) {
  const box = (await (await page.$(`[data-testid=media-tile][data-id="${id}"]`))!.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3);
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.3);
}
async function clickScrub(at: number) {
  const box = (await (await page.$("[data-testid=source-scrub]"))!.boundingBox())!;
  await page.mouse.click(box.x + box.width * at, box.y + box.height / 2);
}
async function overTimelineClip(id: string) {
  const box = (await (await page.$(`[data-testid=timeline-item][data-item="${id}"]`))!.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}
async function stopTimeline() {
  if (await timelinePlaying()) await page.keyboard.press("k");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.playing !== "true", { timeout: 5000 });
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-source-viewer-app-")));
  for (const [name, src] of [
    ["take-a.mp4", "testsrc2"],
    ["take-b.mp4", "smptebars"],
  ] as const) {
    const args = ["-v", "error", "-y", "-f", "lavfi", "-i", `${src}=s=1280x720:r=${FPS}`, "-t", "10", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30"];
    execFileSync("ffmpeg", [...args, "-pix_fmt", "yuv420p", join(root, name)]);
  }
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=220:beep_factor=4:d=10", "-c:a", "aac", join(root, "song.m4a")]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=1280x720", "-frames:v", "1", join(root, "still.png")]);
  const probe = { frames: 10 * FPS, fps: FPS, width: 1280, height: 720, hasAudio: false };
  dir = writeProject(root, "Source viewer", {
    format: "uncut/0",
    name: "Source viewer",
    canvas: { width: 1920, height: 1080, fps: FPS },
    media: [
      { id: "m-a", kind: "video", name: "take-a.mp4", path: join(root, "take-a.mp4"), probe },
      { id: "m-b", kind: "video", name: "take-b.mp4", path: join(root, "take-b.mp4"), probe },
      { id: "m-song", kind: "audio", name: "song.m4a", path: join(root, "song.m4a"), probe: { frames: 10 * FPS, hasAudio: true } },
      { id: "m-still", kind: "image", name: "still.png", path: join(root, "still.png"), probe: { width: 1280, height: 720 } },
    ],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "c1", type: "clip", media: "m-a", in: 0, duration: 150 },
          { id: "c2", type: "clip", media: "m-a", in: 150, duration: 150 },
        ],
      },
    ],
  });
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: FAKE } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector('[data-testid=timeline-item][data-item="c2"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid=media-tile][data-id="m-b"]', { timeout: 10000 });
  await sleep(500);
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("Space over a media tile opens it in the source viewer and plays it; Space over it again pauses", { skip, timeout: 60000 }, async () => {
  await page.mouse.move(5, 5);
  await page.screenshot({ path: shot("before") });
  await hoverTile("m-b");
  await page.keyboard.press("Space");
  await waitViewer("m-b");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=source-play]")?.dataset.playing === "true", { timeout: 5000 });
  assert.equal(await timelinePlaying(), false, "the timeline doesn't play");
  await page.waitForFunction(() => document.querySelector<HTMLVideoElement>("[data-testid=source-video]")!.currentTime > 0.3, { timeout: 5000 });
  assert.match(await page.$eval("[data-testid=source-name]", (el) => el.textContent ?? ""), /take-b\.mp4/);
  await page.screenshot({ path: shot("playing") });
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=source-play]")?.dataset.playing !== "true", { timeout: 5000 });
  const paused = await sourceTime();
  await sleep(300);
  assert.equal(await sourceTime(), paused, "paused");
  assert.equal(await viewerMedia(), "m-b");
});

test("I and O mark the file in the viewer, and Add puts In to Out at the end of the main track", { skip, timeout: 60000 }, async () => {
  await waitViewer("m-b");
  await clickScrub(0.2);
  await page.keyboard.press("i");
  await clickScrub(0.5);
  await page.keyboard.press("o");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=source-scrub]")?.dataset.out !== undefined, { timeout: 5000 });
  const marks = await page.$eval("[data-testid=source-scrub]", (el) => [Number((el as HTMLElement).dataset.in), Number((el as HTMLElement).dataset.out)]);
  assert.ok(Math.abs(marks[0]! - 2) < 0.3 && Math.abs(marks[1]! - 5) < 0.3, `marks at ${marks.join(", ")}`);
  assert.equal(await page.$("[data-testid=marks]"), null, "the timeline has no marks");
  await page.screenshot({ path: shot("marks") });
  const rev = await revision();
  await page.click("[data-testid=source-add]");
  await waitRevision(rev + 1);
  const added = mainOf(onDisk()).at(-1)!;
  assert.equal(added.media, "m-b");
  assert.ok(Math.abs(added.in! - 60) <= 9 && Math.abs(added.duration - 90) <= 18, `in ${added.in}, ${added.duration} frames`);
  assert.equal(await viewerMedia(), "m-b", "the viewer stays open");
});

test("Esc, the Timeline button and a press on the timeline go back to the timeline", { skip, timeout: 60000 }, async () => {
  await page.mouse.move(5, 5);
  await page.keyboard.press("Escape");
  await waitNoViewer();
  await hoverTile("m-a");
  await page.keyboard.press("Space");
  await waitViewer("m-a");
  await page.click("[data-testid=source-back]");
  await waitNoViewer();
  await hoverTile("m-a");
  await page.keyboard.press("Space");
  await waitViewer("m-a");
  const ruler = (await (await page.$("[data-testid=ruler]"))!.boundingBox())!;
  await page.mouse.click(ruler.x + 40, ruler.y + 10);
  await waitNoViewer();
});

test("Space over a timeline clip, or with a viewer open and the pointer elsewhere, plays the timeline", { skip, timeout: 60000 }, async () => {
  await stopTimeline();
  await overTimelineClip("c1");
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.playing === "true", { timeout: 5000 });
  assert.equal(await viewerMedia(), undefined);
  await page.keyboard.press("Space");
  await stopTimeline();
  await hoverTile("m-b");
  await page.keyboard.press("Space");
  await waitViewer("m-b");
  await page.mouse.move(5, 5);
  await page.keyboard.press("Space");
  await waitNoViewer();
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.playing === "true", { timeout: 5000 });
  await stopTimeline();
});

test("a double click opens a tile: a sound shows its waveform, a picture itself", { skip, timeout: 60000 }, async () => {
  const tile = async (id: string) => (await (await page.$(`[data-testid=media-tile][data-id="${id}"] .thumb`))!.boundingBox())!;
  const song = await tile("m-song");
  await page.mouse.click(song.x + song.width * 0.3, song.y + song.height * 0.6, { clickCount: 2 });
  await waitViewer("m-song");
  assert.equal(await viewerPlaying(), false, "opened paused");
  await page.waitForSelector("[data-testid=source-wave] canvas[data-ready=true]", { timeout: 15000 });
  await page.mouse.move(5, 5);
  await sleep(300);
  await page.screenshot({ path: shot("audio") });
  const still = await tile("m-still");
  await page.mouse.click(still.x + still.width * 0.3, still.y + still.height * 0.6, { clickCount: 2 });
  await waitViewer("m-still");
  await page.waitForFunction(() => (document.querySelector<HTMLImageElement>("[data-testid=source-image]")?.naturalWidth ?? 0) > 0, { timeout: 5000 });
  assert.equal(await page.$("[data-testid=source-play]"), null, "a picture has nothing to play");
  await page.mouse.move(5, 5);
  await page.keyboard.press("Escape");
  await waitNoViewer();
});

test("Space typed in the composer stays text, even with the pointer over a tile", { skip, timeout: 60000 }, async () => {
  await page.click("[data-testid=tab-agent]").catch(() => {});
  await page.waitForSelector("[data-testid=agent-input]", { timeout: 10000 });
  await page.click("[data-testid=agent-input]");
  await page.keyboard.type("a b");
  await hoverTile("m-a");
  await page.keyboard.type(" c");
  assert.equal(await page.$eval("[data-testid=agent-input]", (el) => (el as HTMLTextAreaElement).value ?? el.textContent), "a b c");
  assert.equal(await viewerMedia(), undefined, "no viewer opened");
  assert.equal(await timelinePlaying(), false);
});
