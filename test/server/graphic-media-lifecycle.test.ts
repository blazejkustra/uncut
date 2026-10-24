// D290 review fixes: the media pictures graphics draw (apps/server/src/export/graphicMedia.ts and
// its readers) under load, on variable-rate footage and around close.
// - 8 sizes at once (more than its 4 decoders): all resolve, one decoder each (a busy decoder is
//   waited for, never stopped: that used to respawn ffmpeg in a loop), and nothing starts after close;
// - one file and size asked for far-apart frames at once: they take turns, a bounded number of starts;
// - a variable-rate file: the frame for t is the one a clip shows at that source time
//   (sourceFramePick), whether the source seeks to it fresh or reads on to it;
// - file(): a new file per answer (100 at once all hold their own picture; the old ring of 64 was
//   rewritten while read), none after close; the rasteriser's reader removes each once read;
// - the preview route's shared source closes when idle and when the project changes;
// - a graphic's frame may only navigate to a graphic document of the connected server, and only
//   messages from the opaque origin of a compositor iframe are media requests.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GRAPHIC_PATH as CONTRACTS_GRAPHIC_PATH } from "../../packages/contracts/src/media.ts";
import type { Media } from "../../packages/core/src/index.ts";
import { graphicMediaSource, type GraphicMediaSource } from "../../apps/server/src/export/graphicMedia.ts";
import { previewSource } from "../../apps/server/src/export/graphicMediaRoute.ts";
import { sourceFramePick, untaggedFilter } from "../../apps/server/src/export/exportPlan.ts";
import { handleMedia, takeMediaReply } from "../../apps/desktop/src/renderMedia.ts";
import { allowFrameNavigation, GRAPHIC_PATH } from "../../apps/desktop/src/permissions.ts";
import { graphicMediaAsk } from "../../apps/web/src/preview/graphicMessage.ts";

const which = (name: string) => spawnSync("which", [name], { encoding: "utf8" }).stdout.trim();
const bin = which("ffmpeg");
const skip = bin ? false : "needs ffmpeg";

let dir: string;
let clip: string;
let vfr: string;
const sources: Array<GraphicMediaSource> = [];
const make = (media: Array<Media>) => {
  const s = graphicMediaSource({ bin, media: () => media, mediaPath: (m) => m.path });
  sources.push(s);
  return s;
};
const clipMedia = (): Array<Media> => [{ id: "clip", kind: "video", name: "clip.mp4", path: clip }];
const vfrMedia = (): Array<Media> => [{ id: "vfr", kind: "video", name: "vfr.mp4", path: vfr }];
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

before(() => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "uncut-gm-lifecycle-"));
  clip = join(dir, "clip.mp4");
  // 6 s at 30 fps, every frame different, a keyframe every second.
  const r = spawnSync(bin, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30",
    "-t",
    "6",
    "-c:v",
    "libx264",
    "-g",
    "30",
    "-pix_fmt",
    "yuv420p",
    clip,
  ]);
  assert.equal(r.status, 0, String(r.stderr));
  // Variable rate: frames 0–20 at n/30, then a third of a second missing (frame 21 at 31/30 s), each
  // frame's brightness its number × 7 (mod 256), lossless.
  vfr = join(dir, "vfr.mp4");
  const v = spawnSync(bin, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "nullsrc=s=64x64:r=30",
    "-frames:v",
    "60",
    "-vf",
    "geq=lum='mod(N*7,256)':cb=128:cr=128,setpts='(N+10*gt(N,20))/30/TB'",
    "-fps_mode",
    "passthrough",
    "-c:v",
    "libx264",
    "-qp",
    "0",
    "-g",
    "15",
    "-pix_fmt",
    "yuv420p",
    vfr,
  ]);
  assert.equal(v.status, 0, String(v.stderr));
});

after(() => {
  for (const s of sources) s.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("8 sizes at once: all resolve, one decoder each; close stops everything, nothing starts after", { skip, timeout: 60000 }, async () => {
  const source = make(clipMedia());
  const t0 = Date.now();
  const ps = await Promise.all(Array.from({ length: 8 }, (_, i) => source.picture({ id: "clip", t: 2.5, w: 100 + 2 * i })));
  assert.equal(ps.length, 8);
  assert.ok(Date.now() - t0 < 20000, "in good time");
  assert.equal(source.starts(), 8, "one decoder per size: a busy decoder is never stopped for another");
  // Again, consecutive frames: still bounded (each size starts at most one more after an eviction).
  await Promise.all(Array.from({ length: 8 }, (_, i) => source.picture({ id: "clip", t: 2.5 + 1 / 30, w: 100 + 2 * i })));
  assert.ok(source.starts() <= 16, `bounded: ${source.starts()} starts`);
  // In flight at close: asked, then closed at once.
  const late = Array.from({ length: 8 }, (_, i) =>
    source.file({ id: "clip", t: 4, w: 200 + 2 * i }).then(
      () => "ok",
      (e: Error) => e.message,
    ),
  );
  source.close();
  const results = await Promise.all(late);
  assert.ok(
    results.every((r) => r.endsWith("closed")),
    `in-flight requests end with "closed": ${results.join(", ")}`,
  );
  const after = source.starts();
  await sleep(1500);
  assert.equal(source.starts(), after, "no decoder starts after close");
  await assert.rejects(source.picture({ id: "clip", t: 1 }), /closed/);
});

test("one size asked for far-apart frames at once takes turns: a bounded number of starts", { skip, timeout: 60000 }, async () => {
  const source = make(clipMedia());
  const times = [0.2, 5.5, 0.3, 5.0, 1.0, 4.0, 0.5, 3.0];
  const ps = await Promise.all(times.map((t) => source.picture({ id: "clip", t })));
  assert.deepEqual(
    ps.map((p) => p.frame),
    times.map((t) => Math.floor(t * 30 + 1e-6)),
  );
  assert.ok(source.starts() <= times.length, `at most one start per request: ${source.starts()}`);
  source.close();
});

/** The frame a clip of the VFR file shows at source time t (sourceFramePick), 64×64 bgr24. */
function clipFrame(t: number): Buffer {
  const pick = sourceFramePick(t, 30);
  const r = spawnSync(bin, [
    "-v",
    "error",
    ...pick.seekArgs,
    "-i",
    vfr,
    "-vf",
    `${untaggedFilter(64)}${pick.filter},scale=w=64:h=64:flags=bicubic,format=bgr24`,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "bgr24",
    "pipe:1",
  ]);
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
}
/** The bgr24 pixels of a top-down 24-bit BMP. */
const pixels = (bmp: Buffer) => {
  const w = bmp.readInt32LE(18);
  const h = -bmp.readInt32LE(22);
  const stride = (w * 3 + 3) & ~3;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) bmp.copy(raw, y * w * 3, 54 + y * stride, 54 + y * stride + w * 3);
  return raw;
};
const meanDiff = (a: Buffer, b: Buffer) => {
  assert.equal(a.length, b.length);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
};

test("a variable-rate file: the frame at t is a clip's at that source time, sought fresh or read on to", { skip, timeout: 60000 }, async () => {
  // 1.0 s falls in the gap after frame 20 (0.667 s; frame 21 starts at 1.033 s): frame 20, not 25 or 30.
  for (const t of [1.0, 0.95, 31 / 30, 1.5, 2.2]) {
    const fresh = make(vfrMedia());
    const a = await fresh.picture({ id: "vfr", t });
    fresh.close();
    const walk = make(vfrMedia());
    let b = await walk.picture({ id: "vfr", t: 0 });
    for (let s = 1 / 30; s < t; s += 1 / 30) b = await walk.picture({ id: "vfr", t: s });
    b = await walk.picture({ id: "vfr", t });
    walk.close();
    assert.equal(a.frame, b.frame, `t ${t}: fresh and read-on agree (${a.frame} vs ${b.frame})`);
    assert.ok(meanDiff(pixels(a.bytes), pixels(b.bytes)) < 0.01, `t ${t}: same picture`);
    assert.ok(meanDiff(pixels(a.bytes), clipFrame(t)) < 0.5, `t ${t}: the clip's frame at that time`);
  }
  const s = make(vfrMedia());
  assert.equal((await s.picture({ id: "vfr", t: 1.0 })).frame, 20);
  assert.equal((await s.picture({ id: "vfr", t: 31 / 30 })).frame, 21);
  s.close();
});

test("file(): 100 at once each hold their own picture; the reader removes each once read", { skip, timeout: 120000 }, async () => {
  const source = make(clipMedia());
  const asks = Array.from({ length: 100 }, (_, i) => ({ id: "clip", t: (i % 50) / 30 + (i >= 50 ? 3 : 0), w: 64 }));
  const files = await Promise.all(asks.map((a) => source.file(a)));
  assert.equal(new Set(files.map((f) => f.file)).size, 100, "a file each");
  for (const [i, f] of files.entries()) assert.deepEqual(readFileSync(f.file), (await source.picture(asks[i]!)).bytes, `file ${i} holds its own frame`);
  source.close();
  assert.ok(!existsSync(files[0]!.file), "close removes the rest");

  // The rasteriser's side (apps/desktop renderMedia.ts): the answer's file is read, then removed.
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const sent: Array<{ media: { sub: number } }> = [];
  handleMedia(
    { handle: (_scheme: string, fn: (request: Request) => Promise<Response>) => void (handler = fn) } as never,
    (msg) => void sent.push(msg as { media: { sub: number } }),
  );
  const file = join(dir, "answer.bmp");
  writeFileSync(file, Buffer.from("picture"));
  const response = handler!(new Request("uncut-media://media/clip?t=1"));
  await sleep(10);
  assert.equal(sent.length, 1);
  assert.equal(takeMediaReply({ mediaReply: sent[0]!.media.sub, file, type: "image/bmp" }), true);
  const r = await response;
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "picture");
  await sleep(50);
  assert.ok(!existsSync(file), "removed once read");
});

test("the preview's shared source closes when idle and when the project changes, never mid-request", async () => {
  const made: Array<{ dir: string; closed: number }> = [];
  const fake = async (d: string) => {
    const rec = { dir: d, closed: 0 };
    made.push(rec);
    return {
      picture: async () => ({ bytes: Buffer.alloc(1), type: "image/png" as const, width: 1, height: 1 }),
      file: async () => ({ file: "", type: "" }),
      close: () => void rec.closed++,
      starts: () => 0,
    };
  };
  const preview = previewSource(fake, 80);
  await preview.use("/a", "ffmpeg", [], async (s) => {
    await sleep(150);
    return s.picture({ id: "x", t: 0 });
  });
  assert.equal(made[0]!.closed, 0, "not closed while a request was in flight");
  assert.ok(preview.open());
  await sleep(150);
  assert.equal(made[0]!.closed, 1, "closed once idle");
  assert.ok(!preview.open());
  await preview.use("/a", "ffmpeg", [], (s) => s.picture({ id: "x", t: 0 }));
  await preview.use("/b", "ffmpeg", [], (s) => s.picture({ id: "x", t: 0 }));
  assert.equal(made[1]!.closed, 1, "another project: the old source closed");
  assert.equal(made[2]!.dir, "/b");
  preview.close();
  await sleep(0);
  assert.equal(made[2]!.closed, 1);
});

test("a graphic's frame navigates only to the connected server's graphic documents; only its opaque-origin messages are asked", () => {
  assert.equal(GRAPHIC_PATH, CONTRACTS_GRAPHIC_PATH);
  const server = "http://127.0.0.1:4321";
  assert.equal(allowFrameNavigation(`${server}/media/graphic/intro.html?k=secret`, server), true);
  for (const url of [
    "https://evil.example/?frame=data:image/bmp;base64,AAAA",
    "http://127.0.0.1:9999/media/graphic/intro.html",
    `${server}/media/file/clip?token=x`,
    `${server}/media/graphicx`,
    "http://user:pw@127.0.0.1:4321/media/graphic/a.html",
    "data:text/html,<p>hi",
    "about:blank",
    "javascript:alert(1)",
    "not a url",
  ])
    assert.equal(allowFrameNavigation(url, server), false, url);
  assert.equal(allowFrameNavigation(`${server}/media/graphic/a.html`, undefined), false, "no server yet: nothing");

  const frame = {};
  const other = {};
  const data = { uncut: "media", seq: 1, id: "clip", t: 1 };
  assert.ok(graphicMediaAsk({ origin: "null", data, source: frame }, [frame]));
  assert.equal(graphicMediaAsk({ origin: "https://evil.example", data, source: frame }, [frame]), undefined, "a frame navigated elsewhere");
  assert.equal(graphicMediaAsk({ origin: "null", data, source: other }, [frame]), undefined, "not a graphic's iframe");
  assert.equal(graphicMediaAsk({ origin: "null", data, source: null }, [frame]), undefined);
  assert.equal(graphicMediaAsk({ origin: "null", data: { uncut: "render" }, source: frame }, [frame]), undefined);
});
