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

import { CRITIC_SYSTEM, criticReview, criticText, type CriticFinding, type CriticInput } from "../../apps/server/src/agent/agentCritic.ts";
import { beatWordLines, beatWords, canvasShare, dropBeat, dropLine, FLAT_MAX, flatFindings, flatFraction, flatLines, budgetLine, frameDiff, grayFrames, MAX_STRIPS, motionAnchors, motionFindings, motionFrames, motionIntent, motionLines, motionRenderOrder, motionScan, SCAN_BUDGET, SCAN_WINDOW, scanPlan, scanSize, STRIP_CELL, stripLayout, stripPlan } from "../../apps/server/src/agent/criticMotion.ts";
import { drawSheet } from "../../apps/server/src/export/exporter/sheets.ts";
import { openFrameSession, renderFramesWith } from "../../apps/server/src/export/exporter/frames.ts";
import { loadGraphicLibs } from "../../apps/server/src/export/graphicLibs.ts";
import { resolveGraphicLibs, type Project } from "../../packages/core/src/index.ts";
import { criticSkills, runFacts, UNMEASURED } from "../../apps/server/src/agent/tools/cards.ts";
import { reviewRubric as rubricOf, soundProfileFor, suggestSkills as suggestOf } from "../../packages/core/src/skills/skills.ts";
import { soundProfileText } from "../../packages/core/src/checks/soundSheet.ts";

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
  assert.deepEqual(motionIntent({ skills: ["motion-film"], words: "" }), { oneTake: true, loop: true, footage: false });
  assert.deepEqual(motionIntent({ skills: [], words: "A launch film, one take, never cut" }), { oneTake: true, loop: false, footage: false });
  assert.deepEqual(motionIntent({ skills: [], words: "a product demo" }), { oneTake: false, loop: false, footage: false });
  assert.equal(motionIntent({ skills: ["motion-film"], words: "DJI 0050 drone footage" }).footage, true);
  assert.equal(motionIntent({ skills: [], words: "", hasFootage: true }).footage, true);
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
  assert.match(runFacts(12, [{ round: 1, blockers: [1, 2] }, { round: 2, blockers: [] }]), /12 beats; this is review 3 \(before it: round 1: 2 blockers, not passed; round 2: no blockers\)/);
  assert.match(runFacts(undefined, []), /no beats; this is review 1, the first/);
  assert.match(CRITIC_SYSTEM, /one hero element at a time on a calm canvas[\s\S]*this run's facts/);
});

// D297 (the audit): with the motion film on it wins: only its checklist and the brand's reach the
// critic, motion craft isn't suggested with it, its sound profile is ui (an effect per press, never a
// blocker), and a scan that couldn't run is Uncut's problem, not the video's.
test("D297: the film's checklist wins, no motion craft with it, the ui sound profile, an unmeasured scan isn't marked down", () => {
  const skills = ["launch-promo", "motion-craft", "sound-design", "brand-application", "motion-film"].map((name) => ({ name }));
  assert.deepEqual(criticSkills(skills).map((x) => x.name), ["brand-application", "motion-film"]);
  assert.deepEqual(criticSkills(skills.slice(0, 3)).map((x) => x.name), ["launch-promo", "motion-craft", "sound-design"]);
  const film = suggestOf({ film: "Our launch film: one take, never cut, a single shape morphing on the beat", type: "launch-promo" });
  assert.ok(film.includes("motion-film") && !film.includes("motion-craft"), film.join(", "));
  assert.ok(suggestOf({ film: "Our launch film", type: "launch-promo" }).includes("motion-craft"));
  assert.equal(soundProfileFor({ film: "x", type: "launch-promo" }, ["sound-design", "motion-film"]), "ui");
  assert.equal(soundProfileFor({ film: "a silent film", type: "launch-promo" }, ["motion-film"]), "off");
  const rubric = rubricOf({ film: "x", type: "launch-promo" }, { skills: ["motion-film"] });
  assert.ok(!rubric.hardKinds.includes("sound"), "never a blocker");
  assert.match(soundProfileText("ui"), /one soft effect per real cursor press, drag or morph/);
  assert.match(UNMEASURED, /don't mark anything down/);
});
