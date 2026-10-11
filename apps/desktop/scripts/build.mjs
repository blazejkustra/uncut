// Bundles main + preload to CommonJS (the sandboxed preload must be CJS) and copies the
// built renderer next to them, so the packaged app is just this dist folder.
import { cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { build } from "esbuild";

const dir = (p) => new URL(p, new URL("..", import.meta.url)).pathname;

await rm(dir("dist"), { recursive: true, force: true });
await build({
  entryPoints: { main: dir("src/main.ts"), preload: dir("src/preload.ts") },
  outdir: dir("dist"),
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  logLevel: "warning",
});

const renderer = dir("../web/dist");
if (existsSync(renderer)) await cp(renderer, dir("dist/renderer"), { recursive: true });
else console.warn("apps/web/dist not built yet; only the dev server URL will work");
