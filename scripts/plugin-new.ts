// pnpm plugin:new <id> [--name "Shown name"] [--shader]: starts a plugin for Uncut's catalog (D104).
// Copies plugins/catalog/_template (or, with --shader, plugins/catalog/_shader-template, D213) to plugins/catalog/<id with dots as dashes>, puts in the id, the name
// and the tool prefix, and prints what to do next. --help says it all.
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { checkPluginFolder, gateContext, pluginDirs, REPO, SHADER_TEMPLATE_DIR, SHADER_TEMPLATE_ID, TEMPLATE_DIR, TEMPLATE_ID } from "./plugin-gate.ts";
import { checkPluginShaders } from "./plugin-shaders.ts";

const HELP = `pnpm plugin:new <id> [--name "Shown name"] [--shader]

Starts a plugin in plugins/catalog/<id with dots as dashes>/ from the template
(plugins/catalog/_template): a manifest (uncut.module.json, apiVersion uncut.module/1)
and server.ts, a stdio MCP server written with @uncut/plugin-sdk, with one tool for the
agent and one text look.

With --shader, a shader effect plugin instead (plugins/catalog/_shader-template): a
manifest with one effect in contributes.shaders and effect.ts, the effect written with
TypeGPU (a typed WebGPU shader in TypeScript). It runs no program: Uncut draws the WGSL
pnpm plugin:check --write resolves from effect.ts. effect.ts's header says how it works.

  <id>         who you are, a dot, what it is: lowercase letters, digits and dashes,
               e.g. acme.promo-kit. It's the folder's name (dots as dashes), the start of
               every contribution id (acme.promo-kit.headline) and of the tool names
               (acme_promo_kit_word_count).
  --name       the name users see (default: from the id, "Acme promo kit").
  --plugins    the plugins folder to write into (default: this repo's plugins/).
  --shader     a shader effect plugin (see above).

Next steps:
  1. Edit uncut.module.json: description, author, capabilities (only what you use), the
     agentTools (each tool's name, description, inputSchema) and contributes (looks,
     components, rules). The types in packages/plugin-sdk/src/index.ts are the contract.
  2. Edit server.ts: one handler per tool, by the same names. A plugin that only adds
     looks, components or rules needs no code: delete server.ts and agentTools, set
     "runtime": { "type": "data" } (see plugins/catalog/taste-extra).
  3. pnpm plugin:check plugins/catalog/<folder>   (the checks a pull request must pass)
  4. Try it in Uncut: Settings, Plugins, Add plugin, Choose folder, then Allow.
  5. Open a pull request that adds only your folder.`;

export function pluginNew(argv: ReadonlyArray<string>): { dir: string; id: string; name: string; shader: boolean } {
  const args = [...argv];
  const take = (flag: string) => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
    args.splice(i, 2);
    return value;
  };
  const shader = args.includes("--shader");
  if (shader) args.splice(args.indexOf("--shader"), 1);
  const templateDir = shader ? SHADER_TEMPLATE_DIR : TEMPLATE_DIR;
  const templateId = shader ? SHADER_TEMPLATE_ID : TEMPLATE_ID;
  const plugins = resolve(take("--plugins") ?? join(REPO, "plugins"));
  const givenName = take("--name");
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) throw new Error(`Pass the plugin's id, e.g. pnpm plugin:new acme.promo-kit.\n\n${HELP}`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/.test(id)) throw new Error(`${id} isn't an id: lowercase letters, digits and dashes, in two or more parts with dots between (acme.promo-kit).`);
  if (id === TEMPLATE_ID || id === SHADER_TEMPLATE_ID) throw new Error(`${id} is the template's own id: pick yours.`);
  const folder = id.replaceAll(".", "-");
  const dir = join(plugins, "catalog", folder);
  if (existsSync(dir)) throw new Error(`${relative(process.cwd(), dir) || dir} is already there.`);
  // An id (or folder) another plugin already has, there or in this repo.
  const others = [plugins, join(REPO, "plugins")].flatMap((root) => Object.values(pluginDirs(root)).flat());
  for (const other of others) {
    let otherId: string | undefined;
    try {
      otherId = (JSON.parse(readFileSync(join(other, "uncut.module.json"), "utf8")) as { id?: string }).id;
    } catch {}
    if (otherId === id || other.endsWith(`/${folder}`)) throw new Error(`The id ${id} is taken by ${relative(process.cwd(), other) || other}.`);
  }
  const words = id.split(/[.-]/);
  const name = givenName?.trim() || [words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1), ...words.slice(1)].join(" ");
  const prefix = id.replace(/[.-]/g, "_");

  cpSync(templateDir, dir, { recursive: true });
  for (const file of readdirSync(dir)) {
    const path = join(dir, file);
    let body = readFileSync(path, "utf8");
    if (file === "uncut.module.json") {
      const manifest = JSON.parse(body) as Record<string, unknown>;
      manifest.name = name;
      body = `${JSON.stringify(manifest, null, 2)}\n`;
    }
    // The template's id, folder and tool prefix, wherever they appear (contribution ids, tool names).
    body = body.replaceAll(templateId, id).replaceAll(templateId.replaceAll(".", "-"), folder).replaceAll(templateId.replace(/[.-]/g, "_"), prefix);
    if (file === "effect.ts") body = body.replace(/^\/\/ The shader effect template \(D213\): copy it with `pnpm plugin:new <id> --shader`, never edit it in place\.\n/m, `// ${name} (${id}), started from Uncut's shader effect template.\n`);
    if (file === "server.ts") body = body.replace(/^\/\/ The plugin template: copy it with `pnpm plugin:new <id>`, never edit it in place\.\n/m, `// ${name} (${id}), started from Uncut's plugin template.\n`);
    writeFileSync(path, body);
  }
  return { dir, id, name, shader };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  try {
    const { dir, id, name, shader } = pluginNew(argv);
    const problems = [...(shader ? checkPluginShaders(dir, { where: relative(process.cwd(), dir) || dir }) : []), ...checkPluginFolder(dir, await gateContext())];
    const where = relative(process.cwd(), dir) || dir;
    console.log(`Made ${name} (${id}) in ${where}/`);
    if (problems.length) console.log(`\nIt doesn't pass the checks yet:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    console.log(`\nNext:
${shader ? `  1. Edit ${where}/effect.ts (the TypeGPU effect) and its params in uncut.module.json.
  2. pnpm plugin:check --write ${where}   (resolves effect.ts into the manifest's wgsl)
  3. pnpm plugin:check ${where}` : `  1. Edit ${where}/uncut.module.json: description, author, capabilities, agentTools, contributes.
  2. Edit ${where}/server.ts: one handler per tool (or make it a data plugin: see --help).
  3. pnpm plugin:check ${where}`}
  4. In Uncut: Settings, Plugins, Add plugin, Choose folder, then Allow.
  5. Open a pull request that adds only ${where}/.
pnpm plugin:new --help has the details.`);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
