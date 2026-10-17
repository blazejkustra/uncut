// uncutUI's editor stage shows the cut in its preview by itself: films mounted the editor without
// preview.frame (or passed it only later) and their wide shots showed a black hole where the
// preview sits (T4 9 s, T5 8 to 11 s, A2r8 8 s, A1r7 9.42 s, A2r9 8 s). Without a frame, the stage
// draws the clip under the playhead: its media's real frame (uncut.frame at in + playhead - start)
// or its image; a gap stays black, and the census reports a preview on screen that is empty.
// Through the export rasteriser (apps/desktop render.ts): the right source frame, the same pixels
// drawn fresh or after other frames, and the census note.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { censusOf, graphicDocument, graphicInfo, SMALL_TEXT, type Media, type Project } from "../../packages/core/src/index.ts";
import { readGraphics } from "../../apps/server/src/export/exporter.ts";
import { loadGraphicLibs } from "../../apps/server/src/export/graphicLibs.ts";
import { graphicMediaSource, type GraphicMediaSource } from "../../apps/server/src/export/graphicMedia.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { pixelHash, rgbaOf } from "../helpers/image-compare.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const which = (name: string) => spawnSync("which", [name], { encoding: "utf8" }).stdout.trim();
const bin = which("ffmpeg");
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : bin ? false : "needs ffmpeg";

const W = 540;
const H = 675;
const canvas = { width: W, height: H, fps: 30 };

// The editor with three clips and no preview.frame; the playhead is t. The camera fits the
// preview's frame to the canvas, so the canvas's middle is the preview's picture.
// Clip 0: the video from 0.5 s of it, at 1 to 3 s (red for its first second, green after);
// clip 1: an image (blue), at 3 to 4 s; then a gap to 6 s.
const STAGE = `<div id="stage" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;background:#222;overflow:hidden"><div id="cam" style="position:absolute;left:0;top:0;transform-origin:0 0"></div></div>
<script src="uncut:lib/ui.js"></script>
<script>
const cam = document.getElementById("cam");
const pic = document.createElement("canvas");
pic.width = 64; pic.height = 36;
pic.getContext("2d").fillStyle = "#0000ff";
pic.getContext("2d").fillRect(0, 0, 64, 36);
const blue = pic.toDataURL();
window.render = (t) => {
  const ed = uncutUI.mount(cam, "editor", {
    width: 1440, height: 1000, time: t,
    timeline: { clips: [
      { track: "Main", start: 1, duration: 2, name: "Drone", media: "clip", in: 0.5 },
      { track: "Main", start: 3, duration: 1, name: "Still", image: blue },
      { track: "Audio", start: 0, duration: 6, name: "Song", media: "clip" },
    ], playhead: t },
    preview: { time: t, canvas: "1080×1350, 60 fps" },
  });
  const r = uncutUI.rectIn(uncutUI.find(ed, "frame"), cam);
  const k = Math.min(${W} / r.w, ${H} / r.h);
  cam.style.transform = "translate(" + (${W} / 2 - (r.x + r.w / 2) * k) + "px, " + (${H} / 2 - (r.y + r.h / 2) * k) + "px) scale(" + k + ")";
};
</script>`;

const OTHER = `<div style="width:10px;height:10px;background:#f00"></div><script>window.render = () => {};</script>`;

let root: string;
let docs: Map<string, string>;
let raster: Rasterizer;
let source: GraphicMediaSource;
const media: Array<Media> = [];
const project = {
  canvas,
  tracks: [{ items: [{ type: "graphic", src: "graphics/stage.html", duration: 180 }, { type: "graphic", src: "graphics/other.html", duration: 180 }] }],
} as unknown as Project;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-ui-preview-")));
  const dir = join(root, "Preview.uncut");
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "stage.html"), STAGE);
  writeFileSync(join(dir, "graphics", "other.html"), OTHER);
  const clip = join(root, "clip.mp4");
  const c = spawnSync(bin, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:size=320x180:rate=30:d=1", "-f", "lavfi", "-i", "color=c=lime:size=320x180:rate=30:d=2", "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
  assert.equal(c.status, 0, String(c.stderr));
  media.push({ id: "clip", kind: "video", name: "clip.mp4", path: clip } as Media);
  source = graphicMediaSource({ bin, media: () => media, mediaPath: (m) => (m as Media & { path: string }).path });
  const graphics = await readGraphics(dir, project, await loadGraphicLibs(resolve("assets/graphic-libs")));
  docs = new Map([...graphics].map(([src, html]) => [src, graphicDocument(html, canvas)]));
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  raster = await startRasterizer(command, undefined, { media: source.file });
});

after(async () => {
  if (skip) return;
  await raster?.close();
  source?.close();
  if (process.env.UNCUT_KEEP_OUTPUT) console.log(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
});

async function frame(src: string, seconds: number, out: string) {
  const local = Math.round(seconds * canvas.fps);
  const info = graphicInfo({ duration: 180, props: {} }, canvas, local);
  const reply = await raster.render({ kind: "graphic", width: W, height: H, doc: docs.get(src)!, t: local / canvas.fps, info, out, name: src, census: SMALL_TEXT });
  return { png: out, census: reply ? censusOf(reply.census) : undefined };
}

/** The mean colour of the canvas's middle (a quarter of each side around the centre). */
function middle(png: string): [number, number, number] {
  const px = rgbaOf(png);
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.round(H * 0.375); y < H * 0.625; y++)
    for (let x = Math.round(W * 0.375); x < W * 0.625; x++) {
      const i = (y * W + x) * 4;
      sum[0] += px[i]!;
      sum[1] += px[i + 1]!;
      sum[2] += px[i + 2]!;
      n++;
    }
  return sum.map((v) => Math.round(v / n)) as [number, number, number];
}

test("the editor stage's preview shows the clip under the playhead without preview.frame, the same drawn fresh, and a gap is reported", { skip, timeout: 300000 }, async () => {
  // 1.2 s: 0.2 s into the clip, its media at 0.7 s (red); 2.2 s: its media at 1.7 s (green).
  const red = await frame("graphics/stage.html", 1.2, join(root, "red.png"));
  const [r1, g1, b1] = middle(red.png);
  assert.ok(r1 > 180 && g1 < 70 && b1 < 70, `mid-cut, the preview shows the clip's frame at in + 0.2 s (red), got ${r1},${g1},${b1}`);
  assert.equal(red.census?.emptyPreview, undefined, "a preview with footage isn't reported empty");
  const green = await frame("graphics/stage.html", 2.2, join(root, "green.png"));
  const [r2, g2, b2] = middle(green.png);
  assert.ok(g2 > 180 && r2 < 70 && b2 < 70, `later, the clip's frame at 1.7 s of it (green), got ${r2},${g2},${b2}`);
  const still = await frame("graphics/stage.html", 3.5, join(root, "blue.png"));
  const [r3, g3, b3] = middle(still.png);
  assert.ok(b3 > 180 && r3 < 70 && g3 < 70, `an image clip shows its image (blue), got ${r3},${g3},${b3}`);
  // The gap: nothing invented, black, and the census says so.
  const gap = await frame("graphics/stage.html", 5, join(root, "gap.png"));
  const [r4, g4, b4] = middle(gap.png);
  assert.ok(r4 < 40 && g4 < 40 && b4 < 40, `a gap stays black, got ${r4},${g4},${b4}`);
  assert.ok((gap.census?.emptyPreview ?? 0) > 50, `the census reports the empty preview filling the frame, got ${gap.census?.emptyPreview}`);
  // Fresh: another graphic first, so this is the stage's first frame in a new document.
  await frame("graphics/other.html", 0, join(root, "other.png"));
  const fresh = await frame("graphics/stage.html", 1.2, join(root, "red-fresh.png"));
  assert.equal(pixelHash(fresh.png), pixelHash(red.png), "the preview's footage is the same drawn first in a fresh document");
  await frame("graphics/other.html", 0, join(root, "other2.png"));
  const freshStill = await frame("graphics/stage.html", 3.5, join(root, "blue-fresh.png"));
  assert.deepEqual(middle(freshStill.png), middle(still.png), "an image clip's picture is there on a fresh document's first frame");
});
