import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute } from "node:path";
import { type Media, type Project, writeEdl, writeFcpxml } from "@uncut/core";
import { canonical, exists, plainFsError, writeInto } from "./files.ts";

export interface SavedTimeline {
  readonly path: string;
  readonly warnings: ReadonlyArray<string>;
}

const WRITERS: Readonly<Record<string, typeof writeEdl>> = { ".fcpxml": writeFcpxml, ".edl": writeEdl };

/** The open project's timeline written to `output` (.fcpxml or .edl), or why not: the same path checks as a video export. */
export async function saveTimelineFile(
  project: Project,
  mediaPath: (m: Media) => string,
  output: string,
  overwrite = false,
): Promise<SavedTimeline | { readonly reason: "invalid-path" | "exists" | "empty" | "source-media"; readonly message: string }> {
  const path = output.trim();
  const write = WRITERS[extname(path).toLowerCase()];
  if (!isAbsolute(path) || !write) return { reason: "invalid-path", message: "Choose where to save the timeline: a .fcpxml or .edl file." };
  if (!project.tracks.some((t) => t.items.length)) return { reason: "empty", message: "The timeline is empty: there's nothing to export yet." };
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
  if (!overwrite && (await exists(path))) return { reason: "exists", message: `${basename(path)} already exists in that folder.` };
  const { text, warnings } = write(project, mediaPath);
  try {
    await writeInto(path, text);
  } catch (error) {
    return { reason: "invalid-path", message: plainFsError(error, dirname(path)) };
  }
  return { path, warnings };
}
