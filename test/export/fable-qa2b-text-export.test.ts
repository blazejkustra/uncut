// Fable QA round 2, the Text chunk (F21, F24; D163, D164, D166) through the export:
// - the plan: every new move and a loop are one PNG per distinct look, each core textHtml at that
//   frame; the alpha ramps are exactly the moves core moveFades says fade (bounce, blur), the rest
//   (typewriter, scale, pop, loops) are in the looks; a loop's looks repeat (≤ its period);
//   karaoke captions are core captionAt's text per frame.
// - on the bundled server: a blur-in mid frame, a typewriter mid frame and a karaoke caption frame
//   of the exported file match Chromium's PNG of what core says the preview draws (SSIM ≥ 0.98),
//   and the karaoke fill grows word by word in the exported frames.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { animationAt, applyEdit, captionAt, createSession, layout, moveFades, planMakeCaptions, RENDER_CSS, textHtml, visualsAt, type CutTranscript, type Item, type Project } from "../../packages/core/src/index.ts";
import { planCaptionStyle } from "../../packages/core/src/text/captions.ts";
import { planExport } from "../../apps/server/src/export/exportPlan.ts";
import { rasterizerCommand, startRasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { writeProject } from "../helpers/export-fixture.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skipServer = !existsSync(BUNDLE) || !existsSync(MEDIA) || !existsSync(DESKTOP) ? "server, desktop or media core not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";

const W = 1280;
const H = 720;
const BG = "#203040";
const WORDS = [
  { text: "Alpha", start: 0.2, end: 0.6 }, // 6–18
  { text: "Bravo", start: 0.7, end: 1.1 }, // 21–33
  { text: "Charlie.", start: 1.2, end: 1.6 }, // 36–48
];
const T: CutTranscript = { words: WORDS, language: "en", seconds: 4 };
const MOVES = ["move.typewriter", "move.bounce", "move.blur", "move.scale", "move.pop"] as const;

/** Text with each new move (in and out), a looping one, and karaoke captions over a 120-frame clip. */
function textProject(path: string): Project {
  const texts: Array<Item> = [
    { id: "blur", type: "text", start: 0, duration: 40, text: "Blur in", transform: { x: 100, y: 80 }, style: { font: "DM Sans", size: 90, weight: 700, color: "#FFFFFF" }, animation: { in: { module: "move.blur", duration: 20 } } },
    { id: "type", type: "text", start: 40, duration: 40, text: "Typewriter", transform: { x: 100, y: 80 }, style: { font: "DM Mono", size: 90, weight: 500, color: "#FFFFFF", tracking: 0 }, animation: { in: { module: "move.typewriter", duration: 30 } } },
    { id: "pulse", type: "text", start: 80, duration: 40, text: "Pulse", transform: { x: 100, y: 80 }, style: { font: "DM Sans", size: 90, weight: 700, color: "#FFFFFF" }, animation: { loop: { module: "move.pulse", duration: 10 } } },
  ];
  const moves: Array<Item> = MOVES.map((module, i) => ({ id: `m${i}`, type: "text", start: i * 20, duration: 20, text: "Moves", transform: { x: 700, y: 300 }, style: { font: "DM Sans", size: 60, weight: 700, color: "#FFFFFF" }, animation: { in: { module, duration: 8 }, out: { module, duration: 8 } } }));
  const base: Project = {
    format: "uncut/0",
    name: "Text moves",
    canvas: { width: W, height: H, fps: 30 },
    textLooks: 1,
    media: [{ id: "m-talk", kind: "video", name: "Talk.mp4", path, probe: { frames: 120, fps: 30, width: 640, height: 360, hasAudio: true } }],
    tracks: [
      { id: "text", kind: "text", name: "Text", items: texts },
      { id: "text-2", kind: "text", name: "Text 2", items: moves },
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "clip-1", type: "clip", media: "m-talk", in: 0, duration: 120 }] },
    ],
  };
  const made = planMakeCaptions(base, { media: "m-talk", transcript: T, captionStyle: "karaoke" });
  assert.ok(!("problem" in made), "problem" in made ? made.problem : "");
  return applyEdit(createSession(base), { actor: "user", ops: made.ops }).project;
}
const itemOf = (p: Project, id: string) => p.tracks.flatMap((t) => t.items).find((i) => i.id === id)!;
const capOf = (p: Project) => p.tracks.flatMap((t) => t.items).find((i) => i.type === "captions")!;

test("plan: the new moves and a loop are core textHtml per frame; ramps only where moveFades; karaoke captions per frame", () => {
  const project = textProject("/tmp/none.mp4");
  const plan = planExport(project, { mediaPath: () => "/tmp/none.mp4", width: W, height: H });
  assert.ok(!("problem" in plan), "problem" in plan ? plan.problem : "");
  if ("problem" in plan) return;
  const visuals = plan.visuals;
  for (const id of ["blur", "type", "pulse", "m0", "m1", "m2", "m3", "m4"]) {
    const item = itemOf(project, id);
    const own = visuals.filter((l) => l.item.id === id);
    assert.ok(own.length, id);
    for (const layer of own) {
      assert.equal(layer.kind, "raster");
      if (layer.kind !== "raster") return;
      const start = item.start ?? 0;
      for (let f = layer.f0; f < layer.f1; f++) assert.equal(layer.states[layer.frames[f - layer.f0]!], textHtml(item, project, { motion: animationAt(item, f - start, project.canvas).motion }), `${id} frame ${f}`);
      const fades = [item.animation?.in, item.animation?.out].filter((m) => m && moveFades(item, m)).length;
      assert.equal(layer.ramps.length, fades, `${id}: ${fades} ramps`);
    }
  }
  // Typewriter: one look per character count (0…10) then the plain text: 11 looks.
  const type = plan.visuals.find((l) => l.item.id === "type")!;
  assert.ok(type.kind === "raster" && type.states.length === 11, `typewriter looks ${type.kind === "raster" ? type.states.length : 0}`);
  // A 10-frame loop repeats: at most 10 distinct looks over its 40 frames.
  const pulse = plan.visuals.find((l) => l.item.id === "pulse")!;
  assert.ok(pulse.kind === "raster" && pulse.states.length <= 10 && pulse.states.length > 2, `pulse looks ${pulse.kind === "raster" ? pulse.states.length : 0}`);
  // Karaoke captions: each frame core captionAt (the fill over the words said so far).
  const cap = capOf(project);
  assert.equal(cap.style?.captionStyle, "karaoke");
  const layers = plan.visuals.filter((l) => l.item.type === "captions");
  assert.ok(layers.length);
  for (const layer of layers) {
    if (layer.kind !== "raster") continue;
    for (let f = layer.f0; f < layer.f1; f++) {
      const text = captionAt(project, cap, f);
      if (text) assert.equal(layer.states[layer.frames[f - layer.f0]!], textHtml(text, project), `captions frame ${f}`);
    }
  }
  assert.equal(captionAt(project, cap, 25)!.text, "[[Alpha Bravo]] Charlie.");
  assert.deepEqual(plan.warnings, []);
});

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let server: Server;
let client: Client;
let jobs: ReturnType<Client["subscribe"]>;
const job = (id: string) => jobs.values.at(-1)?.find((j: { id: string }) => j.id === id);
const finished = (id: string, timeout = 180000) => jobs.until((list) => list.some((j: any) => j.id === id && ["done", "failed", "cancelled"].includes(j.phase)), timeout).then(() => job(id));
const frameOf = (file: string, n: number, out: string) => (execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-update", "1", out]), out);
const rgbFrames = (file: string) => execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1024 * 1024 * 1024 });
/** SSIM of two frames, over a crop (w:h:x:y) holding the text so the plain background doesn't dominate. */
const ssim = (a: string, b: string, crop = `${W}:${H}:0:0`) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", `[0]format=gray,crop=${crop}[a];[1]format=gray,crop=${crop}[b];[a][b]ssim`, "-f", "null", "-"], { encoding: "utf8" });
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
};
/** Karaoke-yellow pixels (#FFD23F) in the lower band of frame f. */
function yellow(all: Buffer, f: number) {
  const size = W * H * 3;
  const px = all.subarray(f * size, (f + 1) * size);
  let n = 0;
  for (let y = Math.round(H * 0.7); y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (px[i]! > 220 && px[i + 1]! > 170 && px[i + 1]! < 235 && px[i + 2]! < 120) n++;
    }
  }
  return n;
}

before(async () => {
  if (skipServer) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-fable2-text-export-")));
  mkdirSync(join(root, "out"));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${BG.replace("#", "0x")}:size=640x360:rate=30`, "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(root, "Talk.mp4")]);
  server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data") } });
  client = await connect(server.ready.port, server.ready.token);
  jobs = client.subscribe("export.jobs");
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("export: blur in, typewriter and karaoke captions are what core says the preview draws", { skip: skipServer, timeout: 300000 }, async () => {
  mkdirSync("test-output", { recursive: true });
  const project = textProject(join(root, "Talk.mp4"));
  const dir = writeProject(root, "Moves", project);
  await client.ok("project.open", { dir });
  const output = join(root, "out", "Moves.mp4");
  const { jobId } = await client.ok("export.start", { output, quality: "standard", loudness: "off" });
  const done = await finished(jobId);
  assert.equal(done.phase, "done", done.error);
  const r = rasterizerCommand();
  assert.ok(!("problem" in r));
  const raster = await startRasterizer(r);
  try {
    // The preview's drawing at a frame: every text visual through textHtml with its opacity and motion.
    // Crops around the text: the top-left titles, the caption band.
    const top = "700:180:60:60";
    const band = `${W}:200:0:${H - 200}`;
    for (const [f, name, crop] of [[10, "blur", top], [55, "typewriter", top], [25, "karaoke", band]] as const) {
      const html = visualsAt(project, layout(project).starts, f)
        .filter((v) => v.item.type === "text" && typeof v.item.text === "string")
        .map(({ item, opacity, motion }) => textHtml(item, project, { opacity, motion }))
        .join("");
      const ref = join(root, `${name}-ref.png`);
      await raster.render({ width: W, height: H, css: RENDER_CSS, html: `<div style="position:absolute;inset:0;background:${BG}"></div>${html}`, out: ref });
      const exported = frameOf(output, f, resolve(`test-output/fable2-text-export-${name}.png`));
      const score = ssim(ref, exported, crop);
      console.log(`  ${name} frame ${f} vs Chromium PNG of core's HTML: SSIM ${score.toFixed(4)}`);
      assert.ok(score >= 0.98, `${name}: SSIM ${score}`);
    }
    // A control: the blur frame against the same text drawn without its blur scores lower.
    const sharp = visualsAt(project, layout(project).starts, 10)
      .filter((v) => v.item.id === "blur")
      .map(({ item, opacity }) => textHtml(item, project, { opacity }))
      .join("");
    const plain = join(root, "blur-plain.png");
    await raster.render({ width: W, height: H, css: RENDER_CSS, html: `<div style="position:absolute;inset:0;background:${BG}"></div>${sharp}`, out: plain });
    const control = ssim(plain, resolve("test-output/fable2-text-export-blur.png"), top);
    console.log(`  blur frame vs the text unblurred: SSIM ${control.toFixed(4)}`);
    assert.ok(control < ssim(join(root, "blur-ref.png"), resolve("test-output/fable2-text-export-blur.png"), top) - 0.01, "the export is blurred");
  } finally {
    await raster.close();
  }
  // The karaoke fill grows: more yellow once Bravo is said than while only Alpha is.
  const frames = rgbFrames(output);
  const one = yellow(frames, 12);
  const two = yellow(frames, 25);
  const three = yellow(frames, 40);
  console.log(`  karaoke yellow px: ${one}, ${two}, ${three}`);
  assert.ok(one > 50 && two > one * 1.4 && three > two * 1.2, `${one} < ${two} < ${three}`);
});
