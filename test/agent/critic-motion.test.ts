// D292: the critic sees motion. Pure parts: the anchors (storyboard beats, else every 2 s, at most
// six), the strips (six frames 1/12 s apart around each anchor), the scan plan (every frame when it
// fits the budget, else windows around the anchors plus an even sampling, bounded), the scan itself
// on synthetic grey frames (a single-frame pop, a one-frame jump, a hold over 1 s, the loop seam),
// the findings (pops always; jumps and holds for a one-take film; the seam for a loop), the critic's
// <motion> block and the rubric line, and pops becoming review defects. With the desktop built: a
// synthetic graphic (uncut:lib/motion.js springs, one white flash frame, one hard jump) rendered
// like review_submit renders it, decoded by ffmpeg, scanned: the flash is the pop, the jump is the
// jump; a strip draws as one small image.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { CRITIC_SYSTEM, criticReview, criticText, type CriticFinding, type CriticInput } from "../../apps/server/src/agent/agentCritic.ts";
import { frameDiff, grayFrames, MAX_STRIPS, motionAnchors, motionFindings, motionIntent, motionLines, motionScan, SCAN_BUDGET, scanPlan, scanSize, STRIP_CELL, stripLayout, stripPlan } from "../../apps/server/src/agent/criticMotion.ts";
import { drawSheet } from "../../apps/server/src/export/exporter/sheets.ts";
import { renderFramesWith } from "../../apps/server/src/export/exporter/frames.ts";
import { loadGraphicLibs } from "../../apps/server/src/export/graphicLibs.ts";
import { resolveGraphicLibs, type Project } from "../../packages/core/src/index.ts";

const DESKTOP = resolve("apps/desktop/dist/main.cjs");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(DESKTOP) ? "desktop not built (run pnpm build)" : hasFfmpeg ? false : "needs ffmpeg";

test("anchors, strips and the scan plan stay bounded", () => {
  const fps = 60;
  const duration = 30 * fps;
  const beats = Array.from({ length: 15 }, (_, i) => ({ start: i * 2, title: `s${i}` }));
  const anchors = motionAnchors(beats, fps, duration);
  assert.equal(anchors.length, MAX_STRIPS);
  assert.equal(anchors[0]!.frame, 0);
  assert.equal(anchors.at(-1)!.frame, 28 * fps, "the last beat is in");
  assert.deepEqual(motionAnchors(undefined, 30, 150).map((a) => a.frame), [0, 60, 120], "no storyboard: every 2 s");
  const strips = stripPlan(anchors, fps, duration);
  for (const s of strips) {
    assert.equal(s.frames.length, 6);
    for (let i = 1; i < 6; i++) assert.equal(s.frames[i]! - s.frames[i - 1]!, 5, "1/12 s apart at 60 fps");
    assert.ok(s.frames.every((f) => f >= 0 && f < duration));
  }
  assert.equal(strips[1]!.at, 6 * fps, "beats picked evenly");
  assert.deepEqual(strips[1]!.frames, [350, 355, 360, 365, 370, 375], "two before the anchor, the rest after");
  assert.deepEqual(stripPlan([{ frame: 0, label: "x" }], 30, 100)[0]!.frames, [0, 3, 6, 9, 12, 15], "clamped at the start");
  assert.deepEqual(stripPlan([{ frame: 99, label: "x" }], 30, 100)[0]!.frames, [84, 87, 90, 93, 96, 99], "clamped at the end");
  const plan = scanPlan(anchors, fps, duration);
  assert.ok(plan.length <= SCAN_BUDGET + 8, `${plan.length} frames`);
  for (const a of anchors) for (let d = -5; d <= 5; d++) if (a.frame + d >= 0) assert.ok(plan.includes(a.frame + d), `around ${a.frame}`);
  assert.ok(plan.includes(0) && plan.includes(duration - 1));
  assert.deepEqual(scanPlan(anchors, 30, 90), Array.from({ length: 90 }, (_, i) => i), "a short film: every frame");
  // A strip's sheet is one downscaled row.
  const l = stripLayout(6, 1080 / 1350);
  assert.equal(l.rows, 1);
  assert.equal(l.cellWidth, STRIP_CELL);
  assert.ok(l.width < 1300 && l.height < 320, `${l.width}x${l.height}`);
});

/** A synthetic film in grey frames: a smooth ramp, with a flash, a jump and a hold where asked. */
function film(n: number, o: { pop?: number; jump?: number; holdFrom?: number; holdTo?: number }) {
  const size = 64 * 80;
  const out: Array<{ frame: number; gray: Uint8Array }> = [];
  let shift = 0;
  for (let f = 0; f < n; f++) {
    if (o.jump !== undefined && f === o.jump) shift = 120;
    const moving = !(o.holdFrom !== undefined && f >= o.holdFrom && f <= o.holdTo!);
    const k = moving ? f : o.holdFrom!;
    const g = new Uint8Array(size);
    for (let i = 0; i < size; i++) g[i] = (((i % 64) * 2 + k * 3 + shift) % 200) + 20;
    if (f === o.pop) g.fill(250);
    out.push({ frame: f, gray: g });
  }
  return out;
}

test("the scan: a flash frame is a pop, a hard switch a jump, a still stretch a hold, the seam measured", () => {
  const fps = 30;
  const scan = motionScan(film(100, { pop: 20, jump: 50, holdFrom: 60, holdTo: 99 }), fps);
  assert.deepEqual(scan.pops.map((p) => p.frame), [20]);
  assert.ok(scan.pops[0]!.ratio >= 3);
  assert.deepEqual(scan.jumps.map((j) => j.frame), [50]);
  assert.deepEqual(scan.holds, [{ start: 60, end: 99 }]);
  assert.deepEqual(motionScan(film(100, { holdFrom: 60, holdTo: 89 }), fps).holds, [], "29 frames at 30 fps is under a second");
  assert.ok(scan.seam && scan.seam.diff > 0.05, "the last frame isn't the first");
  // A clean ramp: nothing.
  const clean = motionScan(film(60, {}), fps);
  assert.deepEqual([clean.pops.length, clean.jumps.length, clean.holds.length], [0, 0, 0]);
  // Pure: the same frames in another order, the same answer.
  assert.deepEqual(motionScan([...film(100, { pop: 20, jump: 50, holdFrom: 60, holdTo: 99 })].reverse(), fps), scan);
  // Sparse samples aren't judged for pops (a pop needs both neighbours).
  assert.deepEqual(motionScan(film(90, { pop: 20 }).filter((x) => x.frame % 2 === 0 || x.frame === 21), fps).pops, []);
  assert.equal(frameDiff(new Uint8Array([0, 255]), new Uint8Array([255, 255])), 0.5);

  // Findings: the pop always; the jump and hold only in a one-take film; the seam only for a loop.
  const plain = motionFindings(scan, fps);
  assert.deepEqual(plain.map((f) => f.key), ["motion:pop:20"]);
  const oneTake = motionFindings(scan, fps, { oneTake: true, loop: true });
  assert.deepEqual(oneTake.map((f) => f.key), ["motion:pop:20", "motion:jump:50", "motion:hold:60", "motion:seam:0"]);
  assert.ok(oneTake.every((f) => f.rule === "motion" && !f.hard));
  assert.deepEqual(motionIntent({ skills: ["motion-film"], words: "" }), { oneTake: true, loop: true });
  assert.deepEqual(motionIntent({ skills: [], words: "A launch film, one take, never cut" }), { oneTake: true, loop: false });
  assert.deepEqual(motionIntent({ skills: [], words: "a product demo" }), { oneTake: false, loop: false });
  const lines = motionLines(scan, fps, { consecutive: true });
  assert.match(lines.join("\n"), /Single-frame pops: f 20 \(0\.67 s/);
  assert.match(lines.join("\n"), /Holds over 1 s with nothing changing: f 60 to f 99/);
  assert.match(lines.join("\n"), /Loop seam: .* a visible jump if it loops/);
});

test("the critic gets the strips and the scan in <motion>; pops become review defects of kind motion", () => {
  const scan = motionScan(film(90, { pop: 20 }), 30);
  const checks: Array<CriticFinding> = motionFindings(scan, 30);
  const input: CriticInput = {
    round: 1,
    canvas: { width: 1080, height: 1350, fps: 30 },
    frames: 90,
    kit: [],
    claims: [],
    checks,
    determinism: { checked: [], differed: [] },
    images: [{ label: "frame strip around beat 1 (f 0, 0.00 s): frames 0, 3, 6, 9, 12, 15 left to right, 83 ms apart", jpeg: Buffer.from("x") }],
    motion: { lines: motionLines(scan, 30, { consecutive: true }), strips: 1 },
  };
  const text = criticText(input);
  const block = /<motion>\n([\s\S]*?)\n<\/motion>/.exec(text)?.[1] ?? "";
  assert.match(block, /Frame-difference scan of 90 small grey frames \(every frame\)/);
  assert.match(block, /1 frame strip among the images/);
  assert.match(block, /f 20: Single-frame pop at f 20/);
  assert.doesNotMatch(text, /<layout-checks>/, "motion findings aren't layout checks");
  assert.match(text, /Image 1: frame strip around beat 1/);
  assert.match(CRITIC_SYSTEM, /frame strips/);
  assert.match(CRITIC_SYSTEM, /single-frame|a frame unlike both its neighbours/);
  assert.match(text, /changes land on the music's beats, no single-frame pops, no hold over 1 s/, "the rubric judges timing, pops, holds and the seam");
  const answer = { scores: { hook: 9, readability: 9, motion: 9, variety: 9, sound: 9, brand: 9 }, evidence: {}, blockers: [], defects: [], fixes: [], summary: "", unproven: [] };
  const review = criticReview(answer, { round: 1, claims: [], checks, determinism: { checked: [], differed: [] }, looked: { sheet: true, phone: true }, revision: 1, turnId: "t", fps: 30 });
  const pop = review.defects.find((d) => (d as { kind?: string }).kind === "motion");
  assert.ok(pop, "the pop is a defect");
  assert.equal((pop as { rule?: string }).rule, "motion:pop", "Intended can match it by its rule family");
  assert.equal(pop!.at, 0.67);
  assert.equal(review.blockers?.length ?? 0, 0, "a pop is a defect, not a blocker");
});

const POP_GRAPHIC = `<div id="bg" style="position:absolute;inset:0;background:#e9e7e2"></div>
<div id="box" style="position:absolute;left:0;top:150px;width:120px;height:120px;border-radius:24px;background:#111"></div>
<div id="flash" style="position:absolute;inset:0;background:#fff;display:none"></div>
<script src="uncut:lib/motion.js"></script>
<script>
window.render = (t, info) => {
  const x = uncutMotion.springs(t, [{ at: 0, to: 20 }, { at: 0.1, to: 160 }], "spring.settle") + (info.frame >= 24 ? 120 : 0);
  document.getElementById("box").style.transform = "translateX(" + x + "px)";
  document.getElementById("flash").style.display = info.frame === 12 ? "block" : "none";
};
</script>`;

test("a synthetic graphic rendered like review_submit renders it: the flash frame is the pop, the jump the jump; a strip is one small image", { skip, timeout: 180000 }, async () => {
  const libs = await loadGraphicLibs(resolve("assets/graphic-libs"));
  const project = {
    format: "uncut/0",
    name: "Pop",
    canvas: { width: 400, height: 500, fps: 30 },
    media: [],
    tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "g", type: "graphic", src: "graphics/pop.html", start: 0, duration: 36 }] }],
  } as unknown as Project;
  const graphics = new Map([["graphics/pop.html", resolveGraphicLibs(POP_GRAPHIC, libs)]]);
  const frames = Array.from({ length: 36 }, (_, i) => i);
  const rendered = await renderFramesWith("ffmpeg", project, () => "", graphics, frames, 96, new AbortController().signal);
  assert.equal(rendered.length, 36);
  const { w, h } = scanSize(project.canvas);
  assert.deepEqual([w, h], [64, 80]);
  const grays = await grayFrames("ffmpeg", rendered.map((f) => f.jpeg), w, h);
  assert.equal(grays.length, 36);
  const scan = motionScan(rendered.map((f, i) => ({ frame: f.frame, gray: grays[i]! })), 30);
  assert.deepEqual(scan.pops.map((p) => p.frame), [12], JSON.stringify(scan.pops));
  assert.deepEqual(scan.jumps.map((j) => j.frame), [24], JSON.stringify(scan.jumps));
  // The same frames twice decode to the same greys (deterministic graphic, deterministic scan).
  const again = await grayFrames("ffmpeg", rendered.map((f) => f.jpeg), w, h);
  assert.deepEqual(again.map((g) => Buffer.from(g).toString("base64")), grays.map((g) => Buffer.from(g).toString("base64")));
  // A strip: six frames around the jump as one downscaled image.
  const strip = stripPlan([{ frame: 24, label: "beat 2" }], 30, 36)[0]!;
  const cells = strip.frames.map((f) => ({ jpeg: rendered[f]!.jpeg, caption: `f ${f}` }));
  const layout = stripLayout(cells.length, 400 / 500);
  const sheet = await drawSheet(cells, layout);
  assert.equal(sheet[0], 0xff);
  assert.equal(sheet[1], 0xd8, "a JPEG");
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", "-i", "-"], { input: sheet, encoding: "utf8" });
  assert.equal(probe.stdout.trim(), `${layout.width},${layout.height}`);
});
