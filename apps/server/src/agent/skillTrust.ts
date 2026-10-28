// A project's own Claude Code skills load only after the user said yes to them (security review of
// 9d372be: a downloaded or shared project could bring its own). The answer is kept per project (its
// real path) in Uncut's data folder, keyed by the skills' names and SKILL.md hashes, so a changed or
// added skill asks again. The user's own, synced and enabled-plugin skills never ask.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ClaudeSkill } from "./claudeSkills.ts";

const FILE = "claude-skill-trust.json";

interface Answer {
  readonly key: string;
  readonly load: boolean;
}

/** What a project's skills are trusted by: their names and hashes, in order. */
export const projectSkillsKey = (skills: ReadonlyArray<Pick<ClaudeSkill, "name" | "hash">>): string =>
  createHash("sha256")
    .update(
      skills
        .map((s) => `${s.name}:${s.hash}`)
        .sort()
        .join("\n"),
    )
    .digest("hex")
    .slice(0, 32);

async function readAnswers(dataDir: string): Promise<Record<string, Answer>> {
  try {
    const got = JSON.parse(await readFile(join(dataDir, FILE), "utf8")) as unknown;
    return got && typeof got === "object" && !Array.isArray(got) ? (got as Record<string, Answer>) : {};
  } catch {
    return {};
  }
}

/** The user's answer for this project's skills as they are now ("ask" when never asked, or they changed). */
export async function projectSkillsAnswer(dataDir: string, projectDir: string, key: string): Promise<"load" | "skip" | "ask"> {
  const a = (await readAnswers(dataDir))[projectDir];
  if (!a || a.key !== key) return "ask";
  return a.load ? "load" : "skip";
}

/** Keeps the user's answer for this project's skills (by key). */
export async function answerProjectSkills(dataDir: string, projectDir: string, key: string, load: boolean): Promise<void> {
  const all = await readAnswers(dataDir);
  all[projectDir] = { key, load };
  await mkdir(dataDir, { recursive: true });
  const tmp = join(dataDir, `${FILE}.${process.pid}.tmp`);
  await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, join(dataDir, FILE));
}

/** The project folder as answers are kept: its real path. */
export const realProject = (dir: string) => {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
};

/** A project's skills waiting for the user's yes: the key to answer with, and their names. */
export interface ProjectSkillsAsk {
  readonly key: string;
  readonly names: ReadonlyArray<string>;
}

/** The skills a session may load: the project's only when the user said yes to them as they are now; `ask` while unanswered. */
export async function trustedSkills(
  all: ReadonlyArray<ClaudeSkill>,
  dataDir: string,
  projectDir: string | undefined,
): Promise<{ skills: Array<ClaudeSkill>; ask?: ProjectSkillsAsk }> {
  const own = all.filter((s) => s.plugin === "project");
  const others = all.filter((s) => s.plugin !== "project");
  if (!own.length || !projectDir) return { skills: others };
  const key = projectSkillsKey(own);
  const answer = await projectSkillsAnswer(dataDir, realProject(projectDir), key);
  if (answer === "load") return { skills: [...all] };
  return { skills: others, ...(answer === "ask" ? { ask: { key, names: own.map((s) => s.name) } } : {}) };
}
