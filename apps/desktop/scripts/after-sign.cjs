// electron-builder afterSign hook: re-seal the outer app with a designated requirement pinned
// to the bundle id. An ad-hoc signature's identity is otherwise its cdhash, which changes on
// every build, and macOS keys privacy grants (screen recording, microphone) and Keychain items
// to it. Only the outer bundle is re-signed: Electron's frameworks keep their own signatures.
// A Developer ID signature replaces all this before capture ships.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const id = context.packager.appInfo.id;
  execFileSync("codesign", ["--force", "--sign", "-", "--requirements", `=designated => identifier "${id}"`, appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
};
