// Builds uncut.video (pnpm site:build): `next build` in site/ writes the static export to site/out/,
// then this writes site/out/_headers from the site/_headers template. Next's export carries a few
// inline scripts (its bootstrap and each page's flight data); rather than allow 'unsafe-inline',
// every one is hashed (sha256) into the CSP of the page it's on. The template's `/*` CSP gets the
// 404 page's hashes (Cloudflare serves 404.html under any unknown path); each page gets its own rule
// that detaches that one and sets a CSP with its own hashes, so no line grows with the number of
// pages (Cloudflare caps a _headers line at 2,000 characters and a file at 100 rules).
// Deploy from site/ (wrangler takes ./functions from the folder it runs in): see site/DEPLOY.txt.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const SITE = resolve(import.meta.dirname, "../site");
const OUT = join(SITE, "out");
const NEXT = join(SITE, "node_modules/next/dist/bin/next");

execFileSync(process.execPath, [NEXT, "build"], { cwd: SITE, stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });

const files = (readdirSync(OUT, { recursive: true }) as Array<string>).map((f) => join(OUT, f));
const html = files.filter((f) => f.endsWith(".html"));

/** 'sha256-…' for each inline script a browser runs (not data blocks like application/ld+json). */
function inlineScriptHashes(page: string): Array<string> {
  const hashes = new Set<string>();
  for (const m of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1]!;
    if (/\bsrc=/i.test(attrs)) continue;
    const type = attrs.match(/\btype=["']?([^"'\s>]+)/i)?.[1]?.toLowerCase();
    if (type && !["module", "text/javascript", "application/javascript"].includes(type)) continue;
    hashes.add(`'sha256-${createHash("sha256").update(m[2]!, "utf8").digest("base64")}'`);
  }
  return [...hashes];
}

// Inline styles would need 'unsafe-inline' in style-src: there must be none.
for (const f of html) {
  const page = readFileSync(f, "utf8");
  if (/<style\b|\sstyle=/i.test(page)) throw new Error(`${relative(SITE, f)} has an inline style; the CSP (style-src 'self') would block it`);
  if (/\/Users\/|sourceMappingURL/.test(page)) throw new Error(`${relative(SITE, f)} carries a local path or a source map link`);
}
for (const f of files.filter((f) => f.endsWith(".js"))) {
  const text = readFileSync(f, "utf8");
  if (/\/Users\/|sourceMappingURL/.test(text)) throw new Error(`${relative(SITE, f)} carries a local path or a source map link`);
  if (/typegpu|tgpu\.resolve/i.test(text)) throw new Error(`${relative(SITE, f)} ships TypeGPU; only its WGSL should reach the browser`);
}

const template = readFileSync(join(SITE, "_headers"), "utf8");
const CSP_LINE = /^(\s*Content-Security-Policy: .*script-src [^;]*)(;.*)$/m;
const base = template.match(CSP_LINE);
if (!base) throw new Error("site/_headers needs a Content-Security-Policy line with a script-src");
const csp = (hashes: Array<string>) => `${base[1]}${hashes.map((h) => ` ${h}`).join("")}${base[2]}`.trim();

const notFound = inlineScriptHashes(readFileSync(join(OUT, "404.html"), "utf8"));
const rules: Array<string> = [];
for (const f of html.sort()) {
  const rel = relative(OUT, f).split("\\").join("/");
  // Pages are served at their folder (/privacy/); 404.html and Next's _not-found copies aren't pages.
  if (!rel.endsWith("index.html") || rel.startsWith("_not-found/") || rel.startsWith("404/")) continue;
  const path = `/${rel.slice(0, -"index.html".length)}`;
  rules.push(`${path}\n  ! Content-Security-Policy\n  ${csp(inlineScriptHashes(readFileSync(f, "utf8")))}`);
}
const headers = `${template.replace(CSP_LINE, (_l, a: string, b: string) => `${a}${notFound.map((h) => ` ${h}`).join("")}${b}`).trimEnd()}

# Each page's own CSP: the hashes of its inline scripts (written by scripts/site-build.ts).
${rules.join("\n\n")}
`;
const long = headers.split("\n").filter((l) => l.length > 2000);
if (long.length) throw new Error(`_headers has a line over Cloudflare's 2,000 characters: ${long[0]!.slice(0, 80)}…`);
const ruleCount = headers.split("\n").filter((l) => /^\//.test(l)).length;
if (ruleCount > 100) throw new Error(`_headers has ${ruleCount} rules; Cloudflare allows 100`);
writeFileSync(join(OUT, "_headers"), headers);

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const home = readFileSync(join(OUT, "index.html"), "utf8");
const homeJs = [...home.matchAll(/<script src="([^"]+)"(?![^>]*noModule)/g)].map((m) => m[1]!);
const sizes = homeJs.map((src) => readFileSync(join(OUT, src)));
const gpu = files.find((f) => f.endsWith(".js") && readFileSync(f, "utf8").includes("createShaderModule"));
console.log(`site/out: ${html.length} pages, ${ruleCount} header rules`);
console.log(`home page JS: ${homeJs.length} files, ${kb(sizes.reduce((a, b) => a + b.length, 0))}, ${kb(sizes.reduce((a, b) => a + gzipSync(b).length, 0))} gzipped`);
if (!gpu || !readFileSync(gpu, "utf8").includes("@vertex")) throw new Error("the hero's WebGPU chunk or its WGSL is missing");
console.log(`hero WebGPU chunk: ${kb(statSync(gpu).size)}, ${kb(gzipSync(readFileSync(gpu)).length)} gzipped`);
