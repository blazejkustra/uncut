// The user's sound folders (D208): folders the user added (the Sound effects or Audio tab's Folders
// view) whose audio files appear as a library, searchable and previewable. The files are only
// referenced: nothing is copied until one is added to a project (then into its media/, like a
// bundled sound). The list of folders is kept in <dataDir>/sound-folders.json; each folder's index
// (names, paths inside it, sizes) is made by walking it, kept for a minute, and made again on rescan.
// The Music library read from its XML is kept until that file's size or mtime changes (D262). One
// folder that can't be read is listed as missing; it never hides the others.
//
// Safety: the client names a sound by its id only; the server maps it to a path it found in the
// folder's walk, and that path's real path must still sit inside the folder's real path (a link
// swapped in later can't point outside). Hidden files and folders and links are skipped.
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, sep } from "node:path";

import { FOLDER_AUDIO_EXTENSIONS, MUSIC_LIBRARY_PATH, type FolderSound, type SoundFolder } from "@uncut/core/library";

import { MUSIC_FOLDER_NAME, musicLibraryStamp, readMusicLibrary } from "./musicApp.ts";

/** The most audio files one folder's index lists, folders it walks, and how deep. */
export const MAX_FOLDER_FILES = 5000;
const MAX_DIRS = 2000;
const MAX_DEPTH = 8;
/** An index is reused this long (rescan makes it again). */
export const INDEX_MS = 60_000;
const EXTENSIONS = new Set(FOLDER_AUDIO_EXTENSIONS);

interface Stored {
  readonly id: string;
  readonly path: string;
  readonly added: string;
}
interface Indexed {
  readonly at: number;
  readonly folder: SoundFolder;
  /** The folder's real path ("" for the Music library, whose songs can sit anywhere: D249). */
  readonly real: string;
  readonly paths: ReadonlyMap<string, string>;
  /** The Music library's XML size and mtime when it was read (D262): reused while they hold. */
  readonly stamp?: string;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
/** "Big_Whoosh-02" for big_whoosh-02.wav: the name as the list shows it. */
const nameOf = (file: string) => basename(file, extname(file)).replace(/[_]+/g, " ").trim() || basename(file);

/** ~ and $HOME expanded; must then be absolute. */
export function expandHome(path: string) {
  const p = path.trim();
  if (p === "~" || p === "$HOME") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p.startsWith("$HOME/")) return join(homedir(), p.slice(6));
  return p;
}

export class FolderError extends Error {}

/** Walks a folder for audio files (hidden entries and links skipped), at most MAX_FOLDER_FILES. */
async function walk(root: string, folderId: string): Promise<{ sounds: Array<FolderSound>; paths: Map<string, string>; truncated: boolean }> {
  const sounds: Array<FolderSound> = [];
  const paths = new Map<string, string>();
  let dirs = 0;
  let truncated = false;
  const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: "", depth: 0 }];
  while (queue.length) {
    const { dir, rel, depth } = queue.shift()!;
    if (++dirs > MAX_DIRS) {
      truncated = true;
      break;
    }
    let entries: Array<Dirent>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth + 1 <= MAX_DEPTH && e.name !== "node_modules") queue.push({ dir: join(dir, e.name), rel: relPath, depth: depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      const ext = extname(e.name).slice(1).toLowerCase();
      if (!EXTENSIONS.has(ext)) continue;
      if (sounds.length >= MAX_FOLDER_FILES) {
        truncated = true;
        break;
      }
      const full = join(dir, e.name);
      const size = await stat(full).then((s) => s.size, () => -1);
      if (size <= 0) continue;
      const id = hash(`${folderId}/${relPath}`);
      sounds.push({ id, folder: folderId, name: nameOf(e.name), rel: relPath, ext, bytes: size });
      paths.set(id, full);
    }
    if (truncated && sounds.length >= MAX_FOLDER_FILES) break;
  }
  return { sounds, paths, truncated };
}

export function soundFolders({ dataDir, now = Date.now, musicRoot, readMusic = readMusicLibrary }: { readonly dataDir: string; readonly now?: () => number; readonly musicRoot?: string | undefined; readonly readMusic?: typeof readMusicLibrary }) {
  const file = join(dataDir, "sound-folders.json");
  const indexes = new Map<string, Indexed>();
  /** Indexes being made (a second list() at the same time waits for the same one). */
  const making = new Map<string, Promise<Indexed>>();
  let lock: Promise<unknown> = Promise.resolve();
  const locked = <A>(run: () => Promise<A>): Promise<A> => {
    const next = lock.then(run, run);
    lock = next.catch(() => undefined);
    return next;
  };

  async function stored(): Promise<Array<Stored>> {
    try {
      const json = JSON.parse(await readFile(file, "utf8")) as { folders?: Array<Partial<Stored>> };
      return (json.folders ?? []).filter((f): f is Stored => typeof f.id === "string" && typeof f.path === "string" && typeof f.added === "string");
    } catch {
      return [];
    }
  }
  async function save(folders: ReadonlyArray<Stored>) {
    await mkdir(dataDir, { recursive: true });
    const part = `${file}.${randomUUID()}.part`;
    await writeFile(part, `${JSON.stringify({ folders }, null, 2)}\n`);
    await rename(part, file);
  }

  function index(f: Stored, rescan: boolean): Promise<Indexed> {
    const pending = making.get(f.id);
    if (pending && !rescan) return pending;
    const run = make(f, rescan).finally(() => making.get(f.id) === run && making.delete(f.id));
    making.set(f.id, run);
    return run;
  }

  async function make(f: Stored, rescan: boolean): Promise<Indexed> {
    const known = indexes.get(f.id);
    if (f.path === MUSIC_LIBRARY_PATH) {
      // D249: the Music app's library, its DRM-free songs (musicApp.ts). D262: an unchanged XML isn't read again.
      const stamp = await musicLibraryStamp(musicRoot);
      if (known && !rescan && (stamp ? known.stamp === stamp : now() - known.at < INDEX_MS)) return known;
      const lib = await readMusic(musicRoot, f.id, walk);
      const folder: SoundFolder = { id: f.id, path: lib.where || "~/Music", name: MUSIC_FOLDER_NAME, sounds: lib.sounds, system: "music", ...(lib.found ? {} : { missing: true }), ...(lib.truncated ? { truncated: true } : {}), ...(lib.skipped ? { skipped: lib.skipped } : {}) };
      const entry: Indexed = { at: now(), real: "", paths: lib.paths, folder, ...(stamp ? { stamp } : {}) };
      indexes.set(f.id, entry);
      return entry;
    }
    if (known && !rescan && now() - known.at < INDEX_MS) return known;
    const name = basename(f.path) || f.path;
    let real: string;
    try {
      real = await realpath(f.path);
      if (!(await stat(real)).isDirectory()) throw new Error("not a folder");
    } catch {
      const missing: Indexed = { at: now(), real: "", paths: new Map(), folder: { id: f.id, path: f.path, name, sounds: [], missing: true } };
      indexes.set(f.id, missing);
      return missing;
    }
    const { sounds, paths, truncated } = await walk(real, f.id);
    const entry: Indexed = { at: now(), real, paths, folder: { id: f.id, path: f.path, name, sounds, ...(truncated ? { truncated: true } : {}) } };
    indexes.set(f.id, entry);
    return entry;
  }

  async function list(rescan = false): Promise<Array<SoundFolder>> {
    const folders = await stored();
    for (const id of indexes.keys()) if (!folders.some((f) => f.id === id)) indexes.delete(id);
    // D262: one folder failing is listed as missing; the others still show.
    const settled = await Promise.allSettled(folders.map((f) => index(f, rescan)));
    return settled.map((r, i) => {
      if (r.status === "fulfilled") return r.value.folder;
      const f = folders[i]!;
      console.warn(`sound folder ${f.path} can't be read: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      return f.path === MUSIC_LIBRARY_PATH ? { id: f.id, path: "~/Music", name: MUSIC_FOLDER_NAME, sounds: [], system: "music" as const, missing: true } : { id: f.id, path: f.path, name: basename(f.path) || f.path, sounds: [], missing: true };
    });
  }

  function add(raw: string): Promise<Array<SoundFolder>> {
    return locked(async () => {
      if (raw.trim() === MUSIC_LIBRARY_PATH) {
        // D249: the Music app's library, asked for in the Audio tab (never scanned before that).
        const folders = await stored();
        const id = hash(MUSIC_LIBRARY_PATH);
        if (!folders.some((f) => f.id === id)) await save([...folders, { id, path: MUSIC_LIBRARY_PATH, added: new Date(now()).toISOString() }]);
        indexes.delete(id);
        return list();
      }
      const path = expandHome(raw);
      if (!path || !isAbsolute(path)) throw new FolderError("Choose a folder (a full path).");
      let real: string;
      try {
        real = await realpath(path);
        if (!(await stat(real)).isDirectory()) throw new FolderError(`${path} isn't a folder.`);
      } catch (error) {
        if (error instanceof FolderError) throw error;
        throw new FolderError(`Can't open ${path}.`);
      }
      if (real === sep) throw new FolderError("Choose a folder of sounds, not the whole disk.");
      const folders = await stored();
      const id = hash(real);
      if (!folders.some((f) => f.id === id)) {
        await save([...folders, { id, path: real, added: new Date(now()).toISOString() }]);
        indexes.delete(id);
      }
      return list();
    });
  }

  function remove(id: string): Promise<Array<SoundFolder>> {
    return locked(async () => {
      const folders = await stored();
      if (folders.some((f) => f.id === id)) await save(folders.filter((f) => f.id !== id));
      indexes.delete(id);
      return list();
    });
  }

  /** A listed sound's file: its absolute path, only while it is still a file inside its folder. */
  async function resolve(soundId: string): Promise<{ readonly path: string; readonly sound: FolderSound; readonly folder: SoundFolder } | undefined> {
    if (!/^[a-f0-9]{16}$/.test(soundId)) return undefined;
    let entry = [...indexes.values()].find((i) => i.paths.has(soundId));
    if (!entry) {
      await list();
      entry = [...indexes.values()].find((i) => i.paths.has(soundId));
    }
    if (!entry) return undefined;
    const path = entry.paths.get(soundId)!;
    try {
      const real = await realpath(path);
      // A folder's file must still sit inside it; a Music library song can be anywhere, but must be a file of an audio type.
      if (entry.folder.system === "music" ? !EXTENSIONS.has(extname(real).slice(1).toLowerCase()) : !real.startsWith(`${entry.real}${sep}`)) return undefined;
      if (!(await stat(real)).isFile()) return undefined;
      const sound = entry.folder.sounds.find((s) => s.id === soundId)!;
      return { path: real, sound, folder: entry.folder };
    } catch {
      return undefined;
    }
  }

  return { list, add, remove, resolve };
}

export type SoundFolders = ReturnType<typeof soundFolders>;
