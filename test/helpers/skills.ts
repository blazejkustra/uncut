// D232 (issue #60): Uncut's own skills as the server gets them, from the bundled plugin
// plugins/uncut-skills (its manifest read like discovery reads it).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readContributions, type ModuleManifest, type PluginSkill } from "../../packages/core/src/index.ts";

export const SKILLS_MANIFEST = resolve("plugins/uncut-skills/uncut.module.json");

export function bundledSkills(): ReadonlyArray<PluginSkill> {
  const manifest = JSON.parse(readFileSync(SKILLS_MANIFEST, "utf8")) as ModuleManifest;
  return readContributions(manifest, { reserved: new Set(), moves: new Set() }).contributions.skills ?? [];
}

export const bundledSkill = (name: string) => bundledSkills().find((x) => x.name === name)!;
