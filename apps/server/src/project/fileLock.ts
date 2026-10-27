// A lock shared by every server on one data dir (one per window), or on one project:
// `<file>.lock`, created exclusively and holding its owner's pid, process start time and a token
// for this taking. A live owner's lock is never taken: it is stale only when the owner is gone
// (its pid is dead, or after a long hold the pid belongs to a process that started at another
// time). Breaking a stale lock runs one breaker at a time (`<file>.lock.break`) and removes the
// lock only if it is still the one judged stale, so two waiters never both take it. A release
// removes the lock only while it is still its own.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import * as Effect from "effect/Effect";

const POLL_MS = 15;
/** Past this a live pid's start time is checked (a crashed owner whose pid was reused). */
const LONG_HOLD_MS = 10_000;
/** How long acquireFileLock waits for a live owner before it goes ahead without the lock. */
const WAIT_MS = 10_000;
/** An empty or half-written lock (its owner died writing it) is stale after this. */
const UNREADABLE_MS = 1000;
let counter = 0;

const myStart = Math.round(Date.now() - process.uptime() * 1000);
const lockText = () => JSON.stringify({ pid: process.pid, start: myStart, token: randomBytes(8).toString("hex") });
const noLock = async () => {};

interface Held {
  readonly text: string;
  readonly pid: number | undefined;
  readonly start: number | undefined;
  readonly mtimeMs: number;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** When a process started (ps's lstart, to the second); undefined if it can't be told. */
function startOf(pid: number): number | undefined {
  try {
    const started = Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim());
    return Number.isFinite(started) ? started : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readHeld(path: string): Promise<Held | undefined> {
  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {}
    const owner = typeof parsed === "number" ? { pid: parsed } : (parsed as { pid?: unknown; start?: unknown } | undefined);
    const pid = typeof owner?.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0 ? owner.pid : undefined;
    const start = typeof owner?.start === "number" ? owner.start : undefined;
    return { text, pid, start, mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

function isStale(held: Held) {
  if (held.pid === undefined) return Date.now() - held.mtimeMs > UNREADABLE_MS;
  if (!alive(held.pid)) return true;
  if (held.start === undefined || Date.now() - held.mtimeMs < LONG_HOLD_MS) return false;
  const started = startOf(held.pid);
  return started !== undefined && Math.abs(started - held.start) > 2000;
}

async function tryCreate(path: string, text: string) {
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Removes `path` if it still holds `text`; a file that changed meanwhile is put back. */
async function removeIfSame(path: string, text: string) {
  const aside = `${path}.aside-${process.pid}-${++counter}`;
  try {
    await rename(path, aside);
  } catch {
    return;
  }
  const moved = await readFile(aside, "utf8").catch(() => undefined);
  if (moved !== text) await link(aside, path).catch(() => {});
  await rm(aside, { force: true });
}

/** Removes a stale lock, one breaker at a time; the lock is judged again under the breaker's guard. */
async function breakStale(lock: string) {
  const guard = `${lock}.break`;
  const mine = lockText();
  if (!(await tryCreate(guard, mine))) {
    // A breaker that died mid-break leaves its guard.
    const other = await readHeld(guard);
    if (other && isStale(other)) await removeIfSame(guard, other.text);
    return;
  }
  try {
    const held = await readHeld(lock);
    if (held && isStale(held)) await removeIfSame(lock, held.text);
  } finally {
    await removeIfSame(guard, mine);
  }
}

const releaser = (lock: string, text: string) => () => removeIfSame(lock, text).catch(() => {});

/**
 * Takes `<file>.lock`, waiting while another live process holds it. A folder where no lock can be
 * made (read-only, gone), or an owner that never lets go, means going ahead without it: the write
 * that follows fails there and says so, or replaces the file whole (writes are atomic).
 */
export async function acquireFileLock(file: string, waitMs = WAIT_MS): Promise<() => Promise<void>> {
  const lock = `${file}.lock`;
  const text = lockText();
  const end = Date.now() + waitMs;
  try {
    await mkdir(dirname(lock), { recursive: true });
    while (!(await tryCreate(lock, text)) && Date.now() < end) {
      const held = await readHeld(lock);
      if (held && isStale(held)) await breakStale(lock);
      else await sleep(POLL_MS);
    }
    if (Date.now() >= end && (await readFile(lock, "utf8").catch(() => "")) !== text) return noLock;
  } catch {
    return noLock;
  }
  return releaser(lock, text);
}

/**
 * Takes `<file>.lock` only if no live process holds it, however long that one has had it (a
 * download, an open project); undefined when another one does.
 */
export async function tryFileLock(file: string): Promise<(() => Promise<void>) | undefined> {
  const lock = `${file}.lock`;
  const text = lockText();
  await mkdir(dirname(lock), { recursive: true });
  if (await tryCreate(lock, text)) return releaser(lock, text);
  const held = await readHeld(lock);
  if (!held || !isStale(held)) return undefined;
  await breakStale(lock);
  return (await tryCreate(lock, text)) ? releaser(lock, text) : undefined;
}

/** The pid holding `<file>.lock`, if a live one does. */
export async function fileLockHolder(file: string): Promise<number | undefined> {
  const held = await readHeld(`${file}.lock`);
  return held && !isStale(held) ? held.pid : undefined;
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
