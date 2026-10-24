import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { McpResult } from "../../agent/agent.ts";
import type { FoundPlugin } from "../discovery/manifest.ts";

// Images passed on to the agent (D97): these types, at most this many bytes decoded.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** An MCP tools/call result as Uncut passes it on: text and images; anything else as JSON text. */
export function toMcpResult(raw: unknown): McpResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as { content?: unknown; structuredContent?: unknown; isError?: unknown };
  const content: Array<McpResult["content"][number]> = [];
  for (const c of Array.isArray(r.content) ? (r.content as Array<Record<string, unknown>>) : []) {
    if (c?.type === "text" && typeof c.text === "string") content.push({ type: "text", text: c.text });
    else if (c?.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string") {
      const bytes = Math.floor((c.data.length * 3) / 4);
      if (!IMAGE_TYPES.has(c.mimeType)) content.push({ type: "text", text: `(The plugin sent an image of type ${c.mimeType.slice(0, 60)}; only PNG, JPEG, GIF and WebP are passed on, so it was left out.)` });
      else if (bytes > MAX_IMAGE_BYTES) content.push({ type: "text", text: `(The plugin sent a ${Math.round(bytes / 1024 / 1024)} MB image; images over ${MAX_IMAGE_BYTES / 1024 / 1024} MB are left out.)` });
      else content.push({ type: "image", data: c.data, mimeType: c.mimeType });
    }
    else content.push({ type: "text", text: JSON.stringify(c) });
  }
  if (!content.length && r.structuredContent !== undefined) content.push({ type: "text", text: JSON.stringify(r.structuredContent) });
  if (!content.length) content.push({ type: "text", text: Array.isArray(r.content) ? "(The plugin returned nothing.)" : JSON.stringify(raw ?? null) });
  return { content, ...(r.isError === true ? { isError: true } : {}) };
}

export const errorResult = (text: string): McpResult => ({ content: [{ type: "text", text }], isError: true });

/**
 * A tool result as the host returns it: what the agent sees, plus what the plugin declared for
 * Uncut itself (D98): `structuredContent.uncut`, e.g. a recording to import ({ media }) or a file
 * to swap in ({ replace }). Uncut acts on it only for a plugin allowed to add media.
 */
export type PluginResult = McpResult & { readonly declared?: Record<string, unknown>; readonly structured?: unknown };

/** What Uncut tells a plugin about the call (D98), as MCP `_meta` on tools/call. */
export interface PluginContext {
  /** The open project's folder (plugins that read the project). */
  readonly "uncut/projectDir"?: string;
  /** Where a plugin that adds media writes its files: <project>/media/captures (D12). */
  readonly "uncut/captureDir"?: string;
  /** The project's saved flows (capture sources): <project>/flows. */
  readonly "uncut/flowsDir"?: string;
  /** A generator's call (#107): the grant its uncut/fetch requests name. */
  readonly "uncut/grant"?: string;
}

export const CAPTURE_DIR = join("media", "captures");
export const FLOWS_DIR = "flows";

/** The context a plugin gets for a project, by what it may do; the capture folder is created. */
export async function pluginContext(plugin: Pick<FoundPlugin, "capabilities" | "kind">, projectDir: string | undefined): Promise<PluginContext> {
  if (!projectDir) return {};
  const reads = plugin.capabilities.includes("project:read");
  const writes = plugin.capabilities.includes("media:write");
  const context: Record<string, string> = {};
  if (reads) context["uncut/projectDir"] = projectDir;
  if (writes) {
    const dir = join(projectDir, CAPTURE_DIR);
    await mkdir(dir, { recursive: true });
    context["uncut/captureDir"] = dir;
  }
  if (plugin.kind === "capture-source" && (reads || writes)) context["uncut/flowsDir"] = join(projectDir, FLOWS_DIR);
  return context;
}

/** The plugin's declaration for Uncut in a raw tools/call result, if any. */
export const declaredOf = (raw: unknown): Record<string, unknown> | undefined => {
  const structured = (raw as { structuredContent?: unknown } | null)?.structuredContent;
  const uncut = structured && typeof structured === "object" ? (structured as { uncut?: unknown }).uncut : undefined;
  return uncut && typeof uncut === "object" && !Array.isArray(uncut) ? (uncut as Record<string, unknown>) : undefined;
};
