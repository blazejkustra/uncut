// Brand kits, skills and the production plan on disk (U7, U15, U16; D186, D188, D189).
//
//   <dataDir>/brand/kits/<id>/kit.json (+ its files)     the user's kits, every project sees them
//   <dataDir>/brand/skills/<id>.json                      the user's skills
//   <project>/brand/kits/<id>/kit.json (+ its files)     this project's kits (win on the same id)
//   <project>/brand/skills/<id>.json                      this project's skills
//   <project>/brand/active.json                           { kit, skills } the project uses (D232: skills it has used)
//   plugins' skills (D232, issue #60)                      read-only, passed in by the caller (BrandDirs.skills)
//   <project>/brief.json, storyboard.json, reviews/review-<n>.json   the plan
//
// Plain async functions over the file system, lenient on read (a field of the wrong type is
// dropped or defaulted, a file that isn't JSON is skipped), strict on write (normalised first).
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { AgentPlan, BrandActive, BrandKit, BrandScope, BrandSkill, BrandState, BrandStyle, Brief, IntendedFinding, Review, Storyboard, StoryboardBeat } from "@uncut/contracts";
import { AGENT_IMAGE_NAME } from "@uncut/contracts";

import type { PluginSkill } from "@uncut/core";
import { isVideoType, skillIdsOf } from "@uncut/core/skills";

import { writeAtomic } from "../project/atomicWrite.ts";

/** Ids of kits and skills: lowercase letters, digits and dashes (also their folder or file name). */
export const BRAND_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A kit's file names: a plain name with an extension. */
export const BRAND_FILE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}\.[A-Za-z0-9]{1,8}$/;
/** The files a kit may hold (logos, fonts, example frames and clips). */
export const BRAND_FILE_TYPES = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ttf", ".otf", ".woff", ".woff2", ".mp4", ".mov", ".webm"]);
/** Font files a kit can hold (D198): graphics, texts and components load them. */
export const FONT_EXT = new Set([".woff2", ".woff", ".ttf", ".otf"]);
/** Logo files: pictures Chromium draws (an SVG stays vector in graphics). */
export const LOGO_EXT = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);
/** The most a kit file may be (bytes). */
export const BRAND_FILE_MAX = 200 * 1024 * 1024;
/** A colour the kit understands: #rgb or #rrggbb (stored lowercase #rrggbb). */
export const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "kit";

export const normHex = (hex: string): string | undefined => {
  if (!HEX.test(hex.trim())) return undefined;
  const h = hex.trim().slice(1).toLowerCase();
  return `#${h.length === 3 ? [...h].map((c) => c + c).join("") : h}`;
};

const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");
const strs = (v: unknown, n = 40, max = 400) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, n).map((x) => x.slice(0, max)) : []);
const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const fileName = (v: unknown) => (typeof v === "string" && BRAND_FILE.test(v) ? v : undefined);

export function normStyle(raw: unknown): BrandStyle | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  const palette = (Array.isArray(s.palette) ? s.palette : [])
    .flatMap((p) => {
      const hex = p && typeof p === "object" ? normHex(str((p as Record<string, unknown>).hex, 16)) : typeof p === "string" ? normHex(p) : undefined;
      if (!hex) return [];
      const role = p && typeof p === "object" ? str((p as Record<string, unknown>).role, 60) : "";
      return [{ hex, ...(role ? { role } : {}) }];
    })
    .slice(0, 16);
  const notes = str(s.notes, 4000);
  const source = str(s.source, 400);
  return { ...(source ? { source } : {}), palette, type: str(s.type), shotLengths: str(s.shotLengths), transitions: str(s.transitions), camera: str(s.camera), grain: str(s.grain), ...(notes ? { notes } : {}) };
}

export function normKit(raw: unknown, scope: BrandScope, id?: string): BrandKit | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const k = raw as Record<string, unknown>;
  const kid = id ?? (typeof k.id === "string" && BRAND_ID.test(k.id) ? k.id : undefined);
  if (!kid) return undefined;
  const logos = (k.logos && typeof k.logos === "object" ? k.logos : {}) as Record<string, unknown>;
  const light = fileName(logos.light);
  const dark = fileName(logos.dark);
  const mark = fileName(logos.mark);
  const colors = (Array.isArray(k.colors) ? k.colors : []).flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const o = c as Record<string, unknown>;
    const hex = normHex(str(o.hex, 16));
    if (!hex) return [];
    const name = str(o.name, 60);
    return [{ hex, role: str(o.role, 60) || "accent", ...(name ? { name } : {}) }];
  }).slice(0, 24);
  const fonts = (Array.isArray(k.fonts) ? k.fonts : []).flatMap((f) => {
    if (!f || typeof f !== "object") return [];
    const o = f as Record<string, unknown>;
    const family = str(o.family, 80).trim();
    if (!family) return [];
    const weight = typeof o.weight === "number" && o.weight >= 100 && o.weight <= 900 ? Math.round(o.weight) : undefined;
    // D198: the family's font file in the kit's folder.
    const file = fileName(o.file);
    return [{ family, role: str(o.role, 40) || "body", ...(weight ? { weight } : {}), ...(file && FONT_EXT.has(extname(file).toLowerCase()) ? { file } : {}) }];
  }).slice(0, 8);
  const style = normStyle(k.style);
  const updatedAt = str(k.updatedAt, 40);
  return {
    id: kid,
    name: str(k.name, 80).trim() || kid,
    scope,
    logos: { ...(light ? { light } : {}), ...(dark ? { dark } : {}), ...(mark ? { mark } : {}) },
    colors,
    fonts,
    ...(str(k.about, 2000).trim() ? { about: str(k.about, 2000).trim() } : {}),
    tone: str(k.tone, 4000),
    taglines: strs(k.taglines, 20, 200),
    urls: strs(k.urls, 20, 300),
    dos: strs(k.dos),
    donts: strs(k.donts),
    examples: strs(k.examples, 24, 300).filter((x) => BRAND_FILE.test(x)),
    ...(style ? { style } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function normSkill(raw: unknown, scope: BrandScope, id?: string): BrandSkill | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const k = raw as Record<string, unknown>;
  const sid = id ?? (typeof k.id === "string" && BRAND_ID.test(k.id) ? k.id : undefined);
  if (!sid) return undefined;
  const updatedAt = str(k.updatedAt, 40);
  return { id: sid, name: str(k.name, 80).trim() || sid, scope, description: str(k.description, 300), body: str(k.body, 20000), ...(updatedAt ? { updatedAt } : {}) };
}

export const globalBrandDir = (dataDir: string) => join(dataDir, "brand");
export const projectBrandDir = (projectDir: string) => join(projectDir, "brand");
const scopeDir = (scope: BrandScope, dirs: BrandDirs) => (scope === "global" ? globalBrandDir(dirs.dataDir) : projectBrandDir(dirs.projectDir ?? ""));

export interface BrandDirs {
  readonly dataDir: string;
  /** The open project's folder; undefined: none open (only the user's kits and skills). */
  readonly projectDir?: string | undefined;
  /** D232: the allowed plugins' skills (Plugins.skillsNow); none when left out. */
  readonly skills?: ReadonlyArray<PluginSkill> | undefined;
}

/** D232: a plugin's skill as the brand state lists it: its name is its id (what /name calls), its title its name. */
// D248: builtin (labelled as Uncut's own) only for a plugin that ships with Uncut, never from the id alone.
export const skillOfPlugin = (x: PluginSkill): BrandSkill => ({ id: x.name, name: x.title, scope: "global", description: x.description, body: x.instructions, plugin: x.plugin, pluginName: x.pluginName, ...(x.bundled ? { builtin: true } : {}) });

const readJson = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
};

const list = async (dir: string) => {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
};

async function kitsIn(base: string, scope: BrandScope) {
  const out: Array<{ kit: BrandKit; files: Record<string, string> }> = [];
  for (const id of await list(join(base, "kits"))) {
    if (!BRAND_ID.test(id)) continue;
    const kit = normKit(await readJson(join(base, "kits", id, "kit.json")), scope, id);
    if (!kit) continue;
    const files: Record<string, string> = {};
    for (const name of await list(join(base, "kits", id))) if (name !== "kit.json" && BRAND_FILE.test(name)) files[name] = join(base, "kits", id, name);
    out.push({ kit, files });
  }
  return out;
}

async function skillsIn(base: string, scope: BrandScope) {
  const out: Array<BrandSkill> = [];
  for (const name of await list(join(base, "skills"))) {
    if (!name.endsWith(".json") || !BRAND_ID.test(name.slice(0, -5))) continue;
    const skill = normSkill(await readJson(join(base, "skills", name)), scope, name.slice(0, -5));
    if (skill) out.push(skill);
  }
  return out;
}

export async function readActive(projectDir: string): Promise<BrandActive> {
  const raw = (await readJson(join(projectBrandDir(projectDir), "active.json"))) as Record<string, unknown> | undefined;
  const kit = raw && typeof raw.kit === "string" && BRAND_ID.test(raw.kit) ? raw.kit : null;
  // D232: Uncut's own skills were builtin-<name> before; they're <name> now.
  return { kit, skills: skillIdsOf(strs(raw?.skills, 20, 64).filter((s) => BRAND_ID.test(s))) };
}

/** D232: marks skills as used by the project (a /name in a message, or skill_read), so the critic follows them. */
export async function useSkills(projectDir: string, ids: ReadonlyArray<string>): Promise<void> {
  if (!ids.length) return;
  const active = await readActive(projectDir);
  const next = [...new Set([...active.skills, ...ids])];
  if (next.length !== active.skills.length) await writeActive(projectDir, { kit: active.kit, skills: next });
}

export async function writeActive(projectDir: string, active: BrandActive): Promise<void> {
  await mkdir(projectBrandDir(projectDir), { recursive: true });
  const kit = active.kit && BRAND_ID.test(active.kit) ? active.kit : null;
  await writeAtomic(join(projectBrandDir(projectDir), "active.json"), `${JSON.stringify({ kit, skills: [...new Set(active.skills.filter((s) => BRAND_ID.test(s)))].slice(0, 20) }, null, 2)}\n`);
}

/**
 * D198: kits live in the user's library. A kit made in a project before (D186 made the agent's new
 * kits there) is copied into the library once, with its files, unless the library has one with that
 * id; the project's copy stays and keeps winning there (a copy pinned to it), so nothing changes
 * for that project while every other project can now pick the kit. Kits pinned to a project since
 * (saved with `pinned: true`) stay pinned; brand/migrated.json lists the ids done, so a library kit
 * the user deletes isn't brought back.
 */
export async function migrateProjectKits(dirs: BrandDirs): Promise<Array<string>> {
  if (!dirs.projectDir) return [];
  const local = await list(join(projectBrandDir(dirs.projectDir), "kits"));
  if (!local.length) return [];
  const marker = join(projectBrandDir(dirs.projectDir), "migrated.json");
  const marked = ((await readJson(marker)) ?? {}) as Record<string, unknown>;
  const done = new Set(strs(marked.kits, 200, 64));
  const before = done.size;
  const copied: Array<string> = [];
  for (const id of local) {
    if (!BRAND_ID.test(id) || done.has(id)) continue;
    const from = join(projectBrandDir(dirs.projectDir), "kits", id);
    const to = join(globalBrandDir(dirs.dataDir), "kits", id);
    const raw = await readJson(join(from, "kit.json"));
    const kit = normKit(raw, "global", id);
    if (!kit || (raw as { pinned?: unknown }).pinned === true) continue;
    done.add(id);
    if (await stat(to).then(() => true, () => false)) continue;
    try {
      await mkdir(to, { recursive: true });
      for (const name of await list(from)) if (name === "kit.json" || BRAND_FILE.test(name)) await copyFile(join(from, name), join(to, name));
      copied.push(id);
    } catch (error) {
      done.delete(id);
      console.error(`[uncut] couldn't copy the kit ${id} into the library: ${(error as Error).message}`);
    }
  }
  if (done.size !== before) {
    try {
      // D248: the file also lists the skill renames done (migrateShadowedSkills): kept.
      await writeAtomic(marker, `${JSON.stringify({ ...marked, kits: [...done].sort() }, null, 2)}\n`);
    } catch {}
  }
  return copied;
}

/** The renames migrateShadowedSkills made in the user's library (old id → new id), for the projects opened later. */
const renamedFile = (dataDir: string) => join(globalBrandDir(dataDir), "renamed-skills.json");
const renamesIn = (raw: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}).filter((e): e is [string, string] => BRAND_ID.test(e[0]) && typeof e[1] === "string" && BRAND_ID.test(e[1])));

/** Renames one skill file to a free id (its json's id too); the new id, or undefined when it couldn't. */
async function renameSkillFile(base: string, id: string, taken: Set<string>): Promise<string | undefined> {
  const stem = id.replace(/-\d+$/, "").slice(0, 60) || "skill";
  let next = `${stem}-2`;
  for (let n = 3; taken.has(next); n++) next = `${stem}-${n}`;
  const from = join(base, "skills", `${id}.json`);
  const raw = await readJson(from);
  if (!raw || typeof raw !== "object") return undefined;
  try {
    await writeAtomic(join(base, "skills", `${next}.json`), `${JSON.stringify({ ...(raw as Record<string, unknown>), id: next }, null, 2)}\n`);
    await rm(from, { force: true });
  } catch (error) {
    console.error(`[uncut] couldn't rename the skill ${id}: ${(error as Error).message}`);
    return undefined;
  }
  taken.add(next);
  return next;
}

/**
 * D248 (review M3 of #60): before D232 Uncut's own skills were builtin-<name>, so the user could
 * have a skill of their own called explainer, talking-head or sound-design, now a plugin's names.
 * Such a file is renamed once to a free id (explainer-2), so it shows and stays editable, and the
 * project's active.json and brief.json, where a plain "explainer" meant the user's (Uncut's was
 * builtin-explainer), are rewritten to it. The library's renames are kept in
 * brand/renamed-skills.json and applied to each project once (brand/migrated.json "skills").
 */
export async function migrateShadowedSkills(dirs: BrandDirs): Promise<void> {
  const names = new Set((dirs.skills ?? []).map((x) => x.name));
  const globalBase = globalBrandDir(dirs.dataDir);
  const projectBase = dirs.projectDir ? projectBrandDir(dirs.projectDir) : undefined;
  const ids = async (base: string | undefined) => (base ? (await list(join(base, "skills"))).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter((id) => BRAND_ID.test(id)) : []);
  const globalIds = await ids(globalBase);
  const projectIds = await ids(projectBase);
  const taken = new Set([...names, ...globalIds, ...projectIds]);
  const library = renamesIn(await readJson(renamedFile(dirs.dataDir)));
  let libraryChanged = false;
  for (const id of globalIds) {
    if (!names.has(id) || id.startsWith("builtin-")) continue;
    const next = await renameSkillFile(globalBase, id, taken);
    if (next) {
      library[id] = next;
      libraryChanged = true;
    }
  }
  if (libraryChanged) {
    try {
      await writeAtomic(renamedFile(dirs.dataDir), `${JSON.stringify(library, null, 2)}\n`);
    } catch {}
  }
  if (!projectBase || !dirs.projectDir) return;
  // This project's own skills win over the library's on the same id (readBrand), so theirs first.
  const local: Record<string, string> = {};
  for (const id of projectIds) {
    if (!names.has(id) || id.startsWith("builtin-")) continue;
    const next = await renameSkillFile(projectBase, id, taken);
    if (next) local[id] = next;
  }
  const marker = join(projectBase, "migrated.json");
  const mark = ((await readJson(marker)) ?? {}) as Record<string, unknown>;
  const done = new Set(strs(mark.skills, 200, 64));
  const renames: Record<string, string> = {};
  for (const [from, to] of Object.entries({ ...library, ...local })) if (!done.has(from) || local[from]) renames[from] = to;
  if (!Object.keys(renames).length) return;
  const rewrite = (list: unknown) => (Array.isArray(list) ? list.map((x) => (typeof x === "string" && Object.hasOwn(renames, x) ? renames[x] : x)) : list);
  const activeFile = join(projectBase, "active.json");
  const active = await readJson(activeFile);
  if (active && typeof active === "object" && Array.isArray((active as { skills?: unknown }).skills)) {
    await writeAtomic(activeFile, `${JSON.stringify({ ...(active as object), skills: rewrite((active as { skills: unknown }).skills) }, null, 2)}\n`).catch(() => {});
  }
  const brief = await readJson(briefFile(dirs.projectDir));
  if (brief && typeof brief === "object" && Array.isArray((brief as { skills?: unknown }).skills)) {
    await writeAtomic(briefFile(dirs.projectDir), `${JSON.stringify({ ...(brief as object), skills: rewrite((brief as { skills: unknown }).skills) }, null, 2)}\n`).catch(() => {});
  }
  try {
    await mkdir(projectBase, { recursive: true });
    await writeAtomic(marker, `${JSON.stringify({ ...mark, skills: [...new Set([...done, ...Object.keys(renames)])].sort() }, null, 2)}\n`);
  } catch {}
}

/** Every kit and skill the project sees (its own win on the same id), its choice, and the kits' files. */
export async function readBrand(dirs: BrandDirs): Promise<BrandState> {
  await migrateProjectKits(dirs).catch(() => []);
  await migrateShadowedSkills(dirs).catch((error) => console.error(`[uncut] couldn't move skills that share a plugin's name: ${(error as Error).message}`));
  const kits = new Map<string, { kit: BrandKit; files: Record<string, string> }>();
  for (const k of await kitsIn(globalBrandDir(dirs.dataDir), "global")) kits.set(k.kit.id, k);
  if (dirs.projectDir) for (const k of await kitsIn(projectBrandDir(dirs.projectDir), "project")) kits.set(k.kit.id, k);
  // D232: the plugins' skills first (read-only; Uncut's own come from the bundled uncut.skills), then
  // the user's own (D186), which never shadow a plugin's: a file with that id is left out.
  const skills = new Map<string, BrandSkill>((dirs.skills ?? []).map((x) => [x.name, skillOfPlugin(x)]));
  const fromPlugin = new Set(skills.keys());
  for (const s of await skillsIn(globalBrandDir(dirs.dataDir), "global")) if (!fromPlugin.has(s.id) && !s.id.startsWith("builtin-")) skills.set(s.id, s);
  if (dirs.projectDir) for (const s of await skillsIn(projectBrandDir(dirs.projectDir), "project")) if (!fromPlugin.has(s.id) && !s.id.startsWith("builtin-")) skills.set(s.id, s);
  const active = dirs.projectDir ? await readActive(dirs.projectDir) : { kit: null, skills: [] };
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return {
    kits: [...kits.values()].map((k) => k.kit).sort(byName),
    skills: [...skills.values()].sort(byName),
    active: { kit: active.kit && kits.has(active.kit) ? active.kit : null, skills: active.skills.filter((s) => skills.has(s)) },
    files: Object.fromEntries([...kits.values()].map((k) => [k.kit.id, k.files])),
  };
}

/** The project's kit (or undefined) and skills, with the kit's files. */
export async function activeBrand(dirs: BrandDirs): Promise<{ kit?: BrandKit; files: Record<string, string>; skills: Array<BrandSkill> }> {
  const state = await readBrand(dirs);
  const kit = state.kits.find((k) => k.id === state.active.kit);
  return { ...(kit ? { kit } : {}), files: kit ? (state.files[kit.id] ?? {}) : {}, skills: state.skills.filter((s) => state.active.skills.includes(s.id)) };
}

export async function saveKit(dirs: BrandDirs, kit: BrandKit): Promise<BrandKit> {
  if (kit.scope === "project" && !dirs.projectDir) throw new Error("Open a project to keep a kit in it.");
  const id = BRAND_ID.test(kit.id) ? kit.id : slug(kit.name);
  const norm = normKit({ ...kit, updatedAt: new Date().toISOString() }, kit.scope, id);
  if (!norm) throw new Error("That kit isn't valid.");
  const dir = join(scopeDir(kit.scope, dirs), "kits", id);
  await mkdir(dir, { recursive: true });
  const { scope: _scope, ...stored } = norm;
  // D198: a kit saved into a project is pinned there on purpose; the library migration leaves it.
  await writeAtomic(join(dir, "kit.json"), `${JSON.stringify(kit.scope === "project" ? { ...stored, pinned: true } : stored, null, 2)}\n`);
  return norm;
}

export async function deleteKit(dirs: BrandDirs, id: string, scope: BrandScope): Promise<void> {
  if (!BRAND_ID.test(id)) throw new Error("No such kit.");
  if (scope === "project" && !dirs.projectDir) throw new Error("Open a project first.");
  await rm(join(scopeDir(scope, dirs), "kits", id), { recursive: true, force: true });
}

export async function saveSkill(dirs: BrandDirs, skill: BrandSkill): Promise<BrandSkill> {
  if (skill.scope === "project" && !dirs.projectDir) throw new Error("Open a project to keep a skill in it.");
  // D207, D232: a plugin's skills are read-only; a duplicate gets an id of its own.
  let id = BRAND_ID.test(skill.id) ? skill.id : slug(skill.name);
  // D248: a new skill named like a plugin's (Explainer) gets a free id of its own (explainer-2).
  if (!BRAND_ID.test(skill.id) && dirs.skills?.some((x) => x.name === id)) {
    const stem = id;
    for (let n = 2; dirs.skills.some((x) => x.name === id) || (await stat(join(scopeDir(skill.scope, dirs), "skills", `${id}.json`)).then(() => true, () => false)); n++) id = `${stem}-${n}`;
  }
  if (skill.builtin || skill.plugin || id.startsWith("builtin-") || dirs.skills?.some((x) => x.name === id)) throw new Error("A plugin's skills can't be changed: duplicate it and edit the copy.");
  const { builtin: _b, plugin: _p, pluginName: _n, ...own } = skill;
  const norm = normSkill({ ...own, updatedAt: new Date().toISOString() }, skill.scope, id);
  if (!norm) throw new Error("That skill isn't valid.");
  const dir = join(scopeDir(skill.scope, dirs), "skills");
  await mkdir(dir, { recursive: true });
  const { scope: _scope, ...stored } = norm;
  await writeAtomic(join(dir, `${id}.json`), `${JSON.stringify(stored, null, 2)}\n`);
  return norm;
}

export async function deleteSkill(dirs: BrandDirs, id: string, scope: BrandScope): Promise<void> {
  if (!BRAND_ID.test(id)) throw new Error("No such skill.");
  if (id.startsWith("builtin-") || dirs.skills?.some((x) => x.name === id)) throw new Error("A plugin's skills can't be deleted here; remove the plugin in Settings, Plugins.");
  if (scope === "project" && !dirs.projectDir) throw new Error("Open a project first.");
  await rm(join(scopeDir(scope, dirs), "skills", `${id}.json`), { force: true });
}

/** Copies a file into a kit's folder (a free name next to what's there); returns the name. */
export async function addKitFile(dirs: BrandDirs, kitId: string, scope: BrandScope, path: string): Promise<string> {
  if (!BRAND_ID.test(kitId)) throw new Error("No such kit.");
  if (scope === "project" && !dirs.projectDir) throw new Error("Open a project first.");
  const ext = extname(path).toLowerCase();
  if (!BRAND_FILE_TYPES.has(ext)) throw new Error(`A kit keeps pictures, fonts and short clips (${[...BRAND_FILE_TYPES].join(", ")}), not ${ext || "files without an extension"}.`);
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`${basename(path)} isn't a file.`);
  if (info.size > BRAND_FILE_MAX) throw new Error(`${basename(path)} is over 200 MB.`);
  const dir = join(scopeDir(scope, dirs), "kits", kitId);
  await mkdir(dir, { recursive: true });
  const stem = basename(path, extname(path)).replace(/[^A-Za-z0-9._ -]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 80) || "file";
  const taken = new Set(await list(dir));
  let name = `${stem}${ext}`;
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}${ext}`;
  await copyFile(path, join(dir, name));
  return name;
}

// ---- the plan ----

export function normBrief(raw: unknown): Brief | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  const notes = str(b.notes, 4000);
  const updatedAt = str(b.updatedAt, 40);
  const by = b.by === "agent" || b.by === "user" ? b.by : undefined;
  // D217: the video type (core VIDEO_TYPES) and the suggested skills.
  const type = isVideoType(b.type) ? b.type : undefined;
  // D232: builtin-<name> ids from before are <name> now.
  const skills = skillIdsOf(strs(b.skills, 12, 80));
  return {
    film: str(b.film, 600),
    audience: str(b.audience, 600),
    duration: str(b.duration, 60),
    formats: strs(b.formats, 8, 80),
    assets: strs(b.assets, 40, 300),
    visual: str(b.visual, 2000),
    hardLines: strs(b.hardLines, 20, 300),
    deliverables: strs(b.deliverables, 12, 200),
    ...(notes ? { notes } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(by ? { by } : {}),
    ...(type ? { type } : {}),
    ...(skills.length ? { skills } : {}),
  };
}

export function normBeats(raw: unknown): Array<StoryboardBeat> {
  return (Array.isArray(raw) ? raw : [])
    .flatMap((x) => {
      if (!x || typeof x !== "object") return [];
      const b = x as Record<string, unknown>;
      const start = Math.max(0, num(b.start));
      const end = Math.max(start, num(b.end, start));
      const sound = str(b.sound, 200);
      const still = typeof b.still === "string" && AGENT_IMAGE_NAME.test(b.still) ? b.still : undefined;
      return [{ start, end, title: str(b.title, 120), entry: str(b.entry, 600), exit: str(b.exit, 600), purpose: str(b.purpose, 400), assets: strs(b.assets, 12, 200), ...(sound ? { sound } : {}), ...(still ? { still } : {}) }];
    })
    .slice(0, 40);
}

export function normStoryboard(raw: unknown): Storyboard | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  const status = s.status === "approved" || s.status === "declined" ? s.status : "proposed";
  const approvedBy = s.approvedBy === "user" || s.approvedBy === "setting" || s.approvedBy === "agent" ? s.approvedBy : undefined;
  const note = str(s.note, 2000);
  const updatedAt = str(s.updatedAt, 40);
  return { summary: str(s.summary, 600), beats: normBeats(s.beats), status, ...(approvedBy ? { approvedBy } : {}), ...(note ? { note } : {}), ...(updatedAt ? { updatedAt } : {}) };
}

export function normReview(raw: unknown): Review | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const sc = (r.scores && typeof r.scores === "object" ? r.scores : {}) as Record<string, unknown>;
  // D217: only the categories that were scored (a rubric's na ones are absent); a review before D217 has all six.
  const scores = Object.fromEntries(["hook", "readability", "motion", "variety", "sound", "brand"].flatMap((k) => (typeof sc[k] === "number" && Number.isFinite(sc[k]) ? [[k, Math.max(0, Math.min(10, sc[k] as number))]] : [])));
  const rubric = r.rubric && typeof r.rubric === "object" ? Object.fromEntries(Object.entries(r.rubric as Record<string, unknown>).flatMap(([k, v]) => (["hook", "readability", "motion", "variety", "sound", "brand"].includes(k) && (v === "required" || v === "optional" || v === "na") ? [[k, v as "required" | "optional" | "na"]] : []))) : undefined;
  const opt = (o: Record<string, unknown>) => ({
    ...(str(o.rule, 60) ? { rule: str(o.rule, 60) } : {}),
    ...(typeof o.to === "number" && Number.isFinite(o.to) ? { to: Math.max(0, o.to) } : {}),
  });
  const det = r.determinism && typeof r.determinism === "object" ? (r.determinism as Record<string, unknown>) : undefined;
  const looked = r.looked && typeof r.looked === "object" ? (r.looked as Record<string, unknown>) : undefined;
  const notes = str(r.notes, 2000);
  const turnId = str(r.turnId, 80);
  return {
    round: Math.max(1, Math.round(num(r.round, 1))),
    scores,
    defects: (Array.isArray(r.defects) ? r.defects : [])
      .flatMap((x) => {
        if (!x || typeof x !== "object") return [];
        const d = x as Record<string, unknown>;
        return [{ at: Math.max(0, num(d.at)), what: str(d.what, 300), ...(str(d.fix, 300) ? { fix: str(d.fix, 300) } : {}), ...(str(d.id, 20) ? { id: str(d.id, 20) } : {}), ...(str(d.kind, 40) ? { kind: str(d.kind, 40) } : {}), ...(d.source === "check" || d.source === "critic" ? { source: d.source } : {}), ...opt(d) }];
      })
      .slice(0, 12),
    ...(notes ? { notes } : {}),
    // D195: rounds before the critic process were the agent's own.
    by: r.by === "critic" ? "critic" : "agent",
    ...(Array.isArray(r.blockers)
      ? {
          blockers: r.blockers
            .flatMap((b) => {
              const o = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
              const what = str(o.what, 300);
              return what ? [{ ...(str(o.id, 20) ? { id: str(o.id, 20) } : {}), kind: str(o.kind, 40) || "other", what, ...(typeof o.at === "number" && Number.isFinite(o.at) ? { at: Math.max(0, o.at) } : {}), source: o.source === "check" ? "check" : "critic", ...opt(o) }] : [];
            })
            .slice(0, 20),
        }
      : {}),
    ...(r.evidence && typeof r.evidence === "object" ? { evidence: Object.fromEntries(Object.entries(r.evidence as Record<string, unknown>).flatMap(([k, v]) => (typeof v === "string" && v.trim() ? [[k.slice(0, 40), v.slice(0, 400)]] : [])).slice(0, 12)) } : {}),
    ...(Array.isArray(r.fixes)
      ? {
          fixes: r.fixes
            .flatMap((f) => {
              const o = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
              const defect = str(o.defect, 20);
              return defect ? [{ defect, what: str(o.what, 300), ...(typeof o.at === "number" && Number.isFinite(o.at) ? { at: Math.max(0, o.at) } : {}), verified: o.verified === true, ...(str(o.note, 300) ? { note: str(o.note, 300) } : {}) }] : [];
            })
            .slice(0, 10),
        }
      : {}),
    ...(str(r.error, 400) ? { error: str(r.error, 400) } : {}),
    ...(rubric && Object.keys(rubric).length ? { rubric } : {}),
    ...(str(r.videoType, 40) ? { videoType: str(r.videoType, 40) } : {}),
    ...(str(r.soundProfile, 20) ? { soundProfile: str(r.soundProfile, 20) } : {}),
    ...(typeof r.intended === "number" && r.intended > 0 ? { intended: Math.round(r.intended) } : {}),
    ...(det ? { determinism: { checked: strs(det.checked, 40, 120), differed: strs(det.differed, 40, 120) } } : {}),
    ...(looked ? { looked: { sheet: looked.sheet === true, phone: looked.phone === true } } : {}),
    passed: r.passed === true,
    ...(typeof r.revision === "number" ? { revision: r.revision } : {}),
    at: str(r.at, 40) || new Date(0).toISOString(),
    ...(turnId ? { turnId } : {}),
  };
}

export const briefFile = (dir: string) => join(dir, "brief.json");
export const storyboardFile = (dir: string) => join(dir, "storyboard.json");
export const reviewsDir = (dir: string) => join(dir, "reviews");
/** D217: the findings the user marked Intended. */
export const intendedFile = (dir: string) => join(dir, "intended.json");

export function normIntended(raw: unknown): Array<IntendedFinding> {
  return (Array.isArray(raw) ? raw : [])
    .flatMap((x) => {
      if (!x || typeof x !== "object") return [];
      const o = x as Record<string, unknown>;
      const kind = str(o.kind, 60);
      if (!kind) return [];
      const from = typeof o.from === "number" && Number.isFinite(o.from) ? Math.max(0, o.from) : undefined;
      const to = typeof o.to === "number" && Number.isFinite(o.to) && from !== undefined ? Math.max(from, o.to) : undefined;
      return [{ kind, what: str(o.what, 300), ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), at: str(o.at, 40) || new Date().toISOString() }];
    })
    .slice(-100);
}

export async function writeIntended(dir: string, list: ReadonlyArray<IntendedFinding>): Promise<Array<IntendedFinding>> {
  const norm = normIntended(list);
  await writeAtomic(intendedFile(dir), `${JSON.stringify(norm, null, 2)}\n`);
  return norm;
}

export async function readPlan(dir: string): Promise<AgentPlan> {
  const brief = normBrief(await readJson(briefFile(dir)));
  const storyboard = normStoryboard(await readJson(storyboardFile(dir)));
  const reviews: Array<Review> = [];
  for (const name of await list(reviewsDir(dir))) {
    if (!/^review-\d+\.json$/.test(name)) continue;
    const r = normReview(await readJson(join(reviewsDir(dir), name)));
    if (r) reviews.push(r);
  }
  reviews.sort((a, b) => a.at.localeCompare(b.at) || a.round - b.round);
  const intended = normIntended(await readJson(intendedFile(dir)));
  return { ...(brief ? { brief } : {}), ...(storyboard ? { storyboard } : {}), reviews, ...(intended.length ? { intended } : {}) };
}

export async function writeBrief(dir: string, brief: Brief): Promise<Brief> {
  const norm = normBrief({ ...brief, updatedAt: new Date().toISOString() })!;
  await writeAtomic(briefFile(dir), `${JSON.stringify(norm, null, 2)}\n`);
  return norm;
}

export async function writeStoryboard(dir: string, storyboard: Storyboard): Promise<Storyboard> {
  const norm = normStoryboard({ ...storyboard, updatedAt: new Date().toISOString() })!;
  await writeAtomic(storyboardFile(dir), `${JSON.stringify(norm, null, 2)}\n`);
  return norm;
}

/** Saves a review as the next review-<n>.json; returns it. */
export async function writeReview(dir: string, review: Review): Promise<Review> {
  await mkdir(reviewsDir(dir), { recursive: true });
  const taken = (await list(reviewsDir(dir))).map((n) => /^review-(\d+)\.json$/.exec(n)?.[1]).filter(Boolean).map(Number);
  const n = (taken.length ? Math.max(...taken) : 0) + 1;
  await writeAtomic(join(reviewsDir(dir), `review-${n}.json`), `${JSON.stringify(review, null, 2)}\n`);
  return review;
}
