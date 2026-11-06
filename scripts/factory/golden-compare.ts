// Compares what an export measured with its golden. Pure: the ffmpeg work is in goldens.ts.
import type { Probe } from "./media.ts";

export interface Measured {
  readonly probe: Probe;
  readonly frameHashes: ReadonlyArray<string>;
  readonly audioLevelsDb: ReadonlyArray<number>;
  readonly syncMs?: ReadonlyArray<number>;
}

export interface CompareRule {
  readonly compare: "hash" | "ssim";
  readonly expectedFrames: number;
  readonly hasAudio: boolean;
  readonly expectedFlashes?: number;
}

const DURATION_TOLERANCE_S = 0.05;
const STREAM_GAP_TOLERANCE_S = 0.1;
const LEVEL_TOLERANCE_DB = 1;
const SYNC_TOLERANCE_MS = 34;

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

export function streamProblems(probe: Probe, golden: Probe, rule: CompareRule) {
  const problems: Array<string> = [];
  const { video, audio } = probe;
  if (!video) return ["the export has no video stream"];
  if (video.frames !== rule.expectedFrames) problems.push(`${video.frames} video frames, expected ${rule.expectedFrames}`);
  if (golden.video && (video.width !== golden.video.width || video.height !== golden.video.height)) {
    problems.push(`${video.width}x${video.height}, golden ${golden.video.width}x${golden.video.height}`);
  }
  if (golden.video && video.codec !== golden.video.codec) problems.push(`codec ${video.codec}, golden ${golden.video.codec}`);
  if (golden.video && !near(video.fps, golden.video.fps, 0.001)) problems.push(`${video.fps} fps, golden ${golden.video.fps}`);
  if (!near(probe.durationS, golden.durationS, DURATION_TOLERANCE_S)) problems.push(`${probe.durationS} s long, golden ${golden.durationS} s`);
  if (rule.hasAudio !== Boolean(audio)) problems.push(audio ? "an audio stream where none belongs" : "the export has no audio stream");
  if (audio && golden.audio) {
    if (audio.codec !== golden.audio.codec) problems.push(`audio codec ${audio.codec}, golden ${golden.audio.codec}`);
    if (audio.sampleRate !== golden.audio.sampleRate) problems.push(`${audio.sampleRate} Hz, golden ${golden.audio.sampleRate} Hz`);
    if (audio.channels !== golden.audio.channels) problems.push(`${audio.channels} audio channels, golden ${golden.audio.channels}`);
  }
  if (audio && !near(audio.durationS, video.durationS, STREAM_GAP_TOLERANCE_S)) problems.push(`audio ${audio.durationS} s against video ${video.durationS} s`);
  if (audio && !near(audio.startS, video.startS, STREAM_GAP_TOLERANCE_S)) problems.push(`audio starts at ${audio.startS} s, video at ${video.startS} s`);
  return problems;
}

export function hashProblems(hashes: ReadonlyArray<string>, golden: ReadonlyArray<string>) {
  const different = golden.flatMap((hash, frame) => (hashes[frame] === hash ? [] : [frame]));
  if (different.length === 0 && hashes.length === golden.length) return [];
  const first = different[0] === undefined ? "" : `, first at frame ${different[0]}`;
  return [`${different.length} of ${golden.length} frames differ from the golden${first}`];
}

export function levelProblems(levels: ReadonlyArray<number>, golden: ReadonlyArray<number>) {
  const window = golden.findIndex((db, i) => levels[i] === undefined || !near(levels[i]!, db, LEVEL_TOLERANCE_DB));
  if (window < 0) return [];
  return [`sound level at ${window * 0.5} s is ${levels[window]} dB, golden ${golden[window]} dB`];
}

/** How far each beep lands from its flash, in ms; negative when the sound comes first. */
export function syncOffsetsMs(flashes: ReadonlyArray<number>, beeps: ReadonlyArray<number>, fps: number, videoStartS = 0, audioStartS = 0) {
  return flashes.flatMap((frame, i) => {
    const beep = beeps[i];
    return beep === undefined ? [] : [Math.round((audioStartS + beep - videoStartS - frame / fps) * 10000) / 10];
  });
}

export function syncProblems(offsetsMs: ReadonlyArray<number>, expected: number) {
  const problems = offsetsMs.length === expected ? [] : [`${offsetsMs.length} flash and beep pairs, expected ${expected}`];
  const worst = offsetsMs.reduce((max, ms) => (Math.abs(ms) > Math.abs(max) ? ms : max), 0);
  return Math.abs(worst) > SYNC_TOLERANCE_MS ? [...problems, `sound is ${worst} ms from the picture, allowed ${SYNC_TOLERANCE_MS} ms`] : problems;
}

export function ssimProblems(scores: Readonly<Record<string, number>>, minSsim: number) {
  return Object.entries(scores).flatMap(([frame, score]) => (score >= minSsim ? [] : [`frame ${frame}: SSIM ${score} against the golden, needs ${minSsim}`]));
}

export function compareExport(measured: Measured, golden: Measured, rule: CompareRule) {
  const problems = [...streamProblems(measured.probe, golden.probe, rule), ...levelProblems(measured.audioLevelsDb, golden.audioLevelsDb)];
  if (rule.compare === "hash") problems.push(...hashProblems(measured.frameHashes, golden.frameHashes));
  if (rule.expectedFlashes !== undefined) problems.push(...syncProblems(measured.syncMs ?? [], rule.expectedFlashes));
  return problems;
}
