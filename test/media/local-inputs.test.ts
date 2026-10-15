// D219: every ffmpeg/ffprobe input is limited to files and pipes (-protocol_whitelist file,pipe),
// and the exports, concat lists, image sequences, lut3d files, subtitles and pipes still work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { localInputs } from "../../apps/server/src/media/localInputs.ts";

const W = ["-protocol_whitelist", "file,pipe"];
const which = (bin: string) => spawnSync("which", [bin], { encoding: "utf8" }).stdout.trim() || undefined;
const FFMPEG = which("ffmpeg");
const FFPROBE = which("ffprobe");

test("D219: the whitelist goes before every ffmpeg input, once; ffprobe gets it up front; other programs are untouched", () => {
  assert.deepEqual(localInputs("/opt/homebrew/bin/ffmpeg", ["-v", "error", "-i", "a.mp4", "-ss", "2", "-i", "b.mov", "-filter_complex", "overlay", "out.mp4"]), ["-v", "error", ...W, "-i", "a.mp4", "-ss", "2", ...W, "-i", "b.mov", "-filter_complex", "overlay", "out.mp4"]);
  // An input that already has one (probe/thumb/proxy, D212) keeps just that; idempotent.
  const thumb = ["-v", "error", "-y", ...W, "-hwaccel", "videotoolbox", "-ss", "1", "-i", "a.mp4", "-frames:v", "1", "t.jpg"];
  assert.deepEqual(localInputs("ffmpeg", thumb), thumb);
  const once = localInputs("ffmpeg", ["-f", "image2", "-pattern_type", "none", "-i", "x.png", "-i", "pipe:0", "o.mp4"]);
  assert.deepEqual(localInputs("ffmpeg", once), once);
  assert.equal(once.filter((a) => a === "-protocol_whitelist").length, 2);
  // No inputs: as it was.
  for (const args of [["-hide_banner", "-encoders"], ["-hwaccels"], ["-version"]]) assert.deepEqual(localInputs("ffmpeg", args), args);
  assert.deepEqual(localInputs("/x/ffprobe", ["-v", "error", "-show_format", "a.mp4"]), [...W, "-v", "error", "-show_format", "a.mp4"]);
  assert.deepEqual(localInputs("ffprobe", [...W, "a.mp4"]), [...W, "a.mp4"]);
  for (const bin of ["/x/whisper-cli", "claude", "/usr/bin/git"]) assert.deepEqual(localInputs(bin, ["-i", "a"]), ["-i", "a"]);
});

test("D219: with the whitelist, real ffmpeg still does what exports need, and refuses network inputs", { skip: !FFMPEG || !FFPROBE ? "ffmpeg isn't installed" : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-local-inputs-"));
  const ff = (args: Array<string>, input?: Buffer) => spawnSync(FFMPEG!, localInputs(FFMPEG!, ["-v", "error", "-nostdin", "-y", ...args]), { cwd: dir, encoding: "utf8", ...(input ? { input } : {}) });
  const ok = (args: Array<string>, what: string, input?: Buffer) => {
    const r = ff(args, input);
    assert.equal(r.status, 0, `${what}: ${r.stderr}`);
  };
  try {
    ok(["-f", "lavfi", "-i", "color=red:s=64x64:d=1", "-r", "10", "a.mp4"], "a lavfi input");
    ok(["-i", "a.mp4", "f%03d.png"], "a file input");
    ok(["-f", "image2", "-framerate", "10", "-start_number", "1", "-i", "f%03d.png", "-f", "image2", "-pattern_type", "none", "-i", "f001.png", "-filter_complex", "overlay", "b.mp4"], "an image sequence and a still");
    writeFileSync(join(dir, "list.txt"), "file 'a.mp4'\nfile 'b.mp4'\n");
    ok(["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "c.mp4"], "a concat list");
    writeFileSync(join(dir, "id.cube"), "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n");
    ok(["-i", "a.mp4", "-vf", `lut3d=file=${join(dir, "id.cube")}`, "d.mp4"], "a lut3d file");
    writeFileSync(join(dir, "s.srt"), "1\n00:00:00,000 --> 00:00:01,000\nhi\n");
    ok(["-i", "a.mp4", "-f", "srt", "-i", "s.srt", "-map", "0", "-map", "1", "-c:v", "copy", "-c:s", "mov_text", "e.mp4"], "a subtitles input");
    ok(["-f", "rawvideo", "-pix_fmt", "rgba", "-s", "4x4", "-i", "pipe:0", "-frames:v", "1", "p.png"], "a pipe input", Buffer.alloc(64));
    const probed = execFileSync(FFPROBE!, localInputs(FFPROBE!, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(dir, "c.mp4")]), { encoding: "utf8" });
    assert.ok(Number(probed) > 1.5, probed);
    // A second input over http, and a concat list naming one: refused before any connection.
    const http = ff(["-i", "a.mp4", "-i", "http://127.0.0.1:9/x.mp4", "-f", "null", "-"]);
    assert.notEqual(http.status, 0);
    assert.match(http.stderr, /Protocol 'http' not on whitelist 'file,pipe'/);
    writeFileSync(join(dir, "evil.txt"), "ffconcat version 1.0\nfile 'http://127.0.0.1:9/x.mp4'\n");
    const nested = ff(["-f", "concat", "-safe", "0", "-i", "evil.txt", "-f", "null", "-"]);
    assert.notEqual(nested.status, 0);
    assert.match(nested.stderr, /not on whitelist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
