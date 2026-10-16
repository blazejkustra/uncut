// Phase 5 chunk 6 (D70) on the packaged app (background window): the inspector's Find beats runs the
// beats job on a 120 BPM click track (first click at 0.2 s, so beats at frames 6, 21, 36, … at
// 30 fps), the audio item then shows beat ticks, and with snapping on a dragged title sticks to a
// beat (the snap line shows it), the playhead snaps to a beat when the ruler is clicked near one,
// ⌘ turns it off. Screenshots: test-output/beats-ticks.png, test-output/beats-snap.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { clickTrack, writeWav } from "../helpers/beats-audio.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const which = (name: string) => {
  try {
    return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};
const skip = !existsSync(APP) ? `packaged app not built: run pnpm dist to create ${APP}` : !which("ffmpeg") ? "needs ffmpeg" : false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FPS = 30;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const waitFor = (selector: string, timeout = 20000) => page.waitForSelector(selector, { timeout });
const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const title = () => onDisk().tracks.find((t: { id: string }) => t.id === "text").items[0];
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const ppf = () => page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
const box = async (selector: string) => {
  const b = await (await page.$(selector))?.boundingBox();
  assert.ok(b, `no box for ${selector}`);
  return b;
};
const playheadFrame = () => page.$eval("[data-testid=playhead]", (el) => Number((el as HTMLElement).dataset.frame));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-beats-app-")));
  writeWav(join(root, "Clicks.wav"), clickTrack(120, 10, 0.2).buf);
  dir = join(root, "Beats.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Beats",
      canvas: { width: 1920, height: 1080, fps: FPS },
      media: [{ id: "m-clicks", kind: "audio", name: "Clicks.wav", path: join(root, "Clicks.wav"), probe: { frames: 300, hasAudio: true } }],
      tracks: [
        { id: "text", kind: "text", name: "Text", items: [{ id: "title", type: "text", start: 100, duration: 30, text: "On the beat" }] },
        { id: "main", kind: "video", role: "main", name: "Main", items: [] },
        { id: "audio", kind: "audio", name: "Audio", items: [{ id: "song", type: "audio", media: "m-clicks", in: 0, start: 0, duration: 300 }] },
      ],
    }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("Find beats in the inspector, ticks on the audio item, a dragged title and the playhead snap to beats", { skip, timeout: 180000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  await waitFor('[data-item="song"]');
  assert.equal(await page.$("[data-testid=beat-ticks]"), null, "no ticks before the beats are found");

  // Select the music: the inspector offers Find beats; it runs the job and shows the tempo.
  await page.click('[data-item="song"] .nm');
  await waitFor('[data-testid=insp-beats][data-state=none]');
  await page.click("[data-testid=insp-find-beats]");
  await waitFor('[data-testid=insp-beats][data-state=done]', 30000);
  assert.equal(await page.$eval("[data-testid=insp-beats-summary]", (el) => el.textContent), "120 BPM, 20 beats");
  // The cached result the timeline draws.
  const folder = readdirSync(join(dir, ".cache", "analysis"))[0]!;
  const cached = JSON.parse(readFileSync(join(dir, ".cache", "analysis", folder, "beats.json"), "utf8")).result as { bpm: number; beats: Array<number> };
  const frames = cached.beats.map((t) => Math.round(t * FPS));
  assert.deepEqual(frames.slice(0, 4), [6, 21, 36, 51]);

  // Ticks on the audio item, one per beat, the first at frame 6.
  await waitFor('[data-item="song"] [data-testid=beat-ticks]');
  const ticks = await page.$eval('[data-item="song"] [data-testid=beat-ticks]', (el) => ({ count: Number((el as SVGElement).dataset.count), first: Number((el as SVGElement).dataset.first), path: el.querySelector("path")!.getAttribute("d") }));
  assert.equal(ticks.count, 20);
  assert.equal(ticks.first, 6);
  const scale = await ppf();
  const xs = [...ticks.path!.matchAll(/M([\d.]+) 0V22/g)].map((m) => Number(m[1]));
  assert.equal(xs.length, 20);
  for (const [i, x] of xs.entries()) assert.ok(Math.abs(x - frames[i]! * scale) <= 0.5 * scale, `tick ${i} at ${x}px, beat frame ${frames[i]}`);
  await page.screenshot({ path: "test-output/beats-ticks.png" });

  // Drag the title (100–130) right by 10 frames: its start (110) sticks to the beat at 111.
  const rev = await revision();
  const t = await box('[data-item="title"]');
  const from = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
  const to = { x: from.x + 10 * scale, y: from.y };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + (to.x - from.x) / 3, from.y, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=snap-line]")?.dataset.frame === "111", { timeout: 5000 }).catch(() => {});
  assert.equal(await page.$eval("[data-testid=snap-line]", (el) => Number((el as HTMLElement).dataset.frame)), 111, "the snap line on the beat");
  await page.screenshot({ path: "test-output/beats-snap.png" });
  await page.mouse.up();
  await page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1]) > r, { timeout: 10000 }, rev);
  assert.equal(title().start, 111);

  // The playhead: a click on the ruler a frame before a beat lands on it; with ⌘ it doesn't.
  const ruler = await box("[data-testid=ruler]");
  await page.mouse.click(ruler.x + 50 * scale + 1, ruler.y + ruler.height / 2);
  await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=playhead]")!.dataset.frame) === 51, { timeout: 5000 }).catch(() => {});
  assert.equal(await playheadFrame(), 51, "snapped to the beat at 51");
  await page.keyboard.down("Meta");
  await page.mouse.click(ruler.x + 50 * scale + 1, ruler.y + ruler.height / 2);
  await page.keyboard.up("Meta");
  await sleep(150);
  assert.equal(await playheadFrame(), 50, "⌘: no snapping");
});
