import { open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import * as Effect from "effect/Effect";

let counter = 0;

/** The file a write to `path` should replace: the symlink's target if `path` is one. */
const resolveTarget = async (path: string) => {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw error;
  }
};

/** writeFileAtomic as a plain promise. */
export const writeAtomic = async (path: string, data: string) => {
  const target = await resolveTarget(path);
  const tmp = join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${++counter}`);
  let renamed = false;
  try {
    const file = await open(tmp, "wx");
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, target);
    renamed = true;
    // Make the rename itself durable, not just the bytes.
    const dir = await open(dirname(target), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    if (!renamed) await rm(tmp, { force: true });
  }
};

/**
 * Write to a temp file next to the real target, fsync it, rename it over the target and fsync
 * the folder, so readers never see half a file and a crash never loses an acknowledged write.
 * A symlinked `path` keeps its link: the write goes through to what it points at. Callers
 * that also update memory should run this inside an uninterruptible region.
 */
export const writeFileAtomic = (path: string, data: string): Effect.Effect<void, Error> =>
  Effect.tryPromise({ try: () => writeAtomic(path, data), catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))) });
