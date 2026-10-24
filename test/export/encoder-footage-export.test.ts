// D289 (issue #12): D212's hardware H.264 rule checked on real footage, not only a generated clip.
// For each preset, a stretch of the DJI 4K60 HEVC drone clip (test/helpers/footage.ts) is scaled to
// the preset's size into a lossless 8-bit intermediate, then encoded with exactly the export's
// video arguments (videoCodec) on VideoToolbox and on libx264. Each is scored against the
// intermediate with libvmaf and ssim:
// - VideoToolbox's VMAF ≥ libx264's − 1 at every preset (D212's matching rule), SSIM within 0.005;
// - VideoToolbox encodes faster at Standard and High (Draft is decode-bound end to end, D212).
// Skips without the footage (UNCUT_FOOTAGE_DIR or the fixtures/footage symlink), libvmaf or
// either encoder. The numbers go to the test's diagnostics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { videoCodec, type Caps } from "../../apps/server/src/export/exportPlan.ts";
import { DJI_CLIP, footageMissing } from "../helpers/footage.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const listed = (flag: string) => (hasFfmpeg ? execFileSync("ffmpeg", ["-hide_banner", flag], { encoding: "utf8" }) : "");
const encoders = listed("-encoders");
const hasVmaf = /\blibvmaf\b/.test(listed("-filters"));
const hasBoth = /\bh264_videotoolbox\b/.test(encoders) && /\blibx264\b/.test(encoders);
const skip = !existsSync(DJI_CLIP)
  ? footageMissing(DJI_CLIP)
  : !hasFfmpeg
    ? "needs ffmpeg"
    : !hasVmaf
      ? "this ffmpeg has no libvmaf"
      : !hasBoth
        ? "this ffmpeg has no h264_videotoolbox and libx264"
        : false;

const CAPS: Caps = { encoders: new Set(["h264_videotoolbox", "libx264"]), videotoolboxDecode: true, major: 8 };
const FPS = 60;
// D212's stretches: 10 s from 1:00 at 720p and 1080p, 5 s at 4K.
const PRESETS = [
  { quality: "draft", width: 1280, height: 720, seconds: 10 },
  { quality: "standard", width: 1920, height: 1080, seconds: 10 },
  { quality: "high", width: 3840, height: 2160, seconds: 5 },
] as const;

/** VMAF and SSIM (All) of `file` against `ref`, frame-aligned. */
function score(file: string, ref: string) {
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      file,
      "-i",
      ref,
      "-lavfi",
      `[0:v]settb=1/${FPS},setpts=N,split[a0][a1];[1:v]settb=1/${FPS},setpts=N,split[b0][b1];[a0][b0]libvmaf=n_threads=8;[a1][b1]ssim`,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const vmaf = /VMAF score: ([\d.]+)/.exec(r.stderr)?.[1];
  const ssim = /SSIM .*All:([\d.]+)/.exec(r.stderr)?.[1];
  assert.ok(vmaf && ssim, r.stderr.slice(-600));
  return { vmaf: Number(vmaf), ssim: Number(ssim) };
}

test(
  "D289: on the drone footage VideoToolbox matches libx264's quality at every preset, and is faster at Standard and High",
  { skip, timeout: 900000 },
  (t) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "uncut-encoder-footage-")));
    try {
      const rows: Array<string> = [];
      for (const p of PRESETS) {
        const ref = join(dir, `${p.quality}-ref.mkv`);
        // The export's own scaling of a 10-bit BT.709 source to an 8-bit 4:2:0 picture, kept lossless.
        execFileSync("ffmpeg", [
          "-v",
          "error",
          "-y",
          "-hwaccel",
          "videotoolbox",
          "-ss",
          "60",
          "-t",
          String(p.seconds),
          "-i",
          DJI_CLIP,
          "-map",
          "0:v:0",
          "-vf",
          `scale=w=${p.width}:h=${p.height}:out_color_matrix=bt709:out_range=tv,format=yuv420p`,
          "-c:v",
          "libx264",
          "-qp",
          "0",
          "-preset",
          "ultrafast",
          ref,
        ]);
        const run = (encoder: "hardware" | "software") => {
          const out = join(dir, `${p.quality}-${encoder}.mp4`);
          const started = performance.now();
          execFileSync("ffmpeg", [
            "-v",
            "error",
            "-y",
            "-i",
            ref,
            ...videoCodec(p.quality, CAPS, { width: p.width, height: p.height }, FPS, { encoder }),
            "-pix_fmt",
            "yuv420p",
            out,
          ]);
          const seconds = (performance.now() - started) / 1000;
          const mbps = (statSync(out).size * 8) / 1e6 / p.seconds;
          return { seconds, mbps, ...score(out, ref) };
        };
        const hw = run("hardware");
        const sw = run("software");
        const row = (name: string, r: typeof hw) =>
          `${p.quality} ${name}: VMAF ${r.vmaf.toFixed(2)}, SSIM ${r.ssim.toFixed(4)}, ${r.mbps.toFixed(1)} Mb/s, ${r.seconds.toFixed(1)} s`;
        rows.push(row("VideoToolbox", hw), row("libx264", sw));
        assert.ok(hw.vmaf >= sw.vmaf - 1, `${p.quality}: VMAF VideoToolbox ${hw.vmaf.toFixed(2)} vs libx264 ${sw.vmaf.toFixed(2)}`);
        assert.ok(hw.ssim >= sw.ssim - 0.005, `${p.quality}: SSIM VideoToolbox ${hw.ssim.toFixed(4)} vs libx264 ${sw.ssim.toFixed(4)}`);
        if (p.quality !== "draft")
          assert.ok(hw.seconds < sw.seconds, `${p.quality}: VideoToolbox ${hw.seconds.toFixed(1)} s vs libx264 ${sw.seconds.toFixed(1)} s`);
        rmSync(ref);
      }
      for (const r of rows) t.diagnostic(r);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
