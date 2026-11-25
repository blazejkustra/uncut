// The preview's sound keeps playing (packaged app, background window). Reported: "sometimes audio
// is not playing when I want to preview". The playback engine (D333) draws video clips with their
// <video> paused, so a clip's sound and every audio item play through the mix's own <audio>
// elements on the playback clock. A clip with a 660 Hz tone and a 440 Hz music tone play from
// several points on a throttled renderer: the mix never seeks one of its <audio> elements again
// within half a second while it plays (each seek stalls it), and a tone is missing in at most a few
// of the samples.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";

import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { viewerPrefs } from "../helpers/viewer-prefs.ts";

const APP = resolve(process.env.UNCUT_TEST_APP ?? "dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test footage") : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 30;
const SECONDS = 20;
/** RMS of both tones (0.3 amplitude each): 0.3; of one: 0.21. */
const BOTH_RMS = 0.26;
let root = "";
let app: LaunchedApp | undefined;
let page: Page;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Seek {
  readonly item: string;
  readonly t: number;
  readonly from: number;
  readonly to: number;
}
interface Probe {
  seeks: Array<Seek>;
  samples: Array<{ rms: number; sounding: number }>;
  timer: number;
}

/** From now on, every currentTime set on a playing <audio> (the mix's own) is recorded. */
const recordSeeks = () =>
  page.evaluate(() => {
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")!;
    const probe = { seeks: [], samples: [], timer: 0 } as unknown as Probe;
    (globalThis as unknown as { __probe: Probe }).__probe = probe;
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      get() {
        return d.get!.call(this);
      },
      set(v: number) {
        if (this instanceof HTMLAudioElement && !this.paused)
          probe.seeks.push({ item: this.dataset.item ?? "", t: performance.now(), from: d.get!.call(this), to: v });
        d.set!.call(this, v);
      },
    });
  });

/** Sample the mix's output level and its sounding items every 50 ms in the page, starting `after` ms from now. */
const startSampling = (after: number) =>
  page.evaluate((wait) => {
    const probe = (globalThis as unknown as { __probe: Probe }).__probe;
    const hook = (globalThis as unknown as { __uncutAudio: { level(): { rms: number }; state(): { items: Array<{ gain: number }> } } }).__uncutAudio;
    probe.seeks.length = 0;
    probe.samples.length = 0;
    const from = performance.now() + wait;
    probe.timer = window.setInterval(() => {
      if (performance.now() < from) return;
      probe.samples.push({ rms: hook.level().rms, sounding: hook.state().items.filter((i) => i.gain > 0.01).length });
    }, 50);
  }, after);

const stopSampling = () =>
  page.evaluate(() => {
    const probe = (globalThis as unknown as { __probe: Probe }).__probe;
    clearInterval(probe.timer);
    return { seeks: probe.seeks.splice(0), samples: probe.samples.splice(0) };
  });

async function seekTo(frame: number) {
  const r = (await (await page.$("[data-testid=ruler]"))!.boundingBox())!;
  const ppf = Number(await page.$eval("[data-testid=timeline]", (el) => (el as HTMLElement).dataset.ppf));
  await page.mouse.click(r.x + frame * ppf + 0.5, r.y + 10);
  await page.waitForFunction((f) => Math.abs(Number(document.querySelector<HTMLElement>("[data-testid=playhead]")!.dataset.frame) - f) <= 2, {}, frame);
}

/** Play from `frame` with the play button for `ms`: the <audio> seeks while playing, and the share of samples (after 0.4 s) with a tone missing. */
async function listen(frame: number, ms = 3000) {
  await seekTo(frame);
  await page.mouse.move(10, 10);
  await sleep(1500);
  await startSampling(400);
  await page.click("[data-testid=play]");
  await sleep(ms);
  await page.click("[data-testid=play]");
  const { seeks, samples } = await stopSampling();
  const audible = samples.filter((s) => s.sounding > 0);
  const missing = audible.filter((s) => s.rms < BOTH_RMS).length / Math.max(1, audible.length);
  return { frame, seeks, missing, audible: audible.length };
}

/** The shortest time (ms) between two seeks of the same element, Infinity with fewer than two. */
function closestSeeks(seeks: ReadonlyArray<Seek>) {
  let closest = Infinity;
  const last = new Map<string, number>();
  for (const s of seeks) {
    const before = last.get(s.item);
    if (before !== undefined) closest = Math.min(closest, s.t - before);
    last.set(s.item, s.t);
  }
  return closest;
}

before(async () => {
  if (skip) return;
  await lockApps();
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-audio-sync-app-")));
  const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", "-threads", "2", "-filter_threads", "2", ...args]);
  ff(
    ...["-f", "lavfi", "-i", `testsrc2=s=1280x720:r=${FPS}`, "-f", "lavfi", "-i", "aevalsrc=0.3*sin(2*PI*660*t):s=48000"],
    ...[
      "-t",
      String(SECONDS),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-g",
      "30",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      join(root, "talk.mp4"),
    ],
  );
  ff("-f", "lavfi", "-i", `aevalsrc=0.3*sin(2*PI*440*t):s=48000:d=${SECONDS}`, "-c:a", "aac", join(root, "music.m4a"));
  const frames = SECONDS * FPS;
  const dir = writeProject(root, "Sync", {
    format: "uncut/0",
    name: "Sync",
    canvas: { width: 1920, height: 1080, fps: FPS },
    media: [
      { id: "m-talk", kind: "video", name: "talk.mp4", path: join(root, "talk.mp4"), probe: { frames, fps: FPS, width: 1280, height: 720, hasAudio: true } },
      { id: "m-music", kind: "audio", name: "music.m4a", path: join(root, "music.m4a"), probe: { frames, hasAudio: true } },
    ],
    tracks: [
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "talk", type: "clip", media: "m-talk", in: 0, duration: frames }] },
      { id: "music", kind: "audio", name: "Music", items: [{ id: "song", type: "audio", media: "m-music", in: 0, start: 0, duration: frames }] },
    ],
  });
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: FAKE } });
  page = app.page;
  await waitForWelcome(page);
  await viewerPrefs(page, { atTarget: false });
  await page.click("[data-testid=open-project]");
  await page.waitForSelector('[data-testid=timeline-item][data-item="song"]', { timeout: 30000 });
  await sleep(3000);
  // A busy renderer (a heavy project, a loaded Mac): an <audio> then takes longer than DRIFT_S to start sounding.
  await (await page.createCDPSession()).send("Emulation.setCPUThrottlingRate", { rate: 8 });
  await recordSeeks();
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

test(
  "the mix's <audio> elements keep playing on a busy renderer: no seek right after the last, no tone missing for long",
  { skip, timeout: 120000 },
  async () => {
    const runs = [];
    for (const frame of [30, 150, 300, 420]) runs.push(await listen(frame));
    const report = JSON.stringify(
      runs.map((r) => ({ frame: r.frame, seeks: r.seeks.length, closest: Math.round(closestSeeks(r.seeks)), missing: r.missing, audible: r.audible })),
    );
    for (const r of runs) {
      assert.ok(r.audible > 10, `both tones were to sound while playing from ${r.frame}: ${report}`);
      assert.ok(closestSeeks(r.seeks) > 500, `no <audio> seeked twice within half a second from ${r.frame}: ${JSON.stringify(r.seeks)} (${report})`);
      assert.ok(r.missing <= 0.2, `a tone missing in at most 20% of the samples from ${r.frame}: ${report}`);
    }
  },
);
