// Phase 4 chunk 1 on the packaged app: the preview, transport and timeline work, also in a project
// with no media. An empty project gets a title from the Text tab and plays it (the text is on
// screen at exactly its frames); the user's DJI clip added to the main track shows decoded frames,
// and scrubbing to frame f shows the source at f / fps (D38, within ±0.1 s per FORMAT.md).
// Screenshots: test-output/preview-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, waitForWelcome } from "../helpers/app.ts";
import { demoProject, skipDemo } from "../helpers/demo.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg for pixel checks") : `packaged app not built: run pnpm dist to create ${APP}`;
const skipClip = skip || skipDemo;

type App = Awaited<ReturnType<typeof launchApp>>;
let root = "";
let projects = "";
const apps = new Set<App>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const text = (page: Page, id: string) => page.$eval(`[data-testid=${id}]`, (el) => (el.textContent ?? "").trim());
const frameOf = (page: Page) => page.$eval("[data-testid=preview-frame]", (el) => Number((el as HTMLElement).dataset.frame));
const meta = async (page: Page, key: Parameters<Page["keyboard"]["press"]>[0], shift = false) => {
  await page.keyboard.down("Meta");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
};
const items = (page: Page) =>
  page.$$eval("[data-testid=timeline-item]", (els) =>
    els.map((e) => {
      const d = (e as HTMLElement).dataset;
      return { id: d.item, type: d.type, start: Number(d.start), duration: Number(d.duration), track: (e.parentElement as HTMLElement).dataset.track };
    }),
  );
const trackIds = (page: Page) => page.$$eval("[data-testid=track]", (els) => els.map((e) => (e as HTMLElement).dataset.id));
/** Seek by keyboard: Home, then ⇧→ for whole seconds and → for frames. */
async function goTo(page: Page, frame: number, fps: number) {
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < Math.floor(frame / fps); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  for (let i = 0; i < frame % fps; i++) await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, frame);
}

/** The preview as grey pixels, w×h, read back through ffmpeg. */
function grey(png: string, w: number, h: number) {
  return execFileSync("ffmpeg", ["-v", "error", "-i", png, "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"]);
}
/** Share of bright pixels in a band of rows (fractions of the height). */
function brightShare(png: string, fromY: number, toY: number) {
  const w = 480;
  const h = 270;
  const px = grey(png, w, h);
  let bright = 0;
  let total = 0;
  for (let y = Math.floor(fromY * h); y < Math.ceil(toY * h); y++) {
    for (let x = 0; x < w; x++) {
      total++;
      if (px[y * w + x]! > 150) bright++;
    }
  }
  return bright / total;
}
async function shotPreview(page: Page, name: string) {
  const path = out(`preview-${name}.png`);
  await (await page.$("[data-testid=preview-frame]"))!.screenshot({ path });
  return path;
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-preview-")));
  projects = join(root, "projects");
  mkdirSync(projects);
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("an empty project gets a title and a lower third, plays them at their frames, and undo takes them back", { skip, timeout: 120000 }, async () => {
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([projects]) } });
  apps.add(app);
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=new-project]");
  await waitFor(page, "[data-testid=new-project-form]");
  await page.click("[data-testid=choose-folder]");
  await page.waitForFunction((dir: string) => document.querySelector<HTMLElement>("[data-testid=parent-dir]")!.title === dir, {}, projects);
  await page.click("[data-testid=create]");
  await waitFor(page, "[data-testid=editor]");
  const dir = await page.$eval("[data-testid=project-title]", (el) => (el as HTMLElement).title);
  const onDisk = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));

  // Empty: nothing to play, black preview, the timeline says what to do.
  assert.equal(await text(page, "timecode"), "00:00:00:00 / 00:00:00:00");
  assert.equal(await page.$eval("[data-testid=play]", (b) => (b as HTMLButtonElement).disabled), true);
  await waitFor(page, "[data-testid=timeline-empty]");
  assert.match(await text(page, "timeline-empty"), /Text tab/);

  // Text tab → Title: 3 s at the playhead (frame 0) on the Text track.
  await page.click("[data-testid=rail-text]");
  await waitFor(page, "[data-testid=text-library]");
  // A double click adds one title, not two edits racing for the same id.
  await page.click("[data-testid=text-preset][data-preset=title]", { clickCount: 2 });
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=timeline-item]").length === 1);
  await sleep(500);
  assert.equal((await items(page)).length, 1, "one title from a double click");
  assert.equal(await page.$("[data-testid=editor-error]"), null, "no refused edit");
  assert.deepEqual(await items(page), [{ id: "title-1", type: "text", start: 0, duration: 90, track: "text" }]);
  assert.equal(await text(page, "timecode"), "00:00:00:00 / 00:00:03:00");
  assert.equal(await page.$("[data-testid=timeline-empty]"), null);
  await waitFor(page, '.pv-text[data-item="title-1"]');
  const saved = onDisk().tracks.find((t: { id: string }) => t.id === "text").items[0];
  assert.deepEqual(saved, { id: "title-1", type: "text", start: 0, duration: 90, text: "Title", transform: { x: 154, y: 410 }, style: { preset: "text.title", size: 130, weight: 700 } });

  // At 2 s the Text track is taken for the next 3 s, so a lower third goes on a new text track on top.
  await page.click("[data-testid=timeline]");
  await goTo(page, 60, 30);
  await page.click("[data-testid=text-preset][data-preset=lower-third]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=timeline-item]").length === 2);
  assert.deepEqual((await items(page)).find((i) => i.id === "lower-third-1"), { id: "lower-third-1", type: "text", start: 60, duration: 90, track: "text-1" });
  assert.deepEqual(await trackIds(page), ["text-1", "text", "main", "audio"]);
  assert.equal(await text(page, "timecode"), "00:00:02:00 / 00:00:05:00");
  await page.screenshot({ path: out("preview-text-editor.png") });

  // Pixels: the title (rows 36–52 %) is drawn at frame 30 and gone at frame 120; the lower third
  // (rows 78–90 %) is there at 120 and not at 30.
  await goTo(page, 30, 30);
  const at30 = await shotPreview(page, "title-30");
  await goTo(page, 120, 30);
  const at120 = await shotPreview(page, "title-120");
  assert.ok(brightShare(at30, 0.36, 0.52) > 0.01, `title visible at 30 (${brightShare(at30, 0.36, 0.52)})`);
  assert.ok(brightShare(at120, 0.36, 0.52) < 0.001, `title gone at 120 (${brightShare(at120, 0.36, 0.52)})`);
  assert.ok(brightShare(at120, 0.78, 0.9) > 0.005, `lower third visible at 120 (${brightShare(at120, 0.78, 0.9)})`);
  assert.ok(brightShare(at30, 0.78, 0.9) < 0.001, `no lower third at 30 (${brightShare(at30, 0.78, 0.9)})`);

  // Play from the start (Space): the clock runs with no media, and on every drawn frame the
  // title shows exactly while f < 90 and the lower third exactly while f >= 60.
  await page.keyboard.press("Home");
  const t0 = Date.now();
  const samples = await page.evaluate(
    () =>
      new Promise<Array<[number, boolean, boolean]>>((done) => {
        const frame = document.querySelector<HTMLElement>("[data-testid=preview-frame]")!;
        const got: Array<[number, boolean, boolean]> = [];
        const sample = () => {
          got.push([Number(frame.dataset.frame), !!frame.querySelector('[data-item="title-1"]'), !!frame.querySelector('[data-item="lower-third-1"]')]);
          if (frame.dataset.playing === "false" && got.length > 5) return done(got);
          requestAnimationFrame(sample);
        };
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true }));
        requestAnimationFrame(sample);
      }),
  );
  const seconds = (Date.now() - t0) / 1000;
  const frames = samples.map((s) => s[0]);
  assert.equal(frames.at(-1), 149, "stops on the last frame");
  assert.ok(seconds > 4 && seconds < 7, `5 s of project played in ${seconds.toFixed(1)} s`);
  assert.ok(new Set(frames).size > 60, `${new Set(frames).size} distinct frames drawn`);
  for (const [f, title, lower] of samples) {
    assert.equal(title, f < 90, `title at frame ${f}`);
    assert.equal(lower, f >= 60, `lower third at frame ${f}`);
  }
  assert.equal(await text(page, "timecode"), "00:00:04:29 / 00:00:05:00");

  // Undo removes the lower third and the track made for it (one edit), then the title.
  await meta(page, "KeyZ");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=timeline-item]").length === 1);
  assert.deepEqual(await trackIds(page), ["text", "main", "audio"]);
  assert.ok(await frameOf(page) <= 90, "the playhead is clamped to the shorter project (at most its end)");
  await page.click("[data-testid=undo]");
  await waitFor(page, "[data-testid=timeline-empty]");
  assert.equal(await page.$(".pv-text"), null);
  assert.deepEqual(onDisk().tracks.map((t: { items: unknown[] }) => t.items.length), [0, 0, 0]);
  await meta(page, "KeyZ", true);
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=timeline-item]").length === 1);

  // End puts the playhead after the last frame (nothing drawn there; → goes no further), so a
  // text added there follows the title instead of overlapping its last frame.
  await page.click("[data-testid=timeline]");
  await page.keyboard.press("End");
  await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === 90);
  assert.equal(await text(page, "timecode"), "00:00:03:00 / 00:00:03:00");
  assert.equal(await page.$(".pv-text"), null, "nothing is drawn at the end");
  assert.deepEqual(await page.$$eval("[data-testid=step-forward],[data-testid=to-end]", (b) => (b as Array<HTMLButtonElement>).map((x) => x.disabled)), [true, true]);
  await page.keyboard.press("ArrowRight");
  await sleep(100);
  assert.equal(await frameOf(page), 90, "→ stops at the end");
  await page.click("[data-testid=text-preset][data-preset=text]");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=timeline-item]").length === 2);
  const added = (await items(page)).find((i) => i.id !== "title-1")!;
  assert.deepEqual({ ...added, id: undefined }, { id: undefined, type: "text", start: 90, duration: 90, track: "text" });
  assert.equal(await frameOf(page), 90, "the playhead stays where the text was added");
  // Play from the end starts over.
  await page.keyboard.press("End");
  await page.keyboard.press("Space");
  await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) < 90);
  await page.keyboard.press("Space");
  assert.deepEqual(app.errors, []);
  await app.close();
  apps.delete(app);
});

/** SSIM between two images, both scaled to 480×270 grey. 1 means identical. */
function ssim(a: string, b: string) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
}
/** Best SSIM between a preview shot and any source frame within ±0.1 s of `seconds`. */
function bestMatch(src: string, shot: string, seconds: number, tag: string) {
  const pattern = out(`preview-src-${tag}-%02d.png`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(Math.max(0, seconds - 0.1)), "-i", src, "-t", "0.2", "-map", "0:v:0", "-vf", "scale=480:270", pattern]);
  let best = 0;
  for (let i = 1; existsSync(pattern.replace("%02d", String(i).padStart(2, "0"))); i++) best = Math.max(best, ssim(shot, pattern.replace("%02d", String(i).padStart(2, "0"))));
  return best;
}
const videos = (page: Page) =>
  page.$$eval("video[data-item]", (els) =>
    els.map((e) => {
      const v = e as HTMLVideoElement;
      return { id: v.dataset.item, src: v.src, time: v.currentTime, paused: v.paused, seeking: v.seeking, ready: v.readyState, opacity: Number(v.style.opacity) };
    }),
  );
/** Put the playhead on exactly `target`: click the ruler near it, then step with the arrow keys. */
async function seekTo(page: Page, target: number, fps: number) {
  const ruler = (await (await page.$("[data-testid=ruler]"))!.boundingBox())!;
  const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
  const scroll = await page.$eval(".bottom-body", (el) => el.scrollLeft);
  await page.mouse.click(Math.min(ruler.x + ruler.width - 2, ruler.x + target * ppf - scroll), ruler.y + ruler.height / 2);
  for (let i = 0; i < 400; i++) {
    const f = await frameOf(page);
    if (f === target) return;
    const gap = target - f;
    const shift = Math.abs(gap) >= fps;
    if (shift) await page.keyboard.down("Shift");
    await page.keyboard.press(gap > 0 ? "ArrowRight" : "ArrowLeft");
    if (shift) await page.keyboard.up("Shift");
  }
  assert.fail(`couldn't put the playhead on ${target} (at ${await frameOf(page)})`);
}
/** Average colour of the middle of an image, [r, g, b]. */
function rgbCenter(png: string) {
  return [...execFileSync("ffmpeg", ["-v", "error", "-i", png, "-vf", "crop=iw/4:ih/4,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])];
}
async function settle(page: Page) {
  // D221: 4K footage under a scrub canvas seeks its <video> once the playhead rests; the canvas goes once it has.
  await page.waitForFunction(() => ![...document.querySelectorAll<HTMLCanvasElement>("canvas.pv-scrub")].some((c) => c.style.visibility !== "hidden"), { timeout: 10000 });
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => !v.seeking && v.readyState >= 2), { timeout: 10000 });
  await sleep(150);
}

test("the DJI clip added to main plays, scrubs to f / fps, and drops onto the timeline", { skip: skipClip, timeout: 180000 }, async (t) => {
  // A project with the demo's media entry (already probed) and nothing on the timeline.
  const demo = JSON.parse(readFileSync(demoProject(), "utf8"));
  const src: string = demo.media[0].path;
  const dir = join(root, "Clip.uncut");
  mkdirSync(dir);
  const fps = demo.canvas.fps as number;
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Clip",
      canvas: demo.canvas,
      media: demo.media,
      tracks: [
        { id: "text", kind: "text", name: "Text", items: [] },
        { id: "main", kind: "video", role: "main", name: "Main", items: [] },
        { id: "audio", kind: "audio", name: "Audio", items: [] },
      ],
    }),
  );
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data-clip"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  apps.add(app);
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor(page, "[data-testid=media-tile]");

  // + on the tile appends the whole clip to the main track.
  const frames = demo.media[0].probe.frames as number;
  await page.hover("[data-testid=media-tile]");
  await page.click("[data-testid=add-to-timeline]", { clickCount: 2 });
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=timeline-item]").length === 1);
  await sleep(500);
  assert.equal(await page.$("[data-testid=editor-error]"), null, "a double click is one add, not a refused second edit");
  assert.deepEqual(await items(page), [{ id: "clip-1", type: "clip", start: 0, duration: frames, track: "main" }]);
  const [video] = await videos(page);
  assert.match(video!.src, /^http:\/\/127\.0\.0\.1:\d+\/media\/file\/m-flight\?token=[^&]+&v=/, "footage comes from the server, not file://");

  // A decoded frame, not black.
  await settle(page);
  const first = await shotPreview(page, "clip-0");
  const px = grey(first, 160, 90);
  const mean = px.reduce((a, b) => a + b, 0) / px.length;
  assert.ok(mean > 20, `preview is black (mean grey ${mean.toFixed(1)})`);
  await page.screenshot({ path: out("preview-clip-editor.png") });

  // Scrub on the ruler: wherever the playhead lands (frame f), the video is at f / fps and the
  // picture matches the source there, not some other moment.
  const ruler = (await (await page.$("[data-testid=ruler]"))!.boundingBox())!;
  for (const [i, share] of [0.17, 0.43, 0.71].entries()) {
    await page.mouse.click(ruler.x + ruler.width * share, ruler.y + ruler.height / 2);
    await settle(page);
    const f = await frameOf(page);
    assert.equal(await page.$eval("[data-testid=playhead]", (el) => Number((el as HTMLElement).dataset.frame)), f);
    const [v] = await videos(page);
    // The video is asked for exactly f / fps (D38); which source frame shows there is what the
    // pixel check below judges, within ±0.1 s because the file has dropped-frame gaps.
    assert.ok(Math.abs(v!.time - f / fps) < 0.5 / fps, `frame ${f}: video at ${v!.time.toFixed(4)} s, expected ${(f / fps).toFixed(4)} s`);
    const shot = await shotPreview(page, `scrub-${i}`);
    const right = bestMatch(src, shot, f / fps, `scrub-${i}`);
    const wrong = bestMatch(src, shot, ((f + 40 * fps) % frames) / fps, `scrub-${i}-other`);
    t.diagnostic(`frame ${f}: SSIM ${right.toFixed(3)} at f/fps, ${wrong.toFixed(3)} 40 s away`);
    assert.ok(right > 0.6, `frame ${f}: preview doesn't match the source at ${(f / fps).toFixed(2)} s (SSIM ${right})`);
    assert.ok(right > wrong + 0.05, `frame ${f}: matches another moment as well (${right} vs ${wrong})`);
  }
  // A frame step moves the video by exactly 1 / fps, each way.
  const before = await frameOf(page);
  const t0Video = (await videos(page))[0]!.time;
  for (const [key, delta] of [["ArrowRight", 1], ["ArrowRight", 1], ["ArrowLeft", -1]] as const) {
    const was = await frameOf(page);
    const wasTime = (await videos(page))[0]!.time;
    await page.keyboard.press(key);
    await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, was + delta);
    await settle(page);
    const now = (await videos(page))[0]!.time;
    assert.ok(Math.abs(now - wasTime - delta / fps) < 0.25 / fps, `${key}: video moved ${(now - wasTime).toFixed(4)} s, expected ${(delta / fps).toFixed(4)} s`);
  }
  assert.ok(Math.abs((await videos(page))[0]!.time - t0Video - 1 / fps) < 0.25 / fps);

  // Playback: the clock runs in real time and the video plays along.
  await page.keyboard.press("Space");
  const t0 = Date.now();
  await sleep(1500);
  const playing = await videos(page);
  const f1 = await frameOf(page);
  const elapsed = (Date.now() - t0) / 1000;
  await page.keyboard.press("Space");
  const rate = (f1 - (before + 1)) / elapsed;
  t.diagnostic(`played at ${rate.toFixed(1)} fps; video ${JSON.stringify(playing)}`);
  assert.ok(rate > 40 && rate < 75, `played ${rate.toFixed(1)} frames per second`);
  assert.equal(playing[0]!.paused, false, "the video was playing");
  await settle(page);
  const paused = await frameOf(page);
  assert.ok(Math.abs((await videos(page))[0]!.time - paused / fps) < 0.5 / fps, "after pausing the video is at the playhead");

  // Dragging the tile onto the timeline appends it again, after the first clip.
  const lanes = (await (await page.$("[data-testid=lane][data-track=main]"))!.boundingBox())!;
  const cdp = await page.createCDPSession();
  const data = { items: [{ mimeType: "application/x-uncut-media", data: "m-flight" }], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    await cdp.send("Input.dispatchDragEvent", { type, x: lanes.x + lanes.width / 2, y: lanes.y + lanes.height / 2, data });
  }
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=timeline-item]").length === 2);
  assert.deepEqual((await items(page))[1], { id: "clip-2", type: "clip", start: frames, duration: frames, track: "main" });
  assert.equal(await frameOf(page), frames, "the playhead goes to the added clip");

  // The cut between the two clips. A second before it, the next clip is already loaded, hidden
  // and parked on its first frame (warm-up), behind the visible one.
  await seekTo(page, frames - fps, fps);
  await settle(page);
  let vs = await videos(page);
  assert.deepEqual(vs.map((v) => [v.id, v.opacity]).sort(), [["clip-1", 1], ["clip-2", 0]], `warm-up: ${JSON.stringify(vs)}`);
  assert.ok(vs.find((v) => v.id === "clip-2")!.time < 0.5 / fps, "the next clip waits on its first frame");
  // Last frame of clip 1, then the boundary frame shows clip 2 from its start.
  await seekTo(page, frames - 1, fps);
  await settle(page);
  vs = await videos(page);
  const outgoing = vs.find((v) => v.opacity === 1)!;
  assert.equal(outgoing.id, "clip-1");
  assert.ok(Math.abs(outgoing.time - (frames - 1) / fps) < 0.5 / fps, `last frame of clip 1 at ${outgoing.time}`);
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction((f) => Number(document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.frame) === f, {}, frames);
  await settle(page);
  vs = await videos(page);
  assert.deepEqual(vs.map((v) => [v.id, v.opacity]), [["clip-2", 1]], `after the cut: ${JSON.stringify(vs)}`);
  assert.ok(vs[0]!.time < 0.5 / fps, `clip 2 starts at its first frame (${vs[0]!.time})`);
  const cutShot = await shotPreview(page, "cut");
  const atStart = bestMatch(src, cutShot, 0, "cut-start");
  const atEnd = bestMatch(src, cutShot, (frames - 1) / fps, "cut-end");
  t.diagnostic(`at the cut: SSIM ${atStart.toFixed(3)} vs source start, ${atEnd.toFixed(3)} vs source end`);
  assert.ok(atStart > 0.6 && atStart > atEnd + 0.05, `the boundary frame shows clip 2's first frame (${atStart} vs ${atEnd})`);

  // Play across the cut: on every drawn frame the visible video is the clip the timeline says,
  // at the time the clock says (within a few frames), on both sides of the cut.
  await seekTo(page, frames - 90, fps);
  await settle(page);
  const samples = await page.evaluate(
    () =>
      new Promise<Array<{ f: number; id: string | undefined; time: number; stable: boolean }>>((done) => {
        const frame = document.querySelector<HTMLElement>("[data-testid=preview-frame]")!;
        const got: Array<{ f: number; id: string | undefined; time: number; stable: boolean }> = [];
        const start = performance.now();
        const sample = () => {
          const v = [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].find((e) => e.style.opacity === "1");
          got.push({ f: Number(frame.dataset.frame), id: v?.dataset.item, time: v?.currentTime ?? NaN, stable: !!v && !v.paused && !v.seeking && v.readyState >= 3 });
          if (performance.now() - start > 3000) {
            window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true }));
            return done(got);
          }
          requestAnimationFrame(sample);
        };
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true }));
        requestAnimationFrame(sample);
      }),
  );
  const drifts: Array<number> = [];
  for (const s of samples) {
    if (s.id === undefined) continue;
    assert.equal(s.id, s.f < frames ? "clip-1" : "clip-2", `frame ${s.f} shows ${s.id}`);
    if (!s.stable) continue;
    const expected = s.f < frames ? s.f / fps : (s.f - frames) / fps;
    drifts.push(Math.abs(s.time - expected));
  }
  drifts.sort((a, b) => a - b);
  const p90 = drifts[Math.floor(drifts.length * 0.9)]!;
  t.diagnostic(`playback across the cut: ${samples.length} samples, ${drifts.length} stable, drift median ${(drifts[drifts.length >> 1]! * 1000).toFixed(0)} ms, p90 ${(p90 * 1000).toFixed(0)} ms, max ${(drifts.at(-1)! * 1000).toFixed(0)} ms`);
  assert.ok(samples.some((s) => s.f < frames - 30) && samples.some((s) => s.f > frames + 30), `played across the cut: ${samples[0]!.f}…${samples.at(-1)!.f}`);
  assert.ok(samples.some((s) => s.stable && s.id === "clip-1") && samples.some((s) => s.stable && s.id === "clip-2"), "both clips played");
  assert.ok(p90 < 4 / fps, `video and clock drift apart: p90 ${p90.toFixed(3)} s`);
  assert.ok(drifts.at(-1)! < 0.2, `video and clock drift apart: max ${drifts.at(-1)!.toFixed(3)} s`);

  // Undo removes it again.
  await meta(page, "KeyZ");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=timeline-item]").length === 1);
  assert.equal(JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).tracks[1].items.length, 1);
  assert.deepEqual(app.errors, []);
  await app.close();
  apps.delete(app);
});

test("a relinked file and another project with the same media ids show their own footage", { skip, timeout: 120000 }, async () => {
  const red = join(root, "red.mp4");
  const blue = join(root, "blue.mp4");
  for (const [path, colour] of [[red, "red"], [blue, "blue"]] as const) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:size=320x180:rate=30`, "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", path]);
  }
  const probe = { frames: 60, fps: 30, width: 320, height: 180, hasAudio: false };
  const write = (dir: string, name: string, path: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "project.json"),
      JSON.stringify({
        format: "uncut/0",
        name,
        canvas: { width: 1920, height: 1080, fps: 30 },
        media: [{ id: "m-a", kind: "video", name: "a.mp4", path, probe }],
        tracks: [
          { id: "text", kind: "text", name: "Text", items: [] },
          { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-a", in: 0, duration: 60 }] },
          { id: "audio", kind: "audio", name: "Audio", items: [] },
        ],
      }),
    );
  };
  const one = join(root, "One.uncut");
  const two = join(root, "Two.uncut");
  write(one, "One", red);
  write(two, "Two", red);
  const app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data-relink"), UNCUT_TEST_DIALOG: JSON.stringify([one, two]) } });
  apps.add(app);
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor(page, "video[data-item]");
  await settle(page);
  const colour = async (name: string) => rgbCenter(await shotPreview(page, name));
  const isRed = ([r, g, b]: Array<number>) => r! > 150 && g! < 80 && b! < 80;
  const isBlue = ([r, g, b]: Array<number>) => b! > 150 && r! < 80 && g! < 80;
  let c = await colour("relink-before");
  assert.ok(isRed(c), `red first: ${c}`);
  const srcBefore = (await videos(page))[0]!.src;

  // Relink by hand: same media id, another file. The next edit is refused (changed on disk);
  // reloading must show the new file, not the old <video>'s frames.
  write(one, "One", blue);
  await page.click("[data-testid=rail-text]");
  await page.click("[data-testid=text-preset][data-preset=title]");
  await waitFor(page, "[data-testid=changed-on-disk]");
  await page.click("[data-testid=reload]");
  await page.waitForFunction((before) => document.querySelector<HTMLVideoElement>("video[data-item]")?.src !== before, {}, srcBefore);
  await settle(page);
  c = await colour("relink-after");
  assert.ok(isBlue(c), `blue after the relink: ${c}`);

  // Another project whose clip has the same item and media ids (but a red file): its own footage.
  await page.click("[data-testid=timeline]");
  await meta(page, "KeyO");
  await page.waitForFunction(() => document.title === "Two");
  await waitFor(page, "video[data-item]");
  await settle(page);
  c = await colour("switched");
  assert.ok(isRed(c), `red in the other project: ${c}`);
  // Nothing asked the server for media that isn't in the open project (that would be a 404 here).
  assert.deepEqual(app.errors, []);
  await app.close();
  apps.delete(app);
});
