// Issue #82: no black frames at cuts while the preview plays, on the packaged app (run invisibly and muted).
// The project: one main track of 7 clips cut back to back (6 cuts, 2 s each) from four files, each at
// its own in-point, as real footage is cut: 1920×1080 H.264 with sound, 3840×2160 HEVC with sound
// (the heavy one: long GOP, hardware-encoded, the scrub cache's "heavy" rule), 1280×720 H.264 with
// a look (an effects canvas), and 640×360 H.264 (no D222 untone filter). Played across every cut with
// the scrub cache on and off and the GPU compositor on and off (4 runs).
// What's on screen is read from the compositor's own output: the DevTools screencast (every frame the
// page presents, as a JPEG), decoded afterwards and the preview frame's inside checked for black (most
// of it under luma 24; testsrc2 has under 2 % that dark). Each black frame is matched to the playhead
// and the cut it's near. The glitch probe (test/helpers/preview-glitches.ts) runs alongside and its
// counts are printed. Asserted: no black frame in any run, and no layer that blanks after showing.
// Screenshots: test-output/issue82-*.png (a frame on each side of a cut, and any black frame found).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { countGlitches, startGlitchProbe, stopGlitchProbe, type GlitchLayer } from "../helpers/preview-glitches.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg") : `packaged app not built: run pnpm dist to create ${APP}`;

const FPS = 30;
const CLIP = 2 * FPS;
const out = (name: string) => resolve("test-output", `issue82-${name}.png`);
let root = "";
let dir = "";
let app: LaunchedApp | undefined;
let page: Page;
const layers: Array<GlitchLayer> = [];
const cuts: Array<number> = [];
const waitFor = (selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue82-")));
  dir = join(root, "Cuts.uncut");
  mkdirSync(join(dir, "media"), { recursive: true });
  const seconds = "14";
  const make = (size: string, file: string, codec: Array<string>, sound: boolean) =>
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${FPS}`, ...(sound ? ["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000"] : []), "-t", seconds, ...codec, "-pix_fmt", "yuv420p", ...(sound ? ["-c:a", "aac", "-b:a", "128k", "-shortest"] : []), join(root, file)]);
  const h264 = (g: number) => ["-c:v", "libx264", "-preset", "veryfast", "-g", String(g)];
  make("1920x1080", "HD.mp4", h264(60), true);
  make("3840x2160", "UHD.mp4", ["-c:v", "hevc_videotoolbox", "-b:v", "40M", "-g", "60", "-tag:v", "hvc1"], true);
  make("1280x720", "Mid.mp4", h264(30), false);
  make("640x360", "Small.mp4", h264(30), false);
  const frames = 14 * FPS;
  const media = [
    { id: "m-hd", kind: "video", name: "HD.mp4", path: join(root, "HD.mp4"), probe: { frames, fps: FPS, width: 1920, height: 1080, hasAudio: true } },
    { id: "m-uhd", kind: "video", name: "UHD.mp4", path: join(root, "UHD.mp4"), probe: { frames, fps: FPS, width: 3840, height: 2160, hasAudio: true } },
    { id: "m-mid", kind: "video", name: "Mid.mp4", path: join(root, "Mid.mp4"), probe: { frames, fps: FPS, width: 1280, height: 720, hasAudio: false } },
    { id: "m-small", kind: "video", name: "Small.mp4", path: join(root, "Small.mp4"), probe: { frames, fps: FPS, width: 640, height: 360, hasAudio: false } },
  ];
  const plan: Array<[string, number, boolean?]> = [
    ["m-hd", 30],
    ["m-uhd", 60],
    ["m-mid", 90, true],
    ["m-small", 15],
    ["m-uhd", 200],
    ["m-hd", 150],
    ["m-uhd", 10],
  ];
  const items = plan.map(([m, inF, look], i) => ({ id: `c${i}`, type: "clip", media: m, in: inF, duration: CLIP, ...(look ? { effects: [{ module: "effect.look", params: { look: "warm", intensity: 1 } }] } : {}) }));
  items.forEach((it, i) => {
    layers.push({ id: it.id, kind: "video", track: 0, start: i * CLIP, duration: CLIP, in: it.in, ...(it.effects ? { fx: true } : {}) });
    if (i) cuts.push(i * CLIP);
  });
  writeFileSync(join(dir, "project.json"), JSON.stringify({ format: "uncut/0", name: "Cuts", canvas: { width: 1920, height: 1080, fps: FPS }, media, tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items }] }));
});
after(async () => {
  await app?.close();
  unlockApps();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function clickAt(f: number) {
  const ruler = (await (await page.$("[data-testid=ruler]"))!.boundingBox())!;
  const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
  const scroll = await page.$eval(".bottom-body", (el) => el.scrollLeft);
  await page.mouse.click(ruler.x + 0.5 + f * ppf - scroll, ruler.y + ruler.height / 2);
}

const ready = () => page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>("video[data-item]")].every((v) => v.readyState >= 2 && !v.seeking), { timeout: 20000 });

async function setPreview(scrub: boolean, gpu: boolean) {
  await page.keyboard.down("Meta");
  await page.keyboard.press("Comma");
  await page.keyboard.up("Meta");
  await waitFor("[data-testid=settings]");
  await page.click("[data-testid=settings-nav-app]");
  for (const [id, on] of [["settings-scrub-cache", scrub], ["settings-gpu-compositor", gpu]] as const) {
    await waitFor(`[data-testid=${id}]`);
    const checked = await page.$eval(`[data-testid=${id}]`, (el) => (el as HTMLInputElement).checked);
    if (checked !== on) await page.click(`[data-testid=${id}]`);
  }
  await page.click("[data-testid=settings-close]");
}

interface Shot {
  data: string;
  /** Wall-clock ms the frame was presented. */
  at: number;
}

/** Plays from `from` for `ms`, with the screencast and the glitch probe on; returns the frames seen and the probe's samples. */
async function play(label: string, from: number, ms: number) {
  await clickAt(from);
  await ready();
  await sleep(600);
  const cdp = await page.createCDPSession();
  const shots: Array<Shot> = [];
  cdp.on("Page.screencastFrame", (e: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    shots.push({ data: e.data, at: (e.metadata.timestamp ?? Date.now() / 1000) * 1000 });
    void cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 900, maxHeight: 700, everyNthFrame: 1 });
  await startGlitchProbe(page, layers.map((l) => l.id));
  await page.keyboard.press("Space");
  await sleep(ms);
  await page.keyboard.press("Space");
  await sleep(200);
  await cdp.send("Page.stopScreencast");
  await cdp.detach();
  const probe = await stopGlitchProbe(page);
  const origin = await page.evaluate(() => performance.timeOrigin);
  // D241: renders where the GPU compositor kept the last frame up (a layer had nothing to draw yet).
  const held = await page.$eval("[data-testid=preview-frame]", (el) => Number((el as HTMLElement).dataset.gpuHeld ?? 0));
  const heldBy = await page.evaluate(() => document.querySelector<HTMLElement>("canvas[data-gpu-compositor=\"0\"]")?.dataset.heldBy ?? "");
  const rect = await page.$eval("[data-testid=preview-frame]", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x / innerWidth, y: r.y / innerHeight, w: r.width / innerWidth, h: r.height / innerHeight };
  });
  // Each frame: the share of the preview frame's inside (5 % in from each edge) under luma 24.
  const dark: Array<number> = [];
  for (let i = 0; i < shots.length; i += 40) {
    dark.push(
      ...(await page.evaluate(
        async (datas: Array<string>, rect: { x: number; y: number; w: number; h: number }) => {
          const result: Array<number> = [];
          for (const d of datas) {
            const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(d), (ch) => ch.charCodeAt(0))], { type: "image/jpeg" }));
            const x = Math.round((rect.x + rect.w * 0.05) * bitmap.width);
            const y = Math.round((rect.y + rect.h * 0.05) * bitmap.height);
            const w = Math.max(1, Math.round(rect.w * 0.9 * bitmap.width));
            const h = Math.max(1, Math.round(rect.h * 0.9 * bitmap.height));
            const c = new OffscreenCanvas(w, h);
            const ctx = c.getContext("2d")!;
            ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
            bitmap.close();
            const px = ctx.getImageData(0, 0, w, h).data;
            let n = 0;
            for (let p = 0; p < px.length; p += 4) if (0.2126 * px[p]! + 0.7152 * px[p + 1]! + 0.0722 * px[p + 2]! < 24) n++;
            result.push(n / (w * h));
          }
          return result;
        },
        shots.slice(i, i + 40).map((s) => s.data),
        rect,
      )),
    );
  }
  // The playhead when each frame was presented (the probe's sample just before it).
  const samples = probe.samples.map((s) => ({ at: origin + s.t, frame: s.frame, playing: s.playing, layers: s.layers }));
  const frameAt = (at: number) => {
    let f: (typeof samples)[number] | undefined;
    for (const s of samples) {
      if (s.at > at) break;
      f = s;
    }
    return f;
  };
  const blacks = shots
    .map((s, i) => ({ i, dark: dark[i]!, at: s.at, sample: frameAt(s.at) }))
    .filter((b) => b.dark > 0.6 && b.sample?.playing)
    .map((b) => ({ ...b, frame: b.sample!.frame, cut: cuts.reduce((best, c) => (Math.abs(c - b.sample!.frame) < Math.abs(best - b.sample!.frame) ? c : best), cuts[0]!) }));
  const playingShots = shots.filter((s) => frameAt(s.at)?.playing).length;
  const c = countGlitches(probe.samples, layers, { fps: FPS, lateMs: 1000, longMs: 150 });
  console.log(`# issue82 ${label}: ${shots.length} screen frames (${playingShots} while playing), black ${blacks.length}${blacks.length ? ` at playhead frames [${blacks.map((b) => `${b.frame} (cut ${b.cut}${b.frame >= b.cut ? "+" : ""}${b.frame - b.cut})`).join(", ")}]` : ""}; probe: flash ${c.flash}, late ${c.late}, look flash ${c.lookFlash}, stale ${c.stale}, frozen ${c.frozen}, worst frame ${c.worstFrameMs.toFixed(0)} ms; gpu held renders so far ${held}${heldBy ? ` (last by ${heldBy})` : ""}; stats ${JSON.stringify(probe.stats)}`);
  // Each black frame: what the probe saw of the layers around it (drawn, seeking, media time, frames presented).
  for (const b of blacks.slice(0, 3)) console.log(`# issue82 ${label} black f${b.frame}: ${JSON.stringify(b.sample?.layers)}`);
  if (c.details.length) console.log(`# issue82 ${label} details: ${c.details.slice(0, 40).join("; ")}`);
  const name = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  for (const b of blacks.slice(0, 3)) writeFileSync(out(`${name}-black-f${b.frame}`), Buffer.from(shots[b.i]!.data, "base64"));
  // One frame on each side of the first cut, to look at.
  const near = (f: number) => shots.find((s) => (frameAt(s.at)?.frame ?? -1) >= f);
  const before = near(cuts[0]! - 2);
  const afterCut = near(cuts[0]! + 1);
  if (before) writeFileSync(out(`${name}-before-cut`), Buffer.from(before.data, "base64"));
  if (afterCut) writeFileSync(out(`${name}-after-cut`), Buffer.from(afterCut.data, "base64"));
  return { blacks, flash: c.flash, playingShots };
}

test("issue #82: playback across 6 cuts (4K HEVC among them) shows no black frame, scrub cache and GPU compositor on and off", { skip, timeout: 900000 }, async () => {
  app = await launchApp({ command: APP, env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]) } });
  page = app.page;
  await waitForWelcome(page);
  await page.click("[data-testid=open-project]");
  await waitFor("[data-testid=editor]");
  await page.click("[data-testid=bottom-timeline]");
  const runs: Record<string, Awaited<ReturnType<typeof play>>> = {};
  for (const [scrub, gpu] of [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ] as const) {
    await setPreview(scrub, gpu);
    const label = `scrub ${scrub ? "on" : "off"}, gpu ${gpu ? "on" : "off"}`;
    runs[label] = await play(label, CLIP - 15, (cuts.at(-1)! - CLIP + 45) * (1000 / FPS));
  }
  for (const [label, r] of Object.entries(runs)) {
    assert.ok(r.playingShots > 100, `${label}: the screencast saw the playback (${r.playingShots} frames)`);
    assert.deepEqual(r.blacks.map((b) => b.frame), [], `${label}: black frames while playing`);
    assert.equal(r.flash, 0, `${label}: a layer blanked after showing`);
  }
  assert.deepEqual(app.errors, []);
});
