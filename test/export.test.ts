// Phase 4 chunk 6 (D34, D39, D54, D55): export as a server job.
// - The plan's maths against core: every layer's frames, opacity, source time and text motion are
//   visualsAt's; every sound's gain is audibleAt's; the gain expression ffmpeg evaluates matches.
// - On the bundled server with ffmpeg-made media: an export probes right (size, fps, length, an
//   audio stream), shows the source frame it should, and its sound has the levels core expects;
//   loudness normalisation lands on its target; a silent project gets a silent track; an existing
//   file is only replaced when asked; missing media is a clear error; cancelling (while drawing
//   text, or mid-render) leaves no ffmpeg, no rasteriser, no temp files and no partial output.
// - The agent's render_frames returns JPEGs that match the export's frames.
// - The user's DJI clip (when present) exports at 4K and matches the source frame (SSIM).
// SSIM against what the preview draws is in export-app.test.ts (the packaged app).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { audibleAt, layout, textHtml, visualsAt } from "../packages/core/src/index.ts";
import type { Project } from "../packages/core/src/types.ts";
import type { Visual } from "../packages/core/src/timeline.ts";
import { AUDIO_BLOCK, gainAt, gainExpr, graphFileArgs, outputSize, planExport, rampsAt, type GainModel, type VisualLayer } from "../apps/server/src/exportPlan.ts";
import { rasterizerCommand } from "../apps/server/src/rasterizer.ts";
import { sweepStaleTemp } from "../apps/server/src/exporter.ts";
import { demoProject, FOOTAGE, skipDemo } from "./helpers/demo.ts";
import { exportProject, FPS, makeExportFixture, writeProject } from "./helpers/export-fixture.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "./helpers/server.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const MCP = resolve("apps/server/dist/mcp.mjs");
const FAKE = resolve("test/helpers/fake-claude.ts");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skipFfmpeg = hasFfmpeg ? false : "needs ffmpeg";
const skipServer = !existsSync(BUNDLE) || !existsSync(MEDIA) || !existsSync(DESKTOP) || !existsSync(MCP) ? "server, desktop or media core not built (run pnpm build)" : skipFfmpeg;

// ---- the plan against core (no processes) ----

/** The fixture plus the awkward cases: an odd transition (half frames), speed, every move in and out. */
function trickyProject(): Project {
  const p = exportProject("/nowhere");
  const tracks = p.tracks.map((t) => {
    if (t.id === "main")
      return {
        ...t,
        items: [
          { id: "card", type: "component" as const, component: "component.solid", duration: 45, props: { color: "#123" }, animation: { out: { module: "move.fade", duration: 15 } } },
          { id: "a1", type: "clip" as const, media: "m-a", in: 10, duration: 60, speed: 1.5, animation: { in: { module: "move.rise", duration: 9 } } },
          { id: "b", type: "clip" as const, media: "m-b", in: 15, duration: 50, transitionIn: { module: "transition.crossfade", duration: 15 }, animation: { out: { module: "move.slide-left", duration: 11 } } },
          { id: "a2", type: "clip" as const, media: "m-a", in: 120, duration: 40, transitionIn: { module: "transition.crossfade", duration: 9 } },
        ],
      };
    if (t.id === "text")
      return {
        ...t,
        items: [
          { id: "t1", type: "text" as const, start: 3, duration: 40, text: "Rise", animation: { in: { module: "move.rise", duration: 12 }, out: { module: "move.wipe", duration: 10 } } },
          { id: "t2", type: "text" as const, start: 60, duration: 30, text: "Slide", style: { preset: "text.header" }, animation: { in: { module: "move.slide-left", duration: 8 }, out: { module: "move.fade", duration: 30 } } },
          { id: "t3", type: "text" as const, start: 100, duration: 50, text: "Wipe", animation: { in: { module: "move.wipe", duration: 14 }, out: { module: "move.rise", duration: 7 } } },
        ],
      };
    if (t.id === "overlay")
      return {
        ...t,
        items: [
          ...t.items,
          { id: "end-card", type: "component" as const, component: "component.end-card", start: 150, duration: 20 },
          { id: "logo", type: "graphic" as const, src: "logo.svg", start: 175, duration: 10 },
        ],
      };
    if (t.id === "audio")
      return {
        ...t,
        mixer: { gainDb: -3 },
        items: [{ id: "music", type: "audio" as const, media: "m-music", in: 30, start: 5, duration: 200, gainDb: 2, fadeIn: 17, fadeOut: 23, gainKeys: [{ frame: 0, db: -70 }, { frame: 40, db: 0 }, { frame: 40, db: -6 }, { frame: 120, db: 3 }] }],
      };
    return t;
  });
  return { ...p, tracks };
}

/**
 * What the export draws of what visualsAt lists, as the preview draws it: clips of video or image
 * media, backgrounds (component.solid) and text. Deliberately not drawn (in neither): graphics,
 * captions and other components.
 */
const drawn = (project: Project, v: Visual) => {
  const media = v.item.media ? project.media.find((m) => m.id === v.item.media) : undefined;
  return (v.item.type === "clip" && media !== undefined && media.kind !== "audio") || (v.item.type === "component" && v.item.component === "component.solid") || (v.item.type === "text" && typeof v.item.text === "string");
};

for (const [name, project] of [
  ["fixture", exportProject("/nowhere")],
  ["tricky", trickyProject()],
] as const) {
  test(`export plan (${name}): layers, opacity, source time and motion are visualsAt's, in its order`, () => {
    const plan = planExport(project, { mediaPath: (m) => m.path, width: 1920, height: 1080 });
    if ("problem" in plan) throw new Error(plan.problem);
    const { starts, duration } = layout(project);
    assert.equal(plan.frames, duration);
    for (let f = 0; f < duration; f++) {
      const seen: Array<Visual> = visualsAt(project, starts, f).filter((v) => drawn(project, v));
      const layers: Array<VisualLayer> = plan.visuals.filter((l) => f >= l.f0 && f < l.f1);
      assert.deepEqual(
        layers.map((l) => l.item.id),
        seen.map((v) => v.item.id),
        `frame ${f}: drawn layers in order`,
      );
      for (const [i, l] of layers.entries()) {
        const v = seen[i]!;
        assert.ok(Math.abs(rampsAt(l.ramps, f) - v.opacity) < 1e-9, `${l.item.id} at ${f}: opacity ${rampsAt(l.ramps, f)} vs ${v.opacity}`);
        if (l.kind === "video") assert.ok(Math.abs(l.source + ((f - l.f0) * l.speed) / FPS - v.source) < 1e-9, `${l.item.id} at ${f}: source time`);
        if (l.kind === "raster" && l.item.type === "text") assert.equal(l.states[l.frames[f - l.f0]!], textHtml(l.item, project, { motion: v.motion }), `${l.item.id} at ${f}: look`);
      }
    }
  });

  test(`export plan (${name}): every sound's gain is audibleAt's`, () => {
    const plan = planExport(project, { mediaPath: (m) => m.path, width: 1920, height: 1080 });
    if ("problem" in plan) throw new Error(plan.problem);
    const { starts, duration } = layout(project);
    for (let f = 0; f < duration; f += 0.25) {
      const heard = audibleAt(project, starts, f).filter((a) => a.gain > 0);
      for (const a of heard) {
        const layer = plan.audio.find((l) => l.item.id === a.item.id);
        assert.ok(layer, `${a.item.id} sounds at ${f} but isn't in the plan`);
        assert.ok(f >= layer.from && f < layer.to, `${a.item.id} at ${f} is outside its span`);
        const local = f - starts.get(a.item.id)!;
        assert.ok(Math.abs(gainAt(layer.gain, local) - a.gain) < 1e-9, `${a.item.id} at ${f}: gain ${gainAt(layer.gain, local)} vs ${a.gain}`);
        assert.ok(Math.abs(layer.source + ((f - layer.from) * layer.speed) / FPS - a.source) < 1e-6, `${a.item.id} at ${f}: source time`);
      }
    }
  });
}

test("export sizes: Draft 720p, Standard 1080p by the shorter side, never upscaled; High is the canvas", () => {
  assert.deepEqual(outputSize({ width: 3840, height: 2160 }, "draft"), { width: 1280, height: 720 });
  assert.deepEqual(outputSize({ width: 3840, height: 2160 }, "standard"), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize({ width: 3840, height: 2160 }, "high"), { width: 3840, height: 2160 });
  assert.deepEqual(outputSize({ width: 1080, height: 1920 }, "draft"), { width: 720, height: 1280 });
  assert.deepEqual(outputSize({ width: 1280, height: 720 }, "standard"), { width: 1280, height: 720 });
  assert.ok(!("problem" in planExport(exportProject("/x"), { mediaPath: (m) => m.path, width: 2, height: 2 })));
  const empty = { ...exportProject("/x"), tracks: exportProject("/x").tracks.map((t) => ({ ...t, items: [] })) };
  assert.match((planExport(empty, { mediaPath: (m) => m.path, width: 2, height: 2 }) as { problem: string }).problem, /empty/);
});

test("the gain expression ffmpeg evaluates matches the gain, block by block", { skip: skipFfmpeg }, () => {
  const models: Array<GainModel> = [
    { baseDb: -1, keys: [{ frame: 0, db: -70 }, { frame: 30, db: 0 }, { frame: 30, db: -6 }, { frame: 90, db: 4 }], duration: 120, half: 0, nextHalf: 0, fadeIn: 13, fadeOut: 21 },
    { baseDb: -6, keys: [], duration: 60, half: 7.5, nextHalf: 10, fadeIn: 20, fadeOut: 20 },
  ];
  for (const m of models) {
    const seconds = (m.duration + m.half + m.nextHalf) / FPS;
    const raw = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `aevalsrc=1:s=48000:d=${seconds}`, "-af", `aformat=sample_fmts=fltp,asetnsamples=n=${AUDIO_BLOCK}:p=0,volume=eval=frame:volume='${gainExpr(m, FPS)}'`, "-f", "f32le", "-"], { maxBuffer: 1 << 26 });
    const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    let worst = 0;
    for (let b = 0; (b + 1) * AUDIO_BLOCK <= samples.length; b++) {
      const local = (((b + 0.5) * AUDIO_BLOCK) / 48000) * FPS - m.half;
      worst = Math.max(worst, Math.abs(samples[b * AUDIO_BLOCK]! - gainAt(m, local)));
    }
    assert.ok(worst < 1e-4, `worst block differs by ${worst}`);
  }
});

test("the rasteriser starts as the desktop says; without it, the workspace's Electron runs the desktop bundle (dev, tests)", () => {
  // Packaged: the desktop passes its own binary and no entry (it always runs its bundled main).
  assert.deepEqual(rasterizerCommand({ UNCUT_RENDER_BIN: "/Applications/Uncut.app/Contents/MacOS/Uncut", UNCUT_RENDER_ENTRY: "" }), { bin: "/Applications/Uncut.app/Contents/MacOS/Uncut", args: ["--uncut-render"] });
  // pnpm dev: a bare Electron, so the desktop bundle is the entry.
  assert.deepEqual(rasterizerCommand({ UNCUT_RENDER_BIN: "/x/electron", UNCUT_RENDER_ENTRY: "/x/main.cjs" }), { bin: "/x/electron", args: ["/x/main.cjs", "--uncut-render"] });
  if (!existsSync(DESKTOP)) return;
  // The server on Electron-as-Node with nothing passed: never a bare --uncut-render (Electron's welcome app).
  assert.deepEqual(rasterizerCommand({}, { electron: "44.6.0", execPath: "/x/electron" }), { bin: "/x/electron", args: [DESKTOP, "--uncut-render"] });
  const node = rasterizerCommand({}, { electron: undefined, execPath: process.execPath });
  assert.ok("bin" in node && /electron/i.test(node.bin) && node.args[0] === DESKTOP, JSON.stringify(node));
});

test("ffmpeg 6 gets the graph with -filter_complex_script, 7 and later with -/filter_complex", () => {
  assert.deepEqual(graphFileArgs({ major: 6 }, "/g.txt"), ["-filter_complex_script", "/g.txt"]);
  assert.deepEqual(graphFileArgs({ major: 8 }, "/g.txt"), ["-/filter_complex", "/g.txt"]);
  assert.deepEqual(graphFileArgs({ major: undefined }, "/g.txt"), ["-/filter_complex", "/g.txt"]);
});

test("stale export and rasteriser temp folders are swept: dead owners, or an hour old without one", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "uncut-sweep-")));
  try {
    const make = (name: string, ageMs = 0) => {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "f.png"), "x");
      const t = (Date.now() - ageMs) / 1000;
      utimesSync(join(dir, name), t, t);
    };
    make("uncut-export-999999-dead01"); // owner gone
    make("uncut-render-profile-999999-dead02");
    make(`uncut-export-${process.pid}-mine01`); // ours (the server itself)
    make(`uncut-render-profile-${process.ppid}-live01`, 5 * 3600_000); // an owner that's alive, however old
    make("uncut-export-old001", 2 * 3600_000); // no owner, two hours old
    make("uncut-export-new001"); // no owner, fresh
    make("uncut-export-test-abcdef", 5 * 3600_000); // not ours
    await sweepStaleTemp(dir);
    assert.deepEqual(readdirSync(dir).sort(), [`uncut-export-${process.pid}-mine01`, "uncut-export-new001", "uncut-export-test-abcdef", `uncut-render-profile-${process.ppid}-live01`].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- on the server ----

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let temp = "";
let server: Server;
let client: Client;
let jobs: ReturnType<Client["subscribe"]>;
const job = (id: string) => jobs.values.at(-1)?.find((j: { id: string }) => j.id === id);
const finished = (id: string, timeout = 120000) => jobs.until((list) => list.some((j: any) => j.id === id && ["done", "failed", "cancelled"].includes(j.phase)), timeout).then(() => job(id));
const children = () => (spawnSync("pgrep", ["-P", String(server.proc.pid)], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const resultLog = () => join(root, "results.jsonl");

before(async () => {
  if (skipServer) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-export-test-")));
  temp = join(root, "tmp");
  mkdirSync(temp);
  mkdirSync(join(root, "out"));
  writeFileSync(join(root, "prompts.jsonl"), "");
  writeFileSync(resultLog(), "");
  makeExportFixture(join(root, "media"));
  // The server's temp folder is its own, so leftovers are ours to see.
  server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data"), TMPDIR: temp, UNCUT_CLAUDE: FAKE, FAKE_PLAN: join(root, "plan.json"), FAKE_PROMPT_LOG: join(root, "prompts.jsonl"), FAKE_RESULT_LOG: resultLog() } });
  client = await connect(server.ready.port, server.ready.token);
  jobs = client.subscribe("export.jobs");
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

const open = async (name: string, project: Project) => client.ok("project.open", { dir: writeProject(root, name, project) });
const probe = (file: string) =>
  JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,duration:format=duration", "-of", "json", file], { encoding: "utf8" })) as {
    streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate: string; nb_frames?: string }>;
    format: { duration: string };
  };
/** Frame n of a video (by index, not by seeking) as a PNG. */
const frameOf = (file: string, n: number, out: string) => (execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-update", "1", out]), out);
/** SSIM of two images at 480×270 grey (1 = identical). */
const ssim = (a: string, b: string) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0]scale=480:270,format=gray[a];[1]scale=480:270,format=gray[b];[a][b]ssim", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/All:([\d.]+)/.exec(r.stderr)![1]);
};
/** RMS of the left channel over [t, t + d) seconds (decoded from the start: an AAC seek can land oddly). */
const rms = (file: string, t: number, d = 0.05) => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a", "-af", `pan=mono|c0=FL,atrim=start=${t}:duration=${d}`, "-f", "f32le", "-"]);
  const s = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  return Math.sqrt(s.reduce((a, x) => a + x * x, 0) / s.length);
};
/** The RMS core expects over the same window: every sound is a sine at amplitude 0.5 of its own pitch. */
const expectedRms = (project: Project, t: number, d = 0.05) => {
  const { starts } = layout(project);
  const steps = 50;
  const power = new Map<string, number>();
  for (let i = 0; i < steps; i++) {
    const f = (t + ((i + 0.5) / steps) * d) * FPS;
    for (const a of audibleAt(project, starts, f)) {
      const pitch = a.item.media!;
      power.set(pitch, (power.get(pitch) ?? 0) + (0.5 * a.gain) ** 2 / 2 / steps);
    }
  }
  return Math.sqrt([...power.values()].reduce((a, b) => a + b, 0));
};

test("export: the fixture renders at the canvas size and fps with sound at core's levels", { skip: skipServer, timeout: 120000 }, async () => {
  const project = exportProject(join(root, "media"));
  await open("Fixture", project);
  const output = join(root, "out", "Fixture.mp4");
  const t0 = Date.now();
  const { jobId } = await client.ok("export.start", { output, quality: "standard", loudness: "off" });
  await jobs.until((list) => list.some((j: any) => j.id === jobId && j.phase === "rendering"), 60000);
  const done = await finished(jobId);
  assert.equal(done.phase, "done", done.error);
  console.log(`fixture export (8 s, 1080p): ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  assert.equal(done.output, output);
  assert.equal(done.progress, 1);
  const p = probe(output);
  const v = p.streams.find((s) => s.codec_type === "video")!;
  const a = p.streams.find((s) => s.codec_type === "audio")!;
  assert.equal(v.width, 1920);
  assert.equal(v.height, 1080);
  assert.equal(v.r_frame_rate, "30/1");
  assert.equal(Number(v.nb_frames), 240);
  assert.equal(a.codec_name, "aac");
  const colour = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_space,color_primaries,color_transfer,color_range", "-of", "csv=p=0", output], { encoding: "utf8" }).trim();
  assert.equal(colour, "tv,bt709,bt709,bt709", "tagged BT.709 (range, matrix, primaries, transfer)");
  assert.ok(Math.abs(Number(p.format.duration) - 8) < 0.05, `duration ${p.format.duration}`);
  // Frame 60 is A 15 frames in (the clip after the title card), full frame.
  const src = join(root, "a-15.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(root, "media", "A.mp4"), "-vf", "select=eq(n\\,15),scale=1920:1080", "-frames:v", "1", "-update", "1", src]);
  const shot = ssim(frameOf(output, 60, join(root, "export-60.png")), src);
  console.log(`frame 60 vs source frame 15: SSIM ${shot.toFixed(4)}`);
  assert.ok(shot > 0.97, `SSIM ${shot}`);
  // Sound: music fading in, clip tones, the crossfade, the music fading out.
  for (const t of [0.5, 1.2, 2, 3.6, 4.7, 5, 5.2, 6.5, 7.5]) {
    const got = rms(output, t);
    const want = expectedRms(project, t);
    console.log(`  rms at ${t}s: ${got.toFixed(4)} (core ${want.toFixed(4)})`);
    assert.ok(Math.abs(got - want) <= 0.03 * want + 0.003, `rms at ${t}s: ${got} vs ${want}`);
  }
  // Nothing left in the temp folder (the rasteriser's profile included).
  assert.deepEqual(readdirSync(temp), []);
  assert.deepEqual(children(), []);
});

test("export: an existing file is replaced only when asked; loudness lands on its target; draft is 720p", { skip: skipServer, timeout: 120000 }, async () => {
  const output = join(root, "out", "Fixture.mp4");
  assert.ok(existsSync(output));
  const refused = await client.fail("export.start", { output, quality: "draft", loudness: "normal" });
  assert.equal(refused.reason, "exists");
  assert.match(refused.message, /Fixture\.mp4 already exists/);
  const { jobId } = await client.ok("export.start", { output, quality: "draft", loudness: "normal", overwrite: true });
  const done = await finished(jobId);
  assert.equal(done.phase, "done", done.error);
  const v = probe(output).streams.find((s) => s.codec_type === "video")!;
  assert.deepEqual([v.width, v.height], [1280, 720]);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", output, "-map", "0:a", "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" });
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/.exec(r.stderr)?.[1]);
  console.log(`loudness after "normal": ${lufs} LUFS`);
  assert.ok(Math.abs(lufs + 14) < 1, `integrated loudness ${lufs}`);
});

test("export: a project without sound gets a silent track; bad paths and missing media are clear errors", { skip: skipServer, timeout: 120000 }, async () => {
  const silent = { ...exportProject(join(root, "media")), media: [], tracks: [{ id: "main", kind: "video" as const, role: "main" as const, name: "Main", items: [{ id: "card", type: "component" as const, component: "component.solid", duration: 30, props: { color: "white" } }] }] };
  await open("Silent", silent);
  const output = join(root, "out", "Silent.mp4");
  const { jobId } = await client.ok("export.start", { output, quality: "standard", loudness: "normal" });
  const done = await finished(jobId);
  assert.equal(done.phase, "done", done.error);
  const streams = probe(output).streams;
  assert.ok(streams.some((s) => s.codec_type === "audio"));
  assert.ok(rms(output, 0.2, 0.5) < 1e-4);
  const white = execFileSync("ffmpeg", ["-v", "error", "-i", output, "-vf", "select=eq(n\\,10),scale=1:1,format=gray", "-frames:v", "1", "-f", "rawvideo", "-"])[0]!;
  assert.ok(white > 230, `white card came out as ${white}`);

  const relative = await client.fail("export.start", { output: "Silent.mp4", quality: "standard", loudness: "off" });
  assert.equal(relative.reason, "invalid-path");
  const nowhere = await client.fail("export.start", { output: join(root, "no-such-folder", "x.mp4"), quality: "standard", loudness: "off" });
  assert.equal(nowhere.reason, "invalid-path");

  // Never over footage the project uses, even when told to replace (the file isn't touched).
  const fixture = exportProject(join(root, "media"));
  await open("Footage", fixture);
  const before = readFileSync(join(root, "media", "A.mp4"));
  const footage = await client.fail("export.start", { output: join(root, "media", "A.mp4"), quality: "standard", loudness: "off", overwrite: true });
  assert.equal(footage.reason, "source-media");
  assert.match(footage.message, /A\.mp4 would replace footage this project uses/);
  assert.ok(readFileSync(join(root, "media", "A.mp4")).equals(before));
  // A folder Uncut can't write in is said at once, in words.
  const locked = join(root, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o555);
  const unwritable = await client.fail("export.start", { output: join(locked, "x.mp4"), quality: "standard", loudness: "off" });
  chmodSync(locked, 0o755);
  assert.equal(unwritable.reason, "invalid-path");
  assert.match(unwritable.message, /isn't allowed to write in/);

  const broken = exportProject(join(root, "media"));
  await open("Broken", { ...broken, media: broken.media.map((m) => (m.id === "m-b" ? { ...m, path: join(root, "media", "Gone.mp4") } : m)) });
  const missing = await client.fail("export.start", { output: join(root, "out", "Broken.mp4"), quality: "standard", loudness: "off" });
  assert.equal(missing.reason, "missing-media");
  assert.match(missing.message, /B\.mp4 \(.*Gone\.mp4\) is missing/);
  assert.ok(!existsSync(join(root, "out", "Broken.mp4")));
});

test("export: cancelling while text is drawn or mid-render leaves no processes, temp files or output", { skip: skipServer, timeout: 180000 }, async () => {
  const media = join(root, "media");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "60", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(media, "Long.mp4")]);
  const base = exportProject(media);
  const long: Project = {
    ...base,
    media: [...base.media, { id: "m-long", kind: "video", name: "Long.mp4", path: join(media, "Long.mp4"), probe: { frames: 1800, fps: 30, width: 1280, height: 720, hasAudio: false } }],
    tracks: base.tracks.map((t) => (t.id === "main" ? { ...t, items: [{ id: "long", type: "clip" as const, media: "m-long", in: 0, duration: 1800 }] } : t.id === "audio" || t.id === "overlay" ? { ...t, items: [] } : t)),
  };
  await open("Long", long);
  const output = join(root, "out", "Long.mp4");

  // Right away: queued or drawing the text.
  const first = await client.ok("export.start", { output, quality: "high", loudness: "off" });
  await client.ok("export.cancel", { jobId: first.jobId });
  assert.equal((await finished(first.jobId)).phase, "cancelled");

  // Mid-render: ffmpeg is a child of the server, then it isn't.
  const { jobId } = await client.ok("export.start", { output, quality: "high", loudness: "off" });
  // A second export waits its turn; one to the same file is refused; cancelling the waiting one is immediate.
  const waiting = await client.ok("export.start", { output: join(root, "out", "Long-2.mp4"), quality: "draft", loudness: "off" });
  const same = await client.fail("export.start", { output, quality: "draft", loudness: "off", overwrite: true });
  assert.equal(same.reason, "busy");
  await jobs.until((list) => list.some((j: any) => j.id === jobId && j.phase === "rendering" && j.progress > 0.05), 60000);
  assert.equal(job(waiting.jobId).phase, "queued");
  await client.ok("export.cancel", { jobId: waiting.jobId });
  await jobs.until((list) => list.some((j: any) => j.id === waiting.jobId && j.phase === "cancelled"), 2000);
  assert.equal(job(jobId).phase, "rendering", "the running one goes on");
  const running = job(jobId);
  assert.ok(running.etaSeconds >= 0, "an ETA while rendering");
  const kids = children();
  assert.ok(kids.length >= 1, "ffmpeg runs as the server's child");
  await client.ok("export.cancel", { jobId });
  const end = await finished(jobId);
  assert.equal(end.phase, "cancelled");
  assert.equal(end.error, undefined);
  for (let i = 0; i < 20 && children().length; i++) await sleep(100);
  assert.deepEqual(children(), [], "no ffmpeg or rasteriser left");
  for (const pid of kids) assert.throws(() => process.kill(Number(pid), 0), `pid ${pid} is gone`);
  assert.deepEqual(readdirSync(temp), [], "temp files removed");
  assert.ok(!existsSync(output), "no partial output");
  assert.deepEqual(readdirSync(dirname(output)).filter((f) => f.startsWith(".")), []);
});

test("export: quitting mid-render stops ffmpeg and removes the temp files before the server exits", { skip: skipServer, timeout: 120000 }, async () => {
  const quitTemp = join(root, "tmp-quit");
  mkdirSync(quitTemp);
  const other = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data-quit"), TMPDIR: quitTemp } });
  const c = await connect(other.ready.port, other.ready.token);
  try {
    const list = c.subscribe("export.jobs");
    await c.ok("project.open", { dir: join(root, "Long.uncut") });
    const { jobId } = await c.ok("export.start", { output: join(root, "out", "Quit.mp4"), quality: "high", loudness: "off" });
    await list.until((l) => l.some((j: any) => j.id === jobId && j.phase === "rendering" && j.progress > 0.02), 60000);
    const kids = spawnSync("pgrep", ["-P", String(other.proc.pid)], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    assert.ok(kids.length >= 1);
    assert.ok(readdirSync(quitTemp).length >= 1, "temp files while rendering");
    c.close();
    await other.stop();
    for (const pid of kids) assert.throws(() => process.kill(Number(pid), 0), `pid ${pid} is gone`);
    assert.deepEqual(readdirSync(quitTemp), [], "temp files removed before exit");
    assert.ok(!existsSync(join(root, "out", "Quit.mp4")));
  } finally {
    c.close();
    await other.stop();
  }
});

test("render_frames: the agent gets JPEGs of the edit that match the export's frames", { skip: skipServer, timeout: 120000 }, async () => {
  const project = exportProject(join(root, "media"));
  const snap = await open("Frames", project);
  assert.ok(snap.dir);
  writeFileSync(join(root, "plan.json"), JSON.stringify([[{ tool: "render_frames", args: { frames: [5, 120, 150], scale: 0.25 } }, { tool: "render_frames", args: { frames: [] } }]]));
  const agent = client.subscribe("agent.subscribe");
  const { turnId } = await client.ok("agent.send", { prompt: "Look at it" });
  await agent.until((s) => s?.turns.some((t: any) => t.id === turnId && t.status !== "running"), 60000);
  const turn = agent.values.at(-1).turns.find((t: any) => t.id === turnId);
  assert.equal(turn.items.find((i: any) => i.tool === "render_frames")?.text, "Looked at frames 5, 120, 150");
  const [ok, bad] = readFileSync(resultLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l)) as Array<{ result: { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } }>;
  assert.ok(!ok!.result.isError, JSON.stringify(ok!.result).slice(0, 300));
  assert.match(ok!.result.content[0]!.text!, /Frames 5, 120, 150 .* at 480×270/);
  const images = ok!.result.content.filter((c) => c.type === "image");
  assert.equal(images.length, 3);
  const exported = join(root, "out", "Fixture-frames.mp4");
  const { jobId } = await client.ok("export.start", { output: exported, quality: "standard", loudness: "off" });
  assert.equal((await finished(jobId)).phase, "done");
  for (const [i, f] of [5, 120, 150].entries()) {
    assert.equal(images[i]!.mimeType, "image/jpeg");
    const jpg = join(root, `agent-${f}.jpg`);
    writeFileSync(jpg, Buffer.from(images[i]!.data!, "base64"));
    const s = probe(jpg).streams[0]!;
    assert.deepEqual([s.width, s.height], [480, 270]);
    const score = ssim(jpg, frameOf(exported, f, join(root, `exported-${f}.png`)));
    console.log(`render_frames ${f} vs export: SSIM ${score.toFixed(4)}`);
    assert.ok(score > 0.9, `frame ${f}: SSIM ${score}`);
  }
  assert.ok(bad!.result.isError);
  assert.match(bad!.result.content[0]!.text!, /frames must be/);
});

test("export: the DJI 4K clip exports at 4K and matches the source frame", { skip: skipServer || skipDemo, timeout: 600000 }, async () => {
  const projectFile = demoProject();
  const project = JSON.parse(readFileSync(projectFile, "utf8")) as Project;
  await client.ok("project.open", { dir: dirname(projectFile) });
  // A frame showing one clip alone, fully, with no text: its picture is the source's.
  const { starts, duration } = layout(project);
  let pick: { f: number; source: number } | undefined;
  for (let f = Math.floor(duration * 0.6); f < duration && !pick; f++) {
    const vs = visualsAt(project, starts, f);
    if (vs.length === 1 && vs[0]!.item.type === "clip" && vs[0]!.opacity === 1) pick = { f, source: vs[0]!.source };
  }
  assert.ok(pick, "a frame with one clip alone");
  const output = join(root, "out", "Demo.mp4");
  const t0 = Date.now();
  const { jobId } = await client.ok("export.start", { output, quality: "high", loudness: "off" });
  const done = await finished(jobId, 550000);
  assert.equal(done.phase, "done", done.error);
  const seconds = (Date.now() - t0) / 1000;
  const v = probe(output).streams.find((s) => s.codec_type === "video")!;
  assert.deepEqual([v.width, v.height, v.codec_name, v.r_frame_rate], [3840, 2160, "hevc", "60/1"]);
  const shot = frameOf(output, pick.f, join(root, "demo-export.png"));
  // The source frame on screen at that moment is the last one starting at or before it (D38);
  // its neighbours show how much a frame off would cost.
  const times = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-read_intervals", `${pick.source - 0.2}%+0.4`, "-show_entries", "frame=pts_time", "-of", "csv=p=0", FOOTAGE], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map(Number)
    .sort((a, b) => a - b);
  const onScreen = times.filter((t) => t <= pick!.source + 0.0001).length - 1;
  assert.ok(onScreen > 0 && onScreen < times.length - 1);
  const scores: Array<number> = [];
  for (const i of [onScreen - 1, onScreen, onScreen + 1]) {
    const src = join(root, `demo-src-${i}.png`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(times[i]! - 0.0005), "-i", FOOTAGE, "-frames:v", "1", "-update", "1", src]);
    scores.push(ssim(shot, src));
  }
  console.log(`DJI export (${(duration / project.canvas.fps).toFixed(1)} s of 4K, High/HEVC): ${seconds.toFixed(1)} s; frame ${pick.f} (source ${pick.source.toFixed(3)} s) vs the source frames before / on screen / after: SSIM ${scores.map((s) => s.toFixed(4)).join(" / ")}`);
  assert.ok(scores[1]! > 0.95, `SSIM ${scores}`);
  assert.ok(scores[1]! >= Math.max(scores[0]!, scores[2]!), "the frame on screen matches best");
  rmSync(output, { force: true });
});
