// The Homebrew cask for Uncut (#117): `brew install --cask blazejkustra/tap/uncut`. The release
// workflow renders it when a release is published and pushes it to blazejkustra/homebrew-tap
// (Casks/uncut.rb); a maintainer can render the same file by hand.
//   node scripts/homebrew-cask.ts --version 0.0.4 --zip release/Uncut-0.0.4-arm64-mac.zip
//   node scripts/homebrew-cask.ts --version v0.0.4 --sha256 <hex> [--out Casks/uncut.rb]
// The cask installs the update zip (Uncut-<version>-arm64-mac.zip, D276), not the dmg: its name
// follows from the version alone (the dmg's carries the build date). The app is Developer ID-signed,
// notarized and stapled (`pnpm dist:signed`, D247), so the cask needs no quarantine caveat; it
// updates itself (electron-updater), hence auto_updates. Apple silicon and macOS 13+ only, like the
// build (electron-builder.yml's arm64 targets, the bundle's LSMinimumSystemVersion 13.0; a bare
// `depends_on macos: :ventura` means 13 or later). The url has no `verified:` (Homebrew deprecated it).
import { createHash } from "node:crypto";
import { createReadStream, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { BUNDLE_ID, UPDATER_CACHE_DIR } from "../apps/desktop/src/updater/policy.ts";
import { updateZipName } from "../apps/desktop/scripts/signing.ts";

export const REPO = "blazejkustra/uncut";
export const TAP = "blazejkustra/homebrew-tap";

/** `0.0.4` or `v0.0.4` → `0.0.4`; anything that isn't a plain release version is refused. */
export function caskVersion(input: string): string {
  const version = input.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a release version: ${JSON.stringify(input)} (expected e.g. 0.0.4 or v0.0.4)`);
  return version;
}

export function caskSha256(input: string): string {
  const sha = input.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`Not a sha256: ${JSON.stringify(input)} (expected 64 hex digits)`);
  return sha;
}

/** What `brew uninstall --zap` removes: the app's data and Electron's, the updater's caches, macOS's per-app files. */
export const ZAP_PATHS = [
  "~/Library/Application Support/Uncut",
  `~/Library/Caches/${BUNDLE_ID}`,
  `~/Library/Caches/${BUNDLE_ID}.ShipIt`,
  `~/Library/Caches/${UPDATER_CACHE_DIR}`,
  `~/Library/HTTPStorages/${BUNDLE_ID}`,
  `~/Library/Preferences/${BUNDLE_ID}.plist`,
  `~/Library/Saved Application State/${BUNDLE_ID}.savedState`,
];

export function renderCask(o: { readonly version: string; readonly sha256: string }): string {
  const version = caskVersion(o.version);
  const sha256 = caskSha256(o.sha256);
  return `cask "uncut" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/${REPO}/releases/download/v#{version}/${updateZipName("#{version}")}"
  name "Uncut"
  desc "AI-first video editor that works with Claude Code"
  homepage "https://uncut.video/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :ventura

  app "Uncut.app"

  zap trash: [
${ZAP_PATHS.map((p) => `    "${p}",`).join("\n")}
  ]
end
`;
}

export async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const HELP = `node scripts/homebrew-cask.ts --version <version> (--zip <file> | --sha256 <hex>) [--out <file>]

Renders Uncut's Homebrew cask (Casks/uncut.rb in ${TAP}) for a published release.
  --version  the release, 0.0.4 or v0.0.4
  --zip      the release's Uncut-<version>-arm64-mac.zip; its sha256 goes in the cask
  --sha256   or the zip's sha256 itself
  --out      write the cask there instead of printing it`;

async function main(argv: Array<string>) {
  const { values } = parseArgs({ args: argv, options: { version: { type: "string" }, zip: { type: "string" }, sha256: { type: "string" }, out: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) return void console.log(HELP);
  if (!values.version || !values.zip === !values.sha256) {
    console.error(HELP);
    process.exit(2);
  }
  const sha256 = values.zip ? await sha256OfFile(resolve(values.zip)) : values.sha256!;
  const cask = renderCask({ version: values.version, sha256 });
  if (values.out) writeFileSync(resolve(values.out), cask);
  else process.stdout.write(cask);
}

if (import.meta.main) await main(process.argv.slice(2));
