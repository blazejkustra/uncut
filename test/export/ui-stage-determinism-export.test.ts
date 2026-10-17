// uncutUI's live editor stage and fly through the export rasteriser (apps/desktop render.ts): the
// stage keeps each panel's DOM between frames and rebuilds one only when its props change, and fly
// caches its copies, but the export draws frames out of order (parallel workers, a fresh document
// after another graphic or a timed-out frame). Every frame must be the same pixels whether it is
// drawn first in a fresh document, after the frames before it, or after frames in shuffled order:
// panels swapped and swapped back (Inspector, Effects), a dialog opened and closed, blur and dim
// easing out, clips, steps and the playhead moving, two flights (a hero piece docking, a tile
// becoming a clip, the tile leaving), a running step's spinner turning with t; a flight to an element not laid out shows nothing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { graphicDocument, graphicInfo, type Project } from "../../packages/core/src/index.ts";
import { readGraphics } from "../../apps/server/src/export/exporter.ts";
import { loadGraphicLibs } from "../../apps/server/src/export/graphicLibs.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../../apps/server/src/export/rasterizer.ts";
import { opaquePixels, pixelHash, rgbaOf } from "../helpers/image-compare.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";

const W = 540;
const H = 675;
const canvas = { width: W, height: H, fps: 30 };

const STAGE = `<div id="stage" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;background:#f1f0ed;overflow:hidden"><div id="cam" style="position:absolute;left:0;top:0;transform-origin:0 0"></div></div>
<script src="uncut:lib/ui.js"></script>
<script>
const stage = document.getElementById("stage");
const cam = document.getElementById("cam");
const pic = document.createElement("canvas");
pic.width = 108; pic.height = 135;
pic.getContext("2d").fillStyle = "#3a7";
pic.getContext("2d").fillRect(0, 0, 108, 135);
const thumb = pic.toDataURL();
const prompt = "Make a launch film on the beat";
const within = (t, a, b) => t >= a && t < b;
let checked = false;
window.render = (t) => {
  if (!checked) {
    // A flight to an element not laid out (display: none) shows nothing: never a copy shrinking into the host's corner.
    const gone = document.createElement("div");
    gone.style.display = "none";
    stage.appendChild(gone);
    const r = uncutUI.fly(stage, 0.5, { id: "gone", at: 0.2, from: { x: 10, y: 10, w: 100, h: 50 }, to: gone });
    if (r.w || stage.querySelector('[data-fly="gone"]').style.display !== "none") throw new Error("fly: a flight to an element not laid out shows");
    gone.remove();
    checked = true;
  }
  const clips = [];
  if (t > 0.6) clips.push({ track: "Main", start: 0, duration: 2 + t, name: "A", image: thumb, selected: within(t, 1.2, 2) });
  if (t > 1.5) clips.push({ track: "Text", start: 1, duration: 1.5, name: "Title" });
  const ed = uncutUI.mount(cam, "editor", {
    width: 1440, height: 1000, scale: 0.375 + 0.05 * Math.min(1, t / 3), time: t,
    blur: 6 * Math.max(0, 1 - t / 0.8), dim: 0.35 * Math.max(0, 1 - t / 0.8),
    media: [{ name: "A", meta: "Video", image: thumb, duration: 12 }],
    topbar: { title: "Film", exportLabel: within(t, 2.4, 2.8) ? "Exporting " + Math.round((t - 2.4) * 250) + "%" : undefined },
    composer: { text: t < 0.5 ? "" : t > 2.6 ? "Warmer" : "" },
    turn: t > 0.5 ? { steps: ["Read the brand kit", "Found the beats", "Placed the clips"].slice(0, Math.min(3, 1 + Math.floor((t - 0.5) / 0.4))), done: Math.max(0, Math.floor((t - 0.7) / 0.4)) } : undefined,
    timeline: { clips, playhead: t },
    preview: { frame: pic, time: t, canvas: "1080×1350, 60 fps" },
    side: within(t, 1.2, 2) ? "inspector" : undefined,
    inspector: { title: "A", filter: "Warm", amount: Math.round(t * 20) },
    library: within(t, 0.9, 1.6) ? "effects" : undefined,
    effects: { active: t > 1.1 ? "warm" : "" },
    export: within(t, 1.8, 2.4) ? { quality: "high", duration: 4 } : undefined,
    exportProgress: within(t, 2.4, 2.7) ? { progress: (t - 2.4) / 0.3 } : undefined,
    highlight: within(t, 2.0, 2.2) ? ["topbar.export"] : [],
    press: { "topbar.export": within(t, 1.75, 1.8) ? 0.95 : 1 },
  });
  cam.style.transform = "translate(" + (-20 * Math.min(1, t)) + "px, " + (-10 * Math.min(1, t)) + "px)";
  uncutUI.fly(stage, t, { id: "dock", at: 0.3, dur: 0.6, from: { piece: "composer", props: { text: prompt }, width: 460, type: 22 }, to: uncutUI.find(ed, "composer"), fit: "contain" });
  uncutUI.fly(stage, t, { id: "tile", at: 0.55, dur: 0.5, from: ed.querySelector('[data-testid="media-tile"] .thumb'), to: ed.querySelector(".tl-lane.main .clip"), arc: -40, leave: true });
};
</script>`;

const OTHER = `<div style="width:10px;height:10px;background:#f00"></div><script>window.render = () => {};</script>`;

let root: string;
let docs: Map<string, string>;
let raster: Rasterizer;
const project = {
  canvas,
  tracks: [{ items: [{ type: "graphic", src: "graphics/stage.html", duration: 90 }, { type: "graphic", src: "graphics/other.html", duration: 90 }] }],
} as unknown as Project;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-ui-stage-")));
  const dir = join(root, "Stage.uncut");
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "stage.html"), STAGE);
  writeFileSync(join(dir, "graphics", "other.html"), OTHER);
  const graphics = await readGraphics(dir, project, await loadGraphicLibs(resolve("assets/graphic-libs")));
  docs = new Map([...graphics].map(([src, html]) => [src, graphicDocument(html, canvas)]));
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  raster = await startRasterizer(command);
});

after(async () => {
  if (skip) return;
  await raster?.close();
  if (process.env.UNCUT_KEEP_OUTPUT) console.log(`kept ${root}`);
  else rmSync(root, { recursive: true, force: true });
});

/**
 * How far two frames are apart: Chromium's own raster caches (glyphs, tiles at a scale drawn the
 * frame before) shift a few edge pixels by a few levels between a reused document and a fresh one,
 * even for a plain mount of the editor (the case before the live stage too); a wrong panel, a
 * leftover dialog, a flight in the wrong place or an element left hidden moves many pixels far.
 */
function apart(a: string, b: string): { off: number; far: number; max: number } {
  const x = rgbaOf(a);
  const y = rgbaOf(b);
  let off = 0;
  let far = 0;
  let max = 0;
  for (let i = 0; i < x.length; i += 4) {
    const d = Math.max(Math.abs(x[i]! - y[i]!), Math.abs(x[i + 1]! - y[i + 1]!), Math.abs(x[i + 2]! - y[i + 2]!), Math.abs(x[i + 3]! - y[i + 3]!));
    if (d > 0) off++;
    if (d > 32) far++;
    if (d > max) max = d;
  }
  return { off, far, max };
}

async function frame(src: string, local: number, out: string) {
  const info = graphicInfo({ duration: 90, props: {} }, canvas, local);
  await raster.render({ kind: "graphic", width: W, height: H, doc: docs.get(src)!, t: local / canvas.fps, info, out, name: src });
  return out;
}

test("the live editor stage and fly: a frame is the same picture drawn fresh, in order, or after frames in shuffled order", { skip, timeout: 300000 }, async (t) => {
  const frames = Array.from({ length: 31 }, (_, i) => i * 3); // t 0 to 3 s, every 0.1 s
  const seq = new Map<number, string>();
  for (const f of frames) seq.set(f, await frame("graphics/stage.html", f, join(root, `seq-${f}.png`)));
  // A fixed shuffle (seeded), in the same document: each frame drawn after unrelated ones.
  let s = 7;
  const shuffled = [...frames].sort(() => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  const bad: string[] = [];
  let worst = 0;
  const check = (how: string, f: number, png: string) => {
    const d = apart(seq.get(f)!, png);
    worst = Math.max(worst, d.off);
    if (d.far > 0 || d.off > W * H * 0.01) bad.push(`${how} ${f}: ${d.off} px off, ${d.far} by more than 32, max ${d.max}`);
  };
  for (const f of shuffled) check("shuffled", f, await frame("graphics/stage.html", f, join(root, `shuf-${f}.png`)));
  // Fresh: another graphic first, so the stage's document loads anew and this is its first frame.
  for (const f of frames) {
    await frame("graphics/other.html", 0, join(root, "other.png"));
    check("fresh", f, await frame("graphics/stage.html", f, join(root, `fresh-${f}.png`)));
  }
  t.diagnostic(`worst: ${worst} px off`);
  assert.deepEqual(bad, [], `frames apart from the in-order render (UNCUT_KEEP_OUTPUT=1 keeps ${root})`);
  assert.ok(new Set([...seq.values()].map(pixelHash)).size > 25, "the stage moves with t");
  assert.ok(opaquePixels(seq.get(45)!) / (W * H) > 0.99, "the frame is drawn");
});
