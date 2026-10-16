// D247: `pnpm dist:signed`'s pure parts (notarytool arguments and answers, codesign and spctl
// output, the release name, the telemetry token) and the release workflow running the same script.
// Nothing here calls codesign, notarytool or the keychain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";

import { backgroundSvg, DMG_FOOTER, DMG_HEADING, DMG_ICONS, DMG_WINDOW } from "../../apps/desktop/scripts/make-dmg-background.ts";
import {
  BUILT_DMG_NAME,
  DEFAULT_NOTARY_PROFILE,
  dmgBuilderArgs,
  dmgSignArgs,
  isMachO,
  isMissingProfile,
  notaryAuth,
  notaryCheckArgs,
  notaryLogArgs,
  notarySubmitArgs,
  parseCodesignDetails,
  parseNotarySubmit,
  parseSpctl,
  releaseDmgName,
  signatureProblems,
  spctlDmgArgs,
  storeCredentialsHint,
  TELEMETRY_KEYCHAIN_SERVICE,
  telemetryToken,
} from "../../apps/desktop/scripts/signing.ts";

test("notary profile: UNCUT_NOTARY_PROFILE, default uncut-notary; CI's keychain when given", () => {
  assert.equal(DEFAULT_NOTARY_PROFILE, "uncut-notary");
  assert.deepEqual(notaryAuth({}), { profile: "uncut-notary", keychain: undefined });
  assert.deepEqual(notaryAuth({ UNCUT_NOTARY_PROFILE: "  ", UNCUT_NOTARY_KEYCHAIN: "" }), { profile: "uncut-notary", keychain: undefined });
  const ci = notaryAuth({ UNCUT_NOTARY_PROFILE: "ci", UNCUT_NOTARY_KEYCHAIN: "/tmp/k.keychain-db" });
  assert.deepEqual(ci, { profile: "ci", keychain: "/tmp/k.keychain-db" });
  const local = notaryAuth({});
  assert.deepEqual(notarySubmitArgs("/x/Uncut.dmg", local), ["notarytool", "submit", "/x/Uncut.dmg", "--keychain-profile", "uncut-notary", "--wait", "--output-format", "json"]);
  assert.deepEqual(notarySubmitArgs("/x/Uncut.dmg", ci), ["notarytool", "submit", "/x/Uncut.dmg", "--keychain-profile", "ci", "--keychain", "/tmp/k.keychain-db", "--wait", "--output-format", "json"]);
  assert.deepEqual(notaryLogArgs("abc", local), ["notarytool", "log", "abc", "--keychain-profile", "uncut-notary"]);
  assert.deepEqual(notaryCheckArgs(local).slice(0, 2), ["notarytool", "history"]);
  const hint = storeCredentialsHint(local);
  assert.match(hint, /^xcrun notarytool store-credentials "uncut-notary" --apple-id <[^>]+> --team-id <[^>]+> --password <[^>]+>$/, "placeholders only");
  assert.equal(isMissingProfile('Error: No Keychain password item found for profile: uncut-notary'), true);
  assert.equal(isMissingProfile("Error: HTTP status code: 401. Unable to authenticate."), false);
});

test("notarytool submit's JSON answer: id and status, Invalid kept for the log", () => {
  const ok = 'Conducting pre-submission checks...\n{"id":"2efe2717-52ef-43a5-96dc-0797e4ca1041","status":"Accepted","message":"Processing complete"}\n';
  assert.deepEqual(parseNotarySubmit(ok), { id: "2efe2717-52ef-43a5-96dc-0797e4ca1041", status: "Accepted", message: "Processing complete" });
  assert.deepEqual(parseNotarySubmit('{"id":"x","status":"Invalid"}'), { id: "x", status: "Invalid" });
  assert.equal(parseNotarySubmit("Error: something"), undefined);
  assert.equal(parseNotarySubmit("{not json}"), undefined);
  assert.equal(parseNotarySubmit('{"status":"Accepted"}'), undefined, "no id, nothing to fetch a log for");
});

test("codesign -dvvv: Developer ID, hardened runtime, secure timestamp, team; what notarization refuses", () => {
  const good = `Executable=/x/Uncut.app/Contents/Resources/bin/uncut-media
Identifier=uncut-media
Format=Mach-O thin (arm64)
CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=30+7 location=embedded
Signature size=9000
Authority=Developer ID Application: Example Developer (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=16 Oct 2026 at 12:00:00
TeamIdentifier=ABCDE12345
Runtime Version=15.0.0`;
  const d = parseCodesignDetails(good);
  assert.deepEqual(d, { signed: true, adHoc: false, runtime: true, timestamp: true, teamId: "ABCDE12345", authority: "Developer ID Application: Example Developer (ABCDE12345)" });
  assert.deepEqual(signatureProblems(d, "ABCDE12345"), []);
  const adhoc = parseCodesignDetails(`CodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0 location=embedded
Signature=adhoc
Signed Time=16 Oct 2026
TeamIdentifier=not set`);
  assert.deepEqual(signatureProblems(adhoc, "ABCDE12345"), ["ad-hoc signature", "no hardened runtime", "no secure timestamp", "team none, expected ABCDE12345"]);
  assert.deepEqual(signatureProblems(parseCodesignDetails("/x: code object is not signed at all"), "ABCDE12345"), ["not signed"]);
  const otherTeam = parseCodesignDetails(good.replace(/ABCDE12345/g, "6HVVJA9KV8"));
  assert.deepEqual(signatureProblems(otherTeam, "ABCDE12345"), ["team 6HVVJA9KV8, expected ABCDE12345"]);
});

test("spctl's verdict: only accepted + Notarized Developer ID passes", () => {
  assert.deepEqual(parseSpctl("/x/Uncut.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Example Developer (ABCDE12345)"), { accepted: true, source: "Notarized Developer ID" });
  assert.deepEqual(parseSpctl("/x/Uncut.app: accepted\nsource=Developer ID"), { accepted: true, source: "Developer ID" });
  assert.deepEqual(parseSpctl("/x/Uncut.app: rejected\nsource=Unnotarized Developer ID"), { accepted: false, source: "Unnotarized Developer ID" });
  assert.deepEqual(spctlDmgArgs("/x.dmg"), ["-a", "-t", "open", "--context", "context:primary-signature", "-vv", "/x.dmg"]);
});

test("Mach-O detection: thin, fat, either byte order; not scripts or text", () => {
  const b = (...n: Array<number>) => Uint8Array.from(n);
  assert.equal(isMachO(b(0xcf, 0xfa, 0xed, 0xfe)), true, "arm64 thin (little-endian)");
  assert.equal(isMachO(b(0xca, 0xfe, 0xba, 0xbe)), true, "universal");
  assert.equal(isMachO(b(0xfe, 0xed, 0xfa, 0xcf)), true);
  assert.equal(isMachO(b(0x23, 0x21, 0x2f, 0x62)), false, "#!/b");
  assert.equal(isMachO(b(0xcf, 0xfa)), false);
});

test("the DMG: compressed HFS+, signed with the identity and a secure timestamp; release name with version and UTC date", () => {
  const args = dmgBuilderArgs("/s/Uncut.app", "/tmp/out");
  assert.deepEqual(args.slice(0, 7), ["--config", "electron-builder.yml", "--mac", "dmg", "--arm64", "--prepackaged", "/s/Uncut.app"], "the dmg target on the signed app, not a new build");
  for (const a of ["-c.dmg.sign=false", "-c.dmg.writeUpdateInfo=false", "-c.dmg.format=UDZO", "-c.dmg.filesystem=HFS+", `-c.dmg.artifactName=${BUILT_DMG_NAME}`, "-c.directories.output=/tmp/out"]) assert.ok(args.includes(a), a);
  assert.ok(!args.some((a) => a.startsWith("-c.mac.identity") || a.startsWith("-c.mac.hardenedRuntime")), "nothing that would re-sign the stapled app");
  assert.deepEqual(dmgSignArgs("CC8D", "/o.dmg"), ["--force", "--sign", "CC8D", "--timestamp", "/o.dmg"]);
  assert.equal(releaseDmgName("0.1.0", new Date("2026-10-16T23:30:00Z")), "Uncut-0.1.0-20261016-arm64.dmg");
  assert.equal(releaseDmgName("1.2.3", new Date("2027-01-02T00:00:00Z")), "Uncut-1.2.3-20270102-arm64.dmg");
  assert.match(readFileSync(".gitignore", "utf8"), /^release\/$/m, "release/ is never committed");
});

test("telemetry token: the environment wins, else the keychain item, else inert; never in the line", () => {
  assert.equal(TELEMETRY_KEYCHAIN_SERVICE, "uncut-telemetry-app-token");
  const env = telemetryToken(" env-secret ", { code: 0, out: "kc-secret\n" });
  assert.equal(env.token, "env-secret");
  const kc = telemetryToken(undefined, { code: 0, out: "kc-secret\n" });
  assert.equal(kc.token, "kc-secret");
  assert.match(kc.line, /from the keychain \(uncut-telemetry-app-token\)/);
  for (const absent of [telemetryToken("", undefined), telemetryToken(undefined, { code: 44, out: "" }), telemetryToken("  ", { code: 0, out: "\n" })]) {
    assert.equal(absent.token, undefined);
    assert.match(absent.line, /inert/);
    assert.equal(absent.line.split("\n").length, 1, "one line");
  }
  for (const r of [env, kc]) assert.doesNotMatch(r.line, /secret/, "the token never printed");
  const script = readFileSync("apps/desktop/scripts/dist-signed.ts", "utf8");
  assert.match(script, /spawnSync\("security", \["find-generic-password", "-s", TELEMETRY_KEYCHAIN_SERVICE, "-w"\], \{ encoding: "utf8", stdio: \["ignore", "pipe", "ignore"\] \}\)/, "read piped, never on the terminal");
  // D266: --skip-build still stages the plugins from the repo (never a stale stage).
  assert.match(script, /if \(skipBuild\) \{[^]*stagePlugins\(undefined, join\(desktop, "stage\/plugins"\)\)[^]*\} else \{/);
  assert.match(script, /spawnSync\("pnpm", \["build"\], \{ stdio: "inherit", cwd: root, env: \{ \.\.\.process\.env, UNCUT_TELEMETRY_TOKEN: t\.token \?\? "" \} \}\)/, "only in the build's environment");
});

test("release.yml runs pnpm dist:signed with a temporary keychain and the notary profile in it", () => {
  const yml = readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(yml, /\n\s+run: pnpm dist:signed\n/);
  assert.match(yml, /xcrun notarytool store-credentials uncut-notary [^\n]*--keychain "\$KC"/);
  assert.match(yml, /UNCUT_NOTARY_KEYCHAIN=\$KC/);
  assert.match(yml, /UNCUT_NOTARY_PROFILE: uncut-notary/);
  assert.match(yml, /UNCUT_TELEMETRY_TOKEN: \$\{\{ secrets\.UNCUT_TELEMETRY_TOKEN \}\}/);
  assert.match(yml, /gh release create "\$GITHUB_REF_NAME" release\/\*\.dmg [^\n]*--draft/);
  assert.doesNotMatch(yml, /CSC_LINK|CSC_KEY_PASSWORD/, "electron-builder's own keychain would hide the identity from the script's checks");
});

// D288: the installer window. dist-signed.ts's makeDmg runs electron-builder's dmg target (dmgBuilderArgs)
// with electron-builder.yml's `dmg` block, so the staging is the app, the Applications link, the
// background (a retina pair), the window layout and the volume name and icon from there.
test("the DMG's installer window: background pair, icon layout, volume name, no Finder scripting", () => {
  const fromBuilder = createRequire(realpathSync("apps/desktop/node_modules/electron-builder/package.json"));
  const yaml = createRequire(realpathSync(fromBuilder.resolve("app-builder-lib")))("js-yaml") as { load: (s: string) => any };
  const dmg = yaml.load(readFileSync("apps/desktop/electron-builder.yml", "utf8")).dmg;
  assert.equal(dmg.title, "Uncut", "volume name");
  assert.equal(dmg.icon, undefined, "volume icon defaults to the app icon (mac.icon)");
  assert.equal(dmg.background, "build/background.png");
  assert.equal(dmg.backgroundColor, undefined, "electron-builder refuses both");
  assert.equal(dmg.iconSize, 128);
  const [app, link] = dmg.contents;
  assert.deepEqual({ x: app.x, y: app.y, type: app.type }, { ...DMG_ICONS.app, type: "file" }, "the app on the left, where the background expects it");
  assert.equal(app.path, undefined, "the app is the packaged (or --prepackaged) one");
  assert.deepEqual(link, { ...DMG_ICONS.applications, type: "link", path: "/Applications" }, "Applications on the right, same height");
  assert.equal(app.y, link.y);
  assert.ok(app.x < link.x);
  // The window takes the background's size: 1x and 2x PNGs (electron-builder joins them into a TIFF).
  const size = (file: string) => {
    const png = readFileSync(file);
    assert.equal(png.subarray(1, 4).toString(), "PNG", file);
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  };
  assert.deepEqual(size("apps/desktop/build/background.png"), DMG_WINDOW);
  assert.deepEqual(size("apps/desktop/build/background@2x.png"), { width: DMG_WINDOW.width * 2, height: DMG_WINDOW.height * 2 });
  // The light installer page: heading, footer, wordmark, DM Sans embedded; no label plates (labels are black on light).
  const svg = backgroundSvg("AAAA");
  assert.equal(DMG_HEADING, "Drag Uncut into Applications.");
  assert.equal(DMG_FOOTER, "Once copied, open it from Applications.");
  for (const t of [DMG_HEADING, DMG_FOOTER, ">Uncut</text>", "data:font/woff2;base64,AAAA", `width="${DMG_WINDOW.width}" height="${DMG_WINDOW.height}"`]) assert.ok(svg.includes(t), t);
  const script = readFileSync("apps/desktop/scripts/dist-signed.ts", "utf8");
  assert.match(script, /dmgBuilderArgs\(app, out\)/, "makeDmg lays out the DMG with electron-builder");
  assert.doesNotMatch(script, /osascript|"Finder"|hdiutil", \["create"/, "no Finder scripting (hangs on CI) and no plain hdiutil DMG");
  assert.match(script, /makeDmg\(appPath, dmg\);\s*await notarize\(dmg, "the DMG", auth\);/, "the DMG notarized is the one laid out");
});
