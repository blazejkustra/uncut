// Issue #90 (D258) on the bundled server: with a bundled.json in the bundled folder, only the listed
// plugins ship (allowed), and every other plugin there is in the catalog, install-only. A catalog
// entry carries what the marketplace card shows (author, asks) and, once installed, whether that
// copy is allowed; install, allow (with D248's skills hash), disable and remove follow it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUNDLE, MEDIA, connect, killAll, startServer } from "../helpers/server.ts";

const skip = existsSync(BUNDLE) && existsSync(MEDIA) ? false : "server bundle or media binary not built";
const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-market-")));
after(() => {
  killAll();
  rmSync(root, { recursive: true, force: true });
});

test("bundled.json splits the bundled folder; the catalog's cards; install, allow, disable and remove", { skip, timeout: 60000 }, async () => {
  const bundled = join(root, "plugins");
  cpSync(resolve("plugins/uncut-skills"), join(bundled, "uncut-skills"), { recursive: true });
  cpSync(resolve("plugins/catalog/taste-extra"), join(bundled, "taste-extra"), { recursive: true });
  cpSync(resolve("plugins/catalog/uncut-example-kit"), join(bundled, "catalog", "uncut-example-kit"), { recursive: true });
  writeFileSync(join(bundled, "bundled.json"), JSON.stringify({ bundled: ["uncut.skills"] }));
  const server = await startServer({ env: { UNCUT_DATA_DIR: join(root, "data"), UNCUT_BUNDLED_PLUGINS_DIR: bundled } });
  const client = await connect(server.ready.port, server.ready.token);
  const list = await client.ok("plugins.list", {});
  assert.deepEqual(
    list.map((p: any) => [p.id, p.source, p.status]),
    [["uncut.skills", "bundled", "ready"]],
    "only the listed plugin ships; taste.extra sits at the top but isn't listed",
  );
  assert.equal(list[0].author, "Uncut");
  assert.equal(list[0].runs, false);

  const catalog = await client.ok("plugins.catalog", {});
  assert.deepEqual(catalog.plugins.map((p: any) => p.id).sort(), ["taste.extra", "uncut.example-kit"]);
  const kit = catalog.plugins.find((p: any) => p.id === "uncut.example-kit");
  assert.equal(kit.author, "Uncut");
  assert.equal(kit.enabled, false);
  assert.equal(kit.status, undefined);
  assert.match(kit.asks[0], /adds a skill/, "the card says what allowing it means (D248's skills sentence)");
  assert.deepEqual(kit.contributes, {
    looks: ["Lower third"],
    components: ["Callout badge"],
    rules: [],
    shaders: ["Spotlight"],
    skills: ["Lower thirds (/example-kit-lower-thirds)"],
  });

  // Install: copied in, not allowed yet.
  const installed = await client.ok("plugins.enable", { id: "uncut.example-kit" });
  const row = installed.plugins.find((p: any) => p.id === "uncut.example-kit");
  assert.equal(row.status, "needs-approval");
  assert.ok(row.skillsHash, "the approval is for its skills");
  assert.equal((await client.ok("plugins.catalog", {})).plugins.find((p: any) => p.id === "uncut.example-kit").status, "needs-approval");
  // Allow: as shown (folder, capabilities, skills).
  const allowed = await client.ok("plugins.approve", { id: row.id, dir: row.dir, capabilities: row.capabilities, skills: row.skillsHash });
  assert.equal(allowed.find((p: any) => p.id === "uncut.example-kit").status, "ready");
  assert.equal((await client.ok("plugins.catalog", {})).plugins.find((p: any) => p.id === "uncut.example-kit").status, "ready");
  const contributions = await client.ok("plugins.contributions", {});
  assert.ok(contributions.shaders.some((s: any) => s.id === "uncut.example-kit.spotlight" && s.wgsl.includes("fn effect")));
  assert.ok(contributions.looks.some((l: any) => l.id === "uncut.example-kit.lower-third"));
  // Disable: stops allowing it; its contributions go, the copy stays.
  await client.ok("plugins.revoke", { id: "uncut.example-kit" });
  const off = (await client.ok("plugins.catalog", {})).plugins.find((p: any) => p.id === "uncut.example-kit");
  assert.deepEqual([off.enabled, off.status], [true, "needs-approval"]);
  assert.ok(!(await client.ok("plugins.contributions", {})).looks.some((l: any) => l.id === "uncut.example-kit.lower-third"));
  // Remove: back to available.
  await client.ok("plugins.uninstall", { id: "uncut.example-kit" });
  const gone = (await client.ok("plugins.catalog", {})).plugins.find((p: any) => p.id === "uncut.example-kit");
  assert.deepEqual([gone.enabled, gone.status], [false, undefined]);
  assert.ok(!(await client.ok("plugins.list", {})).some((p: any) => p.id === "uncut.example-kit"));
});
