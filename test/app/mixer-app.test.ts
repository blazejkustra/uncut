// Phase 6 chunk 6 (D83) on the packaged app, run invisibly and muted (the background test window's
// audio is muted, so nothing reaches the speakers while the graph still runs and meters):
// - the Mixer tab: a strip per track with sound and the master; a fader drag, a pan drag and solo
//   are one edit each with their History labels, ⌘Z/⇧⌘Z step through them, double-click resets;
// - the meters move during playback (and a soloed-out track's meter stays down);
// - the volume line on a clip: a click adds a key on the line, dragging a key moves it (one edit),
//   ⌫ removes a selected key without deleting its item, ⌘Z/⇧⌘Z;
// - preview ≈ export: the preview's master output, recorded sample for sample while it plays a mix
//   with pan, keys, a fade, a track volume and the master volume, against the export's mix of the
//   same project.json (planExport + audioGraph, what the export runs): every 0.25 s window within
//   1.5 dB RMS per channel, and integrated loudness within 1 dB LUFS.
// Screenshots: test-output/mixer-panel.png, test-output/mixer-envelope.png.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import { launchApp, lockApps, unlockApps, type LaunchedApp, waitForWelcome } from "../helpers/app.ts";
import { audioGraph, planExport } from "../../apps/server/src/export/exportPlan.ts";
import { dbWords } from "../../packages/core/src/timeline/edit-log.ts";
import { levelY } from "../../apps/web/src/audio/sound.ts";
import type { Project } from "../../packages/core/src/timeline/types.ts";

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
const center = async (page: Page, selector: string) => {
  const b = (await (await page.$(selector))!.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
};
async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await page.mouse.up();
}
const dB = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
const meterDb = (page: Page, id: string) => page.$eval(`[data-meter="${id}"]`, (el) => Number((el as HTMLElement).dataset.peak));

before(async () => {
  if (skip) return;
  await lockApps();
  mkdirSync("test-output", { recursive: true });
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-mixer-")));
  const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  // Voice: mono 440 Hz at 0.25. Music: stereo, 550 Hz at 0.2 left and 770 Hz at 0.1 right. Talk: 6 s with
  // 660 Hz at 0.25, used as a 4 s clip, so its sound stopping at 4 s is the mix's doing, not the file's end.
  ff("-f", "lavfi", "-i", "aevalsrc=0.25*sin(2*PI*440*t):s=48000:d=9", "-c:a", "aac", "-b:a", "192k", join(root, "Voice.m4a"));
  ff("-f", "lavfi", "-i", "aevalsrc=0.2*sin(2*PI*550*t)|0.1*sin(2*PI*770*t):s=48000:d=9:c=stereo", "-c:a", "aac", "-b:a", "256k", join(root, "Music.m4a"));
  ff("-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-f", "lavfi", "-i", "aevalsrc=0.25*sin(2*PI*660*t):s=48000", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", join(root, "Talk.mp4"));
  const dir = join(root, "Mix.uncut");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify({
      format: "uncut/0",
      name: "Mix",
      canvas: { width: 1280, height: 720, fps: 30 },
      media: [
        { id: "m-talk", kind: "video", name: "Talk.mp4", path: join(root, "Talk.mp4"), probe: { frames: 180, fps: 30, width: 320, height: 240, hasAudio: true } },
        { id: "m-voice", kind: "audio", name: "Voice.m4a", path: join(root, "Voice.m4a"), probe: { frames: 270 } },
        { id: "m-music", kind: "audio", name: "Music.m4a", path: join(root, "Music.m4a"), probe: { frames: 270 } },
      ],
      tracks: [
        { id: "text", kind: "text", name: "Text", items: [] },
        { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 120 }] },
        { id: "voice", kind: "audio", name: "Voice", items: [{ id: "v", type: "audio", media: "m-voice", in: 0, start: 0, duration: 240 }] },
        { id: "music", kind: "audio", name: "Music", items: [{ id: "m", type: "audio", media: "m-music", in: 0, start: 0, duration: 240, fadeIn: 60, fadeOut: 45 }] },
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

test("Mixer: faders, pan, solo, meters, volume keys on the timeline, undo, History, and the preview's mix ≈ the export's", { skip, timeout: 300000 }, async () => {
  const dir = join(root, "Mix.uncut");
  const app = await launchApp({
    command: APP,
    env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_TEST_DIALOG: JSON.stringify([dir]), UNCUT_CLAUDE: FAKE, FAKE_PLAN: join(root, "plan.json"), FAKE_PROMPT_LOG: join(root, "prompts.jsonl") },
  });
  apps.add(app);
  const { page } = app;
  const onDisk = (): Project => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
  const mixerOf = (id: string) => onDisk().tracks.find((t) => t.id === id)!.mixer;
  const voiceItem = () => onDisk().tracks.find((t) => t.id === "voice")!.items[0]!;
  try {
    await waitForWelcome(page);
    await page.click("[data-testid=open-project]");
    await waitFor(page, "[data-testid=editor]");
    let rev = await revision(page);

    // The Mixer: strips for the three tracks with sound (timeline order: main, voice, music) and the master.
    await page.click("[data-testid=bottom-mixer]");
    await waitFor(page, "[data-testid=mixer-panel]");
    assert.deepEqual(await page.$$eval("[data-testid=mixer-strip]", (els) => els.map((e) => (e as HTMLElement).dataset.track)), ["main", "voice", "music"]);
    await waitFor(page, "[data-testid=mixer-master]");

    // Drag the Voice fader down to about −6 dB: one edit.
    const fader = '[data-testid=mixer-strip][data-track="voice"] [data-testid=mixer-fader]';
    const h = await page.$eval(fader, (el) => (el as HTMLElement).clientHeight);
    const thumb = await center(page, `${fader} [data-testid=mixer-fader-thumb]`);
    await drag(page, thumb, 0, (levelY(-6) - levelY(0)) * h);
    rev = await savedAfter(page, rev);
    const voiceDb = mixerOf("voice")!.gainDb!;
    assert.ok(Math.abs(voiceDb + 6) <= 0.75, `fader at ${voiceDb} dB`);
    const afterFader = rev;
    await sleep(300);
    assert.equal(await revision(page), afterFader, "the drag was one edit");
    assert.equal(await page.$eval('[data-testid=mixer-strip][data-track="voice"] [data-testid=mixer-db]', (el) => el.textContent), voiceDb === 0 ? "0" : `−${Math.abs(voiceDb)}`);

    // Pan Music about 30 % left.
    const pan = '[data-testid=mixer-strip][data-track="music"] [data-testid=mixer-pan]';
    const panBox = (await (await page.$(pan))!.boundingBox())!;
    await drag(page, { x: panBox.x + panBox.width / 2, y: panBox.y + panBox.height / 2 }, -0.3 * (panBox.width / 2), 0);
    rev = await savedAfter(page, rev);
    const musicPan = mixerOf("music")!.pan!;
    assert.ok(musicPan < -0.2 && musicPan > -0.4, `pan ${musicPan}`);

    // Solo Voice: the note says so; the meters move while playing, Music's stays down.
    await page.click('[data-testid=mixer-strip][data-track="voice"] [data-testid=mixer-solo]');
    rev = await savedAfter(page, rev);
    assert.deepEqual(mixerOf("voice"), { gainDb: voiceDb, solo: true });
    await waitFor(page, "[data-testid=mixer-solo-note]");
    assert.equal(await page.$eval("[data-testid=mixer-solo-note]", (el) => el.textContent), "Solo is on: only Voice will be heard, in the preview and the export.");
    await page.keyboard.press("Home");
    await page.keyboard.press("Space");
    await sleep(700);
    const meters = { voice: await meterDb(page, "voice"), music: await meterDb(page, "music"), main: await meterDb(page, "main"), master: await meterDb(page, "master") };
    await page.screenshot({ path: out("mixer-panel.png") });
    await page.keyboard.press("Space");
    // Voice: 0.25 peak at −6 dB ≈ −18 dBFS on both channels.
    assert.ok(meters.voice > -24 && meters.voice < -12, `voice meter ${JSON.stringify(meters)}`);
    assert.ok(meters.master > -24, `master meter ${JSON.stringify(meters)}`);
    assert.ok(!(meters.music > -70) && !(meters.main > -70), `soloed out: ${JSON.stringify(meters)}`);
    await sleep(500);
    assert.ok(!((await meterDb(page, "master")) > -70), "the meters fall back when paused");

    // Unsolo; double-click the fader: back to 0 dB; ⌘Z puts −6 back, ⇧⌘Z resets again, ⌘Z once more.
    await page.click('[data-testid=mixer-strip][data-track="voice"] [data-testid=mixer-solo]');
    rev = await savedAfter(page, rev);
    assert.deepEqual(mixerOf("voice"), { gainDb: voiceDb });
    await page.click(fader, { clickCount: 2 });
    rev = await savedAfter(page, rev);
    assert.equal(mixerOf("voice"), undefined, "double-click: 0 dB (the field goes)");
    await meta(page, "KeyZ");
    rev = await savedAfter(page, rev);
    assert.deepEqual(mixerOf("voice"), { gainDb: voiceDb });
    await meta(page, "KeyZ", true);
    rev = await savedAfter(page, rev);
    assert.equal(mixerOf("voice"), undefined);
    await meta(page, "KeyZ");
    rev = await savedAfter(page, rev);
    assert.deepEqual(mixerOf("voice"), { gainDb: voiceDb });
    // The pan's double-click centres it (then ⌘Z).
    await page.click(pan, { clickCount: 2 });
    rev = await savedAfter(page, rev);
    assert.equal(mixerOf("music"), undefined);
    await meta(page, "KeyZ");
    rev = await savedAfter(page, rev);
    assert.deepEqual(mixerOf("music"), { pan: musicPan });

    // The master fader, a little down.
    const master = "[data-testid=mixer-master-fader]";
    const mh = await page.$eval(master, (el) => (el as HTMLElement).clientHeight);
    await drag(page, await center(page, `${master} [data-testid=mixer-master-fader-thumb]`), 0, (levelY(-2.5) - levelY(0)) * mh);
    rev = await savedAfter(page, rev);
    const masterDb = onDisk().master!.gainDb!;
    assert.ok(masterDb <= -1 && masterDb >= -4.5, `master ${masterDb}`);
    await waitFor(page, "[data-testid=mixer-master-note]");
    // The mono Voice a little right too, so the preview ≈ export check covers the mono up-mix + pan.
    const voicePanEl = '[data-testid=mixer-strip][data-track="voice"] [data-testid=mixer-pan]';
    const vpb = (await (await page.$(voicePanEl))!.boundingBox())!;
    await drag(page, { x: vpb.x + vpb.width / 2, y: vpb.y + vpb.height / 2 }, 0.25 * (vpb.width / 2), 0);
    rev = await savedAfter(page, rev);
    const voicePan = mixerOf("voice")!.pan!;
    assert.ok(voicePan > 0.15 && voicePan < 0.35, `voice pan ${voicePan}`);

    // The volume line on the Voice item: select it, click the line at 1 s and at 6 s (keys on the line,
    // no change in sound), drag the 6 s key down to about −15 dB.
    await page.click("[data-testid=bottom-timeline]");
    await waitFor(page, "[data-testid=timeline]");
    const ppf = await page.$eval("[data-testid=timeline]", (el) => Number((el as HTMLElement).dataset.ppf));
    const item = '[data-testid=timeline-item][data-item="v"]';
    const ib = (await (await page.$(item))!.boundingBox())!;
    await page.mouse.click(ib.x + ib.width * 0.5, ib.y + ib.height - 4);
    await waitFor(page, `${item} [data-testid=envelope-line]`);
    const env = (await (await page.$(`${item} [data-testid=envelope]`))!.boundingBox())!;
    const lineAt = (frame: number, db: number) => ({ x: env.x + frame * ppf, y: env.y + levelY(db) * env.height });
    const clickLine = async (frame: number) => {
      const p = lineAt(frame, 0);
      await page.mouse.click(p.x, p.y);
    };
    await clickLine(30);
    rev = await savedAfter(page, rev);
    await clickLine(180);
    rev = await savedAfter(page, rev);
    const keys = voiceItem().gainKeys!;
    assert.equal(keys.length, 2, JSON.stringify(keys));
    assert.ok(Math.abs(keys[0]!.frame - 30) <= 2 && Math.abs(keys[1]!.frame - 180) <= 2 && keys.every((k) => k.db === 0), JSON.stringify(keys));
    const k2 = keys[1]!.frame;
    const keyEl = `${item} [data-testid=envelope-key][data-frame="${k2}"]`;
    await waitFor(page, keyEl);
    const kc = await center(page, keyEl);
    await drag(page, kc, 0, (levelY(-15) - levelY(0)) * env.height);
    rev = await savedAfter(page, rev);
    const moved = voiceItem().gainKeys!;
    assert.equal(moved.length, 2);
    assert.ok(Math.abs(moved[1]!.frame - k2) <= 1, `kept its time: ${JSON.stringify(moved)}`);
    assert.ok(moved[1]!.db < -12 && moved[1]!.db > -18, `dragged to about −15 dB: ${JSON.stringify(moved)}`);
    await (await page.$(item))!.screenshot({ path: out("mixer-envelope.png") });
    // ⌘Z: the key back on the line; ⇧⌘Z: down again.
    await meta(page, "KeyZ");
    rev = await savedAfter(page, rev);
    assert.equal(voiceItem().gainKeys![1]!.db, 0);
    await meta(page, "KeyZ", true);
    rev = await savedAfter(page, rev);
    assert.deepEqual(voiceItem().gainKeys, moved);
    // Select the 1 s key and ⌫: the key goes, the item stays; ⌘Z brings it back.
    await waitFor(page, `${item} [data-testid=envelope-key][data-frame="${moved[0]!.frame}"]`);
    await page.click(`${item} [data-testid=envelope-key][data-frame="${moved[0]!.frame}"]`);
    await waitFor(page, `${item} [data-testid=envelope-key].selected`);
    await page.keyboard.press("Backspace");
    rev = await savedAfter(page, rev);
    assert.deepEqual(voiceItem().gainKeys, [moved[1]]);
    assert.equal(voiceItem().id, "v", "the item is still there");
    await meta(page, "KeyZ");
    rev = await savedAfter(page, rev);
    assert.deepEqual(voiceItem().gainKeys, moved);
    // Drag the 1 s key in time past the 6 s one: it stops one frame before it (no shared frame), one edit.
    const first = await center(page, `${item} [data-testid=envelope-key][data-index="0"]`);
    await drag(page, first, (k2 - moved[0]!.frame + 20) * ppf, 0);
    rev = await savedAfter(page, rev);
    assert.deepEqual(voiceItem().gainKeys!.map((k) => k.frame), [k2 - 1, k2], JSON.stringify(voiceItem().gainKeys));
    assert.equal(voiceItem().gainKeys![1]!.db, moved[1]!.db, "the neighbour is untouched");
    await meta(page, "KeyZ");
    rev = await savedAfter(page, rev);
    assert.deepEqual(voiceItem().gainKeys, moved);

    // History: the labels of the Mixer's and the line's edits.
    await page.click("[data-testid=tab-history]");
    await waitFor(page, "[data-testid=history-entry]");
    const labels = await page.$$eval("[data-testid=history-entry] .history-what", (els) => els.map((e) => e.textContent ?? ""));
    for (const want of [`Set volume of track Voice to ${dbWords(voiceDb)}`, `Pan Music ${Math.round(Math.abs(musicPan) * 100)} % left`, "Solo Voice", "Unsolo Voice", `Pan Voice ${Math.round(voicePan * 100)} % right`, `Set master volume to ${dbWords(masterDb)}`, "Add volume key at 1.0 s", "Add volume key at 6.0 s", `Move volume key to ${(k2 / 30).toFixed(1)} s, ${dbWords(moved[1]!.db)}`, "Remove volume key at 1.0 s"]) {
      assert.ok(labels.some((l) => l.includes(want)), `History has "${want}": ${JSON.stringify(labels)}`);
    }

    // Preview ≈ export: record the master output while the whole mix plays from the start.
    const project = onDisk();
    assert.ok(project.master?.gainDb && project.tracks.find((t) => t.id === "music")!.mixer?.pan && project.tracks.find((t) => t.id === "voice")!.mixer?.gainDb, "the mix has a master volume, a pan and a track volume");
    await page.keyboard.press("Home");
    await sleep(300);
    assert.equal(await page.evaluate(() => (globalThis as unknown as { __uncutAudio: { startCapture(): boolean } }).__uncutAudio.startCapture()), true);
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-testid=preview-frame]")!.dataset.playing === "false", { timeout: 20000 });
    await sleep(300);
    const cap = await page.evaluate(() => (globalThis as unknown as { __uncutAudio: { stopCapture(): { sampleRate: number; t0: number; left: string; right: string; marks: Array<{ t: number; frame: number }>; latency: number; sink: string } } }).__uncutAudio.stopCapture());
    // A background test window plays to no device (D97 note): no headphone latency in the capture.
    assert.equal(cap.sink, "none", "the preview plays to no output device in a test run");
    assert.ok(cap, "captured");
    const f32 = (s: string) => {
      const b = Buffer.from(s, "base64");
      return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    };
    const pre = { left: f32(cap.left), right: f32(cap.right) };
    const sr = cap.sampleRate;
    // The export's mix of the same project.json, as float WAV at the preview's rate.
    const exportMix = (p: Project, name: string) => {
      const plan = planExport(p, { mediaPath: (m) => m.path, width: 640, height: 360 });
      assert.ok(!("problem" in plan));
      const g = audioGraph(plan, 0);
      writeFileSync(join(root, `${name}.txt`), g.filters.join(";\n"));
      const exp = join(root, `${name}.wav`);
      const r = spawnSync("ffmpeg", ["-hide_banner", "-y", ...g.inputs, "-/filter_complex", join(root, `${name}.txt`), "-map", "[aout]", "-ar", String(sr), "-c:a", "pcm_f32le", exp], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr.slice(-600));
      const raw = execFileSync("ffmpeg", ["-v", "error", "-i", exp, "-f", "f32le", "-ac", "2", "-"], { maxBuffer: 1 << 28 });
      const inter = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      const out = { left: new Float32Array(inter.length / 2), right: new Float32Array(inter.length / 2) };
      for (let i = 0; i < out.left.length; i++) (out.left[i] = inter[2 * i]!, (out.right[i] = inter[2 * i + 1]!));
      return out;
    };
    const ex = exportMix(project, "export");
    // The same mix with the clip's hard end 0.12 s earlier and later (D54 keeps elements within 0.12 s
    // of the clock): the range a window touching that edge may honestly read.
    const shifted = (dFrames: number) => ({ ...project, tracks: project.tracks.map((t) => (t.id === "main" ? { ...t, items: t.items.map((i) => ({ ...i, duration: i.duration + dFrames })) } : t)) });
    const exEarly = exportMix(shifted(-0.12 * 30), "export-early");
    const exLate = exportMix(shifted(0.12 * 30), "export-late");

    // Where project time 0 is in the recording: from the frames drawn at each context time while
    // playing (frame / fps − t, median), refined by the best match of 50 ms levels within ±0.25 s
    // (the media elements' own output delay isn't visible to the clock).
    const playingMarks = cap.marks.filter((m, i) => i > 3 && m.frame > 3 && m.frame < 230);
    const offs = playingMarks.map((m) => m.frame / 30 - m.t).sort((a, b) => a - b);
    const clockOffset = offs[Math.floor(offs.length / 2)]!; // project time = context time + offset
    const startIndex = (lag: number) => Math.round((-clockOffset - cap.t0 + lag) * sr); // capture index of project time 0
    const rms = (a: Float32Array, i0: number, n: number) => {
      let s = 0;
      for (let i = Math.max(0, i0); i < Math.min(a.length, i0 + n); i++) s += a[i]! ** 2;
      return Math.sqrt(s / n);
    };
    const W = Math.round(0.05 * sr);
    let best = { lag: 0, err: Infinity };
    // ±0.6 s: wide enough for an output device's latency (Bluetooth ~0.25 s) should a sink ever be used.
    for (let lag = -0.6; lag <= 0.6; lag += 0.005) {
      const s0 = startIndex(lag);
      let err = 0;
      for (let k = Math.round(0.5 / 0.05); k < Math.round(7.5 / 0.05); k++) {
        const e = dB(rms(ex.left, k * W, W)) - dB(rms(pre.left, s0 + k * W, W));
        err += Math.min(e * e, 400);
      }
      if (err < best.err) best = { lag, err };
    }
    assert.ok(Math.abs(best.lag) < 0.6 - 0.005, `the alignment search hit its ±0.6 s limit (lag ${best.lag.toFixed(3)} s): the recording and the clock disagree more than the search covers`);
    const s0 = startIndex(best.lag);
    console.log(`capture: ${sr} Hz, ${pre.left.length} samples from context time ${cap.t0.toFixed(3)}; clock offset ${clockOffset.toFixed(3)} s, lag ${best.lag.toFixed(3)} s (sink ${cap.sink}, output latency ${cap.latency.toFixed(3)} s), project 0 at sample ${s0}`);
    assert.ok(s0 + 0.5 * sr >= 0 && s0 + 7.75 * sr <= pre.left.length, `the recording covers 0.5–7.75 s of the mix (start ${s0}, ${pre.left.length} samples, lag ${best.lag})`);
    // Windows touching a hard item edge (the clip's end at 4 s: no fade, so the level steps) depend
    // on when each element stops, which D54 keeps within 0.12 s of the clock: there the preview must
    // lie between the export with that edge 0.12 s early and 0.12 s late (±0.5 dB), not on the export.
    const hardEdges = [4];
    const worst = { d: 0, at: "" };
    const edge = { d: 0, at: "" };
    const W4 = Math.round(0.25 * sr);
    for (let k = 2; k < 31; k++) {
      // 0.5–7.75 s
      const t = k * 0.25;
      const atEdge = hardEdges.some((e) => e > t - 0.15 && e < t + 0.25 + 0.15);
      for (const ch of ["left", "right"] as const) {
        const e = dB(rms(ex[ch], k * W4, W4));
        const p = dB(rms(pre[ch], s0 + k * W4, W4));
        if (atEdge) {
          const range = [e, dB(rms(exEarly[ch], k * W4, W4)), dB(rms(exLate[ch], k * W4, W4))];
          const lo = Math.min(...range) - 0.5;
          const hi = Math.max(...range) + 0.5;
          const d = p < lo ? lo - p : p > hi ? p - hi : 0;
          if (d >= edge.d) Object.assign(edge, { d, at: `${ch} ${t.toFixed(2)} s: preview ${p.toFixed(2)} dB, export with the edge ±0.12 s ${lo.toFixed(2)}…${hi.toFixed(2)} dB` });
          continue;
        }
        const d = Math.abs(e - p);
        if (d > worst.d) Object.assign(worst, { d, at: `${ch} ${t.toFixed(2)} s: export ${e.toFixed(2)} dB, preview ${p.toFixed(2)} dB` });
      }
    }
    assert.ok(worst.d <= 1.5, `preview vs export, worst 0.25 s window: ${worst.at} (lag ${best.lag.toFixed(3)} s)`);
    assert.ok(edge.d === 0, `preview vs export next to the clip's hard end, outside the ±0.12 s model: ${edge.at}`);
    // Integrated loudness of the same 0.5–7.75 s.
    const lufs = (left: Float32Array, right: Float32Array, name: string) => {
      const n = Math.min(left.length, right.length);
      const buf = new Float32Array(2 * n);
      for (let i = 0; i < n; i++) (buf[2 * i] = left[i]!, (buf[2 * i + 1] = right[i]!));
      writeFileSync(join(root, `${name}.f32`), Buffer.from(buf.buffer));
      const rr = spawnSync("ffmpeg", ["-hide_banner", "-f", "f32le", "-ar", String(sr), "-ac", "2", "-i", join(root, `${name}.f32`), "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" });
      return Number(/Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(rr.stderr)![1]);
    };
    const a = Math.round(0.5 * sr);
    const b = Math.round(7.75 * sr);
    const lPre = lufs(pre.left.subarray(s0 + a, s0 + b), pre.right.subarray(s0 + a, s0 + b), "pre");
    const lExp = lufs(ex.left.subarray(a, b), ex.right.subarray(a, b), "exp");
    assert.ok(Math.abs(lPre - lExp) <= 1, `LUFS preview ${lPre} vs export ${lExp}`);
    console.log(`preview vs export: worst window ${worst.d.toFixed(2)} dB (${worst.at}), at the hard edge ${edge.at}, LUFS ${lPre} vs ${lExp}, lag ${best.lag.toFixed(3)} s`);
    assert.deepEqual(app.errors, []);
  } catch (error) {
    await page.screenshot({ path: out("mixer-failure.png") }).catch(() => {});
    throw Object.assign(error as Error, { message: `${(error as Error).message}\n--- app output ---\n${app.output().slice(-3000)}` });
  }
});
