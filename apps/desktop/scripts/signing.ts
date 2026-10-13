// `pnpm dist:signed` (D114): the app signed with a keychain identity instead of ad-hoc, with the
// hardened runtime and build/signed.entitlements.plist (microphone, camera, and what Electron
// needs), into dist/signed/ so the ad-hoc build the tests use (dist/mac-arm64) stays as it is.
// Not notarized. Pure helpers here; scripts/dist-signed.ts runs them.

/** Where the signed build goes, relative to apps/desktop (electron-builder's project dir). */
export const SIGNED_OUTPUT = "../../dist/signed";
export const SIGNED_ENTITLEMENTS = "build/signed.entitlements.plist";

/** The identities `security find-identity -v -p codesigning` lists: name and SHA-1. */
export function parseIdentities(output: string): Array<{ readonly hash: string; readonly name: string }> {
  const found: Array<{ hash: string; name: string }> = [];
  for (const line of output.split("\n")) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/.exec(line);
    if (m) found.push({ hash: m[1]!, name: m[2]! });
  }
  return found;
}

/**
 * The identity to sign with: UNCUT_SIGN_IDENTITY (a name or SHA-1 that must be in the keychain),
 * else the first Developer ID Application, else the first Apple Development one; a sentence when
 * there's none.
 */
export function pickIdentity(identities: ReadonlyArray<{ readonly hash: string; readonly name: string }>, wanted?: string): { readonly name: string; readonly hash: string } | { readonly problem: string } {
  if (wanted?.trim()) {
    const w = wanted.trim();
    const hit = identities.find((i) => i.hash === w.toUpperCase() || i.name === w || i.name.includes(w));
    return hit ?? { problem: `No signing identity "${w}" in the keychain (security find-identity -v -p codesigning lists them).` };
  }
  const hit = identities.find((i) => i.name.startsWith("Developer ID Application:")) ?? identities.find((i) => i.name.startsWith("Apple Development:"));
  return hit ?? { problem: "No Developer ID Application or Apple Development identity in the keychain. Set UNCUT_SIGN_IDENTITY to the one to use." };
}

/**
 * electron-builder's arguments for the signed build (run in apps/desktop). The identity is passed
 * by its SHA-1 (electron-builder refuses a "Developer ID Application:" prefix and finds the
 * certificate by any part of its line). No timestamp: --timestamp asks Apple's server, and a
 * build that isn't notarized doesn't need one.
 */
export function signedBuilderArgs(identityHash: string): Array<string> {
  return [
    "--config",
    "electron-builder.yml",
    "--mac",
    "dir",
    "--arm64",
    `-c.mac.identity=${identityHash}`,
    "-c.mac.hardenedRuntime=true",
    `-c.mac.entitlements=${SIGNED_ENTITLEMENTS}`,
    `-c.mac.entitlementsInherit=${SIGNED_ENTITLEMENTS}`,
    "-c.mac.timestamp=none",
    `-c.directories.output=${SIGNED_OUTPUT}`,
  ];
}

/** Whether the build is ad-hoc (the default `pnpm dist`): no identity, or "-". */
export const isAdHoc = (identity: unknown) => identity === undefined || identity === null || identity === "-";
