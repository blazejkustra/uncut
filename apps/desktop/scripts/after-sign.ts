// electron-builder afterSign hook: re-seal the outer app with a designated requirement pinned
// to the bundle id. An ad-hoc signature's identity is otherwise its cdhash, which changes on
// every build, and macOS keys privacy grants (screen recording, microphone) and Keychain items
// to it. Only the outer bundle is re-signed: Electron's frameworks keep their own signatures.
// A Developer ID signature replaces all this before capture ships.
// electron-builder require()s the hook; Node strips the types and hands it this module's default.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { AfterPackContext } from "electron-builder";

export default async function afterSign(context: AfterPackContext) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const id = context.packager.appInfo.id;
  execFileSync("codesign", ["--force", "--sign", "-", "--requirements", `=designated => identifier "${id}"`, appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
}
