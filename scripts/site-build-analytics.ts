// Builds the landing page's analytics script (D284): site/src/analytics.ts → site/assets/analytics.js,
// one minified ES module with no source map. Part of `pnpm site:build`. The output is committed:
// Cloudflare Pages serves site/ as static files (plus site/functions), with no build step there.
// `--outfile <path>` builds elsewhere (the tests use it).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = resolve(import.meta.dirname, "..");
const i = process.argv.indexOf("--outfile");
const OUT = i > 0 ? resolve(process.argv[i + 1]!) : join(ROOT, "site/assets/analytics.js");
const store = join(ROOT, "node_modules/.pnpm");
const esbuildDir = readdirSync(store).find((d) => /^esbuild@\d/.test(d));
const esbuild = esbuildDir && join(store, esbuildDir, "node_modules/esbuild/bin/esbuild");
if (!esbuild || !existsSync(esbuild)) throw new Error("esbuild isn't in node_modules/.pnpm (pnpm install)");

execFileSync(esbuild, [
  join(ROOT, "site/src/analytics.ts"),
  "--bundle", "--format=esm", "--minify", "--target=es2022",
  "--legal-comments=none", "--charset=utf8", "--log-level=warning", `--outfile=${OUT}`,
], { stdio: ["ignore", "inherit", "inherit"], cwd: ROOT });

const text = readFileSync(OUT, "utf8");
if (/\/Users\/|sourceMappingURL/.test(text)) throw new Error("analytics.js carries a local path or a source map link");
console.log(`${OUT.startsWith(ROOT) ? OUT.slice(ROOT.length + 1) : OUT}: ${(statSync(OUT).size / 1024).toFixed(1)} KB, ${(gzipSync(text).length / 1024).toFixed(1)} KB gzipped`);
