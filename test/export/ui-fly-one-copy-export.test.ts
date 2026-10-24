// uncutUI.fly keeps one copy of the words on screen (T3b keynote, 4.25 s: a faint second prompt, in
// the bubble's line breaks, behind the flying composer). The hand-over faded the landing snapshot in
// while the typed composer was still whole, so mid-flight the prompt showed twice; and a stage with
// message set from frame 0 (as T3b's was) showed the bubble's prompt next to the hero before Send.
// Through the export rasteriser, every frame before, during and after the flight: a probe counts the
// pictures of the whole prompt (visible, faded no lower than 5 %) and paints the count into a
// corner pixel, which the test reads back. Never two; one on every frame but the hand-over's middle.
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
import { rgbaOf } from "../helpers/image-compare.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";

const W = 540;
const H = 675;
const canvas = { width: W, height: H, fps: 30 };

// Send at 1.2 s, the flight 0.9 s. The message is in the stage from frame 0 and never hidden by the graphic.
const STAGE = `<div id="stage" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;background:#f1f0ed;overflow:hidden"><div id="world" style="position:absolute;left:0;top:0;transform-origin:0 0"></div><div id="fx" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"></div></div>
<div id="probe" style="position:absolute;left:0;top:0;width:8px;height:8px;z-index:999"></div>
<script src="uncut:lib/ui.js"></script>
<script>
const stage = document.getElementById("stage");
const world = document.getElementById("world");
const fx = document.getElementById("fx");
const prompt = "Make a launch film on the beat";
const send = 1.2;
function shown(el) {
  let alpha = 1;
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    const cs = getComputedStyle(e);
    if (cs.display === "none") return false;
    alpha *= parseFloat(cs.opacity);
  }
  const r = el.getBoundingClientRect();
  return getComputedStyle(el).visibility !== "hidden" && alpha > 0.05 && r.width > 0 && r.height > 0 && r.right > 0 && r.left < ${W} && r.bottom > 0 && r.top < ${H};
}
window.render = (t) => {
  const k = Math.min(1, Math.max(0, (t - send) / 0.9));
  const root = uncutUI.mount(world, "editor", {
    width: 1440, height: 1000, scale: 0.375, time: t,
    blur: 6 * (1 - k), dim: 0.16 * (1 - k),
    message: { text: prompt },
    turn: t >= send ? { steps: ["Read the brand kit"], done: 0 } : undefined,
    timeline: { clips: [], playhead: 0 },
  });
  uncutUI.fly(fx, t, { id: "composer", at: send, to: root.querySelector(".msg-user"), fit: "contain", from: { piece: "composer", y: 640, props: { text: prompt, caret: false }, typing: { at: 0.05, dur: 0.8 } } });
  const has = (el) => (el.textContent || "").replace(/\\s+/g, " ").includes(prompt);
  // A copy is one picture of the words: the flying card's start, its landing snapshot, or the stage's bubble (a composer draws its text twice, a textarea under its highlight: one copy).
  const copies = new Set([...stage.querySelectorAll("*")].filter((el) => has(el) && ![...el.children].some(has) && shown(el)).map((el) => el.closest(".uncut-ui-fly-a, .uncut-ui-fly-b, .msg-user") || el));
  document.getElementById("probe").style.background = "rgb(" + Math.min(255, copies.size * 60) + ",0,0)";
};
</script>`;

let root: string;
let doc: string;
let raster: Rasterizer;
const project = { canvas, tracks: [{ items: [{ type: "graphic", src: "graphics/fly.html", duration: 90 }] }] } as unknown as Project;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-ui-fly-")));
  const dir = join(root, "Fly.uncut");
  mkdirSync(join(dir, "graphics"), { recursive: true });
  writeFileSync(join(dir, "graphics", "fly.html"), STAGE);
  const graphics = await readGraphics(dir, project, await loadGraphicLibs(resolve("assets/graphic-libs")));
  doc = graphicDocument(graphics.get("graphics/fly.html")!, canvas);
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

async function copiesAt(f: number): Promise<number> {
  const out = join(root, `f-${f}.png`);
  await raster.render({
    kind: "graphic",
    width: W,
    height: H,
    doc,
    t: f / canvas.fps,
    info: graphicInfo({ duration: 90, props: {} }, canvas, f),
    out,
    name: "graphics/fly.html",
  });
  const px = rgbaOf(out);
  const i = (2 * W + 2) * 4;
  return Math.round(px[i]! / 60);
}

test("uncutUI.fly: the prompt is on screen exactly once before, all through and after its flight into the bubble", { skip, timeout: 300000 }, async () => {
  // typed by 0.85 s; the flight runs from frame 36 (1.2 s) to frame 63 (2.1 s), every frame of it checked
  const frames = [27, 30, 33, ...Array.from({ length: 28 }, (_, i) => 36 + i), 66, 72];
  // The hand-over (the typed words out by 34 % of the flight, the bubble's in from there) may leave
  // the shell wordless for a frame at its middle; never two copies, and one everywhere else.
  const handover = (f: number) => Math.abs((f - 36) / 27 - 0.34) < 0.05;
  const bad: string[] = [];
  for (const f of frames) {
    const n = await copiesAt(f);
    if (n > 1 || (n !== 1 && !handover(f))) bad.push(`frame ${f} (${(f / canvas.fps - 1.2).toFixed(2)} s from Send): ${n} copies`);
  }
  assert.deepEqual(bad, [], `the prompt shown other than once (UNCUT_KEEP_OUTPUT=1 keeps ${root})`);
});
