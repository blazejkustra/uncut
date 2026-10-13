// The .srt / .vtt files a project imported (D105): recorded by the import, so neither the agent's
// subtitles_export nor the export dialog's file next to the video ever writes over one of them.
// Kept in the project's .cache (no project.json field: a track has no place for a path); a cleared
// cache forgets them (a known limit).
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const fileOf = (projectDir: string) => join(projectDir, ".cache", "subtitle-sources.json");

/** A path as the file system knows it (symlinks resolved), the parent's when it doesn't exist. */
export const canonicalPath = async (path: string) => {
  try {
    return await realpath(path);
  } catch {
    return join(await realpath(dirname(path)).catch(() => dirname(path)), basename(path));
  }
};

/** The real paths of the subtitles files this project imported. */
export async function importedSubtitleSources(projectDir: string): Promise<Set<string>> {
  try {
    const list = JSON.parse(await readFile(fileOf(projectDir), "utf8")) as unknown;
    return new Set(Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : []);
  } catch {
    return new Set();
  }
}

/** Remember imported subtitles files (by real path). */
export async function recordSubtitleSources(projectDir: string, paths: ReadonlyArray<string>) {
  if (!paths.length) return;
  const known = await importedSubtitleSources(projectDir);
  for (const p of paths) known.add(await canonicalPath(p));
  await mkdir(dirname(fileOf(projectDir)), { recursive: true });
  await writeFile(fileOf(projectDir), JSON.stringify([...known], null, 2));
}

/** The sentence refusing to write over an imported subtitles file, or undefined. */
export async function overwritesImported(projectDir: string, path: string): Promise<string | undefined> {
  const target = await canonicalPath(path);
  return (await importedSubtitleSources(projectDir)).has(target) ? `${basename(path)} is a subtitles file this project imported, and Uncut never writes over it. Choose another name.` : undefined;
}
