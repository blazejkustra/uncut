// `pnpm dist:signed` (D114, D247): a Developer ID-signed, notarized and stapled DMG in
// release/Uncut-<version>-<YYYYMMDD>-arm64.dmg that opens on any Mac without a Gatekeeper warning.
//   1. identity: the first Developer ID Application one (or UNCUT_SIGN_IDENTITY); a forced other
//      identity (Apple Development) makes a local-only build: signed and checked, not notarized.
//   2. the notary profile (UNCUT_NOTARY_PROFILE, default uncut-notary; UNCUT_NOTARY_KEYCHAIN in CI)
//      is checked before the slow build.
//   3. electron-builder signs the app (hardened runtime, secure timestamp, entitlements) into
//      dist/signed/mac-arm64; every Mach-O inside is checked, then codesign --verify --deep --strict.
//   4. the app is notarized (zip) and stapled; a DMG is made from it, signed, notarized and stapled.
//   5. stapler validate and spctl on both, then the DMG goes to release/, with the auto-update feed
//      (#102, D276): a zip of the stapled app (Squirrel.Mac installs from it), a .blockmap for the
//      zip and the DMG (electron-updater's differential download), and latest-mac.yml.
// It runs `pnpm build` itself, after the cheap checks, with telemetry's app token (D223) from
// UNCUT_TELEMETRY_TOKEN or the keychain item "uncut-telemetry-app-token"; without one the build is inert.
// It never prints credentials: notarytool reads them from the keychain profile, the token goes only
// into the build's environment.
// Flags: --sign-only (sign, check and make the DMG, no notarization: nothing goes to Apple);
// --skip-build (package the apps/*/dist already built); --dmg-only (D288: only remake and sign the
// local DMG from the app already signed in dist/signed/mac-arm64, to check the installer window).
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILT_DMG_NAME,
  dmgBuilderArgs,
  dmgSignArgs,
  isMachO,
  isMissingProfile,
  latestMacYaml,
  loadBuildBlockMap,
  notaryAuth,
  notaryCheckArgs,
  notaryLogArgs,
  notarySubmitArgs,
  parseCodesignDetails,
  parseIdentities,
  parseNotarySubmit,
  parseSpctl,
  pickIdentity,
  releaseDmgName,
  signatureProblems,
  signedBuilderArgs,
  spctlDmgArgs,
  storeCredentialsHint,
  telemetryToken,
  TELEMETRY_KEYCHAIN_SERVICE,
  updateZipArgs,
  updateZipName,
  type FeedFile,
  type NotaryAuth,
} from "./signing.ts";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktop, "../..");
const signedDir = resolve(root, "dist/signed");
const appPath = join(signedDir, "mac-arm64", "Uncut.app");

const fail = (message: string): never => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};
const step = (message: string) => console.log(`\n▸ ${message}`);

/** Runs a tool, returning its exit code and combined output (nothing printed). */
function capture(cmd: string, args: ReadonlyArray<string>): { code: number; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
/** Runs a tool with its output on the terminal; fails the build when it fails. */
function run(cmd: string, args: ReadonlyArray<string>, what: string, cwd?: string) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (r.status !== 0) fail(`${what} failed (${cmd} exited ${r.status ?? r.signal}).`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const unknown = argv.filter((a) => a !== "--sign-only" && a !== "--skip-build" && a !== "--dmg-only");
if (unknown.length) fail(`Unknown argument ${unknown.join(" ")} (only --sign-only, --skip-build and --dmg-only).`);
const dmgOnly = argv.includes("--dmg-only");
const signOnly = argv.includes("--sign-only") || dmgOnly;
const skipBuild = argv.includes("--skip-build");

// 1. Identity.
const picked = pickIdentity(
  parseIdentities(execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" })),
  process.env.UNCUT_SIGN_IDENTITY,
);
if ("problem" in picked) fail(picked.problem);
const { identity, shareable: developerId } = picked as Exclude<typeof picked, { problem: string }>;
if (!developerId) console.warn(`\n⚠ ${(picked as { warning: string }).warning}`);
const shareable = developerId && !signOnly;
if (developerId && signOnly) console.warn("\n⚠ --sign-only: signed and checked, NOT notarized (nothing is sent to Apple); not copied to release/.");
const teamId = /\(([A-Z0-9]{10})\)$/.exec(identity.name)?.[1];
console.log(`Signing with ${identity.name} (${identity.hash}), hardened runtime, secure timestamp${shareable ? ", notarized" : ", NOT notarized"}.`);

if (dmgOnly) {
  if (!existsSync(appPath)) fail(`--dmg-only: no signed app at ${relative(root, appPath)}; run pnpm dist:signed --sign-only first.`);
  const dmg = join(signedDir, "Uncut-local-arm64.dmg");
  makeDmg(appPath, dmg);
  console.log(`\nSigned DMG (not notarized) from the existing app: ${dmg}`);
  process.exit(0);
}

// 2. The notary profile, before spending minutes on a build.
const auth = notaryAuth(process.env);
if (shareable) {
  step(`Checking the notary profile "${auth.profile}"${auth.keychain ? ` in ${auth.keychain}` : ""}`);
  const check = capture("xcrun", notaryCheckArgs(auth));
  if (check.code !== 0) {
    if (isMissingProfile(check.out)) fail(`No notarytool keychain profile "${auth.profile}". Create it once:\n  ${storeCredentialsHint(auth)}`);
    // notarytool's own message (an auth or network error); it holds no secret.
    fail(
      `notarytool could not use the profile "${auth.profile}":\n${check.out.trim()}\nIf the credentials changed, store them again:\n  ${storeCredentialsHint(auth)}`,
    );
  }
}

// 3. Build (with the telemetry token), then sign.
if (skipBuild) {
  console.log("\n--skip-build: packaging the apps/*/dist already built.");
  // D266: the plugins are staged from the repo even so (cheap), so a plugins/ change since the last
  // build isn't packaged stale.
  step("Staging the plugins (plugins/bundled.json)");
  const { stagePlugins } = await import("../../../scripts/plugin-bundle.ts");
  const staged = stagePlugins(undefined, join(desktop, "stage/plugins"));
  console.log(`plugins: ${staged.bundled.length} bundled, ${staged.catalog.length} in the catalog`);
} else {
  // stdout only (the password), piped, never on the terminal or in an argv.
  const k = process.env.UNCUT_TELEMETRY_TOKEN?.trim()
    ? undefined
    : spawnSync("security", ["find-generic-password", "-s", TELEMETRY_KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const fromKeychain = k && { code: k.status ?? 1, out: k.stdout ?? "" };
  const t = telemetryToken(process.env.UNCUT_TELEMETRY_TOKEN, fromKeychain);
  console.log(t.line);
  step("Building (pnpm build)");
  const r = spawnSync("pnpm", ["build"], { stdio: "inherit", cwd: root, env: { ...process.env, UNCUT_TELEMETRY_TOKEN: t.token ?? "" } });
  if (r.status !== 0) fail(`pnpm build failed (exited ${r.status ?? r.signal}).`);
}
step("Building the signed app (electron-builder)");
rmSync(join(signedDir, "mac-arm64"), { recursive: true, force: true });
run(join(desktop, "node_modules", ".bin", "electron-builder"), signedBuilderArgs(identity.hash), "electron-builder", desktop);
verifyApp(appPath);

if (!shareable) {
  // spctl is expected to reject a build that isn't Developer ID + notarized; shown, not enforced.
  const s = capture("spctl", ["-a", "-t", "exec", "-vv", appPath]);
  console.log(`spctl (expected to reject a local-only build): ${s.out.trim()}`);
  const dmg = join(signedDir, `Uncut-local-arm64.dmg`);
  makeDmg(appPath, dmg);
  console.log(`\nSigned app (not notarized): ${appPath}\nSigned DMG (not notarized; other Macs will warn): ${dmg}`);
  process.exit(0);
}

// 4. Notarize and staple the app, then the DMG made from it.
const work = mkdtempSync(join(tmpdir(), "uncut-notarize-"));
try {
  const zip = join(work, "Uncut.zip");
  step("Zipping the app for notarization");
  run("ditto", ["-c", "-k", "--keepParent", appPath, zip], "ditto");
  await notarize(zip, "the app", auth);
  await staple(appPath);
  assertSpctl(capture("spctl", ["-a", "-t", "exec", "-vv", appPath]).out, "the app");

  const dmg = join(signedDir, "Uncut-arm64.dmg");
  makeDmg(appPath, dmg);
  await notarize(dmg, "the DMG", auth);
  await staple(dmg);
  assertSpctl(capture("spctl", spctlDmgArgs(dmg)).out, "the DMG");
  checkAppInsideDmg(dmg);

  // 5. Output.
  const version = (JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")) as { version: string }).version;
  const out = join(root, "release", releaseDmgName(version, new Date()));
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(dmg, out);
  const sha = capture("shasum", ["-a", "256", out]).out.split(/\s/)[0];
  const feed = await updateFeed(version, out);
  console.log(
    `\n✓ Developer ID-signed, notarized and stapled:\n  ${out}\n  sha256 ${sha}\nAuto-update feed (upload all of these to the release of tag v${version}):\n  ${feed.join("\n  ")}`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

// ---------- steps ----------

/**
 * #102 (D276): the auto-update feed next to the DMG in release/: the zip of the stapled app, a
 * blockmap for it and for the DMG (gzip, electron-builder's own code), and latest-mac.yml. Returns
 * the files made.
 */
async function updateFeed(version: string, dmg: string): Promise<Array<string>> {
  step("Making the auto-update feed (zip, blockmaps, latest-mac.yml)");
  const dir = dirname(dmg);
  const zip = join(dir, updateZipName(version));
  rmSync(zip, { force: true });
  run("ditto", updateZipArgs(appPath, zip), "ditto (update zip)");
  const buildBlockMap = loadBuildBlockMap(desktop);
  const entry = async (file: string): Promise<FeedFile> => {
    const info = await buildBlockMap(file, "gzip", `${file}.blockmap`);
    return { url: file.slice(dir.length + 1), sha512: info.sha512, size: info.size };
  };
  const yml = join(dir, "latest-mac.yml");
  writeFileSync(yml, latestMacYaml({ version, zip: await entry(zip), dmg: await entry(dmg), releaseDate: new Date() }));
  return [dmg, `${dmg}.blockmap`, zip, `${zip}.blockmap`, yml];
}

/** Every Mach-O in the bundle signed by the team, hardened runtime, secure timestamp; then the deep check. */
function verifyApp(app: string) {
  step("Checking every binary's signature");
  const binaries = machOFiles(app);
  const bad: Array<string> = [];
  for (const file of binaries) {
    const problems = signatureProblems(parseCodesignDetails(capture("codesign", ["-dvvv", file]).out), teamId);
    if (problems.length) bad.push(`${relative(app, file)}: ${problems.join(", ")}`);
  }
  if (bad.length) fail(`Binaries that won't pass notarization:\n  ${bad.join("\n  ")}`);
  console.log(`${binaries.length} binaries: signed by ${teamId ?? identity.name}, hardened runtime, secure timestamp.`);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], "codesign --verify --deep --strict");
}

function machOFiles(dir: string): Array<string> {
  const found: Array<string> = [];
  const head = Buffer.alloc(4);
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue; // symlinks inside frameworks point at files already listed
    const file = join(entry.parentPath, entry.name);
    if (statSync(file).size < 4) continue;
    const fd = openSync(file, "r");
    try {
      readSync(fd, head, 0, 4, 0);
    } finally {
      closeSync(fd);
    }
    if (isMachO(head)) found.push(file);
  }
  return found;
}

/**
 * The installer DMG of the app (D288: electron-builder's dmg target on the signed app, the window
 * laid out from electron-builder.yml's `dmg` block), signed with the identity and a timestamp.
 */
function makeDmg(app: string, dmg: string) {
  step("Making the DMG (electron-builder's dmg target on the signed app)");
  const out = mkdtempSync(join(tmpdir(), "uncut-dmg-"));
  try {
    run(join(desktop, "node_modules", ".bin", "electron-builder"), dmgBuilderArgs(app, out), "electron-builder (dmg)", desktop);
    rmSync(dmg, { force: true });
    copyFileSync(join(out, BUILT_DMG_NAME), dmg); // the temp folder may be on another volume
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  run("codesign", dmgSignArgs(identity.hash, dmg), "signing the DMG");
  run("codesign", ["--verify", "--strict", "--verbose=2", dmg], "codesign --verify (DMG)");
}

async function notarize(file: string, what: string, a: NotaryAuth) {
  step(`Notarizing ${what} (xcrun notarytool submit --wait; usually a few minutes)`);
  const r = capture("xcrun", notarySubmitArgs(file, a));
  const result = parseNotarySubmit(r.out);
  if (r.code === 0 && result?.status === "Accepted") {
    console.log(`Accepted (${result.id}).`);
    return;
  }
  if (isMissingProfile(r.out)) fail(`No notarytool keychain profile "${a.profile}". Create it once:\n  ${storeCredentialsHint(a)}`);
  console.error(r.out.trim());
  if (result) {
    console.error(`\nNotary log for ${result.id}:`);
    console.error(capture("xcrun", notaryLogArgs(result.id, a)).out.trim());
  }
  fail(`Notarization of ${what} ${result ? `ended ${result.status}` : "failed"}.`);
}

/** Staples the ticket (retried: right after Accepted the ticket may not be served yet) and validates it. */
async function staple(file: string) {
  step(`Stapling ${relative(root, file)}`);
  for (let attempt = 1; ; attempt++) {
    const r = capture("xcrun", ["stapler", "staple", file]);
    if (r.code === 0) break;
    if (attempt >= 4) fail(`xcrun stapler staple failed:\n${r.out.trim()}`);
    console.log(`stapler: not yet (attempt ${attempt}), retrying in 15 s`);
    await sleep(15000);
  }
  run("xcrun", ["stapler", "validate", file], "xcrun stapler validate");
}

function assertSpctl(output: string, what: string) {
  const v = parseSpctl(output);
  console.log(output.trim());
  if (!v.accepted || v.source !== "Notarized Developer ID") fail(`Gatekeeper (spctl) does not accept ${what}: ${v.source ?? "no source"}.`);
}

/** Mounts the final DMG and checks the app inside still carries its ticket and a valid signature. */
function checkAppInsideDmg(dmg: string) {
  step("Checking the app inside the DMG");
  const mount = mkdtempSync(join(tmpdir(), "uncut-mnt-"));
  run("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mount, "-quiet"], "hdiutil attach");
  try {
    const app = join(mount, "Uncut.app");
    run("xcrun", ["stapler", "validate", app], "stapler validate (app in the DMG)");
    run("codesign", ["--verify", "--deep", "--strict", app], "codesign --verify (app in the DMG)");
  } finally {
    capture("hdiutil", ["detach", mount, "-quiet"]);
    rmSync(mount, { recursive: true, force: true });
  }
}
