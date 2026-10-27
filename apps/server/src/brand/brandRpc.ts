// The brand RPCs (D186): thin wrappers over store.ts with the user's data folder and the open
// project's folder (project kits and skills, and the project's choice, need an open project).
import { BrandError, type BrandActive, type BrandKit, type BrandScope, type BrandSkill, type BrandState, type ClaudeCodeSkill } from "@uncut/contracts";
import type { PluginSkill } from "@uncut/core";
import * as Effect from "effect/Effect";

import { expandHome } from "../paths.ts";
import type { ProjectView } from "../project/projects.ts";
import { importIntoKit } from "./importer.ts";
import { addKitFile, deleteKit, deleteSkill, readBrand, saveKit, saveSkill, writeActive, type BrandDirs } from "./store.ts";

const failed = (error: unknown) => new BrandError({ reason: "failed", message: error instanceof Error ? error.message : String(error) });

/** The user's Claude Code skills for a project folder, as the composer's / menu shows them, and the project's own waiting for a yes. */
export type ClaudeSkillsOf = (
  projectDir: string | undefined,
) => Promise<{ readonly skills: ReadonlyArray<ClaudeCodeSkill>; readonly ask?: { readonly key: string; readonly names: ReadonlyArray<string> } }>;
/** Keeps the user's answer to a project's own skills. */
export type AnswerProjectSkills = (projectDir: string, key: string, load: boolean) => Promise<void>;

export function brandRpc(
  dataDir: string,
  view: Effect.Effect<ProjectView | undefined>,
  skills: () => ReadonlyArray<PluginSkill> = () => [],
  claudeSkills: ClaudeSkillsOf = async () => ({ skills: [] }),
  answerSkills: AnswerProjectSkills = async () => {},
) {
  // D232: the allowed plugins' skills come along (the Skills tab lists them).
  const dirs = Effect.map(view, (v): BrandDirs => ({ dataDir, projectDir: v?.dir, skills: skills() }));
  const run = <A>(f: (d: BrandDirs) => Promise<A>) => Effect.flatMap(dirs, (d) => Effect.tryPromise({ try: () => f(d), catch: failed }));
  const ownSkills = (d: BrandDirs): ReturnType<ClaudeSkillsOf> => claudeSkills(d.projectDir).catch(() => ({ skills: [] }));
  const state = async (d: BrandDirs): Promise<BrandState> => {
    const [brand, claude] = await Promise.all([readBrand(d), ownSkills(d)]);
    return {
      ...brand,
      claudeSkills: claude.skills.map(({ id, plugin, name, description }) => ({ id, plugin, name, description })),
      ...(claude.ask ? { projectSkillsAsk: { key: claude.ask.key, names: [...claude.ask.names] } } : {}),
    };
  };
  return {
    get: run(state),
    saveKit: (kit: BrandKit) => run(async (d): Promise<BrandState> => (await saveKit(d, kit), state(d))),
    deleteKit: (id: string, scope: BrandScope) => run(async (d) => (await deleteKit(d, id, scope), state(d))),
    saveSkill: (skill: BrandSkill) => run(async (d) => (await saveSkill(d, skill), state(d))),
    deleteSkill: (id: string, scope: BrandScope) => run(async (d) => (await deleteSkill(d, id, scope), state(d))),
    setActive: (active: BrandActive) =>
      Effect.flatMap(dirs, (d) =>
        d.projectDir
          ? Effect.tryPromise({ try: async () => (await writeActive(d.projectDir!, active), state(d)), catch: failed })
          : Effect.fail(new BrandError({ reason: "no-project", message: "Open a project to choose its kit." })),
      ),
    // Only for the skills as they are now: a key that no longer matches asks again.
    trustProjectSkills: (key: string, load: boolean) =>
      run(async (d) => {
        if (!d.projectDir) throw new Error("Open a project first.");
        if ((await claudeSkills(d.projectDir)).ask?.key !== key) throw new Error("This project's skills changed: look at them again.");
        await answerSkills(d.projectDir, key, load);
        return state(d);
      }),
    addFile: (kit: string, scope: BrandScope, path: string) =>
      run(async (d) => ({ name: await addKitFile(d, kit, scope, expandHome(path)), state: await state(d) })),
    // D198: logos and fonts from a file, a folder or an https address.
    importFiles: (kit: string, scope: BrandScope, source: string) =>
      run(async (d) => {
        const got = await importIntoKit(d, kit, scope, source);
        if ("problem" in got) throw new Error(got.problem);
        return { files: [...got.files], state: await state(d) };
      }),
  };
}
