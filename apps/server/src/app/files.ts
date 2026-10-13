// files.list (D107): one folder of the server's own disk, for a remote environment's pickers (open
// a project, where a new one goes, import, the export folder, a plugin folder). It only reads, and
// only what the server's user can read anyway; hidden entries are left out. Writes never go
// through here: they stay with the calls that already check their own targets (project.create,
// export.start, the upload route).
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { FilesError, type FileEntry, type FileListing } from "@uncut/contracts";
import * as Effect from "effect/Effect";

/** Folders with more entries are cut here (dirs first), so a huge folder can't stall the picker. */
export const MAX_ENTRIES = 2000;

const fail = (reason: FilesError["reason"], message: string) => new FilesError({ reason, message });

/** Where New project suggests saving on this machine: ~/Movies if it exists, else home. */
export const defaultParentDir = () => (existsSync(join(homedir(), "Movies")) ? join(homedir(), "Movies") : homedir());

export const listFolder = (dir: string | undefined): Effect.Effect<FileListing, FilesError> =>
  Effect.tryPromise({
    try: async (): Promise<FileListing> => {
      const home = homedir();
      const raw = dir ?? home;
      if (typeof raw !== "string" || !isAbsolute(raw) || raw.includes("\0")) throw fail("invalid-path", `Not an absolute path: ${String(raw).slice(0, 200)}`);
      const folder = resolve(raw);
      const names = (await readdir(folder)).filter((n) => !n.startsWith(".")).sort((a, b) => a.localeCompare(b));
      const entries: Array<FileEntry> = [];
      // stat follows symlinks: a link to a folder lists as a folder (reading only, D107).
      for (let i = 0; i < names.length; i += 64) {
        const batch = await Promise.all(
          names.slice(i, i + 64).map(async (name): Promise<FileEntry | undefined> => {
            try {
              const s = await stat(join(folder, name));
              if (s.isDirectory()) return { name, kind: "dir", ...(existsSync(join(folder, name, "project.json")) ? { project: true } : {}) };
              if (s.isFile()) return { name, kind: "file", size: s.size };
            } catch {}
            return undefined;
          }),
        );
        for (const e of batch) if (e) entries.push(e);
      }
      entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "dir" ? -1 : 1));
      const parent = dirname(folder);
      return { dir: folder, ...(parent !== folder ? { parent } : {}), home, entries: entries.slice(0, MAX_ENTRIES) };
    },
    catch: (error) => {
      if (error instanceof FilesError) return error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return fail("missing", "That folder isn't there any more.");
      if (code === "ENOTDIR") return fail("not-a-folder", "That's a file, not a folder.");
      if (code === "EACCES" || code === "EPERM") return fail("forbidden", "The server isn't allowed to read that folder.");
      return fail("io", `Couldn't read that folder: ${(error as Error).message}`);
    },
  });
