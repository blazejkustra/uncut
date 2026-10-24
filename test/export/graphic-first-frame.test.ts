// A graphic's slow first frame (round 10's A2r10b, A2-noskill): its setup fetched 18 footage
// thumbnails one after another (await uncut.frame in a loop, ~330 ms each from 4K HEVC), about 6 s,
// and failed "took longer than 5 s ... at 0.00 s" although pictures kept coming: the deadline only
// waited while a request was in flight, and a sequential loop has none for the ms between one
// answer and its next ask. Through the real rasteriser with a slow media source:
// - a first frame fetching pictures one after another past 5 s draws, and the next frame is fast;
// - a script that never yields still fails within about the 5 s frame deadline, and says so;
// - a render(t) waiting on a promise that never settles fails at 5 s, naming that, not media.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { graphicDocument, graphicInfo } from "../../packages/core/src/index.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../../apps/server/src/export/rasterizer.ts";

const DESKTOP = process.env.UNCUT_TEST_DESKTOP ?? resolve("apps/desktop/dist/main.cjs");
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : false;

const canvas = { width: 320, height: 180, fps: 30 };
// A 2×2 red PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwGMgRQAH+4D/dJQfRoAAAAASUVORK5CYII=", "base64");
const PICTURE_MS = 250;
// The page's own work on each picture (decode, draw, re-encode) between one answer and the next ask.
const WORK_MS = 120;
const PICTURES = 20;

// Its first frame fetches PICTURES thumbnails one after another (each drawn and re-encoded, as the
// round's films did, with WORK_MS of the page's own work: the gap between requests a deadline
// sampling in-flight requests lands in), then draws them; later frames reuse them.
const THUMBS = `<canvas id="c" width="320" height="180"></canvas><script>
let thumbs;
async function setup() {
  const out = [];
  for (let i = 0; i < ${PICTURES}; i++) {
    const f = await uncut.frame("clip", i * 0.5, { width: 64 });
    const c = document.createElement("canvas"); c.width = f.width; c.height = f.height;
    c.getContext("2d").drawImage(f, 0, 0);
    out.push(c.toDataURL("image/jpeg", 0.8));
    const until = performance.now() + ${WORK_MS};
    while (performance.now() < until);
  }
  return out;
}
window.render = async (t) => {
  thumbs ??= setup();
  const urls = await thumbs;
  const g = document.getElementById("c").getContext("2d");
  g.fillStyle = urls.length === ${PICTURES} ? "rgb(0,255,0)" : "rgb(0,0,255)";
  g.fillRect(0, 0, 320, 180);
};
</script>`;

let root: string;
let raster: Rasterizer;
let asked = 0;

before(async () => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), "uncut-graphic-first-frame-"));
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  // A slow source (a cold 4K decoder's pace): each picture a new file, as the server's are.
  raster = await startRasterizer(command, undefined, {
    media: async () => {
      const file = join(root, `p-${++asked}.png`);
      await new Promise((done) => setTimeout(done, PICTURE_MS));
      writeFileSync(file, PNG);
      return { file, type: "image/png" };
    },
  });
});

after(async () => {
  if (skip) return;
  await raster?.close();
  rmSync(root, { recursive: true, force: true });
});

const frame = (html: string, t: number, name: string) =>
  raster.render({
    kind: "graphic",
    width: canvas.width,
    height: canvas.height,
    doc: graphicDocument(html, canvas),
    t,
    info: graphicInfo({ duration: 60, props: {} }, canvas, Math.round(t * canvas.fps)),
    out: join(root, `${name}-${t}.png`),
    name,
  });

test("a first frame fetching its pictures one after another past 5 s draws; the next frame is fast", { skip, timeout: 60000 }, async () => {
  const t0 = Date.now();
  await frame(THUMBS, 0, "thumbs");
  const first = Date.now() - t0;
  console.log(`  first frame: ${first} ms, ${asked} pictures`);
  assert.equal(asked, PICTURES);
  assert.ok(first > 5000, `the setup takes longer than the 5 s frame deadline (${first} ms), or this test shows nothing`);
  const t1 = Date.now();
  await frame(THUMBS, 0.5, "thumbs");
  assert.ok(Date.now() - t1 < 3000, `the next frame reuses them (${Date.now() - t1} ms)`);
  assert.equal(asked, PICTURES, "no picture asked again");
});

test("a script that never yields still fails at the frame deadline, naming it", { skip, timeout: 60000 }, async () => {
  const t0 = Date.now();
  await assert.rejects(frame("<script>while (true) {}</script>", 0, "stuck"), (e: Error) => {
    assert.match(
      e.message,
      /stuck: the graphic took longer than 5 s to load and draw a frame at 0\.00 s \(its first frame, the document just loaded\): its script never yielded/,
    );
    return true;
  });
  assert.ok(Date.now() - t0 < 8000, `failed in ${Date.now() - t0} ms`);
});

test("a render(t) waiting on a promise that never settles fails at 5 s, not blamed on media", { skip, timeout: 60000 }, async () => {
  const t0 = Date.now();
  await assert.rejects(frame("<script>window.render = () => new Promise(() => {});</script>", 1, "hang"), (e: Error) => {
    assert.match(
      e.message,
      /hang: the graphic took longer than 5 s to load and draw a frame at 1\.00 s \(its first frame, the document just loaded\): render\(t\) was waiting on a promise that never settled, with no project picture pending/,
    );
    return true;
  });
  assert.ok(Date.now() - t0 < 8000, `failed in ${Date.now() - t0} ms`);
});
