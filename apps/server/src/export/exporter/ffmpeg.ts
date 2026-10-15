import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import type { Project, Media } from "@uncut/core";
import type { Caps, ExportPlan } from "../exportPlan.ts";
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
    const list = (args: Array<string>) => run(bin, args, undefined).then((r) => r.stdout, () => "");
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
      const r = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", mediaPath(m)], signal ?? new AbortController().signal).catch(() => undefined);
      try {
        const stream = r?.code === 0 ? (JSON.parse(r.stdout) as { streams?: Array<{ width?: number; height?: number }> }).streams?.[0] : undefined;
        return stream?.width && stream.height ? { ...m, probe: { ...(m.probe ?? {}), width: stream.width, height: stream.height } } : m;
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
    const r = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_space,height", "-of", "json", file], signal).catch((error: Error) => {
      if (error instanceof Cancelled) throw error;
      return undefined;
    });
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
