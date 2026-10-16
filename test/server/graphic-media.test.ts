// D290: the pictures of project media that graphics draw (apps/server/src/export/graphicMedia.ts),
// on a generated clip (testsrc2: every frame differs) and a generated PNG.
// - the frame for t is the one a clip of that media shows at that source time in the export
//   (exportPlan sourceFramePick), at n / fps exactly and between frames;
// - consecutive frames come from one decoder (read on, not seek); a jump back starts another, and
//   still gives the right frame;
// - sizes: at most 1920 long, smaller to fit a box, aspect kept, even;
// - unknown ids, audio, past the end (the last frame), an image (PNG with alpha);
// - the request parser and the markers the agent's HTML names (core graphicMedia.ts).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GRAPHIC_CSP, graphicDocument, graphicMediaFrame, graphicMediaSize, graphicMediaUsed, parseGraphicMediaRequest, type Media } from "../../packages/core/src/index.ts";
import { bmpOf, graphicMediaSource, type GraphicMediaSource } from "../../apps/server/src/export/graphicMedia.ts";
import { sourceFramePick, untaggedFilter } from "../../apps/server/src/export/exportPlan.ts";

const which = (name: string) => spawnSync("which", [name], { encoding: "utf8" }).stdout.trim();
const bin = which("ffmpeg");
const skip = bin ? false : "needs ffmpeg";

let dir: string;
let source: GraphicMediaSource;
const media: Array<Media> = [];

before(() => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "uncut-graphic-media-"));
  const clip = join(dir, "clip.mp4");
  // 4 s at 30 fps, 320×180, a keyframe every second (so a seek decodes from one).
  const r = spawnSync(bin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "4", "-c:v", "libx264", "-g", "30", "-pix_fmt", "yuv420p", clip]);
  assert.equal(r.status, 0, String(r.stderr));
  const png = join(dir, "still.png");
  const p = spawnSync(bin, ["-v", "error", "-f", "lavfi", "-i", "color=c=red@0.5:size=200x100,format=rgba", "-frames:v", "1", png]);
  assert.equal(p.status, 0, String(p.stderr));
  media.push({ id: "clip", kind: "video", name: "clip.mp4", path: clip }, { id: "still", kind: "image", name: "still.png", path: png }, { id: "song", kind: "audio", name: "song.m4a", path: join(dir, "song.m4a") });
  source = graphicMediaSource({ bin, media: () => media, mediaPath: (m) => m.path });
});

after(() => {
  if (skip) return;
  source?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The bgr24 pixels of our top-down 24-bit BMP. */
function pixelsOf(bmp: Buffer): { width: number; height: number; raw: Buffer } {
  assert.equal(bmp.toString("ascii", 0, 2), "BM");
  const width = bmp.readInt32LE(18);
  const height = -bmp.readInt32LE(22);
  const stride = (width * 3 + 3) & ~3;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) bmp.copy(raw, y * width * 3, 54 + y * stride, 54 + y * stride + width * 3);
  return { width, height, raw };
}

/** The frame a clip at source time t shows in the export (sourceFramePick; the clip is untagged, 180 lines, as the export reads it), at width × height, bgr24. */
function exportFrame(t: number, width: number, height: number): Buffer {
  const pick = sourceFramePick(t, 30);
  const r = spawnSync(bin, ["-v", "error", ...pick.seekArgs, "-i", media[0]!.path, "-vf", `${untaggedFilter(180)}${pick.filter},scale=w=${width}:h=${height}:flags=bicubic,format=bgr24`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
}

const meanDiff = (a: Buffer, b: Buffer) => {
  assert.equal(a.length, b.length);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
};

test("core: sizes, frame grid, request parsing, markers, CSP", () => {
  assert.deepEqual(graphicMediaSize(3840, 2160), { width: 1920, height: 1080 });
  assert.deepEqual(graphicMediaSize(3840, 2160, { w: 800 }), { width: 800, height: 450 });
  assert.deepEqual(graphicMediaSize(1080, 1920, { h: 961 }), { width: 540, height: 962 });
  assert.deepEqual(graphicMediaSize(640, 360, { w: 4000 }), { width: 640, height: 360 }, "never larger than the media");
  assert.equal(graphicMediaFrame(0, 30), 0);
  assert.equal(graphicMediaFrame(1 / 30, 30), 1, "n / fps is frame n despite rounding");
  assert.equal(graphicMediaFrame(7 / 30, 30), 7);
  assert.equal(graphicMediaFrame(0.049, 30), 1);
  assert.equal(graphicMediaFrame(100, 30, 120), 119, "within the frames");
  const q = (s: string) => new URLSearchParams(s);
  assert.deepEqual(parseGraphicMediaRequest("abc-1", q("t=1.5&w=640")), { id: "abc-1", t: 1.5, w: 640 });
  assert.ok("problem" in parseGraphicMediaRequest("../x", q("")));
  assert.ok("problem" in parseGraphicMediaRequest("a", q("t=-1")));
  assert.ok("problem" in parseGraphicMediaRequest("a", q("w=0")));
  assert.ok("problem" in parseGraphicMediaRequest("a", q("h=1.5")));
  assert.deepEqual(graphicMediaUsed(`<img src="uncut:media/d1#t=2.5"><div style="background:url('uncut:media/p-2')"></div><script>const f = await uncut.frame("d1", t); uncut.image('logo_3'); uncut.frame(id, 1)</script>`), ["d1", "p-2", "logo_3"]);
  // The CSP: still nothing from the network; the media scheme for fetches, blob: images.
  assert.match(GRAPHIC_CSP, /default-src 'none'/);
  assert.match(GRAPHIC_CSP, /connect-src uncut-media:(;|$)/);
  assert.match(GRAPHIC_CSP, /img-src data: blob:;/);
  assert.doesNotMatch(GRAPHIC_CSP, /https?:|\*/);
  const doc = graphicDocument("<p>x</p>", { width: 10, height: 10 });
  assert.ok(doc.indexOf("window.uncut") < doc.indexOf("<p>x</p>"), "the helper is in <head>, before the author's markup");
  assert.match(doc, /__uncutMedia\.ready\(\)/);
});

test("bmpOf pads rows to 4 bytes and is top-down", () => {
  const raw = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]); // 3×2
  const bmp = bmpOf(raw, 3, 2);
  assert.equal(bmp.length, 54 + 12 * 2);
  assert.deepEqual(pixelsOf(bmp).raw, raw);
});

test("a video's frame at t is the export's frame at that source time; consecutive frames read on", { skip, timeout: 60000 }, async () => {
  const W = 320;
  const H = 180;
  const starts = source.starts();
  // Forward, on and between the grid, then a jump back and a far jump ahead.
  const times = [0, 1 / 30, 2 / 30, 0.1, 0.12, 0.2, 0.5, 0.517, 1.0, 0.25, 3.5, 3.9];
  for (const t of times) {
    const p = await source.picture({ id: "clip", t });
    assert.equal(p.type, "image/bmp");
    const { width, height, raw } = pixelsOf(p.bytes);
    assert.deepEqual([width, height], [W, H]);
    assert.equal(p.frame, graphicMediaFrame(t, 30), `t ${t}`);
    const same = meanDiff(raw, exportFrame(t, W, H));
    const next = meanDiff(raw, exportFrame((graphicMediaFrame(t, 30) + 1) / 30, W, H));
    assert.ok(same < 0.5, `t ${t}: the export's frame (mean diff ${same.toFixed(3)})`);
    assert.ok(next > same + 1, `t ${t}: not the next one (${next.toFixed(3)} vs ${same.toFixed(3)})`);
  }
  // 0 → 0.517 read on in one decoder, 0.25 (back) and 3.5 (far ahead) started others; 3.9 read on.
  assert.equal(source.starts() - starts, 3, "one decoder for the forward run, one per jump");
  // The same frame again: from the cache, byte for byte.
  const a = await source.picture({ id: "clip", t: 0.5 });
  const b = await source.picture({ id: "clip", t: 0.5 + 0.001 });
  assert.equal(a.bytes, b.bytes);
});

test("sizes, past the end, a still, unknown ids and sounds", { skip, timeout: 60000 }, async () => {
  const small = await source.picture({ id: "clip", t: 1, w: 100 });
  assert.deepEqual([small.width, small.height], [100, 56]);
  assert.deepEqual([pixelsOf(small.bytes).width, pixelsOf(small.bytes).height], [100, 56]);
  const end = await source.picture({ id: "clip", t: 60 });
  assert.equal(end.frame, 119, "past the end: the last frame");
  const still = await source.picture({ id: "still", t: 3 });
  assert.equal(still.type, "image/png");
  assert.deepEqual([still.width, still.height], [200, 100]);
  // A PNG with its alpha (colour type 6: RGBA).
  assert.equal(still.bytes.readUInt8(25), 6);
  await assert.rejects(source.picture({ id: "nope", t: 0 }), /no media nope/);
  await assert.rejects(source.picture({ id: "song", t: 0 }), /a sound, not a picture/);
  const f = await source.file({ id: "clip", t: 2 });
  assert.match(f.file, /\.bmp$/);
  assert.equal(f.type, "image/bmp");
});
