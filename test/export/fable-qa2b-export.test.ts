// Fable QA round 2, export chunk (F4, D171): every preset is H.264 (High at a higher bitrate), HEVC
// only when chosen; the Advanced size, frame rate and bitrate are what the file gets.
// - The encoder arguments and the output-rate filter against the choices (no processes).
// - On the bundled server: High → h264 (ffprobe); HEVC chosen → hevc; 720p at 24 fps and a bitrate
//   → a 1280×720, 24/1 file of the same length; out-of-range settings are refused.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Project } from "../../packages/core/src/timeline/types.ts";
import { exportFrameRates, exportShortSides, outputSize, presetBitrateMbps } from "../../packages/core/src/export.ts";
import { canHevc, exportCommand, planExport, videoCodec, type Caps } from "../../apps/server/src/export/exportPlan.ts";
import { exportProject, makeExportFixture, writeProject } from "../helpers/export-fixture.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skipServer =
  !existsSync(BUNDLE) || !existsSync(MEDIA) || !existsSync(DESKTOP)
    ? "server, desktop or media core not built (run pnpm build)"
    : hasFfmpeg
      ? false
      : "needs ffmpeg";
const localEncoders = hasFfmpeg
  ? new Set([...execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).matchAll(/^\s*[VAS][\w.]{5}\s+(\S+)/gm)].map((m) => m[1]!))
  : new Set<string>();

const VT: Caps = { encoders: new Set(["h264_videotoolbox", "hevc_videotoolbox", "libx264"]), videotoolboxDecode: true, major: 8 };
const SW: Caps = { encoders: new Set(["libx264", "libx265"]), videotoolboxDecode: false, major: 8 };
const arg = (args: ReadonlyArray<string>, flag: string) => args[args.indexOf(flag) + 1];

test("F4: every preset encodes H.264; HEVC only when chosen; a bitrate replaces the preset's", () => {
  const hd = { width: 1920, height: 1080 };
  // D212: Draft and Standard on VideoToolbox, High on libx264 (Advanced can swap either).
  for (const q of ["draft", "standard"] as const) assert.equal(arg(videoCodec(q, VT, hd, 30), "-c:v"), "h264_videotoolbox", q);
  assert.equal(arg(videoCodec("high", VT, hd, 30), "-c:v"), "libx264");
  for (const q of ["draft", "standard", "high"] as const) assert.equal(arg(videoCodec(q, SW, hd, 30), "-c:v"), "libx264", q);
  // HEVC's bitrate: High above Standard at the same size (the shared table the dialog shows).
  assert.equal(arg(videoCodec("high", VT, hd, 30, { codec: "hevc", encoder: "hardware" }), "-b:v"), `${presetBitrateMbps("high", "hevc", hd, 30)}M`);
  assert.ok(presetBitrateMbps("high", "hevc", hd, 30) > presetBitrateMbps("standard", "hevc", hd, 30));
  assert.equal(arg(videoCodec("standard", VT, hd, 30, { codec: "hevc" }), "-c:v"), "hevc_videotoolbox");
  assert.equal(arg(videoCodec("high", VT, hd, 30, { codec: "hevc" }), "-tag:v"), "hvc1");
  assert.equal(arg(videoCodec("standard", SW, hd, 30, { codec: "hevc" }), "-c:v"), "libx265");
  assert.equal(arg(videoCodec("standard", VT, hd, 30, { bitrateMbps: 12 }), "-b:v"), "12M");
  // libx264 keeps its quality-based rate unless a bitrate is given.
  assert.equal(arg(videoCodec("high", SW, hd, 30), "-crf"), "17");
  assert.equal(arg(videoCodec("high", SW, hd, 30, { bitrateMbps: 8 }), "-b:v"), "8M");
  assert.equal(canHevc({ encoders: new Set(["libx264"]) }), false);
});

test("F4: Advanced sizes and rates: never upscaled, the canvas first; another output rate resamples the finished picture", () => {
  assert.deepEqual(exportShortSides({ width: 1920, height: 1080 }), [1080, 720, 480]);
  assert.deepEqual(exportShortSides({ width: 3840, height: 2160 }), [2160, 1440, 1080, 720, 480]);
  assert.deepEqual(exportFrameRates(30), [30, 25, 24]);
  assert.deepEqual(outputSize({ width: 1080, height: 1920 }, "high", 720), { width: 720, height: 1280 });
  assert.deepEqual(outputSize({ width: 1280, height: 720 }, "high", 1080), { width: 1280, height: 720 });
  const project = plainProject("/x");
  const plan = planExport(project, { mediaPath: (m) => m.path, width: 1280, height: 720 });
  assert.ok(!("problem" in plan));
  const base = { background: "/bg.png", rasters: new Map(), caps: VT, quality: "high" as const, output: "/out.mp4" };
  assert.match(exportCommand(plan, base).graph, new RegExp(`trim=end_frame=${plan.frames}\\[vout\\]`));
  const at24 = exportCommand(plan, { ...base, video: { fps: 24, codec: "hevc", bitrateMbps: 5 } });
  assert.match(at24.graph, new RegExp(`trim=end_frame=${plan.frames},fps=24\\[vout\\]`));
  assert.equal(arg(at24.outputArgs, "-c:v"), "hevc_videotoolbox");
  assert.equal(arg(at24.outputArgs, "-b:v"), "5M");
  assert.equal(arg(at24.outputArgs, "-t"), String(plan.frames / plan.fps));
});

// ---- on the server ----

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let server: Server;
let client: Client;
let jobs: ReturnType<Client["subscribe"]>;
const job = (id: string) => jobs.values.at(-1)?.find((j: { id: string }) => j.id === id);
const finished = (id: string, timeout = 120000) =>
  jobs.until((list) => list.some((j: any) => j.id === id && ["done", "failed", "cancelled"].includes(j.phase)), timeout).then(() => job(id));

/** The fixture's picture clips only (no text, so no rasteriser: quick). */
function plainProject(dir = join(root, "media")): Project {
  const p = exportProject(dir);
  return {
    ...p,
    tracks: p.tracks
      .filter((t) => t.id === "main" || t.id === "audio")
      .map((t) => (t.id === "main" ? { ...t, items: t.items.filter((i) => i.type === "clip") } : t)),
  };
}
const probe = (file: string) => {
  const out = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,codec_tag_string,width,height,r_frame_rate,nb_frames,bit_rate:format=duration",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8" },
    ),
  ) as {
    streams: Array<{ codec_name: string; codec_tag_string: string; width: number; height: number; r_frame_rate: string; nb_frames: string; bit_rate?: string }>;
    format: { duration: string };
  };
  return { ...out.streams[0]!, duration: Number(out.format.duration) };
};

before(async () => {
  if (skipServer) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-fable2-export-")));
  mkdirSync(join(root, "out"));
  mkdirSync(join(root, "tmp"));
  makeExportFixture(join(root, "media"));
  server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data"), TMPDIR: join(root, "tmp") } });
  client = await connect(server.ready.port, server.ready.token);
  jobs = client.subscribe("export.jobs");
  await client.ok("project.open", { dir: writeProject(root, "Plain", plainProject()) });
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

const exportWith = async (name: string, payload: Record<string, unknown>) => {
  const output = join(root, "out", `${name}.mp4`);
  const { jobId } = await client.ok("export.start", { output, loudness: "off", ...payload });
  const done = await finished(jobId);
  assert.equal(done.phase, "done", done.error);
  return { output, job: done, probe: probe(output) };
};

test("F4 on the server: High is H.264 at the canvas size", { skip: skipServer, timeout: 120000 }, async () => {
  const { job: j, probe: p } = await exportWith("High", { quality: "high" });
  assert.equal(p.codec_name, "h264");
  assert.equal(p.codec_tag_string, "avc1");
  assert.deepEqual([p.width, p.height, p.r_frame_rate], [1920, 1080, "30/1"]);
  assert.equal(j.codec, "h264");
});

test(
  "F4 on the server: HEVC when chosen in Advanced",
  { skip: skipServer || (canHevc({ encoders: localEncoders }) ? false : "this ffmpeg has no HEVC encoder"), timeout: 120000 },
  async () => {
    const { job: j, probe: p } = await exportWith("Hevc", { quality: "high", video: { codec: "hevc" } });
    assert.equal(p.codec_name, "hevc");
    assert.equal(p.codec_tag_string, "hvc1");
    assert.equal(j.codec, "hevc");
  },
);

test(
  "F4 on the server: a size, frame rate and bitrate override is what the file gets; bad values are refused",
  { skip: skipServer, timeout: 120000 },
  async () => {
    const { job: j, probe: p } = await exportWith("Small", { quality: "standard", video: { shortSide: 720, fps: 24, bitrateMbps: 2 } });
    assert.equal(p.codec_name, "h264");
    assert.deepEqual([p.width, p.height, p.r_frame_rate], [1280, 720, "24/1"]);
    const plan = planExport(plainProject(), { mediaPath: (m) => m.path, width: 1280, height: 720 });
    assert.ok(!("problem" in plan));
    const seconds = plan.frames / plan.fps;
    assert.ok(Math.abs(p.duration - seconds) < 0.1, `${p.duration} vs ${seconds}`);
    assert.equal(Number(p.nb_frames), Math.round(seconds * 24));
    assert.deepEqual([j.width, j.height, j.fps, j.bitrateMbps], [1280, 720, 24, 2]);
    // VideoToolbox aims at the bitrate; well under the preset's (3.1 Mb/s at 720p24 would be Standard's own).
    if (p.bit_rate) assert.ok(Number(p.bit_rate) < 3.5e6, `bit rate ${p.bit_rate}`);
    for (const video of [{ fps: 0 }, { bitrateMbps: 9000 }, { shortSide: 4 }]) {
      const refused = await client.fail("export.start", { output: join(root, "out", "Bad.mp4"), quality: "standard", loudness: "off", video });
      assert.equal((refused as { reason: string }).reason, "invalid-settings", JSON.stringify(video));
    }
  },
);
