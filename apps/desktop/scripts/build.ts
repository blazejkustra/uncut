// Bundles main + preload to CommonJS (the sandboxed preload must be CJS) and copies the
// built renderer next to them, so the packaged app is just this dist folder.
import { cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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
