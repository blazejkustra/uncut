// D258: plugins/bundled.json decides which of the repo's plugins ship inside Uncut (installed and
// allowed from the start); every other plugin folder, at the top of plugins/ or under catalog/, is
// install-only (the marketplace). The packaged app gets that split laid out by the desktop build
// (scripts/plugin-bundle.ts: bundled ones in Resources/plugins, the rest in Resources/plugins/catalog,
// no list); in development the server reads the list from the repo's plugins/ and gets the same split.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const BUNDLED_LIST_FILE = "bundled.json";

/** The ids in a plugins folder's bundled.json; undefined when there's none. Throws (one sentence) when it isn't a list of ids. */
export function readBundledList(pluginsDir: string): ReadonlyArray<string> | undefined {
  const file = join(pluginsDir, BUNDLED_LIST_FILE);
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} isn't valid JSON (${(error as Error).message}).`);
  }
  const ids = (raw as { bundled?: unknown } | null)?.bundled;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/.test(id))) {
    throw new Error(`${file} needs "bundled": a list of plugin ids (acme.promo-kit).`);
  }
  if (new Set(ids).size !== ids.length) throw new Error(`${file} lists a plugin twice.`);
  return ids as ReadonlyArray<string>;
}

/** Plugin folders under a plugins folder: its top-level ones (not catalog) and catalog/'s, no hidden or "_" ones (templates). */
export function pluginFolders(pluginsDir: string): Array<string> {
  const dirsIn = (dir: string, skip: ReadonlyArray<string>) => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => !n.startsWith(".") && !n.startsWith("_") && !skip.includes(n))
      .map((n) => join(dir, n))
      .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "uncut.module.json")))
      .sort();
  };
  return [...dirsIn(pluginsDir, ["catalog"]), ...dirsIn(join(pluginsDir, "catalog"), [])];
}

const idOf = (dir: string): string | undefined => {
  try {
    const id = (JSON.parse(readFileSync(join(dir, "uncut.module.json"), "utf8")) as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
};

export interface PluginLayout {
  /** The folders of the plugins that ship inside Uncut. */
  readonly bundled: ReadonlyArray<string>;
  /** Every other plugin folder: install-only, in the marketplace. */
  readonly catalog: ReadonlyArray<string>;
  /** Listed ids with no folder (one sentence each). */
  readonly problems: ReadonlyArray<string>;
}

/** The split bundled.json makes of a plugins folder; undefined when it has no bundled.json (every top-level folder ships, catalog/ is the catalog). */
export function pluginLayout(pluginsDir: string): PluginLayout | undefined {
  const list = readBundledList(pluginsDir);
  if (!list) return undefined;
  const wanted = new Set(list);
  const bundled: Array<string> = [];
  const catalog: Array<string> = [];
  const found = new Set<string>();
  for (const dir of pluginFolders(pluginsDir)) {
    const id = idOf(dir);
    if (id && wanted.has(id) && !found.has(id)) {
      found.add(id);
      bundled.push(dir);
    } else catalog.push(dir);
  }
  const problems = list.filter((id) => !found.has(id)).map((id) => `${BUNDLED_LIST_FILE} lists ${id}, but no plugin folder has that id.`);
  return { bundled, catalog, problems };
}
