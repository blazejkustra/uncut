// What an exported file holds, measured with ffprobe and ffmpeg.
import { execFileSync } from "node:child_process";

const MAX_DECODED_BYTES = 1024 * 1024 * 1024;

const decoded = (args: ReadonlyArray<string>) => execFileSync("ffmpeg", ["-v", "error", ...args], { maxBuffer: MAX_DECODED_BYTES });

export interface VideoStream {
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frames: number;
  readonly durationS: number;
  readonly startS: number;
}

export interface AudioStream {
  readonly codec: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationS: number;
  readonly startS: number;
}

export interface Probe {
  readonly durationS: number;
  readonly video?: VideoStream;
  readonly audio?: AudioStream;
}

interface RawStream {
  readonly codec_type: string;
  readonly codec_name: string;
  readonly width?: number;
  readonly height?: number;
  readonly r_frame_rate?: string;
  readonly nb_read_packets?: string;
  readonly duration?: string;
  readonly start_time?: string;
  readonly sample_rate?: string;
  readonly channels?: number;
}

const rate = (fraction = "0/1") => {
  const [top, bottom] = fraction.split("/").map(Number);
  return top! / (bottom || 1);
};

export function probeOf(file: string): Probe {
  const entries = "stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_packets,duration,start_time,sample_rate,channels:format=duration";
  const raw = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_packets", "-show_entries", entries, "-of", "json", file], { encoding: "utf8" })) as {
    streams: ReadonlyArray<RawStream>;
    format: { duration: string };
  };
  const v = raw.streams.find((s) => s.codec_type === "video");
  const a = raw.streams.find((s) => s.codec_type === "audio");
  return {
    durationS: Number(raw.format.duration),
    ...(v && {
      video: {
        codec: v.codec_name,
        width: v.width ?? 0,
        height: v.height ?? 0,
        fps: rate(v.r_frame_rate),
        frames: Number(v.nb_read_packets),
        durationS: Number(v.duration),
        startS: Number(v.start_time ?? 0),
      },
    }),
    ...(a && {
      audio: {
        codec: a.codec_name,
        sampleRate: Number(a.sample_rate),
        channels: a.channels ?? 0,
        durationS: Number(a.duration),
        startS: Number(a.start_time ?? 0),
      },
    }),
  };
}

/** One MD5 per decoded frame, in order. */
export const frameHashes = (file: string) =>
  decoded(["-i", file, "-map", "0:v:0", "-f", "framemd5", "-"])
    .toString("utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1)!.trim());

export function framePng(file: string, frame: number, out: string) {
  decoded(["-y", "-i", file, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", "-update", "1", out]);
  return out;
}

const pcmOf = (file: string, sampleRate: number) => {
  const raw = decoded(["-i", file, "-map", "0:a:0", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "-"]);
  const copy = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  return new Float32Array(copy as ArrayBuffer);
};

const rmsDb = (samples: Float32Array) => {
  let power = 0;
  for (const s of samples) power += s * s;
  return Math.round(100 * 10 * Math.log10(power / Math.max(samples.length, 1) + 1e-12)) / 100;
};

const LEVEL_WINDOW_S = 0.5;
const LEVEL_RATE = 48000;

/** The sound's level in dB, one value per half second. */
export function audioLevels(file: string) {
  const pcm = pcmOf(file, LEVEL_RATE);
  const size = LEVEL_RATE * LEVEL_WINDOW_S;
  const levels: Array<number> = [];
  for (let at = 0; at + size <= pcm.length; at += size) levels.push(rmsDb(pcm.subarray(at, at + size)));
  return levels;
}

/** Where `values` rise through `threshold`, as indices. */
export function risingEdges(values: ArrayLike<number>, threshold: number) {
  const edges: Array<number> = [];
  for (let i = 0; i < values.length; i++) if (values[i]! >= threshold && (i === 0 || values[i - 1]! < threshold)) edges.push(i);
  return edges;
}

const FLASH_LUMA = 128;
const FLASH_FRAME_SIZE = 16 * 9;

/** The frames where the picture jumps from black to white. */
export function flashFrames(file: string) {
  const gray = decoded(["-i", file, "-map", "0:v:0", "-vf", "scale=16:9,format=gray", "-f", "rawvideo", "-"]);
  const means: Array<number> = [];
  for (let at = 0; at + FLASH_FRAME_SIZE <= gray.length; at += FLASH_FRAME_SIZE) {
    let sum = 0;
    for (let i = at; i < at + FLASH_FRAME_SIZE; i++) sum += gray[i]!;
    means.push(sum / FLASH_FRAME_SIZE);
  }
  return risingEdges(means, FLASH_LUMA);
}

const BEEP_RATE = 48000;
const BEEP_WINDOW = 48;
const BEEP_LEVEL = 0.1;
const BEEP_MIN_GAP_S = 0.2;

/** When beeps start, in seconds from the sound's first sample. */
export function beepTimes(file: string) {
  const pcm = pcmOf(file, BEEP_RATE);
  const peaks = new Float32Array(Math.floor(pcm.length / BEEP_WINDOW));
  for (let w = 0; w < peaks.length; w++) {
    let peak = 0;
    for (const s of pcm.subarray(w * BEEP_WINDOW, (w + 1) * BEEP_WINDOW)) peak = Math.max(peak, Math.abs(s));
    peaks[w] = peak;
  }
  const times: Array<number> = [];
  for (const edge of risingEdges(peaks, BEEP_LEVEL)) {
    const t = (edge * BEEP_WINDOW) / BEEP_RATE;
    if (times.length === 0 || t - times.at(-1)! >= BEEP_MIN_GAP_S) times.push(t);
  }
  return times;
}
