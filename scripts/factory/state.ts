import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { FactoryPaths } from "./config.ts";

export function isStopped(paths: FactoryPaths) {
  return existsSync(paths.stop);
}

function nextLocalMidnight(now: Date) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}

export function pauseForTheDay(paths: FactoryPaths, now = new Date()) {
  writeFileSync(paths.pausedUntil, nextLocalMidnight(now).toISOString());
}

export function pausedUntil(paths: FactoryPaths, now = new Date()) {
  if (!existsSync(paths.pausedUntil)) return undefined;
  const until = new Date(readFileSync(paths.pausedUntil, "utf8").trim());
  return until > now ? until : undefined;
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function lockHolder(lockPath: string) {
  if (!existsSync(lockPath)) return undefined;
  const pid = Number(readFileSync(lockPath, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : undefined;
}

function claimLock(lockPath: string) {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export function acquireLock(lockPath: string) {
  mkdirSync(dirname(lockPath), { recursive: true });
  if (claimLock(lockPath)) return true;
  if (lockHolder(lockPath) !== undefined) return false;
  rmSync(lockPath, { force: true });
  return claimLock(lockPath);
}

export function releaseLock(lockPath: string) {
  if (lockHolder(lockPath) === process.pid) rmSync(lockPath, { force: true });
}

export function readJsonl<T>(path: string): Array<T> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function appendJsonl(path: string, entry: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}
