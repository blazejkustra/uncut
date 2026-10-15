// The media library's helpers: ids, stored paths, posters, probes, subtitles files and D209's canvas match.
import { createHash } from "node:crypto";
import { stat, readFile, realpath } from "node:fs/promises";
import { basename, relative, isAbsolute, join } from "node:path";
import { type ParsedCue, parseSubtitles, decodeSubtitleBytes, type Project, canvasForClip } from "@uncut/core";
import type { ProbeInfo } from "../mediaCore.ts";
import { MATCH_FIRST_CLIP } from "../../project/projects.ts";
import type { MediaEntry } from "./service.ts";

/** A subtitles file bigger than this isn't read (an hour of dense subtitles is ~100 kB). */
export const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;

/** A .srt / .vtt file's cues, or why it can't be imported (a sentence). */
export async function readSubtitleFile(path: string): Promise<{ readonly cues: ReadonlyArray<ParsedCue> } | { readonly problem: string }> {
  const name = basename(path);
  try {
    const s = await stat(path);
    if (s.size > MAX_SUBTITLE_BYTES) return { problem: `${name} is too big for a subtitles file (over ${MAX_SUBTITLE_BYTES / 1024 / 1024} MB).` };
    const parsed = parseSubtitles(decodeSubtitleBytes(await readFile(path)), name);
    return "problem" in parsed ? parsed : { cues: parsed.cues };
  } catch {
    return { problem: `${name} couldn't be read.` };
  }
}

/** A file inside the project folder is stored relative to it (media/captures/x.mp4, D12). */
export const storedPath = (path: string, projectDir: string) => {
  const rel = relative(projectDir, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
};

export type ProjectShape = {
  canvas: { fps: number };
  media: ReadonlyArray<{ id: string; path: string }>;
  tracks: ReadonlyArray<{ id: string; items: ReadonlyArray<{ id: string }> }>;
  scenes?: ReadonlyArray<{ id: string }>;
};

export const thumbDir = (projectDir: string) => join(projectDir, ".cache", "thumbs");

/** "DJI_0005 (final).MP4" → "m-dji-0005-final", made unique against `taken`. */
export const mediaId = (name: string, taken: Set<string>) => {
  const stem = name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "media";
  let id = `m-${stem}`;
  for (let n = 2; taken.has(id); n++) id = `m-${stem}-${n}`;
  taken.add(id);
  return id;
};

/** Every id the validator requires to be unique: media, tracks, items, scenes. */
export const allIds = (project: ProjectShape) =>
  new Set([
    ...project.media.map((m) => m.id),
    ...project.tracks.flatMap((t) => [t.id, ...t.items.map((i) => i.id)]),
    ...(project.scenes ?? []).map((s) => s.id),
  ]);

export const realOr = (path: string) => realpath(path).catch(() => path);

/**
 * A poster belongs to the file it was made from: its name carries a short hash of the path,
 * size and modification time, so a reused id or a changed file never shows a stale picture.
 */
export const posterKey = async (path: string) => {
  try {
    const s = await stat(path);
    return createHash("sha1").update(`${path}\0${s.size}\0${s.mtimeMs}`).digest("hex").slice(0, 12);
  } catch {
    return undefined;
  }
};
export const posterName = (id: string, key: string) => `${id}--${key}.jpg`;

export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".svg"]);
// ffmpeg reads "shot%d.png" as an image sequence; for one image, say it's one file.
export const imageInput = (path: string) => ["-f", "image2", "-pattern_type", "none", "-i", path];

export const PROBE_ERRORS: Record<string, string> = {
  "not-found": "The file doesn't exist.",
  unsupported: "Uncut can't read this kind of file yet.",
  unreadable: "The file couldn't be read",
};

/** ffprobe's JSON in the media core's shape, for formats the core doesn't parse. */
export const fromFfprobe = (json: string): ProbeInfo | undefined => {
  let j: { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  try {
    j = JSON.parse(json);
  } catch {
    return undefined;
  }
  const streams = j.streams ?? [];
  const image = /png_pipe|jpeg_pipe|image2|webp_pipe|gif|tiff_pipe|bmp_pipe/.test(String(j.format?.format_name ?? ""));
  const video = streams
    .filter((s) => s.codec_type === "video" && !(s.disposition as Record<string, number> | undefined)?.attached_pic)
    .sort((a, b) => Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height))[0];
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!video && !audio) return undefined;
  const [num, den] = String(video?.r_frame_rate ?? "0/0").split("/").map(Number);
  const duration = Number(j.format?.duration ?? video?.duration ?? audio?.duration);
  return {
    kind: image ? "image" : video ? "video" : "audio",
    container: String(j.format?.format_name ?? "unknown").split(",")[0]!,
    ...(Number.isFinite(duration) && !image ? { durationSeconds: duration } : {}),
    ...(video ? { width: Number(video.width), height: Number(video.height), videoCodec: String(video.codec_name) } : {}),
    ...(num && den && !image ? { fps: `${num}/${den}`, fpsValue: num / den } : {}),
    ...(audio ? { audioCodec: String(audio.codec_name) } : {}),
    hasAudio: Boolean(audio),
    via: "ffprobe",
  };
};

/** A probe in project terms: the length in project frames, the picture as shown. */
/** D209: whether the project was made with "Match first clip" and hasn't matched one yet. */
export const matchPending = (dir: string) =>
  stat(join(dir, ".cache", MATCH_FIRST_CLIP)).then(
    () => true,
    () => false,
  );

/**
 * D209: the canvas the first video asks for, when the project has no video yet and an empty
 * timeline (a rate change retimes nothing then); undefined otherwise or when it's the same.
 */
export function matchCanvas(project: Project, probed: ReadonlyArray<{ readonly info: ProbeInfo }>): Project["canvas"] | undefined {
  if (project.media.some((m) => m.kind === "video") || project.tracks.some((t) => t.items.length)) return undefined;
  const clip = probed.find((p) => p.info.kind === "video" && p.info.width && p.info.height)?.info;
  if (!clip) return undefined;
  const next = canvasForClip(project.canvas, { width: clip.width, height: clip.height, fps: clip.fpsValue, rotation: clip.rotation });
  if (!next || (next.width === project.canvas.width && next.height === project.canvas.height && next.fps === project.canvas.fps)) return undefined;
  return next;
}

export const probeOf = (info: ProbeInfo, fps: number): MediaEntry["probe"] => {
  // The project stores the picture as shown: a phone clip turned 90° is portrait.
  const turned = info.rotation === 90 || info.rotation === 270;
  const width = turned ? info.height : info.width;
  const height = turned ? info.width : info.height;
  const frames = info.kind !== "image" && info.durationSeconds ? Math.max(1, Math.floor(info.durationSeconds * fps)) : undefined;
  return { ...(frames ? { frames } : {}), ...(info.fpsValue ? { fps: info.fpsValue } : {}), ...(width ? { width } : {}), ...(height ? { height } : {}), hasAudio: info.hasAudio };
};
