// The gate for plugins in this repo (D103): every folder under plugins/ (the bundled, pre-approved
// ones at the top, and the catalog under plugins/catalog that users enable themselves) must be a
// plugin Uncut loads cleanly and that's safe to ship. Community plugins arrive as pull requests to
// plugins/catalog, so this is what a PR has to pass:
// - uncut.module.json valid (schema, checkManifest), apiVersion declared and current;
// - the folder is named after the id (dots as dashes), ids unique across the repo;
// - contributions without a single warning (namespaced, no collisions, no script in templates);
// - only regular files at the folder's top level (what the app ships: no subfolders, no symlinks,
//   nothing hidden), only .json and .ts, at most 40 files and 512 KB;
// - a data plugin is its manifest alone (no code); a process plugin's node entry is in its folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { API_VERSION } from "../../packages/plugin-sdk/src/index.ts";
import { loadModules, readContributions, type ModuleManifest } from "../../packages/core/src/index.ts";
import { checkManifest, MANIFEST_FILE } from "../../apps/server/src/plugins/plugins.ts";

const MAX_FILES = 40;
const MAX_BYTES = 512 * 1024;
const modules = await loadModules("spec/modules/builtin");
const builtinIds = new Set(modules.keys());
const moves = new Set([...modules.values()].filter((m) => m.kind === "move").map((m) => m.id));

const dirsIn = (root: string) => readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "catalog").map((d) => join(root, d.name));
const bundled = dirsIn("plugins");
const catalog = existsSync("plugins/catalog") ? dirsIn("plugins/catalog") : [];

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

test("the repo has bundled plugins and a catalog with the example", () => {
  assert.deepEqual(bundled.map((d) => d.split("/").at(-1)).sort(), ["argent-capture", "whisper-transcribe"]);
  assert.ok(catalog.some((d) => d.endsWith("taste-extra")));
});

test("every plugin under plugins/ passes the contribution rules", () => {
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const dir of [...bundled, ...catalog]) {
    const where = dir;
    const files = walk(dir);
    for (const f of files) {
      assert.equal(f.kind, "file", `${f.path}: only regular files (no symlinks, pipes or devices)`);
      assert.ok(!f.path.slice(dir.length + 1).split("/").some((part) => part.startsWith(".")), `${f.path}: no hidden files`);
      assert.match(f.path, /\.(json|ts)$/, `${f.path}: only .json and .ts files`);
      assert.ok(!f.path.slice(dir.length + 1).includes("/"), `${f.path}: files sit at the plugin's top level (the app ships */*.ts only)`);
      assert.doesNotMatch(f.path, /node_modules/, `${f.path}: no node_modules (plugins import only the SDK)`);
    }
    assert.ok(files.length <= MAX_FILES, `${where}: at most ${MAX_FILES} files`);
    assert.ok(files.reduce((n, f) => n + f.bytes, 0) <= MAX_BYTES, `${where}: at most ${MAX_BYTES / 1024} KB`);

    const raw = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
    const checked = checkManifest(raw, builtinIds);
    assert.ok("manifest" in checked, `${where}: ${"problem" in checked ? checked.problem : ""}`);
    const manifest = raw as ModuleManifest;
    assert.equal(manifest.apiVersion, API_VERSION, `${where}: declares apiVersion ${API_VERSION}`);
    assert.equal(dir.split("/").at(-1), manifest.id.replaceAll(".", "-"), `${where}: the folder is named after the id`);
    assert.ok(!ids.has(manifest.id), `${where}: id ${manifest.id} is also ${ids.get(manifest.id)}`);
    ids.set(manifest.id, dir);
    assert.equal(manifest.builtin, undefined, `${where}: plugins aren't built-in modules`);

    const { warnings } = readContributions(manifest, { reserved: builtinIds, moves, taken });
    assert.deepEqual(warnings, [], `${where}: contributions load without warnings`);

    const runtime = manifest.runtime as { type: string; command?: string; args?: Array<string> };
    if (runtime.type === "data") {
      assert.deepEqual(files.map((f) => f.path.slice(dir.length + 1)), [MANIFEST_FILE], `${where}: a data plugin is its manifest alone, no code`);
    } else {
      assert.equal(runtime.type, "process");
      if (runtime.command === "node") {
        const entry = (runtime.args ?? []).find((a) => a.endsWith(".ts"));
        assert.ok(entry && existsSync(join(dir, entry)), `${where}: its node entry is in the folder`);
      }
    }
  }
});
