// Builds the media tools Uncut ships into native/tools/out, from the pinned sources in sources.ts:
//   out/bin       ffmpeg, ffprobe (LGPL 2.1 or later), whisper-cli (MIT)
//   out/lib       FFmpeg's shared libraries, found through @rpath, so anyone can relink against their own
//   out/licenses  the licence texts and SOURCES.txt
//   out/sources   the source archives, attached to each release beside the app (not in the app)
// Needs Xcode's command line tools, cmake, meson and ninja. Only an LGPL FFmpeg may ship: no
// --enable-gpl, --enable-nonfree or --enable-version3, so no x264 or x265; H.264 and HEVC encode
// through VideoToolbox.
//   node native/tools/build.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

import { FFMPEG_CONFIGURE, TOOL_SOURCES, type ToolSource } from "./sources.ts";

const HERE = import.meta.dirname;
const OUT = join(HERE, "out");
const WORK = join(HERE, "work");
const PREFIX = join(WORK, "prefix");
const MACOS_TARGET = "13.0";
const JOBS = String(availableParallelism());
const FFMPEG_LIBRARY = /^(libavcodec|libavdevice|libavfilter|libavformat|libavutil|libswresample|libswscale)\.\d+\.dylib$/;
const TOOLS = ["ffmpeg", "ffprobe", "whisper-cli"];

const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: MACOS_TARGET, PKG_CONFIG_PATH: join(PREFIX, "lib/pkgconfig") };
const run = (command: string, args: ReadonlyArray<string>, cwd: string) => execFileSync(command, args, { cwd, env, stdio: "inherit" });
const ffmpegSays = (...args: ReadonlyArray<string>) => execFileSync(join(OUT, "bin/ffmpeg"), ["-hide_banner", ...args], { encoding: "utf8" });
const sourceOf = (name: ToolSource["name"]) => TOOL_SOURCES.find((s) => s.name === name)!;

function unpacked(source: ToolSource) {
  const archive = join(WORK, source.file);
  if (!existsSync(archive)) run("curl", ["-fsSL", "--retry", "3", "-o", archive, source.url], WORK);
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (sha256 !== source.sha256) throw new Error(`${source.file} has SHA-256 ${sha256}, expected ${source.sha256}`);
  const dir = join(WORK, `${source.name}-src`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  run("tar", ["xf", archive, "--strip-components=1", "-C", dir], WORK);
  return dir;
}

function buildDav1d(src: string) {
  run(
    "meson",
    ["setup", "build", `--prefix=${PREFIX}`, "--libdir=lib", "--buildtype=release", "--default-library=static", "-Denable_tools=false", "-Denable_tests=false"],
    src,
  );
  run("ninja", ["-C", "build", "install"], src);
}

function buildFfmpeg(src: string) {
  const min = `-mmacosx-version-min=${MACOS_TARGET}`;
  const flags = [
    `--prefix=${PREFIX}`,
    ...FFMPEG_CONFIGURE,
    `--extra-cflags=${min}`,
    `--extra-ldflags=${min} -Wl,-rpath,@executable_path/../lib`,
    "--pkg-config-flags=--static",
  ];
  run("./configure", flags, src);
  run("make", [`-j${JOBS}`, "install"], src);
}

function buildWhisper(src: string) {
  const flags = [
    "-B",
    "build",
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOS_TARGET}`,
    "-DCMAKE_OSX_ARCHITECTURES=arm64",
    "-DBUILD_SHARED_LIBS=OFF",
    "-DGGML_NATIVE=OFF",
    "-DGGML_METAL=ON",
    "-DGGML_METAL_EMBED_LIBRARY=ON",
    "-DWHISPER_BUILD_TESTS=OFF",
    "-DWHISPER_BUILD_SERVER=OFF",
  ];
  run("cmake", flags, src);
  run("cmake", ["--build", "build", "--target", "whisper-cli", "-j", JOBS], src);
}

function layOutBinaries(whisperSrc: string) {
  copyFileSync(join(PREFIX, "bin/ffmpeg"), join(OUT, "bin/ffmpeg"));
  copyFileSync(join(PREFIX, "bin/ffprobe"), join(OUT, "bin/ffprobe"));
  copyFileSync(join(whisperSrc, "build/bin/whisper-cli"), join(OUT, "bin/whisper-cli"));
  for (const file of readdirSync(join(PREFIX, "lib")).filter((f) => FFMPEG_LIBRARY.test(f))) copyFileSync(join(PREFIX, "lib", file), join(OUT, "lib", file));
}

function layOutLicences(ffmpegSrc: string, dav1dSrc: string, whisperSrc: string) {
  copyFileSync(join(ffmpegSrc, "COPYING.LGPLv2.1"), join(OUT, "licenses/FFmpeg.LGPLv2.1.txt"));
  copyFileSync(join(dav1dSrc, "COPYING"), join(OUT, "licenses/dav1d.txt"));
  copyFileSync(join(whisperSrc, "LICENSE"), join(OUT, "licenses/whisper.cpp.txt"));
  const sources = TOOL_SOURCES.map((s) => `${s.name} ${s.version}\n  ${s.url}\n  SHA-256 ${s.sha256}`).join("\n");
  const text = `${sources}\n\nAll three are unmodified. FFmpeg is configured with:\n${FFMPEG_CONFIGURE.join(" ")}\n\nThe recipe is native/tools in https://github.com/blazejkustra/uncut\n`;
  writeFileSync(join(OUT, "licenses/SOURCES.txt"), text);
}

function layOutSources() {
  for (const source of TOOL_SOURCES) copyFileSync(join(WORK, source.file), join(OUT, "sources", source.file));
}

function signAdHoc() {
  const libraries = readdirSync(join(OUT, "lib")).map((f) => join(OUT, "lib", f));
  for (const file of [...TOOLS.map((t) => join(OUT, "bin", t)), ...libraries]) {
    run("strip", ["-x", file], OUT);
    run("codesign", ["--force", "--sign", "-", file], OUT);
  }
}

function assertShippable() {
  if (/--enable-(gpl|nonfree|version3)\b/.test(ffmpegSays("-buildconf"))) throw new Error("This FFmpeg isn't LGPL 2.1, so it must not ship.");
  if (!/Lesser General Public\s+License/.test(ffmpegSays("-L"))) throw new Error("This FFmpeg doesn't report the LGPL, so it must not ship.");
  const encoders = ffmpegSays("-encoders");
  for (const needed of ["h264_videotoolbox", "hevc_videotoolbox"]) if (!encoders.includes(needed)) throw new Error(`This FFmpeg has no ${needed}.`);
}

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("The bundled tools are built on Apple silicon macOS.");
rmSync(PREFIX, { recursive: true, force: true });
mkdirSync(PREFIX, { recursive: true });
const dav1dSrc = unpacked(sourceOf("dav1d"));
const ffmpegSrc = unpacked(sourceOf("ffmpeg"));
const whisperSrc = unpacked(sourceOf("whisper.cpp"));
buildDav1d(dav1dSrc);
buildFfmpeg(ffmpegSrc);
buildWhisper(whisperSrc);

rmSync(OUT, { recursive: true, force: true });
for (const dir of ["bin", "lib", "licenses", "sources"]) mkdirSync(join(OUT, dir), { recursive: true });
layOutBinaries(whisperSrc);
layOutLicences(ffmpegSrc, dav1dSrc, whisperSrc);
layOutSources();
signAdHoc();
assertShippable();
console.log(`Built the media tools in ${OUT}`);
