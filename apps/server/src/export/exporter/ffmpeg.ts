import { execFile, spawn, type ChildProcess } from "node:child_process";
import { availableParallelism, setPriority } from "node:os";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import type { Project, Media } from "@uncut/core";
import { DENOISE_LAG_SAMPLES, stageFilter, type Caps, type ExportPlan } from "../exportPlan.ts";
import { withoutApiKey } from "../../app/shellEnv.ts";
import { localInputs } from "../../media/localInputs.ts";

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/** What this ffmpeg can do, asked once per binary. */
const capsCache = new Map<string, Promise<Caps>>();
export const capsOf = (bin: string) => {
  let caps = capsCache.get(bin);
  if (!caps) {
    const list = (args: Array<string>) =>
      run(bin, args, undefined).then(
        (r) => r.stdout,
        () => "",
      );
    caps = Promise.all([list(["-hide_banner", "-encoders"]), list(["-hide_banner", "-hwaccels"]), list(["-version"])]).then(([encoders, hwaccels, version]) => {
      const major = /^ffmpeg version n?(\d+)\./m.exec(version)?.[1];
      return {
        encoders: new Set([...encoders.matchAll(/^\s*[VAS][\w.]{5}\s+(\S+)/gm)].map((m) => m[1]!)),
        videotoolboxDecode: /^videotoolbox$/m.test(hwaccels),
        major: major === undefined ? undefined : Number(major),
      };
    });
    capsCache.set(bin, caps);
  }
  return caps;
};

const DENOISE_PROBE_SAMPLES = 16800;
const DENOISE_PROBE_CLICK = 12000;

/** How far a 32-bit float mono decode's loudest sample sits after the probe's click; undefined when it can't be the click. */
export function clickLag(pcm: Buffer): number | undefined {
  let loudest = 0;
  let at = -1;
  for (let i = 0; i + 4 <= pcm.length; i += 4) {
    const level = Math.abs(pcm.readFloatLE(i));
    if (level > loudest) {
      loudest = level;
      at = i / 4;
    }
  }
  return at < DENOISE_PROBE_CLICK ? undefined : at - DENOISE_PROBE_CLICK;
}

const denoiseProbeArgs = (bin: string) =>
  localInputs(bin, [
    "-v",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc='0.9*eq(n,${DENOISE_PROBE_CLICK})':s=48000:d=${DENOISE_PROBE_SAMPLES / 48000}`,
    "-af",
    stageFilter({ kind: "denoise", amount: 0.5 }, 0),
    "-f",
    "f32le",
    "-",
  ]);

const measureDenoiseLag = (bin: string) =>
  promisify(execFile)(bin, denoiseProbeArgs(bin), { encoding: "buffer", env: withoutApiKey(process.env), maxBuffer: 1 << 20 }).then(
    ({ stdout }) => clickLag(stdout) ?? DENOISE_LAG_SAMPLES,
    () => DENOISE_LAG_SAMPLES,
  );

const denoiseLagCache = new Map<string, Promise<number>>();
/** What afftdn delays 48 kHz audio by on this ffmpeg (D330), measured on a click once per binary. */
export const denoiseLagOf = (bin: string) => {
  let lag = denoiseLagCache.get(bin);
  if (lag === undefined) {
    lag = measureDenoiseLag(bin);
    denoiseLagCache.set(bin, lag);
  }
  return lag;
};

/**
 * How much less CPU an export's helpers (ffmpeg, the rasteriser) get than the app (a nice value):
 * the window and the server stay smooth while they use what's left, and an idle Mac is as fast.
 */
export const EXPORT_NICE = 10;

/** How long after its start a helper's priority is set again (ms): see lowerPriority. */
const PRIORITY_AGAIN_MS = 50;

/**
 * Lowers a started helper's priority (EXPORT_NICE); a process already gone is left alone. Set again
 * a moment later: on macOS about 1 child in 200 still ended up at the app's priority when it was set
 * only as spawn returned.
 */
export const lowerPriority = (child: ChildProcess) => {
  const lower = () => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      setPriority(child.pid, EXPORT_NICE);
    } catch {}
  };
  lower();
  setTimeout(lower, PRIORITY_AGAIN_MS).unref();
};

/** Threads for the export's encoder: all but two of this Mac's cores, so the app always has some. */
export const encoderThreads = (cores = availableParallelism()) => Math.max(1, cores - 2);

/**
 * Each input of `inputs` (ffmpeg input arguments) decoded with at most `threads` threads. ffmpeg
 * gives every input a thread (and its frames) per core: an export with 30 layers held over 4 GB.
 */
export const boundedDecoders = (inputs: ReadonlyArray<string>, threads = 2) =>
  inputs.flatMap((arg) => (arg === "-i" ? ["-threads", String(threads), "-i"] : [arg]));

/** The export's encode: its inputs (boundedDecoders), the graph, encoderThreads and the output, progress on stdout. */
export const encodeArgs = (
  cmd: { readonly inputs: ReadonlyArray<string>; readonly outputArgs: ReadonlyArray<string> },
  graphArgs: ReadonlyArray<string>,
  cores?: number,
) => [
  "-hide_banner",
  "-nostdin",
  "-y",
  "-nostats",
  "-progress",
  "pipe:1",
  "-stats_period",
  "0.25",
  ...boundedDecoders(cmd.inputs),
  ...graphArgs,
  "-threads:v",
  String(encoderThreads(cores)),
  ...cmd.outputArgs,
];

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a tool to the end, killing it (SIGKILL) if `signal` aborts. stdout lines go to `onLine`
 * when given (ffmpeg's -progress), else are kept; stderr keeps its last 64 kB.
 */
export function run(bin: string, args: ReadonlyArray<string>, signal: AbortSignal | undefined, onLine?: (line: string) => void): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new Cancelled());
    const child = spawn(bin, localInputs(bin, args), { env: withoutApiKey(process.env), stdio: ["ignore", "pipe", "pipe"] });
    lowerPriority(child);
    let stdout = "";
    let stderr = "";
    let partial = "";
    child.stdout.on("data", (d: Buffer) => {
      if (!onLine) return void (stdout += d);
      const lines = (partial + d).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    });
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d).slice(-65536)));
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new Cancelled());
      resolvePromise({ code, stdout, stderr });
    });
  });
}

/**
 * The project with the picture size of media whose probe lacks it read from the file (D75 review):
 * a box fits the picture by its aspect, as the preview's object-fit does with the decoded size.
 */
export async function withPictureSizes(ffmpeg: string, project: Project, mediaPath: (m: Media) => string, signal?: AbortSignal): Promise<Project> {
  const ffprobe = join(dirname(ffmpeg), "ffprobe");
  const media = await Promise.all(
    project.media.map(async (m) => {
      if (m.kind === "audio" || (m.probe?.width && m.probe?.height)) return m;
      const r = await run(
        ffprobe,
        ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", mediaPath(m)],
        signal ?? new AbortController().signal,
      ).catch(() => undefined);
      try {
        const stream = r?.code === 0 ? (JSON.parse(r.stdout) as { streams?: Array<{ width?: number; height?: number }> }).streams?.[0] : undefined;
        return stream?.width && stream.height ? { ...m, probe: { ...m.probe, width: stream.width, height: stream.height } } : m;
      } catch {
        return m;
      }
    }),
  );
  return { ...project, media };
}

/**
 * Video files of a plan whose first video stream has no colour tags, with their height (see
 * CommandOptions.untagged): the preview (Chromium on macOS) reads those as BT.601 with SMPTE-C
 * primaries below 720 lines and as BT.709 from 720 up.
 */
export async function untaggedFiles(ffmpeg: string, plan: ExportPlan, signal: AbortSignal): Promise<Map<string, number>> {
  const ffprobe = join(dirname(ffmpeg), "ffprobe");
  const out = new Map<string, number>();
  const videos = new Set(plan.visuals.flatMap((l) => (l.kind === "video" ? [l.file] : [])));
  for (const file of videos) {
    const r = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_space,height", "-of", "json", file], signal).catch(
      (error: Error) => {
        if (error instanceof Cancelled) throw error;
        return undefined;
      },
    );
    let stream: { color_space?: string; height?: number } | undefined;
    try {
      stream = r?.code === 0 ? (JSON.parse(r.stdout) as { streams?: Array<{ color_space?: string; height?: number }> }).streams?.[0] : undefined;
    } catch {}
    if (stream && (!stream.color_space || stream.color_space === "unknown")) out.set(file, stream.height ?? 0);
  }
  return out;
}

/** The last useful lines of ffmpeg's stderr, for an error message. */
export const ffmpegError = (stderr: string) =>
  stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(frame=|size=|Press \[q\])/.test(l))
    .slice(-3)
    .join(" ")
    .slice(0, 600);
