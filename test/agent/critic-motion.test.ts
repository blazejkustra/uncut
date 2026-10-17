// D292: the critic sees motion. Pure parts: the anchors (storyboard beats, else every 2 s, at most
// six), the strips (six frames 1/12 s apart around each anchor), the scan plan (every frame when it
// fits the budget, else windows around the anchors plus an even sampling, bounded), the scan itself
// on synthetic grey frames (a single-frame pop, a one-frame jump, a hold over 1 s, the loop seam),
// the findings (pops always; jumps and holds for a one-take film; the seam for a loop), the critic's
// <motion> block and the rubric line, and pops becoming review defects. With the desktop built: a
// synthetic graphic (uncut:lib/motion.js springs, one white flash frame, one hard jump) rendered
// like review_submit renders it, decoded by ffmpeg, scanned: the flash is the pop, the jump is the
// jump; a strip draws as one small image. The render order and the time budget (a stubbed slow
// renderer on a fake clock): strips and scene-change windows first, the scan cut short and saying so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { agreeingNotes, CRITIC_SYSTEM, criticReview, criticText, type CriticFinding, type CriticInput } from "../../apps/server/src/agent/agentCritic.ts";
import { EMPTY_CONTENT, THIN_FLAT, THIN_TALL, THIN_WIDTH, thinMeasure, thinRuns, emptyMeasure, emptySize, emptyRuns, type ScanFrame, FAST_STEP, nearlyEmpty, OPEN_MAX_S, refineEmpty, JUMP_OVER, refineJumps, beatWordLines, beatWords, canvasShare, dropBeat, dropLine, FLAT_MAX, flatFindings, flatFraction, flatLines, budgetLine, frameDiff, grayFrames, MAX_STRIPS, motionAnchors, motionFindings, motionFrames, motionIntent, motionLines, motionRenderOrder, motionScan, SCAN_BUDGET, SCAN_WINDOW, scanPlan, scanSize, STRIP_CELL, stripLayout, stripPlan, blurPicks, BLUR_CELL } from "../../apps/server/src/agent/criticMotion.ts";
import { drawSheet } from "../../apps/server/src/export/exporter/sheets.ts";
import { openFrameSession, renderFramesWith } from "../../apps/server/src/export/exporter/frames.ts";
import { loadGraphicLibs } from "../../apps/server/src/export/graphicLibs.ts";
import { resolveGraphicLibs, type Project } from "../../packages/core/src/index.ts";
import { blurStripLabel, criticSkills, runFacts, UNMEASURED } from "../../apps/server/src/agent/tools/cards.ts";
import { reviewRubric as rubricOf, soundProfileFor, suggestSkills as suggestOf } from "../../packages/core/src/skills/skills.ts";
import { soundProfileText } from "../../packages/core/src/checks/soundSheet.ts";
import { skillOfPlugin } from "../../apps/server/src/brand/store.ts";

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
  // D297: in a motion film pops, jumps (cuts) and the seam are blockers; a hold stays a finding.
  const filmFound = motionFindings(scan, fps, { oneTake: true, loop: true, hard: true });
  assert.deepEqual(filmFound.filter((f) => f.hard).map((f) => f.key), ["motion:pop:20", "motion:jump:50", "motion:seam:0"]);
  assert.ok(!filmFound.find((f) => f.key === "motion:hold:60")!.hard);
  // Since the ablations cut the skill, it no longer prescribes a loop: only the brief's words ask for one.
  assert.deepEqual(motionIntent({ skills: ["motion-film"], words: "" }), { oneTake: true, loop: false, footage: false });
  assert.equal(motionIntent({ skills: ["motion-film"], words: "a seamless loop" }).loop, true);
  assert.deepEqual(motionIntent({ skills: [], words: "A launch film, one take, never cut" }), { oneTake: true, loop: false, footage: false });
  assert.deepEqual(motionIntent({ skills: [], words: "a product demo" }), { oneTake: false, loop: false, footage: false });
  assert.equal(motionIntent({ skills: ["motion-film"], words: "DJI 0050 drone footage" }).footage, true);
  assert.equal(motionIntent({ skills: [], words: "", hasFootage: true }).footage, true);
  const lines = motionLines(scan, fps, { consecutive: true });
  assert.match(lines.join("\n"), /Single-frame pops and flashes \([^)]*\): f 20 \(0\.67 s/);
  assert.match(lines.join("\n"), /Holds over 1 s with nothing changing: f 60 to f 99/);
  assert.match(lines.join("\n"), /Loop seam: .* a visible jump if it loops/);
});

// A1r8 (12.98 and 15.48 s): the next shot drawn whole for two frames before its grow began, then the
// old shot again. A pop needs one frame and a jump a picture that stays: a flash is its own rule.
test("the scan: a 2-frame flash (the picture goes back) is a pop with a span; a cut and back later, a longer run, a cut are not", () => {
  const fps = 60;
  const size = 64 * 80;
  // The old shot drifting slowly; `other` frames show a different shot (another texture).
  const shots = (n: number, other: (f: number) => boolean) => Array.from({ length: n }, (_, f) => {
    const g = new Uint8Array(size);
    for (let i = 0; i < size; i++) g[i] = other(f) ? (((i >> 6) * 7 + (i % 64) * 5) % 180) + 40 : (((i % 64) * 2 + f) % 200) + 20;
    return { frame: f, gray: g };
  });
  const flash = motionScan(shots(90, (f) => f === 30 || f === 31), fps);
  assert.deepEqual(flash.pops.map((p) => [p.frame, p.span]), [[30, 2]]);
  assert.ok(flash.pops[0]!.ratio >= 3);
  assert.deepEqual(flash.jumps, [], "its edges aren't jumps");
  const found = motionFindings(flash, fps, { oneTake: true, hard: true });
  assert.deepEqual(found.map((f) => [f.key, f.hard]), [["motion:pop:30", true]]);
  assert.match(found[0]!.message, /2-frame flash at f 30 to f 31 \(0\.50 s\)/);
  assert.deepEqual(found[0]!.range, { start: 30, end: 31 });
  assert.match(motionLines(flash, fps, { consecutive: true }).join("\n"), /f 30 to f 31 \(0\.50 s/);
  // Three frames at 60 fps still flash (0.05 s); four are a shot, its in and out two jumps.
  assert.deepEqual(motionScan(shots(90, (f) => f >= 30 && f <= 32), fps).pops.map((p) => p.span), [3]);
  const four = motionScan(shots(90, (f) => f >= 30 && f <= 33), fps);
  assert.deepEqual([four.pops.length, four.jumps.map((j) => j.frame)], [0, [30, 34]]);
  // A cut that stays: a jump, no flash. A single frame: still the plain pop.
  const cut = motionScan(shots(90, (f) => f >= 30), fps);
  assert.deepEqual([cut.pops.length, cut.jumps.map((j) => j.frame)], [0, [30]]);
  assert.deepEqual(motionScan(shots(90, (f) => f === 30), fps).pops.map((p) => [p.frame, p.span]), [[30, undefined]]);
  // Sparse samples (the frames before and after missing) aren't judged.
  assert.deepEqual(motionScan(shots(90, (f) => f === 30 || f === 31).filter((x) => x.frame !== 29), fps).pops, []);
});

test("the scan: a sampled frame of a 2-frame flash is narrowed by refineJumps and found (A1r8: f 780 and 930 were samples)", async () => {
  const fps = 60;
  const size = 64 * 80;
  const all = Array.from({ length: 120 }, (_, f) => {
    const g = new Uint8Array(size);
    const other = f === 79 || f === 80;
    for (let i = 0; i < size; i++) g[i] = other ? (((i >> 6) * 7 + (i % 64) * 5) % 180) + 40 : (((i % 64) * 2 + f) % 200) + 20;
    return { frame: f, gray: g };
  });
  const sampled = all.filter((x) => x.frame % 10 === 0);
  assert.deepEqual(motionScan(sampled, fps).pops, [], "samples alone can't judge it");
  const added = await refineJumps({ frames: sampled, fps, duration: all.length, render: async (fs) => fs.map((f) => all[f]!) });
  assert.deepEqual(motionScan([...sampled, ...added], fps).pops.map((p) => [p.frame, p.span]), [[79, 2]]);
});

// Blind round 3: the references' first real change lands by 0.6 s; Uncut's light films drifted under a
// still hook for 1.5 to 1.9 s and read as static. A drift is not a change; a sampling every 0.15 s
// measures the same as every frame; a soft finding in a one-take film only.
test("the open: the first real change is measured; later than a second is a static open in a one-take film", () => {
  const fps = 60;
  const size = 64 * 80;
  // A big shape under a slow drift (one grey level every 15 frames), then (from `at`) sliding 2 px a frame.
  const opening = (at: number, n = 180) => Array.from({ length: n }, (_, f) => {
    const x = Math.max(0, f - at) * 2;
    const lift = Math.floor(Math.min(f, at) / 15);
    const g = new Uint8Array(size);
    for (let i = 0; i < size; i++) g[i] = ((i % 64) >= 10 + x && (i % 64) < 30 + x ? 200 : 30) + lift;
    return { frame: f, gray: g };
  });
  const lively = motionScan(opening(30), fps);
  assert.ok(lively.open && lively.open.frame! <= 40 && lively.open.frame! >= 30, JSON.stringify(lively.open));
  assert.ok(!motionFindings(lively, fps, { oneTake: true }).some((f) => f.key === "motion:open:0"));
  const late = motionScan(opening(100), fps);
  assert.ok(late.open!.frame! > OPEN_MAX_S * fps && late.open!.peak < 0.015, JSON.stringify(late.open));
  const sampled = motionScan(opening(100).filter((x) => x.frame <= 5 || x.frame % 9 === 0), fps);
  assert.ok(Math.abs(sampled.open!.frame! - late.open!.frame!) <= 9, "a 0.15 s sampling lands within a sample of every frame");
  const found = motionFindings(late, fps, { oneTake: true, hard: true }).find((f) => f.key === "motion:open:0")!;
  assert.ok(found && !found.hard && found.range!.start === 0, "a finding, never a blocker");
  assert.match(found.message, /static open: the first real change lands at f \d+ \(1\.\d\d s\)/);
  assert.ok(!motionFindings(late, fps).some((f) => f.key === "motion:open:0"), "not one take: no finding");
  assert.match(motionLines(late, fps, { consecutive: true }).join("\n"), /The open: the first real change .* a static open\./);
  assert.match(motionLines(lively, fps, { consecutive: true }).join("\n"), /The open: the first real change .* lands at f \d+ \(0\.\d\d s\)\./);
  // Nothing at all in the first 2 s; samples that stop before a second measure nothing.
  assert.equal(motionScan(opening(500, 130), fps).open!.frame, undefined);
  assert.match(motionFindings(motionScan(opening(500, 130), fps), fps, { oneTake: true }).find((f) => f.key === "motion:open:0")!.message, /nothing really changes in the first 2 s/);
  assert.equal(motionScan(opening(30, 50), fps).open, undefined);
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
  assert.match(text, /changes land on the music's beats, no single-frame pops or few-frame flashes, no hold over 1 s/, "the rubric judges timing, pops, holds and the seam");
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

// D296: scale. A grey frame (64 × 80) with a textured "footage" card on flat black, or full-bleed.
function card(w: number, h: number, cover: number, seed = 1) {
  const g = new Uint8Array(w * h).fill(10);
  const cw = Math.round(w * Math.sqrt(cover));
  const ch = Math.round(h * Math.sqrt(cover));
  const x0 = (w - cw) >> 1;
  const y0 = (h - ch) >> 1;
  let x = seed;
  for (let y = y0; y < y0 + ch; y++)
    for (let i = x0; i < x0 + cw; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      g[y * w + i] = 60 + (x % 140);
    }
  return g;
}

test("D296: flat background share, the scale finding for footage-first films, the storyboard's words", () => {
  const w = 64;
  const h = 80;
  const small = flatFraction(card(w, h, 0.45), w, h);
  assert.ok(Math.abs(small - 0.55) < 0.05, `a card covering 45 %: ${small}`);
  assert.ok(flatFraction(card(w, h, 1), w, h) < 0.05, "full-bleed footage");
  assert.ok(flatFraction(new Uint8Array(w * h).fill(200), w, h) > 0.99, "a flat frame");
  // A smooth gradient (a sky) isn't one flat colour.
  const sky = Uint8Array.from({ length: w * h }, (_, i) => Math.floor(i / w) * 3);
  assert.ok(flatFraction(sky, w, h) < 0.2, `a gradient: ${flatFraction(sky, w, h)}`);
  const strips = [0.55, 0.6, 0.1, 0.5].map((flat, i) => ({ label: `beat ${i + 1}`, at: i * 120, flat }));
  const found = flatFindings(strips, 60, true);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, "scale");
  assert.match(found[0]!.message, /3 of 4 scene changes \(worst 60 % at 2\.00 s\)[\s\S]*70 %/);
  assert.deepEqual(flatFindings(strips, 60, false), [], "not footage first: no finding");
  assert.deepEqual(flatFindings(strips.map((x) => ({ ...x, flat: 0.2 })), 60, true), []);
  assert.match(flatLines(strips, 60, true).join("\n"), /beat 1 \(0\.00 s\) 55 %[\s\S]*Over 35 % at 3 of 4 strips/);
  assert.equal(FLAT_MAX, 0.35);
  // The words a beat says it shows, from its quotes (straight, curly, single).
  assert.deepEqual(beatWords({ title: "Open: the claim", entry: "Coastal road in the card, Uncut mark, 'Edit videos by talking to an agent'", exit: "“Free and open source” rises; the user's car" }), ["Edit videos by talking to an agent", "Free and open source"]);
  assert.deepEqual(beatWords({ entry: 'The line "Hands every change back to you" rises' }), ["Hands every change back to you"]);
  const lines = beatWordLines([{ start: 0, end: 2.5, entry: "'Edit videos'" }, { start: 2.5, end: 4, entry: "no words" }]);
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /^beat 1 \(0 s to 2\.5 s\): "Edit videos"$/);
  assert.match(CRITIC_SYSTEM, /over 35 % at most scene changes[\s\S]*storyboard's words/);
});

test("render order: the strips' frames and the scene changes' windows first, then the rest of the scan, each once", () => {
  const fps = 60;
  const duration = 30 * fps;
  const anchors = motionAnchors([{ start: 0 }, { start: 10 }, { start: 20 }], fps, duration);
  const strips = stripPlan(anchors, fps, duration);
  const scanList = scanPlan(anchors, fps, duration);
  const order = motionRenderOrder(strips, scanList, anchors, duration);
  assert.equal(new Set(order).size, order.length, "each frame once");
  const want = new Set([...strips.flatMap((s) => s.frames), ...scanList]);
  assert.deepEqual([...order].sort((a, b) => a - b), [...want].sort((a, b) => a - b), "the union of both");
  const firstPart = order.slice(0, order.findIndex((f, i) => i > 0 && f < order[i - 1]!));
  for (const a of anchors) for (let d = -SCAN_WINDOW; d <= SCAN_WINDOW; d++) if (a.frame + d >= 0) assert.ok(firstPart.includes(a.frame + d), `f ${a.frame + d} near ${a.label} comes first`);
  for (const s of strips) for (const f of s.frames) assert.ok(firstPart.includes(f));
  assert.ok(firstPart.includes(duration - 1) && firstPart.includes(duration - 2), "the seam's frames come first");
});

test("the time budget: a slow renderer is stopped, the scan runs on what was rendered and says how much", async () => {
  const fps = 60;
  const duration = 30 * fps;
  const anchors = motionAnchors([{ start: 0 }, { start: 10 }, { start: 20 }], fps, duration);
  const strips = stripPlan(anchors, fps, duration);
  const scanList = scanPlan(anchors, fps, duration);
  // A fake clock and a renderer that takes 300 ms a frame and asks `until` before each.
  let clock = 1000;
  const render = async (frames: ReadonlyArray<number>, until: () => boolean) => {
    {
      const out: Array<{ frame: number; jpeg: Buffer }> = [];
      for (const frame of frames) {
        if (until()) break;
        clock += 300;
        out.push({ frame, jpeg: Buffer.from([frame & 255]) });
      }
      return out;
    }
  };
  const got = await motionFrames({ strips, scanList, anchors, duration, render, budgetMs: 15_000, now: () => clock });
  assert.equal(got.cut, true);
  assert.equal(got.byFrame.size, 51, "frames until 15 s had gone by: 51 at 300 ms (the 51st starts at exactly 15 s)");
  assert.equal(got.planned, scanList.length);
  assert.ok(got.scanned.length < scanList.length && got.scanned.length > 0);
  for (const a of anchors) assert.ok(got.scanned.includes(a.frame) && got.scanned.includes(Math.min(duration - 1, a.frame + 1)), `the scene change at f ${a.frame} is covered`);
  for (const s of strips) for (const f of s.frames) assert.ok(got.byFrame.has(f), `strip frame ${f} rendered`);
  // The scan on those frames says it was cut short, with the words the tool result uses.
  const scan = motionScan(got.scanned.map((f) => ({ frame: f, gray: new Uint8Array(16).fill(f % 7) })), fps);
  const lines = motionLines(scan, fps, { consecutive: false, planned: got.planned });
  assert.equal(lines[0], budgetLine(got.scanned.length, got.planned));
  assert.match(lines[0]!, new RegExp(`frame-difference scan covered ${got.scanned.length} of ${scanList.length} frames: time budget`, "i"));
  // A fast renderer isn't cut: every frame, no budget line.
  clock = 0;
  const fast = await motionFrames({ strips, scanList, anchors, duration, render: async (frames, until) => frames.flatMap((frame) => (until() ? [] : [{ frame, jpeg: Buffer.alloc(1) }])), budgetMs: 15_000, now: () => clock });
  assert.equal(fast.cut, false);
  assert.equal(fast.scanned.length, scanList.length);
  const full = motionScan(fast.scanned.map((f) => ({ frame: f, gray: new Uint8Array(16) })), fps);
  assert.ok(!motionLines(full, fps, { consecutive: false, planned: fast.planned }).some((l) => /time budget/.test(l)));
});

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
  // As review_submit renders them (D292): one session, the capture shrunk by the rasteriser, at the strips' width.
  const session = await openFrameSession("ffmpeg", project, () => "", graphics, new AbortController().signal, undefined, { downscale: true });
  let rendered: Awaited<ReturnType<typeof session.render>>;
  let sessionSheet: Buffer;
  try {
    rendered = await session.render(frames, STRIP_CELL);
    sessionSheet = await session.sheet(rendered.slice(0, 3).map((f) => ({ jpeg: f.jpeg, caption: `f ${f.frame}` })), stripLayout(3, 400 / 500));
    // `until` stops it: frames after it says true aren't rendered.
    let n = 0;
    assert.equal((await session.render(frames, STRIP_CELL, { until: () => n++ >= 4 })).length, 4);
  } finally {
    await session.close();
  }
  assert.equal(rendered.length, 36);
  const sized = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", "-i", "-"], { input: rendered[0]!.jpeg, encoding: "utf8" });
  assert.equal(sized.stdout.trim(), "200,250");
  assert.equal(sessionSheet[1], 0xd8, "the session's sheet is a JPEG");
  // The plain path (render_frames, full-size captures) finds the same.
  const plain = await renderFramesWith("ffmpeg", project, () => "", graphics, frames, 96, new AbortController().signal);
  const plainGrays = await grayFrames("ffmpeg", plain.map((f) => f.jpeg), 64, 80);
  const plainScan = motionScan(plain.map((f, i) => ({ frame: f.frame, gray: plainGrays[i]! })), 30);
  assert.deepEqual([plainScan.pops.map((p) => p.frame), plainScan.jumps.map((j) => j.frame)], [[12], [24]]);
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

// Rehearsal 3 (D297): the drop always gets a strip and a fact; a UI-first film naming its footage
// isn't judged footage first; the canvas around the picture; this run's true facts.
test("D297: the drop's strip and fact, UI-first intent, the canvas around the picture, the run's facts", () => {
  const fps = 60;
  const beats = Array.from({ length: 12 }, (_, i) => ({ start: i * 2, end: i * 2 + 2, title: i === 6 ? "6. Drop: the preview floods" : `${i + 1}. beat`, sound: i === 6 ? "Drop, downbeat 12.0 s" : "beat" }));
  assert.equal(dropBeat(beats), 6);
  assert.equal(dropBeat([{ start: 0, title: "dropdown menu" }]), undefined, "a word, not the drop");
  const anchors = motionAnchors(beats, fps, 24 * fps);
  assert.equal(anchors.length, MAX_STRIPS);
  assert.ok(anchors.some((a) => a.frame === 720), anchors.map((a) => a.frame).join(", "));
  assert.equal(anchors[0]!.frame, 0);
  assert.equal(anchors.at(-1)!.frame, 22 * fps);
  // Around the drop: a flood that already happened vs one landing on it.
  const flat = (v: number) => new Uint8Array(64 * 80).fill(v);
  const frames = (before: number, after: number) => [{ frame: 720 - SCAN_WINDOW, gray: flat(before) }, { frame: 719, gray: flat(after) }, { frame: 720 + SCAN_WINDOW, gray: flat(after) }];
  assert.match(dropLine(frames(20, 200), 720, fps)!, /came before it/);
  const landing = [{ frame: 720 - SCAN_WINDOW, gray: flat(20) }, { frame: 719, gray: flat(20) }, { frame: 720 + SCAN_WINDOW, gray: flat(200) }];
  assert.match(dropLine(landing, 720, fps)!, /lands on it/);
  assert.equal(dropLine([], 720, fps), undefined);
  // Footage words in a UI-first brief don't make it footage first.
  assert.equal(motionIntent({ skills: ["motion-film"], words: "You type into the composer, the agent builds the timeline, the drone footage floods on the drop" }).footage, false);
  assert.equal(motionIntent({ skills: ["motion-film"], words: "A travel film from my drone footage" }).footage, true);
  // Canvas: a framed card on black, a full-bleed noisy picture, a borderless dark panel on black.
  const w = 64, h = 80;
  const card = flat(10);
  for (let y = 10; y < 70; y++) for (let x = 8; x < 56; x++) card[y * w + x] = y === 10 || y === 69 || x === 8 || x === 55 ? 60 : 12;
  const c = canvasShare(card, w, h);
  assert.ok(Math.abs(c.share - (1 - (60 * 48) / (w * h))) < 0.02 && c.level <= 16, JSON.stringify(c));
  let seed = 7;
  const noisy = Uint8Array.from({ length: w * h }, () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), 40 + (seed % 160)));
  assert.ok(canvasShare(noisy, w, h).share < 0.05);
  const borderless = flat(10);
  for (let y = 10; y < 70; y++) for (let x = 8; x < 56; x++) borderless[y * w + x] = 13;
  assert.ok(canvasShare(borderless, w, h).share > 0.95, "dark on dark reads as one canvas");
  const lines = flatLines([{ label: "beat 1", at: 0, flat: 0.5, canvas: 0.3, level: 241 }], fps, false).join("\n");
  assert.match(lines, /beat 1 30 % at grey 241/);
  // The run's facts.
  assert.match(runFacts(12, [{ round: 1, blockers: [1, 2] }, { round: 2, blockers: [] }]), /12 beats; this is review 3 \(before it: round 1: not passed, 2 blockers; round 2: no blockers\)/);
  // Round 2's A1: the exact scores and result of each round, so an in-film score card is checked the same way every round.
  const facts = runFacts(8, [{ round: 1, passed: false, blockers: [1, 2, 3], scores: { hook: 7, readability: 8, motion: 5, variety: 7, brand: 8 } }, { round: 2, passed: true, blockers: [], scores: { hook: 8, readability: 8, motion: 8, variety: 8, brand: 9 } }]);
  assert.match(facts, /round 1: not passed, 3 blockers, scores hook 7, readability 8, motion 5, variety 7, brand 8; round 2: passed, no blockers, scores hook 8/);
  assert.match(facts, /scores shown without its result when it didn't pass/);
  assert.match(runFacts(undefined, []), /no storyboard has been proposed yet .*; this is review 1, the first/);
  assert.match(runFacts(8, []), /the brief asks for X, but this run shows Y/);
  assert.match(CRITIC_SYSTEM, /never against a house style[\s\S]*this run's facts/);
  assert.doesNotMatch(CRITIC_SYSTEM, /one hero element|flat black with a caption/);
});

// D297 (the audit) let the motion film's checklist win; since the ablations cut its creative rules
// every skill's checklist reaches the critic and it has no sound profile of its own. Motion craft
// still isn't suggested with it, and a scan that couldn't run is Uncut's problem, not the video's.
test("D297 after the cut: every checklist reaches the critic, no motion craft with the film, no film sound profile, an unmeasured scan isn't marked down", () => {
  // Built the way the brand state lists them: a plugin skill's name is its id, its title the name shown.
  const skills = ["launch-promo", "motion-craft", "sound-design", "brand-application", "motion-film"].map((name) => skillOfPlugin({ name, title: `The ${name} skill`, description: "", instructions: "", plugin: "uncut-skills", pluginName: "Uncut skills", bundled: true }));
  assert.deepEqual(criticSkills(skills).map((x) => x.id), ["launch-promo", "motion-craft", "sound-design", "brand-application", "motion-film"]);
  assert.deepEqual(criticSkills(skills.slice(0, 3)).map((x) => x.id), ["launch-promo", "motion-craft", "sound-design"]);
  const film = suggestOf({ film: "Our launch film: one take, never cut, a single shape morphing on the beat", type: "launch-promo" });
  assert.ok(film.includes("motion-film") && !film.includes("motion-craft"), film.join(", "));
  assert.ok(suggestOf({ film: "Our launch film", type: "launch-promo" }).includes("motion-craft"));
  assert.equal(soundProfileFor({ film: "x", type: "launch-promo" }, ["sound-design", "motion-film"]), "strict");
  assert.equal(soundProfileFor({ film: "a silent film", type: "launch-promo" }, ["motion-film"]), "off");
  const rubric = rubricOf({ film: "x", type: "launch-promo" }, { skills: ["motion-film"] });
  assert.equal(rubric.sound, soundProfileFor({ film: "x", type: "launch-promo" }), "the type's profile, no film override");
  assert.match(soundProfileText("ui"), /one soft effect per real cursor press, drag or morph/);
  assert.match(UNMEASURED, /don't mark anything down/);
});

// Rehearsal 4 (A1): four hard cuts the scan never saw, three mid-beat and one into a push-in that
// eases out fast. Grey frames like A1's: a cut of 19 % followed by 7 %, 6.8 %, 6.4 %… per frame.
function cutFilm(n: number, cuts: ReadonlyArray<number>, easeAfter: ReadonlyArray<number> = []) {
  const size = 64 * 80;
  const out: Array<{ frame: number; gray: Uint8Array }> = [];
  for (let f = 0; f < n; f++) {
    const shot = cuts.filter((c) => f >= c).length;
    const since = f - Math.max(0, ...cuts.filter((c) => f >= c));
    // A push-in easing out: the picture keeps changing a lot each frame, less every frame.
    // (A1's numbers: the cut changes 19 % of the picture, the frames after it 7 %, 4.4 %, 2.7 %…, so
    // against its busier neighbour the cut is under 3×.) It cuts to the same picture, brighter.
    const into = easeAfter.includes(cuts[shot - 1] ?? -1);
    const eased = into ? Math.round(48 * 0.63 ** since) : 0;
    const look = into ? shot - 1 : shot;
    const g = new Uint8Array(size);
    for (let i = 0; i < size; i++) g[i] = ((((i % 64) * (3 + look * 2) + Math.floor(i / 64) * look * 5 + f) % 100) + 20) + eased;
    out.push({ frame: f, gray: g });
  }
  return out;
}

test("A1: hard cuts between the sampled frames are found, a cut into a fast move too, and smooth motion isn't", async () => {
  const fps = 60;
  const n = 900;
  const cuts = [130, 389, 449, 509];
  const frames = cutFilm(n, cuts, [389]);
  const at = new Map(frames.map((x) => [x.frame, x.gray]));
  // The every-frame scan: every cut, the one into the eased move included (it was judged against the move).
  assert.deepEqual(motionScan(frames, fps).jumps.map((j) => j.frame), cuts);
  const step = (f: number) => frameDiff(at.get(f - 1)!, at.get(f)!);
  assert.ok(step(389) < 3 * step(390) && step(389) >= JUMP_OVER * step(390), `${step(389)} then ${step(390)}: the old rule (3× the busier side) missed it`);
  // As review_submit samples it: anchors at the beats (none near the cuts), windows and an even sampling.
  const anchors = motionAnchors([{ start: 0 }, { start: 4 }, { start: 12 }], fps, n);
  const plan = scanPlan(anchors, fps, n, 80);
  assert.ok(cuts.every((c) => !(plan.includes(c - 1) && plan.includes(c))), "no cut has both its frames sampled");
  const sampled = plan.map((f) => ({ frame: f, gray: at.get(f)! }));
  assert.deepEqual(motionScan(sampled, fps).jumps, [], "the sampling alone misses them (the A1 bug)");
  let calls = 0;
  const added = await refineJumps({ frames: sampled, fps, duration: n, render: async (fs) => (calls++, fs.map((f) => ({ frame: f, gray: at.get(f)! }))) });
  assert.deepEqual(motionScan([...sampled, ...added], fps).jumps.map((j) => j.frame), cuts);
  assert.ok(added.length <= 16 * 10 && calls <= 8, `${added.length} frames in ${calls} renders`);
  // Out of time: it stops, adding nothing more.
  assert.deepEqual(await refineJumps({ frames: sampled, fps, duration: n, until: () => true, render: async () => assert.fail("rendered past the budget") }), []);
  // Smooth motion only: nothing narrowed down is a jump.
  const smooth = cutFilm(n, []);
  const sAt = new Map(smooth.map((x) => [x.frame, x.gray]));
  const sSampled = plan.map((f) => ({ frame: f, gray: sAt.get(f)! }));
  const sAdded = await refineJumps({ frames: sSampled, fps, duration: n, render: async (fs) => fs.map((f) => ({ frame: f, gray: sAt.get(f)! })) });
  assert.deepEqual(motionScan([...sSampled, ...sAdded], fps).jumps, []);
});

test("the card's summary agrees with the round's blockers", () => {
  const unseen = [{ kind: "unverified-fix" }, { kind: "unverified-fix" }, { kind: "unverified-fix" }];
  assert.equal(
    agreeingNotes("No blockers, and the drop, floods and loop seam are strong, but two measured holds over 1 s remain.", unseen),
    "3 blockers (claimed fix not seen ×3). The drop, floods and loop seam are strong, but two measured holds over 1 s remain.",
  );
  assert.equal(agreeingNotes("No blockers remain. Motion is below the bar.", [{ kind: "motion" }]), "1 blocker (motion). Motion is below the bar.");
  assert.equal(agreeingNotes("Clean and on brand.", []), "Clean and on brand.");
  assert.equal(agreeingNotes("The card shows an invented result.", [{ kind: "invented" }]), "1 blocker (invented). The card shows an invented result.");
  // Review: a "no blockers" or stale count mid-sentence takes its whole sentence, not a garbled half.
  assert.equal(agreeingNotes("The film has no blockers but the hook is weak. Motion is good.", [{ kind: "motion" }]), "1 blocker (motion). Motion is good.");
  assert.equal(agreeingNotes("2 blockers remain: the font and the overflow. The drop lands.", [{ kind: "font" }]), "1 blocker (font). The drop lands.");
  assert.equal(agreeingNotes("Two blockers: the font and the overflow. The drop lands.", [{ kind: "font" }, { kind: "overflow" }]), "Two blockers: the font and the overflow. The drop lands.", "a count that agrees stays");
  // Zero final blockers (the user marked them Intended): a stale count goes; nothing left says none.
  assert.equal(agreeingNotes("3 blockers: the font, the overflow and a pop. The drop lands.", []), "The drop lands.");
  assert.equal(agreeingNotes("One blocker remains.", []), "No blockers.");
  assert.equal(agreeingNotes("No blockers. The drop lands.", []), "No blockers. The drop lands.");
  // criticReview: an unverified claim makes a blocker, and the notes say so.
  const review = criticReview(
    { scores: { hook: 8, readability: 8, motion: 8, variety: 8, sound: 8, brand: 8 }, evidence: {}, blockers: [], defects: [], fixes: [{ defect: "d1", verified: false, note: "still holds" }], summary: "No blockers, and it lands.", unproven: [] },
    { round: 3, claims: [{ defect: "d1", what: "moved the cursor", at: 19 }], checks: [], determinism: { checked: [], differed: [] }, looked: { sheet: true, phone: true }, revision: 1, turnId: "t", fps: 60 },
  );
  assert.equal(review.blockers?.length, 1);
  assert.equal(review.notes, "1 blocker (claimed fix not seen). It lands.");
  assert.match(CRITIC_SYSTEM, /never "no blockers" while a claimed fix is unverified/);
  // The brief's scripted facts: honesty first, and the message says what to show instead.
  assert.match(CRITIC_SYSTEM, /"the brief asks for X, but this run shows Y", and give the true version/);
  assert.match(CRITIC_SYSTEM, /a true text that differs from the brief's script is a brand defect/);
});

const CUT_GRAPHIC = `<div id="bg" style="position:absolute;inset:0"></div>
<div id="box" style="position:absolute;left:40px;top:150px;width:160px;height:160px;border-radius:24px"></div>
<script>
const shots = [["#e9e7e2", "#111"], ["#1d3b5a", "#f2c14e"], ["#3a3a3a", "#e05a47"]];
window.render = (t, info) => {
  const k = info.frame >= 151 ? 2 : info.frame >= 70 ? 1 : 0;
  document.getElementById("bg").style.background = shots[k][0];
  const box = document.getElementById("box");
  box.style.background = shots[k][1];
  box.style.transform = "translateX(" + (Math.sin(t * 2) * 60 + 60) + "px)";
};
</script>`;

test("a rendered film with real cuts mid-beat: review_submit's sampling plus the refinement finds each one", { skip, timeout: 180000 }, async () => {
  const libs = await loadGraphicLibs(resolve("assets/graphic-libs"));
  const fps = 30;
  const n = 240;
  const project = { format: "uncut/0", name: "Cuts", canvas: { width: 400, height: 500, fps }, media: [], tracks: [{ id: "main", kind: "video", role: "main", name: "Main", items: [{ id: "g", type: "graphic", src: "graphics/cuts.html", start: 0, duration: n }] }] } as unknown as Project;
  const graphics = new Map([["graphics/cuts.html", resolveGraphicLibs(CUT_GRAPHIC, libs)]]);
  const anchors = motionAnchors([{ start: 0 }, { start: 4 }], fps, n);
  const plan = scanPlan(anchors, fps, n, 60);
  assert.ok(!plan.includes(69) || !plan.includes(70));
  const session = await openFrameSession("ffmpeg", project, () => "", graphics, new AbortController().signal, undefined, { downscale: true });
  try {
    const { w, h } = scanSize(project.canvas);
    const grey = async (frames: ReadonlyArray<number>) => {
      const shot = await session.render(frames, STRIP_CELL);
      const gs = await grayFrames("ffmpeg", shot.map((x) => x.jpeg), w, h);
      return shot.map((x, i) => ({ frame: x.frame, gray: gs[i]! }));
    };
    const sampled = await grey(plan);
    assert.deepEqual(motionScan(sampled, fps).jumps, []);
    const added = await refineJumps({ frames: sampled, fps, duration: n, render: grey });
    const scan = motionScan([...sampled, ...added], fps);
    assert.deepEqual(scan.jumps.map((j) => j.frame), [70, 151], JSON.stringify(scan.jumps));
    assert.deepEqual(scan.pops, []);
  } finally {
    await session.close();
  }
});

// Rehearsal 4: nearly empty frames (A1 22.1-22.5 s cursor only, A2 4.2-4.4 s) block a motion film;
// fast moves that the export's blur stacks into copies (A2 14.0 s) are a finding with the fix.
test("nearly empty stretches are measured to the frame and block a motion film; very fast moves are findings", async () => {
  const fps = 60, w = 64, h = 80, n = 600;
  const canvas = (cursor: boolean) => {
    const g = new Uint8Array(w * h).fill(237);
    if (cursor) for (let y = 40; y < 42; y++) for (let x = 30; x < 32; x++) g[y * w + x] = 10;
    return g;
  };
  const hero = (f: number) => {
    const g = new Uint8Array(w * h).fill(237);
    for (let y = 12; y < 68; y++) for (let x = 8; x < 56; x++) g[y * w + x] = 20 + ((x * 7 + y * 3 + f) % 60);
    return g;
  };
  // Empty from 253 to 266 (0.23 s, cursor only) and from 400 to 405 (0.1 s, too short to count).
  const frameAt = (f: number) => ((f >= 253 && f <= 266) ? canvas(true) : f >= 400 && f <= 405 ? canvas(false) : hero(f));
  assert.ok(nearlyEmpty(canvas(true), w, h) && !nearlyEmpty(hero(0), w, h));
  assert.ok(EMPTY_CONTENT <= 0.02);
  const plan = scanPlan(motionAnchors([{ start: 0 }, { start: 5 }], fps, n), fps, n, 120);
  const sampled = plan.map((f) => ({ frame: f, gray: frameAt(f) }));
  const edges = await refineEmpty({ frames: sampled, fps, size: { w, h }, render: async (fs) => fs.map((f) => ({ frame: f, gray: frameAt(f) })) });
  const scan = motionScan([...sampled, ...edges], fps, { size: { w, h } });
  assert.deepEqual(emptyRuns(scan, fps), [{ start: 253, end: 266 }]);
  const found = motionFindings(scan, fps, { oneTake: true, hard: true });
  const empty = found.find((f) => f.key === "motion:empty:253")!;
  assert.ok(empty.hard, "a blocker in a motion film");
  assert.match(empty.message, /f 253 to f 266 \(4\.22 s to 4\.45 s, 0\.23 s\)/);
  assert.ok(!motionFindings(scan, fps, { oneTake: true }).find((f) => f.key === "motion:empty:253")!.hard, "a finding elsewhere");
  assert.deepEqual(motionFindings(scan, fps).filter((f) => /empty/.test(f.key ?? "")), [], "not one take: no finding");
  assert.match(motionLines(scan, fps, { consecutive: false }).join("\n"), /Nearly empty frames .* f 253 to f 266/);
  // Without the frame size there's no claim either way.
  assert.ok(!motionLines(motionScan(sampled, fps), fps, { consecutive: false }).some((l) => /empty/i.test(l)));
  // A very fast move: 3+ frames each changing more than FAST_STEP; not a jump.
  const fast = Array.from({ length: 40 }, (_, f) => {
    const g = new Uint8Array(w * h);
    const off = f < 20 ? 0 : f < 25 ? (f - 19) * 30 : 150;
    for (let i = 0; i < g.length; i++) g[i] = (((i % w) * 4 + off) % 200) + 20;
    return { frame: f, gray: g };
  });
  const fs = motionScan(fast, fps);
  assert.ok(fs.fast.length === 1 && fs.fast[0]!.peak >= FAST_STEP, JSON.stringify(fs.fast));
  const ff = motionFindings(fs, fps, { oneTake: true, hard: true }).find((f) => f.key?.startsWith("motion:fast:"))!;
  assert.ok(!ff.hard);
  // Round 3: the smear is the move's speed over the shutter; the hint is the peak speed, not a fixed length or more samples.
  assert.match(ff.message, /slow the move's fastest frames \(the ease's peak speed counts, not its length/);
  assert.match(ff.message, /shorten the shutter/);
  assert.match(ff.message, /A smooth blur that keeps the words readable is fine/);
  assert.match(ff.message, /more sub-frames only smooth the copies into a smear/);
});

test("review: the 12-finding cap keeps every blocker (the loop seam) ahead of soft findings", () => {
  const ev = (frame: number) => ({ frame, diff: 0.2, ratio: 9 });
  const scan = {
    frames: 600,
    pops: [10, 20, 30, 40].map(ev),
    jumps: [100, 110, 120, 130].map(ev),
    holds: [{ start: 200, end: 280 }, { start: 300, end: 380 }],
    empty: [{ start: 400, end: 420 }, { start: 450, end: 470 }],
    emptyMeasured: true,
    fast: [{ start: 500, end: 504, peak: 0.1 }, { start: 520, end: 524, peak: 0.1 }, { start: 540, end: 544, peak: 0.1 }],
    seam: { diff: 0.3, typical: 0.01 },
    typical: 0.01,
  };
  const found = motionFindings(scan, 60, { oneTake: true, loop: true, hard: true });
  assert.equal(found.length, 12);
  assert.ok(found.some((f) => f.key === "motion:seam:0" && f.hard), found.map((f) => f.key).join(", "));
  const firstSoft = found.findIndex((f) => !f.hard);
  assert.ok(firstSoft < 0 || found.slice(firstSoft).every((f) => !f.hard), "hard ones lead");
});

// Review of 72a73b9: a canvas share alone flagged a dark full-bleed UI and sat close to a lone
// wordmark. Frames drawn at 1080 × 1350, encoded at the renderer's 200 px and decoded at EMPTY_WIDTH
// like review_submit: only the cursor-only frame is nearly empty.
const W1 = 1080, H1 = 1350;
function drawn(bg: number, paint: (set: (x0: number, y0: number, x1: number, y1: number, v: number) => void) => void) {
  const g = new Uint8Array(W1 * H1).fill(bg);
  paint((x0, y0, x1, y1, v) => {
    for (let y = Math.max(0, y0); y < Math.min(H1, y1); y++) g.fill(v, y * W1 + Math.max(0, x0), y * W1 + Math.min(W1, x1));
  });
  return g;
}
/** A block letter (an H-like glyph: two stems and a bar) at x, y, w × h with stroke s. */
const glyph = (set: (x0: number, y0: number, x1: number, y1: number, v: number) => void, x: number, y: number, w: number, h: number, s: number, v: number) => {
  set(x, y, x + s, y + h, v);
  set(x + w - s, y, x + w, y + h, v);
  set(x, y + (h >> 1) - (s >> 1), x + w, y + (h >> 1) + (s >> 1), v);
};
const FIXTURES: Record<string, Uint8Array> = {
  darkUI: drawn(28, (set) => {
    // Two panels a few levels off the near-black, soft edges, then lines of small light text.
    for (const [x0, y0, x1, y1] of [[40, 60, 1040, 700], [40, 740, 1040, 1300]] as const) {
      set(x0, y0, x1, y1, 30);
      set(x0 + 6, y0 + 6, x1 - 6, y1 - 6, 32);
    }
    for (let line = 0; line < 5; line++) {
      const y = 110 + line * 250;
      let x = 90;
      for (let word = 0; word < 2; word++) {
        const letters = 3 + ((line + word) % 5);
        for (let l = 0; l < letters; l++) glyph(set, x + l * 16, y, 12, 18, 3, 190);
        x += letters * 16 + 22;
      }
    }
  }),
  wordmark: drawn(237, (set) => {
    for (let l = 0; l < 5; l++) glyph(set, 342 + l * 84, 630, 60, 90, 18, 20);
  }),
  headline: drawn(20, (set) => {
    for (let l = 0; l < 4; l++) glyph(set, 40 + l * 255, 470, 220, 400, 60, 240);
  }),
  cursorOnly: drawn(237, (set) => {
    // An arrow cursor with a white outline, near the middle.
    for (let r = 0; r < 34; r++) set(560, 640 + r, 560 + Math.min(24, Math.round(r * 0.75)) + 2, 641 + r, 255);
    for (let r = 2; r < 32; r++) set(562, 640 + r, 562 + Math.min(20, Math.round(r * 0.66)), 641 + r, 15);
  }),
};
const jpegOf = (gray: Uint8Array) => {
  const out = spawnSync("ffmpeg", ["-v", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W1}x${H1}`, "-i", "-", "-vf", "scale=200:-2:flags=area", "-q:v", "4", "-f", "image2pipe", "-c:v", "mjpeg", "-"], { input: gray, maxBuffer: 1 << 26 });
  assert.equal(out.status, 0, String(out.stderr));
  return out.stdout;
};

test("review of 72a73b9: a dark full-bleed UI, a lone wordmark and a huge headline aren't empty; a cursor alone on a light canvas is", { skip: hasFfmpeg ? false : "needs ffmpeg" }, async () => {
  const size = emptySize({ width: W1, height: H1 });
  assert.deepEqual(size, { w: 160, h: 200 });
  const names = Object.keys(FIXTURES);
  const greys = await grayFrames("ffmpeg", names.map((n) => jpegOf(FIXTURES[n]!)), size.w, size.h);
  const m = Object.fromEntries(names.map((n, i) => [n, emptyMeasure(greys[i]!, size.w, size.h)]));
  for (const n of ["darkUI", "wordmark", "headline"]) assert.ok(!m[n]!.empty, `${n}: ${JSON.stringify(m[n])}`);
  assert.ok(m.cursorOnly!.empty, JSON.stringify(m.cursorOnly));
  // The dark UI really is the case the old measure got wrong: at the scan's 64 px its soft panels
  // and its text read as 97.5 % canvas or more.
  const small = scanSize({ width: W1, height: H1 });
  const [dark64] = await grayFrames("ffmpeg", [jpegOf(FIXTURES.darkUI!)], small.w, small.h);
  assert.ok(canvasShare(dark64!, small.w, small.h).share >= 0.975, JSON.stringify(canvasShare(dark64!, small.w, small.h)));
  // The reviewer's probe: soft panels on 28 and 1.5 % of scattered light pixels, at 96 px.
  const w = 96, h = 120, g = new Uint8Array(w * h).fill(28);
  for (let y = 10; y < 110; y++) for (let x = 6; x < 90; x++) g[y * w + x] = x < 8 || x > 87 || y < 12 || y > 107 ? 30 : 32;
  for (let i = 0, lit = 0; i < w * h && lit < w * h * 0.015; i += 67, lit++) g[i] = 60;
  assert.ok(!emptyMeasure(g, w, h).empty);
});

test("review of 72a73b9: refineEmpty samples closer next to a bare frame, edges every stretch (more than 8), and an unrefined run reaches out to its neighbours", async () => {
  const fps = 60, w = 64, h = 80, n = 1200;
  const flat = () => new Uint8Array(w * h).fill(237);
  const cursor = () => {
    const g = flat();
    g[40 * w + 30] = 10;
    return g;
  };
  const hero = (f: number) => {
    const g = flat();
    for (let y = 12; y < 68; y++) for (let x = 8; x < 56; x++) g[y * w + x] = 20 + ((x * 7 + y * 3 + f) % 60);
    return g;
  };
  // A small mark of four letters: bare (under EMPTY_SUSPECT) but not empty.
  const small = () => {
    const g = flat();
    for (let l = 0; l < 4; l++) for (let y = 38; y < 42; y++) g[y * w + 20 + l * 6] = 20;
    return g;
  };
  // 0.25 s empty (131..145) right after a small mark (100..130): both between samples 0.5 s apart.
  const at1 = (f: number) => (f >= 131 && f <= 145 ? cursor() : f >= 100 && f <= 130 ? small() : hero(f));
  const sparse = Array.from({ length: n / 30 }, (_, i) => i * 30).map((f) => ({ frame: f, gray: at1(f) }));
  const render1 = async (fs: ReadonlyArray<number>) => fs.map((f) => ({ frame: f, gray: at1(f) }));
  assert.deepEqual(emptyRuns(motionScan(sparse, fps, { size: { w, h } }), fps), [], "the samples alone miss it");
  const found1 = await refineEmpty({ frames: sparse, fps, size: { w, h }, render: render1, duration: n });
  assert.deepEqual(emptyRuns(motionScan([...sparse, ...found1], fps, { size: { w, h } }), fps), [{ start: 131, end: 145 }]);
  // Ten empty stretches: every edge narrowed (the old cap was 8 edges).
  const stretch = (f: number) => f % 100 >= 40 && f % 100 <= 59;
  const at2 = (f: number) => (stretch(f) ? cursor() : hero(f));
  const samples2 = Array.from({ length: n / 15 }, (_, i) => i * 15).map((f) => ({ frame: f, gray: at2(f) }));
  const found2 = await refineEmpty({ frames: samples2, fps, size: { w, h }, render: async (fs) => fs.map((f) => ({ frame: f, gray: at2(f) })), duration: n });
  const runs2 = emptyRuns(motionScan([...samples2, ...found2], fps, { size: { w, h } }), fps);
  assert.equal(runs2.length, 12);
  assert.ok(runs2.every((r) => !r.upto && r.start % 100 === 40 && r.end % 100 === 59), JSON.stringify(runs2));
  // Out of time: one empty sample between non-empty ones 9 frames away may be 17 frames long.
  const at3 = (f: number) => (f >= 300 && f <= 305 ? cursor() : hero(f));
  const samples3: Array<ScanFrame> = [291, 300, 309].map((f) => ({ frame: f, gray: at3(f) }));
  const scan3 = motionScan(samples3, fps, { size: { w, h } });
  assert.deepEqual(scan3.empty, [{ start: 300, end: 300, upto: { start: 292, end: 308 } }]);
  assert.equal(emptyRuns(scan3, fps).length, 1);
  const f3 = motionFindings(scan3, fps, { oneTake: true, hard: true }).find((f) => f.key === "motion:empty:300")!;
  assert.ok(!f3.hard && /Maybe a nearly empty frame.*up to 0\.28 s/.test(f3.message), f3.message);
  assert.match(motionLines(scan3, fps, { consecutive: false }).join("\n"), /maybe f 292 to f 308/);
  // A precomputed emptiness (the larger grey) wins over the scan-size grey.
  const sure: ScanFrame = { frame: 0, gray: hero(0), bare: { content: 0.001, parts: 1, empty: true } };
  assert.equal(motionScan([sure, { frame: 1, gray: hero(1), bare: { content: 0.5, parts: 9, empty: false } }], fps).empty.length, 1);
});


test("round 2's A1: the fast moves get a strip drawn with the export's blur, and the critic is told what to look for", () => {
  const picks = blurPicks([{ start: 361, end: 364, peak: 0.07 }, { start: 721, end: 725, peak: 0.09 }, { start: 10, end: 11, peak: 0.1 }, { start: 900, end: 905, peak: 0.1 }]);
  assert.equal(picks.length, 3);
  assert.deepEqual(picks[0]!.frames, [361, 363, 364]);
  assert.deepEqual(picks[2]!.frames, [10, 11]);
  const l = stripLayout(3, 1080 / 1350, BLUR_CELL);
  assert.equal(l.cellWidth, BLUR_CELL);
  assert.match(CRITIC_SYSTEM, /drawn WITH the project's motion blur/);
  assert.match(CRITIC_SYSTEM, /dark bands at the frame's edges/);
});

test("the blurred strip's label says it's the project's motion blur, not a claim about the export's quality", () => {
  const label = blurStripLabel({ start: 361, end: 364 }, 60, { samples: 12, shutter: 180 }, [361, 363, 364], false);
  assert.match(label, /drawn WITH the project's motion blur \(12 sub-frames over a 180° shutter; as a Standard or High export draws it; a Draft export draws it sharp\): frames 361, 363, 364/);
  assert.doesNotMatch(label, /as the export will look|export's motion blur/);
  assert.match(blurStripLabel({ start: 1, end: 3 }, 30, { samples: 8, shutter: 90 }, [1, 3], true), /the project turns it on for every export/);
  // The critic is told to judge the strips by that label.
  assert.ok(CRITIC_SYSTEM.includes("drawn WITH the project's motion blur") && label.includes("drawn WITH the project's motion blur"));
});

// Round 4's A1: at 18.05 s the footage swapped to the agent panel in 4 frames (the export's steps,
// at the scan's 64 px: 2.6, 4.9, 8.7, 8.6 %, then 1 %), a cut to a blind judge that no one-frame
// rule saw; the same film's designed grows peak at 3 to 4 % over 7 to 10 frames.
test("a quick swap (a cut spread over a few frames) is a jump with its span; a fast designed grow isn't", async () => {
  const fps = 60;
  const n = 400;
  const px = 4000;
  const steps = Array.from({ length: n - 1 }, (_, i) => 0.003 + (i % 3) * 0.001);
  [0.026, 0.049, 0.087, 0.086].forEach((d, i) => (steps[200 + i] = d));
  [0.01, 0.012, 0.016, 0.02, 0.025, 0.032, 0.025, 0.009].forEach((d, i) => (steps[300 + i] = d));
  // Each step flips that share of the pixels (black to white, then back), so frameDiff is the step.
  const gray = new Uint8Array(px);
  let p = 0;
  const frames: Array<ScanFrame> = [{ frame: 0, gray: gray.slice() }];
  for (let f = 0; f < n - 1; f++) {
    for (let k = Math.round(steps[f]! * px); k > 0; k--, p = (p + 1) % px) gray[p] = 255 - gray[p]!;
    frames.push({ frame: f + 1, gray: gray.slice() });
  }
  const scan = motionScan(frames, fps);
  assert.deepEqual(scan.jumps.map((j) => [j.frame, j.span]), [[203, 4]]);
  assert.ok(scan.jumps[0]!.diff > 0.2, `${scan.jumps[0]!.diff}: the whole swap's change`);
  const [finding] = motionFindings(scan, fps, { oneTake: true, hard: true }).filter((x) => x.key?.startsWith("motion:jump"));
  assert.match(finding!.message, /^Quick swap at f 203 \(3\.38 s\): 2\d\.\d % of the picture changes in 4 frames \(0\.07 s\)[\s\S]*that is a cut/);
  assert.equal(finding!.hard, true);
  assert.match(motionLines(scan, fps, { consecutive: true }).join("\n"), /f 203 \(3\.38 s, 2\d %, over 4 frames\)/);
  // As review_submit samples it (every 12th frame): the narrowing widens to the swap's still sides.
  const at = new Map(frames.map((x) => [x.frame, x.gray]));
  const sampled = frames.filter((x) => x.frame % 12 === 5);
  const added = await refineJumps({ frames: sampled, fps, duration: n, render: async (fs) => fs.map((f) => ({ frame: f, gray: at.get(f)! })) });
  assert.deepEqual(motionScan([...sampled, ...added], fps).jumps.map((j) => [j.frame, j.span]), [[203, 4]]);
});

// T1, T1b: after Send, the agent panel (grey 17 on the canvas's 10) with one bubble and a line or two
// of desktop-size steps (1.5 % of the height) passed the empty rule (the panel is content) and every
// round. A low-information frame is mostly one flat colour family with only marks that small; a big
// pill or headline on a calm canvas, footage, and a frame with no mark at all (the empty rule's) aren't.
test("low-information frames: a dark panel with small lines blocks a motion film from 0.5 s; one big element on a calm canvas doesn't", async () => {
  const w = THIN_WIDTH, h = 250, fps = 60;
  const field = (bg: number) => {
    const g = new Uint8Array(w * h).fill(bg);
    for (let y = 0; y < h; y++) for (let x = 40; x < w; x++) g[y * w + x] = bg + 7; // the panel, one colour family with the canvas
    return g;
  };
  // A text line `px` tall at (x, y): letters 2 px wide, 1 px apart (they join into a word).
  const line = (g: Uint8Array, x: number, y: number, len: number, px: number, v: number) => {
    for (let k = 0; k < len; k += 3) for (let yy = y; yy < y + px; yy++) for (let xx = x + k; xx < x + k + 2; xx++) g[yy * w + xx] = v;
  };
  const panel = (px: number) => {
    const g = field(10);
    for (let y = 30; y < 44; y++) for (let x = 90; x < 190; x++) g[y * w + x] = 28; // the bubble
    line(g, 96, 35, 80, px, 220);
    line(g, 50, 60, 60, px, 150);
    for (let y = 150; y < 158; y++) for (let x = 120; x < 125; x++) g[y * w + x] = 240; // the cursor
    return g;
  };
  const small = thinMeasure(panel(3), w, h); // 1.2 % of the height
  assert.ok(small.thin && small.flat >= THIN_FLAT && small.tall < THIN_TALL, JSON.stringify(small));
  assert.ok(!emptyMeasure(panel(3), w, h).empty, "the empty rule passes it (the panel is content)");
  assert.ok(!thinMeasure(panel(9), w, h).thin, "lines 3.6 % tall read: not low-information");
  const pill = new Uint8Array(w * h).fill(237);
  for (let y = 110; y < 140; y++) for (let x = 50; x < 150; x++) pill[y * w + x] = 15;
  assert.ok(!thinMeasure(pill, w, h).thin, "one big pill on a calm canvas");
  assert.ok(!thinMeasure(new Uint8Array(w * h).fill(10), w, h).thin, "no mark at all is the empty rule's, not this");
  const footage = Uint8Array.from({ length: w * h }, (_, i) => (i * 37) % 251);
  assert.ok(!thinMeasure(footage, w, h).thin, "footage");
  // 0.6 s of the small panel between big pills: a blocker in a motion film; 0.3 s: a finding.
  const run = (frames: number) => {
    const fr = Array.from({ length: 120 }, (_, f) => {
      const g = f >= 30 && f < 30 + frames ? panel(3) : pill;
      return { frame: f, gray: g.subarray(0, 64), info: thinMeasure(g, w, h) };
    });
    const scan = motionScan(fr, fps);
    return { scan, found: motionFindings(scan, fps, { oneTake: true, hard: true }).filter((x) => x.key?.startsWith("motion:thin:")) };
  };
  const long = run(36);
  assert.deepEqual(thinRuns(long.scan, fps), [{ start: 30, end: 65 }]);
  assert.equal(long.found.length, 1);
  assert.ok(long.found[0]!.hard, "0.6 s blocks a motion film");
  assert.match(long.found[0]!.message, /low-information/);
  assert.match(motionLines(long.scan, fps, { consecutive: true }).join("\n"), /Low-information frames .* f 30 to f 65/);
  const short = run(18);
  assert.equal(short.found.length, 1);
  assert.ok(!short.found[0]!.hard, "0.3 s is a finding");
  assert.deepEqual(motionFindings(long.scan, fps, { hard: true }).filter((x) => x.key?.startsWith("motion:thin:")), [], "not one take: no finding");
});
