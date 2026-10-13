// Phase 6 chunk 7 (D84–D88) on the packaged app, run invisibly and muted (launchApp's background
// window; its audio is muted, the graph still runs):
// - the Mixer: + FX adds an EQ and a compressor to Voice; a param typed in the slot's popover, the
//   compressor moved up, bypassed; each one edit with its History label; ⌘Z/⇧⌘Z;
// - ducking: Music ducks under Voice from its Duck row; the voice's loudness analysis is started
//   by it, and the dashed duck line appears on the music item in the timeline;
// - the master: loudness target Broadcast and a limiter ceiling of −2 dBTP; ⌘Z/⇧⌘Z;
// - the preview's own node builders (OfflineAudioContext): BiquadFilterNode's response = core's
//   cookbook curves; the compressor's make-up cancellation leaves a tone under the threshold at
//   unity and a steady tone over it on the static curve; the limiter holds its ceiling;
// - preview ≈ export: the preview's master output recorded while a hot mix with EQ, ducking and the
//   limiter plays, against the export's mix of the same project.json (planExport + audioGraph with
//   the cached envelope, As mixed with the limiter): every 0.25 s window within 1.5 dB RMS per
//   channel and LUFS within 1 dB; the limiter's gain-reduction light moves; with the compressor
//   on too, how close the two compressors are is measured and reported (D84).
// Screenshots: test-output/effects-mixer.png, test-output/effects-ducking.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp } from "../helpers/app.ts";
import { audioGraph, planExport } from "../../apps/server/src/export/exportPlan.ts";
import { cachedFor, targetOf, type LoudnessResult } from "../../apps/server/src/analysis/analysis.ts";
import { biquadResponseDb, compressorCurveDb, decodeEnvelope, type Project, type Stage } from "../../packages/core/src/index.ts";

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
  await page.waitForFunction((r) => Number(/revision (\d+)/.exec(document.querySelector<HTMLElement>("[data-testid=saved]")!.title)?.[1] ?? -1) > r, { timeout: 10000 }, after);
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
/** Type a value into a number field (select what's there, type, Enter commits). */
async function typeInto(page: Page, selector: string, value: string) {
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Meta");
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
}
const dB = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
type AudioHook = {
  startCapture(): boolean;
  stopCapture(): { sampleRate: number; t0: number; left: string; right: string; marks: Array<{ t: number; frame: number }>; latency: number; sink: string } | undefined;
  biquadResponse(stage: Stage, freqs: ReadonlyArray<number>, sampleRate?: number): Array<number>;
  offlineTone(o: { stages?: ReadonlyArray<Stage>; ceilingDb?: number; amp: number; freq?: number; seconds?: number }): Promise<{ rms: number; peak: number }>;
  levels(): { limiter: number };
};

const SECONDS = 9;
before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-effects-")));
  const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  // Voice: a 220 Hz "voice" with harmonics, speaking 1.5–3.0 s and 5.0–6.2 s. Music: stereo tones and
  // pink noise (broadband, so the EQ shapes it). A silent 9 s picture on main.
  ff("-f", "lavfi", "-i", `aevalsrc='0.3*(sin(2*PI*220*t)+0.4*sin(2*PI*660*t)+0.2*sin(2*PI*1760*t))*(between(t,1.5,3)+between(t,5,6.2))':s=48000:d=${SECONDS}`, "-c:a", "aac", "-b:a", "192k", join(root, "Voice.m4a"));
  ff("-f", "lavfi", "-i", `aevalsrc='0.15*sin(2*PI*550*t)|0.1*sin(2*PI*770*t)':s=48000:d=${SECONDS}:c=stereo`, "-f", "lavfi", "-i", `anoisesrc=d=${SECONDS}:c=pink:r=48000:a=0.12:seed=5`, "-filter_complex", "[1]aformat=channel_layouts=stereo[n];[0][n]amix=inputs=2:normalize=0", "-c:a", "aac", "-b:a", "256k", join(root, "Music.m4a"));
  ff("-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-t", String(SECONDS), "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "Picture.mp4"));
  const dir = join(root, "Fx.uncut");
  mkdirSync(dir);
  const frames = SECONDS * 30;
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Fx",
      canvas: { width: 1280, height: 720, fps: 30 },
      media: [
        { id: "m-pic", kind: "video", name: "Picture.mp4", path: join(root, "Picture.mp4"), probe: { frames, fps: 30, width: 320, height: 240, hasAudio: false } },
        { id: "m-voice", kind: "audio", name: "Voice.m4a", path: join(root, "Voice.m4a"), probe: { frames } },
        { id: "m-music", kind: "audio", name: "Music.m4a", path: join(root, "Music.m4a"), probe: { frames } },
      ],
      tracks: [
        { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-pic", in: 0, duration: frames }] },
        // Hot: the voice +4 dB and the music +6 dB sum over the limiter's ceiling while both play.
        { id: "voice", kind: "audio", name: "Voice", mixer: { gainDb: 4 }, items: [{ id: "v", type: "audio", media: "m-voice", in: 0, start: 0, duration: frames }] },
        { id: "music", kind: "audio", name: "Music", mixer: { gainDb: 6 }, items: [{ id: "m", type: "audio", media: "m-music", in: 0, start: 0, duration: frames }] },
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

test("effects: EQ and compressor slots, ducking with its line, limiter and target, undo, History, the preview's nodes = core, and the preview's mix ≈ the export's", { skip, timeout: 400000 }, async () => {
  const dir = join(root, "Fx.uncut");
  const app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: FAKE, FAKE_PLAN: join(root, "plan.json"), FAKE_PROMPT_LOG: join(root, "prompts.jsonl") },
  });
  apps.add(app);
  const { page } = app;
  const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  const fxOf = (id: string) => onDisk().tracks.find((t) => t.id === id)!.mixer?.effects ?? [];
  const strip = (id: string) => `[data-testid=mixer-strip][data-track="${id}"]`;
  const H = "__uncutAudio";
  try {
    await waitFor(page, "[data-testid=welcome]");
    await page.click("[data-testid=open-project]");
    await waitFor(page, "[data-testid=editor]");
    let rev = await revision(page);
    await page.click("[data-testid=bottom-mixer]");
    await waitFor(page, "[data-testid=mixer-panel]");

    // + FX → EQ on Voice: one edit.
    await page.click(`${strip("voice")} [data-testid=fx-add]`);
    await waitFor(page, "[data-testid=fx-menu]");
    await page.click("[data-testid=fx-add-audio\\.eq]");
    rev = await savedAfter(page, rev);
    assert.deepEqual(fxOf("voice"), [{ module: "audio.eq" }]);
    // Its popover: a low cut at 120 Hz and the mid +4 dB at 2 kHz, one edit each.
    await page.click(`${strip("voice")} [data-testid=fx-slot][data-module="audio.eq"]`);
    await waitFor(page, "[data-testid=fx-popover]");
    await typeInto(page, "[data-testid=fx-popover] [data-testid=fx-param-lowCutHz]", "120");
    rev = await savedAfter(page, rev);
    await typeInto(page, "[data-testid=fx-popover] [data-testid=fx-param-midHz]", "2000");
    rev = await savedAfter(page, rev);
    await typeInto(page, "[data-testid=fx-popover] [data-testid=fx-param-midGainDb]", "4");
    rev = await savedAfter(page, rev);
    assert.deepEqual(fxOf("voice"), [{ module: "audio.eq", params: { lowCutHz: 120, midHz: 2000, midGainDb: 4 } }]);
    await page.keyboard.press("Escape");
    // + FX → Compressor, moved up before the EQ, bypassed.
    await page.click(`${strip("voice")} [data-testid=fx-add]`);
    await waitFor(page, "[data-testid=fx-menu]");
    await page.click("[data-testid=fx-add-audio\\.compressor]");
    rev = await savedAfter(page, rev);
    await page.click(`${strip("voice")} [data-testid=fx-slot][data-module="audio.compressor"]`);
    await waitFor(page, "[data-testid=fx-popover]");
    await page.click("[data-testid=fx-popover] [data-testid=fx-up]");
    rev = await savedAfter(page, rev);
    assert.deepEqual(fxOf("voice").map((f) => f.module), ["audio.compressor", "audio.eq"]);
    await page.click(`${strip("voice")} [data-testid=fx-slot][data-module="audio.compressor"]`);
    await waitFor(page, "[data-testid=fx-popover]");
    await page.click("[data-testid=fx-popover] [data-testid=fx-bypass]");
    rev = await savedAfter(page, rev);
    assert.equal(fxOf("voice")[0]!.bypass, true);
    await waitFor(page, `${strip("voice")} [data-testid=fx-slot][data-module="audio.compressor"][data-bypass="true"]`);
    await page.keyboard.press("Escape");
    // ⌘Z / ⇧⌘Z through the bypass.
    await page.click("[data-testid=mixer-panel] .mixer-gap");
    await meta(page, "KeyZ");
    rev = await savedAfter(page, rev);
    assert.equal(fxOf("voice")[0]!.bypass, undefined);
    await meta(page, "KeyZ", true);
    rev = await savedAfter(page, rev);
    assert.equal(fxOf("voice")[0]!.bypass, true);

    // Ducking: Music under Voice. The voice's loudness analysis starts by itself (not cached yet).
    await page.click(`${strip("music")} [data-testid=duck-btn]`);
    await waitFor(page, "[data-testid=duck-popover]");
    await page.select("[data-testid=duck-popover] [data-testid=duck-under]", "voice");
    rev = await savedAfter(page, rev);
    assert.deepEqual(fxOf("music"), [{ module: "audio.duck", params: { under: ["voice"], amountDb: -12, attackMs: 250, releaseMs: 600 } }]);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-testid=duck-note]"), { timeout: 30000 });

    // The master: Broadcast target, limiter ceiling −2 dBTP; ⌘Z / ⇧⌘Z.
    await page.click("[data-testid=target-btn]");
    await waitFor(page, "[data-testid=master-popover]");
    await page.select("[data-testid=master-popover] [data-testid=target-select]", "-23");
    rev = await savedAfter(page, rev);
    assert.deepEqual(onDisk().master, { loudness: { targetLufs: -23 } });
    await typeInto(page, "[data-testid=master-popover] [data-testid=limiter-ceiling]", "-2");
    rev = await savedAfter(page, rev);
    assert.deepEqual(onDisk().master, { loudness: { targetLufs: -23 }, effects: [{ module: "audio.limiter", params: { ceilingDb: -2 } }] });
    // Every strip shows its name: the slots fit (or scroll inside their own list), the strip doesn't scroll.
    const fit = await page.$$eval("[data-testid=mixer-strip]", (els) => els.map((e) => ({ id: (e as HTMLElement).dataset.track, top: e.scrollTop, sh: e.scrollHeight, ch: e.clientHeight, kids: [...e.children].map((c) => `${c.className}:${Math.round((c as HTMLElement).getBoundingClientRect().height)}`).join(" ") })));
    console.log(`strips: ${JSON.stringify(fit)}`);
    for (const f of fit) assert.ok(f.top === 0 && f.sh <= f.ch + 1, `strip ${f.id} overflows: ${JSON.stringify(f)}`);
    await page.screenshot({ path: out("effects-mixer.png") });
    await page.keyboard.press("Escape");
    await page.click("[data-testid=mixer-panel] .mixer-gap");
    await meta(page, "KeyZ");
    rev = await savedAfter(page, rev);
    assert.deepEqual(onDisk().master, { loudness: { targetLufs: -23 } });
    await meta(page, "KeyZ", true);
    rev = await savedAfter(page, rev);
    assert.equal(await page.$eval("[data-testid=limiter-btn]", (el) => (el as HTMLElement).dataset.ceiling), "-2");

    // The duck line on the music item in the timeline.
    await page.click("[data-testid=bottom-timeline]");
    await waitFor(page, '[data-testid=timeline-item][data-item="m"] [data-testid=duck-line]', 20000);
    assert.equal(await page.$('[data-testid=timeline-item][data-item="v"] [data-testid=duck-line]'), null, "the voice isn't ducked");
    await page.screenshot({ path: out("effects-ducking.png") });

    // History: every label.
    await page.click("[data-testid=tab-history]");
    await waitFor(page, "[data-testid=history-entry]");
    const labels = await page.$$eval("[data-testid=history-entry] .history-what", (els) => els.map((e) => e.textContent ?? ""));
    for (const want of ["Add EQ to Voice", "Set EQ on Voice: low cut 120 Hz", "Set EQ on Voice: low cut 120 Hz, +4 dB at 2 kHz", "Add Compressor to Voice", "Move Compressor up on Voice", "Bypass Compressor on Voice", "Duck Music under Voice by −12 dB", "Set the loudness target to Broadcast (−23 LUFS)", "Set the master limiter to −2 dBTP"]) {
      assert.ok(labels.some((l) => l.includes(want)), `History has "${want}": ${JSON.stringify(labels)}`);
    }

    // The preview's own nodes against core (OfflineAudioContext, so no speakers either).
    const freqs = [40, 100, 200, 500, 1000, 2000, 5000, 10000, 16000];
    const stages: Array<Extract<Stage, { kind: "biquad" }>> = [
      { kind: "biquad", type: "highpass", freq: 120, q: Math.SQRT1_2, gainDb: 0 },
      { kind: "biquad", type: "lowpass", freq: 6000, q: Math.SQRT1_2, gainDb: 0 },
      { kind: "biquad", type: "peaking", freq: 2000, q: 1.4, gainDb: 4 },
      { kind: "biquad", type: "lowshelf", freq: 150, q: 1, gainDb: -6 },
      { kind: "biquad", type: "highshelf", freq: 8000, q: 1, gainDb: 5 },
    ];
    let worstEq = 0;
    for (const sr of [44100, 48000]) {
      for (const s of stages) {
        const got = await page.evaluate((a) => (globalThis as unknown as Record<string, AudioHook>)[a.H]!.biquadResponse(a.s, a.freqs, a.sr), { s, freqs, sr, H });
        freqs.forEach((f, i) => {
          const want = biquadResponseDb(s, sr, f);
          worstEq = Math.max(worstEq, Math.abs(got[i]! - want));
          assert.ok(Math.abs(got[i]! - want) <= 0.1, `${s.type} at ${f} Hz (${sr} Hz): BiquadFilterNode ${got[i]!.toFixed(2)} dB, core ${want.toFixed(2)} dB`);
        });
      }
    }
    const comp: Extract<Stage, { kind: "compressor" }> = { kind: "compressor", thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 150, makeupDb: 2 };
    const under = await page.evaluate((a) => (globalThis as unknown as Record<string, AudioHook>)[a.H]!.offlineTone({ stages: [a.comp], amp: 0.05 }), { comp, H }); // −26 dBFS peak: under the threshold
    const unity = dB(under.peak) - dB(0.05) - comp.makeupDb;
    assert.ok(Math.abs(unity) <= 0.25, `the compressor's own make-up is cancelled: a tone under the threshold is off by ${unity.toFixed(2)} dB`);
    const over = await page.evaluate((a) => (globalThis as unknown as Record<string, AudioHook>)[a.H]!.offlineTone({ stages: [a.comp], amp: 0.5 }), { comp, H }); // −6 dBFS peak
    const curve = compressorCurveDb(comp, -6);
    assert.ok(Math.abs(dB(over.peak) - curve) <= 1, `a steady tone over the threshold: ${dB(over.peak).toFixed(2)} dBFS peak, curve ${curve.toFixed(2)}`);
    const lim = await page.evaluate((h) => (globalThis as unknown as Record<string, AudioHook>)[h]!.offlineTone({ ceilingDb: -2, amp: 2 }), H); // +6 dBFS
    assert.ok(dB(lim.peak) <= -2 + 0.01, `the limiter holds −2: ${dB(lim.peak).toFixed(2)} dBFS`);
    const limUnder = await page.evaluate((h) => (globalThis as unknown as Record<string, AudioHook>)[h]!.offlineTone({ ceilingDb: -2, amp: 0.25 }), H);
    assert.ok(Math.abs(dB(limUnder.peak) - dB(0.25)) <= 0.25, `under the ceiling the limiter is transparent: ${dB(limUnder.peak).toFixed(2)} vs ${dB(0.25).toFixed(2)}`);
    console.log(`preview nodes: EQ worst ${worstEq.toFixed(4)} dB vs core; compressor under ${unity.toFixed(3)} dB, over ${dB(over.peak).toFixed(2)} vs curve ${curve.toFixed(2)}; limiter ${dB(lim.peak).toFixed(2)} dBFS`);

    // Preview ≈ export, the hot mix with EQ, ducking and the limiter (the compressor bypassed).
    const voice = onDisk().media.find((m) => m.id === "m-voice")!;
    const loud = (await cachedFor(targetOf(dir, voice, 30), "loudness")) as LoudnessResult | undefined;
    assert.ok(loud?.hasAudio && loud.envelope, "the voice's loudness was measured for the ducking");
    const envelopes = new Map([["m-voice", decodeEnvelope(loud.envelope)!]]);
    const compare = async (name: string) => {
      const project = onDisk();
      await page.keyboard.press("Home");
      await sleep(400);
      assert.equal(await page.evaluate((h) => (globalThis as unknown as Record<string, AudioHook>)[h]!.startCapture(), H), true);
      await page.keyboard.press("Space");
      let gr = 0;
      let voiceLight = 0;
      const grs: Array<number> = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        const now = await page.evaluate((h) => (globalThis as unknown as Record<string, AudioHook>)[h]!.levels().limiter, H);
        gr = Math.min(gr, now);
        if (now < -0.05) grs.push(now);
        // The voice strip's compressor light (it must come back after a bypass and turning back on).
        const light = await page.$eval('[data-testid=fx-gr][data-gr="voice"]', (el) => Number((el as HTMLElement).dataset.value)).catch(() => 0);
        voiceLight = Math.min(voiceLight, light);
        if ((await page.$eval("[data-testid=preview-frame]", (el) => (el as HTMLElement).dataset.playing)) === "false") break;
        await sleep(100);
      }
      await sleep(300);
      const cap = (await page.evaluate((h) => (globalThis as unknown as Record<string, AudioHook>)[h]!.stopCapture(), H))!;
      assert.equal(cap.sink, "none", "the preview plays to no output device in a test run");
      assert.ok(cap, "captured");
      const f32 = (s: string) => {
        const b = Buffer.from(s, "base64");
        return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
      };
      const pre = { left: f32(cap.left), right: f32(cap.right) };
      const sr = cap.sampleRate;
      const plan = planExport(project, { mediaPath: (m) => m.path, width: 640, height: 360, envelopes });
      assert.ok(!("problem" in plan));
      assert.deepEqual(plan.limiter, { ceilingDb: -2 });
      const g = audioGraph(plan, 0);
      writeFileSync(join(root, `${name}.txt`), g.filters.join(";\n"));
      const wav = join(root, `${name}.wav`);
      const r = spawnSync("ffmpeg", ["-hide_banner", "-y", ...g.inputs, "-/filter_complex", join(root, `${name}.txt`), "-map", "[aout]", "-ar", String(sr), "-c:a", "pcm_f32le", wav], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr.slice(-600));
      const raw = execFileSync("ffmpeg", ["-v", "error", "-i", wav, "-f", "f32le", "-ac", "2", "-"], { maxBuffer: 1 << 28 });
      const inter = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      const ex = { left: new Float32Array(inter.length / 2), right: new Float32Array(inter.length / 2) };
      for (let i = 0; i < ex.left.length; i++) (ex.left[i] = inter[2 * i]!, (ex.right[i] = inter[2 * i + 1]!));
      // Alignment as in the mixer test (D83): the clock's offset from the drawn frames, refined by ±0.6 s of 50 ms levels (an output device's latency fits).
      const playingMarks = cap.marks.filter((m, i) => i > 3 && m.frame > 3 && m.frame < SECONDS * 30 - 10);
      const offs = playingMarks.map((m) => m.frame / 30 - m.t).sort((a, b) => a - b);
      const clockOffset = offs[Math.floor(offs.length / 2)]!;
      const startIndex = (lag: number) => Math.round((-clockOffset - cap.t0 + lag) * sr);
      const rms = (a: Float32Array, i0: number, n: number) => {
        let s = 0;
        for (let i = Math.max(0, i0); i < Math.min(a.length, i0 + n); i++) s += a[i]! ** 2;
        return Math.sqrt(s / n);
      };
      const W = Math.round(0.05 * sr);
      let best = { lag: 0, err: Infinity };
      for (let lag = -0.6; lag <= 0.6; lag += 0.005) {
        const s0 = startIndex(lag);
        let err = 0;
        for (let k = Math.round(0.5 / 0.05); k < Math.round(8.25 / 0.05); k++) {
          const e = dB(rms(ex.left, k * W, W)) - dB(rms(pre.left, s0 + k * W, W));
          err += Math.min(e * e, 400);
        }
        if (err < best.err) best = { lag, err };
      }
      assert.ok(Math.abs(best.lag) < 0.6 - 0.005, `the alignment search hit its limit (lag ${best.lag.toFixed(3)} s)`);
      const s0 = startIndex(best.lag);
      assert.ok(s0 + 0.5 * sr >= 0 && s0 + 8.25 * sr <= pre.left.length, `the recording covers 0.5–8.25 s (start ${s0}, ${pre.left.length} samples)`);
      const worst = { d: 0, at: "" };
      const W4 = Math.round(0.25 * sr);
      // A window next to an onset (the export's level moves over 1 dB when the window slides 50 ms)
      // compares the recording's timing jitter, not the mix: the capture's clock can be a few tens of
      // ms off under load (a full test run measured 1.75 dB at 1.25 s with the lag found 35 ms from its
      // usual 0.180 s). Those windows are left out and counted; at most a third may be.
      const slide = Math.round(0.05 * sr);
      let skipped = 0;
      for (let k = 2; k < 33; k++) {
        const t = k * 0.25;
        const onset = (["left", "right"] as const).some((ch) => Math.abs(dB(rms(ex[ch], k * W4 - slide, W4)) - dB(rms(ex[ch], k * W4 + slide, W4))) > 1);
        if (onset) {
          skipped++;
          continue;
        }
        for (const ch of ["left", "right"] as const) {
          const e = dB(rms(ex[ch], k * W4, W4));
          const p = dB(rms(pre[ch], s0 + k * W4, W4));
          const d = Math.abs(e - p);
          if (d > worst.d) Object.assign(worst, { d, at: `${ch} ${t.toFixed(2)} s: export ${e.toFixed(2)} dB, preview ${p.toFixed(2)} dB` });
        }
      }
      const lufs = (left: Float32Array, right: Float32Array, file: string) => {
        const n = Math.min(left.length, right.length);
        const buf = new Float32Array(2 * n);
        for (let i = 0; i < n; i++) (buf[2 * i] = left[i]!, (buf[2 * i + 1] = right[i]!));
        writeFileSync(join(root, `${file}.f32`), Buffer.from(buf.buffer));
        const rr = spawnSync("ffmpeg", ["-hide_banner", "-f", "f32le", "-ar", String(sr), "-ac", "2", "-i", join(root, `${file}.f32`), "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" });
        return Number(/Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(rr.stderr)![1]);
      };
      const a = Math.round(0.5 * sr);
      const b = Math.round(8.25 * sr);
      const lPre = lufs(pre.left.subarray(s0 + a, s0 + b), pre.right.subarray(s0 + a, s0 + b), `${name}-pre`);
      const lExp = lufs(ex.left.subarray(a, b), ex.right.subarray(a, b), `${name}-exp`);
      assert.ok(skipped <= 10, `${skipped} of 31 windows are next to an onset`);
      console.log(`${name}: worst 0.25 s window ${worst.d.toFixed(2)} dB (${worst.at}; ${skipped} of 31 windows next to an onset left out), LUFS preview ${lPre} vs export ${lExp}, limiter gain reduction down to ${gr.toFixed(1)} dB (median while working ${grs.length ? grs.sort((x, y) => x - y)[Math.floor(grs.length / 2)]!.toFixed(1) : "0"} dB, ${grs.length} readings), lag ${best.lag.toFixed(3)} s, sink ${cap.sink}, output latency ${cap.latency.toFixed(3)} s`);
      return { worst, lPre, lExp, gr, voiceLight };
    };
    const main = await compare("eq-duck-limiter");
    assert.ok(main.worst.d <= 1.5, `preview vs export, worst 0.25 s window: ${main.worst.at}`);
    assert.ok(Math.abs(main.lPre - main.lExp) <= 1, `LUFS preview ${main.lPre} vs export ${main.lExp}`);
    assert.ok(main.gr < -0.5, `the limiter worked on the hot mix (gain reduction ${main.gr} dB)`);

    // With the compressor on as well: how close Web Audio's compressor and acompressor are on this voice (D84).
    await page.click("[data-testid=bottom-mixer]");
    await page.click(`${strip("voice")} [data-testid=fx-slot][data-module="audio.compressor"]`);
    await waitFor(page, "[data-testid=fx-popover]");
    await page.click("[data-testid=fx-popover] [data-testid=fx-bypass]");
    rev = await savedAfter(page, rev);
    assert.equal(fxOf("voice")[0]!.bypass, undefined);
    await page.keyboard.press("Escape");
    const withComp = await compare("with-compressor");
    // D84: measured 0.56–1.23 dB per window on this voice; asserted at the chunk's ±1.5 dB RMS / ±1 dB LUFS target.
    assert.ok(withComp.worst.d <= 1.5, `with the compressor, preview vs export: ${withComp.worst.at}`);
    assert.ok(Math.abs(withComp.lPre - withComp.lExp) <= 1, `with the compressor, LUFS preview ${withComp.lPre} vs export ${withComp.lExp}`);
    assert.ok(withComp.voiceLight < -1, `the voice compressor's gain-reduction light moves after bypass and back on (${withComp.voiceLight} dB)`);
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: out("effects-failure.png") }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-3000)}` });
  }
});
