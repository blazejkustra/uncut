// `pnpm dist:signed` (D114, D247): a Developer ID-signed, notarized and stapled DMG that opens on
// any Mac without a Gatekeeper warning. The app is signed with a keychain identity, the hardened
// runtime, a secure timestamp and build/signed.entitlements.plist into dist/signed/ (so the ad-hoc
// dist/mac-arm64 the tests use stays as it is), notarized, stapled, packed into a signed DMG that
// is notarized and stapled too, and copied to release/. Pure helpers here (identity, arguments,
// output parsing); scripts/dist-signed.ts runs them.

import { createRequire } from "node:module";
import { join } from "node:path";

/** Where the signed build goes, relative to apps/desktop (electron-builder's project dir). */
export const SIGNED_OUTPUT = "../../dist/signed";
export const SIGNED_ENTITLEMENTS = "build/signed.entitlements.plist";
export const DEFAULT_NOTARY_PROFILE = "uncut-notary";

type Identity = { readonly hash: string; readonly name: string };

/** The identities `security find-identity -v -p codesigning` lists: name and SHA-1. */
export function parseIdentities(output: string): Array<Identity> {
  const found: Array<Identity> = [];
  for (const line of output.split("\n")) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/.exec(line);
    if (m) found.push({ hash: m[1]!, name: m[2]! });
  }
  return found;
}

const isDeveloperId = (i: Identity) => i.name.startsWith("Developer ID Application:");

export type PickedIdentity =
  | { readonly identity: Identity; readonly shareable: true }
  | { readonly identity: Identity; readonly shareable: false; readonly warning: string }
  | { readonly problem: string };

/**
 * The identity to sign with. A shareable build needs a Developer ID Application identity: the
 * first one in the keychain, or UNCUT_SIGN_IDENTITY (a name, part of one, or a SHA-1) naming one.
 * UNCUT_SIGN_IDENTITY naming anything else (Apple Development) forces a local-only build: signed,
 * not notarized, for this Mac. With neither, a problem that says what was found and what's needed.
 */
export function pickIdentity(identities: ReadonlyArray<Identity>, wanted?: string): PickedIdentity {
  if (wanted?.trim()) {
    const w = wanted.trim();
    const hit = identities.find((i) => i.hash === w.toUpperCase() || i.name === w || i.name.includes(w));
    if (!hit) return { problem: `No signing identity "${w}" in the keychain (security find-identity -v -p codesigning lists them).` };
    if (isDeveloperId(hit)) return { identity: hit, shareable: true };
    return {
      identity: hit,
      shareable: false,
      warning: `"${hit.name}" is not a Developer ID Application identity: this build is LOCAL-ONLY (signed, not notarized). Other Macs will refuse it; it is not copied to release/.`,
    };
  }
  const hit = identities.find(isDeveloperId);
  if (hit) return { identity: hit, shareable: true };
  const others = identities.map((i) => `"${i.name}"`).join(", ");
  return {
    problem: [
      `No "Developer ID Application" identity in the keychain${others ? ` (found ${others})` : ""}.`,
      "A build other Macs open without a warning needs one: create it at developer.apple.com > Certificates (Developer ID Application), install it with its private key, then run pnpm dist:signed again.",
      "For a local-only build signed with another identity, set UNCUT_SIGN_IDENTITY to its name or SHA-1.",
    ].join("\n"),
  };
}

/**
 * electron-builder's arguments for the signed app (run in apps/desktop). The identity goes by its
 * SHA-1 (electron-builder refuses a "Developer ID Application:" prefix). osx-sign signs every
 * Mach-O in the bundle (helpers, frameworks, dylibs, crashpad, Resources/bin/uncut-media) with the
 * hardened runtime and, since no `timestamp` is set, Apple's secure timestamp. notarize=false:
 * this script notarizes, electron-builder must not try on its own when APPLE_* variables are set.
 */
export function signedBuilderArgs(identityHash: string): Array<string> {
  return [
    "--config",
    "electron-builder.yml",
    "--mac",
    "dir",
    "--arm64",
    "--publish",
    "never",
    `-c.mac.identity=${identityHash}`,
    "-c.mac.hardenedRuntime=true",
    `-c.mac.entitlements=${SIGNED_ENTITLEMENTS}`,
    `-c.mac.entitlementsInherit=${SIGNED_ENTITLEMENTS}`,
    "-c.mac.notarize=false",
    `-c.directories.output=${SIGNED_OUTPUT}`,
  ];
}

/** Whether the build is ad-hoc (the default `pnpm dist`): no identity, or "-". */
export const isAdHoc = (identity: unknown) => identity === undefined || identity === null || identity === "-";

// ---------- notarytool ----------

export type NotaryAuth = { readonly profile: string; readonly keychain?: string | undefined };

/** The profile and keychain from the environment: UNCUT_NOTARY_PROFILE (default uncut-notary), UNCUT_NOTARY_KEYCHAIN (CI's temporary keychain). */
export function notaryAuth(env: Record<string, string | undefined>): NotaryAuth {
  const profile = env.UNCUT_NOTARY_PROFILE?.trim() || DEFAULT_NOTARY_PROFILE;
  const keychain = env.UNCUT_NOTARY_KEYCHAIN?.trim() || undefined;
  return { profile, keychain };
}

const authArgs = (auth: NotaryAuth) => ["--keychain-profile", auth.profile, ...(auth.keychain ? ["--keychain", auth.keychain] : [])];

/** `xcrun` arguments: a cheap call that fails when the profile is missing or its credentials are wrong. */
export const notaryCheckArgs = (auth: NotaryAuth) => ["notarytool", "history", ...authArgs(auth), "--output-format", "json"];
export const notarySubmitArgs = (file: string, auth: NotaryAuth) => ["notarytool", "submit", file, ...authArgs(auth), "--wait", "--output-format", "json"];
export const notaryLogArgs = (id: string, auth: NotaryAuth) => ["notarytool", "log", id, ...authArgs(auth)];

/** The one line that fixes a missing notary profile (never with real credentials in it). */
export function storeCredentialsHint(auth: NotaryAuth): string {
  return `xcrun notarytool store-credentials "${auth.profile}" --apple-id <your Apple ID> --team-id <your Team ID> --password <an app-specific password from account.apple.com>${auth.keychain ? ` --keychain "${auth.keychain}"` : ""}`;
}

/** Whether notarytool's error output means the keychain profile isn't there. */
export const isMissingProfile = (output: string) =>
  /No Keychain password item found|could not find.*profile|profile.*not found|No credentials found/i.test(output);

/** `notarytool submit --wait --output-format json`'s answer: the submission id and its status. */
export function parseNotarySubmit(output: string): { readonly id: string; readonly status: string; readonly message?: string } | undefined {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    const json = JSON.parse(output.slice(start, end + 1)) as { id?: unknown; status?: unknown; message?: unknown };
    if (typeof json.id !== "string") return undefined;
    return {
      id: json.id,
      status: typeof json.status === "string" ? json.status : "Unknown",
      ...(typeof json.message === "string" ? { message: json.message } : {}),
    };
  } catch {
    return undefined;
  }
}

// ---------- verification ----------

export type SignatureDetails = {
  readonly signed: boolean;
  readonly adHoc: boolean;
  readonly runtime: boolean;
  readonly timestamp: boolean;
  readonly teamId?: string | undefined;
  readonly authority?: string | undefined;
};

/** `codesign -dvvv <file>`'s output (it prints to stderr): what the signature has. */
export function parseCodesignDetails(output: string): SignatureDetails {
  const flags = /^CodeDirectory .*flags=0x[0-9a-f]+\(([^)]*)\)/m.exec(output)?.[1] ?? "";
  const team = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim();
  return {
    signed: /^CodeDirectory /m.test(output) && !/code object is not signed/.test(output),
    adHoc: /^Signature=adhoc$/m.test(output) || flags.split(",").includes("adhoc"),
    runtime: flags.split(",").includes("runtime"),
    // A secure timestamp prints `Timestamp=`; `Signed Time=` is only the signer's clock.
    timestamp: /^Timestamp=/m.test(output),
    teamId: team && team !== "not set" ? team : undefined,
    authority: /^Authority=(.+)$/m.exec(output)?.[1]?.trim(),
  };
}

/** What's wrong with one binary's signature for notarization, or nothing. */
export function signatureProblems(d: SignatureDetails, teamId: string | undefined): Array<string> {
  if (!d.signed) return ["not signed"];
  const problems: Array<string> = [];
  if (d.adHoc) problems.push("ad-hoc signature");
  if (!d.runtime) problems.push("no hardened runtime");
  if (!d.timestamp) problems.push("no secure timestamp");
  if (teamId && d.teamId !== teamId) problems.push(`team ${d.teamId ?? "none"}, expected ${teamId}`);
  return problems;
}

/** `spctl -a -vv ...`'s verdict: accepted or not, and the source (want "Notarized Developer ID"). */
export function parseSpctl(output: string): { readonly accepted: boolean; readonly source?: string | undefined } {
  return { accepted: /: accepted$/m.test(output) && !/: rejected/m.test(output), source: /^source=(.+)$/m.exec(output)?.[1]?.trim() };
}

/** Whether a file's first bytes are a Mach-O (thin or universal) binary. */
export function isMachO(head: Uint8Array): boolean {
  if (head.length < 4) return false;
  const magic = ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf].includes(magic);
}

// ---------- output ----------

/** release/Uncut-<version>-<YYYYMMDD>-arm64.dmg, the date in UTC. */
export function releaseDmgName(version: string, date: Date): string {
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, "");
  return `Uncut-${version}-${ymd}-arm64.dmg`;
}

/** The DMG electron-builder writes into the output folder given to dmgBuilderArgs. */
export const BUILT_DMG_NAME = "Uncut.dmg";

/**
 * electron-builder's arguments (run in apps/desktop) for the installer DMG of an already signed and
 * stapled app (D288): its dmg target with --prepackaged, which neither packs nor signs nor runs the
 * afterSign hook, only lays out the DMG from electron-builder.yml's `dmg` block (background, window,
 * icon positions, volume name and icon) with dmgbuild, headless. Compressed HFS+ (UDZO); no blockmap
 * (stapling changes the bytes, the feed makes its own from the final file); not signed here, the
 * script signs it with dmgSignArgs. Into its own folder, so `pnpm dist`'s dist/ is never touched.
 */
export function dmgBuilderArgs(app: string, outDir: string): Array<string> {
  return [
    "--config",
    "electron-builder.yml",
    "--mac",
    "dmg",
    "--arm64",
    "--prepackaged",
    app,
    "--publish",
    "never",
    "-c.dmg.sign=false",
    "-c.dmg.writeUpdateInfo=false",
    "-c.dmg.format=UDZO",
    "-c.dmg.filesystem=HFS+",
    `-c.dmg.artifactName=${BUILT_DMG_NAME}`,
    `-c.directories.output=${outDir}`,
  ];
}

/** codesign's arguments for the DMG itself: the identity and a secure timestamp. */
export const dmgSignArgs = (identityHash: string, dmg: string) => ["--force", "--sign", identityHash, "--timestamp", dmg];

/** spctl's DMG check, as Apple documents it for a notarized disk image. */
export const spctlDmgArgs = (dmg: string) => ["-a", "-t", "open", "--context", "context:primary-signature", "-vv", dmg];

// ---------- telemetry token ----------

/** The keychain item (generic password) holding telemetry's app token (D223) for local release builds. */
export const TELEMETRY_KEYCHAIN_SERVICE = "uncut-telemetry-app-token";

/**
 * The token the build gets, and the one line that says where it came from (never the token).
 * UNCUT_TELEMETRY_TOKEN in the environment (CI's secret) wins; else `security find-generic-password
 * -s uncut-telemetry-app-token -w`'s stdout when it succeeded; else none and an inert build.
 */
export function telemetryToken(
  envToken: string | undefined,
  keychain: { readonly code: number; readonly out: string } | undefined,
): { readonly token?: string; readonly line: string } {
  if (envToken?.trim()) return { token: envToken.trim(), line: "Telemetry app token: from UNCUT_TELEMETRY_TOKEN." };
  const fromKeychain = keychain && keychain.code === 0 ? keychain.out.trim() : "";
  if (fromKeychain) return { token: fromKeychain, line: `Telemetry app token: from the keychain (${TELEMETRY_KEYCHAIN_SERVICE}).` };
  return { line: `Telemetry app token: none (no UNCUT_TELEMETRY_TOKEN, no keychain item ${TELEMETRY_KEYCHAIN_SERVICE}); this build's telemetry is inert.` };
}

// ---------- the auto-update feed (#102, D276) ----------

/** The zip Squirrel.Mac installs from (electron-updater picks the file whose name says arm64). */
export const updateZipName = (version: string) => `Uncut-${version}-arm64-mac.zip`;

/** ditto's arguments for the update zip of the stapled app (what electron-builder's mac zip and Apple use). */
export const updateZipArgs = (app: string, zip: string) => ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip];

export type BuildBlockMap = (file: string, compression: "gzip", out: string) => Promise<{ size: number; sha512: string }>;

/**
 * app-builder-lib's blockmap builder (electron-builder's own code; app-builder-lib isn't a direct
 * dependency). electron-builder is resolved from apps/desktop/package.json, which follows pnpm's
 * symlink to its real folder, where app-builder-lib sits beside it (D276).
 */
export function loadBuildBlockMap(desktopDir: string): BuildBlockMap {
  const builderPkg = createRequire(join(desktopDir, "package.json")).resolve("electron-builder/package.json");
  return (createRequire(builderPkg)("app-builder-lib/out/targets/blockmap/blockmap") as { buildBlockMap: BuildBlockMap }).buildBlockMap;
}

export type FeedFile = { readonly url: string; readonly sha512: string; readonly size: number };

/**
 * latest-mac.yml, as electron-builder writes it: the version, the zip first (path/sha512 at the top
 * are the zip's, for old updaters) then the DMG, sha512 in base64, and the release date. The GitHub
 * provider fetches it from the release of the tag v<version>; each file's url is the asset's name.
 */
export function latestMacYaml(input: { readonly version: string; readonly zip: FeedFile; readonly dmg: FeedFile; readonly releaseDate: Date }): string {
  const file = (f: FeedFile) => [`  - url: ${f.url}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`];
  return [
    `version: ${input.version}`,
    "files:",
    ...file(input.zip),
    ...file(input.dmg),
    `path: ${input.zip.url}`,
    `sha512: ${input.zip.sha512}`,
    `releaseDate: '${input.releaseDate.toISOString()}'`,
    "",
  ].join("\n");
}
