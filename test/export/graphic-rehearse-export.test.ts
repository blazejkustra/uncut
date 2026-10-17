// The export's graphics rehearsed (apps/server/src/export/exporter/rehearse.ts) through the real
// rasteriser: round 2's A2 shipped a film whose graphic broke only on a long contiguous run (a
// picture it held went detached at frame 511), which render_frames' few frames and the critic's
// scan never reached. The rehearsal runs render(t) as the export does, so:
// - a graphic that breaks at frame N on a contiguous run fails the rehearsal at the same frame, with
//   the same reason, as the export's own rasterise (with and without motion blur's sub-frames);
// - a graphic that doesn't break is covered whole, and isn't run again once it passed;
// - the time budget cuts it short and says how far it got.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Project } from "../../packages/core/src/index.ts";
import { planExport, type ExportPlan } from "../../apps/server/src/export/exportPlan.ts";
import { rasterise } from "../../apps/server/src/export/exporter/rasterise.ts";
import { rehearsalCalls, rehearsalLine, rehearseGraphics } from "../../apps/server/src/export/exporter/rehearse.ts";
import { openFrameSession } from "../../apps/server/src/export/exporter/frames.ts";
import { rasterizerCommand, startRasterizer, type Rasterizer } from "../../apps/server/src/export/rasterizer.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";
const FFMPEG = hasFfmpeg ? execFileSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim() : "ffmpeg";

const W = 64;
const H = 80;
const FPS = 30;
const FRAMES = 240;
const BREAK_AT = 150;

// Holds a picture it made at its first frame and draws it every frame; at BREAK_AT it lets go of it
// (closes it) after drawing: the next draw throws "The image source is detached", as A2r2's did.
const BREAKS = `<canvas id="c" width="${W}" height="${H}"></canvas><script>
const ctx = document.getElementById("c").getContext("2d");
let held, closed = false;
window.render = async (t, info) => {
  if (!held) { const o = new OffscreenCanvas(8, 8); o.getContext("2d").fillRect(0, 0, 8, 8); held = await createImageBitmap(o); }
  ctx.clearRect(0, 0, ${W}, ${H});
  ctx.drawImage(held, Math.round(t * 30) % 40, 10);
  if (info.frame === ${BREAK_AT} && !closed) { held.close(); closed = true; }
};
</script>`;
const FINE = `<canvas id="c" width="${W}" height="${H}"></canvas><script>
const ctx = document.getElementById("c").getContext("2d");
window.render = (t) => { ctx.clearRect(0, 0, ${W}, ${H}); ctx.fillStyle = "#fff"; ctx.fillRect(Math.round(t * 60) % 40, 10, 8, 8); };
</script>`;

const projectOf = (src: string): Project =>
  ({
    format: "uncut/0",
    name: "Rehearse",
    canvas: { width: W, height: H, fps: FPS },
    media: [],
    tracks: [
      { id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "bg", type: "component", component: "component.solid", duration: FRAMES + 20, props: { color: "#000000" } }] },
      { id: "g", kind: "video", name: "Graphics", items: [{ id: "film", type: "graphic", src, start: 20, duration: FRAMES }] },
    ],
  }) as unknown as Project;

const plan = (html: string, motionBlur: boolean, src = "graphics/film.html") => {
  const p = planExport(projectOf(src), { mediaPath: () => "", width: W, height: H, graphic: () => html, motionBlur });
  if ("problem" in p) throw new Error(p.problem);
  return p as ExportPlan;
};

let root: string;
let raster: Rasterizer;

before(async () => {
  if (skip) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-rehearse-")));
  const command = rasterizerCommand({ ...process.env, UNCUT_RENDER_ENTRY: DESKTOP });
  if ("problem" in command) throw new Error(command.problem);
  raster = await startRasterizer(command);
});

after(async () => {
  if (skip) return;
  await raster?.close();
  rmSync(root, { recursive: true, force: true });
});

const exportFailure = async (p: ExportPlan, name: string) => {
  const dir = join(root, name);
  mkdirSync(dir);
  const error = await rasterise(raster, p, projectOf("graphics/film.html"), () => "", dir, new AbortController().signal, undefined, { bin: FFMPEG }).then(
    () => undefined,
    (e: Error) => e,
  );
  assert.ok(error, "the export fails");
  return error.message;
};

for (const blur of [false, true]) {
  test(`a graphic that breaks on a long run fails the rehearsal where the export fails${blur ? " (motion blur)" : ""}`, { skip, timeout: 120_000 }, async () => {
    const p = plan(BREAKS, blur);
    const exported = await exportFailure(p, blur ? "blur" : "sharp");
    const rehearsed = await rehearseGraphics(raster, p, { budgetMs: 60_000 });
    assert.ok(rehearsed.failure, "the rehearsal fails");
    // Blur: the frame's second sub-frame draws the closed picture, so the same frame breaks.
    const frame = blur ? BREAK_AT : BREAK_AT + 1;
    assert.match(exported, new RegExp(`\\(its frame ${frame}\\)`));
    assert.match(rehearsed.failure!, new RegExp(`\\(its frame ${frame}\\)`));
    assert.match(exported, /detached/);
    assert.match(rehearsed.failure!, /detached/);
    assert.match(rehearsed.failure!, new RegExp(`at ${((20 + frame) / FPS).toFixed(2)} s`));
    assert.equal(rehearsed.frame, 20 + frame);
    assert.match(rehearsalLine(rehearsed), /every frame in order/);
  });
}

test("a graphic that doesn't break is covered whole, then not run again; the budget cuts it short and says so", { skip, timeout: 120_000 }, async () => {
  const p = plan(FINE, true, "graphics/fine.html");
  const layer = p.visuals.find((l) => l.kind === "graphic");
  assert.ok(layer && layer.kind === "graphic");
  const calls = rehearsalCalls(layer, FPS);
  assert.equal(calls.length, FRAMES);
  assert.equal(calls[1]!.ts.length, 4, "each frame's sub-frames");
  const short = await rehearseGraphics(raster, plan(FINE.replace("#fff", "#eee"), true, "graphics/fine.html"), { budgetMs: -1 });
  assert.equal(short.failure, undefined);
  assert.equal(short.covered, 0);
  assert.match(rehearsalLine(short), /time budget/);
  const whole = await rehearseGraphics(raster, p, { budgetMs: 60_000 });
  assert.deepEqual({ covered: whole.covered, total: whole.total, failure: whole.failure }, { covered: FRAMES, total: FRAMES, failure: undefined });
  assert.match(rehearsalLine(whole), /without an error/);
  const t0 = Date.now();
  const again = await rehearseGraphics(raster, p, { budgetMs: 60_000 });
  assert.equal(again.covered, FRAMES);
  assert.ok(Date.now() - t0 < 200, "a rehearsal that passed isn't run again");
});

test("a frame session (render_frames, review_submit) rehearses with the export's blur and finds it too", { skip, timeout: 120_000 }, async () => {
  process.env.UNCUT_RENDER_ENTRY ??= DESKTOP;
  const project = { ...projectOf("graphics/film.html"), motionBlur: { on: true, samples: 6 } } as Project;
  const session = await openFrameSession(FFMPEG, project, () => "", new Map([["graphics/film.html", BREAKS]]), new AbortController().signal);
  try {
    // A few scattered frames, as render_frames draws them, never reach it.
    await assert.doesNotReject(session.render([0, 100, 200], W));
    const x = await session.rehearse(60_000);
    assert.match(x.failure ?? "", new RegExp(`\\(its frame ${BREAK_AT}\\).*detached`));
  } finally {
    await session.close();
  }
});
