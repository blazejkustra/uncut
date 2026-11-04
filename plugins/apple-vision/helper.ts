// Runs uncut-vision (native/vision, Swift on Apple Vision) for the Apple Vision plugin. Self-contained
// (only node: imports), so the plugin folder works as copied.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";

export const HELPER = "uncut-vision";
export const NO_HELPER = "This build of Uncut has no Apple Vision helper (uncut-vision). Build it with node native/vision/build.ts.";

/** Where the helper is: Resources/bin in the app (plugins sit in Resources/plugins), native/vision/out in the repo. */
export const helperCandidates = (pluginDir: string) => [join(pluginDir, "../../bin", HELPER), join(pluginDir, "../../native/vision/out", HELPER)];

export const findHelper = (pluginDir: string) => helperCandidates(pluginDir).find((path) => existsSync(path));

export class Stopped extends Error {
  constructor() {
    super("cancelled");
  }
}

export type MatteMode = "person" | "subject";

export interface HelperEvent {
  readonly event: "start" | "frame" | "progress" | "done" | "error";
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly t?: number;
  readonly done?: number;
  readonly total?: number;
  readonly message?: string;
}

export interface RunOptions {
  readonly signal: AbortSignal;
  readonly onProgress?: (done: number, total: number) => void;
}

export const parseEvent = (line: string): HelperEvent | undefined => {
  if (!line.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(line) as HelperEvent;
    return typeof value.event === "string" ? value : undefined;
  } catch {
    return undefined;
  }
};

/** FFV1 grey frames from stdin (D291's settings), 4 threads at most. */
export const matteFfmpegArgs = (width: number, height: number, fps: number, out: string) => [
  "-hide_banner",
  "-nostdin",
  "-v",
  "error",
  "-threads",
  "4",
  "-f",
  "rawvideo",
  "-pix_fmt",
  "gray",
  "-s",
  `${width}x${height}`,
  "-framerate",
  String(fps),
  "-i",
  "pipe:0",
  "-c:v",
  "ffv1",
  "-level",
  "3",
  "-g",
  "1",
  "-slices",
  width < 64 || height < 64 ? "1" : "16",
  "-threads",
  "4",
  "-f",
  "matroska",
  "-y",
  out,
];

export const rangeArgs = (start: number, end: number | undefined) => ["--start", String(start), ...(end !== undefined ? ["--end", String(end)] : [])];

function onEvents(child: ChildProcess, handle: (event: HelperEvent) => void) {
  let partial = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    const lines = (partial + chunk.toString()).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseEvent(line.trim());
      if (event) handle(event);
    }
  });
}

interface Exit {
  readonly code: number | null;
  readonly error?: Error;
}

/** How a child ended; never rejects (a spawn error, e.g. a missing binary, is its `error`). */
const exitOf = (child: ChildProcess) =>
  new Promise<Exit>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code) => resolve({ code }));
  });

const lastLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" ")
    .slice(0, 400);

const helperFailure = (exit: Exit, message: string | undefined) =>
  new Error(exit.error ? `The Apple Vision helper couldn't start: ${exit.error.message}` : (message ?? `The Apple Vision helper stopped (exit ${exit.code}).`));

export interface MatteInput {
  readonly helper: string;
  readonly ffmpeg: string;
  readonly media: string;
  readonly start: number;
  readonly end?: number | undefined;
  readonly mode: MatteMode;
  readonly out: string;
}

export interface MatteAnswer {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frames: number;
  readonly times: ReadonlyArray<number>;
}

/** The helper's grey frames through ffmpeg into `out`; the frames' source times come from its log. Nothing is left at `out` unless it succeeds. */
export async function runMatte(input: MatteInput, { signal, onProgress }: RunOptions): Promise<MatteAnswer> {
  if (signal.aborted) throw new Stopped();
  const helper = spawn(input.helper, ["matte", "--input", input.media, ...rangeArgs(input.start, input.end), "--mode", input.mode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const helperExit = exitOf(helper);
  let encoder: ChildProcess | undefined;
  let encoderExit: Promise<Exit> = Promise.resolve({ code: 0 });
  let encoderLog = "";
  let size: HelperEvent | undefined;
  let failure: string | undefined;
  const times: Array<number> = [];
  const kill = () => {
    helper.kill("SIGKILL");
    encoder?.kill("SIGKILL");
  };
  signal.addEventListener("abort", kill, { once: true });
  helper.once("exit", () => encoder ?? helper.stdout!.resume());

  const startEncoder = (event: HelperEvent) => {
    encoder = spawn(input.ffmpeg, matteFfmpegArgs(event.width!, event.height!, event.fps!, input.out), { stdio: ["pipe", "ignore", "pipe"] });
    encoderExit = exitOf(encoder).then((exit) => {
      if (exit.code !== 0) helper.kill("SIGKILL");
      return exit;
    });
    encoder.stderr!.on("data", (d: Buffer) => (encoderLog = (encoderLog + d.toString()).slice(-8000)));
    encoder.stdin!.on("error", () => {});
    helper.stdout!.pipe(encoder.stdin!);
  };

  onEvents(helper, (event) => {
    if (event.event === "start" && !size) {
      size = event;
      startEncoder(event);
    } else if (event.event === "frame" && typeof event.t === "number") times.push(event.t);
    else if (event.event === "progress" && event.done !== undefined && event.total !== undefined) onProgress?.(event.done, event.total);
    else if (event.event === "error") failure = event.message;
  });

  try {
    const helperDone = await helperExit;
    const encoderDone = await encoderExit;
    if (signal.aborted) throw new Stopped();
    if (encoderDone.error) throw new Error(`ffmpeg couldn't start (${input.ffmpeg}): ${encoderDone.error.message}`);
    if (encoderDone.code !== 0) throw new Error(`ffmpeg couldn't write the matte (exit ${encoderDone.code}): ${lastLines(encoderLog) || "it said nothing"}`);
    if (helperDone.code !== 0) throw helperFailure(helperDone, failure);
    if (!size || !times.length) throw new Error("The matte came out with no frames.");
    return { width: size.width!, height: size.height!, fps: size.fps!, frames: times.length, times };
  } catch (error) {
    await rm(input.out, { force: true });
    throw signal.aborted ? new Stopped() : error;
  } finally {
    signal.removeEventListener("abort", kill);
  }
}

/** A helper command that answers JSON on stdout (faces, track), written to `out`; nothing is left there unless it succeeds. */
export async function runToFile(helperPath: string, args: ReadonlyArray<string>, out: string, { signal, onProgress }: RunOptions): Promise<void> {
  if (signal.aborted) throw new Stopped();
  const helper = spawn(helperPath, [...args], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = exitOf(helper);
  const file = createWriteStream(out);
  const written = finished(file).then(
    () => undefined,
    (error: Error) => error,
  );
  let failure: string | undefined;
  const kill = () => helper.kill("SIGKILL");
  signal.addEventListener("abort", kill, { once: true });
  helper.stdout!.pipe(file);
  onEvents(helper, (event) => {
    if (event.event === "progress" && event.done !== undefined && event.total !== undefined) onProgress?.(event.done, event.total);
    else if (event.event === "error") failure = event.message;
  });
  try {
    const done = await exit;
    if (done.error) file.end();
    const writeError = await written;
    if (signal.aborted) throw new Stopped();
    if (done.code !== 0) throw helperFailure(done, failure);
    if (writeError) throw new Error(`Couldn't write ${out}: ${writeError.message}`);
  } catch (error) {
    await rm(out, { force: true });
    throw signal.aborted ? new Stopped() : error;
  } finally {
    signal.removeEventListener("abort", kill);
  }
}

/** The helper's own version line, e.g. "uncut-vision 1". */
export function helperVersion(helperPath: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(helperPath, ["version"], { timeout: 10_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))),
  );
}
