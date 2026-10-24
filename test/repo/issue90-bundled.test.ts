// Issue #90 (D258): plugins/bundled.json decides what ships inside the app; every other plugin is
// install-only (the marketplace). The list, the layout it makes of a plugins folder, the packaged
// layout (scripts/plugin-bundle.ts, run by the desktop build, shipped by electron-builder.yml), the
// server's config and discovery honouring it, the example plugin and pnpm plugin:new --from, the
// gate's skill names, and the guide covering every kind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { pluginLayout, readBundledList } from "../../apps/server/src/plugins/discovery/bundled.ts";
import { discoverPlugins } from "../../apps/server/src/plugins/discovery/discover.ts";
import { readConfig } from "../../apps/server/src/app/config.ts";
import { stagePlugins, shippedFiles } from "../../scripts/plugin-bundle.ts";
import { pluginNew, renameSkills } from "../../scripts/plugin-new.ts";
import { checkPluginFolder, gateContext } from "../../scripts/plugin-gate.ts";
import { checkPluginShaders } from "../../scripts/plugin-shaders.ts";
import { EXAMPLE, PLUGIN_GUIDE, guideMarkdown } from "../../apps/web/src/settings/plugins/guide.ts";

const REPO_PLUGINS = resolve("plugins");
const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `uncut-${name}-`)));
const manifest = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    manifest: "uncut.module/0",
    apiVersion: "uncut.module/1",
    id,
    kind: "pack",
    name: id,
    version: "1.0.0",
    runtime: { type: "data" },
    contributes: { rules: [{ id: `${id}.r`, title: "R", rule: { type: "max-words", max: 9 } }] },
    ...extra,
  });
const plugin = (dir: string, id: string, files: Record<string, string> = {}) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "uncut.module.json"), manifest(id));
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
};

test("the repo's bundled.json: today's behaviour (Argent, ElevenLabs, Uncut's skills, Whisper), every id has a folder", () => {
  assert.deepEqual([...readBundledList(REPO_PLUGINS)!].sort(), ["argent.capture", "uncut.elevenlabs", "uncut.skills", "whisper.transcribe"]);
  const layout = pluginLayout(REPO_PLUGINS)!;
  assert.deepEqual(layout.problems, []);
  assert.deepEqual(layout.bundled.map((d) => basename(d)).sort(), ["argent-capture", "uncut-elevenlabs", "uncut-skills", "whisper-transcribe"]);
  const catalog = layout.catalog.map((d) => basename(d));
  assert.ok(catalog.includes("uncut-example-kit") && catalog.includes("taste-extra"), "the catalog has the example and taste-extra");
  assert.ok(!catalog.some((n) => n.startsWith("_")), "templates are never plugins");
});

test("pluginLayout: the list picks bundled ones anywhere; the rest, top-level or catalog, are install-only; no list, no layout", () => {
  const root = tmp("layout");
  try {
    plugin(join(root, "kept"), "acme.kept");
    plugin(join(root, "demoted"), "acme.demoted");
    plugin(join(root, "catalog", "promoted"), "acme.promoted");
    plugin(join(root, "catalog", "plain"), "acme.plain");
    plugin(join(root, "catalog", "_template"), "example.template");
    mkdirSync(join(root, "catalog", "empty"));
    assert.equal(pluginLayout(root), undefined, "no bundled.json: the old layout (every top-level folder ships)");
    writeFileSync(join(root, "bundled.json"), JSON.stringify({ bundled: ["acme.kept", "acme.promoted", "acme.gone"] }));
    const layout = pluginLayout(root)!;
    assert.deepEqual(
      layout.bundled.map((d) => basename(d)),
      ["kept", "promoted"],
    );
    assert.deepEqual(
      layout.catalog.map((d) => basename(d)),
      ["demoted", "plain"],
    );
    assert.deepEqual(layout.problems, ["bundled.json lists acme.gone, but no plugin folder has that id."]);
    writeFileSync(join(root, "bundled.json"), JSON.stringify({ bundled: ["Not An Id"] }));
    assert.throws(() => readBundledList(root), /a list of plugin ids/);
    writeFileSync(join(root, "bundled.json"), JSON.stringify({ bundled: ["acme.kept", "acme.kept"] }));
    assert.throws(() => readBundledList(root), /twice/);
    writeFileSync(join(root, "bundled.json"), "{");
    assert.throws(() => readBundledList(root), /isn't valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stagePlugins: the packaged layout, bundled at the top and the rest in catalog/, only .json and .ts, no tests", () => {
  const root = tmp("stage-src");
  const out = join(tmp("stage-out"), "plugins");
  try {
    plugin(join(root, "kept"), "acme.kept", { "server.ts": "// x\n", "server.test.ts": "// test\n", "notes.md": "# no\n" });
    plugin(join(root, "demoted"), "acme.demoted");
    plugin(join(root, "catalog", "promoted"), "acme.promoted");
    plugin(join(root, "catalog", "_template"), "example.template");
    writeFileSync(join(root, "bundled.json"), JSON.stringify({ bundled: ["acme.kept", "acme.promoted"] }));
    mkdirSync(join(out, "stale"), { recursive: true });
    assert.deepEqual(stagePlugins(root, out), { bundled: ["kept", "promoted"], catalog: ["demoted"] });
    assert.deepEqual(readdirSync(out).sort(), ["catalog", "kept", "promoted"], "emptied first; bundled.json itself isn't shipped");
    assert.deepEqual(readdirSync(join(out, "kept")).sort(), ["server.ts", "uncut.module.json"]);
    assert.deepEqual(readdirSync(join(out, "catalog")), ["demoted"]);
    rmSync(join(root, "bundled.json"));
    assert.throws(() => stagePlugins(root, out), /bundled\.json is missing/);
    writeFileSync(join(root, "bundled.json"), JSON.stringify({ bundled: ["acme.gone"] }));
    assert.throws(() => stagePlugins(root, out), /acme\.gone/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(resolve(out, ".."), { recursive: true, force: true });
  }
});

test("the repo staged as the app ships it: the list's plugins in plugins/, every other in plugins/catalog/, files as in the repo", () => {
  const out = join(tmp("stage-repo"), "plugins");
  try {
    const staged = stagePlugins(REPO_PLUGINS, out);
    const layout = pluginLayout(REPO_PLUGINS)!;
    assert.deepEqual(
      readdirSync(out)
        .filter((n) => n !== "catalog")
        .sort(),
      layout.bundled.map((d) => basename(d)).sort(),
    );
    assert.deepEqual(readdirSync(join(out, "catalog")).sort(), [...staged.catalog].sort());
    for (const dir of [...layout.bundled.map((d) => [d, join(out, basename(d))]), ...layout.catalog.map((d) => [d, join(out, "catalog", basename(d))])]) {
      const [from, to] = dir as [string, string];
      assert.deepEqual(readdirSync(to).sort(), shippedFiles(from));
      for (const f of readdirSync(to)) assert.ok(readFileSync(join(to, f)).equals(readFileSync(join(from, f))), `${basename(from)}/${f}`);
    }
  } finally {
    rmSync(resolve(out, ".."), { recursive: true, force: true });
  }
});

test("packaging is wired: the desktop build stages plugins, electron-builder ships stage/plugins, the stage folder is ignored", () => {
  const yml = readFileSync("apps/desktop/electron-builder.yml", "utf8");
  assert.match(yml, /- from: stage\/plugins\n\s+to: plugins\n/);
  assert.doesNotMatch(yml, /from: \.\.\/\.\.\/plugins\n/, "not the repo's plugins folder as is");
  assert.match(readFileSync("apps/desktop/scripts/build.ts", "utf8"), /stagePlugins\(undefined, dir\("stage\/plugins"\)\)/);
  assert.match(readFileSync(".gitignore", "utf8"), /^apps\/desktop\/stage\/$/m);
});

test("the server honours the list: config gives the bundled root its folders and the catalog the rest; discovery reads only those", async () => {
  const root = tmp("config");
  try {
    plugin(join(root, "kept"), "acme.kept");
    plugin(join(root, "demoted"), "acme.demoted");
    plugin(join(root, "catalog", "plain"), "acme.plain");
    const before = readConfig({ UNCUT_BUNDLED_PLUGINS_DIR: root, UNCUT_DATA_DIR: join(root, "data") });
    assert.equal(before.pluginDirs.at(-1)!.folders, undefined, "no list: every top-level folder (the packaged app)");
    assert.equal(before.pluginCatalogFolders, undefined);
    writeFileSync(join(root, "bundled.json"), JSON.stringify({ bundled: ["acme.kept"] }));
    const config = readConfig({ UNCUT_BUNDLED_PLUGINS_DIR: root, UNCUT_DATA_DIR: join(root, "data") });
    const bundledRoot = config.pluginDirs.at(-1)!;
    assert.deepEqual(bundledRoot.folders, [join(root, "kept")]);
    assert.deepEqual(config.pluginCatalogFolders, [join(root, "demoted"), join(root, "catalog", "plain")]);
    const reserved = { moduleIds: new Set<string>(), toolNames: new Set<string>() };
    assert.deepEqual(
      (await discoverPlugins([bundledRoot], reserved)).plugins.map((p) => p.id),
      ["acme.kept"],
    );
    const catalog = await discoverPlugins([{ source: "user", dir: config.pluginCatalogDir, folders: config.pluginCatalogFolders }], reserved);
    assert.deepEqual(
      catalog.plugins.map((p) => p.id),
      ["acme.demoted", "acme.plain"],
    );
    // UNCUT_PLUGIN_CATALOG_DIR (tests) still means that folder alone.
    assert.equal(
      readConfig({ UNCUT_BUNDLED_PLUGINS_DIR: root, UNCUT_PLUGIN_CATALOG_DIR: join(root, "catalog"), UNCUT_DATA_DIR: join(root, "data") }).pluginCatalogFolders,
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the example plugin: a look, a component, a skill and a shader effect; it passes the gate and its shader resolves", async () => {
  const dir = join(REPO_PLUGINS, "catalog", basename(EXAMPLE.folder));
  const m = JSON.parse(readFileSync(join(dir, "uncut.module.json"), "utf8"));
  assert.equal(m.id, EXAMPLE.id);
  assert.equal(m.runtime.type, "data");
  for (const kind of ["looks", "components", "skills", "shaders"]) assert.equal(m.contributes[kind].length, 1, kind);
  const ctx = await gateContext();
  assert.deepEqual(checkPluginShaders(dir, { where: "example" }), []);
  assert.deepEqual(checkPluginFolder(dir, ctx), []);
});

test("pnpm plugin:new --from uncut.example-kit: a copy with your id everywhere and renamed skills, which passes the gate", async () => {
  const plugins = tmp("from");
  try {
    mkdirSync(join(plugins, "catalog"));
    const made = pluginNew(["acme.promo-kit", "--from", EXAMPLE.id, "--plugins", plugins, "--name", "Acme kit"]);
    assert.equal(made.from, true);
    assert.equal(made.dir, join(plugins, "catalog", "acme-promo-kit"));
    const m = JSON.parse(readFileSync(join(made.dir, "uncut.module.json"), "utf8"));
    assert.equal(m.id, "acme.promo-kit");
    assert.equal(m.name, "Acme kit");
    assert.deepEqual(
      [m.contributes.looks[0].id, m.contributes.components[0].id, m.contributes.shaders[0].id],
      ["acme.promo-kit.lower-third", "acme.promo-kit.badge", "acme.promo-kit.spotlight"],
    );
    assert.equal(m.contributes.skills[0].name, "promo-kit-lower-thirds");
    assert.match(m.contributes.skills[0].instructions, /acme\.promo-kit\.lower-third/);
    assert.ok(!readFileSync(join(made.dir, "uncut.module.json"), "utf8").includes(EXAMPLE.id), "no trace of the example's id");
    assert.match(readFileSync(join(made.dir, "effect.ts"), "utf8"), /^\/\/ Acme kit \(acme\.promo-kit\), started from Example kit/);
    // The repo's plugins first, so a clash would show.
    const ctx = await gateContext();
    for (const dir of [...pluginLayout(REPO_PLUGINS)!.bundled, ...pluginLayout(REPO_PLUGINS)!.catalog]) checkPluginFolder(dir, ctx);
    assert.deepEqual(checkPluginShaders(made.dir, { where: "copy" }), []);
    assert.deepEqual(checkPluginFolder(made.dir, ctx), []);
    assert.throws(() => pluginNew(["acme.other", "--from", "nobody.here", "--plugins", plugins]), /no plugin nobody\.here/);
    assert.throws(() => pluginNew(["acme.other", "--from", EXAMPLE.id, "--shader", "--plugins", plugins]), /not both/);
  } finally {
    rmSync(plugins, { recursive: true, force: true });
  }
  assert.deepEqual(
    (
      renameSkills({ contributes: { skills: [{ name: "kit" }, { name: "other" }] } }, "uncut.kit", "acme.box").contributes as {
        skills: Array<{ name: string }>;
      }
    ).skills.map((s) => s.name),
    ["box", "box-other"],
  );
});

test("the gate: a skill name another plugin has, or one of Uncut's own, is refused", async () => {
  const root = tmp("gate-skills");
  try {
    const skill = (name: string) => ({ contributes: { skills: [{ name, description: "D", instructions: "I" }] } });
    for (const [folder, id, name] of [
      ["acme-one", "acme.one", "shared-name"],
      ["acme-two", "acme.two", "shared-name"],
      ["acme-three", "acme.three", "launch-promo"],
    ] as const) {
      mkdirSync(join(root, folder));
      writeFileSync(join(root, folder, "uncut.module.json"), manifest(id, skill(name)));
    }
    const ctx = await gateContext();
    assert.deepEqual(checkPluginFolder(join(root, "acme-one"), ctx), []);
    assert.match(checkPluginFolder(join(root, "acme-two"), ctx).join("\n"), /skill name shared-name is taken by acme\.one/);
    assert.match(checkPluginFolder(join(root, "acme-three"), ctx).join("\n"), /launch-promo is one of Uncut's own/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the guide covers the manifest, every kind, the SDK, testing and publishing, and names the example", () => {
  const md = guideMarkdown();
  for (const word of [
    "looks",
    "components",
    "rules",
    "filters",
    "shaders",
    "skills",
    "agent tools",
    "process plugins",
    "argent-capture",
    "whisper-transcribe",
    "serve",
    "ToolContext",
    "ToolError",
    "UncutDeclaration",
    "plugin:check --write",
    "bundled.json",
    "capabilities",
    "apiVersion",
    EXAMPLE.id,
    EXAMPLE.folder,
  ])
    assert.ok(md.includes(word), word);
  assert.deepEqual(
    PLUGIN_GUIDE.map((s) => s.id),
    ["what", "start", "manifest", "kinds", "sdk", "approval", "test", "publish"],
  );
  assert.ok(existsSync(join(REPO_PLUGINS, "catalog", basename(EXAMPLE.folder))), "the example the guide links to exists");
});
