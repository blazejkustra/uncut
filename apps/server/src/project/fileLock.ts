// A lock shared by every server on one data dir (one per window): `<file>.lock`, created
// exclusively and holding the owner's pid. It is stale when that pid is gone, or when it has been
// held far longer than any read-modify-write takes (a reused pid, a frozen holder); a stale lock is
// moved aside and the create tried again, so only one waiter ever takes it.
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import * as Effect from "effect/Effect";

const POLL_MS = 15;
const STALE_MS = 10_000;
let counter = 0;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function isStale(lock: string, maxAgeMs = STALE_MS) {
  try {
    const [text, info] = await Promise.all([readFile(lock, "utf8"), stat(lock)]);
    const pid = Number(text.trim());
    if (Date.now() - info.mtimeMs > maxAgeMs) return true;
    return Number.isInteger(pid) && pid > 0 ? !alive(pid) : Date.now() - info.mtimeMs > 1000;
  } catch {
    return false;
  }
}

async function tryCreate(lock: string) {
  try {
    const handle = await open(lock, "wx", 0o600);
    try {
      await handle.writeFile(String(process.pid));
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function moveAside(lock: string) {
  const aside = `${lock}.stale-${process.pid}-${++counter}`;
  try {
    await rename(lock, aside);
    await rm(aside, { force: true });
  } catch {}
}

/**
 * Takes `<file>.lock`, waiting while another live process holds it. A folder where no lock can be
 * made (read-only, gone) gets none: the write that follows fails there and says so.
 */
export async function acquireFileLock(file: string): Promise<() => Promise<void>> {
  const lock = `${file}.lock`;
  try {
    await mkdir(dirname(lock), { recursive: true });
    while (!(await tryCreate(lock))) {
      if (await isStale(lock)) await moveAside(lock);
      else await sleep(POLL_MS);
    }
  } catch {
    return async () => {};
  }
  return () => rm(lock, { force: true }).catch(() => {});
}

/**
 * Takes `<file>.lock` only if no live process holds it, however long that one has had it (a
 * download); undefined when another one does.
 */
export async function tryFileLock(file: string): Promise<(() => Promise<void>) | undefined> {
  const lock = `${file}.lock`;
  await mkdir(dirname(lock), { recursive: true });
  if (await tryCreate(lock)) return () => rm(lock, { force: true }).catch(() => {});
  if (!(await isStale(lock, Infinity))) return undefined;
  await moveAside(lock);
  return (await tryCreate(lock)) ? () => rm(lock, { force: true }).catch(() => {}) : undefined;
}

/** Runs `fn` holding `<file>.lock`. */
export async function withFileLockAsync<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireFileLock(file);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/** Runs `effect` holding `<file>.lock` (released however it ends). */
export const withFileLock = <A, E, R>(file: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.promise(() => acquireFileLock(file)),
    () => effect,
    (release) => Effect.promise(release),
  );
