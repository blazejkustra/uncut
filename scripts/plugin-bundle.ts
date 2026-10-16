// D258: lays out the plugins the packaged app ships, from plugins/bundled.json. The plugins it lists go
// in <out>/<folder> (Resources/plugins: installed and allowed from the start); every other plugin
// folder of the repo, at the top of plugins/ or under catalog/, goes in <out>/catalog/<folder>
// (Resources/plugins/catalog: the marketplace, install-only). Only what a plugin is made of is copied:
// its top-level .json and .ts files, not tests or notes. Templates ("_" folders) never ship.
// The desktop build (apps/desktop/scripts/build.ts) runs it; electron-builder.yml ships the result.
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pluginLayout, BUNDLED_LIST_FILE } from "../apps/server/src/plugins/discovery/bundled.ts";

export const REPO_PLUGINS = fileURLToPath(new URL("../plugins", import.meta.url));

/** The files of a plugin folder that ship: top-level .json and .ts, no tests. */
export const shippedFiles = (dir: string) =>
  readdirSync(dir)
    .filter((n) => !n.startsWith(".") && /\.(json|ts)$/.test(n) && !n.endsWith(".test.ts") && statSync(join(dir, n)).isFile())
    .sort();

/** Writes the packaged layout into `out` (emptied first) and returns what went where, by folder name. */
export function stagePlugins(pluginsDir: string = REPO_PLUGINS, out: string): { readonly bundled: ReadonlyArray<string>; readonly catalog: ReadonlyArray<string> } {
  const layout = pluginLayout(pluginsDir);
  if (!layout) throw new Error(`${join(pluginsDir, BUNDLED_LIST_FILE)} is missing: it lists the plugins that ship inside Uncut.`);
  if (layout.problems.length) throw new Error(layout.problems.join("\n"));
  const names = [...layout.bundled, ...layout.catalog].map((d) => basename(d));
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) throw new Error(`Two plugin folders are named ${twice}: the app ships them side by side, so rename one.`);
  rmSync(out, { recursive: true, force: true });
  const copy = (from: string, to: string) => {
    mkdirSync(to, { recursive: true });
    for (const f of shippedFiles(from)) copyFileSync(join(from, f), join(to, f));
  };
  for (const dir of layout.bundled) copy(dir, join(out, basename(dir)));
  mkdirSync(join(out, "catalog"), { recursive: true });
  for (const dir of layout.catalog) copy(dir, join(out, "catalog", basename(dir)));
  return { bundled: layout.bundled.map((d) => basename(d)), catalog: layout.catalog.map((d) => basename(d)) };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const out = process.argv[2];
  if (!out) {
    console.error("node scripts/plugin-bundle.ts <out folder>");
    process.exit(1);
  }
  const staged = stagePlugins(REPO_PLUGINS, resolve(out));
  console.log(`Bundled: ${staged.bundled.join(", ")}. Catalog: ${staged.catalog.join(", ")}.`);
}
