// D252: a .uncut project opened from Finder (double-click, drag onto the Dock icon, `open -a Uncut`).
// No imports, not even node:path: the sandboxed preload imports the channel name from here, and
// tests import the parser without Electron.

/** The renderer asks main, once it is connected, for a project Finder opened before it was ready. */
export const PENDING_OPEN_CHANNEL = "uncut:pending-open";

/** The UTI Info.plist exports for project folders (a package, so Finder shows one icon). */
export const PROJECT_UTI = "com.blazejkustra.uncut.project";

/**
 * The .uncut project folder a path Finder handed over stands for: the folder itself (with or without
 * a trailing slash), or the nearest enclosing .uncut folder for a path inside one (say its
 * project.json). Undefined for anything else: Uncut opens projects, not loose files.
 */
export function projectDirFromOpenedPath(opened: unknown): string | undefined {
  if (typeof opened !== "string" || !opened.startsWith("/")) return undefined;
  const parts = opened.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) return undefined;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^.+\.uncut$/i.test(parts[i]!)) return `/${parts.slice(0, i + 1).join("/")}`;
  }
  return undefined;
}
