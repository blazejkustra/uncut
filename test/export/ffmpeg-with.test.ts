// The software encoders aren't in the LGPL ffmpeg Uncut ships: an export that asks for one uses a
// system ffmpeg that has it, and stays on the shipped one when there's none.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentEnv } from "../../apps/server/src/app/shellEnv.ts";
import { ffmpegWith } from "../../apps/server/src/export/exporter/ffmpeg.ts";
import { softwareEncoder } from "../../apps/server/src/export/exportPlan.ts";

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

test("ProRes stays on the shipped ffmpeg, which has prores_ks", async () => {
  const bundled = fakeFfmpeg(join(root, "prores/tools/bin"), ["prores_ks"]);
  process.env.UNCUT_TOOLS_DIR = join(root, "prores/tools");
  process.env.PATH = `${join(root, "prores/tools/bin")}:/nowhere`;
  assert.equal(await ffmpegWith(bundled, softwareEncoder("prores4444")), bundled);
});

test("the agent's plain ffmpeg is the installed one, with the shipped one still on its PATH", () => {
  fakeFfmpeg(join(root, "agent/tools/bin"), []);
  const shipped = join(root, "agent/tools/bin");
  const env = { UNCUT_TOOLS_DIR: join(root, "agent/tools"), PATH: `${shipped}:/opt/homebrew/bin:/usr/bin` };
  assert.equal(agentEnv(env).PATH, `/opt/homebrew/bin:/usr/bin:${shipped}`);
  assert.equal(agentEnv({ UNCUT_TOOLS_DIR: "", PATH: "/opt/homebrew/bin:/usr/bin" }).PATH, "/opt/homebrew/bin:/usr/bin");
});
