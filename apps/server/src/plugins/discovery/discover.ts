import { existsSync } from "node:fs";
import { realpath, readdir, stat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { checkPluginIcon, MAX_ICON_BYTES, readContributions } from "@uncut/core";
import { BUILTIN_IDS } from "@uncut/core/skills";
import type { McpTool } from "../../agent/agentTools.ts";
import {
  type PluginSource,
  type Discovery,
  type FoundPlugin,
  type BrokenPlugin,
  messageOf,
  MANIFEST_FILE,
  checkManifest,
  TOOL_NAME,
  str,
  DEFAULT_TIMEOUT_S,
} from "./manifest.ts";

const RESERVED_SKILLS: ReadonlySet<string> = new Set(Object.values(BUILTIN_IDS));

/**
 * Every plugin folder under `roots`, in order: a subfolder with an uncut.module.json. A manifest
 * that isn't JSON, doesn't match the schema, isn't a process plugin, takes a built-in module's id
 * or an id found earlier is skipped and reported (never thrown). A tool whose name Uncut or an
 * earlier plugin already has is left out with a warning; the plugin's other tools stay.
 */
export async function discoverPlugins(
  roots: ReadonlyArray<{ readonly source: PluginSource; readonly dir: string; readonly folders?: ReadonlyArray<string> | undefined }>,
  reserved: { readonly moduleIds: ReadonlySet<string>; readonly toolNames: ReadonlySet<string>; readonly moves?: ReadonlySet<string> },
): Promise<Discovery> {
  const plugins: Array<FoundPlugin> = [];
  const moves = reserved.moves ?? new Set([...reserved.moduleIds].filter((id) => id.startsWith("move.")));
  const broken: Array<BrokenPlugin> = [];
  const seenRoots = new Set<string>();
  const byId = new Map<string, string>();
  const toolOwner = new Map<string, string>();
  for (const root of roots) {
    let rootDir: string;
    try {
      rootDir = await realpath(root.dir);
    } catch {
      continue; // a missing folder means no plugins there
    }
    if (seenRoots.has(rootDir)) continue;
    seenRoots.add(rootDir);
    let names: Array<string>;
    try {
      // D258: a root with its folders listed (bundled.json's split) has exactly those.
      // Hidden folders and "_" ones (the catalog's _template, D104) are never plugins.
      names = root.folders ? [...root.folders] : (await readdir(rootDir)).filter((n) => !n.startsWith(".") && !n.startsWith("_")).sort();
    } catch (error) {
      broken.push({ source: root.source, dir: rootDir, id: undefined, name: undefined, problem: `Uncut can't read this plugin folder (${messageOf(error)}).` });
      continue;
    }
    for (const name of names) {
      let dir: string;
      try {
        dir = await realpath(resolve(rootDir, name));
        if (!(await stat(dir)).isDirectory()) continue;
      } catch {
        continue;
      }
      const file = join(dir, MANIFEST_FILE);
      if (!existsSync(file)) continue;
      const skip = (problem: string, id?: string, title?: string) => broken.push({ source: root.source, dir, id, name: title, problem });
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        skip(`Its ${MANIFEST_FILE} isn't valid JSON (${messageOf(error)}).`);
        continue;
      }
      const checked = checkManifest(raw, reserved.moduleIds, root.source);
      if ("problem" in checked) {
        skip(checked.problem, checked.id, checked.name);
        continue;
      }
      const manifest = checked.manifest;
      const runtime = manifest.runtime as { type: string; command?: string; args?: Array<string>; timeoutSeconds?: number };
      const earlier = byId.get(manifest.id);
      if (earlier) {
        skip(`Another plugin with the id ${manifest.id} comes first (${earlier}), so this one is skipped.`, manifest.id, manifest.name);
        continue;
      }
      byId.set(manifest.id, dir);
      const warnings: Array<string> = [];
      const tools: Array<McpTool> = [];
      const declared = (manifest.agentTools ?? []) as ReadonlyArray<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
      for (const tool of declared) {
        if (!TOOL_NAME.test(tool.name)) {
          warnings.push(`Its tool ${tool.name.slice(0, 80)} is left out: a tool name can have at most 52 letters, digits, _ or -.`);
          continue;
        }
        if (!tool.inputSchema || tool.inputSchema.type !== "object") {
          warnings.push(`Its tool ${tool.name} is left out: its inputSchema must be an object schema ({"type":"object", ...}).`);
          continue;
        }
        const taken = reserved.toolNames.has(tool.name)
          ? "Uncut has a tool with that name"
          : toolOwner.has(tool.name)
            ? `the plugin ${toolOwner.get(tool.name)} has one with that name`
            : undefined;
        if (taken) {
          warnings.push(`Its tool ${tool.name} is left out: ${taken}.`);
          continue;
        }
        toolOwner.set(tool.name, manifest.id);
        tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
      }
      const icon = typeof manifest.icon === "string" ? await readIcon(dir, manifest.icon, warnings) : undefined;
      const runs = runtime.type === "process";
      // Ids are checked per plugin here; across plugins only allowed ones claim ids (mergeContributions).
      // D248: only a plugin that ships with Uncut may have Uncut's own skill names, and its skills say so.
      const bundled = root.source === "bundled";
      const read0 = readContributions(manifest, { reserved: reserved.moduleIds, moves, ...(bundled ? {} : { reservedSkills: RESERVED_SKILLS }) });
      const read =
        bundled && read0.contributions.skills?.length
          ? { ...read0, contributions: { ...read0.contributions, skills: read0.contributions.skills.map((x) => ({ ...x, bundled: true as const })) } }
          : read0;
      warnings.push(...read.warnings);
      const contributes =
        read.contributions.looks.length +
          read.contributions.components.length +
          read.contributions.rules.length +
          read.contributions.filters.length +
          (read.contributions.shaders?.length ?? 0) +
          (read.contributions.skills?.length ?? 0) >
        0;
      // An analyzer is called by Uncut itself (the analysis queue, D100), not by the agent, and so
      // is an importer (D280, Import from link); a generator is used through generate_media; a plugin
      // that contributes looks, components or checks (D103) is used without tools.
      if (!declared.length && !["analyzer", "importer", "generator"].includes(manifest.kind) && !contributes)
        warnings.push("It has no agent tools, so the agent can't use it.");
      plugins.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: str(manifest.description),
        kind: manifest.kind,
        source: root.source,
        dir,
        manifest,
        capabilities: (manifest.capabilities ?? []) as ReadonlyArray<string>,
        tools,
        warnings,
        spec: {
          id: manifest.id,
          name: manifest.name,
          dir,
          command: runs ? runtime.command! : "",
          args: runs ? (runtime.args ?? []) : [],
          timeoutMs: Math.round((runtime.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000),
        },
        runs,
        contributions: read.contributions,
        ...(icon ? { icon } : {}),
      });
    }
  }
  return { plugins, broken };
}

/**
 * D281: a plugin's icon file (the schema allows only a file name at the top of its folder), checked
 * by checkPluginIcon. A missing, linked-out, oversized or refused icon is a warning and the generic
 * icon, never a reason to skip the plugin.
 */
async function readIcon(dir: string, name: string, warnings: Array<string>): Promise<string | undefined> {
  const leftOut = (why: string) => {
    warnings.push(`Its icon ${name} is left out: ${why}.`);
    return undefined;
  };
  try {
    const file = await realpath(join(dir, name));
    if (dirname(file) !== dir) return leftOut("it links outside the plugin's folder");
    const info = await stat(file);
    if (!info.isFile()) return leftOut("it isn't a file");
    if (info.size > MAX_ICON_BYTES) return leftOut(`it's bigger than ${MAX_ICON_BYTES / 1024} KB`);
    const checked = checkPluginIcon(await readFile(file, "utf8"));
    return "dataUrl" in checked ? checked.dataUrl : leftOut(checked.problem);
  } catch {
    return leftOut("Uncut can't read it");
  }
}
