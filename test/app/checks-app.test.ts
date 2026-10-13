// Phase 6 chunk 8 (D90, D91) on the packaged app, run invisibly and muted:
// - K1 (D121): the Checks tab and the export dialog's checks line are gone; the checks stay in
//   core (projectChecks) and with the agent (project_check); Export is never blocked;
// - the Audio tab's music library: five tracks, mood / tempo / search filters, play to listen, +
//   copies the track into the project's media/ folder and puts it on the audio track at the
//   playhead (as long as the video, with fades) in one edit that one ⌘Z takes back; a double click
//   adds once; with the audio track busy the next one gets its own Music track.
// Screenshot: test-output/music-library.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { MUSIC_TRACKS, projectChecks, type Project } from "../../packages/core/src/index.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const revision = (page: Page) => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
async function savedAfter(page: Page, after: number) {
  await page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1] ?? -1) > r, { timeout: 15000 }, after);
  await sleep(150);
  return revision(page);
}
const meta = async (page: Page, key: "KeyZ", shift = false) => {
  await page.keyboard.down("Meta");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Meta");
};
const rows = (page: Page, selector: string) => page.$$eval(selector, (els) => els.map((e) => (e as HTMLElement).dataset.id ?? (e as HTMLElement).dataset.rule ?? ""));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-checks-")));
  // 8 s of silent test footage, portrait.
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=540x676:rate=30", "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "Shot.mp4")]);
  const dir = join(root, "Taste.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Taste",
      canvas: { width: 1080, height: 1350, fps: 30 },
      textLooks: 1,
      media: [{ id: "m-shot", kind: "video", name: "Shot.mp4", path: join(root, "Shot.mp4"), probe: { frames: 240, fps: 30, width: 540, height: 676, hasAudio: false } }],
      tracks: [
        {
          id: "text",
          kind: "text",
          name: "Text",
          items: [
            { id: "title", type: "text", start: 60, duration: 30, text: "We built it seven times.", transform: { x: 90, y: 300 }, style: { preset: "text.title", size: 88 } },
            { id: "langs", type: "text", start: 150, duration: 90, text: "Swift · Kotlin · Dart", transform: { x: 90, y: 900 }, style: { preset: "text.header", size: 56 } },
          ],
        },
        { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-shot", in: 0, duration: 240, animation: { in: { module: "move.fade", duration: 15 } } }] },
        { id: "audio", kind: "audio", name: "Audio", items: [] },
      ],
    }),
  );
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(join(root, "plan.json"), JSON.stringify([[{ text: "Noted." }]]));
});
after(async () => {
  for (const app of apps) await app.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("no Checks tab or export checks line (K1); the music library adds a track in one edit", { skip, timeout: 300000 }, async () => {
  const dir = join(root, "Taste.uncut");
  const app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: FAKE, FAKE_PLAN: join(root, "plan.json"), FAKE_PROMPT_LOG: join(root, "prompts.jsonl") },
  });
  apps.add(app);
  const { page } = app;
  const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=open-project]");
    await waitFor(page, "[data-testid=editor]");
    let rev = await revision(page);

    // K1 (D121): no Checks tab and no checks line in the export dialog; the project still has
    // warnings (core projectChecks, what the agent's project_check returns) and Export isn't blocked.
    const warnings = projectChecks(onDisk()).filter((c) => c.severity === "warn");
    for (const id of ["trailing-period", "dot-separators", "text-read-time", "frame-one"]) assert.ok(warnings.some((c) => c.id === id), id);
    assert.equal(await page.$("[data-testid=tab-checks]"), null);
    assert.equal(await page.$("[data-testid=checks-count]"), null);
    await page.click("[data-testid=export-button]");
    await waitFor(page, "[data-testid=export-form]");
    assert.equal(await page.$("[data-testid=export-checks]"), null);
    assert.equal(await page.$eval("[data-testid=export-start]", (el) => (el as HTMLButtonElement).disabled), false);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-testid=export-modal]"), { timeout: 5000 });

    // The music library: five tracks; mood, tempo and search narrow them; clearing brings them back.
    await page.click("[data-testid=rail-audio]");
    await waitFor(page, "[data-testid=music-library]");
    assert.deepEqual(await rows(page, "[data-testid=music-row]"), MUSIC_TRACKS.map((t) => t.id));
    await page.click('[data-testid=music-mood][data-mood="calm"]');
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=music-row]").length === 1);
    assert.deepEqual(await rows(page, "[data-testid=music-row]"), ["cozy-4"]);
    await page.click('[data-testid=music-mood][data-mood="calm"]');
    await page.click('[data-testid=music-tempo][data-tempo="medium"]');
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=music-row]").length === 1);
    assert.deepEqual(await rows(page, "[data-testid=music-row]"), ["cozy-3"]);
    await page.click('[data-testid=music-tempo][data-tempo="medium"]');
    await page.type("[data-testid=music-search]", "rhodes");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=music-row]").length === 1);
    assert.deepEqual(await rows(page, "[data-testid=music-row]"), ["cozy-2"]);
    await page.type("[data-testid=music-search]", " zzz");
    await waitFor(page, "[data-testid=music-empty]");
    await page.click("[data-testid=music-search]", { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid=music-row]").length === 5);

    // Listen (the test window is muted): the button shows it's playing, and the element really plays.
    await page.click('[data-testid=music-row][data-id="cozy-2"] [data-testid=music-play]');
    await page.waitForSelector('[data-testid=music-row][data-id="cozy-2"] [data-testid=music-play][data-playing="true"]');
    await sleep(800);
    assert.equal(await page.$eval('[data-testid=music-row][data-id="cozy-2"] [data-testid=music-play]', (el) => (el as HTMLElement).dataset.playing), "true", "still playing (it loaded from the library route)");
    await page.click('[data-testid=music-row][data-id="cozy-2"] [data-testid=music-play]');
    await page.waitForSelector('[data-testid=music-row][data-id="cozy-2"] [data-testid=music-play][data-playing="false"]');

    // + with the playhead at 0: copied into media/, on the audio track at 0, as long as the video (8 s), with fades; one edit.
    await page.click("[data-testid=ruler]");
    await page.keyboard.press("Home");
    await sleep(200);
    await page.click('[data-testid=music-row][data-id="cozy-2"] [data-testid=music-add]');
    rev = await savedAfter(page, rev);
    const p = onDisk();
    const track = MUSIC_TRACKS.find((t) => t.id === "cozy-2")!;
    const media = p.media.find((m) => m.path === "media/cozy-2.m4a")!;
    assert.deepEqual(media, { id: "m-dusty-rhodes-neo-soul-loop", kind: "audio", name: track.title, path: "media/cozy-2.m4a", probe: { frames: Math.floor(track.seconds * 30), hasAudio: true } });
    assert.ok(readFileSync(join(dir, "media", "cozy-2.m4a")).equals(readFileSync(resolve("assets/music/cozy-2.m4a"))), "the same bytes as the bundled file");
    assert.deepEqual(p.tracks.find((t) => t.id === "audio")!.items, [{ id: "audio-1", type: "audio", media: media.id, in: 0, duration: 240, start: 0, fadeIn: 30, fadeOut: 60 }]);
    await waitFor(page, '[data-testid=timeline-item][data-item="audio-1"]');
    await waitFor(page, '[data-testid=music-row][data-id="cozy-2"]');
    assert.match(await page.$eval('[data-testid=music-row][data-id="cozy-2"] .music-meta', (el) => el.textContent ?? ""), /in the project/);
    // The project's sounds list it too.
    await waitFor(page, `[data-testid=audio-row][data-id="${media.id}"]`);
    await sleep(300);
    await page.screenshot({ path: out("music-library.png") });

    // One ⌘Z takes the media and the item back (the copy stays in media/ and is reused).
    await meta(page, "KeyZ");
    rev = await savedAfter(page, rev);
    const back = onDisk();
    assert.ok(!back.media.some((m) => m.path === "media/cozy-2.m4a"));
    assert.deepEqual(back.tracks.find((t) => t.id === "audio")!.items, []);
    assert.ok(existsSync(join(dir, "media", "cozy-2.m4a")));
    // A double click adds it once (re-added from the same copy).
    await page.click('[data-testid=music-row][data-id="cozy-2"] [data-testid=music-add]', { clickCount: 2 });
    rev = await savedAfter(page, rev);
    await sleep(800);
    assert.equal(await revision(page), rev, "one edit for a double click");
    assert.deepEqual(onDisk().media.filter((m) => m.path.startsWith("media/")).map((m) => m.path), ["media/cozy-2.m4a"]);
    assert.equal(onDisk().tracks.find((t) => t.id === "audio")!.items.length, 1);

    // The audio track is busy at the playhead now: the next track gets its own Music track, as long as the video.
    await page.click('[data-testid=music-row][data-id="cozy-4"] [data-testid=music-add]');
    rev = await savedAfter(page, rev);
    const withTwo = onDisk();
    assert.equal(withTwo.tracks.find((t) => t.id === "audio")!.items.length, 1, "nothing after the first sound");
    const musicTrack = withTwo.tracks.find((t) => t.name === "Music")!;
    assert.ok(musicTrack, "a new Music track");
    assert.deepEqual(musicTrack.items.map((i) => [i.start, i.duration]), [[0, 240]]);
    assert.equal(readdirSync(join(dir, "media")).sort().join(","), "cozy-2.m4a,cozy-4.m4a");
  } finally {
    await app.close();
    apps.delete(app);
  }
});
