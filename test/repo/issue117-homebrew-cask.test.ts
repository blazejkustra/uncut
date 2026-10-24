// Issue #117: the Homebrew cask (scripts/homebrew-cask.ts) installs the release's update zip, with the
// right version, sha256, bundle and zap paths; the release workflow pushes it to the tap only when a
// release is published. Nothing is downloaded or pushed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { caskSha256, caskVersion, renderCask, sha256OfFile, ZAP_PATHS } from "../../scripts/homebrew-cask.ts";
import { updateZipName } from "../../apps/desktop/scripts/signing.ts";

const SHA = "95f0fc740d39c6bdd9d830a91ce533ccec7e85d53741dc1f9fe27b48f8417e98";

test("the cask: version, sha256, the versioned update zip of the GitHub release, arm64 and macOS 13+", () => {
  const cask = renderCask({ version: "v0.0.4", sha256: SHA.toUpperCase() });
  assert.match(cask, /^cask "uncut" do\n/);
  assert.match(cask, /\n  version "0\.0\.4"\n/);
  assert.match(cask, new RegExp(`\\n  sha256 "${SHA}"\\n`));
  const url = /\n  url "([^"]+)"\n/.exec(cask)?.[1];
  assert.equal(url, "https://github.com/blazejkustra/uncut/releases/download/v#{version}/Uncut-#{version}-arm64-mac.zip");
  // The same file the release workflow uploads (D276), once #{version} is filled in.
  assert.equal(url!.replaceAll("#{version}", "0.0.4").split("/").pop(), updateZipName("0.0.4"));
  assert.match(cask, /\n  app "Uncut\.app"\n/);
  assert.match(cask, /\n  auto_updates true\n/);
  assert.match(cask, /\n  depends_on arch: :arm64\n/);
  assert.match(cask, /\n  depends_on macos: :ventura\n/);
  assert.match(cask, /strategy :github_latest/);
  assert.match(cask, /\nend\n$/);
});

test("the cask's app name, bundle id and arm64-only build match electron-builder.yml", () => {
  const builder = readFileSync(resolve("apps/desktop/electron-builder.yml"), "utf8");
  assert.match(builder, /^productName: Uncut$/m);
  assert.match(builder, /^appId: com\.blazejkustra\.uncut$/m);
  // Only arm64 targets: no on_intel block to keep in step.
  assert.deepEqual(
    [...builder.matchAll(/^\s+arch: (\S+)$/gm)].map((m) => m[1]).filter((a) => a !== "arm64"),
    [],
  );
});

test("zap: Uncut's data folder, the bundle id's caches and preferences, the updater's cache", () => {
  const cask = renderCask({ version: "0.0.4", sha256: SHA });
  for (const p of ZAP_PATHS) assert.ok(cask.includes(`    "${p}",\n`), p);
  assert.ok(ZAP_PATHS.includes("~/Library/Application Support/Uncut"));
  assert.ok(ZAP_PATHS.includes("~/Library/Caches/com.blazejkustra.uncut.ShipIt"));
  assert.ok(ZAP_PATHS.includes("~/Library/Caches/uncut-updater"));
  assert.ok(ZAP_PATHS.includes("~/Library/Preferences/com.blazejkustra.uncut.plist"));
});

test("bad input is refused: not a release version, not a sha256", () => {
  assert.equal(caskVersion(" v1.2.3 "), "1.2.3");
  for (const v of ["", "v", "1.2", "1.2.3-beta.1", '1.2.3"; system "x', "latest"]) assert.throws(() => caskVersion(v), /Not a release version/, v);
  for (const s of ["", SHA.slice(1), `${SHA}0`, SHA.replace("9", "g"), `"${SHA}"`]) assert.throws(() => caskSha256(s), /Not a sha256/, s);
});

test("the CLI hashes the zip it's given and writes the cask", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-cask-"));
  try {
    const zip = join(dir, "Uncut-0.0.9-arm64-mac.zip");
    writeFileSync(zip, "not really a zip");
    const sha = await sha256OfFile(zip);
    assert.equal(sha, createHash("sha256").update("not really a zip").digest("hex"));
    const out = join(dir, "uncut.rb");
    execFileSync(process.execPath, [resolve("scripts/homebrew-cask.ts"), "--version", "v0.0.9", "--zip", zip, "--out", out]);
    assert.equal(readFileSync(out, "utf8"), renderCask({ version: "0.0.9", sha256: sha }));
    const printed = execFileSync(process.execPath, [resolve("scripts/homebrew-cask.ts"), "--version", "0.0.9", "--sha256", sha], { encoding: "utf8" });
    assert.equal(printed, renderCask({ version: "0.0.9", sha256: sha }));
    assert.throws(() => execFileSync(process.execPath, [resolve("scripts/homebrew-cask.ts"), "--version", "0.0.9"], { stdio: "pipe" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the release workflow: a homebrew job on the latest published release (or by hand), skipped without the token", () => {
  const yml = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
  assert.match(yml, /\n  release:\n    types: \[published\]\n/);
  const job = yml.slice(yml.indexOf("\n  homebrew:\n"));
  assert.ok(job.length > 1, "a homebrew job");
  assert.match(job, /HOMEBREW_TAP_TOKEN/);
  assert.match(job, /::notice::/);
  assert.match(job, /node scripts\/homebrew-cask\.ts --version/);
  assert.match(job, /repository: blazejkustra\/homebrew-tap/);
  assert.match(job, /Casks\/uncut\.rb/);
  // Only the latest published release (never a draft, a prerelease or an older one), one push at a time.
  assert.match(job, /releases\/latest/);
  assert.match(job, /\n    concurrency:\n      group: homebrew-tap\n/);
  // The dmg job never runs for the release event or a cask-only run by hand.
  const dmg = yml.slice(yml.indexOf("\n  dmg:\n"), yml.indexOf("\n  homebrew:\n"));
  assert.match(dmg, /\n    if: github\.event_name != 'release' && !inputs\.cask_tag\n/);
});
