// D332: a module's matte made steady (matteStability.ts) before Uncut keeps it, so preview and
// export read the same steady matte. Two passes, each streamed through ffmpeg (4 threads): the
// survey reads the matte and the picture small and plans the holds; the second pass reads the
// matte at full size and the picture at the gate size, swaps the holds in, runs the median and
// writes a new FFV1 matte.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";

import type { MatteInfo } from "@uncut/contracts";

import { withoutApiKey } from "../../app/shellEnv.ts";
import { localInputs } from "../../media/localInputs.ts";
import { Cancelled } from "../analysisRunner.ts";
import { type Good, heldMatte } from "./matteHold.ts";
import { STABILITY, TemporalMedian, coverage, findCuts, holdLimits, meanDifference, planHolds } from "./matteStability.ts";

export interface StabiliseInput {
  readonly ffmpeg: string;
  /** The media file the matte was made from. */
  readonly source: string;
  /** The module's matte (.mkv) and where the steady one goes. */
  readonly matte: string;
  readonly out: string;
  readonly info: MatteInfo;
}

export interface StabiliseOptions {
  readonly signal: AbortSignal;
  readonly onProgress?: ((fraction: number) => void) | undefined;
}

const SURVEY_SHARE = 0.3;

interface Size {
  readonly w: number;
  readonly h: number;
}

const sizeAcross = (width: number, height: number, w: number): Size => {
  const across = Math.min(w, width);
  return { w: across, h: Math.max(1, Math.round((across * height) / width)) };
};

const FFMPEG_BASE = ["-hide_banner", "-nostdin", "-v", "error", "-threads", "4"];

type PixelFormat = "gray" | "rgb24";

const scaled = ({ w, h }: Size, format: PixelFormat) => ["-vf", `scale=${w}:${h}:flags=area,format=${format}`];

const rawOut = (format: PixelFormat) => ["-f", "rawvideo", "-pix_fmt", format, "pipe:1"];

const matteArgs = (matte: string, size: Size | undefined) => [...FFMPEG_BASE, "-i", matte, ...(size ? scaled(size, "gray") : []), ...rawOut("gray")];

/** The source's frames from the matte's first one: ffmpeg drops frames before -ss, so it starts a millisecond early. */
const pictureArgs = (source: string, info: MatteInfo, size: Size, format: PixelFormat) => [
  ...FFMPEG_BASE,
  ...(info.times[0]! > 0.001 ? ["-ss", String(info.times[0]! - 0.001)] : []),
  "-i",
  source,
  "-map",
  "0:v:0",
  "-frames:v",
  String(info.frames),
  ...scaled(size, format),
  "-fps_mode",
  "passthrough",
  ...rawOut(format),
];

const encoderArgs = (info: MatteInfo, out: string) => [
  ...FFMPEG_BASE,
  ...["-f", "rawvideo", "-pix_fmt", "gray", "-s", `${info.width}x${info.height}`, "-framerate", String(info.fps), "-i", "pipe:0"],
  ...["-c:v", "ffv1", "-level", "3", "-g", "1", "-slices", info.width < 64 || info.height < 64 ? "1" : "16", "-threads", "4"],
  ...["-f", "matroska", "-y", out],
];

const spawnFfmpeg = (ffmpeg: string, args: ReadonlyArray<string>, stdin: "ignore" | "pipe") =>
  spawn(ffmpeg, localInputs(ffmpeg, args), { env: withoutApiKey(process.env), stdio: [stdin, stdin === "pipe" ? "ignore" : "pipe", "pipe"] });

interface Exit {
  readonly code: number | null;
  readonly log: string;
}

function exitOf(child: ChildProcess): Promise<Exit> {
  let log = "";
  child.stderr?.on("data", (d: Buffer) => (log = (log + d.toString()).slice(-2000)));
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, log: error.message }));
    child.once("close", (code) => resolve({ code, log }));
  });
}

const lastLine = (log: string) => log.trim().split("\n").at(-1) ?? "";

/** An ffmpeg's raw frames of `size` bytes from its stdout, each a new buffer; it is killed when the reader stops early or the signal aborts. */
async function* rawFrames(ffmpeg: string, args: ReadonlyArray<string>, size: number, what: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const child = spawnFfmpeg(ffmpeg, args, "ignore");
  const exit = exitOf(child);
  const kill = () => child.kill("SIGKILL");
  signal.addEventListener("abort", kill, { once: true });
  try {
    let frame = new Uint8Array(size);
    let filled = 0;
    for await (const chunk of child.stdout! as AsyncIterable<Buffer>) {
      for (let at = 0; at < chunk.length;) {
        const n = Math.min(size - filled, chunk.length - at);
        frame.set(chunk.subarray(at, at + n), filled);
        filled += n;
        at += n;
        if (filled < size) continue;
        yield frame;
        frame = new Uint8Array(size);
        filled = 0;
      }
    }
    const done = await exit;
    if (signal.aborted) throw new Cancelled();
    if (done.code !== 0) throw new Error(`ffmpeg couldn't read ${what}: ${lastLine(done.log)}`);
  } finally {
    signal.removeEventListener("abort", kill);
    if (child.exitCode === null) kill();
  }
}

/** Reads `count` frames from two streams side by side; a stream that ends early gives undefined from there. */
async function* paired(a: AsyncGenerator<Uint8Array>, b: AsyncGenerator<Uint8Array>, count: number): AsyncGenerator<[Uint8Array, Uint8Array | undefined]> {
  try {
    for (let t = 0; t < count; t++) {
      const [matte, picture] = await Promise.all([a.next(), b.next()]);
      if (matte.done) throw new Error(`The matte has ${t} frames, not ${count}.`);
      yield [matte.value, picture.done ? undefined : picture.value];
    }
  } finally {
    await Promise.allSettled([a.return(undefined), b.return(undefined)]);
  }
}

interface Plan {
  readonly use: Int32Array;
  readonly cutBefore: Uint8Array;
}

/** Pass one: each frame's matte coverage and picture change (in colour, so a cut between shots of the same brightness counts), then the cuts and holds. */
async function survey(input: StabiliseInput, { signal, onProgress }: StabiliseOptions): Promise<Plan> {
  const { ffmpeg, info } = input;
  const size = sizeAcross(info.width, info.height, STABILITY.surveyWidth);
  const areas = new Float32Array(info.frames);
  const change = new Float32Array(info.frames);
  const mattes = rawFrames(ffmpeg, matteArgs(input.matte, size), size.w * size.h, "the matte", signal);
  const pictures = rawFrames(ffmpeg, pictureArgs(input.source, info, size, "rgb24"), 3 * size.w * size.h, "the video", signal);
  let before: Uint8Array | undefined;
  let t = 0;
  for await (const [matte, picture] of paired(mattes, pictures, info.frames)) {
    areas[t] = coverage(matte);
    change[t] = before && picture ? meanDifference(before, picture) : 0;
    before = picture;
    t++;
    onProgress?.((SURVEY_SHARE * t) / info.frames);
  }
  const cutBefore = findCuts(change);
  return { use: planHolds(areas, cutBefore, holdLimits(info.fps)), cutBefore };
}

/** Writes frames to ffmpeg's stdin, waiting while its pipe is full; an encoder that died fails at once. */
class Encoder {
  private readonly child: ChildProcess;
  readonly exit: Promise<Exit>;

  constructor(ffmpeg: string, info: MatteInfo, out: string) {
    this.child = spawnFfmpeg(ffmpeg, encoderArgs(info, out), "pipe");
    this.exit = exitOf(this.child);
    this.child.stdin!.on("error", () => {});
  }

  async write(frames: ReadonlyArray<Uint8Array>) {
    for (const frame of frames) {
      if (this.child.stdin!.write(frame)) continue;
      const ended = await Promise.race([once(this.child.stdin!, "drain").then(() => false), this.exit.then(() => true)]);
      if (ended) throw new Error(`ffmpeg couldn't write the steady matte: ${lastLine((await this.exit).log)}`);
    }
  }

  async end() {
    this.child.stdin!.end();
    const done = await this.exit;
    if (done.code !== 0) throw new Error(`ffmpeg couldn't write the steady matte: ${lastLine(done.log)}`);
  }

  kill() {
    this.child.kill("SIGKILL");
  }
}

/** Pass two: the holds swapped in, the median, the new matte written. */
async function smooth(input: StabiliseInput, plan: Plan, { signal, onProgress }: StabiliseOptions) {
  const { ffmpeg, info } = input;
  const gate = sizeAcross(info.width, info.height, STABILITY.gateWidth);
  const median = new TemporalMedian({ width: info.width, height: info.height, gateWidth: gate.w, gateHeight: gate.h });
  const mattes = rawFrames(ffmpeg, matteArgs(input.matte, undefined), info.width * info.height, "the matte", signal);
  const pictures = rawFrames(ffmpeg, pictureArgs(input.source, info, gate, "gray"), gate.w * gate.h, "the video", signal);
  const encoder = new Encoder(ffmpeg, info, input.out);
  const kill = () => encoder.kill();
  signal.addEventListener("abort", kill, { once: true });
  try {
    let good: Good | undefined;
    let t = 0;
    for await (const [matte, pixels] of paired(mattes, pictures, info.frames)) {
      const picture = pixels && { pixels, w: gate.w, h: gate.h };
      const dropout = plan.use[t] !== t;
      const hold = dropout && good ? heldMatte(good, picture, info.width, info.height) : undefined;
      if (!dropout) good = picture && { matte, picture };
      await encoder.write(median.push({ matte: hold ?? matte, picture: pixels, dropout, cutBefore: plan.cutBefore[t] === 1 }));
      t++;
      onProgress?.(SURVEY_SHARE + ((1 - SURVEY_SHARE) * t) / info.frames);
    }
    await encoder.write(median.flush());
    await encoder.end();
  } catch (error) {
    kill();
    throw signal.aborted ? new Cancelled() : error;
  } finally {
    signal.removeEventListener("abort", kill);
  }
}

/** The steady matte at `out`, same size, frame count and clock as the module's. A failure or cancel can leave part of `out` behind for the caller to remove. */
export async function stabiliseMatte(input: StabiliseInput, options: StabiliseOptions): Promise<void> {
  if (options.signal.aborted) throw new Cancelled();
  const plan = await survey(input, options);
  await smooth(input, plan, options);
}
