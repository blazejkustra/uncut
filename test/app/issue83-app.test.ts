// Issue #83 (D246) on the packaged app, run invisibly and muted (launchApp's background window):
// every mixer effect is heard in the preview as the export renders it, and the popovers are redone.
// - Noise removal: + FX adds it with no "export" badge or "applied on export" text anywhere; its
//   popover shows the floor it works from, measured once the track's loudness analysis is done.
// - The preview's denoiser (the AudioWorklet in the packaged renderer, OfflineAudioContext) against
//   the export's afftdn on the track's own sound: the noise left within 2.5 dB, the voice within
//   0.3 dB, and at least 4 dB of noise taken out.
// - Preview ≈ export, live: the preview's master output recorded while the noisy voice plays with
//   noise removal on, against the export's mix of the same project.json (planExport + audioGraph):
//   every 0.25 s window within 2.5 dB (1.5 dB where the voice speaks), LUFS within 1 dB, and the
//   noise between the words as quiet as the export's.
// - Noise removal's latency compensated (D262): with an undenoised copy of the voice on another
//   track (hard right), the denoised voice lands within 3 ms of it (no ±0.6 s search: one
//   cross-correlation over ±30 ms); ten On/Off toggles leave one denoise processor
//   running, not eleven (__uncutAudio.denoiseStats).
// - The loudness target heard: At target by default (D273), As mixed chosen and kept; the master popover's Preview "At target" plays the gain the export's
//   loudness step measures (export.loudness); the recorded preview lands within 1 LU of the target.
// - The popovers: one On switch (bypass, ducking, limiter), the EQ curve with a dragged mid handle
//   (one edit), the compressor's curve and live gain reduction while playing, the duck curve with
//   the playhead, the limiter's ceiling and reduction; ↑ keeps the popover on the moved entry.
// Screenshots: test-output/issue83-denoise.png, -eq.png, -compressor.png, -duck.png, -master.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { audioGraph, planExport } from "../../apps/server/src/export/exportPlan.ts";
import { stageFilter } from "../../apps/server/src/export/plan/audio.ts";
import { cachedFor, targetOf, type LoudnessResult } from "../../apps/server/src/analysis/analysis.ts";
import { decodeEnvelope, trackNoiseFloorDb, type Project, type SpeechEnvelope, type Stage } from "../../packages/core/src/index.ts";
import { DENOISE_FFT } from "../../packages/core/src/audio/denoise.ts";
import { NO_REAL_AUDIO } from "../helpers/capabilities.ts";

const APP = resolve("dist/mac-arm64/Uncut.app/Contents/MacOS/Uncut");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = existsSync(APP) ? (hasFfmpeg ? false : "needs ffmpeg to make test tones") : `packaged app not built: run pnpm dist to create ${APP}`;

let root = "";
const apps = new Set<LaunchedApp>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (name: string) => resolve("test-output", name);
const waitFor = (page: Page, selector: string, timeout = 15000) => page.waitForSelector(selector, { timeout });
const revision = (page: Page) => page.$eval("[data-testid=saved]", (el) => Number(/revision (\d+)/.exec((el as HTMLElement).title)?.[1] ?? -1));
async function savedAfter(page: Page, after: number) {
  await page.waitForFunction(
    (r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1] ?? -1) > r,
    { timeout: 10000 },
    after,
  );
  await sleep(150);
  return revision(page);
}
async function typeInto(page: Page, selector: string, value: string) {
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Meta");
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
}
const dB = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
const f32 = (s: string) => {
  const b = Buffer.from(s, "base64");
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const b64 = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
type AudioHook = {
  startCapture(): boolean;
  stopCapture():
    | { sampleRate: number; t0: number; left: string; right: string; marks: Array<{ t: number; frame: number }>; latency: number; sink: string }
    | undefined;
  offlineRender(o: { stages: ReadonlyArray<Stage>; input: string; sampleRate?: number }): Promise<{ ready: boolean; output: string }>;
  levels(): { limiter: number; reduction: Record<string, number> };
  denoiseStats(): { live: number; made: number };
};
const H = "__uncutAudio";
const startCapture = (page: Page) => page.evaluate((h) => (globalThis as unknown as Record<string, AudioHook>)[h]!.startCapture(), H);
const stopCapture = (page: Page) => page.evaluate((h) => (globalThis as unknown as Record<string, AudioHook>)[h]!.stopCapture(), H);
const offlineRender = (page: Page, o: { stages: Array<Stage>; input: string }) =>
  page.evaluate((a) => (globalThis as unknown as Record<string, AudioHook>)[a.H]!.offlineRender(a.o), { H, o });

const SECONDS = 9;
// The voice speaks 1.5–3.0 s and 5.0–6.2 s; the hiss runs throughout.
const SPEECH: ReadonlyArray<[number, number]> = [
  [1.5, 3],
  [5, 6.2],
];
before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-issue83-")));
  const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  // A noisy voice: white hiss at about −36 dBFS RMS under a 220 Hz voice with harmonics.
  ff(
    "-f",
    "lavfi",
    "-i",
    `anoisesrc=d=${SECONDS}:c=white:r=48000:a=0.016:seed=7`,
    "-f",
    "lavfi",
    "-i",
    `aevalsrc='0.3*(sin(2*PI*220*t)+0.4*sin(2*PI*660*t)+0.2*sin(2*PI*1760*t))*(between(t,1.5,3)+between(t,5,6.2))':s=48000:d=${SECONDS}`,
    "-filter_complex",
    "[0][1]amix=inputs=2:normalize=0",
    "-c:a",
    "pcm_s16le",
    join(root, "Voice.wav"),
  );
  ff(
    "-f",
    "lavfi",
    "-i",
    `aevalsrc='0.15*sin(2*PI*550*t)|0.1*sin(2*PI*770*t)':s=48000:d=${SECONDS}:c=stereo`,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    join(root, "Music.m4a"),
  );
  ff("-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-t", String(SECONDS), "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "Picture.mp4"));
  const dir = join(root, "Fx83.uncut");
  mkdirSync(dir);
  const frames = SECONDS * 30;
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Fx83",
      canvas: { width: 1280, height: 720, fps: 30 },
      media: [
        {
          id: "m-pic",
          kind: "video",
          name: "Picture.mp4",
          path: join(root, "Picture.mp4"),
          probe: { frames, fps: 30, width: 320, height: 240, hasAudio: false },
        },
        { id: "m-voice", kind: "audio", name: "Voice.wav", path: join(root, "Voice.wav"), probe: { frames } },
        { id: "m-music", kind: "audio", name: "Music.m4a", path: join(root, "Music.m4a"), probe: { frames } },
      ],
      tracks: [
        { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-pic", in: 0, duration: frames }] },
        { id: "voice", kind: "audio", name: "Voice", items: [{ id: "v", type: "audio", media: "m-voice", in: 0, start: 0, duration: frames }] },
        // D262: an undenoised copy of the voice, hard right, unmuted only for the latency check.
        {
          id: "ref",
          kind: "audio",
          name: "Ref",
          mixer: { mute: true, pan: 1 },
          items: [{ id: "r", type: "audio", media: "m-voice", in: 0, start: 0, duration: frames }],
        },
        // Muted for the recordings (the hiss is what's measured); unmuted for the duck graph.
        {
          id: "music",
          kind: "audio",
          name: "Music",
          mixer: { mute: true },
          items: [{ id: "m", type: "audio", media: "m-music", in: 0, start: 0, duration: frames }],
        },
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

/** Play the project from the start and record the preview's master output. */
async function record(page: Page, while_?: () => Promise<void>) {
  // Buttons, not keys: a focused slot button would take the Space.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.querySelector<HTMLElement>("[data-testid=to-start]")?.click();
  });
  await sleep(400);
  assert.equal(await startCapture(page), true);
  await page.evaluate(() => document.querySelector<HTMLElement>("[data-testid=play]")!.click());
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    await while_?.();
    if ((await page.$eval("[data-testid=preview-frame]", (el) => (el as HTMLElement).dataset.playing)) === "false") break;
    await sleep(100);
  }
  await sleep(300);
  const cap = (await stopCapture(page))!;
  assert.ok(cap, "captured");
  assert.equal(cap.sink, "none", "the preview plays to no output device in a test run");
  return cap;
}

/**
 * The lag (ms) of `left` behind `reference`, by cross-correlation over ±30 ms on the hiss between
 * the words. Only that stretch is usable: the voice repeats every 1/220 s and the denoiser leaves
 * little else of it, so across a word peaks 4.5 ms apart tie and the search can land three periods off.
 */
function hissLagMs(left: Float32Array, reference: Float32Array, sampleRate: number) {
  const from = Math.round(3.3 * sampleRate);
  const n = Math.round(1.4 * sampleRate);
  const maxLag = Math.round(0.03 * sampleRate);
  let bestLag = 0;
  let bestC = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let c = 0;
    for (let i = from; i < from + n; i++) c += left[i + lag]! * reference[i]!;
    if (c > bestC) ((bestC = c), (bestLag = lag));
  }
  return (bestLag / sampleRate) * 1000;
}
const minus = (a: Float32Array, b: Float32Array) => a.map((x, i) => x - b[i]!);

const rmsOf = (a: Float32Array, i0: number, n: number) => {
  let s = 0;
  for (let i = Math.max(0, i0); i < Math.min(a.length, i0 + n); i++) s += a[i]! ** 2;
  return Math.sqrt(s / n);
};
function lufsOf(left: Float32Array, right: Float32Array, sr: number, file: string) {
  const n = Math.min(left.length, right.length);
  const buf = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) ((buf[2 * i] = left[i]!), (buf[2 * i + 1] = right[i]!));
  writeFileSync(join(root, `${file}.f32`), Buffer.from(buf.buffer));
  const rr = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-f", "f32le", "-ar", String(sr), "-ac", "2", "-i", join(root, `${file}.f32`), "-af", "ebur128", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  return Number(/Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(rr.stderr)![1]);
}
/** The capture aligned to project time (as effects-app does, D83): the clock from the drawn frames, refined against `ref` by ±0.6 s of 50 ms levels. */
function align(cap: NonNullable<Awaited<ReturnType<typeof record>>>, ref: Float32Array) {
  const sr = cap.sampleRate;
  const pre = { left: f32(cap.left), right: f32(cap.right) };
  const playing = cap.marks.filter((m, i) => i > 3 && m.frame > 3 && m.frame < SECONDS * 30 - 10);
  const offs = playing.map((m) => m.frame / 30 - m.t).sort((a, b) => a - b);
  const clockOffset = offs[Math.floor(offs.length / 2)]!;
  const startIndex = (lag: number) => Math.round((-clockOffset - cap.t0 + lag) * sr);
  const W = Math.round(0.05 * sr);
  let best = { lag: 0, err: Infinity };
  for (let lag = -0.6; lag <= 0.6; lag += 0.005) {
    const s0 = startIndex(lag);
    let err = 0;
    for (let k = 10; k < 165; k++) {
      const e = dB(rmsOf(ref, k * W, W)) - dB(rmsOf(pre.left, s0 + k * W, W));
      err += Math.min(e * e, 400);
    }
    if (err < best.err) best = { lag, err };
  }
  assert.ok(Math.abs(best.lag) < 0.6 - 0.005, `the alignment search hit its limit (lag ${best.lag.toFixed(3)} s)`);
  const s0 = startIndex(best.lag);
  assert.ok(s0 + 0.5 * sr >= 0 && s0 + 8.25 * sr <= pre.left.length, `the recording covers 0.5–8.25 s (start ${s0}, ${pre.left.length} samples)`);
  return { pre, s0, lag: best.lag };
}
const inSpeech = (t0: number, t1: number) => SPEECH.some(([a, b]) => t1 > a - 0.05 && t0 < b + 0.05);

test(
  "issue #83: noise removal heard in the preview ≈ the export, the loudness target heard, and the redesigned effect popovers",
  { skip: skip || NO_REAL_AUDIO, timeout: 480000 },
  async () => {
    const dir = join(root, "Fx83.uncut");
    const app = await launchApp({
      command: APP,
      env: {
        UNCUT_DATA_DIR: join(root, "data"),
        UNCUT_TEST_DIALOG: JSON.stringify([dir]),
        UNCUT_CLAUDE: FAKE,
        FAKE_PLAN: join(root, "plan.json"),
        FAKE_PROMPT_LOG: join(root, "prompts.jsonl"),
      },
    });
    apps.add(app);
    const { page } = app;
    const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
    const fxOf = (id: string) => onDisk().tracks.find((t) => t.id === id)!.mixer?.effects ?? [];
    const strip = (id: string) => `[data-testid=mixer-strip][data-track="${id}"]`;
    try {
      await waitForWelcome(page);
      await page.click("[data-testid=open-project]");
      await waitFor(page, "[data-testid=editor]");
      let rev = await revision(page);
      await page.click("[data-testid=bottom-mixer]");
      await waitFor(page, "[data-testid=mixer-panel]");
      // D273: the preview plays At target by default; this viewer picks As mixed (the levels below are
      // the mix as it is), and that choice is remembered.
      await page.click("[data-testid=target-btn]");
      await waitFor(page, "[data-testid=master-popover]");
      assert.equal(await page.$eval("[data-testid=preview-loudness-target]", (el) => el.getAttribute("aria-checked")), "true", "At target by default");
      await page.click("[data-testid=preview-loudness-mixed]");
      assert.equal(await page.evaluate(() => localStorage.getItem("uncut.previewAtTarget")), "0");
      await page.keyboard.press("Escape");

      // ---- Noise removal: added, no export-only marks, its floor measured ----
      await page.click(`${strip("voice")} [data-testid=fx-add]`);
      await waitFor(page, "[data-testid=fx-menu]");
      const hint = await page.$eval("[data-testid=fx-add-audio\\.denoise]", (el) => el.textContent ?? "");
      assert.doesNotMatch(hint, /export/i, `the menu's hint: ${hint}`);
      await page.click("[data-testid=fx-add-audio\\.denoise]");
      rev = await savedAfter(page, rev);
      assert.deepEqual(fxOf("voice"), [{ module: "audio.denoise" }]);
      assert.equal(await page.$("[data-testid=fx-export-badge]"), null, "no export badge on the slot");
      await page.click(`${strip("voice")} [data-testid=fx-slot][data-module="audio.denoise"]`);
      await waitFor(page, "[data-testid=fx-popover] [data-testid=fx-denoise-graph]");
      await typeInto(page, "[data-testid=fx-popover] [data-testid=fx-param-amount]", "100");
      rev = await savedAfter(page, rev);
      assert.deepEqual(fxOf("voice"), [{ module: "audio.denoise", params: { amount: 1 } }]);
      // The track's loudness analysis starts by itself (noise removal needs its floor) and the popover says so.
      await page.waitForSelector('[data-testid=fx-denoise-floor][data-measured="true"]', { timeout: 40000 });
      const body = await page.evaluate(() => document.body.innerText);
      assert.doesNotMatch(body, /applied on export|not (heard|shown) in (the )?preview|export only/i, "no export-only message anywhere");
      await page.screenshot({ path: out("issue83-denoise.png") });
      const graphFloor = Number(await page.$eval("[data-testid=fx-denoise-graph]", (el) => (el as unknown as SVGElement).dataset.floor));
      await page.keyboard.press("Escape");

      // ---- The packaged renderer's denoiser (the worklet) ≈ afftdn on this track's sound ----
      const voiceMedia = onDisk().media.find((m) => m.id === "m-voice")!;
      const loud = (await cachedFor(targetOf(dir, voiceMedia, 30), "loudness")) as LoudnessResult | undefined;
      assert.ok(loud?.hasAudio && loud.envelope, "the voice's loudness was measured");
      const envelopes = new Map<string, SpeechEnvelope | null>([["m-voice", decodeEnvelope(loud.envelope)!]]);
      const floorDb = trackNoiseFloorDb(
        onDisk(),
        onDisk().tracks.find((t) => t.id === "voice")!,
        envelopes,
      );
      const SR = 48000;
      const raw = execFileSync("ffmpeg", ["-v", "error", "-i", join(root, "Voice.wav"), "-f", "f32le", "-ac", "1", "-ar", String(SR), "-"], {
        maxBuffer: 1 << 28,
      });
      const x = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      const stage: Stage = { kind: "denoise", amount: 1, floorDb };
      const rendered = await offlineRender(page, { stages: [stage], input: b64(x) });
      assert.equal(rendered.ready, true, "noise removal's AudioWorklet loads in the packaged app");
      const pre = f32(rendered.output);
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-i",
        join(root, "Voice.wav"),
        "-af",
        stageFilter(stage),
        "-c:a",
        "pcm_f32le",
        join(root, "voice-afftdn.wav"),
      ]);
      const exRaw = execFileSync("ffmpeg", ["-v", "error", "-i", join(root, "voice-afftdn.wav"), "-f", "f32le", "-ac", "1", "-"], { maxBuffer: 1 << 28 });
      const ex = new Float32Array(exRaw.buffer.slice(exRaw.byteOffset, exRaw.byteOffset + exRaw.byteLength));
      const win = (a: Float32Array, s: number, e: number, lag = 0) => dB(rmsOf(a, Math.round(s * SR) + lag, Math.round((e - s) * SR)));
      const offline = {
        noiseIn: win(x, 3.5, 4.8),
        noisePre: win(pre, 3.5, 4.8, DENOISE_FFT),
        noiseEx: win(ex, 3.5, 4.8),
        voicePre: win(pre, 1.8, 2.8, DENOISE_FFT),
        voiceEx: win(ex, 1.8, 2.8),
      };
      console.log(
        `offline (worklet in the app vs afftdn), floor ${floorDb} dBFS (graph ${graphFloor}): noise ${offline.noiseIn.toFixed(2)} → preview ${offline.noisePre.toFixed(2)} / export ${offline.noiseEx.toFixed(2)} dB; voice ${offline.voicePre.toFixed(2)} / ${offline.voiceEx.toFixed(2)} dB`,
      );
      assert.equal(graphFloor, floorDb, "the popover shows the floor the export uses");
      assert.ok(Math.abs(offline.noisePre - offline.noiseEx) <= 2.5, "noise left: preview ≈ export");
      assert.ok(Math.abs(offline.voicePre - offline.voiceEx) <= 0.3, "voice kept: preview ≈ export");
      assert.ok(offline.noiseIn - offline.noisePre >= 4, "the preview takes the hiss down");

      // ---- Live: the preview's mix with noise removal ≈ the export's ----
      const exportMix = (project: Project, name: string, rate: number) => {
        const plan = planExport(project, { mediaPath: (m) => m.path, width: 640, height: 360, envelopes });
        assert.ok(!("problem" in plan));
        const g = audioGraph(plan, 0);
        writeFileSync(join(root, `${name}.txt`), g.filters.join(";\n"));
        const wav = join(root, `${name}.wav`);
        const r = spawnSync(
          "ffmpeg",
          ["-hide_banner", "-y", ...g.inputs, "-/filter_complex", join(root, `${name}.txt`), "-map", "[aout]", "-ar", String(rate), "-c:a", "pcm_f32le", wav],
          { encoding: "utf8" },
        );
        assert.equal(r.status, 0, r.stderr.slice(-600));
        const raw2 = execFileSync("ffmpeg", ["-v", "error", "-i", wav, "-f", "f32le", "-ac", "2", "-"], { maxBuffer: 1 << 28 });
        const inter = new Float32Array(raw2.buffer.slice(raw2.byteOffset, raw2.byteOffset + raw2.byteLength));
        const e = { left: new Float32Array(inter.length / 2), right: new Float32Array(inter.length / 2) };
        for (let i = 0; i < e.left.length; i++) ((e.left[i] = inter[2 * i]!), (e.right[i] = inter[2 * i + 1]!));
        return e;
      };
      const cap = await record(page);
      // The context's own rate (44.1 or 48 kHz with the Mac's output): the export's mix is rendered at it.
      const sr = cap.sampleRate;
      const exMix = exportMix(onDisk(), "denoise", sr);
      const { pre: live, s0, lag } = align(cap, exMix.left);
      const W4 = Math.round(0.25 * sr);
      const worst = { all: 0, speech: 0, at: "" };
      let noisePre = 0;
      let noiseEx = 0;
      let noiseN = 0;
      for (let k = 2; k < 33; k++) {
        const t = k * 0.25;
        for (const ch of ["left", "right"] as const) {
          const e = dB(rmsOf(exMix[ch], k * W4, W4));
          const p = dB(rmsOf(live[ch], s0 + k * W4, W4));
          const d = Math.abs(e - p);
          const speech = inSpeech(t, t + 0.25);
          if (d > worst.all) Object.assign(worst, { all: d, at: `${ch} ${t.toFixed(2)} s: export ${e.toFixed(2)} dB, preview ${p.toFixed(2)} dB` });
          if (speech) worst.speech = Math.max(worst.speech, d);
          else if (ch === "left") ((noisePre += p), (noiseEx += e), noiseN++);
        }
      }
      const lPre = lufsOf(live.left.subarray(s0 + sr / 2, s0 + 8.25 * sr), live.right.subarray(s0 + sr / 2, s0 + 8.25 * sr), sr, "denoise-pre");
      const lExp = lufsOf(exMix.left.subarray(sr / 2, 8.25 * sr), exMix.right.subarray(sr / 2, 8.25 * sr), sr, "denoise-exp");
      console.log(
        `live with noise removal: worst window ${worst.all.toFixed(2)} dB (${worst.at}), in speech ${worst.speech.toFixed(2)} dB; between words preview ${(noisePre / noiseN).toFixed(2)} vs export ${(noiseEx / noiseN).toFixed(2)} dB; LUFS ${lPre} vs ${lExp}; lag ${lag.toFixed(3)} s`,
      );
      assert.ok(worst.all <= 2.5, `preview vs export, worst 0.25 s window: ${worst.at}`);
      assert.ok(worst.speech <= 1.5, `preview vs export where the voice speaks: ${worst.speech.toFixed(2)} dB`);
      assert.ok(Math.abs(noisePre / noiseN - noiseEx / noiseN) <= 2, "the hiss between the words: preview ≈ export");
      assert.ok(
        noisePre / noiseN <= offline.noiseIn - 4,
        `the hiss is down in the live preview too (${(noisePre / noiseN).toFixed(2)} dB vs ${offline.noiseIn.toFixed(2)} in the file)`,
      );
      assert.ok(Math.abs(lPre - lExp) <= 1, `LUFS preview ${lPre} vs export ${lExp}`);

      // ---- D262: the denoised voice lands with an undenoised copy of it ----
      // Ref (hard right) unmuted: left is the denoised voice, right − left is Ref's raw voice (the
      // voice is centred: 1 on both sides). Uncompensated their lag is DENOISE_FFT samples (21–23 ms).
      // The two <audio> elements can't start closer than the bound: play() has no start time, and
      // their starts land up to about 2.5 ms apart, stable for the take.
      await page.click(`${strip("ref")} [data-testid=mixer-mute]`);
      rev = await savedAfter(page, rev);
      const capRef = await record(page);
      const left = f32(capRef.left);
      const lagMs = hissLagMs(left, minus(f32(capRef.right), left), capRef.sampleRate);
      console.log(`denoised voice vs its undenoised copy: ${lagMs.toFixed(2)} ms (uncompensated ${((DENOISE_FFT / capRef.sampleRate) * 1000).toFixed(1)} ms)`);
      assert.ok(Math.abs(lagMs) < 3, `the denoised voice lags its undenoised copy by ${lagMs.toFixed(2)} ms`);
      await page.click(`${strip("ref")} [data-testid=mixer-mute]`);
      rev = await savedAfter(page, rev);

      // ---- D262: toggling noise removal leaves no processor behind ----
      const stats = () => page.evaluate((h) => (globalThis as unknown as Record<string, AudioHook>)[h]!.denoiseStats(), H);
      await page.waitForFunction((h) => (globalThis as unknown as Record<string, AudioHook>)[h]!.denoiseStats().live === 1, { timeout: 5000 }, H);
      const made0 = (await stats()).made;
      await page.click(`${strip("voice")} [data-testid=fx-slot][data-module="audio.denoise"]`);
      await waitFor(page, "[data-testid=fx-popover] [data-testid=fx-bypass]");
      for (let i = 0; i < 10; i++) {
        await page.click("[data-testid=fx-popover] [data-testid=fx-bypass]");
        rev = await savedAfter(page, rev);
        await sleep(100);
      }
      assert.equal(fxOf("voice")[0]!.bypass, undefined, "ten toggles: on again");
      await page.keyboard.press("Escape");
      await page
        .waitForFunction((h) => (globalThis as unknown as Record<string, AudioHook>)[h]!.denoiseStats().live <= 1, { timeout: 5000 }, H)
        .catch(() => {});
      const after10 = await stats();
      console.log(`denoise processors after 10 toggles: ${after10.made - made0} made, ${after10.live} running`);
      assert.ok(after10.made - made0 >= 5, `each toggle back on built a new chain (${after10.made - made0} made)`);
      assert.equal(after10.live, 1, "only the current chain's denoise processor runs");

      // ---- The loudness target, heard: Broadcast (−23 LUFS), Preview At target ----
      await page.click("[data-testid=target-btn]");
      await waitFor(page, "[data-testid=master-popover]");
      await page.select("[data-testid=master-popover] [data-testid=target-select]", "-23");
      rev = await savedAfter(page, rev);
      assert.equal(
        await page.$eval("[data-testid=preview-loudness-mixed]", (el) => el.getAttribute("aria-checked")),
        "true",
        "As mixed: this viewer's choice wins over the default",
      );
      await page.click("[data-testid=preview-loudness-target]");
      await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=preview-loudness-status]")?.dataset.gain !== "", { timeout: 60000 });
      const gain = Number(await page.$eval("[data-testid=preview-loudness-status]", (el) => (el as HTMLElement).dataset.gain));
      const mixLufs = Number(await page.$eval("[data-testid=preview-loudness-status]", (el) => (el as HTMLElement).dataset.lufs));
      await waitFor(page, "[data-testid=master-popover] [data-testid=limiter-graph]");
      await page.screenshot({ path: out("issue83-master.png") });
      await page.keyboard.press("Escape");
      const capT = await record(page);
      const alignedT = align(capT, exMix.left);
      const lTarget = lufsOf(
        alignedT.pre.left.subarray(alignedT.s0 + sr / 2, alignedT.s0 + 8.25 * sr),
        alignedT.pre.right.subarray(alignedT.s0 + sr / 2, alignedT.s0 + 8.25 * sr),
        sr,
        "target-pre",
      );
      console.log(`At target −23: the mix measured ${mixLufs} LUFS, gain ${gain} dB; the preview played ${lTarget} LUFS (As mixed ${lPre})`);
      assert.ok(Math.abs(gain - (-23 - mixLufs)) <= 1.5, `the gain brings the mix to the target (${gain} dB for ${mixLufs} LUFS)`);
      assert.ok(Math.abs(lTarget - -23) <= 1, `the preview plays at the target: ${lTarget} LUFS`);
      // Back to As mixed (the choice is this viewer's, not the project's).
      await page.click("[data-testid=target-btn]");
      await waitFor(page, "[data-testid=master-popover]");
      await page.click("[data-testid=preview-loudness-mixed]");
      await page.keyboard.press("Escape");

      // ---- The popovers ----
      // EQ: the curve, a dragged mid handle (one edit), ↑ keeps the popover on it, the On switch.
      await page.click(`${strip("voice")} [data-testid=fx-add]`);
      await waitFor(page, "[data-testid=fx-menu]");
      await page.click("[data-testid=fx-add-audio\\.eq]");
      rev = await savedAfter(page, rev);
      await page.click(`${strip("voice")} [data-testid=fx-slot][data-module="audio.eq"]`);
      await waitFor(page, "[data-testid=fx-popover] [data-testid=fx-eq-graph]");
      assert.equal(Number(await page.$eval("[data-testid=fx-eq-graph]", (el) => (el as unknown as SVGElement).dataset.at1k)), 0, "a flat EQ");
      const handle = (await page.$("[data-testid=fx-eq-handle-mid]"))!;
      const hb = (await handle.boundingBox())!;
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(hb.x + hb.width / 2 + i * 6, hb.y + hb.height / 2 - i * 4);
      await page.mouse.up();
      rev = await savedAfter(page, rev);
      const eq = fxOf("voice")[1]!;
      assert.equal(eq.module, "audio.eq");
      assert.ok((eq.params?.midGainDb as number) > 3 && (eq.params?.midHz as number) > 1000, `the drag set the mid band: ${JSON.stringify(eq.params)}`);
      await page.waitForFunction(() => Number(document.querySelector<SVGElement>("[data-testid=fx-eq-graph]")?.dataset.at1k) > 1, { timeout: 5000 });
      await page.click("[data-testid=fx-popover] [data-testid=fx-up]");
      rev = await savedAfter(page, rev);
      assert.deepEqual(
        fxOf("voice").map((f) => f.module),
        ["audio.eq", "audio.denoise"],
      );
      await page.waitForFunction(() => document.querySelector("[data-testid=fx-popover] .fxp-title")?.textContent?.includes("EQ"), { timeout: 5000 });
      await page.screenshot({ path: out("issue83-eq.png") });
      await page.click("[data-testid=fx-popover] [data-testid=fx-bypass]");
      rev = await savedAfter(page, rev);
      assert.equal(fxOf("voice")[0]!.bypass, true);
      assert.equal(await page.$eval("[data-testid=fx-popover] [data-testid=fx-bypass]", (el) => el.getAttribute("aria-checked")), "false");
      assert.ok(await page.$eval("[data-testid=fx-eq-graph]", (el) => el.classList.contains("bypassed")), "the curve dims when bypassed");
      await page.click("[data-testid=fx-popover] [data-testid=fx-bypass]");
      rev = await savedAfter(page, rev);
      assert.equal(fxOf("voice")[0]!.bypass, undefined);
      await page.keyboard.press("Escape");

      // Compressor: the curve and its gain reduction, live while playing.
      await page.click(`${strip("voice")} [data-testid=fx-add]`);
      await waitFor(page, "[data-testid=fx-menu]");
      await page.click("[data-testid=fx-add-audio\\.compressor]");
      rev = await savedAfter(page, rev);
      await page.click(`${strip("voice")} [data-testid=fx-slot][data-module="audio.compressor"]`);
      await waitFor(page, "[data-testid=fx-popover] [data-testid=fx-comp-graph]");
      await page.evaluate(() => document.querySelector<HTMLElement>("[data-testid=to-start]")?.click());
      await sleep(300);
      // The popover keeps the keyboard's Space from the preview: play from the transport instead.
      await page.evaluate(() => document.querySelector<HTMLElement>("[data-testid=play]")!.click());
      let grDeep = 0;
      const tGr = Date.now();
      while (Date.now() - tGr < 6000) {
        const v = Number(await page.$eval("[data-testid=fx-pop-gr]", (el) => (el as unknown as SVGElement).dataset.value));
        if (v < grDeep) grDeep = v;
        if (grDeep < -3) break;
        await sleep(80);
      }
      await page.screenshot({ path: out("issue83-compressor.png") });
      console.log(`compressor popover: gain reduction down to ${grDeep} dB`);
      assert.ok(grDeep < -1, `the popover's gain reduction moves while the voice plays (${grDeep} dB)`);
      await page.keyboard.press("Escape");
      if ((await page.$eval("[data-testid=preview-frame]", (el) => (el as HTMLElement).dataset.playing)) === "true")
        await page.evaluate(() => document.querySelector<HTMLElement>("[data-testid=play]")!.click());

      // Ducking: Music (unmuted) under Voice; the curve over the timeline with the playhead; its On switch.
      await page.click(`${strip("music")} [data-testid=mixer-mute]`);
      rev = await savedAfter(page, rev);
      await page.click(`${strip("music")} [data-testid=duck-btn]`);
      await waitFor(page, "[data-testid=duck-popover]");
      await page.select("[data-testid=duck-popover] [data-testid=duck-under]", "voice");
      rev = await savedAfter(page, rev);
      await page.waitForFunction(() => Number(document.querySelector<SVGElement>("[data-testid=duck-graph]")?.dataset.keys) >= 4, { timeout: 30000 });
      assert.ok(await page.$("[data-testid=duck-graph-playhead]"));
      await page.screenshot({ path: out("issue83-duck.png") });
      await page.click("[data-testid=duck-popover] [data-testid=duck-on]");
      rev = await savedAfter(page, rev);
      assert.equal(fxOf("music").find((f) => f.module === "audio.duck")!.bypass, true);
      await page.keyboard.press("Escape");
      assert.deepEqual(app.errors, []);
    } catch (error) {
      await page.screenshot({ path: out("issue83-failure.png") }).catch(() => {});
      throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-3000)}` });
    }
  },
);
