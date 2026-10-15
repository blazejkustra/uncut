// pnpm plugin:check [folder]: the checks a plugin pull request must pass (D104), the same as
// test/repo/plugins-folder.test.ts, on one folder (or, with none, every plugin in the repo).
// --help says what's checked.
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { checkPluginFolder, gateContext, pluginDirs, SHADER_TEMPLATE_DIR, SHADER_TEMPLATE_ID, TEMPLATE_DIR } from "./plugin-gate.ts";
import { checkPluginShaders } from "./plugin-shaders.ts";

const HELP = `pnpm plugin:check [--write] [folder]

Checks a plugin folder the way the repo's gate test does (run it before a pull request);
with no folder, every plugin under plugins/ and plugins/catalog, and the template.

  - uncut.module.json is valid (the schema, plus Uncut's own checks) and declares
    "apiVersion": "uncut.module/1";
  - the folder is named after the id, dots as dashes (acme.promo-kit: acme-promo-kit);
  - the id, contribution ids and tool names aren't taken by another plugin in the repo;
    contribution ids are the plugin's id, a dot and a name;
  - looks, components and rules load without a warning (no script in a component);
  - only .json and .ts files, at the folder's top level, no symlinks or hidden files,
    at most 40 files and 512 KB;
  - code imports only node: built-ins, @uncut/plugin-sdk and its own ./files.ts;
  - a data plugin is its manifest alone (plus its shader effects' .ts sources); a node
    plugin's entry .ts is in the folder;
  - shader effects (contributes.shaders): each source's TypeGPU export is resolved with
    TypeGPU (in a Node run that can only read the repo and the folder) and must give the
    manifest's wgsl; its signature (uv, t, size[, params]), its params struct against the
    manifest's params, the params' ranges and defaults, and the WGSL limits (no loop or
    while, small literal for loops, no storage, atomics or attributes) are checked.
    --write puts the resolved WGSL in the manifest instead of reporting a difference.

Exit code 0 when it passes, 1 with one line per problem otherwise.`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const given = argv.find((a) => !a.startsWith("-"));
const write = argv.includes("--write");
const shaders = (dir: string) => checkPluginShaders(dir, { write, where: relative(process.cwd(), dir) || dir });
const ctx = await gateContext();
const { bundled, catalog } = pluginDirs();
const problems: Array<string> = [];
let checked: Array<string>;
if (given) {
  const dir = resolve(given);
  if (!existsSync(dir)) {
    console.error(`There's no folder ${given}.`);
    process.exit(1);
  }
  // The repo's other plugins first, so a taken id, contribution or tool name shows up.
  for (const other of [...bundled, ...catalog]) if (resolve(other) !== dir) checkPluginFolder(other, ctx);
  const shaderTemplate = dir === resolve(SHADER_TEMPLATE_DIR);
  // The shader sources first (--write may fill in the manifest's wgsl the gate then reads).
  problems.push(...shaders(dir));
  problems.push(...checkPluginFolder(dir, ctx, { template: dir === resolve(TEMPLATE_DIR) || shaderTemplate, ...(shaderTemplate ? { templateId: SHADER_TEMPLATE_ID } : {}) }));
  checked = [dir];
} else {
  for (const dir of [...bundled, ...catalog]) problems.push(...shaders(dir), ...checkPluginFolder(dir, ctx));
  problems.push(...checkPluginFolder(TEMPLATE_DIR, await gateContext(), { template: true }));
  problems.push(...shaders(SHADER_TEMPLATE_DIR), ...checkPluginFolder(SHADER_TEMPLATE_DIR, await gateContext(), { template: true, templateId: SHADER_TEMPLATE_ID }));
  checked = [...bundled, ...catalog, TEMPLATE_DIR, SHADER_TEMPLATE_DIR];
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
if (given) {
  const { id } = JSON.parse(readFileSync(resolve(given, "uncut.module.json"), "utf8")) as { id: string };
  console.log(`${id} passes (${relative(process.cwd(), resolve(given)) || "."}).`);
} else console.log(`${checked.length} plugin folders pass.`);
