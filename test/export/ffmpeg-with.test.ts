// The software encoders aren't in the LGPL ffmpeg Uncut ships: an export that asks for one uses a
// system ffmpeg that has it, and stays on the shipped one when there's none.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ffmpegWith } from "../../apps/server/src/export/exporter/ffmpeg.ts";

let root = "";
const saved = { PATH: process.env.PATH, UNCUT_TOOLS_DIR: process.env.UNCUT_TOOLS_DIR };

const fakeFfmpeg = (dir: string, encoders: ReadonlyArray<string>) => {
  mkdirSync(dir, { recursive: true });
  const lines = encoders.map((e) => `echo " V....D ${e}  an encoder"`).join("\n");
  const file = join(dir, "ffmpeg");
  writeFileSync(file, `#!/bin/sh\n${lines}\n`);
  chmodSync(file, 0o755);
  return file;
};

before(() => {
  root = mkdtempSync(join(tmpdir(), "uncut-ffmpeg-with-"));
  process.env.UNCUT_TOOLS_DIR = join(root, "tools");
});
after(() => {
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
});

test("the shipped ffmpeg is used when it has the encoder", async () => {
  const bundled = fakeFfmpeg(join(root, "tools/bin"), ["h264_videotoolbox", "libx264"]);
  process.env.PATH = `${join(root, "tools/bin")}:/usr/bin:/bin`;
  assert.equal(await ffmpegWith(bundled, "libx264"), bundled);
});

test("a system ffmpeg with the encoder takes over, and only that one", async () => {
  const bundled = fakeFfmpeg(join(root, "only/tools/bin"), ["h264_videotoolbox"]);
  process.env.UNCUT_TOOLS_DIR = join(root, "only/tools");
  const system = fakeFfmpeg(join(root, "homebrew"), ["libx264"]);
  process.env.PATH = `${join(root, "only/tools/bin")}:${join(root, "homebrew")}:/usr/bin:/bin`;
  assert.equal(await ffmpegWith(bundled, "libx264"), system);
  assert.equal(await ffmpegWith(bundled, "libx265"), undefined);
});

test("with no system ffmpeg there's nothing to fall back on", async () => {
  const bundled = fakeFfmpeg(join(root, "alone/tools/bin"), ["h264_videotoolbox"]);
  process.env.UNCUT_TOOLS_DIR = join(root, "alone/tools");
  process.env.PATH = `${join(root, "alone/tools/bin")}:/nowhere`;
  assert.equal(await ffmpegWith(bundled, "libx264"), undefined);
});
