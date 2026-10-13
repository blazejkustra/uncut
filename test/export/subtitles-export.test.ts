// D105 through the export:
// - the plan: a Subtitles track's plain cues are a few raster layers (each frame textHtml of its
//   cue, nothing between), not one ffmpeg input per cue; burnCaptions false draws neither captions
//   nor Subtitles tracks; the command muxes a soft track as mov_text with a language tag;
// - on the bundled server: a .srt imported with media.import (a Subtitles track; a bad file refused
//   with its reason), an export with a .vtt next to the video and a soft track and burn-in off (no
//   caption pixels; ffprobe shows the mov_text stream in Polish; the track read back is the cues),
//   burn-in on draws the cues on their frames, and export.subtitles writes just the file (refusals).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { applyEdit, createSession, flattenCues, parseSubtitles, planImportSubtitles, planMakeCaptions, subtitleCues, textHtml, writeSrt, writeVtt, type Project } from "../../packages/core/src/index.ts";
import { exportCommand, planExport } from "../../apps/server/src/export/exportPlan.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skipServer = !existsSync(BUNDLE) || !existsSync(MEDIA) || !existsSync(DESKTOP) ? "server, desktop or media core not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";

const W = 1280;
const H = 720;
const BG = "#203040";

// Captions over a cut (as captions-export.test.ts): cards at 6–57 and 78–114.
const WORDS = [
  { text: "Alpha", start: 0.2, end: 0.6 },
  { text: "Bravo", start: 0.7, end: 1.1 },
  { text: "Charlie.", start: 1.2, end: 1.6 },
  { text: "Delta", start: 2.2, end: 2.6 },
  { text: "Echo", start: 4.6, end: 5.0 },
  { text: "Foxtrot.", start: 5.1, end: 5.5 },
];
const SRT = "1\n00:00:00,500 --> 00:00:01,000\nFirst cue\n\n2\n00:00:01,000 --> 00:00:02,000\nSecond cue\n\n3\n00:00:02,500 --> 00:00:03,500\nThird cue\non two lines\n";

function base(path: string): Project {
  return {
    format: "uncut/0",
    name: "Subtitles export",
    canvas: { width: W, height: H, fps: 30 },
    textLooks: 1,
    media: [{ id: "m-talk", kind: "video", name: "Talk.mp4", path, probe: { frames: 180, fps: 30, width: 640, height: 360, hasAudio: true } }],
    tracks: [
      {
        id: "main",
        kind: "video",
        role: "main",
        name: "Main",
        items: [
          { id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 60 },
          { id: "clip-2", type: "clip", media: "m-talk", in: 120, duration: 60 },
        ],
      },
    ],
  };
}
function withCaptions(project: Project): Project {
  const plan = planMakeCaptions(project, { media: "m-talk", transcript: { words: WORDS, language: "en", seconds: 6 } });
  assert.ok(!("problem" in plan));
  return applyEdit(createSession(project), { actor: "user", ops: plan.ops }).project;
}
function withSubtitles(project: Project): Project {
  const parsed = parseSubtitles(SRT, "talk.srt");
  assert.ok(!("problem" in parsed));
  const plan = planImportSubtitles(project, parsed.cues, "talk.srt");
  assert.ok(!("problem" in plan));
  return applyEdit(createSession(project), { actor: "user", ops: plan.ops }).project;
}

test("plan: a Subtitles track's cues are a few layers drawn like each text item; burn-in off draws no captions or cues; the soft track's arguments", () => {
  const project = withSubtitles(withCaptions(base("/tmp/none.mp4")));
  const plan = planExport(project, { mediaPath: () => "/tmp/none.mp4", width: W, height: H });
  assert.ok(!("problem" in plan));
  const subs = project.tracks.find((t) => t.name === "Subtitles")!;
  const layers = plan.visuals.filter((l) => l.track.id === subs.id);
  // Cues at 15–30, 30–60 (touching: one run) and 75–105.
  assert.deepEqual(layers.map((l) => [l.f0, l.f1]), [[15, 60], [75, 105]]);
  for (const layer of layers) {
    assert.ok(layer.kind === "raster");
    if (layer.kind !== "raster") continue;
    for (let f = layer.f0; f < layer.f1; f++) {
      const cue = subs.items.find((i) => i.start! <= f && f < i.start! + i.duration)!;
      assert.equal(layer.states[layer.frames[f - layer.f0]!], textHtml(cue, project), `frame ${f}`);
    }
  }
  assert.equal(plan.visuals.filter((l) => l.item.type === "captions").length, 2);

  const bare = planExport(project, { mediaPath: () => "/tmp/none.mp4", width: W, height: H, burnCaptions: false });
  assert.ok(!("problem" in bare));
  assert.deepEqual(bare.visuals.filter((l) => l.item.type === "captions" || l.track.id === subs.id), []);
  assert.equal(bare.frames, 120);

  // A cue with its own animation is drawn on its own (the normal text path), the rest still together.
  const animated: Project = { ...project, tracks: project.tracks.map((t) => (t.id === subs.id ? { ...t, items: t.items.map((i, k) => (k === 1 ? { ...i, animation: { in: { module: "move.fade", duration: 5 } } } : i)) } : t)) };
  const mixed = planExport(animated, { mediaPath: () => "/tmp/none.mp4", width: W, height: H });
  assert.ok(!("problem" in mixed));
  assert.deepEqual(mixed.visuals.filter((l) => l.track.id === subs.id).map((l) => [l.f0, l.f1]).sort((a, b) => a[0]! - b[0]!), [[15, 30], [30, 60], [75, 105]]);

  // Cues a user dragged onto each other: each drawn on its own (both show, as in the preview); the rest still merged.
  const overlapped: Project = { ...project, tracks: project.tracks.map((t) => (t.id === subs.id ? { ...t, items: t.items.map((i, k) => (k === 1 ? { ...i, start: 70, duration: 20 } : i)) } : t)) };
  const both = planExport(overlapped, { mediaPath: () => "/tmp/none.mp4", width: W, height: H });
  assert.ok(!("problem" in both));
  const own = both.visuals.filter((l) => l.track.id === subs.id);
  assert.deepEqual(own.map((l) => [l.item.id, l.f0, l.f1]).sort((a, b) => Number(a[1]) - Number(b[1])), [[subs.items[0]!.id, 15, 30], [subs.items[1]!.id, 70, 90], [subs.items[2]!.id, 75, 105]]);
  for (const f of [80, 85]) assert.equal(own.filter((l) => l.f0 <= f && f < l.f1).length, 2, `frame ${f}: both cues drawn`);

  const cmd = exportCommand(bare, { background: "/tmp/bg.png", rasters: new Map(), caps: { encoders: new Set(), videotoolboxDecode: false }, quality: "standard", output: "/tmp/out.mp4", subtitles: { file: "/tmp/subs.srt", language: "pol" } });
  const inputs = cmd.inputs.filter((a) => a === "-i").length;
  assert.equal(cmd.inputs.at(-1), "/tmp/subs.srt");
  assert.deepEqual(cmd.inputs.slice(-4), ["-f", "srt", "-i", "/tmp/subs.srt"]);
  const at = cmd.outputArgs.indexOf("mov_text");
  assert.deepEqual(cmd.outputArgs.slice(at - 3, at + 5), ["-map", `${inputs - 1}:s:0`, "-c:s", "mov_text", "-metadata:s:s:0", "language=pol", "-disposition:s:0", "0"]);
  const shown = exportCommand(bare, { background: "/tmp/bg.png", rasters: new Map(), caps: { encoders: new Set(), videotoolboxDecode: false }, quality: "standard", output: "/tmp/out.mp4", subtitles: { file: "/tmp/subs.srt", language: "pol", show: true } });
  assert.equal(shown.outputArgs[shown.outputArgs.indexOf("-disposition:s:0") + 1], "default", "on by default when the captions aren't burned in");
});

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let server: Server;
let client: Client;
let jobs: ReturnType<Client["subscribe"]>;
let imports: ReturnType<Client["subscribe"]>;
const finished = (id: string, timeout = 180000) => jobs.until((list) => list.some((j: any) => j.id === id && ["done", "failed", "cancelled"].includes(j.phase)), timeout).then(() => jobs.values.at(-1).find((j: any) => j.id === id));
const rgbFrames = (file: string) => execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1024 * 1024 * 1024 });
/** Near-white pixels (caption text) in the lower band of frame f. */
function white(all: Buffer, f: number) {
  const size = W * H * 3;
  const px = all.subarray(f * size, (f + 1) * size);
  let n = 0;
  for (let y = Math.round(H * 0.7); y < Math.round(H * 0.97); y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (px[i]! > 220 && px[i + 1]! > 220 && px[i + 2]! > 220) n++;
    }
  }
  return n;
}

before(async () => {
  if (skipServer) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-subtitles-export-test-")));
  mkdirSync(join(root, "out"));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${BG.replace("#", "0x")}:size=640x360:rate=30`, "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(root, "Footage.mp4")]);
  writeFileSync(join(root, "talk.srt"), SRT);
  writeFileSync(join(root, "broken.vtt"), "1\n00:00:01,000 --> 00:00:02,000\nNot a VTT\n");
  server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data") } });
  client = await connect(server.ready.port, server.ready.token);
  jobs = client.subscribe("export.jobs");
  imports = client.subscribe("media.jobs");
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("server: import a .srt, export with a .vtt next to it and a soft track without burn-in, then burned in; subtitles only", { skip: skipServer, timeout: 300000 }, async () => {
  mkdirSync("test-output", { recursive: true });
  const dir = writeProject(root, "Subs", withCaptions(base(join(root, "Footage.mp4"))));
  await client.ok("project.open", { dir });

  // Import: the .srt becomes a Subtitles track (no media); the broken .vtt is refused with its reason.
  const { jobId: importId } = await client.ok("media.import", { paths: [join(root, "talk.srt"), join(root, "broken.vtt")] });
  await imports.until((list) => list.some((j: any) => j.id === importId && (j.phase === "done" || j.phase === "failed")), 60000);
  const imported = imports.values.at(-1).find((j: any) => j.id === importId);
  assert.equal(imported.phase, "done", imported.error);
  assert.deepEqual(imported.result.imported, []);
  assert.deepEqual(imported.result.subtitles.map((s: any) => [s.path, s.cues]), [[join(root, "talk.srt"), 3]]);
  assert.equal(imported.result.failed.length, 1);
  assert.match(imported.result.failed[0].message, /broken\.vtt isn't a WebVTT file/);
  const snap = await client.ok("project.get", {});
  const project = snap.project as Project;
  const subs = project.tracks.find((t) => t.name === "Subtitles")!;
  assert.deepEqual(subs.items.map((i) => [i.start, i.duration, i.text]), [[15, 15, "First cue"], [30, 30, "Second cue"], [75, 30, "Third cue\non two lines"]]);
  assert.equal(project.media.length, 1);
  const cues = subtitleCues(project);
  assert.equal(cues.length, 5, "two caption cards and three cues, merged by time");

  // Export: .vtt next to the video, a Polish soft track, captions not drawn.
  const output = join(root, "out", "Subs.mp4");
  const { jobId } = await client.ok("export.start", { output, quality: "standard", loudness: "off", subtitles: { file: "vtt", track: true, language: "pl" }, burnCaptions: false });
  const done = await finished(jobId);
  assert.equal(done.phase, "done", done.error);
  assert.deepEqual([done.subtitlesFile, done.subtitleTrack, done.burnCaptions], [join(root, "out", "Subs.vtt"), "pol", false]);
  assert.equal(readFileSync(join(root, "out", "Subs.vtt"), "utf8"), writeVtt(cues, 30));
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", output], { encoding: "utf8" })) as { streams: Array<{ codec_type: string; codec_name: string; tags?: { language?: string } }> };
  const sub = probe.streams.find((s) => s.codec_type === "subtitle");
  console.log(`  streams: ${probe.streams.map((s) => `${s.codec_type}/${s.codec_name}${s.tags?.language ? `/${s.tags.language}` : ""}`).join(", ")}`);
  assert.ok(sub, "a subtitle stream");
  assert.deepEqual([sub!.codec_name, sub!.tags?.language], ["mov_text", "pol"]);
  assert.equal((sub as { disposition?: { default?: number } }).disposition?.default, 1, "burn-in off: the track shows by default");
  // The track read back is the cues (to the millisecond).
  const back = execFileSync("ffmpeg", ["-v", "error", "-i", output, "-map", "0:s:0", "-f", "srt", "-"], { encoding: "utf8" });
  const parsed = parseSubtitles(back, "back.srt");
  assert.ok(!("problem" in parsed), back);
  // An mp4 track shows one cue at a time: where a card and a cue overlap, both texts stacked.
  assert.deepEqual(parsed.cues.map((c) => [Math.round(c.start * 30), Math.round(c.end * 30), c.text]), flattenCues(cues).map((c) => [c.from, c.to, c.text]));
  assert.equal(flattenCues(cues)[1]!.text, "Alpha Bravo Charlie.\nFirst cue");
  const bareFrames = rgbFrames(output);
  assert.equal(bareFrames.length, W * H * 3 * 120);
  const lit = Array.from({ length: 120 }, (_, f) => white(bareFrames, f)).filter((n) => n > 50).length;
  assert.equal(lit, 0, "burn-in off: no caption pixels on any frame");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", output, "-vf", "select=eq(n\\,40)", "-frames:v", "1", "-update", "1", resolve("test-output/subtitles-export-bare.png")]);

  // Burned in (the default): caption text exactly where a card or a cue shows.
  const burned = join(root, "out", "Burned.mp4");
  const second = await client.ok("export.start", { output: burned, quality: "standard", loudness: "off" });
  const done2 = await finished(second.jobId);
  assert.equal(done2.phase, "done", done2.error);
  assert.equal(done2.subtitlesFile, undefined);
  const frames = rgbFrames(burned);
  const shown = Array.from({ length: 120 }, (_, f) => white(frames, f) > 200);
  const expected = Array.from({ length: 120 }, (_, f) => cues.some((c) => c.from <= f && f < c.to));
  assert.deepEqual(shown.flatMap((s, f) => (s !== expected[f] ? [f] : [])), [], "text on exactly the cue frames");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", burned, "-vf", "select=eq(n\\,90)", "-frames:v", "1", "-update", "1", resolve("test-output/subtitles-export-burned.png")]);

  // Just the file; refusals.
  const srtPath = join(root, "out", "Only.srt");
  const saved = await client.ok("export.subtitles", { output: srtPath });
  assert.deepEqual(saved, { path: srtPath, format: "srt", cues: 5 });
  assert.equal(readFileSync(srtPath, "utf8"), writeSrt(cues, 30));
  const again = await client.fail("export.subtitles", { output: srtPath });
  assert.deepEqual([again.reason, again.message], ["exists", "Only.srt already exists in that folder."]);
  assert.equal((await client.ok("export.subtitles", { output: srtPath, overwrite: true })).cues, 5);
  assert.match((await client.fail("export.subtitles", { output: join(root, "out", "x.txt") })).message, /a \.srt or \.vtt file/);
  // A sidecar that already exists is refused before the export starts.
  const clash = await client.fail("export.start", { output: join(root, "out", "Only.mp4"), quality: "draft", loudness: "off", subtitles: { file: "srt" } });
  assert.deepEqual([clash.reason, clash.message], ["exists", "Only.srt already exists in that folder."]);

  // The imported .srt is never written over: not as a file next to a video, not as subtitles only.
  const own = await client.fail("export.start", { output: join(root, "talk.mp4"), quality: "draft", loudness: "off", subtitles: { file: "srt" }, overwrite: true });
  assert.deepEqual([own.reason, own.message], ["source-media", "talk.srt is a subtitles file this project imported, and Uncut never writes over it. Choose another name."]);
  assert.match((await client.fail("export.subtitles", { output: join(root, "talk.srt"), overwrite: true })).message, /talk\.srt is a subtitles file this project imported/);
  assert.equal(readFileSync(join(root, "talk.srt"), "utf8"), SRT);

  // Nothing to export: refused with a sentence.
  const empty = writeProject(root, "Empty", base(join(root, "Footage.mp4")));
  await client.ok("project.open", { dir: empty });
  assert.match((await client.fail("export.subtitles", { output: join(root, "out", "Empty.srt") })).message, /no captions or subtitles to export/);
  assert.match((await client.fail("export.start", { output: join(root, "out", "Empty.mp4"), quality: "draft", loudness: "off", subtitles: { track: true } })).message, /no captions or subtitles/);
});
