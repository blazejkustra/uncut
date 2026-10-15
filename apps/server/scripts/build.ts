// Bundles the server into one ESM file so the packaged app doesn't ship node_modules for it.
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const root = new URL("..", import.meta.url);
const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

await build({
  entryPoints: [new URL("src/app/bin.ts", root).pathname],
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
  // Telemetry's app token (issue #13, D223): the CI secret, empty in dev builds (telemetry then stays inert).
  define: { __UNCUT_SERVER_VERSION__: JSON.stringify(version), __UNCUT_TELEMETRY_TOKEN__: JSON.stringify(process.env.UNCUT_TELEMETRY_TOKEN ?? "") },
  logLevel: "warning",
});

// The agent's MCP server (D40): a separate small entry, shipped next to server.mjs, which the
// server finds as ./mcp.mjs and claude starts per turn.
await build({
  entryPoints: [new URL("src/agent/mcp.ts", root).pathname],
  outfile: new URL("dist/mcp.mjs", root).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
});
