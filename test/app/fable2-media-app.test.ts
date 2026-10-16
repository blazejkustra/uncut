// Fable QA round 2, Media/Audio chunk (planning/FEEDBACK.md F8, F26, F27, F28; D167–D170) on the
// packaged app, run invisibly and muted, with real key and pointer events:
// - F8: ⌫ on a used media tile → the in-app confirm (the timeline's selected clip stays) → the media
//   and its items go in one revision; ⌘Z brings both back; the file in media/ is still on disk; an
//   unused media goes from the tile menu without a confirm.
// - F26: list view, sort by name, the used badge, the full name as a tooltip, two-line names, hover scrub.
// - F27: Fit to video from the audio item's menu (looped to the end of the picture, fade out); the
//   fade handle is big enough to grab and dragging it sets a fade in.
// - F28: a sound played with the timeline from the playhead: the playhead moves; stop stops both.
// Screenshots: test-output/fable2-media-*.png, fable2-audio-*.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", `fable2-${name}.png`);
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
type Saved = { id: string; type: string; start?: number; duration: number; media?: string; loop?: boolean; fadeIn?: number; fadeOut?: number };
type SavedProject = { media: Array<{ id: string; name: string; path: string }>; tracks: Array<{ id: string; role?: string; items: Array<Saved> }> };
const onDisk = (): SavedProject => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const itemOnDisk = (id: string) => onDisk().tracks.flatMap((t) => t.items).find((i) => i.id === id);
const mediaIds = () => onDisk().media.map((m) => m.id);
const revision = () => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
const waitRevision = (n: number) => page.waitForFunction((want) => Number(/revision (\d+)/.exec((document.querySelector("[data-testid=saved]") as HTMLElement | null)?.title ?? "")?.[1] ?? -1) >= want, { timeout: 15000 }, n);
const rect = (selector: string) => page.$eval(selector, (el) => el.getBoundingClientRect().toJSON() as DOMRect);
const ppf = () => page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
const item = (id: string) => `[data-testid=timeline-item][data-item="${id}"]`;
const tile = (id: string) => `[data-testid=media-tile][data-id="${id}"]`;
const centre = async (selector: string) => {
  const r = await rect(selector);
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
const key = async (k: Parameters<Page["keyboard"]["press"]>[0], mod?: "Shift" | "Meta") => {
  if (mod) await page.keyboard.down(mod);
  await page.keyboard.press(k);
  if (mod) await page.keyboard.up(mod);
};
const undo = async () => {
  const r = await revision();
  await key("z", "Meta");
  await page.waitForFunction((was) => Number(/revision (\d+)/.exec((document.querySelector("[data-testid=saved]") as HTMLElement | null)?.title ?? "")?.[1] ?? -1) !== was, { timeout: 10000 }, r);
};
const previewFrame = () => page.$eval("[data-testid=preview-frame]", (el) => Number((el as HTMLElement).dataset.frame));
const playing = () => page.$eval("[data-testid=play]", (el) => (el.getAttribute("aria-label") ?? "").startsWith("Pause"));
const tileOrder = () => page.$$eval("[data-testid=media-grid] [data-testid=media-tile]", (els) => els.map((e) => (e as HTMLElement).dataset.id!));

const LONG = "DJI_20261013182112_0042_D_harbour_sunset_wide.mp4";

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-fable2-media-")));
  dir = join(root, "Media.uncut");
  mkdirSync(join(dir, "media"), { recursive: true });
  const lavfi = (args: Array<string>, file: string) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args, file]);
  lavfi(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"], join(root, "Shot.mp4"));
  lavfi(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p"], join(dir, "media", "Used.mp4"));
  lavfi(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p"], join(root, LONG));
  lavfi(["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000", "-t", "4", "-c:a", "aac"], join(root, "Song.m4a"));
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Media",
      canvas: { width: 1920, height: 1080, fps: 30 },
      textLooks: 1,
      media: [
        { id: "m-shot", kind: "video", name: "Shot.mp4", path: join(root, "Shot.mp4"), probe: { frames: 300, fps: 30, width: 640, height: 360, hasAudio: true } },
        { id: "m-used", kind: "video", name: "Used.mp4", path: "media/Used.mp4", probe: { frames: 120, fps: 30, width: 640, height: 360, hasAudio: false } },
        { id: "m-song", kind: "audio", name: "Song.m4a", path: join(root, "Song.m4a"), probe: { frames: 120, hasAudio: true } },
        { id: "m-long", kind: "video", name: LONG, path: join(root, LONG), probe: { frames: 60, fps: 30, width: 320, height: 180, hasAudio: false } },
      ],
      tracks: [
        { id: "overlay", kind: "video", name: "Overlay", items: [{ id: "o1", type: "clip", media: "m-used", in: 0, start: 30, duration: 30, transform: { x: 1200, y: 600, w: 640, h: 360 } }] },
        {
          id: "main",
          kind: "video",
          role: "main",
          name: "Main",
          items: [
            { id: "a", type: "clip", media: "m-used", in: 0, duration: 60 },
            { id: "b", type: "clip", media: "m-shot", in: 0, duration: 240 },
          ],
        },
        { id: "music", kind: "audio", name: "Music", items: [{ id: "song", type: "audio", media: "m-song", in: 0, start: 0, duration: 90 }] },
      ],
    }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("Fable QA round 2, media and audio: remove from project, list and sort, fit to video, fade handles, sounds with the timeline", { skip, timeout: 300000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  await waitFor(item("a"));
  await page.click("[data-testid=bottom-timeline]");
  await page.$eval("[data-testid=rail-media]", (el) => (el as HTMLElement).click());
  await waitFor(tile("m-long"));

  // ---- F26: used badge, full name, two-line names ----
  const used = await page.$$eval("[data-testid=media-tile][data-used=true]", (els) => els.map((e) => (e as HTMLElement).dataset.id!).sort());
  assert.deepEqual(used, ["m-shot", "m-song", "m-used"], "the badge on what the timeline uses");
  assert.equal(await page.$(`${tile("m-long")} [data-testid=media-used]`), null);
  const name = await page.$eval(`${tile("m-long")} [data-testid=tile-name]`, (el) => ({ title: (el as HTMLElement).title, h: el.clientHeight, line: parseFloat(getComputedStyle(el).lineHeight), clamp: getComputedStyle(el).webkitLineClamp }));
  assert.equal(name.title, LONG, "the full name as a tooltip");
  assert.equal(name.clamp, "2");
  assert.ok(name.h > name.line * 1.5, `the long name wraps to two lines (${name.h}px, line ${name.line}px)`);
  await page.screenshot({ path: out("media-grid") });

  // ---- F26: sort by name, list view, remembered ----
  await page.select("[data-testid=media-sort]", "name");
  await page.$eval("[data-testid=media-sort]", (el) => (el as HTMLElement).blur());
  assert.deepEqual(await tileOrder(), ["m-long", "m-shot", "m-song", "m-used"], "A to Z by name");
  await page.click("[data-testid=media-view-list]");
  await waitFor("[data-testid=media-grid][data-view=list]");
  const saved = await page.evaluate(() => localStorage.getItem("uncut.media.view"));
  assert.deepEqual(JSON.parse(saved!), { mode: "list", sort: "name" }, "remembered on this Mac");
  const rows = await page.$$eval("[data-testid=media-grid] [data-testid=media-tile]", (els) => els.map((e) => e.getBoundingClientRect().top));
  assert.ok(rows.every((t, i) => i === 0 || t > rows[i - 1]!), "one per row");
  await page.screenshot({ path: out("media-list") });

  // ---- F26: hover scrub on a video thumbnail ----
  const thumb = await rect(`${tile("m-shot")} .thumb`);
  await page.mouse.move(thumb.left + thumb.width * 0.2, thumb.top + thumb.height / 2);
  await page.mouse.move(thumb.left + thumb.width * 0.7, thumb.top + thumb.height / 2, { steps: 4 });
  await waitFor(`${tile("m-shot")} [data-testid=thumb-scrub]`);
  await page.waitForFunction((sel) => {
    const v = document.querySelector(sel) as HTMLVideoElement | null;
    return !!v && v.readyState >= 2 && v.currentTime > 5;
  }, { timeout: 10000 }, `${tile("m-shot")} [data-testid=thumb-scrub]`);
  await page.screenshot({ path: out("media-scrub") });
  await page.mouse.move(5, 5);
  await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 5000 }, `${tile("m-shot")} [data-testid=thumb-scrub]`);

  // ---- F8: ⌫ on a used tile: the in-app confirm, one revision, ⌘Z brings both back ----
  await page.click(item("b"));
  await page.click(`${tile("m-used")} [data-testid=tile-name]`);
  assert.equal(await page.$eval(tile("m-used"), (el) => el === document.activeElement), true, "the tile has the focus");
  const rev = await revision();
  await key("Backspace");
  await waitFor("[data-testid=remove-media-confirm]");
  assert.match(await page.$eval("[data-testid=remove-media-count]", (el) => el.textContent ?? ""), /2 items on the timeline/);
  await sleep(300);
  assert.equal(await revision(), rev, "nothing removed before the confirm");
  assert.ok(itemOnDisk("b"), "the timeline's selected clip wasn't deleted by the ⌫");
  await page.screenshot({ path: out("media-confirm") });
  await page.click("[data-testid=remove-media-ok]");
  await waitRevision(rev + 1);
  await sleep(300);
  assert.equal(await revision(), rev + 1, "one revision");
  assert.ok(!mediaIds().includes("m-used"), "the media is gone");
  assert.equal(itemOnDisk("a"), undefined);
  assert.equal(itemOnDisk("o1"), undefined);
  assert.ok(itemOnDisk("b"));
  assert.ok(existsSync(join(dir, "media", "Used.mp4")), "the file in media/ stays on disk");
  await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 5000 }, tile("m-used"));
  await page.screenshot({ path: out("media-removed") });
  await page.click(item("b"));
  await undo();
  await waitFor(tile("m-used"));
  await waitFor(item("a"));
  assert.ok(mediaIds().includes("m-used"), "⌘Z: the media is back");
  assert.ok(itemOnDisk("a") && itemOnDisk("o1"), "⌘Z: its items are back, in the same step");

  // Esc cancels; an unused media goes from the tile menu without a confirm.
  await page.click(`${tile("m-used")} [data-testid=tile-name]`);
  await key("Delete");
  await waitFor("[data-testid=remove-media-confirm]");
  await key("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-testid=remove-media-confirm]"), { timeout: 5000 });
  assert.ok(mediaIds().includes("m-used"));
  const rev2 = await revision();
  await page.click(`${tile("m-long")} [data-testid=tile-name]`, { button: "right" });
  await waitFor("[data-testid=context-menu] [data-testid=menu-media-remove]");
  await page.click("[data-testid=menu-media-remove]");
  await waitRevision(rev2 + 1);
  assert.ok(!mediaIds().includes("m-long"));
  assert.equal(await page.$("[data-testid=remove-media-confirm]"), null, "no confirm for an unused media");
  await page.click(item("b"));
  await undo();
  await waitFor(tile("m-long"));

  // ---- F27: the fade handle is easy to grab; dragging it sets a fade in ----
  await page.click(item("song"));
  const handle = await rect(`${item("song")} [data-testid=fade-in-handle]`);
  assert.ok(handle.width >= 10 && handle.height >= 10, `the handle is ${handle.width}×${handle.height}`);
  const lanes = await rect("[data-testid=lanes]");
  const rev3 = await revision();
  const h = { x: handle.left + handle.width / 2, y: handle.top + handle.height / 2 };
  const toX = lanes.left + 30 * (await ppf());
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  await page.mouse.move((h.x + toX) / 2, h.y, { steps: 5 });
  await page.mouse.move(toX, h.y, { steps: 5 });
  await sleep(120);
  await page.mouse.up();
  await waitRevision(rev3 + 1);
  const faded = itemOnDisk("song")!;
  assert.ok(Math.abs((faded.fadeIn ?? 0) - 30) <= 2, `fade in ${faded.fadeIn} frames`);
  await page.screenshot({ path: out("audio-fade") });

  // ---- F27: Fit to video from the item's menu: looped to the end of the picture, fade out ----
  const rev4 = await revision();
  await page.click(item("song"), { button: "right" });
  await waitFor("[data-testid=context-menu] [data-testid=menu-fit-to-video]");
  await page.click("[data-testid=menu-fit-to-video]");
  await waitRevision(rev4 + 1);
  const fit = itemOnDisk("song")!;
  assert.equal(fit.duration, 300, "to the end of the picture (60 + 240 frames)");
  assert.equal(fit.loop, true, "looped: the song is 120 frames");
  assert.equal(fit.fadeOut, 60, "2 s fade out");
  assert.ok(Math.abs((fit.fadeIn ?? 0) - 30) <= 2, "its fade in stays");
  await sleep(200);
  await page.screenshot({ path: out("audio-fit") });
  // The Inspector has it too (already fits: a notice, no edit).
  await waitFor("[data-testid=insp-fit-to-video]");

  // ---- F28: a sound with the timeline from the playhead; stop stops both ----
  await page.$eval("[data-testid=rail-sfx]", (el) => (el as HTMLElement).click());
  await waitFor("[data-testid=library-source]");
  await page.select("[data-testid=library-source]", "pack");
  await waitFor("[data-testid=sfx-row] [data-testid=sound-with-timeline]");
  await key("Escape");
  await page.$eval("[data-testid=to-start]", (el) => (el as HTMLButtonElement).click());
  await page.waitForFunction(() => Number((document.querySelector("[data-testid=preview-frame]") as HTMLElement).dataset.frame) === 0, { timeout: 5000 });
  const together = "[data-testid=sfx-row] [data-testid=sound-with-timeline]";
  await page.click(together);
  await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLElement).dataset.playing === "true", { timeout: 5000 }, together);
  await sleep(700);
  assert.equal(await playing(), true, "the timeline plays");
  const f = await previewFrame();
  assert.ok(f > 5, `the playhead moved (${f})`);
  await page.screenshot({ path: out("audio-together") });
  await page.click(together);
  await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLElement).dataset.playing === "false", { timeout: 5000 }, together);
  assert.equal(await playing(), false, "stop stops the timeline too");
  assert.equal(await page.$$eval("[data-testid=sound-with-timeline][data-playing=true], [data-testid=sfx-play][data-playing=true]", (els) => els.length), 0, "and the sound");
  await page.waitForFunction(() => Number((document.querySelector("[data-testid=preview-frame]") as HTMLElement).dataset.frame) === 0, { timeout: 5000 });
  // Pausing the timeline stops the sound with it.
  await page.click(together);
  await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLElement).dataset.playing === "true", { timeout: 5000 }, together);
  await sleep(300);
  await page.$eval("[data-testid=play]", (el) => (el as HTMLButtonElement).click());
  await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLElement).dataset.playing === "false", { timeout: 5000 }, together);
  assert.deepEqual(app.errors, []);
});
