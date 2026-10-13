// The gate for plugins in this repo (D103): every folder under plugins/ (the bundled, pre-approved
// ones at the top, and the catalog under plugins/catalog that users enable themselves) must be a
// plugin Uncut loads cleanly and that's safe to ship. Community plugins arrive as pull requests to
// plugins/catalog, so this is what a PR has to pass:
// - uncut.module.json valid (schema, checkManifest), apiVersion declared and current;
// - the folder is named after the id (dots as dashes), ids unique across the repo;
// - contributions without a single warning (namespaced, no collisions, no script in templates);
// - only regular files at the folder's top level (what the app ships: no subfolders, no symlinks,
//   nothing hidden), only .json and .ts, at most 40 files and 512 KB;
// - a data plugin is its manifest alone (no code); a process plugin's node entry is in its folder;
// - code imports only node: built-ins, @uncut/plugin-sdk and its own files; tool names unique.
// The checks live in scripts/plugin-gate.ts (D104), shared with `pnpm plugin:check <folder>`; the
// catalog's _template passes them too (all but the folder name), and `pnpm plugin:new` makes plugins that do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkPluginFolder, gateContext, pluginDirs, REPO, TEMPLATE_DIR } from "../../scripts/plugin-gate.ts";

const { bundled, catalog } = pluginDirs();

test("the repo has bundled plugins and a catalog with the example", () => {
  assert.deepEqual(bundled.map((d) => d.split("/").at(-1)).sort(), ["argent-capture", "whisper-transcribe"]);
  assert.ok(catalog.some((d) => d.endsWith("taste-extra")));
  assert.ok(!catalog.some((d) => d.endsWith("_template")), "the template isn't a catalog plugin");
});

test("every plugin under plugins/ passes the contribution rules, and so does the template", async () => {
  const ctx = await gateContext();
  for (const dir of [...bundled, ...catalog]) assert.deepEqual(checkPluginFolder(dir, ctx), [], dir);
  assert.deepEqual(checkPluginFolder(TEMPLATE_DIR, await gateContext(), { template: true }), []);
});

test("the gate catches what a pull request must not do", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-gate-")));
  try {
    const dir = join(root, "plugins", "catalog", "acme-bad");
    cpSync(TEMPLATE_DIR, dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir, "uncut.module.json"), "utf8"));
    writeFileSync(join(dir, "uncut.module.json"), JSON.stringify({ ...manifest, id: "acme.bad", apiVersion: undefined, agentTools: [{ ...manifest.agentTools[0], name: "argent_record" }] }));
    writeFileSync(join(dir, "extra.ts"), 'import lodash from "lodash";\n');
    writeFileSync(join(dir, "notes.txt"), "hi");
    const ctx = await gateContext();
    for (const d of bundled) checkPluginFolder(d, ctx);
    const problems = checkPluginFolder(dir, ctx).join("\n");
    assert.match(problems, /declare "apiVersion"/);
    assert.match(problems, /argent_record is taken by argent\.capture/);
    assert.match(problems, /extra\.ts imports lodash/);
    assert.match(problems, /notes\.txt: only \.json and \.ts/);
    assert.match(problems, /example\.template\.headline/, "a contribution id that isn't the plugin's");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pnpm plugin:new makes a plugin that passes plugin:check and answers its tool", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-plugin-new-")));
  try {
    const plugins = join(root, "plugins");
    const out = execFileSync(process.execPath, [join(REPO, "scripts/plugin-new.ts"), "acme.promo", "--plugins", plugins], { encoding: "utf8" });
    assert.match(out, /plugins\/catalog\/acme-promo/);
    const dir = join(plugins, "catalog", "acme-promo");
    const manifest = JSON.parse(readFileSync(join(dir, "uncut.module.json"), "utf8"));
    assert.equal(manifest.id, "acme.promo");
    assert.equal(manifest.name, "Acme promo");
    assert.deepEqual(manifest.agentTools.map((t: { name: string }) => t.name), ["acme_promo_word_count"]);
    assert.deepEqual(manifest.contributes.looks.map((l: { id: string }) => l.id), ["acme.promo.headline"]);
    assert.ok(!readFileSync(join(dir, "server.ts"), "utf8").includes("example_template"));
    assert.match(execFileSync(process.execPath, [join(REPO, "scripts/plugin-check.ts"), dir], { encoding: "utf8" }), /acme\.promo passes/);
    // Twice: refused, the first copy kept.
    assert.throws(() => execFileSync(process.execPath, [join(REPO, "scripts/plugin-new.ts"), "acme.promo", "--plugins", plugins], { stdio: "pipe" }), /already/);
    // A bad id, and an id the repo has.
    assert.throws(() => execFileSync(process.execPath, [join(REPO, "scripts/plugin-new.ts"), "Acme", "--plugins", plugins], { stdio: "pipe" }), /lowercase/);
    assert.throws(() => execFileSync(process.execPath, [join(REPO, "scripts/plugin-new.ts"), "taste.extra", "--plugins", plugins], { stdio: "pipe" }), /taken/);
    // A broken folder fails plugin:check with its sentence.
    writeFileSync(join(dir, "notes.txt"), "hi");
    assert.throws(() => execFileSync(process.execPath, [join(REPO, "scripts/plugin-check.ts"), dir], { stdio: "pipe" }), /notes\.txt: only \.json and \.ts/);
    rmSync(join(dir, "notes.txt"));

    // It runs: the SDK's register hook (as Uncut starts it) answers tools/list and the tool.
    const project = join(root, "P.uncut");
    execFileSync("mkdir", ["-p", project]);
    writeFileSync(join(project, "project.json"), JSON.stringify({ tracks: [{ items: [{ id: "t1", text: "Ship it [[today]]" }, { id: "c1", media: "m" }] }] }));
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "acme_promo_word_count", arguments: {}, _meta: { "uncut/projectDir": project } } },
    ];
    // stdin stays open until the three answers are in (a closed stdin means Uncut is done: it exits).
    const child = spawn(process.execPath, ["--import", join(REPO, "packages/plugin-sdk/src/register.ts"), "server.ts"], { cwd: dir, stdio: ["pipe", "pipe", "inherit"] });
    let answer = "";
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no answers in 10 s: ${answer}`)), 10000);
      child.stdout.on("data", (d) => {
        answer += d;
        if (answer.trim().split("\n").length >= 3) {
          clearTimeout(timer);
          done();
        }
      });
      child.stdin.write(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
    });
    child.stdin.end();
    const replies = answer.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(replies[0].result.serverInfo.name, "acme.promo");
    assert.deepEqual(replies[1].result.tools.map((t: { name: string }) => t.name), ["acme_promo_word_count"]);
    assert.deepEqual(replies[2].result.structuredContent, { texts: 1, words: 3, perText: [{ id: "t1", words: 3 }], longest: { id: "t1", words: 3 } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok(!existsSync(join(REPO, "plugins/catalog/acme-promo")), "nothing written into the repo");
});
