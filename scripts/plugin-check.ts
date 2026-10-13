// pnpm plugin:check [folder]: the checks a plugin pull request must pass (D104), the same as
// test/repo/plugins-folder.test.ts, on one folder (or, with none, every plugin in the repo).
// --help says what's checked.
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { checkPluginFolder, gateContext, pluginDirs, TEMPLATE_DIR } from "./plugin-gate.ts";

const HELP = `pnpm plugin:check [folder]

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
  - a data plugin is its manifest alone; a node plugin's entry .ts is in the folder.

Exit code 0 when it passes, 1 with one line per problem otherwise.`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const given = argv.find((a) => !a.startsWith("-"));
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
  problems.push(...checkPluginFolder(dir, ctx, { template: dir === resolve(TEMPLATE_DIR) }));
  checked = [dir];
} else {
  for (const dir of [...bundled, ...catalog]) problems.push(...checkPluginFolder(dir, ctx));
  problems.push(...checkPluginFolder(TEMPLATE_DIR, await gateContext(), { template: true }));
  checked = [...bundled, ...catalog, TEMPLATE_DIR];
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
if (given) {
  const { id } = JSON.parse(readFileSync(resolve(given, "uncut.module.json"), "utf8")) as { id: string };
  console.log(`${id} passes (${relative(process.cwd(), resolve(given)) || "."}).`);
} else console.log(`${checked.length} plugin folders pass.`);
