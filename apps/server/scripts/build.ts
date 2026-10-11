// Bundles the server into one ESM file so the packaged app doesn't ship node_modules for it.
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const root = new URL("..", import.meta.url);
const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

await build({
  entryPoints: [new URL("src/bin.ts", root).pathname],
  outfile: new URL("dist/server.mjs", root).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // The map is written next to the bundle for local debugging, but the bundle doesn't point at
  // it: the packaged app ships server.mjs alone.
  sourcemap: "external",
  // ws reaches for these optional native speedups inside try/catch; leave them unresolved.
  external: ["bufferutil", "utf-8-validate"],
  // Bundled CommonJS deps (ws, undici) call require() for node builtins.
  banner: { js: 'import { createRequire as __uncutCreateRequire } from "node:module"; const require = __uncutCreateRequire(import.meta.url);' },
  define: { __UNCUT_SERVER_VERSION__: JSON.stringify(version) },
  logLevel: "warning",
});
