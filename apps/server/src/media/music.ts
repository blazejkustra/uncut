// Sounds going into a project: a bundled sound effect or a file of the user's folders is copied into
// the project's media/ folder (D12: a project that points into the app bundle breaks once it's moved
// to another Mac or the app is updated), under its own file name, or a numbered one when a different
// file already has that name. An identical copy already there is reused. (The bundled music of D91
// went the same way until D274 removed it.)
import { randomUUID } from "node:crypto";
import { copyFile, link, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";

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

/** A bundled sound effect (D134) copied into the project's media/ the same way; its path relative to the project. */
export function copyBundledFile(dir: string, projectDir: string, file: string): Promise<{ readonly path: string } | { readonly problem: string }> {
  return serialised(projectDir, () => copyOnce(join(dir, file), projectDir, file));
}

/**
 * A file of the user's own sound folders (D208) copied into the project's media/ the same way, under
 * `name` (its extension kept; a numbered name when a different file has it); its path relative to the project.
 */
export function copyIntoProject(source: string, projectDir: string, name: string): Promise<{ readonly path: string } | { readonly problem: string }> {
  return serialised(projectDir, () => copyOnce(source, projectDir, name, false));
}

/** Runs `run` after any other copy or download into the same project folder (shared with the online library's downloads). */
export const serialisedFor = serialised;

async function copyOnce(source: string, projectDir: string, file: string, bundled = true): Promise<{ readonly path: string } | { readonly problem: string }> {
  const track = { file };
  try {
    await stat(source);
  } catch {
    return { problem: bundled ? `The bundled file ${track.file} is missing from this copy of Uncut.` : `${source} is missing.` };
  }
  try {
    const folder = join(projectDir, "media");
    await mkdir(folder, { recursive: true });
    // media/ must be the project's own folder, not a link out of it.
    const real = await realpath(folder);
    if (!real.startsWith(`${await realpath(projectDir)}${sep}`)) return { problem: "The project's media folder points outside the project, so the track wasn't copied." };
    const ext = extname(track.file);
    const stem = ext ? track.file.slice(0, -ext.length) : track.file;
    const exists = (path: string) => stat(path).then(() => true, () => false);
    for (let n = 1; n < 100; n++) {
      const name = n === 1 ? track.file : `${stem}-${n}${ext}`;
      const target = join(real, name);
      if (await exists(target)) {
        if (await same(source, target)) return { path: `media/${name}` };
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
          if (await same(source, target)) return { path: `media/${name}` };
          continue;
        }
      } finally {
        await rm(part, { force: true });
      }
      return { path: `media/${name}` };
    }
    return { problem: `The project's media folder already holds 99 other files named like ${track.file}.` };
  } catch (error) {
    return { problem: `Couldn't copy ${track.file} into the project: ${(error as Error).message}` };
  }
}
