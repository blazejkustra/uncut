// Bundles main + preload to CommonJS (the sandboxed preload must be CJS) and copies the
// built renderer next to them, so the packaged app is just this dist folder.
import { cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";

const dir = (p: string) => new URL(p, new URL("..", import.meta.url)).pathname;

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
  // The rasteriser's bundled fonts (D77) go in as data: URLs.
  loader: { ".woff2": "dataurl" },
  logLevel: "warning",
});

// The shader effects' WebGPU runner (D213) for the rasteriser's shader window: the preview's own
// code (apps/web/src/preview/shaderRunner.ts), bundled on its own as window.UncutShader.
await build({
  entryPoints: [dir("../web/src/preview/shaderRunner.ts")],
  outfile: dir("dist/shader-runner.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "UncutShader",
  target: "chrome140",
  logLevel: "warning",
});

const renderer = dir("../web/dist");
if (existsSync(renderer)) await cp(renderer, dir("dist/renderer"), { recursive: true });
else console.warn("apps/web/dist not built yet; only the dev server URL will work");

// D258: the plugins the app ships, laid out from plugins/bundled.json (bundled ones in plugins/, the
// rest in plugins/catalog/); electron-builder.yml's extraResources take stage/plugins.
const { stagePlugins } = await import("../../../scripts/plugin-bundle.ts");
const staged = stagePlugins(undefined, dir("stage/plugins"));
console.log(`plugins: ${staged.bundled.length} bundled, ${staged.catalog.length} in the catalog`);

// electron-builder copies Electron's and Chromium's licences from node_modules/electron/dist
// (electron-builder.yml extraResources) and skips a missing file without failing. The electron
// package (44+) has no install script: it downloads that folder the first time it's required. On a
// fresh checkout (CI, the release workflow) nothing has required it before `pnpm dist`, so the app
// shipped without the licences (#89). Requiring it here downloads it (from the cache when there).
const electronDir = dir("../../node_modules/electron");
createRequire(`${electronDir}/`)("electron");
for (const file of ["LICENSE", "LICENSES.chromium.html"]) {
  if (!existsSync(`${electronDir}/dist/${file}`)) throw new Error(`node_modules/electron/dist/${file} is missing: the app would ship without Electron's licences`);
}
