// D212: hardware H.264 export (issue #12).
// - Which encoder each preset and Advanced choice gets, with one encoder or both (no processes).
// - Quality: VideoToolbox at the preset's constant quality scores at least libx264's VMAF minus one
//   on a generated clip (needs libvmaf and VideoToolbox in the local ffmpeg).
// - On the bundled server: Draft records the hardware encoder; when VideoToolbox refuses (an ffmpeg
//   wrapper that fails its runs), the export falls back to libx264, says so and still finishes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { defaultEncoder, HARDWARE_H264_QUALITY, SOFTWARE_H264_CRF } from "../../packages/core/src/export.ts";
import { hardwareEncoderFailed, usesHardware, videoCodec, type Caps } from "../../apps/server/src/export/exportPlan.ts";
import type { Project } from "../../packages/core/src/timeline/types.ts";
import { exportProject, makeExportFixture, writeProject } from "../helpers/export-fixture.ts";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const BOTH: Caps = { encoders: new Set(["h264_videotoolbox", "hevc_videotoolbox", "libx264", "libx265"]), videotoolboxDecode: true, major: 8 };
const VT_ONLY: Caps = { encoders: new Set(["h264_videotoolbox", "hevc_videotoolbox"]), videotoolboxDecode: true, major: 8 };
const SW_ONLY: Caps = { encoders: new Set(["libx264", "libx265"]), videotoolboxDecode: false, major: 8 };
const hd = { width: 1920, height: 1080 };
const arg = (args: ReadonlyArray<string>, flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

test("D212: Draft and Standard encode on VideoToolbox, High on libx264; Advanced swaps either", () => {
  assert.deepEqual((["draft", "standard", "high"] as const).map(defaultEncoder), ["hardware", "hardware", "software"]);
  for (const q of ["draft", "standard"] as const) {
    const args = videoCodec(q, BOTH, hd, 30);
    assert.equal(arg(args, "-c:v"), "h264_videotoolbox", q);
    // Constant quality, never a bitrate as well.
    assert.equal(arg(args, "-q:v"), String(HARDWARE_H264_QUALITY[q]), q);
    assert.equal(arg(args, "-b:v"), undefined, q);
    assert.equal(arg(videoCodec(q, BOTH, hd, 30, { encoder: "software" }), "-c:v"), "libx264", q);
  }
  assert.equal(arg(videoCodec("draft", BOTH, hd, 30), "-prio_speed"), "1");
  const high = videoCodec("high", BOTH, hd, 30);
  assert.deepEqual([arg(high, "-c:v"), arg(high, "-crf")], ["libx264", String(SOFTWARE_H264_CRF.high)]);
  const highHw = videoCodec("high", BOTH, hd, 30, { encoder: "hardware" });
  assert.deepEqual([arg(highHw, "-c:v"), arg(highHw, "-q:v")], ["h264_videotoolbox", String(HARDWARE_H264_QUALITY.high)]);
  // A bitrate replaces the constant quality on both encoders.
  const set = videoCodec("standard", BOTH, hd, 30, { bitrateMbps: 20 });
  assert.deepEqual([arg(set, "-c:v"), arg(set, "-b:v"), arg(set, "-q:v")], ["h264_videotoolbox", "20M", undefined]);
  const setSw = videoCodec("standard", BOTH, hd, 30, { encoder: "software", bitrateMbps: 20 });
  assert.deepEqual([arg(setSw, "-c:v"), arg(setSw, "-b:v"), arg(setSw, "-crf")], ["libx264", "20M", undefined]);
  // HEVC follows the encoder too.
  assert.equal(arg(videoCodec("standard", BOTH, hd, 30, { codec: "hevc" }), "-c:v"), "hevc_videotoolbox");
  assert.equal(arg(videoCodec("high", BOTH, hd, 30, { codec: "hevc" }), "-c:v"), "libx265");
  // An ffmpeg with one encoder uses it, whatever was asked.
  assert.equal(arg(videoCodec("standard", SW_ONLY, hd, 30, { encoder: "hardware" }), "-c:v"), "libx264");
  assert.equal(arg(videoCodec("high", VT_ONLY, hd, 30, { encoder: "software" }), "-c:v"), "h264_videotoolbox");
  assert.equal(usesHardware("standard", SW_ONLY), false);
  assert.equal(usesHardware("high", VT_ONLY), true);
  assert.equal(usesHardware("high", BOTH), false);
});

test("D212: a VideoToolbox refusal is told apart from other ffmpeg failures", () => {
  for (const line of [
    "[h264_videotoolbox @ 0x1] Error: cannot create compression session: -12902",
    "Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height",
    "[vost#0:0/h264_videotoolbox @ 0x2] Error initializing output stream: Function not implemented",
    "Could not open encoder before EOF",
  ])
    assert.ok(hardwareEncoderFailed(line), line);
  for (const line of ["/x/clip.mp4: No such file or directory", "Invalid data found when processing input", "[Parsed_overlay_3 @ 0x1] Failed to configure input pad"]) assert.ok(!hardwareEncoderFailed(line), line);
});

// ---- quality ----

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const listed = (flag: string) => (hasFfmpeg ? execFileSync("ffmpeg", ["-hide_banner", flag], { encoding: "utf8" }) : "");
const hasVmaf = /\blibvmaf\b/.test(listed("-filters"));
const hasVt = /\bh264_videotoolbox\b/.test(listed("-encoders")) && /\blibx264\b/.test(listed("-encoders"));
const skipQuality = !hasFfmpeg ? "needs ffmpeg" : !hasVmaf ? "this ffmpeg has no libvmaf" : !hasVt ? "this ffmpeg has no h264_videotoolbox and libx264" : false;

const vmaf = (file: string, ref: string) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-i", ref, "-lavfi", "[0:v]settb=1/60,setpts=N[a];[1:v]settb=1/60,setpts=N[b];[a][b]libvmaf", "-f", "null", "-"], { encoding: "utf8" });
  const score = /VMAF score: ([\d.]+)/.exec(r.stderr)?.[1];
  assert.ok(score, r.stderr.slice(-400));
  return Number(score);
};

test("D212: VideoToolbox at each preset's quality scores at least libx264's VMAF minus one", { skip: skipQuality, timeout: 120000 }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "uncut-encoder-")));
  try {
    const ref = join(dir, "ref.mkv");
    // Detail and grain that change every frame: hard for both encoders.
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=2,noise=alls=12:allf=t+u,format=yuv420p", "-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", ref]);
    const caps = BOTH;
    const size = { width: 1280, height: 720 };
    for (const q of ["draft", "standard", "high"] as const) {
      const score = (encoder: "hardware" | "software") => {
        const out = join(dir, `${q}-${encoder}.mp4`);
        execFileSync("ffmpeg", ["-v", "error", "-y", "-i", ref, ...videoCodec(q, caps, size, 30, { encoder }), "-pix_fmt", "yuv420p", out]);
        return vmaf(out, ref);
      };
      const hw = score("hardware");
      const sw = score("software");
      assert.ok(hw >= sw - 1, `${q}: VideoToolbox ${hw.toFixed(2)} vs libx264 ${sw.toFixed(2)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- on the server ----

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const skipServer = !existsSync(BUNDLE) || !existsSync(MEDIA) || !existsSync(DESKTOP) ? "server, desktop or media core not built (run pnpm build)" : !hasFfmpeg ? "needs ffmpeg" : !hasVt ? "this ffmpeg has no h264_videotoolbox and libx264" : false;

type Server = Awaited<ReturnType<typeof startServer>>;
type Client = Awaited<ReturnType<typeof connect>>;
let root = "";
let server: Server;
let client: Client;
let jobs: ReturnType<Client["subscribe"]>;
const job = (id: string) => jobs.values.at(-1)?.find((j: { id: string }) => j.id === id);
const finished = (id: string) => jobs.until((list) => list.some((j: any) => j.id === id && ["done", "failed", "cancelled"].includes(j.phase)), 120000).then(() => job(id));
const codecOf = (file: string) => execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", file], { encoding: "utf8" }).trim();

before(async () => {
  if (skipServer) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-encoder-server-")));
  for (const d of ["out", "tmp", "bin"]) mkdirSync(join(root, d));
  makeExportFixture(join(root, "media"));
  // An ffmpeg that refuses VideoToolbox encodes while bin/refuse exists, like a Mac without the hardware mode.
  const real = execFileSync("/bin/sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim();
  const wrapper = join(root, "bin", "ffmpeg");
  writeFileSync(wrapper, `#!/bin/sh\nif [ -e "${join(root, "bin", "refuse")}" ]; then case "$*" in *h264_videotoolbox*) echo "[h264_videotoolbox @ 0x1] Error: cannot create compression session: -12902" >&2; exit 1;; esac; fi\nexec "${real}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data"), TMPDIR: join(root, "tmp"), PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}` } });
  client = await connect(server.ready.port, server.ready.token);
  jobs = client.subscribe("export.jobs");
  const p = exportProject(join(root, "media"));
  const plain: Project = { ...p, tracks: p.tracks.filter((t) => t.id === "main").map((t) => ({ ...t, items: t.items.filter((i) => i.type === "clip") })) };
  await client.ok("project.open", { dir: writeProject(root, "Encoders", plain) });
});
after(async () => {
  client?.close();
  await server?.stop();
  killAll();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("D212 on the server: Draft encodes on the hardware; a refused hardware encode falls back to libx264", { skip: skipServer, timeout: 240000 }, async () => {
  const run = async (name: string) => {
    const output = join(root, "out", `${name}.mp4`);
    const { jobId } = await client.ok("export.start", { output, quality: "draft", loudness: "off" });
    const done = await finished(jobId);
    assert.equal(done.phase, "done", done.error);
    assert.equal(codecOf(output), "h264");
    return done;
  };
  const hw = await run("Hardware");
  assert.equal(hw.encoder, "hardware");
  assert.ok(!(hw.warnings ?? []).some((w: string) => /hardware encoder/.test(w)));
  writeFileSync(join(root, "bin", "refuse"), "");
  const fell = await run("Fallback");
  assert.equal(fell.encoder, "software");
  assert.ok((fell.warnings ?? []).some((w: string) => /hardware encoder failed/.test(w)), JSON.stringify(fell.warnings));
});
