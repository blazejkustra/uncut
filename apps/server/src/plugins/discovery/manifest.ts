import { type ModuleManifest, type Contributions, validateModule } from "@uncut/core";
import { SKILLS_PLUGIN_ID } from "@uncut/core/skills";
import { API_VERSIONS, API_VERSION } from "@uncut/plugin-sdk";
import type { McpTool } from "../../agent/agentTools.ts";

export const MANIFEST_FILE = "uncut.module.json";
export const DEFAULT_TIMEOUT_S = 120;
// Claude's tool names: [A-Za-z0-9_-], at most 64 characters with the "mcp__uncut__" prefix.
export const TOOL_NAME = /^[A-Za-z0-9_-]{1,52}$/;

export type PluginSource = "user" | "bundled";

/** How to start a process plugin. */
export interface ProcessSpec {
  readonly id: string;
  readonly name: string;
  readonly dir: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
}

export interface FoundPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string | undefined;
  readonly kind: string;
  readonly source: PluginSource;
  readonly dir: string;
  readonly manifest: ModuleManifest;
  readonly capabilities: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<McpTool>;
  readonly warnings: ReadonlyArray<string>;
  /** How to start it; command "" for a data plugin (D103), which never runs. */
  readonly spec: ProcessSpec;
  /** Whether it runs a program (runtime "process"); a "data" plugin only contributes (D103). */
  readonly runs: boolean;
  /** Its looks, components and check rules (D103), shown only once it's allowed. */
  readonly contributions: Contributions;
}

export interface BrokenPlugin {
  readonly source: PluginSource;
  readonly dir: string;
  readonly id: string | undefined;
  readonly name: string | undefined;
  readonly problem: string;
}

export interface Discovery {
  readonly plugins: ReadonlyArray<FoundPlugin>;
  readonly broken: ReadonlyArray<BrokenPlugin>;
}

export const str = (x: unknown) => (typeof x === "string" ? x : undefined);
export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A plugin's parsed uncut.module.json, checked as discovery and install check it: a protocol
 * version this Uncut speaks (D102: missing means uncut.module/1; a newer one is refused before the
 * schema, whose fields it may not know), the module schema, a process plugin with a command, and
 * not a built-in module's id. Else one sentence (and the id and name, when it has them).
 */
export function checkManifest(raw: unknown, builtinIds: ReadonlySet<string>, source: PluginSource = "bundled"): { readonly manifest: ModuleManifest } | { readonly problem: string; readonly id: string | undefined; readonly name: string | undefined } {
  const loose = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const fail = (problem: string, manifest?: { id?: unknown; name?: unknown }) => ({ problem, id: str((manifest ?? loose).id), name: str((manifest ?? loose).name) });
  const api = loose.apiVersion;
  if (typeof api === "string" && /^uncut\.module\/[0-9]+$/.test(api) && !API_VERSIONS.includes(api)) {
    return fail(`It's written for the plugin format ${api}, which is newer than this Uncut understands (${API_VERSION}). Update Uncut to use it.`);
  }
  const problems = validateModule(raw);
  if (problems.length) {
    const list = problems.slice(0, 3).map((p) => `${p.path} ${p.message}`).join("; ");
    return fail(`Its ${MANIFEST_FILE} doesn't match the module format: ${list}${problems.length > 3 ? `, and ${problems.length - 3} more` : ""}.`);
  }
  const manifest = raw as ModuleManifest;
  const runtime = manifest.runtime as { type: string; command?: string };
  if (runtime.type === "data") {
    // A data plugin (D103): nothing runs, so it has no tools and needs something to contribute.
    const c = (manifest.contributes ?? {}) as { looks?: Array<unknown>; components?: Array<unknown>; rules?: Array<unknown>; filters?: Array<unknown>; shaders?: Array<unknown>; skills?: Array<unknown> };
    if ((manifest.agentTools as Array<unknown> | undefined)?.length) return fail(`It's a "data" plugin with agent tools; tools need a "process" plugin that runs a program.`);
    if (!c.looks?.length && !c.components?.length && !c.rules?.length && !c.filters?.length && !c.shaders?.length && !c.skills?.length) return fail(`It's a "data" plugin that contributes nothing (no looks, components, rules, filters, shader effects or skills).`);
  } else {
    if (runtime.type !== "process") return fail(`It's a "${runtime.type}" module; only "process" and "data" plugins load from a plugin folder.`);
    if (!runtime.command) return fail(`Its runtime has no command, so Uncut can't start it.`);
  }
  if (builtinIds.has(manifest.id)) return fail(`Its id ${manifest.id} belongs to a built-in module.`);
  // D248: Uncut's own skills plugin can't be replaced or hidden by a plugin from elsewhere.
  if (source !== "bundled" && manifest.id === SKILLS_PLUGIN_ID) return fail(`Its id ${manifest.id} belongs to Uncut's own skills, which can't be replaced.`);
  return { manifest };
}
