// The launch-film rehearsal's export failure, through the real rasteriser: a graphic that fetches a
// picture once in its setup (a thumbnail) and draws it on every frame, beside one fresh
// uncut.frame(clip, t) per frame. The page's media cache let go of pictures not asked for lately by
// closing them (core GRAPHIC_MEDIA_BOOT sweep), so after 24 pictures the held thumbnail was closed
// and drawImage threw "The image source is detached" (a DOMException), which reached the export as
// "couldn't be drawn at 12.08 s: undefined". Now:
// - the held picture survives a long run of frames (more than the cache keeps);
// - whatever render(t) throws reaches the caller with its name and message (a DOMException, a
//   thrown string), never "undefined".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { graphicDocument, graphicInfo, type Media } from "../../packages/core/src/index.ts";
import { graphicMediaSource, type GraphicMediaSource } from "../../apps/server/src/export/graphicMedia.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../../apps/server/src/export/rasterizer.ts";

const DESKTOP = process.env.UNCUT_TEST_DESKTOP ?? resolve("apps/desktop/dist/main.cjs");
const bin = spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).stdout.trim();
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : bin ? false : "needs ffmpeg";

const W = 160;
const H = 120;
const canvas = { width: W, height: H, fps: 30 };
// Past 2 × fps frames, so the sweep closes the old pictures while the held one stays.
const FRAMES = 80;

// Like launch-film-8.html: thumbs fetched in init, footage asked per frame, both drawn every frame.
const HELD = `<canvas id="c" width="${W}" height="${H}"></canvas>
<script>
const ctx = document.getElementById("c").getContext("2d");
let ready, thumb;
async function init() { thumb = await uncut.frame("clip", 0.1, { width: 32 }); }
window.render = async (t) => {
  ready ??= init();
  await ready;
  const frame = await uncut.frame("clip", 0.2 + t, { width: ${W} });
  ctx.clearRect(0, 0, ${W}, ${H});
  ctx.drawImage(frame, 0, 0, ${W}, ${H});
  ctx.drawImage(thumb, 4, 4, 32, 18);
};
</script>`;

// A picture asked for once after the first frame and kept: closed once unused for about 2 × fps
// frames (a closed ImageBitmap reads 0 × 0), so its memory goes predictably; the setup's isn't.
const AGED = `<canvas id="c" width="${W}" height="${H}"></canvas>
<script>
let early, late;
window.render = async (t, info) => {
  early ??= await uncut.frame("clip", 0.1, { width: 32 });
  if (info.frame === 1) late = await uncut.frame("clip", 0.3, { width: 32 });
  if (info.frame > 1) await uncut.frame("clip", 0.2 + t, { width: 16 });
  if (info.frame === ${FRAMES - 1} && (late.width !== 0 || early.width === 0)) throw new Error("late " + late.width + ", early " + early.width);
};
</script>`;

const THROWS = (what: string) => `<canvas id="c" width="${W}" height="${H}"></canvas>
<script>
const ctx = document.getElementById("c").getContext("2d");
window.render = async () => {
  ${what}
};
</script>`;

let root: string;
let raster: Rasterizer;
let source: GraphicMediaSource;
const media: Array<Media> = [];

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-graphic-held-")));
  const clip = join(root, "clip.mp4");
  const c = spawnSync(bin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-t", "3", "-c:v", "libx264", "-g", "30", "-pix_fmt", "yuv420p", clip]);
  assert.equal(c.status, 0, String(c.stderr));
  media.push({ id: "clip", kind: "video", name: "clip.mp4", path: clip });
  source = graphicMediaSource({ bin, media: () => media, mediaPath: (m) => m.path });
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  raster = await startRasterizer(command, undefined, { media: source.file });
});

after(async () => {
  if (skip) return;
  await raster?.close();
  source?.close();
  rmSync(root, { recursive: true, force: true });
});

const draw = (html: string, local: number) => drawIn(html, local, "held");
const drawIn = (html: string, local: number, name: string) =>
  raster.render({ kind: "graphic", width: W, height: H, doc: graphicDocument(html, canvas), t: local / canvas.fps, info: graphicInfo({ duration: FRAMES, props: {} }, canvas, local), out: join(root, `${name}-${local}.png`), name: `"${name}" (graphics/${name}.html)` });

test("a picture fetched once and drawn every frame survives more frames than the media cache keeps", { skip }, async () => {
  for (let f = 0; f < FRAMES; f++) await assert.doesNotReject(draw(HELD, f), `frame ${f}`);
});

test("a picture unused for about 2 × fps frames is closed; one from the first render is not", { skip }, async () => {
  for (let f = 0; f < FRAMES; f++) await assert.doesNotReject(drawIn(AGED, f, "aged"), `frame ${f}`);
});

test("what render(t) throws reaches the export with its name and message, never undefined", { skip }, async () => {
  // A closed bitmap drawn: the DOMException the rehearsal hit.
  await assert.rejects(draw(THROWS(`const b = await uncut.frame("clip", 0, { width: 32 }); b.close(); ctx.drawImage(b, 0, 0);`), 0), (error: Error) => {
    assert.match(error.message, /InvalidStateError/);
    assert.match(error.message, /detached/);
    assert.doesNotMatch(error.message, /undefined/);
    return true;
  });
  // A thrown string.
  await assert.rejects(draw(THROWS(`throw "the graphic said no";`), 0), /the graphic said no/);
  // A thrown object without a message.
  await assert.rejects(draw(THROWS(`throw {};`), 0), (error: Error) => {
    assert.doesNotMatch(error.message, /undefined/);
    return true;
  });
});
