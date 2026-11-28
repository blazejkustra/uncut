// Timeline v2 phase 3 (D349) on the packaged app: a video with sound dropped on V1 lands as the
// clip and its sound on A1 (a full-height waveform), linked; a click selects both, ⌥-click one;
// dragging the clip takes its sound; trims of the cut's edges trim the sound too, and a crossfade
// goes on the cut over both pairs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CDPSession, Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make the talk") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
let app: LaunchedApp | undefined;
const out = (name: string) => resolve("test-output", name);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Saved = {
  tracks: Array<{
    id: string;
    kind: string;
    role?: string;
    items: Array<{ id: string; start?: number; gap?: number; in?: number; duration: number; link?: string; mute?: boolean; transitionIn?: { module: string } }>;
  }>;
};
const onDisk = (): Saved => JSON.parse(readFileSync(join(root, "Pairs.uncut", "project.json"), "utf8"));
const main = () => onDisk().tracks.find((t) => t.role === "main")!.items;
const sounds = () =>
  onDisk()
    .tracks.filter((t) => t.kind === "audio")
    .flatMap((t) => t.items);

const revision = (page: Page) => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
async function savedAfter(page: Page, after: number) {
  await page.waitForFunction(
    (r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1] ?? -1) > r,
    { timeout: 10000 },
    after,
  );
  return revision(page);
}
const rect = (page: Page, selector: string) => page.$eval(selector, (el) => el.getBoundingClientRect().toJSON() as DOMRect);
const item = (id: string) => `[data-testid=timeline-item][data-item="${id}"]`;
const selectedIds = (page: Page) => page.$$eval(".clip.selected[data-testid=timeline-item]", (els) => els.map((e) => (e as HTMLElement).dataset.item!).sort());

async function xOf(page: Page, frame: number) {
  const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
  return (await rect(page, "[data-testid=lanes]")).left + frame * ppf;
}
async function laneY(page: Page, track: string) {
  const r = await rect(page, `[data-testid=lane][data-track="${track}"]`);
  return r.top + r.height / 2;
}
async function dropMedia(cdp: CDPSession, x: number, y: number, media: string) {
  const data = { items: [{ mimeType: "application/x-uncut-media", data: media }], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) await cdp.send("Input.dispatchDragEvent", { type, x, y, data } as never);
}
async function drag(page: Page, selector: string, dx: number) {
  const r = await rect(page, selector);
  const from = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y, { steps: 5 });
  await page.mouse.move(from.x + dx, from.y, { steps: 5 });
  await sleep(80);
  await page.mouse.up();
}
async function altClick(page: Page, selector: string) {
  await page.keyboard.down("Alt");
  await page.click(selector);
  await page.keyboard.up("Alt");
}

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-pairs-")));
  // 6 s of talk: syllables in bursts with pauses between them.
  execFileSync("ffmpeg", [
    ...["-v", "error", "-y", "-threads", "2"],
    ...["-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:d=6"],
    ...["-f", "lavfi", "-i", "aevalsrc=0.6*sin(2*PI*180*t)*abs(sin(2*PI*2.5*t))*(1+sgn(sin(2*PI*0.5*t+1)+0.3))/2:s=48000:d=6"],
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(root, "Talk.mp4")],
  ]);
  const dir = join(root, "Pairs.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Pairs",
      canvas: { width: 1920, height: 1080, fps: 30 },
      media: [
        {
          id: "m-talk",
          kind: "video",
          name: "Talk.mp4",
          path: join(root, "Talk.mp4"),
          probe: { frames: 180, fps: 30, width: 320, height: 180, hasAudio: true },
        },
      ],
      tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [] }],
    }),
  );
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("timeline v2 phase 3: a dropped talk is a V1 clip and an A1 sound, selected together, moved and trimmed together", { skip, timeout: 180000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([join(root, "Pairs.uncut")]) } });
  const { page } = app;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await page.waitForSelector("[data-testid=editor]", { timeout: 15000 });
  await page.click("[data-testid=bottom-timeline]");
  const cdp = await page.createCDPSession();

  // Dropped on V1: the clip, muted, and its sound on a new audio track, both with one link.
  let rev = await revision(page);
  await dropMedia(cdp, await xOf(page, 5), await laneY(page, "main"), "m-talk");
  rev = await savedAfter(page, rev);
  const [clip] = main();
  const [sound] = sounds();
  assert.ok(clip && sound, JSON.stringify(onDisk()));
  assert.equal(clip.mute, true);
  assert.ok(clip.link && clip.link === sound.link);
  assert.deepEqual([sound.start, sound.in ?? 0, sound.duration], [0, clip.in ?? 0, clip.duration]);
  const audioTrack = onDisk().tracks.find((t) => t.kind === "audio")!.id;
  await page.waitForSelector(`[data-testid=lane][data-track="${audioTrack}"] ${item(sound.id)} [data-testid=waveform]:not(.compact)`, { timeout: 10000 });
  assert.equal(await page.$(`${item(clip.id)} [data-testid=waveform]`), null, "the muted clip draws no waveform of its own");
  const wave = await rect(page, `${item(sound.id)} [data-testid=waveform]`);
  assert.ok(wave.height > 30, `the A1 waveform is tall (${wave.height} px)`);

  // A second talk after it: its sound on the same A1.
  await dropMedia(cdp, await xOf(page, 200), await laneY(page, "main"), "m-talk");
  rev = await savedAfter(page, rev);
  const second = main()[1]!;
  const secondSound = sounds().find((s) => s.link === second.link && s.id !== second.id)!;
  assert.equal(onDisk().tracks.filter((t) => t.kind === "audio").length, 1);
  assert.equal(secondSound.start, 180);
  await page.screenshot({ path: out("d349-dropped.png") });

  // A click on either selects both; ⌥-click selects just the one.
  await page.click(item(clip.id));
  assert.deepEqual(await selectedIds(page), [clip.id, sound.id].sort());
  await page.waitForSelector("[data-testid=inspector-multi]", { hidden: true });
  await page.click(item(secondSound.id));
  assert.deepEqual(await selectedIds(page), [second.id, secondSound.id].sort());
  await page.screenshot({ path: out("d349-selected-both.png") });
  await altClick(page, item(secondSound.id));
  assert.deepEqual(await selectedIds(page), [secondSound.id]);

  // Dragging the second clip right leaves a gap before it on V1; its sound moves as far.
  const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
  await drag(page, item(second.id), 30 * ppf);
  rev = await savedAfter(page, rev);
  const gap = main()[1]!.gap ?? 0;
  assert.ok(gap > 10, `a gap before it (${gap})`);
  assert.equal(sounds().find((s) => s.id === secondSound.id)!.start, 180 + gap);

  // Back together, then both edges of the cut trimmed (the sounds follow), and a crossfade on it.
  await drag(page, item(second.id), -gap * ppf - 20);
  rev = await savedAfter(page, rev);
  assert.equal(main()[1]!.gap ?? 0, 0);
  await drag(page, `${item(clip.id)} [data-testid=trim-end]`, -30 * ppf);
  rev = await savedAfter(page, rev);
  const firstEnd = main()[0]!.duration;
  assert.ok(firstEnd < 170, `trimmed (${firstEnd})`);
  assert.equal(sounds().find((s) => s.id === sound.id)!.duration, firstEnd);
  await drag(page, `${item(second.id)} [data-testid=trim-start]`, 30 * ppf);
  rev = await savedAfter(page, rev);
  const trimmed = main()[1]!;
  const trimmedSound = sounds().find((s) => s.id === secondSound.id)!;
  assert.ok((trimmed.in ?? 0) > 10, `trimmed its start (${trimmed.in})`);
  assert.deepEqual([trimmedSound.in, trimmedSound.duration, trimmedSound.start], [trimmed.in, trimmed.duration, firstEnd]);

  await page.click(`[data-testid=cut-point][data-item="${second.id}"]`);
  await page.click("[data-testid=rail-transitions]");
  await page.waitForSelector('[data-testid=transition-tile][data-module="transition.crossfade"]');
  await page.click('[data-testid=transition-tile][data-module="transition.crossfade"]');
  rev = await savedAfter(page, rev);
  assert.equal(main()[1]!.transitionIn?.module, "transition.crossfade");
  await page.waitForSelector(`[data-testid=lane][data-track="${audioTrack}"] ${item(secondSound.id)}`);
  await page.screenshot({ path: out("d349-crossfade.png") });
});
