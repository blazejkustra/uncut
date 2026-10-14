// The turn-end clean-up (issue #38, D206): graphics the agent wrote that nothing uses any more go
// to the project's trash (.cache/trash/<turn id>/graphics/, put back by Undo turn or the turn's
// Restore), and tracks the agent made in the turn that are empty at its end are removed (an edit of
// the turn). Only the agent's own graphics are ever moved: a file the user wrote is never touched.
import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import { GRAPHIC_SRC, type Project } from "@uncut/core";

/** The last this many revisions of history count as "in use" (a recent Undo or History jump still finds its graphics). */
export const KEEP_REVISIONS = 50;

export const trashDir = (dir: string, turnId: string) => join(dir, ".cache", "trash", turnId, "graphics");

/** Whether `name` (graphics/<name>) is referenced anywhere in these projects (any field: items, components, keys). */
const usedIn = (texts: ReadonlyArray<string>, name: string) => texts.some((t) => t.includes(`graphics/${name}"`) || t.includes(`graphics/${name}?`) || t.includes(`graphics/${name}#`));

/**
 * Of the agent's graphics (`candidates`, file names in graphics/), the ones that exist and that no
 * project in `states` (the current one and recent history) refers to, nor another graphic that is
 * kept (a graphic can load another).
 */
export async function unusedGraphics(dir: string, candidates: Iterable<string>, states: ReadonlyArray<unknown>): Promise<Array<string>> {
  const texts = states.map((p) => JSON.stringify(p));
  let present: Array<string>;
  try {
    present = await readdir(join(dir, "graphics"));
  } catch {
    return [];
  }
  const all = new Set(present);
  const unused = [...new Set(candidates)].filter((n) => GRAPHIC_SRC.test(`graphics/${n}`) && all.has(n) && !usedIn(texts, n)).sort();
  if (!unused.length) return [];
  // A kept graphic that names one keeps it too.
  const kept = present.filter((n) => n.endsWith(".html") && !unused.includes(n));
  const keptText = (await Promise.all(kept.slice(0, 200).map((n) => readFile(join(dir, "graphics", n), "utf8").catch(() => "")))).join("\n");
  return unused.filter((n) => !keptText.includes(n));
}

/** Moves graphics/<name> to the turn's trash; the names actually moved. */
export async function trashGraphics(dir: string, turnId: string, names: ReadonlyArray<string>): Promise<Array<string>> {
  if (!names.length) return [];
  const to = trashDir(dir, turnId);
  await mkdir(to, { recursive: true });
  const moved: Array<string> = [];
  for (const n of names) {
    try {
      await rename(join(dir, "graphics", n), join(to, n));
      moved.push(n);
    } catch {}
  }
  return moved;
}

/** Puts the turn's trashed graphics back (not over a file written since with the same name); the names restored. */
export async function restoreGraphics(dir: string, turnId: string, names: ReadonlyArray<string>): Promise<Array<string>> {
  const from = trashDir(dir, turnId);
  const back: Array<string> = [];
  await mkdir(join(dir, "graphics"), { recursive: true });
  for (const n of names) {
    if (!GRAPHIC_SRC.test(`graphics/${n}`)) continue;
    try {
      await stat(join(dir, "graphics", n));
      continue;
    } catch {}
    try {
      await rename(join(from, n), join(dir, "graphics", n));
      back.push(n);
    } catch {}
  }
  return back;
}

/** Tracks the agent added in the turn (`added`) that are empty now (never the main track, never a locked one). */
export function emptyAddedTracks(project: Project, added: ReadonlySet<string>): Array<string> {
  return project.tracks.filter((t) => added.has(t.id) && t.role !== "main" && !t.locked && t.items.length === 0).map((t) => t.id);
}
