// A new format of a film: the project's folder copied next to it. Its conversation stays behind
// with history.db and agent/, so the copy's agent starts a new chat, and the brief, storyboard,
// reviews and brand come along as files.
import { constants } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import { MAX_NAME_LENGTH } from "./helpers.ts";
import { MATCH_FIRST_CLIP } from "./service.ts";

const LEFT_BEHIND = new Set([
  "project.json",
  "history.db",
  "history.db-wal",
  "history.db-shm",
  "agent",
  join(".cache", "open.lock"),
  join(".cache", "trash"),
  join(".cache", "work"),
  join(".cache", MATCH_FIRST_CLIP),
]);
const NAME_TRIES = 100;

/** Makes `<name>.uncut` beside the project, or `<name> 2.uncut` and so on when that exists. */
async function reserveFolder(parent: string, name: string) {
  for (let n = 1; n <= NAME_TRIES; n++) {
    const taken = n === 1 ? name : `${name} ${n}`;
    const dir = join(parent, `${taken}.uncut`);
    const made = await mkdir(dir).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return false;
        throw error;
      },
    );
    if (made) return { dir, name: taken };
  }
  throw new Error(`There are already ${NAME_TRIES} copies of ${name} in ${parent}`);
}

/** The new folder's place and name, for a format label like "9:16". */
export function reserveCopy(from: string, format: string) {
  const suffix = ` ${format.replace(/[^0-9a-zA-Z]+/g, "x")}`;
  const base = basename(from, ".uncut")
    .slice(0, MAX_NAME_LENGTH - suffix.length - ` ${NAME_TRIES}`.length)
    .trimEnd();
  return reserveFolder(dirname(from), `${base}${suffix}`);
}

/** Clones where the disk can (APFS: no extra space, even with big footage), else copies. */
export const copyFolder = (from: string, to: string) =>
  cp(from, to, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    filter: (source) => !LEFT_BEHIND.has(relative(from, source)),
  });

/** project.json for the copy: media kept by absolute path inside the original now points into the copy. */
export function movedProjectText(text: string, from: string, to: string) {
  const escaped = (dir: string) => JSON.stringify(`${dir}/`).slice(1, -1);
  return text.replaceAll(escaped(from), escaped(to));
}

/** What the copy's first message tells the agent. */
export const copyNote = (fromName: string, format: string, width: number, height: number) =>
  `This project is a copy of "${fromName}", made for a ${format} version (${width}×${height}), and this is a new chat. The timeline came over from the original; the brief, storyboard and reviews here were written for the original's format.`;
