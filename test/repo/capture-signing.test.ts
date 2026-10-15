// D114: recording on this Mac needs macOS's permissions, so the build carries the usage strings and
// an opt-in signed build (pnpm dist:signed) has the hardened runtime and the entitlements. The
// default pnpm dist stays ad-hoc exactly as before (the packaged-app tests run that build). Tests
// never reach macOS's prompts, the real devices or desktopCapturer: the desktop's test media mode
// is checked here without opening a window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { isAdHoc, parseIdentities, pickIdentity, SIGNED_ENTITLEMENTS, SIGNED_OUTPUT, signedBuilderArgs } from "../../apps/desktop/scripts/signing.ts";
import { privacySettingsUrl, TEST_MEDIA_SWITCHES, testMedia } from "../../apps/desktop/src/background.ts";

const read = (p: string) => readFileSync(p, "utf8");

test("the signed build's entitlements: microphone, camera and what Electron needs under the hardened runtime", () => {
  const plist = read(`apps/desktop/${SIGNED_ENTITLEMENTS}`);
  for (const key of ["com.apple.security.device.audio-input", "com.apple.security.device.camera", "com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory", "com.apple.security.cs.disable-library-validation"]) {
    assert.match(plist, new RegExp(`<key>${key.replace(/\./g, "\\.")}</key>\\s*<true/>`), key);
  }
  assert.doesNotMatch(plist, /app-sandbox/, "not sandboxed (the server and plugins spawn tools)");
  // electron-builder picks these names up by itself, which would change the default ad-hoc build.
  assert.equal(existsSync("apps/desktop/build/entitlements.mac.plist"), false);
  assert.equal(existsSync("apps/desktop/build/entitlements.mac.inherit.plist"), false);
});

test("Info.plist gets the microphone and camera usage strings; the default build stays ad-hoc without the hardened runtime", () => {
  const yml = read("apps/desktop/electron-builder.yml");
  assert.match(yml, /\n  extendInfo:\n    NSMicrophoneUsageDescription: Uncut [^\n]+\.\n    NSCameraUsageDescription: Uncut [^\n]+\.\n/);
  assert.match(yml, /\n  identity: "-"\n/);
  assert.match(yml, /\n  hardenedRuntime: false\n/);
  assert.doesNotMatch(yml, /^\s*entitlements(Inherit)?:/m, "the default build has no entitlements");
  assert.match(yml, /\nafterSign: scripts\/after-sign\.ts\n/);
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.dist, "pnpm build && pnpm --filter @uncut/desktop dist");
  assert.equal(pkg.scripts["dist:signed"], "pnpm build && node apps/desktop/scripts/dist-signed.ts");
  assert.equal((JSON.parse(read("apps/desktop/package.json")) as { scripts: Record<string, string> }).scripts.dist, "electron-builder --config electron-builder.yml");
});

test("after-sign re-seals an ad-hoc build with a pinned requirement and only verifies a real signature", () => {
  const hook = read("apps/desktop/scripts/after-sign.ts");
  assert.match(hook, /const adHoc = identity === undefined \|\| identity === null \|\| identity === "-";/);
  assert.match(hook, /if \(adHoc\) execFileSync\("codesign", \["--force", "--sign", "-", "--requirements"/);
  assert.match(hook, /execFileSync\("codesign", \["--verify", "--deep", "--strict", appPath\]/);
  assert.equal(isAdHoc("-"), true);
  assert.equal(isAdHoc(undefined), true);
  assert.equal(isAdHoc("F2408C1CFA9A417EB02DD28221AF86A3FEA5E75C"), false);
});

test("dist:signed picks a keychain identity and passes the hardened runtime, entitlements, no timestamp and its own output folder", () => {
  const listed = `  1) F2408C1CFA9A417EB02DD28221AF86A3FEA5E75C "Apple Development: Jane Doe (ABCDE12345)"
  2) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Jane Doe (ABCDE12345)"
     2 valid identities found`;
  const ids = parseIdentities(listed);
  assert.equal(ids.length, 2);
  assert.deepEqual(pickIdentity(ids), ids[1], "Developer ID first");
  assert.deepEqual(pickIdentity([ids[0]!]), ids[0], "else Apple Development");
  assert.deepEqual(pickIdentity(ids, "Apple Development: Jane Doe (ABCDE12345)"), ids[0]);
  assert.deepEqual(pickIdentity(ids, "f2408c1cfa9a417eb02dd28221af86a3fea5e75c"), ids[0], "by SHA-1");
  assert.match((pickIdentity(ids, "Nobody") as { problem: string }).problem, /No signing identity "Nobody"/);
  assert.match((pickIdentity([]) as { problem: string }).problem, /UNCUT_SIGN_IDENTITY/);
  const args = signedBuilderArgs("F2408C1CFA9A417EB02DD28221AF86A3FEA5E75C");
  assert.deepEqual(args.slice(0, 5), ["--config", "electron-builder.yml", "--mac", "dir", "--arm64"]);
  for (const a of ["-c.mac.identity=F2408C1CFA9A417EB02DD28221AF86A3FEA5E75C", "-c.mac.hardenedRuntime=true", `-c.mac.entitlements=${SIGNED_ENTITLEMENTS}`, `-c.mac.entitlementsInherit=${SIGNED_ENTITLEMENTS}`, "-c.mac.timestamp=none", `-c.directories.output=${SIGNED_OUTPUT}`]) assert.ok(args.includes(a), a);
  assert.equal(SIGNED_OUTPUT, "../../dist/signed", "never over dist/mac-arm64, the ad-hoc build the tests use");
});

test("test media: only with UNCUT_CDP, fake devices, states from the test (granted unless given), never macOS", () => {
  assert.equal(testMedia({ UNCUT_TEST_MEDIA: "fake" }), undefined, "a stray variable can't change a release user's app");
  assert.equal(testMedia({ UNCUT_CDP: "9222" }), undefined);
  assert.deepEqual(testMedia({ UNCUT_CDP: "9222", UNCUT_TEST_MEDIA: "fake" })?.access, { microphone: "granted", camera: "granted", screen: "granted" });
  assert.deepEqual(testMedia({ UNCUT_CDP: "9222", UNCUT_TEST_MEDIA: "fake", UNCUT_TEST_MEDIA_ACCESS: '{"microphone":"denied","screen":"not-determined","camera":"bogus"}' })?.access, { microphone: "denied", camera: "granted", screen: "not-determined" });
  assert.deepEqual(testMedia({ UNCUT_CDP: "9222", UNCUT_TEST_MEDIA: "fake", UNCUT_TEST_MEDIA_ACCESS: "not json" })?.access, { microphone: "granted", camera: "granted", screen: "granted" });
  assert.deepEqual([...TEST_MEDIA_SWITCHES], ["use-fake-device-for-media-stream", "use-fake-ui-for-media-stream"]);
  assert.equal(privacySettingsUrl("microphone"), "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
  assert.equal(privacySettingsUrl("screen"), "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  assert.match(read("test/helpers/app.ts"), /UNCUT_TEST_MEDIA: "fake", \.\.\.extra, UNCUT_CDP: String\(port\)/, "every launched test app uses test media");
});

test("the desktop shell asks macOS, lists screens and opens System Settings only outside test media", () => {
  // app.ts and the module its media-access functions moved to (#54).
  const app = [read("apps/desktop/src/app.ts"), read("apps/desktop/src/app/mediaAccess.ts")].join("\n");
  // Each real call sits after a test-media early return in its function.
  const body = (name: string) => {
    const start = app.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    return app.slice(start, app.indexOf("\n}\n", start));
  };
  for (const [fn, real] of [["mediaAccess", "getMediaAccessStatus"], ["askMediaAccess", "askForMediaAccess"], ["captureSources", "desktopCapturer.getSources"]] as const) {
    const b = body(fn);
    assert.ok(b.indexOf("if (mediaTest)") >= 0 && b.indexOf("if (mediaTest)") < b.indexOf(real), `${fn}: test media returns before ${real}`);
  }
  assert.match(app, /if \(mediaTest\) console\.log\(`\[test\] open \$\{url\}`\);\n\s*else void shell\.openExternal\(url\);/);
  assert.match(app, /if \(!wanted \|\| mediaTest \|\| !frame \|\| !fromAppFrame\(frame\)\) return callback\(\{\}\);/, "getDisplayMedia never records in tests");
  assert.equal(app.match(/systemPreferences\.askForMediaAccess/g)?.length, 1);
  assert.equal(app.match(/desktopCapturer\s*\.getSources/g)?.length, 2, "the list and the display-media handler");
});
