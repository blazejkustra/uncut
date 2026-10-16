// The critic sees motion, not just stills (D292). Still frames can't show a single-frame pop, a
// move that lands off the beat, a hold that drags or a loop that stutters at its seam, so a review
// round also gets:
// - frame strips: for each scene (the storyboard's beats, else evenly spaced moments), a row of N
//   frames around its start at 1/12 s apart, downscaled, one image per strip (bounded: at most
//   MAX_STRIPS strips of STRIP_FRAMES cells, STRIP_CELL px wide);
// - a frame-difference scan: small grey frames (SCAN_WIDTH px) of consecutive frames around each
//   scene change plus an even sampling of the whole film (at most SCAN_BUDGET frames, rendered once
//   with the strips' at STRIP_CELL and stopped at MOTION_BUDGET_MS), from which
//   it finds single-frame pops (a frame that differs from both neighbours more than POP_RATIO times
//   as much as they differ from each other), one-frame jumps (a cut, or a flood that took one
//   frame), holds over a second and the loop seam (last frame against frame 0).
// What it finds goes to the critic as facts (<motion>) and to the agent as review findings
// (rule "motion"). Pure planning and scanning here; the rendering is review_submit's (cards.ts),
// and grayFrames decodes the rendered JPEGs with ffmpeg (no image library in the repo).
import { spawn } from "node:child_process";

import type { CriticFinding } from "./agentCritic.ts";
import { CAPTION_HEIGHT, GAP, type SheetLayout } from "./agentFootage.ts";

/** Frames in a strip, their spacing (s), the most strips, a cell's width (px). */
export const STRIP_FRAMES = 6;
export const STRIP_STEP_S = 1 / 12;
export const MAX_STRIPS = 6;
export const STRIP_CELL = 200;
/** The scan's grey frames are this wide; at most this many frames are rendered for it. */
export const SCAN_WIDTH = 64;
export const SCAN_RENDER_WIDTH = 96;
/**
 * The most time (ms) review_submit spends rendering the strips' and the scan's frames: past it the
 * scan's remaining frames are left out and the scan runs on what was rendered (and says so). The
 * strips' frames and the scene changes' windows come first, so a cut-off scan still covers them.
 */
export const MOTION_BUDGET_MS = 40_000;
export const SCAN_BUDGET = 160;
/** Consecutive frames on each side of a scene change in the scan. */
export const SCAN_WINDOW = 5;
/** A pop or a jump: this many times its neighbours' difference, and at least POP_MIN (mean |Δ| of 0..1 grey). */
export const POP_RATIO = 3;
export const POP_MIN = 0.03;
/** Below this mean difference two samples count as the same picture (a hold). */
export const HOLD_DIFF = 0.0015;
export const HOLD_MAX_S = 1;

export interface MotionAnchor {
  readonly frame: number;
  readonly label: string;
}
export interface MotionStrip {
  readonly label: string;
  readonly at: number;
  readonly frames: ReadonlyArray<number>;
}

const clampTo = (duration: number) => (f: number) => Math.max(0, Math.min(duration - 1, Math.round(f)));

/**
 * The moments the strips and the scan look around: each storyboard beat's start (its scene change),
 * else one every 2 s; never more than `max`, picked evenly, frame 0 first.
 */
export function motionAnchors(beats: ReadonlyArray<{ readonly start: number; readonly title?: string }> | undefined, fps: number, duration: number, max = MAX_STRIPS): Array<MotionAnchor> {
  const clamp = clampTo(duration);
  let all: Array<MotionAnchor> = (beats ?? []).map((b, i) => ({ frame: clamp(b.start * fps), label: `beat ${i + 1}${b.title ? ` ${b.title}` : ""}` }));
  if (!all.length) {
    const every = Math.max(1, Math.round(2 * fps));
    for (let f = 0; f < duration; f += every) all.push({ frame: f, label: `${(f / fps).toFixed(1)} s` });
  }
  const seen = new Set<number>();
  all = all.filter((a) => (seen.has(a.frame) ? false : (seen.add(a.frame), true))).sort((a, b) => a.frame - b.frame);
  if (all.length <= max) return all;
  return Array.from({ length: max }, (_, i) => all[Math.round((i * (all.length - 1)) / (max - 1))]!);
}

/** A strip per anchor: STRIP_FRAMES frames 1/12 s apart, two before the anchor and the rest after (clamped, distinct). */
export function stripPlan(anchors: ReadonlyArray<MotionAnchor>, fps: number, duration: number, count = STRIP_FRAMES, step = STRIP_STEP_S): Array<MotionStrip> {
  const clamp = clampTo(duration);
  const gap = Math.max(1, Math.round(step * fps));
  const before = Math.floor((count - 1) / 2.5);
  return anchors.map((a) => {
    let start = a.frame - before * gap;
    if (start + (count - 1) * gap > duration - 1) start = duration - 1 - (count - 1) * gap;
    const frames = [...new Set(Array.from({ length: count }, (_, i) => clamp(Math.max(0, start) + i * gap)))];
    return { label: a.label, at: a.frame, frames };
  });
}

/**
 * The scan's frames: every frame when the film fits the budget; else SCAN_WINDOW consecutive frames
 * on each side of every anchor, frame 0 and the last frame, and an even sampling (at most every
 * 0.25 s) with what's left of the budget.
 */
export function scanPlan(anchors: ReadonlyArray<MotionAnchor>, fps: number, duration: number, budget = SCAN_BUDGET): Array<number> {
  if (duration <= 0) return [];
  if (duration <= budget) return Array.from({ length: duration }, (_, i) => i);
  const clamp = clampTo(duration);
  const set = new Set<number>([0, 1, duration - 2, duration - 1].map(clamp));
  for (const a of anchors) for (let d = -SCAN_WINDOW; d <= SCAN_WINDOW; d++) set.add(clamp(a.frame + d));
  const left = Math.max(8, budget - set.size);
  const every = Math.max(1, Math.round(0.25 * fps), Math.ceil(duration / left));
  for (let f = 0; f < duration; f += every) set.add(f);
  return [...set].sort((a, b) => a - b).slice(0, budget + 8);
}

/**
 * The strips' and the scan's frames, each once, in render order: first the strips' frames, the
 * scan's frames around each scene change (SCAN_WINDOW each side) and the first and last two
 * frames; then the rest of the scan. Each part sorted.
 */
export function motionRenderOrder(strips: ReadonlyArray<MotionStrip>, scanList: ReadonlyArray<number>, anchors: ReadonlyArray<MotionAnchor>, duration: number): Array<number> {
  const first = new Set<number>(strips.flatMap((s) => s.frames));
  for (const f of scanList) if (f <= 1 || f >= duration - 2 || anchors.some((a) => Math.abs(f - a.frame) <= SCAN_WINDOW)) first.add(f);
  const rest = new Set(scanList.filter((f) => !first.has(f)));
  return [...[...first].sort((a, b) => a - b), ...[...rest].sort((a, b) => a - b)];
}

export interface MotionFrames {
  /** Every frame rendered (the strips' and the scan's), by frame. */
  readonly byFrame: ReadonlyMap<number, Buffer>;
  /** The scan's frames that were rendered, in order. */
  readonly scanned: ReadonlyArray<number>;
  /** How many the scan planned (scanList). */
  readonly planned: number;
  /** Whether the time budget left some out. */
  readonly cut: boolean;
}

/**
 * The strips' and the scan's frames rendered once (motionRenderOrder) by `render`, which asks
 * `until` before each frame: once `budgetMs` has gone by (on `now`), the rest are left out.
 */
export async function motionFrames(o: {
  readonly strips: ReadonlyArray<MotionStrip>;
  readonly scanList: ReadonlyArray<number>;
  readonly anchors: ReadonlyArray<MotionAnchor>;
  readonly duration: number;
  readonly render: (frames: ReadonlyArray<number>, until: () => boolean) => Promise<ReadonlyArray<{ readonly frame: number; readonly jpeg: Buffer }>>;
  readonly budgetMs?: number;
  readonly now?: () => number;
}): Promise<MotionFrames> {
  const now = o.now ?? Date.now;
  const deadline = now() + (o.budgetMs ?? MOTION_BUDGET_MS);
  const order = motionRenderOrder(o.strips, o.scanList, o.anchors, o.duration);
  const rendered = await o.render(order, () => now() > deadline);
  const byFrame = new Map(rendered.map((f) => [f.frame, f.jpeg]));
  const scanned = [...new Set(o.scanList)].filter((f) => byFrame.has(f)).sort((a, b) => a - b);
  return { byFrame, scanned, planned: new Set(o.scanList).size, cut: rendered.length < order.length };
}

/** Mean absolute difference of two grey frames, 0..1. */
export function frameDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a[i]! - b[i]!);
  return s / n / 255;
}

const median = (xs: ReadonlyArray<number>) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface MotionEvent {
  readonly frame: number;
  readonly diff: number;
  /** How many times its neighbours' difference. */
  readonly ratio: number;
}
export interface MotionScan {
  readonly frames: number;
  /** Single-frame pops: a frame unlike both neighbours, which agree. */
  readonly pops: ReadonlyArray<MotionEvent>;
  /** One-frame jumps: the picture changes a lot between two frames and little around them (a cut, a one-frame flood). */
  readonly jumps: ReadonlyArray<MotionEvent>;
  /** Stretches (frames) where nothing visible changes, over HOLD_MAX_S. */
  readonly holds: ReadonlyArray<{ readonly start: number; readonly end: number }>;
  /** The loop seam: the last frame against frame 0, and the typical frame-to-frame difference. */
  readonly seam?: { readonly diff: number; readonly typical: number };
  readonly typical: number;
}

/**
 * Pops, jumps, holds and the seam in a set of grey frames (any frames; consecutive ones are what
 * pops and jumps are judged on). Deterministic and pure.
 */
export function motionScan(input: ReadonlyArray<{ readonly frame: number; readonly gray: Uint8Array }>, fps: number, o: { readonly ratio?: number; readonly min?: number } = {}): MotionScan {
  const ratio = o.ratio ?? POP_RATIO;
  const min = o.min ?? POP_MIN;
  const fr = [...input].sort((a, b) => a.frame - b.frame);
  const at = new Map(fr.map((x) => [x.frame, x.gray]));
  // Differences between consecutive frames (frame f → f + 1).
  const step = new Map<number, number>();
  for (const x of fr) {
    const next = at.get(x.frame + 1);
    if (next) step.set(x.frame, frameDiff(x.gray, next));
  }
  const typical = Math.max(median([...step.values()]), 0.0005);
  const pops: Array<MotionEvent> = [];
  const popFrames = new Set<number>();
  for (const x of fr) {
    const a = step.get(x.frame - 1);
    const b = step.get(x.frame);
    if (a === undefined || b === undefined) continue;
    const around = frameDiff(at.get(x.frame - 1)!, at.get(x.frame + 1)!);
    const d = Math.min(a, b);
    const base = Math.max(around, typical);
    if (d >= min && d >= ratio * base) {
      pops.push({ frame: x.frame, diff: round(d), ratio: round(d / base, 1) });
      popFrames.add(x.frame);
    }
  }
  const jumps: Array<MotionEvent> = [];
  for (const [f, d] of step) {
    if (popFrames.has(f) || popFrames.has(f + 1) || d < min) continue;
    const near = [step.get(f - 2), step.get(f - 1), step.get(f + 1), step.get(f + 2)].filter((v): v is number => v !== undefined);
    if (!near.length) continue;
    const base = Math.max(Math.max(...near), typical);
    if (d >= ratio * base) jumps.push({ frame: f + 1, diff: round(d), ratio: round(d / base, 1) });
  }
  jumps.sort((a, b) => a.frame - b.frame);
  // Holds: runs of samples (at most 0.5 s apart) that don't change.
  const holds: Array<{ start: number; end: number }> = [];
  let runStart: number | undefined;
  let runEnd = 0;
  const gapMax = Math.max(1, Math.round(0.5 * fps));
  const close = () => {
    if (runStart !== undefined && (runEnd - runStart) / fps > HOLD_MAX_S) holds.push({ start: runStart, end: runEnd });
    runStart = undefined;
  };
  for (let i = 1; i < fr.length; i++) {
    const p = fr[i - 1]!;
    const c = fr[i]!;
    if (c.frame - p.frame <= gapMax && frameDiff(p.gray, c.gray) < HOLD_DIFF) {
      if (runStart === undefined) runStart = p.frame;
      runEnd = c.frame;
    } else close();
  }
  close();
  const first = fr[0];
  const last = fr.at(-1);
  const seam = first && last && last.frame > first.frame ? { diff: round(frameDiff(last.gray, first.gray)), typical: round(typical) } : undefined;
  return { frames: fr.length, pops, jumps, holds, ...(seam ? { seam } : {}), typical: round(typical) };
}

const round = (v: number, digits = 4) => Math.round(v * 10 ** digits) / 10 ** digits;
const secs = (f: number, fps: number) => `${(f / fps).toFixed(2)} s`;

/** Whether a seam is a stutter: the last frame further from frame 0 than POP_RATIO typical steps (and visibly so). */
export const seamBroken = (scan: MotionScan) => !!scan.seam && scan.seam.diff >= Math.max(POP_MIN / 2, POP_RATIO * scan.seam.typical);

/**
 * The scan as review findings (rule "motion"): pops always; one-frame jumps and holds over a second
 * when the film is one take (a cut is fine elsewhere, an end card may hold); the seam when it loops.
 * At most 8, worst pops first.
 */
export function motionFindings(scan: MotionScan, fps: number, o: { readonly oneTake?: boolean; readonly loop?: boolean } = {}): Array<CriticFinding> {
  const out: Array<CriticFinding> = [];
  for (const p of [...scan.pops].sort((a, b) => b.ratio - a.ratio).slice(0, 4)) {
    out.push({ rule: "motion", key: `motion:pop:${p.frame}`, frame: p.frame, hard: false, message: `Single-frame pop at f ${p.frame} (${secs(p.frame, fps)}): that frame differs from both neighbours ${p.ratio}× as much as they differ from each other (mean change ${(p.diff * 100).toFixed(1)} %). Something shows or vanishes for one frame.` });
  }
  if (o.oneTake) {
    for (const j of scan.jumps.slice(0, 2)) out.push({ rule: "motion", key: `motion:jump:${j.frame}`, frame: j.frame, hard: false, message: `One-frame jump at f ${j.frame} (${secs(j.frame, fps)}): ${(j.diff * 100).toFixed(1)} % of the picture changes in one frame, ${j.ratio}× the frames around it; in a one-take film that is a cut or a flood that didn't overscale over about 0.3 s.` });
    for (const h of scan.holds.slice(0, 2)) out.push({ rule: "motion", key: `motion:hold:${h.start}`, frame: h.start, range: { start: h.start, end: h.end }, hard: false, message: `Nothing changes from f ${h.start} to f ${h.end} (${((h.end - h.start) / fps).toFixed(1)} s): a hold over 1 s.` });
  }
  if (o.loop && seamBroken(scan)) out.push({ rule: "motion", key: "motion:seam:0", frame: 0, hard: false, message: `The loop seam: the last frame differs from frame 0 by ${(scan.seam!.diff * 100).toFixed(1)} % (a typical frame step is ${(scan.seam!.typical * 100).toFixed(2)} %), so the loop jumps. Make the last frame equal the first, cursor position and speed included.` });
  return out.slice(0, 8);
}

/** What a scan cut short by the time budget says (in the facts and the tool's result). */
export const budgetLine = (covered: number, planned: number) => `The frame-difference scan covered ${covered} of ${planned} frames: time budget (the frames around each scene change first, then the rest in order).`;

/** The scan for the critic, as facts (in <motion>). */
export function motionLines(scan: MotionScan, fps: number, scanned: { readonly consecutive: boolean; readonly planned?: number }): Array<string> {
  const lines = [
    ...(scanned.planned !== undefined && scan.frames < scanned.planned ? [budgetLine(scan.frames, scanned.planned)] : []),
    `Frame-difference scan of ${scan.frames} small grey frames (${scanned.consecutive ? "every frame" : "every frame around each scene change, and an even sampling of the rest"}); a typical frame-to-frame change is ${(scan.typical * 100).toFixed(2)} %.`];
  lines.push(scan.pops.length ? `Single-frame pops: ${scan.pops.map((p) => `f ${p.frame} (${secs(p.frame, fps)}, ${p.ratio}×)`).join(", ")}.` : "No single-frame pops found.");
  if (scan.jumps.length) lines.push(`One-frame jumps (cuts, or changes that took one frame): ${scan.jumps.slice(0, 8).map((j) => `f ${j.frame} (${secs(j.frame, fps)}, ${(j.diff * 100).toFixed(0)} %)`).join(", ")}.`);
  lines.push(scan.holds.length ? `Holds over 1 s with nothing changing: ${scan.holds.map((h) => `f ${h.start} to f ${h.end}`).join(", ")}.` : "No hold over 1 s.");
  if (scan.seam) lines.push(`Loop seam: the last frame differs from frame 0 by ${(scan.seam.diff * 100).toFixed(1)} %${seamBroken(scan) ? ", a visible jump if it loops" : ", a clean loop"}.`);
  return lines;
}

/**
 * Grey frames of `w` × `h` pixels from JPEGs, decoded by one ffmpeg run (the JPEGs piped in as an
 * image2pipe stream). Throws when ffmpeg fails or returns the wrong size.
 */
export function grayFrames(ffmpeg: string, jpegs: ReadonlyArray<Buffer>, w: number, h: number, signal?: AbortSignal): Promise<Array<Uint8Array>> {
  if (!jpegs.length) return Promise.resolve([]);
  return new Promise((done, fail) => {
    const child = spawn(ffmpeg, ["-v", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-i", "-", "-vf", `scale=${w}:${h}:flags=area,format=gray`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { stdio: ["pipe", "pipe", "pipe"], ...(signal ? { signal } : {}) });
    const out: Array<Buffer> = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()).length > 4000 && (err = err.slice(-2000)));
    child.on("error", fail);
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      const all = Buffer.concat(out);
      const size = w * h;
      if (code !== 0 || all.length !== size * jpegs.length) return fail(new Error(`ffmpeg couldn't decode the frames (${code}): ${err.trim().slice(-300) || `${all.length} bytes for ${jpegs.length} frames`}`));
      done(Array.from({ length: jpegs.length }, (_, i) => new Uint8Array(all.buffer, all.byteOffset + i * size, size)));
    });
    for (const j of jpegs) child.stdin.write(j);
    child.stdin.end();
  });
}

/** The scan's grey size for a canvas: SCAN_WIDTH wide, even height. */
export const scanSize = (canvas: { readonly width: number; readonly height: number }) => ({ w: SCAN_WIDTH, h: Math.max(2, Math.round((SCAN_WIDTH * canvas.height) / canvas.width / 2) * 2) });

/** A strip's sheet: one row of `count` cells STRIP_CELL wide with their captions (a downscaled image per strip). */
export function stripLayout(count: number, aspect: number): SheetLayout {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  const n = Math.max(1, count);
  const cellHeight = Math.max(1, Math.round(STRIP_CELL / a));
  return { columns: n, rows: 1, cellWidth: STRIP_CELL, cellHeight, width: n * STRIP_CELL + GAP * (n + 1), height: cellHeight + CAPTION_HEIGHT + GAP * 2 };
}

/** Whether the film is meant as one take (no cuts, no holds) and as a loop: the motion-film skill, or the brief's words. */
export function motionIntent(o: { readonly skills: ReadonlyArray<string>; readonly words: string }): { oneTake: boolean; loop: boolean } {
  const film = o.skills.includes("motion-film");
  return {
    oneTake: film || /one[- ]take|never cut|no cuts|one continuous (shot|take)/i.test(o.words),
    loop: film || /\bloop(s|ing|ed)?\b|last frame (is|=|equals) (the )?first/i.test(o.words),
  };
}
