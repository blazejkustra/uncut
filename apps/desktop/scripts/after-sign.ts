// electron-builder afterSign hook. The default `pnpm dist` is ad-hoc signed: re-seal the outer app
// with a designated requirement pinned to the bundle id. An ad-hoc signature's identity is
// otherwise its cdhash, which changes on every build, and macOS keys privacy grants (screen
// recording, microphone, camera) and Keychain items to it. Only the outer bundle is re-signed:
// Electron's frameworks keep their own signatures.
// `pnpm dist:signed` (D114) signs with a real identity, whose designated requirement is already
// stable (its team and bundle id): re-signing ad-hoc would throw that signature away, so there the
// hook only verifies it.
// electron-builder require()s the hook; Node strips the types and hands it this module's default.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { AfterPackContext } from "electron-builder";

export default async function afterSign(context: AfterPackContext) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const id = context.packager.appInfo.id;
  const identity = (context.packager.config.mac as { identity?: unknown } | null | undefined)?.identity;
  const adHoc = identity === undefined || identity === null || identity === "-";
  if (adHoc) execFileSync("codesign", ["--force", "--sign", "-", "--requirements", `=designated => identifier "${id}"`, appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
}
