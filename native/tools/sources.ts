// The exact sources of the tools Uncut ships. scripts/notices.ts names them in THIRD_PARTY_NOTICES.
export interface ToolSource {
  readonly name: "ffmpeg" | "dav1d" | "whisper.cpp";
  readonly version: string;
  readonly url: string;
  readonly file: string;
  readonly sha256: string;
}

export const TOOL_SOURCES: ReadonlyArray<ToolSource> = [
  {
    name: "ffmpeg",
    version: "9.0.2",
    url: "https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz",
    file: "ffmpeg-9.0.2.tar.xz",
    sha256: "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e",
  },
  {
    name: "dav1d",
    version: "1.5.4",
    url: "https://code.videolan.org/videolan/dav1d/-/archive/1.5.4/dav1d-1.5.4.tar.bz2",
    file: "dav1d-1.5.4.tar.bz2",
    sha256: "2abfb0c89212e6e4733a54e0ae509ec00a5b845a6360946f918806e14aedb011",
  },
  {
    name: "whisper.cpp",
    version: "1.9.5",
    url: "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.5.tar.gz",
    file: "whisper.cpp-1.9.5.tar.gz",
    sha256: "ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720",
  },
];

export const FFMPEG_CONFIGURE: ReadonlyArray<string> = [
  "--arch=arm64",
  "--cc=clang",
  "--disable-static",
  "--enable-shared",
  "--install-name-dir=@rpath",
  "--disable-autodetect",
  "--disable-indevs",
  "--enable-indev=lavfi",
  "--disable-outdevs",
  "--disable-debug",
  "--disable-doc",
  "--disable-ffplay",
  "--enable-audiotoolbox",
  "--enable-bzlib",
  "--enable-libdav1d",
  "--enable-securetransport",
  "--enable-videotoolbox",
  "--enable-zlib",
];
