// Builds the landing page's script (pnpm site:build): site/src/hero.ts → site/assets/hero.js, one
// minified ES module, no source map, no licence banners. The hero background's shaders are written
// with TypeGPU (site/src/heroShaders.ts); they're resolved to WGSL here, in Node, and injected as
// __HERO__, so the browser gets plain WebGPU and no TypeGPU runtime. The output is committed:
// Cloudflare Pages serves site/ as static files, with no build step there.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { heroWgsl } from "../site/src/heroShaders.ts";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "site/assets");
const store = join(ROOT, "node_modules/.pnpm");
const esbuildDir = readdirSync(store).find((d) => /^esbuild@\d/.test(d));
const esbuild = esbuildDir && join(store, esbuildDir, "node_modules/esbuild/bin/esbuild");
if (!esbuild || !existsSync(esbuild)) throw new Error("esbuild isn't in node_modules/.pnpm (pnpm install)");

// Drop the outputs of earlier layouts of this build (hashed chunks), so nothing stale is served.
for (const f of readdirSync(OUT)) if (/^hero(-gpu-[\w-]+)?\.js$/.test(f)) rmSync(join(OUT, f));

const hero = heroWgsl();
execFileSync(esbuild, [
  join(ROOT, "site/src/hero.ts"),
  "--bundle", "--format=esm", "--minify", "--target=es2022",
  "--legal-comments=none", "--charset=utf8", "--log-level=warning",
  `--define:__HERO__=${JSON.stringify(hero)}`,
  `--outfile=${join(OUT, "hero.js")}`,
], { stdio: ["ignore", "inherit", "inherit"], cwd: ROOT });

const text = readFileSync(join(OUT, "hero.js"), "utf8");
if (/\/Users\/|swmansion\.com|sourceMappingURL|typegpu/i.test(text)) throw new Error("hero.js carries a local path, a banner URL, a source map link or TypeGPU's runtime");
console.log(`site/assets/hero.js: ${(statSync(join(OUT, "hero.js")).size / 1024).toFixed(1)} KB, ${(gzipSync(text).length / 1024).toFixed(1)} KB gzipped`);
