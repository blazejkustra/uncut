// The tools the app ships (native/tools): an LGPL FFmpeg with what Uncut's exports need, loading only
// its own libraries and the system's. CI's bundled-tools job builds them; elsewhere the file skips.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OUT = resolve("native/tools/out");
const FFMPEG = join(OUT, "bin/ffmpeg");
const T = { skip: existsSync(FFMPEG) ? false : "the bundled tools aren't built (pnpm tools:build)" };

const USED_FILTERS = [
  "acompressor",
  "adelay",
  "afftdn",
  "alimiter",
  "aloop",
  "alphaextract",
  "alphamerge",
  "ametadata",
  "amix",
  "anullsrc",
  "apad",
  "asetrate",
  "atempo",
  "atrim",
  "biquad",
  "blend",
  "blurdetect",
  "colorchannelmixer",
  "colorspace",
  "convolution",
  "ebur128",
  "equalizer",
  "exposure",
  "fade",
  "freezedetect",
  "gblur",
  "geq",
  "hflip",
  "loudnorm",
  "lut3d",
  "lutrgb",
  "lutyuv",
  "overlay",
  "pan",
  "pixelize",
  "premultiply",
  "rgbashift",
  "scale",
  "scdet",
  "sendcmd",
  "setparams",
  "silencedetect",
  "tile",
  "tpad",
  "unpremultiply",
  "vibrance",
  "xstack",
];

const ffmpeg = (...args: ReadonlyArray<string>) => execFileSync(FFMPEG, ["-hide_banner", ...args], { encoding: "utf8" });
const linkedLibraries = (file: string) =>
  execFileSync("otool", ["-L", file], { encoding: "utf8" })
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0]!)
    .filter(Boolean);

test("the FFmpeg that ships is LGPL, with no GPL or nonfree part", T, () => {
  const config = ffmpeg("-buildconf");
  assert.doesNotMatch(config, /--enable-(gpl|nonfree|version3|libx264|libx265)\b/);
  assert.match(ffmpeg("-L"), /Lesser General Public\s+License/);
  const encoders = ffmpeg("-encoders");
  assert.doesNotMatch(encoders, /libx26[45]/);
  assert.ok(existsSync(join(OUT, "licenses/FFmpeg.LGPLv2.1.txt")));
});

test("the tools load only their own libraries and the system's, so nothing needs Homebrew", T, () => {
  const libraries = readdirSync(join(OUT, "lib")).map((f) => join(OUT, "lib", f));
  const tools = readdirSync(join(OUT, "bin")).map((f) => join(OUT, "bin", f));
  for (const file of [...libraries, ...tools])
    for (const lib of linkedLibraries(file)) assert.match(lib, /^(@rpath\/|\/usr\/lib\/|\/System\/)/, `${file}: ${lib}`);
});

test("it has the filters, encoders and decoders Uncut uses", T, () => {
  const filters = ffmpeg("-filters");
  for (const name of USED_FILTERS) assert.match(filters, new RegExp(`\\s${name}\\s`), name);
  const encoders = ffmpeg("-encoders");
  for (const name of ["h264_videotoolbox", "hevc_videotoolbox", "aac", "ffv1", "png", "mjpeg"]) assert.ok(encoders.includes(` ${name} `), name);
  const decoders = ffmpeg("-decoders");
  for (const name of ["h264", "hevc", "prores", "vp9", "libdav1d", "aac", "mp3", "opus"]) assert.ok(decoders.includes(` ${name} `), name);
  assert.match(ffmpeg("-hwaccels"), /videotoolbox/);
});

test("VideoToolbox makes H.264 and HEVC that decode", T, () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-tools-"));
  try {
    for (const [encoder, name] of [
      ["h264_videotoolbox", "h264.mp4"],
      ["hevc_videotoolbox", "hevc.mp4"],
    ] as const) {
      const file = join(dir, name);
      ffmpeg("-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=1", "-c:v", encoder, "-allow_sw", "1", "-b:v", "2M", file);
      ffmpeg("-v", "error", "-i", file, "-f", "null", "-");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("whisper-cli starts", T, () => {
  assert.match(execFileSync(join(OUT, "bin/whisper-cli"), ["--version"], { encoding: "utf8" }), /whisper\.cpp version: \d/);
});
