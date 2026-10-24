// Takes recorded on this Mac (D114): the Capture tab's microphone, camera and screen recordings.
// The renderer records with MediaRecorder (webm: Opus, VP8/VP9) and uploads the file to
// /api/upload, so it lands in the open project's media/uploads/ on whichever server is active
// (Local or a remote, D108). Here it's moved out of uploads into media/captures/ as a proper file:
// MediaRecorder's webm has no length in its header and a variable frame rate, so it's converted
// with ffmpeg (a voiceover to AAC in .m4a; camera and screen to H.264 + AAC in .mp4 at the
// project's frame rate). The upload is removed once the conversion is there; a failed conversion
// leaves it in media/uploads/ and says so.
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { TAKE_UPLOAD_NAME, type TakeKind } from "@uncut/contracts";

import { runProbe } from "../media/probe.ts";
import { safeUploadName } from "../app/remote.ts";

/** The media source module a take is stored with. */
export const TAKE_MODULE: Record<TakeKind, string> = {
  voiceover: "capture.microphone",
  camera: "capture.camera",
  screen: "capture.screen",
  system: "capture.system",
};
const DEFAULT_NAME: Record<TakeKind, string> = { voiceover: "Voiceover", camera: "Camera", screen: "Screen", system: "Mac sound" };
/** D211: a multi-source take's files in its own folder (media/captures/<take>/). */
export const MULTI_FILE: Record<TakeKind, string> = { screen: "screen.mp4", camera: "camera.mp4", voiceover: "mic.m4a", system: "system.m4a" };
/** D211: the display name of a multi-source take's part ("Take 20261015-101500 camera"). */
export const MULTI_PART_NAME: Record<TakeKind, string> = { screen: "screen", camera: "camera", voiceover: "microphone", system: "Mac sound" };
/** Whether a take of this kind is sound only (an .m4a). */
export const audioOnly = (kind: TakeKind) => kind === "voiceover" || kind === "system";

const inside = (dir: string, file: string) => {
  const rel = relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

const pad = (n: number) => String(n).padStart(2, "0");
/** 20261013-101500, like Argent's takes (D98). */
export const stamp = (d = new Date()) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** "Voiceover 20261013-101500.m4a": the given name (made safe) or the kind's, the time, the extension. */
export function takeFileName(kind: TakeKind, name: string | undefined, at = new Date()) {
  const stem = name?.trim() ? safeUploadName(name.trim()).slice(0, 80).trim() : DEFAULT_NAME[kind];
  return `${stem} ${stamp(at)}.${audioOnly(kind) ? "m4a" : "mp4"}`;
}

/** ffmpeg's arguments for a take (`-n`: never over an existing file). */
export function ffmpegArgs(kind: TakeKind, input: string, output: string, fps: number, encoder: "libx264" | "h264_videotoolbox" = "libx264"): Array<string> {
  if (audioOnly(kind))
    return ["-v", "error", "-nostdin", "-n", "-i", input, "-vn", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", output];
  const video = encoder === "libx264" ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"] : ["-c:v", "h264_videotoolbox", "-b:v", "12M"];
  return [
    "-v",
    "error",
    "-nostdin",
    "-n",
    "-i",
    input,
    ...video,
    "-pix_fmt",
    "yuv420p",
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-r",
    String(fps),
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    output,
  ];
}

/**
 * The uploaded recording, if it's a regular file in the project's media/uploads/ named like the
 * Capture tab's uploads (TAKE_UPLOAD_NAME) and not used by the project's media (a file the user
 * uploaded, D108, is never converted or removed); else a sentence. `mediaPaths`: the project's
 * media paths as stored (relative to the project or absolute).
 */
export async function uploadedTake(
  path: string,
  projectDir: string,
  mediaPaths: ReadonlyArray<string> = [],
): Promise<{ readonly file: string } | { readonly problem: string }> {
  if (typeof path !== "string" || !isAbsolute(path)) return { problem: "The recording's path isn't absolute." };
  if (!TAKE_UPLOAD_NAME.test(basename(path))) return { problem: "That file isn't a recording from the Capture tab, so it wasn't touched." };
  try {
    const file = await realpath(path);
    if (!TAKE_UPLOAD_NAME.test(basename(file))) return { problem: "That file isn't a recording from the Capture tab, so it wasn't touched." };
    for (const p of mediaPaths) {
      const used = await realpath(isAbsolute(p) ? p : resolve(projectDir, p)).catch(() => undefined);
      if (used === file) return { problem: "That file is already media in the project, so it wasn't touched." };
    }
    const uploads = await realpath(join(projectDir, "media", "uploads")).catch(() => undefined);
    if (!uploads || !inside(uploads, file)) return { problem: "The recording isn't in the project's media/uploads folder." };
    const s = await stat(file);
    if (!s.isFile()) return { problem: "The recording isn't a file." };
    if (s.size === 0) return { problem: "The recording is empty." };
    return { file };
  } catch {
    return { problem: "The recording's file isn't there." };
  }
}

/**
 * Converts the uploaded recording into `<project>/media/captures/<name>`; the upload goes once the
 * new file is there. Returns the new file, or a sentence.
 */
export async function convertTake(input: {
  readonly ffmpeg: string;
  readonly env: Record<string, string>;
  readonly projectDir: string;
  readonly upload: string;
  readonly kind: TakeKind;
  readonly name?: string | undefined;
  readonly fps: number;
  /** D211: a folder inside media/captures/ (a multi-source take's) and the file's own name in it. */
  readonly subfolder?: string | undefined;
  readonly fileName?: string | undefined;
}): Promise<{ readonly file: string } | { readonly problem: string }> {
  const { ffmpeg, env, projectDir, upload, kind, name, fps } = input;
  const project = await realpath(projectDir);
  const folder = join(projectDir, "media", "captures", ...(input.subfolder ? [safeUploadName(input.subfolder)] : []));
  await mkdir(folder, { recursive: true });
  const real = await realpath(folder);
  if (!inside(project, real)) return { problem: "The project's media/captures folder points outside the project, so the take wasn't saved." };
  const file = input.fileName ?? takeFileName(kind, name);
  const ext = file.slice(file.lastIndexOf("."));
  const stem = file.slice(0, -ext.length);
  let target = "";
  for (let n = 1; n < 100; n++) {
    const candidate = join(real, n === 1 ? file : `${stem} ${n}${ext}`);
    if (
      !(await stat(candidate).then(
        () => true,
        () => false,
      ))
    ) {
      target = candidate;
      break;
    }
  }
  if (!target) return { problem: "Too many takes with that name in media/captures." };
  const attempt = async (encoder: "libx264" | "h264_videotoolbox") => {
    const r = await runProbe(ffmpeg, ffmpegArgs(kind, upload, target, fps, encoder), { timeoutMs: 30 * 60 * 1000, env });
    if (r.kind === "done" && r.code === 0) return true;
    await rm(target, { force: true });
    return false;
  };
  const ok = (await attempt("libx264")) || (!audioOnly(kind) && (await attempt("h264_videotoolbox")));
  if (!ok) return { problem: `ffmpeg couldn't convert the take; the recording is still in media/uploads/${basename(upload)}.` };
  await rm(upload, { force: true });
  return { file: target };
}
