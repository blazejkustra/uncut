import { constants } from "node:fs";
import { stat, access } from "node:fs/promises";
import { isAbsolute, dirname, basename } from "node:path";
import { type SubtitleFormat, type Project, type Media, subtitleFormatOf, subtitleCues, writeSubtitles } from "@uncut/core";
import { overwritesImported } from "../subtitleSources.ts";
import { plainFsError, canonical, exists, writeInto } from "./files.ts";

export interface SavedSubtitles {
  readonly path: string;
  readonly format: SubtitleFormat;
  readonly cues: number;
}

/** Said when there is nothing to put in a subtitles file. */
export const NO_SUBTITLES = "There are no captions or subtitles to export: make captions (Transcript, Make captions) or import a .srt or .vtt file first.";

/**
 * D105: the open project's subtitles (core subtitleCues: captions cards and Subtitles tracks, merged
 * by time) written to `output` (.srt or .vtt), or why not: the same path checks as a video export.
 */
export async function saveSubtitlesFile(
  project: Project,
  projectDir: string,
  mediaPath: (m: Media) => string,
  output: string,
  overwrite = false,
): Promise<SavedSubtitles | { readonly reason: "invalid-path" | "exists" | "empty" | "source-media"; readonly message: string }> {
  const path = output.trim();
  const format = subtitleFormatOf(path);
  if (!isAbsolute(path) || !format) return { reason: "invalid-path", message: "Choose where to save the subtitles: a .srt or .vtt file." };
  const folder = await stat(dirname(path)).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!folder) return { reason: "invalid-path", message: `The folder ${dirname(path)} doesn't exist.` };
  const writable = await access(dirname(path), constants.W_OK).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (writable) return { reason: "invalid-path", message: plainFsError(writable, dirname(path)) };
  const target = await canonical(path);
  for (const m of project.media)
    if ((await canonical(mediaPath(m))) === target)
      return { reason: "source-media", message: `Saving as ${basename(path)} would replace a file this project uses. Choose another name or folder.` };
  const imported = await overwritesImported(projectDir, path);
  if (imported) return { reason: "source-media", message: imported };
  if (!overwrite && (await exists(path))) return { reason: "exists", message: `${basename(path)} already exists in that folder.` };
  const cues = subtitleCues(project);
  if (!cues.length) return { reason: "empty", message: NO_SUBTITLES };
  try {
    await writeInto(path, writeSubtitles(cues, project.canvas.fps, format));
  } catch (error) {
    return { reason: "invalid-path", message: plainFsError(error, dirname(path)) };
  }
  return { path, format, cues: cues.length };
}
