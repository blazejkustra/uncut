// The "video" analyzer (D67): one ffmpeg pass over the first video stream that isn't a cover
// picture (0:V:0: DJI files carry an mjpeg cover and data streams too), decoded with VideoToolbox
// where there is one, downscaled to 320 px wide grey. ffmpeg finds the scene cuts (scdet), the blur
// (blurdetect, printed per frame) and the frozen stretches (freezedetect) at 320 px, then hands
// every frame, scaled uniformly to cover 128×72 and centre-cropped, to Uncut as raw grey bytes on
// stdout. Here, per frame: the brightness and clipping (signalstats' job, done on those bytes since
// they're here anyway) and the camera's motion against the previous frame by phase correlation (a
// translation with sub-pixel peak, plus how sure it is). ffmpeg's deshake log only gives whole
// pixels at this size and its exhaustive search halves the speed, and vidstab isn't in brew's ffmpeg.
//
// The result keeps measurements, not scores, per second of the file (videoScores.ts turns them
// into stability, sharpness, exposure and a clean score, so tuning the scores needs no re-run).
import { execFile } from "node:child_process";

import { Cancelled, type Runner, spawnRunner } from "./analysisRunner.ts";
import { withoutApiKey } from "../app/shellEnv.ts";
import { type VideoResult, NO_VIDEO } from "./video/result.ts";
import { VideoLog } from "./video/videoLog.ts";
import { PhaseCorrelator } from "./video/phaseCorrelator.ts";
import { round, type FrameSample, windowsOf } from "./video/windows.ts";
export { VIDEO_VERSION, NO_VIDEO, isVideoResult } from "./video/result.ts";
export type { VideoWindow, VideoResult } from "./video/result.ts";
export { MOTION_W, MOTION_H, PhaseCorrelator } from "./video/phaseCorrelator.ts";
export { VideoLog } from "./video/videoLog.ts";
export { smooth, SMOOTH_SIGMA_S, windowsOf } from "./video/windows.ts";
export type { FrameSample } from "./video/windows.ts";
/** ffmpeg's filters run at this width (grey). */
export const ANALYSIS_WIDTH = 320;
/**
 * Frames reach Uncut at this size, scaled uniformly (both axes by the same factor) to cover it and
 * cropped to the centre, so shake reads the same either way on any aspect (portrait included);
 * motion is measured on its centre MOTION_W × MOTION_H.
 */
export const RAW_W = 128;
export const RAW_H = 72;
/** scdet's threshold (0–100: how different a frame must be from the last to start a new shot). */
export const CUT_THRESHOLD = 10;
/** freezedetect: frames this close (dB of noise) for at least FREEZE_MIN_S are frozen. */
export const FREEZE_NOISE_DB = -60;
export const FREEZE_MIN_S = 0.5;
/**
 * scdet also fires on fast pans over busy ground (drone footage: scores 10–12 on a continuous
 * take). A cut is kept only if the frame can't be matched to the one before by a shift (its
 * phase-correlation peak is below CUT_MAX_MATCH; real cuts measure 0.07–0.22, those pans 0.69–0.98)
 * or scdet is sure (CUT_SURE). Known gap: a jump cut over the same background reads as no cut.
 */
export const CUT_MAX_MATCH = 0.4;
export const CUT_SURE = 40;
/** A gap longer than this many typical frame durations before a frame is dropped frames. */
export const DROP_GAP = 2.5;
/** A phase-correlation peak below this is no real match (a flat sky, a cut, noise). */
export const MIN_CONFIDENCE = 0.04;
const JOB_TIMEOUT_MS = 60 * 60_000;
/** A long file decoded in software can take a few times its length: the timeout grows with it. */
export const timeoutFor = (seconds: number | undefined) => Math.max(JOB_TIMEOUT_MS, Math.round((seconds ?? 0) * 4 * 1000));

// ---- ffmpeg ----

/** ffmpeg's arguments: raw 128×72 grey frames on stdout; progress, blur per frame, cuts and freezes on stderr. */
export const videoArgs = (path: string, hwaccel: boolean) => [
  "-hide_banner",
  "-nostdin",
  "-nostats",
  "-progress",
  "pipe:2",
  ...(hwaccel ? ["-hwaccel", "videotoolbox"] : []),
  "-i",
  path,
  // The first video stream that isn't an attached picture (a cover).
  "-map",
  "0:V:0",
  "-an",
  "-sn",
  "-dn",
  "-vf",
  [
    `scale=${ANALYSIS_WIDTH}:-2:flags=fast_bilinear`,
    "format=gray",
    `scdet=threshold=${CUT_THRESHOLD}`,
    `freezedetect=n=${FREEZE_NOISE_DB}dB:d=${FREEZE_MIN_S}`,
    "blurdetect",
    "metadata=mode=print:key=lavfi.blur",
    `scale=${RAW_W}:${RAW_H}:force_original_aspect_ratio=increase:flags=area`,
    `crop=${RAW_W}:${RAW_H}`,
  ].join(","),
  "-fps_mode",
  "passthrough",
  "-f",
  "rawvideo",
  "-pix_fmt",
  "gray",
  "pipe:1",
];

/** ffmpeg's ways of saying the file has no video stream for 0:v:0. */
const NO_VIDEO_STREAM = /matches no streams|does not contain any stream|Failed to set value '0:V:0' for option 'map'/i;

// Whether each ffmpeg can decode with VideoToolbox (asked once per binary).
const hwaccels = new Map<string, Promise<boolean>>();
const canVideotoolbox = (ffmpeg: string) => {
  let known = hwaccels.get(ffmpeg);
  if (!known) {
    known = new Promise((resolve) => execFile(ffmpeg, ["-hide_banner", "-hwaccels"], { timeout: 10_000, env: withoutApiKey(process.env) }, (error, stdout) => resolve(!error && /^videotoolbox$/m.test(String(stdout)))));
    hwaccels.set(ffmpeg, known);
  }
  return known;
};

// ---- the analyzer ----

/** Brightness 0–1 and the shares of near-black and near-white pixels of a grey frame. */
function levels(frame: Uint8Array): { brightness: number; dark: number; bright: number } {
  let sum = 0;
  let dark = 0;
  let bright = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i]!;
    sum += v;
    if (v <= 16) dark++;
    else if (v >= 245) bright++;
  }
  return { brightness: sum / frame.length / 255, dark: dark / frame.length, bright: bright / frame.length };
}

const ffmpegError = (stderr: string) =>
  stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(size=|frame=|Press \[q\]|\[Parsed_metadata|[a-z_]+=)/.test(l))
    .slice(-3)
    .join(" ")
    .slice(0, 400);

/** Cuts, frozen stretches and per-second measurements of the first video stream of `path`. */
export async function analyzeVideo(
  ffmpeg: string,
  path: string,
  options: { readonly signal: AbortSignal; readonly runner?: Runner; readonly seconds?: number | undefined; readonly onProgress?: (fraction: number) => void; readonly hwaccel?: boolean },
): Promise<VideoResult> {
  const log = new VideoLog();
  const correlator = new PhaseCorrelator();
  const frameBytes = RAW_W * RAW_H;
  const pending = Buffer.alloc(frameBytes);
  let filled = 0;
  const motion: Array<{ dx: number; dy: number; peak: number } | undefined> = [];
  const lv: Array<{ brightness: number; dark: number; bright: number }> = [];
  const onFrame = (frame: Uint8Array) => {
    lv.push(levels(frame));
    motion.push(correlator.push(frame, RAW_W, RAW_H));
  };
  const runner = options.runner ?? spawnRunner;
  const hwaccel = options.hwaccel ?? (process.platform === "darwin" && (await canVideotoolbox(ffmpeg)));
  if (options.signal.aborted) throw new Cancelled();
  const r = await runner(ffmpeg, videoArgs(path, hwaccel), {
    signal: options.signal,
    timeoutMs: timeoutFor(options.seconds),
    onStderr: (line) => {
      log.line(line);
      if (line.startsWith("out_time_us=")) {
        const total = options.seconds ?? log.duration;
        if (total) options.onProgress?.(Math.min(0.99, log.outTime / total));
      }
    },
    onStdoutData: (chunk) => {
      let at = 0;
      while (at < chunk.length) {
        const take = Math.min(frameBytes - filled, chunk.length - at);
        chunk.copy(pending, filled, at, at + take);
        filled += take;
        at += take;
        if (filled === frameBytes) {
          onFrame(pending);
          filled = 0;
        }
      }
    },
  });
  if (r.code !== 0) {
    if (NO_VIDEO_STREAM.test(r.stderrTail)) return NO_VIDEO;
    throw new Error(`ffmpeg couldn't read the picture: ${ffmpegError(r.stderrTail) || `it exited with ${r.code}`}`);
  }
  const count = lv.length;
  if (!count) return NO_VIDEO;
  // Frame times from the blur lines; a frame missing one is placed after the last known.
  const times: Array<number> = [];
  const step = (options.seconds ?? log.duration ?? count / 30) / count;
  for (let i = 0; i < count; i++) {
    const t = log.times[i];
    times.push(t !== undefined && Number.isFinite(t) ? t : i ? times[i - 1]! + step : 0);
  }
  const last = times[count - 1]!;
  const frameDur = count > 1 ? (last - times[0]!) / (count - 1) : step;
  const end = Math.max(last + frameDur, log.outTime);
  log.closeFreeze(end);
  // Dropped frames (DJI files have them): a gap of more than DROP_GAP frames before a frame. The
  // picture jumps there, so it's neither a cut nor one frame's motion.
  const dts = times.slice(1).map((t, i) => t - times[i]!).filter((d) => d > 0).sort((x, y) => x - y);
  const typical = dts.length ? dts[dts.length >> 1]! : frameDur;
  const dropFrames = new Set<number>();
  const drops: Array<{ time: number; missing: number }> = [];
  for (let i = 1; i < count; i++) {
    const gap = times[i]! - times[i - 1]!;
    if (typical > 0 && gap > DROP_GAP * typical) {
      dropFrames.add(i);
      drops.push({ time: round(times[i]!, 4), missing: round(gap - typical, 4) });
    }
  }
  const cuts = log.cuts
    .filter((c) => {
      const at = nearestFrame(times, c.time);
      if (dropFrames.has(at)) return false;
      const m = motion[at];
      return c.score >= CUT_SURE || !m || m.peak < CUT_MAX_MATCH;
    })
    .map((c) => ({ time: round(c.time, 4), score: round(c.score, 2) }));
  // A pair across a cut or a gap, or with a weak peak, isn't camera motion.
  const cutFrames = new Set(cuts.map((c) => nearestFrame(times, c.time)));
  const samples: Array<FrameSample> = times.map((time, i) => {
    const m = motion[i];
    const ok = m && m.peak >= MIN_CONFIDENCE && !cutFrames.has(i) && !dropFrames.has(i);
    return { time, ...(ok ? { dx: m.dx, dy: m.dy } : {}), blur: log.blurs[i], ...lv[i]! };
  });
  const frozen = log.frozen.map((f) => ({ start: round(f.start, 4), end: round(Math.min(end, f.end), 4) })).filter((f) => f.end > f.start);
  return {
    hasVideo: true,
    seconds: round(end, 3),
    frames: count,
    fps: round(count / Math.max(1e-6, end - times[0]!), 3),
    cutThreshold: CUT_THRESHOLD,
    cuts,
    drops,
    frozen,
    // Shake in widths of the whole picture: it covers RAW_W × RAW_H, so it's RAW_W wide unless it's
    // wider than that box's aspect (then the sides were cropped).
    windows: windowsOf(samples, frozen, scaledWidth(log.display), end),
  };
}

/** The width (pixels of the raw frames) of the whole picture, scaled to cover RAW_W × RAW_H. */
export function scaledWidth(display: { width: number; height: number } | undefined): number {
  if (!display || display.width <= 0 || display.height <= 0) return RAW_W;
  return Math.max(RAW_W, (RAW_H * display.width) / display.height);
}

/** The index of the frame whose time is nearest `t` (times ascending). */
export function nearestFrame(times: ReadonlyArray<number>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1]! - t) <= Math.abs(times[lo]! - t)) return lo - 1;
  return lo;
}
