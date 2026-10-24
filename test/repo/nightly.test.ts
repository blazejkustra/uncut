// Uncut Nightly (.github/workflows/nightly.yml): the channel read from the version, the nightly's
// version, its own app (name, bundle id, icon, data, update cache and feed) and the workflow that
// publishes it as a prerelease the release never sees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";

import { bundleIdFor, channelOf, feedFileFor, nightlyVersion, productNameFor } from "../../apps/desktop/src/channel.ts";
import { BUNDLE_ID, UPDATER_CACHE_DIR, updaterCacheDirFor, updaterConfigYaml } from "../../apps/desktop/src/updater/policy.ts";
import { builderConfigFor, dmgBuilderArgs, releaseDmgName, signedBuilderArgs } from "../../apps/desktop/scripts/signing.ts";

const fromBuilder = createRequire(realpathSync("apps/desktop/node_modules/electron-builder/package.json"));
const yaml = createRequire(realpathSync(fromBuilder.resolve("app-builder-lib")))("js-yaml") as { load: (s: string) => any };

test("the channel comes from the version alone", () => {
  assert.equal(channelOf("0.0.4"), "stable");
  assert.equal(channelOf("0.0.5-nightly.20261024.12"), "nightly");
  for (const v of ["0.0.5-beta.1", "0.0.5-nightly", "0.0.5-nightly.2026.1", "0.0.5-preview.20261024.1"]) assert.equal(channelOf(v), "stable", v);
});

test("a nightly's version is the next patch, the UTC date and the run, and sorts above the release", () => {
  assert.equal(nightlyVersion("0.0.4", new Date("2026-10-24T23:30:00Z"), 12), "0.0.5-nightly.20261024.12");
  assert.equal(nightlyVersion("1.9.9", new Date("2027-01-02T00:00:00Z"), 1), "1.9.10-nightly.20270102.1");
  assert.equal(nightlyVersion("0.0.5-nightly.20261024.12", new Date("2026-10-25T00:00:00Z"), 13), "0.0.6-nightly.20261025.13");
  assert.throws(() => nightlyVersion("x", new Date(), 1));
  assert.throws(() => nightlyVersion("0.0.4", new Date(), 0));
  assert.equal(channelOf(nightlyVersion("0.0.4", new Date(), 3)), "nightly");
});

test("the nightly is its own app: name, bundle id, feed, update cache, builder config, DMG name", () => {
  assert.equal(productNameFor("stable"), "Uncut");
  assert.equal(productNameFor("nightly"), "Uncut Nightly");
  assert.equal(bundleIdFor("stable"), BUNDLE_ID);
  assert.equal(bundleIdFor("nightly"), "com.blazejkustra.uncut.nightly");
  assert.equal(feedFileFor("stable"), "latest-mac.yml");
  assert.equal(feedFileFor("nightly"), "nightly-mac.yml");
  assert.equal(updaterCacheDirFor("stable"), UPDATER_CACHE_DIR);
  assert.notEqual(updaterCacheDirFor("nightly"), UPDATER_CACHE_DIR);
  assert.match(updaterConfigYaml({ provider: "github", owner: "o", repo: "r" }, "nightly"), /updaterCacheDirName: uncut-nightly-updater\n$/);
  assert.equal(builderConfigFor("stable"), "electron-builder.yml");
  assert.equal(builderConfigFor("nightly"), "electron-builder.nightly.yml");
  assert.deepEqual(signedBuilderArgs("A".repeat(40), "electron-builder.nightly.yml").slice(0, 2), ["--config", "electron-builder.nightly.yml"]);
  assert.deepEqual(dmgBuilderArgs("/s/Uncut Nightly.app", "/out", "electron-builder.nightly.yml").slice(0, 2), ["--config", "electron-builder.nightly.yml"]);
  assert.equal(releaseDmgName("0.0.5-nightly.20261024.12", new Date("2026-10-24T03:00:00Z")), "Uncut-Nightly-0.0.5-nightly.20261024.12-arm64.dmg");
});

test("electron-builder.nightly.yml extends the release's config with the nightly's id, name and icon", () => {
  const nightly = yaml.load(readFileSync("apps/desktop/electron-builder.nightly.yml", "utf8"));
  const stable = yaml.load(readFileSync("apps/desktop/electron-builder.yml", "utf8"));
  assert.deepEqual(nightly.extends, ["./electron-builder.yml", "./electron-builder.nightly-reset.yml"]);
  // electron-builder concatenates arrays across extends: the reset clears the release's document types.
  assert.equal(yaml.load(readFileSync("apps/desktop/electron-builder.nightly-reset.yml", "utf8")).mac.extendInfo.CFBundleDocumentTypes, null);
  assert.equal(nightly.appId, bundleIdFor("nightly"));
  assert.equal(nightly.productName, productNameFor("nightly"));
  assert.equal(nightly.dmg.title, productNameFor("nightly"));
  assert.equal(nightly.mac.icon, "build/icon-nightly.icns");
  assert.ok(existsSync("apps/desktop/build/icon-nightly.icns"));
  assert.notDeepEqual(readFileSync("apps/desktop/build/icon-nightly.icns"), readFileSync("apps/desktop/build/icon.icns"));
  // The same document type as the release's, but the release keeps owning double-clicks.
  const [doc] = nightly.mac.extendInfo.CFBundleDocumentTypes;
  assert.deepEqual({ ...doc, LSHandlerRank: "Owner" }, stable.mac.extendInfo.CFBundleDocumentTypes[0]);
  assert.equal(doc.LSHandlerRank, "Alternate");
});

test("the nightly workflow publishes a signed prerelease with the nightly feed, and the release workflow ignores its tags", () => {
  const yml = readFileSync(".github/workflows/nightly.yml", "utf8");
  assert.match(yml, /schedule:\n\s+- cron:/);
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /node scripts\/nightly-version\.ts --run "\$GITHUB_RUN_NUMBER" --write >> "\$GITHUB_OUTPUT"/);
  assert.match(yml, /run: pnpm dist:signed/);
  assert.match(yml, /release\/nightly-mac\.yml\s*\\\n\s+--prerelease --latest=false/);
  assert.doesNotMatch(yml, /--draft/, "the updater never reads drafts");
  const release = readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(release, /tags: \["v\*", "!v\*-nightly\.\*"\]/);
});
