// D291 through the real rasteriser (apps/desktop render.ts) and ffmpeg:
// - a graphic past 360 frames is streamed (raw BGRA into a FIFO, ffmpeg makes its lossless video):
//   every frame drawn and drawn at its own t (the frame number is the picture's colour), nothing
//   held, and the same pixels when exported twice;
// - straight alpha: a half-transparent streamed frame matches the PNG path's frame;
// - motion blur: a frame is the mean of its sub-frames' pictures (drawn one by one with the PNG
//   path) on premultiplied colour, so a white square's trail is white at half opacity, not grey;
//   blur on differs from blur off;
// - end to end (runJob, 1080×1350 at 60 fps, H.264 High with sound): a long blurred graphic over
//   a 60 fps clip with a flash and a beep at the same moment, and a rising text: every frame there,
//   60/1, the sound as long as the picture, the flash and the beep within a frame of each other,
//   and no two consecutive frames of the graphic the same.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { graphicDocument, graphicInfo, MOTION_BLUR_DEFAULTS, subFrameTimes, type Project } from "../../packages/core/src/index.ts";
import { planExport, type ExportPlan, type VisualLayer } from "../../apps/server/src/export/exportPlan.ts";
import { rasterise } from "../../apps/server/src/export/exporter/rasterise.ts";
import { makeRunJob } from "../../apps/server/src/export/exporter/runJob.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { rgbaOf } from "../helpers/image-compare.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";
const FFMPEG = hasFfmpeg ? execFileSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim() : "ffmpeg";

const W = 160;
const H = 200;
const FPS = 60;
const FRAMES = 400;

/** The frame number as the picture's colour (opaque): R = n mod 256, G = 60 × floor(n / 256), B = 77. */
const COUNTER = `<canvas id="c" width="${W}" height="${H}"></canvas><script>
const ctx = document.getElementById("c").getContext("2d");
window.render = (t, info) => { const n = Math.round(t * info.fps); ctx.fillStyle = "rgb(" + (n % 256) + "," + (60 * Math.floor(n / 256)) + ",77)"; ctx.fillRect(0, 0, ${W}, ${H}); };
</script>`;
/** A white 40 px square moving 64 px a frame on transparency; with a half-transparent red bar. */
const MOVER = `<canvas id="c" width="${W}" height="${H}"></canvas><script>
const ctx = document.getElementById("c").getContext("2d");
window.render = (t, info) => {
  ctx.clearRect(0, 0, ${W}, ${H});
  ctx.fillStyle = "#ffffff"; ctx.fillRect(Math.round(64 * t * info.fps) % 120, 20, 40, 40);
  ctx.fillStyle = "rgba(255, 0, 0, 0.5)"; ctx.fillRect(0, 120, ${W}, 30);
};
</script>`;

const graphicProject = (src: string, extra: Partial<Project> = {}, duration = FRAMES): Project =>
  ({
    format: "uncut/0",
    name: "Blur",
    canvas: { width: W, height: H, fps: FPS },
    media: [],
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "g", type: "graphic", src, duration }] }],
    ...extra,
  }) as Project;

let root: string;
let raster: Rasterizer;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-motion-blur-")));
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  raster = await startRasterizer(command);
});

after(async () => {
  if (skip) return;
  await raster?.close();
  if (process.env.UNCUT_KEEP_OUTPUT) console.log(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
});

/** The graphic layer of a plan streamed by the export's rasterise, as raw RGBA frames. */
async function streamed(html: string, name: string, motionBlur = false, duration = FRAMES): Promise<{ plan: ExportPlan; layer: VisualLayer; frames: Buffer }> {
  const project = graphicProject(`graphics/${name}.html`, {}, duration);
  const plan = planExport(project, { mediaPath: () => "", width: W, height: H, graphic: () => html, motionBlur });
  if ("problem" in plan) throw new Error(plan.problem);
  const dir = join(root, `${name}-${motionBlur ? "blur" : "sharp"}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir);
  const { rasters } = await rasterise(raster, plan, project, () => "", dir, new AbortController().signal, undefined, { bin: FFMPEG });
  const layer = plan.visuals.find((l) => l.kind === "graphic")!;
  const out = rasters.get(layer);
  assert.ok(out?.kind === "video", "streamed into one video");
  return { plan, layer, frames: rgbaOf(out.file) };
}

const frameOf = (frames: Buffer, i: number) => frames.subarray(i * W * H * 4, (i + 1) * W * H * 4);
const px = (frame: Buffer, x: number, y: number) => [...frame.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];

/** A frame drawn the PNG way (one "graphic" request), as RGBA. */
async function pngFrame(html: string, t: number, local: number, name: string): Promise<Buffer> {
  const out = join(root, `${name}.png`);
  await raster.render({ kind: "graphic", width: W, height: H, doc: graphicDocument(html, { width: W, height: H }), t, info: graphicInfo({ duration: FRAMES, props: {} }, { width: W, height: H, fps: FPS }, local), out });
  return rgbaOf(out);
}

test("a graphic past 360 frames: every frame streamed at its own t, none held, the same pixels twice", { skip, timeout: 180000 }, async () => {
  const a = await streamed(COUNTER, "counter");
  assert.equal(a.frames.length, FRAMES * W * H * 4, "every frame there");
  for (let i = 0; i < FRAMES; i++) {
    const [r, g, b, alpha] = px(frameOf(a.frames, i), W / 2, H / 2);
    assert.deepEqual([r, g, b, alpha], [i % 256, 60 * Math.floor(i / 256), 77, 255], `frame ${i} shows frame ${i}`);
  }
  const b = await streamed(COUNTER, "counter");
  assert.ok(a.frames.equals(b.frames), "deterministic: the same pixels when exported again");
});

test("straight alpha: a streamed half-transparent frame is the PNG path's frame", { skip, timeout: 180000 }, async () => {
  const s = await streamed(MOVER, "mover");
  for (const i of [3, 77]) {
    const png = await pngFrame(MOVER, i / FPS, i, `mover-png-${i}`);
    const frame = frameOf(s.frames, i);
    let worst = 0;
    for (let k = 0; k < png.length; k++) worst = Math.max(worst, Math.abs(png[k]! - frame[k]!));
    assert.ok(worst <= 1, `frame ${i}: within 1 of the PNG path (worst ${worst})`);
    const [r, g, b, alpha] = px(frame, 80, 135);
    assert.ok(r! >= 254 && g! <= 1 && b! <= 1 && Math.abs(alpha! - 128) <= 1, `the half-transparent bar is red at half opacity: ${[r, g, b, alpha]}`);
  }
});

test("motion blur: each frame the mean of its sub-frames on premultiplied colour; differs from no blur", { skip, timeout: 240000 }, async () => {
  const sharp = await streamed(MOVER, "mover");
  const blurred = await streamed(MOVER, "mover", true);
  assert.equal(blurred.frames.length, FRAMES * W * H * 4, "one frame per frame, not per sub-frame");
  assert.ok(!sharp.frames.equals(blurred.frames), "blur changes the picture");
  // Held frames (a crossfade shows the graphic before its start) are one frame each, sharp.
  const faded = { ...graphicProject("graphics/mover.html"), tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: 30, props: { color: "#000000" } }, { id: "g", type: "graphic", src: "graphics/mover.html", duration: 40, transitionIn: { module: "transition.crossfade", duration: 20 } }] }] } as unknown as Project;
  const fp = planExport(faded, { mediaPath: () => "", width: W, height: H, graphic: () => MOVER, motionBlur: true });
  assert.ok(!("problem" in fp));
  const fdir = join(root, "faded");
  mkdirSync(fdir);
  const { rasters } = await rasterise(raster, fp, faded, () => "", fdir, new AbortController().signal, undefined, { bin: FFMPEG });
  const fl = fp.visuals.filter((l) => l.kind === "graphic");
  assert.ok(fl.some((l) => l.kind === "graphic" && l.frames[0] === l.frames[1]), "it holds frames before its start");
  for (const l of fl) {
    const o = rasters.get(l)!;
    const n = o.kind === "video" ? rgbaOf(o.file).length / (W * H * 4) : o.kind === "sequence" ? rgbaOf(o.pattern).length / (W * H * 4) : 1;
    assert.equal(n, l.f1 - l.f0, "one frame per frame, held ones too");
  }
  for (const i of [1, 10, 101]) {
    const ts = subFrameTimes(i, FPS, MOTION_BLUR_DEFAULTS);
    const subs = await Promise.all(ts.map((t, j) => pngFrame(MOVER, t, i, `sub-${i}-${j}`)));
    const frame = frameOf(blurred.frames, i);
    let worst = 0;
    for (let p = 0; p < W * H; p++) {
      // The premultiplied mean, made straight again.
      const a = subs.reduce((s, b) => s + b[p * 4 + 3]!, 0) / subs.length;
      const alpha = Math.round(a);
      if (Math.abs(frame[p * 4 + 3]! - alpha) > worst) worst = Math.abs(frame[p * 4 + 3]! - alpha);
      if (alpha < 8) continue;
      for (let c = 0; c < 3; c++) {
        const premul = subs.reduce((s, b) => s + (b[p * 4 + c]! * b[p * 4 + 3]!) / 255, 0) / subs.length;
        const straight = (premul * 255) / a;
        worst = Math.max(worst, Math.abs(frame[p * 4 + c]! - straight));
      }
    }
    assert.ok(worst <= 3, `frame ${i}: the mean of its ${ts.length} sub-frames (worst ${worst.toFixed(1)})`);
    // The square moves 64 px a frame: its 4 sub-frames sit `step` px apart (8 at 180°, 4 at 90°), so
    // x0 + 40 + 1.5 steps is covered by the last two: white at half opacity (premultiplied mean), not grey.
    if (i === 101) continue; // wraps round the canvas
    const x0 = (64 * i) % 120;
    const step = (64 * MOTION_BLUR_DEFAULTS.shutter) / 360 / MOTION_BLUR_DEFAULTS.samples;
    const [r, g, b, alpha] = px(frame, Math.round(x0 + 40 + 1.5 * step), 40);
    assert.ok(Math.abs(alpha! - 128) <= 2 && r! >= 250 && g! >= 250 && b! >= 250, `the trail at 2 of 4 sub-frames: white at half opacity, ${[r, g, b, alpha]}`);
  }
});

test("a graphic request with ts (the critic's blurred frames) is the export's blurred frame", { skip, timeout: 240000 }, async () => {
  const blurred = await streamed(MOVER, "mover", true);
  for (const i of [1, 10, 45]) {
    const out = join(root, `mover-ts-${i}.png`);
    await raster.render({ kind: "graphic", width: W, height: H, doc: graphicDocument(MOVER, { width: W, height: H }), t: i / FPS, ts: subFrameTimes(i, FPS, MOTION_BLUR_DEFAULTS), info: graphicInfo({ duration: FRAMES, props: {} }, { width: W, height: H, fps: FPS }, i), out });
    const png = rgbaOf(out);
    const frame = frameOf(blurred.frames, i);
    let worst = 0;
    for (let p = 0; p < W * H; p++) {
      const a = frame[p * 4 + 3]!;
      worst = Math.max(worst, Math.abs(png[p * 4 + 3]! - a));
      if (a < 8) continue;
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(png[p * 4 + c]! - frame[p * 4 + c]!));
    }
    assert.ok(worst <= 3, `frame ${i}: within 3 of the export's blurred frame (worst ${worst})`);
  }
});

/** A 4 px white bar on black (opaque) sweeping 400 px a frame: 100 px over the 90° shutter, 25 px between 4 sub-frames. */
const STREAK = `<canvas id="c" width="${W}" height="${H}"></canvas><script>
const ctx = document.getElementById("c").getContext("2d");
window.render = (t, info) => {
  const f = t * info.fps - Math.floor(t * info.fps + 1e-9);
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, ${W}, ${H});
  ctx.fillStyle = "#fff"; ctx.fillRect(20 + 400 * f, 0, 4, ${H});
};
</script>`;
/** A still picture: a white square and a line of text on black. */
const STILL = `<canvas id="c" width="${W}" height="${H}"></canvas><script>
const ctx = document.getElementById("c").getContext("2d");
window.render = () => { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, ${W}, ${H}); ctx.fillStyle = "#fff"; ctx.fillRect(30, 30, 50, 50); ctx.font = "20px sans-serif"; ctx.fillText("Still", 30, 140); };
</script>`;

test("D309: a fast sharp bar blurs into one smooth smear (more sub-frames), a still frame keeps the base 4", { skip, timeout: 240000 }, async () => {
  const draw = async (html: string, i: number, name: string) => {
    const out = join(root, `${name}-${i}.png`);
    const reply = await raster.render({ kind: "graphic", width: W, height: H, doc: graphicDocument(html, { width: W, height: H }), t: i / FPS, ts: subFrameTimes(i, FPS, MOTION_BLUR_DEFAULTS), info: graphicInfo({ duration: FRAMES, props: {} }, { width: W, height: H, fps: FPS }, i), out });
    return { samples: reply?.samples, png: rgbaOf(out) };
  };
  const still = await draw(STILL, 5, "still");
  assert.equal(still.samples, MOTION_BLUR_DEFAULTS.samples, "a still frame: the project's sub-frames, none added");
  const streak = await draw(STREAK, 5, "streak");
  assert.ok((streak.samples ?? 0) >= 16, `the fast bar: sub-frames added (${streak.samples})`);
  // Its row: the smear from x 20 to 120 (the bar's left edge over the shutter, plus its 4 px), with
  // 4 sub-frames 4 lit bars 25 px apart and black between; now no gap: every column inside is lit.
  const row = Array.from({ length: W }, (_, x) => streak.png[(100 * W + x) * 4]!);
  const inside = row.slice(24, 116);
  const peak = Math.max(...inside);
  assert.ok(Math.min(...inside) >= peak * 0.5, `one smooth smear, no stepped copies: ${inside.join(",")}`);
  assert.ok(row[10]! < 8 && row[150]! < 8, "dark outside the smear");
  // The streamed export draws the same frame.
  const blurred = await streamed(STREAK, "streak", true, 10);
  const frame = frameOf(blurred.frames, 5);
  let worst = 0;
  for (let p = 0; p < W * H * 4; p++) if (p % 4 !== 3) worst = Math.max(worst, Math.abs(frame[p]! - streak.png[p]!));
  assert.ok(worst <= 3, `the export's frame is the critic's (worst ${worst})`);
});

test("end to end: 1080×1350 at 60 fps, H.264 High with sound: every frame, 60/1, A/V in sync, the graphic never held", { skip, timeout: 600000 }, async () => {
  const BW = 1080;
  const BH = 1350;
  const dir = join(root, "Film.uncut");
  mkdirSync(join(dir, "graphics"), { recursive: true });
  // A 60 fps clip: black with a white flash at 2.0 s (frames 120–125), silent with a 1 kHz beep at 2.0–2.1 s.
  const clip = join(root, "Flash.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=black:s=540x676:r=60:d=6,drawbox=x=0:y=0:w=540:h=676:color=white:t=fill:enable='between(n,120,125)'", "-f", "lavfi", "-i", "aevalsrc='if(between(t,2,2.1),0.6*sin(2*PI*1000*t),0)':s=48000:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", clip]);
  // The graphic: a bar crossing the top quarter (transparent elsewhere), 8 s.
  writeFileSync(join(dir, "graphics", "bar.html"), `<canvas id="c" width="${BW}" height="${BH}"></canvas><script>
const ctx = document.getElementById("c").getContext("2d");
window.render = (t) => { ctx.clearRect(0, 0, ${BW}, ${BH}); ctx.fillStyle = "#ff3366"; ctx.fillRect((t * 700) % ${BW}, 60, 160, 200); };
</script>`);
  const frames = 480;
  const project = {
    format: "uncut/0",
    name: "Film",
    canvas: { width: BW, height: BH, fps: 60 },
    media: [{ id: "m-flash", kind: "video", name: "Flash.mp4", path: clip, probe: { frames: 360, fps: 60, width: 540, height: 676, hasAudio: true } }],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: [{ id: "title", type: "text", start: 30, duration: 120, text: "Sixty frames", style: { preset: "text.title" }, animation: { in: { module: "move.rise", duration: 20 } } }] },
      { id: "gfx", kind: "video", name: "Graphics", items: [{ id: "bar", type: "graphic", src: "graphics/bar.html", start: 0, duration: frames }] },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "flash", type: "clip", media: "m-flash", in: 0, duration: 360 }, { id: "tail", type: "component", component: "component.solid", duration: 120, props: { color: "#202020" } }] },
    ],
  } as unknown as Project;
  const { readGraphics } = await import("../../apps/server/src/export/exporter.ts");
  const graphics = await readGraphics(dir, project);
  const plan = planExport(project, { mediaPath: (m) => m.path, width: BW, height: BH, graphic: (s) => graphics.get(s), motionBlur: true });
  assert.ok(!("problem" in plan));
  assert.equal(plan.frames, frames);
  assert.deepEqual(plan.warnings, []);
  const output = join(root, "film.mp4");
  let last: Record<string, unknown> = {};
  const previous = process.env.UNCUT_RENDER_ENTRY;
  process.env.UNCUT_RENDER_ENTRY = DESKTOP;
  const runJob = makeRunJob({ patch: (_id, change) => void (last = { ...last, ...change }), ffmpegBin: async () => FFMPEG, missingMedia: async () => undefined, duckEnvelopes: async () => new Map() });
  const started = Date.now();
  try {
    await runJob({ id: "j", projectDir: dir, name: "Film", output, quality: "high", loudness: "off", phase: "queued", progress: 0, width: BW, height: BH, fps: 60, seconds: frames / 60, startedAt: new Date().toISOString() }, plan, project, (m) => m.path, true, new AbortController().signal, () => plan, new Map());
  } finally {
    if (previous === undefined) delete process.env.UNCUT_RENDER_ENTRY;
    else process.env.UNCUT_RENDER_ENTRY = previous;
  }
  console.log(`  8 s at 1080×1350, 60 fps, blurred graphic: exported in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  assert.equal(last.phase, "done", String(last.error));
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames,duration", "-of", "json", output], { encoding: "utf8" })) as { streams: Array<Record<string, string>> };
  const video = probe.streams.find((s) => s.codec_type === "video")!;
  const audio = probe.streams.find((s) => s.codec_type === "audio");
  assert.equal(video.codec_name, "h264");
  assert.equal(Number(video.width), BW);
  assert.equal(Number(video.height), BH);
  assert.equal(video.r_frame_rate, "60/1");
  assert.equal(Number(video.nb_read_frames), frames, "every frame there");
  assert.ok(audio, "a sound track");
  assert.ok(Math.abs(Number(audio.duration) - Number(video.duration)) <= 1 / 30, `sound ${audio.duration} s, picture ${video.duration} s`);
  // The flash: the first frame whose middle (under the text and the bar) is bright.
  const luma = execFileSync("ffmpeg", ["-v", "error", "-i", output, "-vf", "crop=200:200:440:900,scale=1:1:flags=area,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 64 * 1024 * 1024 });
  const flashFrame = [...luma].findIndex((v) => v > 128);
  assert.ok(flashFrame >= 119 && flashFrame <= 121, `the flash at frame ${flashFrame} (120)`);
  // The beep: the first 48 kHz sample that's loud.
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", output, "-ac", "1", "-ar", "48000", "-f", "s16le", "-"], { maxBuffer: 64 * 1024 * 1024 });
  let beep = -1;
  for (let i = 0; i < pcm.length / 2; i++)
    if (Math.abs(pcm.readInt16LE(i * 2)) > 3000) {
      beep = i / 48000;
      break;
    }
  assert.ok(Math.abs(beep - flashFrame / 60) <= 1 / 60 + 0.005, `the beep at ${beep.toFixed(3)} s, the flash at ${(flashFrame / 60).toFixed(3)} s`);
  // The graphic's band: no two consecutive frames alike (nothing held), over a stretch past 360 frames.
  const band = execFileSync("ffmpeg", ["-v", "error", "-i", output, "-vf", `crop=${BW}:200:0:60,scale=270:50,format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 256 * 1024 * 1024 });
  const size = 270 * 50;
  let same = 0;
  for (let f = 1; f < frames; f++) if (band.subarray((f - 1) * size, f * size).equals(band.subarray(f * size, (f + 1) * size))) same++;
  assert.equal(same, 0, `${same} frames repeat the one before`);
});
