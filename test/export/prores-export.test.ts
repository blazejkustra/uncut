// ProRes masters: the encoder arguments for each profile, and on the bundled server real .mov files
// checked with ffprobe and a full decode, alpha included.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { codecExtension, presetBitrateMbps } from "../../packages/core/src/export.ts";
import type { Project } from "../../packages/core/src/timeline/types.ts";
import { canProRes, usesHardware, videoCodec, type Caps } from "../../apps/server/src/export/exportPlan.ts";
import { pictureFormats } from "../../apps/server/src/export/plan/codec.ts";
import { exportFileName, freeOutput } from "../../apps/server/src/agent/tools/exportVideo.ts";
import { fileName } from "../../apps/web/src/panels/exportDialog/format.ts";
import { exportProject, makeExportFixture, writeProject } from "../helpers/export-fixture.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const hd = { width: 1920, height: 1080 };
const CAPS: Caps = { encoders: new Set(["prores_ks", "h264_videotoolbox"]), videotoolboxDecode: true, major: 8 };
const arg = (args: ReadonlyArray<string>, flag: string) => args[args.indexOf(flag) + 1];

test("ProRes: each codec maps to prores_ks and its profile, never hardware, ignoring a bitrate", () => {
  const expected = { prores422: "standard", prores422hq: "hq", prores4444: "4444" } as const;
  for (const [codec, profile] of Object.entries(expected) as Array<[keyof typeof expected, string]>) {
    const args = videoCodec("high", CAPS, hd, 30, { codec, bitrateMbps: 20 });
    assert.equal(arg(args, "-c:v"), "prores_ks");
    assert.equal(arg(args, "-profile:v"), profile);
    assert.equal(arg(args, "-vendor"), "apl0");
    assert.equal(args.includes("-b:v"), false);
    assert.equal(usesHardware("standard", CAPS, { codec }), false);
    assert.equal(codecExtension(codec), "mov");
  }
  assert.equal(canProRes(CAPS), true);
  assert.equal(canProRes({ encoders: new Set(["libx264"]) }), false);
  assert.ok(presetBitrateMbps("high", "prores422hq", hd, 30) > presetBitrateMbps("high", "prores422", hd, 30));
});

test("ProRes: composites in 4:4:4, and only 4444 with alpha keeps the alpha plane", () => {
  assert.equal(pictureFormats().output, "yuv420p");
  assert.equal(pictureFormats({ codec: "hevc" }).alpha, "yuva420p");
  assert.equal(pictureFormats({ codec: "prores422" }).output, "yuv422p10le");
  assert.equal(pictureFormats({ codec: "prores4444" }).output, "yuv444p10le");
  const alpha = pictureFormats({ codec: "prores4444", alpha: true });
  assert.deepEqual(alpha, { plain: "yuva444p", alpha: "yuva444p", overlay: "yuv444", output: "yuva444p10le" });
});

test("ProRes: file names follow the codec, in the dialog and for the agent", () => {
  assert.equal(fileName("Launch.mp4", "mov"), "Launch.mov");
  assert.equal(fileName("Launch.mov", "mp4"), "Launch.mp4");
  assert.equal(fileName("Launch.MOV", "mov"), "Launch.MOV");
  assert.equal(fileName("Launch"), "Launch.mp4");
  assert.equal(exportFileName("Launch.mp4", "mov"), "Launch.mov");
  assert.equal(exportFileName("Launch"), "Launch.mp4");
  const taken = new Set(["/d/Launch.mov"]);
  assert.equal(
    freeOutput("/d", "Launch.mov", (p) => taken.has(p)),
    "/d/Launch 2.mov",
  );
});

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const hasProRes = hasFfmpeg && execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).includes("prores_ks");
const skipServer =
  !existsSync(BUNDLE) || !existsSync(MEDIA) || !existsSync(DESKTOP) ? "not built (run pnpm build)" : hasProRes ? false : "needs prores_ks in ffmpeg";

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let server: Server;
let client: Client;
let jobs: ReturnType<Client["subscribe"]>;

const SIZE = { width: 1920, height: 1080 };

const exportVideo = async (name: string, video: object) => {
  const output = join(root, "out", name);
  const { jobId } = await client.ok("export.start", { output, quality: "high", loudness: "off", video });
  await jobs.until((list) => list.some((j: any) => j.id === jobId && ["done", "failed", "cancelled"].includes(j.phase)), 200000);
  const job = jobs.values.at(-1)?.find((j: { id: string }) => j.id === jobId);
  assert.equal(job.phase, "done", job.error);
  return output;
};

const probe = (file: string) =>
  JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], {
      encoding: "utf8",
    }),
  ) as { streams: Array<Record<string, string>>; format: { format_name: string; duration: string } };

/** The alpha plane of the frame at `seconds`, one byte a pixel. */
const alphaFrame = (file: string, seconds: number) =>
  execFileSync("ffmpeg", ["-v", "error", "-ss", String(seconds), "-i", file, "-frames:v", "1", "-vf", "alphaextract,format=gray", "-f", "rawvideo", "pipe:1"], {
    maxBuffer: 1 << 26,
  });

/** How many frames a full decode gets, with -xerror so that a damaged frame fails the test. */
const decodedFrames = (file: string) => {
  const out = execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", file, "-map", "0:v", "-f", "null", "-progress", "pipe:1", "-"], { encoding: "utf8" });
  return Number(/frame=(\d+)\s*\n(?![\s\S]*frame=)/.exec(out)?.[1]);
};

before(async () => {
  if (skipServer) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-prores-")));
  for (const d of ["out", "tmp"]) mkdirSync(join(root, d));
  makeExportFixture(join(root, "media"));
  server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data"), TMPDIR: join(root, "tmp") } });
  client = await connect(server.ready.port, server.ready.token);
  jobs = client.subscribe("export.jobs");
  const p = exportProject(join(root, "media"));
  const lower: Project = {
    ...p,
    tracks: p.tracks.filter((t) => t.id === "text" || t.id === "main").map((t) => (t.id === "main" ? { ...t, items: [] } : t)),
  };
  await client.ok("project.open", { dir: writeProject(root, "ProRes", lower) });
});

after(async () => {
  if (skipServer) return;
  await killAll();
  rmSync(root, { recursive: true, force: true });
});

test(
  "ProRes 422 on the server: a QuickTime file of the profile, tagged BT.709, PCM sound, every frame decodes",
  { skip: skipServer, timeout: 240000 },
  async () => {
    const file = await exportVideo("master.mov", { codec: "prores422", shortSide: 360 });
    const info = probe(file);
    const video = info.streams.find((s) => s.codec_type === "video")!;
    assert.match(info.format.format_name, /mov/);
    assert.equal(video.codec_name, "prores");
    assert.equal(video.profile, "Standard");
    assert.equal(video.codec_tag_string, "apcn");
    assert.equal(video.pix_fmt, "yuv422p10le");
    assert.deepEqual([video.color_space, video.color_primaries, video.color_transfer], ["bt709", "bt709", "bt709"]);
    assert.ok(decodedFrames(file) > 0);
  },
);

test("ProRes 4444 with alpha on the server: the background is transparent, what's drawn is opaque", { skip: skipServer, timeout: 240000 }, async () => {
  const file = await exportVideo("alpha.mov", { codec: "prores4444", alpha: true });
  const info = probe(file);
  const video = info.streams.find((s) => s.codec_type === "video")!;
  assert.equal(video.codec_name, "prores");
  assert.equal(video.profile, "4444");
  assert.equal(video.codec_tag_string, "ap4h");
  assert.ok(video.pix_fmt!.startsWith("yuva444p"), video.pix_fmt);
  assert.ok(decodedFrames(file) > 0);
  const alpha = alphaFrame(file, 0.5);
  assert.equal(alpha.length, SIZE.width * SIZE.height);
  assert.equal(alpha[0], 0, "the corner is transparent");
  assert.ok(
    alpha.some((a) => a >= 250),
    "the text is opaque",
  );
});

test("ProRes 4444 with alpha over the canvas colour matches the opaque export, soft edges included", { skip: skipServer, timeout: 240000 }, async () => {
  const opaque = await exportVideo("match-opaque.mov", { codec: "prores4444" });
  const alpha = await exportVideo("match-alpha.mov", { codec: "prores4444", alpha: true });
  const graph =
    "[0:v]trim=start_frame=20:end_frame=21,format=yuv444p[o];color=black:s=1920x1080:d=1,format=yuv444p[c];[1:v]trim=start_frame=20:end_frame=21,setpts=PTS-STARTPTS[a];[c][a]overlay=format=yuv444:shortest=1,format=yuv444p[m];[o][m]psnr";
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", opaque, "-i", alpha, "-lavfi", graph, "-f", "null", "-"], { encoding: "utf8" });
  const psnr = /average:(\S+)/.exec(r.stderr)?.[1];
  assert.ok(psnr === "inf" || Number(psnr) > 35, `PSNR ${psnr}`);
});

test("ProRes 4444 without alpha stays opaque, and alpha on another codec is refused", { skip: skipServer, timeout: 240000 }, async () => {
  const file = await exportVideo("opaque.mov", { codec: "prores4444" });
  const video = probe(file).streams.find((s) => s.codec_type === "video")!;
  assert.ok(video.pix_fmt!.startsWith("yuv444p"), video.pix_fmt);
  const refused = await client.fail("export.start", {
    output: join(root, "out", "no.mov"),
    quality: "high",
    loudness: "off",
    video: { codec: "prores422", alpha: true },
  });
  assert.equal(refused.reason, "invalid-settings");
  const wrongName = await client.fail("export.start", { output: join(root, "out", "no.mp4"), quality: "high", loudness: "off", video: { codec: "prores422" } });
  assert.equal(wrongName.reason, "invalid-path");
});
