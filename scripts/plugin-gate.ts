// The checks a plugin in this repo must pass (D103, D104), in one place: test/repo/plugins-folder.test.ts
// runs them on every plugin under plugins/ and plugins/catalog, `pnpm plugin:check` on one folder
// before a pull request. Each problem is one sentence; none means the folder is fine.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { API_VERSION } from "../packages/plugin-sdk/src/index.ts";
import { loadModules, readContributions, type ModuleManifest } from "../packages/core/src/index.ts";
import { checkManifest, MANIFEST_FILE } from "../apps/server/src/plugins/plugins.ts";
import { shaderEntries } from "./plugin-shaders.ts";

export const REPO = fileURLToPath(new URL("..", import.meta.url));
export const MAX_FILES = 40;
export const MAX_BYTES = 512 * 1024;
/** The catalog's template (D104): checked like a plugin, but it's copied, never loaded or shipped. */
export const TEMPLATE_DIR = join(REPO, "plugins/catalog/_template");
export const TEMPLATE_ID = "example.template";
/** The shader effect template (D213): `pnpm plugin:new <id> --shader` copies it. */
export const SHADER_TEMPLATE_DIR = join(REPO, "plugins/catalog/_shader-template");
export const SHADER_TEMPLATE_ID = "example.shader";

/** Plugin folders under a plugins root: the bundled ones at the top, the catalog's under catalog/ (no hidden or "_" folders). */
export function pluginDirs(root = join(REPO, "plugins")) {
  const dirsIn = (dir: string) =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name !== "catalog" && !d.name.startsWith(".") && !d.name.startsWith("_"))
          .map((d) => join(dir, d.name))
          .sort()
      : [];
  return { bundled: dirsIn(root), catalog: dirsIn(join(root, "catalog")) };
}

/** Every file under dir (lstat: a symlink is reported, never followed). */
function walk(dir: string, out: Array<{ path: string; kind: string; bytes: number }> = []) {
  for (const name of readdirSync(dir)) {
    if (name === ".DS_Store") continue; // Finder's, gitignored: never in a PR
    const path = join(dir, name);
    const st = lstatSync(path);
    if (st.isDirectory()) walk(path, out);
    else out.push({ path, kind: st.isSymbolicLink() ? "symlink" : st.isFile() ? "file" : "other", bytes: st.size });
  }
  return out;
}

// What a plugin's code may import: Node's built-ins, the SDK, and its own files next to it; a
// shader effect's source (D213) TypeGPU and its own files only.
const IMPORT = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|(?:^|[\s;(])import\s*\(?\s*["']([^"']+)["']/gm;
const allowedImport = (spec: string) => spec.startsWith("node:") || spec === "@uncut/plugin-sdk" || /^\.\/[^/]+\.(ts|json)$/.test(spec);
const allowedShaderImport = (spec: string) => /^typegpu(\/(data|std))?$/.test(spec) || /^\.\/[^/]+\.ts$/.test(spec);

export interface GateContext {
  readonly builtinIds: ReadonlySet<string>;
  readonly moves: ReadonlySet<string>;
  /** Contribution ids taken by the plugins checked before (shared, filled in). */
  readonly taken: Set<string>;
  /** Plugin ids → folder, of the plugins checked before (shared, filled in). */
  readonly ids: Map<string, string>;
  /** Tool names → plugin id, of the plugins checked before (shared, filled in). */
  readonly tools: Map<string, string>;
}

export async function gateContext(): Promise<GateContext> {
  const modules = await loadModules(join(REPO, "spec/modules/builtin"));
  return {
    builtinIds: new Set(modules.keys()),
    moves: new Set([...modules.values()].filter((m) => m.kind === "move").map((m) => m.id)),
    taken: new Set(),
    ids: new Map(),
    tools: new Map(),
  };
}

/**
 * The problems of one plugin folder. `template`: the catalog's template, whose folder isn't named
 * after its id (it's `_template`, so nothing loads it).
 */
export function checkPluginFolder(dir: string, ctx: GateContext, { template = false, templateId = TEMPLATE_ID } = {}): Array<string> {
  const problems: Array<string> = [];
  const where = relative(REPO, dir) || dir;
  const say = (problem: string) => problems.push(`${where}: ${problem}`);
  if (!existsSync(join(dir, MANIFEST_FILE))) return [`${where}: there's no ${MANIFEST_FILE}.`];

  const files = walk(dir);
  // The .ts files its shader effects name (D213): TypeGPU sources, checked as such.
  let shaderSources = new Set<string>();
  try {
    shaderSources = new Set(shaderEntries(JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"))).map((e) => e.source));
  } catch {
    // reported below
  }
  for (const f of files) {
    const rel = f.path.slice(dir.length + 1);
    if (f.kind !== "file") say(`${rel}: only regular files (no symlinks, pipes or devices).`);
    if (rel.split("/").some((part) => part.startsWith("."))) say(`${rel}: no hidden files.`);
    if (!/\.(json|ts)$/.test(rel)) say(`${rel}: only .json and .ts files.`);
    if (rel.includes("/")) say(`${rel}: files sit at the plugin's top level (the app ships */*.ts only).`);
    if (rel.includes("node_modules")) say(`${rel}: no node_modules (plugins import only the SDK).`);
    if (f.kind === "file" && rel.endsWith(".ts") && !rel.includes("/")) {
      const source = readFileSync(f.path, "utf8");
      for (const m of source.matchAll(IMPORT)) {
        const spec = m[1] ?? m[2]!;
        if (shaderSources.has(rel)) {
          if (!allowedShaderImport(spec)) say(`${rel} imports ${spec}: a shader effect's source imports only typegpu, typegpu/data, typegpu/std and its own files (./x.ts).`);
        } else if (!allowedImport(spec)) say(`${rel} imports ${spec}: a plugin imports only node: built-ins, @uncut/plugin-sdk and its own files (./x.ts).`);
      }
    }
  }
  if (files.length > MAX_FILES) say(`at most ${MAX_FILES} files (it has ${files.length}).`);
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  if (bytes > MAX_BYTES) say(`at most ${MAX_BYTES / 1024} KB (it has ${Math.ceil(bytes / 1024)} KB).`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
  } catch (error) {
    say(`${MANIFEST_FILE} isn't valid JSON (${(error as Error).message}).`);
    return problems;
  }
  const checked = checkManifest(raw, ctx.builtinIds);
  if ("problem" in checked) {
    say(checked.problem);
    return problems;
  }
  const manifest = raw as ModuleManifest;
  if (manifest.apiVersion !== API_VERSION) say(`declare "apiVersion": "${API_VERSION}".`);
  const folder = basename(dir);
  if (template) {
    if (manifest.id !== templateId) say(`the template's id stays ${templateId} (pnpm plugin:new replaces it).`);
  } else if (folder !== manifest.id.replaceAll(".", "-")) say(`the folder is named after the id: ${manifest.id.replaceAll(".", "-")}, not ${folder}.`);
  const earlier = ctx.ids.get(manifest.id);
  if (earlier) say(`the id ${manifest.id} is taken (${relative(REPO, earlier) || earlier}).`);
  ctx.ids.set(manifest.id, dir);
  if (manifest.builtin !== undefined) say(`plugins aren't built-in modules: remove "builtin".`);

  const { warnings } = readContributions(manifest, { reserved: ctx.builtinIds, moves: ctx.moves, taken: ctx.taken });
  for (const w of warnings) say(w);

  for (const tool of (manifest.agentTools as Array<{ name: string }> | undefined) ?? []) {
    const owner = ctx.tools.get(tool.name);
    if (owner && owner !== manifest.id) say(`the tool name ${tool.name} is taken by ${owner}: tool names are unique across plugins.`);
    ctx.tools.set(tool.name, manifest.id);
  }

  const runtime = manifest.runtime as { type: string; command?: string; args?: Array<string> };
  if (runtime.type === "data") {
    // Its manifest, plus the TypeGPU sources its shader effects name (D213): resolved by
    // plugin:check, never run by Uncut (the manifest carries their WGSL).
    const names = files.map((f) => f.path.slice(dir.length + 1));
    if (!names.includes(MANIFEST_FILE) || names.some((n) => n !== MANIFEST_FILE && !shaderSources.has(n))) say(`a data plugin is its ${MANIFEST_FILE} alone, no code (and the .ts sources of its shader effects).`);
    for (const source of shaderSources) if (!names.includes(source)) say(`its shader effects' source ${source} isn't in the folder.`);
  } else if (runtime.command === "node") {
    const entry = (runtime.args ?? []).find((a) => a.endsWith(".ts"));
    if (!entry || !existsSync(join(dir, entry))) say(`its node entry (a .ts file in runtime.args) is in the folder.`);
  }
  return problems;
}
