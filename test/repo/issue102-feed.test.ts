// Issue #102 (D276): the auto-update feed `pnpm dist:signed` writes next to the DMG (the zip of the
// stapled app, blockmaps, latest-mac.yml) and the release workflow uploading it on the signed path
// only. The yml is read back with electron-updater's own parser and file resolution, and the
// blockmap is made with electron-builder's code on a scratch file. Nothing is signed or published.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { latestMacYaml, loadBuildBlockMap, updateZipArgs, updateZipName } from "../../apps/desktop/scripts/signing.ts";

const desktopRequire = createRequire(resolve("apps/desktop/package.json"));
const { load } = createRequire(desktopRequire.resolve("electron-updater"))("js-yaml") as { load: (s: string) => unknown };

test("the update zip: named for arm64, made with ditto from the stapled app", () => {
  assert.equal(updateZipName("0.0.2"), "Uncut-0.0.2-arm64-mac.zip");
  assert.deepEqual(updateZipArgs("/b/Uncut.app", "/r/z.zip"), ["-c", "-k", "--sequesterRsrc", "--keepParent", "/b/Uncut.app", "/r/z.zip"]);
});

test("latest-mac.yml has electron-builder's shape: version, zip first then dmg, path/sha512 of the zip, the date", () => {
  const yml = latestMacYaml({
    version: "0.0.2",
    zip: { url: "Uncut-0.0.2-arm64-mac.zip", sha512: "Wm9w+/==", size: 123 },
    dmg: { url: "Uncut-0.0.2-20261016-arm64.dmg", sha512: "RG1n", size: 456 },
    releaseDate: new Date("2026-10-16T12:00:00.000Z"),
  });
  const parsed = load(yml) as Record<string, unknown>;
  assert.deepEqual(parsed, {
    version: "0.0.2",
    files: [
      { url: "Uncut-0.0.2-arm64-mac.zip", sha512: "Wm9w+/==", size: 123 },
      { url: "Uncut-0.0.2-20261016-arm64.dmg", sha512: "RG1n", size: 456 },
    ],
    path: "Uncut-0.0.2-arm64-mac.zip",
    sha512: "Wm9w+/==",
    releaseDate: "2026-10-16T12:00:00.000Z",
  });
});

test("electron-updater's MacUpdater picks the zip from it on Apple silicon", () => {
  const { MacUpdater } = desktopRequire("electron-updater/out/MacUpdater") as {
    MacUpdater: { filterFilesForArch: (files: Array<{ url: URL; info: { url: string } }>, arm: boolean) => Array<{ info: { url: string } }> };
  };
  const base = new URL("https://github.com/blazejkustra/uncut/releases/download/v0.0.2/");
  const files = ["Uncut-0.0.2-arm64-mac.zip", "Uncut-0.0.2-20261016-arm64.dmg"].map((u) => ({ url: new URL(u, base), info: { url: u } }));
  const picked = MacUpdater.filterFilesForArch(files, true).filter((f) => f.info.url.endsWith(".zip"));
  assert.deepEqual(
    picked.map((f) => f.info.url),
    ["Uncut-0.0.2-arm64-mac.zip"],
  );
});

test("blockmaps: the loader dist:signed uses finds electron-builder's builder; base64 sha512 and size of the file", async () => {
  const buildBlockMap = loadBuildBlockMap(resolve("apps/desktop"));
  const dir = mkdtempSync(join(tmpdir(), "uncut-blockmap-"));
  try {
    const file = join(dir, "Uncut-0.0.2-arm64-mac.zip");
    const bytes = Buffer.alloc(300_000, 7);
    writeFileSync(file, bytes);
    const info = await buildBlockMap(file, "gzip", `${file}.blockmap`);
    assert.equal(info.size, bytes.length);
    assert.equal(info.sha512, createHash("sha512").update(bytes).digest("base64"));
    assert.ok(readFileSync(`${file}.blockmap`).length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dist:signed writes the feed after the DMG is stapled, from the stapled app", () => {
  const script = readFileSync("apps/desktop/scripts/dist-signed.ts", "utf8");
  const stapleApp = script.indexOf("await staple(appPath)");
  const feed = script.indexOf("await updateFeed(version, out)");
  assert.ok(stapleApp > 0 && feed > stapleApp, "the zip is made after the app's ticket is stapled");
  assert.match(script, /run\("ditto", updateZipArgs\(appPath, zip\)/);
  assert.match(script, /const buildBlockMap = loadBuildBlockMap\(desktop\);/);
  assert.match(script, /buildBlockMap\(file, "gzip", `\$\{file\}\.blockmap`\)/);
  assert.match(script, /writeFileSync\(yml, latestMacYaml\(/);
});

test("release.yml: a tag needs the certificate (no dmg-only release), drafts the dmg plus the feed, tag = app version", () => {
  const yml = readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(
    yml,
    /- name: A tag needs the certificate\n\s+if: env\.HAS_CERT != 'true' && github\.ref_type == 'tag'\n\s+run: \|\n[^\n]*::error::[^\n]*\n\s+exit 1/,
  );
  assert.match(yml, /- name: Ad-hoc dmg[^\n]*\n\s+if: env\.HAS_CERT != 'true' && github\.ref_type != 'tag'/);
  assert.match(
    yml,
    /- name: Draft release\n\s+if: env\.HAS_CERT == 'true' && github\.ref_type == 'tag'\n[^]*?gh release create "\$GITHUB_REF_NAME" release\/\*\.dmg release\/\*\.dmg\.blockmap release\/\*-mac\.zip release\/\*-mac\.zip\.blockmap release\/latest-mac\.yml --draft/,
  );
  assert.equal((yml.match(/gh release create/g) ?? []).length, 1, "the only release is the signed one");
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /"\$GITHUB_REF_NAME" != "v\$VERSION"/);
});

test("electron-builder publishes nothing itself; the app gets its feed from its own config (no app-update.yml in Resources)", () => {
  const builder = readFileSync("apps/desktop/electron-builder.yml", "utf8");
  assert.match(builder, /^publish: null$/m);
  const pkg = JSON.parse(readFileSync("apps/desktop/package.json", "utf8")) as {
    devDependencies: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  assert.equal(pkg.devDependencies["electron-updater"], "6.8.10", "bundled into main.cjs by esbuild, like everything else");
  assert.equal(pkg.dependencies?.["electron-updater"], undefined);
});
