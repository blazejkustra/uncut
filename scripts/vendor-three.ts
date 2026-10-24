// Vendors three.js into assets/graphic-libs/three.js (D193): graphics write
// <script src="uncut:lib/three.js"></script> and get window.THREE, inlined into their document (no
// network in the preview or the export). Run once per upgrade, offline, from a local copy:
//   node scripts/vendor-three.ts <path to node_modules/three>
// It wraps build/three.cjs (one CommonJS file, no requires) so it defines window.THREE, minifies
// it with the workspace's esbuild keeping the @license header (the inlined document must stay
// under Chromium's 2 MB data: URL limit in the export), and copies three's LICENSE next to it.
// THIRD_PARTY_NOTICES lists it (scripts/notices.ts reads the version from the file's header).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "assets/graphic-libs");
const from = process.argv[2];
if (!from) throw new Error("usage: node scripts/vendor-three.ts <path to node_modules/three>");

const pkg = JSON.parse(readFileSync(join(from, "package.json"), "utf8")) as { version: string; license: string };
if (pkg.license !== "MIT") throw new Error(`three is ${pkg.license}, expected MIT`);
const source = readFileSync(join(from, "build/three.cjs"), "utf8");
if (/\brequire\(/.test(source)) throw new Error("three.cjs requires other files");
if (/<\/script|<!--/i.test(source)) throw new Error("three.cjs holds </script or <!--, which an inline script can't");

const store = join(ROOT, "node_modules/.pnpm");
const esbuildDir = readdirSync(store).find((d) => /^esbuild@\d/.test(d));
const esbuild = esbuildDir && join(store, esbuildDir, "node_modules/esbuild/bin/esbuild");
if (!esbuild || !existsSync(esbuild)) throw new Error("esbuild isn't in node_modules/.pnpm (pnpm install)");

const wrapped = `(function(){var module={exports:{}},exports=module.exports;\n${source}\n;window.THREE=module.exports;})();\n`;
const tmp = mkdtempSync(join(tmpdir(), "uncut-three-"));
let minified: string;
try {
  writeFileSync(join(tmp, "in.js"), wrapped);
  execFileSync(
    esbuild,
    [join(tmp, "in.js"), `--outfile=${join(tmp, "out.js")}`, "--minify", "--legal-comments=inline", "--target=es2020", "--log-level=warning"],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  minified = readFileSync(join(tmp, "out.js"), "utf8");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const header = `/* three.js ${pkg.version} (MIT, https://threejs.org), vendored by scripts/vendor-three.ts from build/three.cjs; defines window.THREE. Licence: three.LICENSE.txt */\n`;
writeFileSync(join(OUT, "three.js"), header + minified);
copyFileSync(join(from, "LICENSE"), join(OUT, "three.LICENSE.txt"));
console.log(`three.js ${pkg.version}: ${(header + minified).length} bytes`);
