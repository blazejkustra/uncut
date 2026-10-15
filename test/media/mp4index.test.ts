// D221: the scrub cache's MP4/MOV sample table (packages/core/src/media/mp4index.ts) against ffprobe.
// For H.264 with B-frames (an edit list shifting the first frame to 0), HEVC long-GOP (hvc1), a moov
// after the mdat, a .mov, and (when it's on this Mac) the DJI 4K60 HEVC drone clip, read-only:
// every packet's byte offset, size, keyframe flag and presentation time match ffprobe's, and
// sampleAt picks the frame shown at a time the way <video> does (the last pts at or before it).
// Codec strings for WebCodecs; fragmented and non-ISO files have no index.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readSync, closeSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { avcCodec, hevcCodec, keyframeOf, readMp4Index, sampleAt, type Mp4Index } from "../../packages/core/src/media/mp4index.ts";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const encoders = hasFfmpeg ? execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }) : "";
const skip = hasFfmpeg ? false : "needs ffmpeg";
const DRONE = join(process.env.HOME ?? "", "Documents/devrel/drone/DJI_20261010132228_0005_D.MP4");
let dir = "";
const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

before(() => {
  dir = mkdtempSync(join(tmpdir(), "uncut-mp4index-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** A file's bytes through the same ReadAt the renderer gives a Range fetch. */
async function indexOf(file: string) {
  const fd = openSync(file, "r");
  try {
    const read = async (offset: number, length: number) => {
      const buf = Buffer.alloc(length);
      const n = readSync(fd, buf, 0, length, offset);
      return new Uint8Array(buf.buffer, buf.byteOffset, n);
    };
    return await readMp4Index(read, statSync(file).size);
  } finally {
    closeSync(fd);
  }
}

type Packet = { pts: number; pos: number; size: number; key: boolean };
const packets = (file: string): Array<Packet> =>
  (JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,pos,size,flags", "-of", "json", file], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })).packets as Array<{ pts_time: string; pos: string; size: string; flags: string }>).map((p) => ({
    pts: Number(p.pts_time),
    pos: Number(p.pos),
    size: Number(p.size),
    key: p.flags.includes("K"),
  }));

/** Every sample matches ffprobe's packet (decode order): offset, size, keyframe, pts. */
function matchesFfprobe(index: Mp4Index, file: string) {
  const ps = packets(file);
  assert.equal(index.sizes.length, ps.length, "sample count");
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    assert.equal(index.offsets[i], p.pos, `offset of ${i}`);
    assert.equal(index.sizes[i], p.size, `size of ${i}`);
    assert.equal(index.key[i] === 1, p.key, `keyframe flag of ${i}`);
    assert.ok(Math.abs(index.pts[i]! - p.pts) < 1e-4, `pts of ${i}: ${index.pts[i]} vs ffprobe ${p.pts}`);
  }
}

/** The frames ffmpeg decodes, in presentation order (best_effort pts). */
const framePts = (file: string) =>
  (JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "json", file], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })).frames as Array<{ pts_time: string }>).map((f) => Number(f.pts_time));

test("D221: H.264 with B-frames: offsets, sizes, keyframes and pts match ffprobe; sampleAt picks the shown frame", { skip }, async () => {
  const file = join(dir, "bframes.mp4");
  ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "4", "-c:v", "libx264", "-bf", "3", "-g", "45", "-pix_fmt", "yuv420p", file);
  const index = (await indexOf(file))!;
  assert.ok(index, "indexed");
  assert.match(index.codec, /^avc1\.64/, "High profile codec string");
  assert.equal(index.codedWidth, 640);
  assert.equal(index.codedHeight, 360);
  matchesFfprobe(index, file);
  // ffmpeg writes the moov last by default (no faststart), and an edit list for the B-frame delay: the first shown frame is at 0.
  const shown = framePts(file);
  assert.equal(shown[0], 0);
  for (let f = 0; f < shown.length; f++) {
    const s = sampleAt(index, f / 30 + 0.0001);
    assert.ok(Math.abs(index.pts[s]! - shown[f]!) < 1e-4, `frame ${f}: sample pts ${index.pts[s]} vs ${shown[f]}`);
    assert.equal(index.key[keyframeOf(index, s)], 1);
    assert.ok(keyframeOf(index, s) <= s);
  }
  // Before the first frame: the first frame; past the end: the last.
  assert.equal(index.pts[sampleAt(index, -1)], 0);
  assert.ok(Math.abs(index.pts[sampleAt(index, 99)]! - shown.at(-1)!) < 1e-4);
});

test("D221: HEVC long-GOP (hvc1), a moov after the mdat, and a .mov are indexed like ffprobe reads them", { skip }, async () => {
  const hevc = join(dir, "hevc.mp4");
  const hevcEncoder = /\bhevc_videotoolbox\b/.test(encoders) ? ["-c:v", "hevc_videotoolbox", "-b:v", "6M"] : ["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error"];
  ff("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "5", ...hevcEncoder, "-g", "60", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", hevc);
  const h = (await indexOf(hevc))!;
  assert.ok(h, "HEVC indexed");
  assert.match(h.codec, /^hvc1\.1\.6\.L\d+/, `HEVC Main codec string: ${h.codec}`);
  matchesFfprobe(h, hevc);
  assert.equal([...h.key].filter(Boolean).length, Math.ceil(150 / 60), "a keyframe every 60 frames");

  const late = join(dir, "moov-last.mp4");
  ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-t", "3", "-c:v", "libx264", "-bf", "0", "-g", "10", "-pix_fmt", "yuv420p", late);
  const l = (await indexOf(late))!;
  assert.ok(l, "moov at the end indexed");
  matchesFfprobe(l, late);

  const mov = join(dir, "clip.mov");
  ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", mov);
  const m = (await indexOf(mov))!;
  assert.ok(m, "mov indexed");
  matchesFfprobe(m, mov);
});

test("D221: a turned track (phone footage) records its clockwise turn, as ffprobe's display matrix", { skip }, async () => {
  const flat = join(dir, "flat.mp4");
  ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", flat);
  assert.equal((await indexOf(flat))!.rotation, 0);
  for (const turn of [90, 180, 270]) {
    const file = join(dir, `turned-${turn}.mp4`);
    // -display_rotation is counter-clockwise (ffprobe's "rotation"); a phone held upright is -90 there, 90 clockwise.
    ff("-display_rotation", String(-turn), "-i", flat, "-c", "copy", file);
    const side = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream_side_data=rotation", "-of", "csv=p=0", file], { encoding: "utf8" }).trim();
    assert.equal((((-Number(side)) % 360) + 360) % 360, turn, `ffprobe reads ${side}`);
    assert.equal((await indexOf(file))!.rotation, turn, `${turn}° clockwise`);
  }
});

/** ffprobe's colour fields of the first video stream. */
const ffColour = (file: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_space,color_primaries,color_transfer,color_range", "-of", "json", file], { encoding: "utf8" })).streams[0] as { color_space?: string; color_primaries?: string; color_transfer?: string; color_range?: string };
const MATRIX: Record<number, string> = { 0: "gbr", 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020nc" };
const PRIMARIES: Record<number, string> = { 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020" };
const TRANSFER: Record<number, string> = { 1: "bt709", 6: "smpte170m", 13: "iec61966-2-1", 16: "smpte2084", 18: "arib-std-b67", 14: "bt2020-10" };
function sameColour(index: Mp4Index, file: string, label: string) {
  const f = ffColour(file);
  const c = index.colour!;
  assert.ok(c, `${label}: the SPS parsed`);
  const name = (table: Record<number, string>, v: number | undefined) => (v === undefined ? undefined : (table[v] ?? `code ${v}`));
  const known = (v: string | undefined) => (v === undefined || v === "unknown" ? undefined : v);
  assert.equal(name(MATRIX, c.matrix), known(f.color_space), `${label}: matrix`);
  assert.equal(name(PRIMARIES, c.primaries), known(f.color_primaries), `${label}: primaries`);
  assert.equal(name(TRANSFER, c.transfer), known(f.color_transfer), `${label}: transfer`);
  assert.equal(c.fullRange === undefined ? undefined : c.fullRange ? "pc" : "tv", known(f.color_range), `${label}: range`);
}

test("D221: the colour description (colr box, else the SPS's VUI) matches ffprobe's; footage that says nothing has none", { skip }, async () => {
  const src = ["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-t", "1"];
  const cases: Array<[string, Array<string>]> = [
    ["untagged.mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p"]],
    ["bt709.mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]],
    ["full.mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-color_range", "pc"]],
    ["bt470bg.mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-colorspace", "bt470bg", "-color_primaries", "bt470bg", "-color_trc", "smpte170m"]],
    ["high10-scaling.mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p10le", "-x264-params", "cqm=jvt", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]],
    ["hevc709.mp4", [...(/\blibx265\b/.test(encoders) ? ["-c:v", "libx265", "-x265-params", "log-level=error"] : ["-c:v", "hevc_videotoolbox"]), "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]],
    ["hevc-untagged.mp4", [...(/\blibx265\b/.test(encoders) ? ["-c:v", "libx265", "-x265-params", "log-level=error"] : ["-c:v", "hevc_videotoolbox"]), "-tag:v", "hvc1", "-pix_fmt", "yuv420p"]],
  ];
  for (const [name, args] of cases) {
    const file = join(dir, name);
    ff(...src, ...args, file);
    sameColour((await indexOf(file))!, file, name);
  }
  assert.deepEqual((await indexOf(join(dir, "untagged.mp4")))!.colour, {}, "says nothing");
  // Tags only in the container (a colr box over an untagged stream): the container's count.
  const boxed = join(dir, "boxed.mov");
  ff("-i", join(dir, "untagged.mp4"), "-c", "copy", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-movflags", "+write_colr", boxed);
  const b = (await indexOf(boxed))!;
  assert.equal(b.colour?.matrix, 1, `colr read: ${JSON.stringify(b.colour)}`);
  sameColour(b, boxed, "boxed.mov");
});

test("D221: fragmented MP4, other codecs and non-ISO files have no index (the preview keeps <video>)", { skip }, async () => {
  const frag = join(dir, "frag.mp4");
  ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-t", "2", "-c:v", "libx264", "-movflags", "frag_keyframe+empty_moov", "-pix_fmt", "yuv420p", frag);
  assert.equal(await indexOf(frag), undefined, "fragmented");
  const mjpeg = join(dir, "mjpeg.mov");
  ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-t", "1", "-c:v", "mjpeg", mjpeg);
  assert.equal(await indexOf(mjpeg), undefined, "MJPEG");
  const webm = join(dir, "clip.webm");
  ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-t", "1", "-c:v", "libvpx", webm);
  assert.equal(await indexOf(webm), undefined, "WebM");
  const junk = join(dir, "junk.mp4");
  execFileSync("/bin/sh", ["-c", `head -c 5000 /dev/urandom > ${JSON.stringify(junk)}`]);
  assert.equal(await indexOf(junk), undefined, "random bytes");
});

test("D221: codec strings from avcC and hvcC records", () => {
  assert.equal(avcCodec(new Uint8Array([1, 0x64, 0x00, 0x28, 0xff])), "avc1.640028");
  assert.equal(avcCodec(new Uint8Array([0, 0x64, 0x00, 0x28])), undefined);
  // Main profile, compatibility flags 0x60000000 (Main, Main 10), Main tier, level 3.1 (93), progressive + frame-only constraint bits.
  const hvcc = new Uint8Array([1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 93, 0xf0]);
  assert.equal(hevcCodec(hvcc, "hvc1"), "hvc1.1.6.L93.90");
  // Main 10, high tier, level 5.1 (153).
  const main10 = new Uint8Array([1, 0x22, 0x20, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 153, 0xf0]);
  assert.equal(hevcCodec(main10, "hev1"), "hev1.2.4.H153.B0");
});

test("D221: the DJI 4K60 HEVC drone clip (read-only) matches ffprobe", { skip: !hasFfmpeg ? "needs ffmpeg" : existsSync(DRONE) ? false : "drone footage not on this Mac" }, async () => {
  const index = (await indexOf(DRONE))!;
  assert.ok(index, "indexed");
  assert.match(index.codec, /^hvc1\.2\./, `Main 10: ${index.codec}`);
  matchesFfprobe(index, DRONE);
  sameColour(index, DRONE, "drone");
});
