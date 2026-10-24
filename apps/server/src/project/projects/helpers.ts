// The projects layer's helpers: errors, names, external-change lines and labels.
import { ProjectError, type Problem, EditRefused } from "@uncut/contracts";
import { type Project, EditError, EditConflict } from "@uncut/core";
import { MAX_ROWS } from "../history.ts";
import { sameJson } from "../jsonPatch.ts";

/** How many revisions history.subscribe sends (newest first; undo/redo steps aren't listed). */
export const HISTORY_LISTED = 200;

/** A change made outside Uncut in a few lines: items and media added, removed or changed. */
export function externalLines(before: Project, after: Project): Array<string> {
  const items = (p: Project) => new Map(p.tracks.flatMap((t) => t.items.map((i) => [i.id, i] as const)));
  const a = items(before);
  const b = items(after);
  const list = (ids: Array<string>) => `${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ` and ${ids.length - 5} more` : ""}`;
  const added = [...b.keys()].filter((id) => !a.has(id));
  const removed = [...a.keys()].filter((id) => !b.has(id));
  const changed = [...b.keys()].filter((id) => a.has(id) && !sameJson(a.get(id), b.get(id)));
  const mediaAdded = after.media.filter((m) => !before.media.some((x) => x.id === m.id)).map((m) => m.id);
  const mediaRemoved = before.media.filter((m) => !after.media.some((x) => x.id === m.id)).map((m) => m.id);
  const lines = [
    added.length ? `Added ${list(added)}` : "",
    removed.length ? `Removed ${list(removed)}` : "",
    changed.length ? `Changed ${list(changed)}` : "",
    mediaAdded.length ? `Added media ${list(mediaAdded)}` : "",
    mediaRemoved.length ? `Removed media ${list(mediaRemoved)}` : "",
    before.name !== after.name ? `Renamed the project to "${after.name}"` : "",
  ].filter(Boolean);
  return lines.length ? lines : ["Changed the project's settings or track order"];
}

export const EXTERNAL_LABEL = "Changed outside Uncut";
export const EXTERNAL_STOP =
  "Undo stops at the change made to project.json outside Uncut, so it isn't lost by accident. To go back further, pick an earlier version in History.";
export const COMPACTED_STOP = `Older steps aren't kept: History keeps the last ${MAX_ROWS} changes.`;

export const projectError = (reason: ProjectError["reason"], message: string, dir?: string, details: ReadonlyArray<Problem> = []) =>
  new ProjectError({ reason, message, dir, details: [...details] });

export const ioError = (dir: string) => (error: { readonly message: string }) => projectError("io", error.message, dir);

// Folder names only: no separators or control characters, no hidden folders, nothing a
// filesystem would mangle (leading/trailing spaces, trailing dots).
export const validName = (name: string) =>
  name.length > 0 &&
  name.length <= 100 &&
  name.trim() === name &&
  name.length <= MAX_NAME_LENGTH &&
  !name.startsWith(".") &&
  !name.endsWith(".") &&
  !/[\u0000-\u001f\u007f/\\:]/.test(name);

export const MAX_NAME_LENGTH = 100;

export const refused = (message: string, details: ReadonlyArray<Problem> = []) => new EditRefused({ message, details: [...details] });

export const toProblems = (error: EditError): Array<Problem> =>
  error instanceof EditConflict
    ? (error.details as Array<string>).map((id) => ({ code: "conflict", path: id, message: `"${id}" was changed by a newer edit` }))
    : (error.details as Array<Problem | string>).map((d) => (typeof d === "string" ? { code: "edit", path: "/", message: d } : d));

export const serialize = (project: unknown) => `${JSON.stringify(project, null, 2)}\n`;

/** The .gitignore a new project gets: the cache and the per-Mac undo history (D71) stay local. */
export const GITIGNORE = ".cache/\nhistory.db\nhistory.db-wal\nhistory.db-shm\n";
