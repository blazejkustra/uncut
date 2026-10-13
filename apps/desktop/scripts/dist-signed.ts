// `pnpm dist:signed` (D114): builds, then packages the app signed with a keychain identity
// (UNCUT_SIGN_IDENTITY, else the first Developer ID Application or Apple Development one), the
// hardened runtime and build/signed.entitlements.plist, into dist/signed/mac-arm64/Uncut.app.
// codesign may ask for the keychain password the first time. Not notarized.
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseIdentities, pickIdentity, signedBuilderArgs } from "./signing.ts";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const listed = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
const identity = pickIdentity(parseIdentities(listed), process.env.UNCUT_SIGN_IDENTITY);
if ("problem" in identity) {
  console.error(identity.problem);
  process.exit(1);
}
console.log(`Signing with ${identity.name} (${identity.hash}), hardened runtime, not notarized.`);
const builder = join(desktop, "node_modules", ".bin", "electron-builder");
const run = spawnSync(builder, signedBuilderArgs(identity.hash), { cwd: desktop, stdio: "inherit" });
if (run.status !== 0) process.exit(run.status ?? 1);
console.log(`Signed app: ${resolve(desktop, "../../dist/signed/mac-arm64/Uncut.app")}`);
