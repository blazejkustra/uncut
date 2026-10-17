// The motion-film stage example's Send (packages/core graphics.ts, beat 2), as written: the typed
// composer piece (beat 1) flies into the message bubble (to: root.querySelector(".msg-user"),
// fit: "contain"), message and a running step set from send, while blur and dim ease out. Through the
// export rasteriser: the hero shows before Send, lands in the bubble, and every frame is the same
// picture drawn in order, shuffled, or fresh in a new document.
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
import { pixelHash, rgbaOf } from "../helpers/image-compare.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";

const W = 540;
const H = 675;
const canvas = { width: W, height: H, fps: 30 };

// send at 1.2 s, the flight 0.9 s; the probe records whether the hero's layer shows, per frame.
const STAGE = `<div id="stage" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;background:#f1f0ed;overflow:hidden"><div id="world" style="position:absolute;left:0;top:0;transform-origin:0 0"></div></div>
<script src="uncut:lib/ui.js"></script>
<script>
const stage = document.getElementById("stage");
const world = document.getElementById("world");
const prompt = "Make a launch film on the beat";
const send = 1.2;
window.render = (t) => {
  const sent = t >= send;
  const k = Math.min(1, Math.max(0, (t - send) / 0.9));
  const root = uncutUI.mount(world, "editor", {
    width: 1440, height: 1000, scale: 0.375, time: t,
    blur: 6 * (1 - k), dim: 0.16 * (1 - k),
    message: sent ? { text: prompt } : undefined,
    turn: sent ? { steps: ["Read the brand kit"], done: 0 } : undefined,
    timeline: { clips: [], playhead: 0 },
  });
  const hero = uncutUI.fly(stage, t, { id: "composer", at: send, to: root.querySelector(".msg-user"), fit: "contain", from: { piece: "composer", y: 640, props: { text: prompt, caret: true }, typing: { at: 0.05, dur: 1 } } });
  document.title = JSON.stringify({ w: Math.round(hero.w), shown: stage.querySelector('[data-fly="composer"]')?.style.display !== "none" });
};
</script>`;

const OTHER = `<div style="width:10px;height:10px;background:#f00"></div><script>window.render = () => {};</script>`;

let root: string;
let docs: Map<string, string>;
let raster: Rasterizer;
const project = { canvas, tracks: [{ items: [{ type: "graphic", src: "graphics/send.html", duration: 90 }, { type: "graphic", src: "graphics/other.html", duration: 90 }] }] } as unknown as Project;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-ui-send-")));
  const dir = join(root, "Send.uncut");
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "send.html"), STAGE);
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

function apart(a: string, b: string): { off: number; far: number } {
  const x = rgbaOf(a);
  const y = rgbaOf(b);
  let off = 0;
  let far = 0;
  for (let i = 0; i < x.length; i += 4) {
    const d = Math.max(Math.abs(x[i]! - y[i]!), Math.abs(x[i + 1]! - y[i + 1]!), Math.abs(x[i + 2]! - y[i + 2]!), Math.abs(x[i + 3]! - y[i + 3]!));
    if (d > 0) off++;
    if (d > 32) far++;
  }
  return { off, far };
}

async function frame(src: string, local: number, out: string) {
  const info = graphicInfo({ duration: 90, props: {} }, canvas, local);
  await raster.render({ kind: "graphic", width: W, height: H, doc: docs.get(src)!, t: local / canvas.fps, info, out, name: src });
  return out;
}

test("the stage example's Send: the typed composer flies into the message bubble, the same pixels in order, shuffled or fresh", { skip, timeout: 300000 }, async () => {
  const frames = Array.from({ length: 25 }, (_, i) => i * 3); // 0 to 2.4 s
  const seq = new Map<number, string>();
  for (const f of frames) seq.set(f, await frame("graphics/send.html", f, join(root, `seq-${f}.png`)));
  // Before Send the big composer is on screen (frames differ from the editor alone as it types), mid-flight it moves.
  const before = [3, 15, 30].map((f) => pixelHash(seq.get(f)!));
  assert.equal(new Set(before).size, 3, "the hero types before Send");
  assert.ok(apart(seq.get(33)!, seq.get(48)!).far > 500, "the prompt flies after Send");
  assert.ok(apart(seq.get(66)!, seq.get(72)!).far < 50, "landed: it settles in the bubble");
  let s = 11;
  const shuffled = [...frames].sort(() => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  const bad: string[] = [];
  const check = (how: string, f: number, png: string) => {
    const d = apart(seq.get(f)!, png);
    if (d.far > 0 || d.off > W * H * 0.01) bad.push(`${how} ${f}: ${d.off} px off, ${d.far} by more than 32`);
  };
  for (const f of shuffled) check("shuffled", f, await frame("graphics/send.html", f, join(root, `shuf-${f}.png`)));
  for (const f of frames) {
    await frame("graphics/other.html", 0, join(root, "other.png"));
    check("fresh", f, await frame("graphics/send.html", f, join(root, `fresh-${f}.png`)));
  }
  assert.deepEqual(bad, [], `frames apart from the in-order render (UNCUT_KEEP_OUTPUT=1 keeps ${root})`);
});
