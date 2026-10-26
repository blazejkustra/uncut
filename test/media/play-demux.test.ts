// D311: the playback engine's demuxer (mediabunny, apps/web/src/preview/play/source.ts) picks the
// frame <video> shows at a time, as the scrub cache's index does: for H.264 with B-frames (an edit
// list), HEVC long-GOP and a .mov, the packet shown at each frame's time is the frame ffmpeg decodes
// there, and its key packet is a keyframe at or before it. WebM, which the scrub cache can't index,
// demuxes too. Decoding needs WebCodecs (the app tests cover it); the decoder's colour space fills in
// what the file leaves out as the <video> reads it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// mediabunny is the web app's dependency, so it's reached in the web app's node_modules.
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from "../../apps/web/node_modules/mediabunny/dist/modules/src/index.js";
import { namedColour } from "../../apps/web/src/preview/scrub.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const encoders = hasFfmpeg ? execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }) : "";
const skip = hasFfmpeg ? false : "needs ffmpeg";
let dir = "";
const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

before(() => {
  dir = mkdtempSync(join(tmpdir(), "uncut-play-demux-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** The frames ffmpeg decodes, in presentation order. */
const framePts = (file: string) =>
  (
    JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "json", file], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    ).frames as Array<{ pts_time: string }>
  ).map((f) => Number(f.pts_time));

/** For every decoded frame: the packet shown at its time is that frame, and its key packet is a keyframe at or before it. */
async function picksShownFrames(file: string, fps: number) {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  try {
    const track = (await input.getPrimaryVideoTrack())!;
    assert.ok(await track.getDecoderConfig(), "a decoder config");
    const sink = new EncodedPacketSink(track);
    const shown = framePts(file);
    assert.ok(shown.length > fps, "decoded frames");
    for (let f = 0; f < shown.length; f++) {
      const t = f / fps + 0.0001;
      const packet = (await sink.getPacket(t))!;
      assert.ok(Math.abs(packet.timestamp - shown[f]!) < 1e-3, `frame ${f}: packet ${packet.timestamp} vs ffmpeg ${shown[f]}`);
      const key = (await sink.getKeyPacket(t, { verifyKeyPackets: true }))!;
      assert.equal(key.type, "key");
      assert.ok(key.timestamp <= packet.timestamp + 1e-6);
    }
  } finally {
    input.dispose();
  }
}

test("D311: H.264 with B-frames: the packet shown at each frame's time is ffmpeg's frame there", { skip }, async () => {
  const file = join(dir, "bframes.mp4");
  ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "3", "-c:v", "libx264", "-bf", "3", "-g", "45", "-pix_fmt", "yuv420p", file);
  await picksShownFrames(file, 30);
});

test("D311: HEVC long-GOP (hvc1) and a .mov pick the same frames", { skip }, async () => {
  const hevc = join(dir, "hevc.mp4");
  const encoder = /\bhevc_videotoolbox\b/.test(encoders)
    ? ["-c:v", "hevc_videotoolbox", "-b:v", "4M"]
    : ["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "keyint=60:log-level=error"];
  ff("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "3", ...encoder, "-tag:v", "hvc1", "-pix_fmt", "yuv420p", hevc);
  await picksShownFrames(hevc, 30);
  const mov = join(dir, "clip.mov");
  ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "3", "-c:v", "libx264", "-bf", "2", "-pix_fmt", "yuv420p", mov);
  await picksShownFrames(mov, 25);
});

test(
  "D311: WebM (VP9), which the scrub cache can't index, demuxes with a decoder config",
  { skip: skip || (!/\blibvpx-vp9\b/.test(encoders) && "needs libvpx-vp9") },
  async () => {
    const file = join(dir, "clip.webm");
    ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "2", "-c:v", "libvpx-vp9", "-deadline", "realtime", file);
    const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
    try {
      const track = (await input.getPrimaryVideoTrack())!;
      assert.match((await track.getDecoderConfig())!.codec, /^vp09\./);
    } finally {
      input.dispose();
    }
  },
);

test("D311: the decoder's colour space fills in what the file leaves out as Chromium's <video> reads it", () => {
  assert.deepEqual(namedColour({}, 360), { matrix: "smpte170m", primaries: "smpte170m", transfer: "smpte170m", fullRange: false });
  assert.deepEqual(namedColour({ fullRange: false }, 1080), { matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: false });
  assert.deepEqual(namedColour({ matrix: "bt470bg", fullRange: true }, 1080), {
    matrix: "bt470bg",
    primaries: "smpte170m",
    transfer: "bt709",
    fullRange: true,
  });
  assert.deepEqual(namedColour({ primaries: "bt709", transfer: "bt709", matrix: "bt709" }, 480), {
    matrix: "bt709",
    primaries: "bt709",
    transfer: "bt709",
    fullRange: false,
  });
});
