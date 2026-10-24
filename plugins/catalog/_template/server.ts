#!/usr/bin/env node
// The plugin template: copy it with `pnpm plugin:new <id>`, never edit it in place.
//
// HOW AN UNCUT PLUGIN WORKS (uncut.module/1)
// A plugin is one folder in plugins/catalog/<id with dots as dashes>/ with two kinds of files:
//   uncut.module.json  what the plugin is: id, name, version, what it may touch (capabilities),
//                      the tools the agent sees (agentTools) and what it adds (contributes).
//   *.ts               the program, when it runs one: a stdio MCP server written with
//                      @uncut/plugin-sdk. Uncut starts it with its own Node ("command": "node"),
//                      in this folder, and maps the SDK import for you: no package.json, no
//                      node_modules, no build step.
// The contract lives in packages/plugin-sdk/src/index.ts: its types are the documentation
// (serve, ToolContext, ToolResult, text, ToolError, UncutDeclaration). Read them once.
//
// WHAT A PLUGIN CAN ADD (manifest "contributes", each id is "<plugin id>.<name>")
//   looks       text looks in the Text grid and for the agent's insert_text; a look is copied into
//               the project when it's used, so projects keep working after the plugin is removed.
//   components  HTML + CSS templates with {{param}} placeholders (no script) for the Elements grid.
//   rules       checks in the Checks tab and the agent's project_check: max-words, banned-phrases,
//               min-text-size, end-card, or "process" (Uncut calls this plugin's `check` tool).
// A plugin that only adds these can drop server.ts and agentTools: "runtime": { "type": "data" },
// "kind": "pack" (see plugins/catalog/taste-extra). The canonical plugin that runs a program is
// plugins/argent-capture/server.ts.
//
// RULES FOR A PULL REQUEST (pnpm plugin:check <folder> runs them; test/repo/plugins-folder.test.ts
// runs them for every plugin in the repo)
//   - apiVersion "uncut.module/1"; the folder is named after the id (dots as dashes);
//   - tool names are unique across all plugins (start them with the id: acme_promo_...);
//   - only .json and .ts files, at the folder's top level, at most 40 files and 512 KB;
//   - imports: node: built-ins and @uncut/plugin-sdk only;
//   - ask only for the capabilities you use; the user sees them before allowing the plugin.
// Users enable catalog plugins in Settings, Plugins, Browse; nothing runs until they allow it.
//
// TRY IT
//   pnpm plugin:check plugins/catalog/<folder>
//   In the app: Settings, Plugins, Add plugin, Choose folder (your folder), then Allow.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { serve, text, ToolError, type Json, type ToolContext, type ToolResult } from "@uncut/plugin-sdk";

interface Item {
  readonly id: string;
  readonly text?: string;
}

/** The words of a text item, without Uncut's [[accent]] and **bold** markers. */
const wordsOf = (s: string) =>
  s
    .replace(/\[\[|\]\]|\*\*/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * One tool: Uncut passes the open project's folder in the call (capability "project:read").
 * A tool returns text for the agent (and structuredContent for code). Throw a ToolError to answer
 * with an error the agent reads as is.
 */
async function wordCount(_args: Json, { projectDir }: ToolContext): Promise<ToolResult> {
  if (!projectDir) throw new ToolError("No project is open.");
  const project = JSON.parse(await readFile(join(projectDir, "project.json"), "utf8")) as { tracks?: Array<{ items?: Array<Item> }> };
  const texts = (project.tracks ?? []).flatMap((t) => t.items ?? []).filter((i) => typeof i.text === "string");
  const counts = texts.map((i) => ({ id: i.id, words: wordsOf(i.text!).length }));
  const longest = counts.reduce<(typeof counts)[number] | undefined>((a, c) => (!a || c.words > a.words ? c : a), undefined);
  const result = { texts: counts.length, words: counts.reduce((n, c) => n + c.words, 0), perText: counts, ...(longest ? { longest } : {}) };
  return text(JSON.stringify(result), result);
}

// The tool names here must match the manifest's agentTools (plus any tool Uncut itself calls,
// like `check` for a "process" rule). The SDK answers initialize, tools/list and cancellation.
serve({
  manifest: new URL("./uncut.module.json", import.meta.url),
  tools: {
    example_template_word_count: wordCount,
  },
});
