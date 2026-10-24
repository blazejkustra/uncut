import { randomUUID } from "node:crypto";
import { constants, rmSync } from "node:fs";
import { writeFile, rename, rm, mkdtemp, readdir, stat, realpath, access, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { cubeText } from "@uncut/core";
import { type ExportPlan, planLuts } from "../exportPlan.ts";

/** Write a file into place without leaving half of it: a sibling temp file, then a rename. */
export async function writeInto(path: string, text: string) {
  const staging = join(dirname(path), `.${basename(path)}.uncut-${randomUUID().slice(0, 8)}`);
  try {
    await writeFile(staging, text);
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}
const TEMP_PREFIX = "uncut-export-";
// Every temp folder made, removed again (synchronously) when the process exits: a quit mid-export
// interrupts the job, whose own cleanup may not finish before bin.ts's 1 s exit timer (#89: seen on
// a slow CI runner). Removing one that's already gone is a no-op.
const made = new Set<string>();
let removeOnExit = false;
/** A temp folder of this server's: the prefix, our pid (so a sweep can tell whose it is), random. */
export const makeTemp = async () => {
  const dir = await mkdtemp(join(tmpdir(), `${TEMP_PREFIX}${process.pid}-`));
  made.add(dir);
  if (!removeOnExit) {
    removeOnExit = true;
    process.once("exit", () => {
      for (const d of made) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {}
      }
    });
  }
  return dir;
};

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Removes export and rasteriser temp folders a server left behind (a crash, a forced quit) from
 * the OS temp dir: those whose owning server (the pid in the name) is gone, and any older than an
 * hour without a pid in the name.
 */
export async function sweepStaleTemp(dir = tmpdir(), now = Date.now()) {
  const names = await readdir(dir).catch(() => [] as Array<string>);
  await Promise.all(
    names.map(async (name) => {
      const m = /^(?:uncut-export-|uncut-render-profile-)(?:(\d+)-)?[A-Za-z0-9]{6}$/.exec(name);
      if (!m) return;
      const pid = m[1] ? Number(m[1]) : undefined;
      if (pid === process.pid) return;
      if (
        pid !== undefined
          ? pidAlive(pid)
          : now -
              (await stat(join(dir, name)).then(
                (s) => s.mtimeMs,
                () => now,
              )) <
            3600_000
      )
        return;
      await rm(join(dir, name), { recursive: true, force: true }).catch(() => {});
    }),
  );
}

/** A file system error as a sentence. */
export function plainFsError(error: unknown, where: string): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  switch (code) {
    case "EACCES":
    case "EPERM":
      return `Uncut isn't allowed to write in ${where}. Choose another folder.`;
    case "EROFS":
      return `${where} is read-only. Choose another folder.`;
    case "ENOSPC":
      return "The disk is full. Free some space or choose another disk, then export again.";
    case "EDQUOT":
      return "You're over your disk quota. Free some space, then export again.";
    case "ENOENT":
      return `${where} isn't there any more. Choose another folder.`;
    case "EXDEV":
      return `The video couldn't be moved to ${where}. Choose another folder.`;
    default:
      return (error as Error)?.message || "The export stopped unexpectedly.";
  }
}

/** A path as the file system knows it (symlinks resolved), the parent's when it doesn't exist yet. */
export const canonical = async (path: string) => {
  try {
    return await realpath(path);
  } catch {
    return join(await realpath(dirname(path)).catch(() => dirname(path)), basename(path));
  }
};

export const exists = (path: string) =>
  access(path, constants.F_OK).then(
    () => true,
    () => false,
  );

/** Move a finished file into place: a rename on the same volume, else copy and delete. */
export async function moveInto(from: string, to: string) {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    const staging = join(dirname(to), `.${basename(to)}.uncut-${randomUUID().slice(0, 8)}`);
    try {
      await copyFile(from, staging);
      await rename(staging, to);
    } finally {
      await rm(staging, { force: true });
      await rm(from, { force: true });
    }
  }
}

/** The colour tables (D136) a plan uses, as .cube files in `dir`, by key. */
export async function writeLuts(plan: Pick<ExportPlan, "visuals">, dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const lut of planLuts(plan)) {
    const file = join(dir, `lut-${lut.key}.cube`);
    await writeFile(file, cubeText(lut));
    out.set(lut.key, file);
  }
  return out;
}

/** Whether `output` is (the same file as) a media file the plan reads. */
export async function replacesMedia(output: string, plan: ExportPlan) {
  const target = await canonical(output);
  for (const f of plan.files) if ((await canonical(f.path)) === target) return true;
  return false;
}

/** The prefix of every export's temp folder in the OS temp dir (the tests look for leftovers). */
export const EXPORT_TEMP_PREFIX = TEMP_PREFIX;
