// Lays out the headless server the way Uncut.app's Resources does (apps/desktop/electron-builder.yml),
// so config.ts finds everything beside server.mjs. Needs the server and desktop builds. The media core
// goes in bin/: the Dockerfile copies its own, anything else passes --media <file>.
import { chmodSync, copyFileSync, cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));

const FOLDERS = [
  { from: "assets/fonts", to: "fonts", keep: /\.woff2$|^OFL\.txt$/ },
  { from: "assets/sfx", to: "sfx", keep: /\.m4a$|^library\.json$/ },
  { from: "assets/graphic-libs", to: "graphic-libs", keep: /\.js$|\.LICENSE\.txt$/ },
  { from: "spec/modules/builtin", to: "modules/builtin", keep: /\.json$/ },
  { from: "packages/plugin-sdk/src", to: "plugin-sdk", keep: /\.ts$/ },
];

const FILES = [
  { from: "apps/server/dist/server.mjs", to: "server/server.mjs" },
  { from: "apps/server/dist/mcp.mjs", to: "server/mcp.mjs" },
  { from: "apps/desktop/dist/main.cjs", to: "render/main.cjs" },
  { from: "apps/desktop/dist/shader-runner.js", to: "render/shader-runner.js" },
  { from: "LICENSE", to: "LICENSE" },
  { from: "THIRD_PARTY_NOTICES", to: "THIRD_PARTY_NOTICES" },
  { from: "infra/server/uncut-server", to: "uncut-server" },
];

function copyInto(out: string, from: string, to: string) {
  const target = join(out, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(from, target);
}

export function packageServer(out: string, media?: string) {
  rmSync(out, { recursive: true, force: true });
  for (const { from, to } of FILES) copyInto(out, join(repo, from), to);
  for (const { from, to, keep } of FOLDERS) {
    for (const name of readdirSync(join(repo, from)).filter((n) => keep.test(n))) copyInto(out, join(repo, from, name), join(to, name));
  }
  cpSync(join(repo, "apps/desktop/stage/plugins"), join(out, "plugins"), { recursive: true });
  writeFileSync(join(out, "package.json"), `${JSON.stringify({ name: "uncut-server", private: true, type: "module" })}\n`);
  chmodSync(join(out, "uncut-server"), 0o755);
  if (media) copyInto(out, media, "bin/uncut-media");
}

if (import.meta.main) {
  const [out, flag, media] = process.argv.slice(2);
  if (!out || (flag && flag !== "--media")) {
    console.error("node scripts/server-package.ts <out folder> [--media <uncut-media binary>]");
    process.exit(2);
  }
  packageServer(resolve(out), media && resolve(media));
}
