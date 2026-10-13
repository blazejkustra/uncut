// The bundled music library (D91) going into a project: a track is copied into the project's
// media/ folder (D12: a project that points into the app bundle breaks once it's moved to another
// Mac or the app is updated), under its own file name, or a numbered one when a different file
// already has that name. An identical copy already there is reused. Used by the renderer's
// music.add and the agent's music_add.
import { randomUUID } from "node:crypto";
import { copyFile, link, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { join, sep } from "node:path";

import { musicTrack, type MusicTrack } from "@uncut/core/music";

const same = async (a: string, b: string) => {
  const [sa, sb] = await Promise.all([stat(a), stat(b)]);
  if (sa.size !== sb.size) return false;
  const [ba, bb] = await Promise.all([readFile(a), readFile(b)]);
  return ba.equals(bb);
};

// One copy at a time per project folder: two adds of the same track (a double click, the agent
// and the user at once) must end with one file, both answered with it.
const queues = new Map<string, Promise<unknown>>();
function serialised<A>(key: string, run: () => Promise<A>): Promise<A> {
  const before = queues.get(key) ?? Promise.resolve();
  const next = before.then(run, run);
  const settled = next.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return next;
}

/**
 * Copies the library track into `<projectDir>/media/` and returns its path relative to the project
 * (media/cozy-2.m4a), or a sentence saying why it couldn't.
 */
export function copyLibraryTrack(musicDir: string, projectDir: string, id: string): Promise<{ readonly track: MusicTrack; readonly path: string } | { readonly problem: string }> {
  return serialised(projectDir, () => copyOnce(musicDir, projectDir, id));
}

async function copyOnce(musicDir: string, projectDir: string, id: string): Promise<{ readonly track: MusicTrack; readonly path: string } | { readonly problem: string }> {
  const track = musicTrack(id);
  if (!track) return { problem: `There's no library track "${id}".` };
  const source = join(musicDir, track.file);
  try {
    await stat(source);
  } catch {
    return { problem: `The library file ${track.file} is missing from this copy of Uncut.` };
  }
  try {
    const folder = join(projectDir, "media");
    await mkdir(folder, { recursive: true });
    // media/ must be the project's own folder, not a link out of it.
    const real = await realpath(folder);
    if (!real.startsWith(`${await realpath(projectDir)}${sep}`)) return { problem: "The project's media folder points outside the project, so the track wasn't copied." };
    const stem = track.file.replace(/\.m4a$/, "");
    const exists = (path: string) => stat(path).then(() => true, () => false);
    for (let n = 1; n < 100; n++) {
      const name = n === 1 ? track.file : `${stem}-${n}.m4a`;
      const target = join(real, name);
      if (await exists(target)) {
        if (await same(source, target)) return { track, path: `media/${name}` };
        continue;
      }
      // Written under a name of its own and linked into place, so a half-copied file never has the
      // real name and a file that appeared meanwhile (another app) is never replaced.
      const part = join(real, `.${name}.${randomUUID()}.part`);
      try {
        await copyFile(source, part);
        try {
          await link(part, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (await same(source, target)) return { track, path: `media/${name}` };
          continue;
        }
      } finally {
        await rm(part, { force: true });
      }
      return { track, path: `media/${name}` };
    }
    return { problem: `The project's media folder already holds 99 other files named like ${track.file}.` };
  } catch (error) {
    return { problem: `Couldn't copy ${track.file} into the project: ${(error as Error).message}` };
  }
}
