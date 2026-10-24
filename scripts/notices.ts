// Writes THIRD_PARTY_NOTICES (plain text, D112; derived from the bundles since #103, D278): what
// Uncut ships that others made, and what it relies on but doesn't ship.
//   node scripts/notices.ts           write THIRD_PARTY_NOTICES
//   node scripts/notices.ts --check   exit 1 if the file is out of date, or a shipped npm package
//                                     has a copyleft (GPL, AGPL, LGPL) or unknown licence
// npm: exactly the packages that end up in the app's bundles. Each bundle the build makes (the
// server and its MCP entry, the desktop's main and preload, the shader runner, the editor) is
// bundled again here in memory with esbuild's metafile, and every node_modules input names a
// package, devDependencies included when they are bundled (electron-updater and its deps); plus
// the plugin SDK's runtime dependencies (shipped as source). Each package's licence file (and its
// NOTICE, as Apache 2.0 asks) is copied in full, identical texts once. Rust: the crates in
// native/media/Cargo.lock, licences from the local cargo registry when it's there. Sound effects
// from assets/sfx/library.json; fonts from assets/fonts/OFL.txt; three.js from assets/graphic-libs
// (D193). No author fields (they carry email addresses).
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "THIRD_PARTY_NOTICES");
type Pkg = { name: string; version: string; license: string; repository: string; dir: string };

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

const licenceOf = (json: Record<string, unknown>): string => {
  const l = json.license ?? json.licenses;
  if (typeof l === "string") return l;
  if (Array.isArray(l)) return l.map((x) => (typeof x === "string" ? x : String((x as { type?: string }).type))).join(" OR ");
  if (l && typeof l === "object" && "type" in l) return String((l as { type: unknown }).type);
  return "UNKNOWN";
};

const repositoryOf = (json: Record<string, unknown>): string => {
  const r = json.repository;
  const url = typeof r === "string" ? r : r && typeof r === "object" && "url" in r ? String((r as { url: unknown }).url) : "";
  return url
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^github:/, "https://github.com/");
};

/** Node's lookup: <dir>/node_modules/<name>, then each parent's. */
function findPackage(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    if (dirname(dir) === dir) return undefined;
  }
}

type Build = { build: (options: Record<string, unknown>) => Promise<{ metafile?: { inputs: Record<string, unknown> } }> };
/** The desktop's esbuild (the one the build uses). */
const esbuild = () => createRequire(join(ROOT, "apps/desktop/package.json"))("esbuild") as Build;
const at = (p: string) => join(ROOT, p);
/** Vite's `?inline`, `?url` and `?worker&url` imports: the file itself (code is followed, assets are not packages). */
const viteQueries = {
  name: "vite-queries",
  setup(b: { onResolve: Function; onLoad: Function }) {
    b.onResolve({ filter: /\?/ }, (a: { path: string; resolveDir: string }) => ({
      path: resolve(a.resolveDir, a.path.replace(/\?.*$/, "")),
      namespace: "query",
    }));
    b.onLoad({ filter: /.*/, namespace: "query" }, (a: { path: string }) => ({
      contents: `${/\.[cm]?[jt]sx?$/.test(a.path) ? `import ${JSON.stringify(a.path)};` : ""}export default "";`,
      loader: "js",
      resolveDir: ROOT,
    }));
  },
};

/** The bundles the build makes (apps/server/scripts/build.ts, apps/desktop/scripts/build.ts, apps/web's vite build), as esbuild metafiles. */
async function bundledInputs(): Promise<Array<string>> {
  const { build } = esbuild();
  const common = { bundle: true, write: false, metafile: true, outdir: join(ROOT, "dist-notices"), logLevel: "silent", absWorkingDir: ROOT };
  const results = await Promise.all([
    build({
      ...common,
      entryPoints: [at("apps/server/src/app/bin.ts"), at("apps/server/src/agent/mcp.ts")],
      platform: "node",
      format: "esm",
      external: ["bufferutil", "utf-8-validate"],
    }),
    build({
      ...common,
      entryPoints: { main: at("apps/desktop/src/main.ts"), preload: at("apps/desktop/src/preload.ts") },
      platform: "node",
      format: "cjs",
      external: ["electron"],
      loader: { ".woff2": "dataurl" },
    }),
    build({ ...common, entryPoints: [at("apps/web/src/preview/shaderRunner.ts")], platform: "browser", format: "iife" }),
    build({
      ...common,
      entryPoints: [at("apps/web/src/main.tsx")],
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      loader: { ".woff2": "dataurl", ".svg": "file", ".png": "file" },
      plugins: [viteQueries],
    }),
  ]);
  return results.flatMap((r) => Object.keys(r.metafile?.inputs ?? {}));
}

const pkgAt = (dir: string): Pkg => {
  const json = readJson(join(dir, "package.json"));
  return { name: String(json.name), version: String(json.version), license: licenceOf(json), repository: repositoryOf(json), dir };
};

/** The package directory an input file belongs to: the path up to its last node_modules/<name>. */
export function packageDirOf(input: string): string | undefined {
  const i = input.lastIndexOf("node_modules/");
  if (i < 0) return undefined;
  const rest = input.slice(i + "node_modules/".length).split("/");
  const name = rest[0]!.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]!;
  return resolve(ROOT, input.slice(0, i) + "node_modules/" + name);
}

/** The npm packages in the app: what the bundles contain, and the plugin SDK's runtime dependencies. */
export async function npmPackages(): Promise<Array<Pkg>> {
  const seen = new Map<string, Pkg>();
  const add = (dir: string) => {
    const p = pkgAt(realpathSync(dir));
    if (!p.name.startsWith("@uncut/")) seen.set(`${p.name}@${p.version}`, p);
  };
  for (const input of await bundledInputs()) {
    const dir = packageDirOf(input);
    if (dir && existsSync(join(dir, "package.json"))) add(dir);
  }
  // The plugin SDK ships as source (Resources/plugin-sdk) and plugins import it at runtime.
  const walk = (from: string, deps: Record<string, string>) => {
    for (const name of Object.keys(deps)) {
      const found = findPackage(name, from);
      if (!found) throw new Error(`${name} (needed by ${from}) isn't in node_modules: run pnpm install`);
      const json = readJson(join(found, "package.json"));
      if (seen.has(`${String(json.name)}@${String(json.version)}`)) continue;
      add(found);
      walk(found, (json.dependencies ?? {}) as Record<string, string>);
    }
  };
  walk(at("packages/plugin-sdk"), (readJson(at("packages/plugin-sdk/package.json")).dependencies ?? {}) as Record<string, string>);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;
/** A package's licence and NOTICE files, each as [file name, text]. */
export function licenceFiles(dir: string): Array<[string, string]> {
  return readdirSync(dir)
    .filter((f) => LICENCE_FILE.test(f))
    .sort((a, b) => Number(/^notice/i.test(a)) - Number(/^notice/i.test(b)) || a.localeCompare(b))
    .map((f) => [f, readFileSync(join(dir, f), "utf8").replace(/\r\n?/g, "\n").trimEnd()] as [string, string])
    .filter(([, text]) => text.length > 0);
}

/** Licences that would put conditions on Uncut's own code or that nobody stated. */
export const isConcerning = (licence: string) =>
  /GPL|UNKNOWN|UNLICENSED|SEE LICENSE/i.test(licence) && !/\bOR\b.*\b(MIT|Apache|BSD|ISC)\b|\b(MIT|Apache|BSD|ISC)\b.*\bOR\b/i.test(licence);

type Crate = { name: string; version: string; license: string; buildOnly: boolean; dir?: string };
/** Procedural-macro crates run while compiling and leave no code in the binary. */
const BUILD_ONLY = new Set(["proc-macro2", "quote", "syn", "serde_derive", "unicode-ident"]);

export function crates(): Array<Crate> {
  const lock = readFileSync(join(ROOT, "native/media/Cargo.lock"), "utf8");
  const registry = join(homedir(), ".cargo/registry/src");
  const indexes = existsSync(registry) ? readdirSync(registry).map((d) => join(registry, d)) : [];
  const out: Array<Crate> = [];
  for (const block of lock.split("[[package]]").slice(1)) {
    const name = /name = "([^"]+)"/.exec(block)?.[1];
    const version = /version = "([^"]+)"/.exec(block)?.[1];
    if (!name || !version || name === "uncut-media") continue;
    let license = "see crates.io";
    let dir: string | undefined;
    for (const index of indexes) {
      const toml = join(index, `${name}-${version}`, "Cargo.toml");
      if (!existsSync(toml)) continue;
      const m = /^license\s*=\s*"([^"]+)"/m.exec(readFileSync(toml, "utf8"));
      if (m) license = m[1]!.replace(/\//g, " OR ");
      dir = dirname(toml);
      break;
    }
    out.push({ name, version, license, buildOnly: BUILD_ONLY.has(name), ...(dir ? { dir } : {}) });
  }
  return out;
}

const rule = "=".repeat(78);
const section = (title: string) => `\n${rule}\n${title}\n${rule}\n\n`;

const MIT_T3 =
  [
    "MIT License",
    "",
    "Copyright (c) 2026 T3 Tools Inc.",
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    'of this software and associated documentation files (the "Software"), to deal',
    "in the Software without restriction, including without limitation the rights",
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
    "copies of the Software, and to permit persons to whom the Software is",
    "furnished to do so, subject to the following conditions:",
    "",
    "The above copyright notice and this permission notice shall be included in all",
    "copies or substantial portions of the Software.",
    "",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
    "SOFTWARE.",
  ].join("\n") + "\n";

/** Files that port t3code's patterns (issue #103): each must still name t3code, so the list stays true. */
const T3CODE_PORTS: ReadonlyArray<readonly [string, string]> = [
  ["apps/server/src/agent/agentLimits.ts", "Claude Code's usage-limit, rate-limit and sign-in results in words (ClaudeAdapterV2)"],
  ["apps/server/src/app/ws.ts", "the WebSocket RPC endpoint's shape"],
  ["apps/server/src/app/shellEnv.ts", "reading the login shell's environment (DesktopShellEnvironment)"],
  ["apps/desktop/src/server.ts", "running the server as a child process (DesktopBackendManager)"],
];

export async function render(): Promise<string> {
  const electron = readJson(join(ROOT, "node_modules/electron/package.json"));
  const npm = await npmPackages();
  const rust = crates();
  let s = "";
  s += "Uncut: third-party notices\n\n";
  s += "Uncut itself is MIT licensed (see LICENSE). This file lists what the Uncut app ships that\n";
  s += "others made, and the programs it uses but doesn't ship. Generated by scripts/notices.ts;\n";
  s += "don't edit it by hand.\n";

  s += section("Fonts: DM Sans and DM Mono (SIL Open Font License 1.1)");
  s += "Shipped in the app (inlined in the editor and the renderer, licence in Resources/fonts/OFL.txt).\n\n";
  s += readFileSync(join(ROOT, "assets/fonts/OFL.txt"), "utf8").trimEnd() + "\n";

  const sfx = readJson(join(ROOT, "assets/sfx/library.json")) as {
    sounds: Array<{
      file: string;
      title: string;
      author: string;
      provider?: string;
      source: string;
      sourceFile?: string;
      license: string;
      licenseChecked?: string;
      licenseProof?: string;
      trimmed?: string;
    }>;
  };
  s += section("Sound effects (CC0 1.0, public domain)");
  s += "Shipped in Resources/sfx (D134, D208): sounds from Freesound (each sound's page links the CC0 1.0\n";
  s += "deed) and from Kenney's packs (kenney.nl; each pack's License.txt says Creative Commons Zero, CC0),\n";
  s += "checked when the pack was made by scripts/make-sfx.ts. Credit isn't required; thanks to every author.\n\n";
  // Uncut's own synthesised sounds (D250, provider "uncut") are Uncut's, not third-party: not listed.
  for (const t of sfx.sounds.filter((x) => x.provider !== "uncut")) {
    s += `${t.file}: "${t.title}" by ${t.author}\n  ${t.source}${t.sourceFile ? ` (${t.sourceFile} in the pack)` : ""}\n  ${t.license}${t.licenseChecked ? `, checked ${t.licenseChecked}` : ""}${t.trimmed ? `; ${t.trimmed}` : ""}\n`;
  }

  // Vendored graphic libraries (D193): three.js; Uncut's own (confetti, globe, spring, random) need no notice.
  const three = readFileSync(join(ROOT, "assets/graphic-libs/three.js"), "utf8").match(/^\/\* three\.js (\d+\.\d+\.\d+) \(MIT/)?.[1];
  if (!three) throw new Error("assets/graphic-libs/three.js has no vendoring header: run node scripts/vendor-three.ts");
  s += section("Graphic libraries: three.js (MIT)");
  s += `three.js ${three} (https://threejs.org), shipped in Resources/graphic-libs (minified, its licence in\n`;
  s += "three.LICENSE.txt beside it) and inlined into graphics that load it. Its licence:\n\n";
  s += readFileSync(join(ROOT, "assets/graphic-libs/three.LICENSE.txt"), "utf8").trimEnd() + "\n";

  // D275: the follow handle's brand marks.
  const icons = readFileSync(join(ROOT, "packages/core/src/visual/brandIcons.ts"), "utf8");
  const iconsVersion = icons.match(/simple-icons@(\d+\.\d+\.\d+)/)?.[1];
  if (!iconsVersion) throw new Error("packages/core/src/visual/brandIcons.ts doesn't name its simple-icons version");
  const brands = [...icons.matchAll(/title: "([^"]+)"/g)].map((m) => m[1]!);
  s += section("Brand icons: Simple Icons (CC0 1.0)");
  s += `The platform logos of the follow handle element (packages/core/src/visual/brandIcons.ts) are SVG\n`;
  s += `paths and brand colours from Simple Icons, simple-icons@${iconsVersion} (https://github.com/simple-icons/simple-icons),\n`;
  s += "released under CC0 1.0 Universal (public domain). As Simple Icons' disclaimer says, the logos\n";
  s += "remain trademarks of their owners; Uncut shows one only to name the platform a handle is on and\n";
  s += "isn't made by or affiliated with any of them. Included: " + brands.join(", ") + ".\n";
  s += "Each mark is drawn only in its brand's own colour or in plain white or black (D278).\n";
  s += "\nAll product names, logos and brands named in this file are trademarks of their respective owners.\n";
  s += "Uncut isn't made by, endorsed by or affiliated with any of them.\n";

  // Issue #103 (D278): t3code's code patterns that Uncut ports, and (while the files exist) its embedded marks.
  for (const [file] of T3CODE_PORTS)
    if (!readFileSync(join(ROOT, file), "utf8").includes("t3code"))
      throw new Error(`${file} no longer names t3code: update T3CODE_PORTS in scripts/notices.ts`);
  const providerMarks = join(ROOT, "apps/web/src/panels/composer/providerMarks.tsx");
  const t3Marks = existsSync(providerMarks) && /<path/.test(readFileSync(providerMarks, "utf8"));
  s += section("t3code (MIT)");
  s += "Parts of Uncut follow code from t3code (https://github.com/pingdotgg/t3code), adapted and\n";
  s += "rewritten in Uncut's own words:\n\n";
  for (const [file, what] of T3CODE_PORTS) s += `${file}: ${what}\n`;
  if (t3Marks) {
    s += "\nThe Claude and OpenAI marks in the model pickers (apps/web/src/panels/composer/providerMarks.tsx)\n";
    s += "are the SVGs t3code embeds (apps/web/src/components/Icons.tsx); they are trademarks of Anthropic\n";
    s += "and OpenAI, shown only to name who makes a model.\n";
  }
  s += "\nt3code's licence:\n\n" + MIT_T3;

  // Issue #63 (D234): the labs' marks in the Generate tab, while it has any.
  const marksFile = join(ROOT, "apps/web/src/panels/generate/marks.tsx");
  const marks = existsSync(marksFile) ? readFileSync(marksFile, "utf8") : "";
  const simpleSlugs = [...new Set([...marks.matchAll(/Simple Icons "([a-z0-9]+)"/g)].map((m) => m[1]!))];
  if (simpleSlugs.length) {
    s += section("Provider marks: Simple Icons (CC0 1.0)");
    s += "The Generate tab's model list (apps/web/src/panels/generate/marks.tsx) shows the labs' marks from\n";
    s += `Simple Icons ${iconsVersion} (https://simpleicons.org, icons ${simpleSlugs.join(", ")}), released under CC0 1.0\n`;
    s += "Universal (https://creativecommons.org/publicdomain/zero/1.0/). The marks remain trademarks of their\n";
    s += "respective owners, shown only to say who makes a model; Uncut isn't made by or affiliated with any of them.\n";
  }

  // D281: the tools' marks on the setup and Settings rows, and the plugins' own icons.
  const toolMarks = readFileSync(join(ROOT, "apps/web/src/onboarding/toolMarks.tsx"), "utf8");
  for (const needle of ['Simple Icons "ffmpeg"', "software-mansion/argent", "36aa14a"])
    if (!toolMarks.includes(needle)) throw new Error(`apps/web/src/onboarding/toolMarks.tsx no longer names ${needle}: update scripts/notices.ts`);
  const typegpuIcon = readFileSync(join(ROOT, "plugins/catalog/typegpu-effects/icon.svg"), "utf8");
  if (!typegpuIcon.includes("software-mansion/TypeGPU"))
    throw new Error("plugins/catalog/typegpu-effects/icon.svg no longer names its source: update scripts/notices.ts");
  s += section("Tool and plugin marks");
  s += "The setup wizard's and Settings' rows (apps/web/src/onboarding/toolMarks.tsx) and the plugins'\n";
  s += "icons (icon.svg in each plugin folder) are drawn in one colour, the row's text colour:\n\n";
  s += `FFmpeg: Simple Icons ${iconsVersion} (https://simpleicons.org, icon ffmpeg), CC0 1.0 Universal.\n`;
  s += "Argent: the mark from Argent's logo, https://github.com/software-mansion/argent,\n";
  s += "  packages/docs/static/img/logo.svg at commit 36aa14a, Apache License 2.0 (the repository's\n";
  s += "  licence, whose full text is among the npm packages' licence texts below); its outline is\n";
  s += "  drawn thicker. Also plugins/argent-capture/icon.svg.\n";
  s += "TypeGPU: its logomark, https://github.com/software-mansion/TypeGPU,\n";
  s += "  apps/typegpu-docs/public/typegpu-logomark-monodark.svg at commit 425afd3, MIT (the\n";
  s += "  repository's licence, Copyright (c) 2025 Software Mansion, the same text as the typegpu npm\n";
  s += "  package's below); in plugins/catalog/typegpu-effects/icon.svg.\n";
  s += "whisper.cpp has no logo of its own, so its row and the Whisper plugin show Uncut's own mark;\n";
  s += "the other plugin icons are Uncut's own drawings too.\n\n";
  s += "These marks are trademarks of their respective owners (FFmpeg of Fabrice Bellard, Argent and\n";
  s += "TypeGPU of Software Mansion), shown only to name the program a row or plugin is about. Uncut\n";
  s += "isn't made by, endorsed by or affiliated with any of them.\n";

  s += section("Electron and Chromium");
  s += `Uncut runs on Electron ${String(electron.version)} (MIT, https://github.com/electron/electron).\n`;
  s += "Electron includes Chromium, Node.js and their dependencies under their own licences (BSD-style\n";
  s += "for Chromium, MIT for Node.js, among others). Their full texts ship inside the app, in\n";
  s += "Uncut.app/Contents/Resources/licenses (LICENSE.electron.txt and LICENSES.chromium.html).\n";

  s += section("Not shipped: programs Uncut uses when they're installed");
  s += "ffmpeg and ffprobe: not bundled. The user installs them (for example brew install ffmpeg) and\n";
  s += "Uncut runs them as separate programs. Their licence (LGPL 2.1 or later, or GPL when built with\n";
  s += "GPL parts, as Homebrew's build is) applies to those programs, not to Uncut. https://ffmpeg.org\n\n";
  s += "whisper.cpp (whisper-cli): not bundled. The user installs it (brew install whisper-cpp); MIT,\n";
  s += "https://github.com/ggml-org/whisper.cpp. Speech models are not in the app or the repository:\n";
  s += "Uncut downloads the one the user picks from huggingface.co/ggerganov/whisper.cpp into its data\n";
  s += "folder and checks its SHA-256. The Whisper model weights are OpenAI's, released under MIT.\n\n";
  s += "Argent (the capture plugin's recorder): not bundled. The user installs it with npx\n";
  s += "@swmansion/argent; Uncut talks to it as a separate program.\n\n";
  s += "Claude Code (the agent): not bundled. Uncut runs the user's own claude command, with\n";
  s += "whatever sign-in it uses; its terms are Anthropic's.\n";

  s += section("npm packages shipped in the app");
  s += "Every package bundled into the app's code (the server, the desktop shell, the editor and the\n";
  s += "shader runner, found from the bundles themselves) and the plugin SDK's runtime dependencies.\n";
  s += "Their licence texts follow below.\n\n";
  for (const p of npm) s += `${p.name}@${p.version}: ${p.license}${p.repository ? `\n  ${p.repository}` : ""}\n`;

  // The full texts, each identical text once with the packages it covers.
  const texts = new Map<string, Array<string>>();
  const without: Array<string> = [];
  for (const p of npm) {
    const files = licenceFiles(p.dir);
    if (!files.length) without.push(`${p.name}@${p.version} (${p.license})`);
    for (const [file, text] of files) {
      const key = `${/^notice/i.test(file) ? "NOTICE" : "LICENSE"}\n${text}`;
      texts.set(key, [...(texts.get(key) ?? []), `${p.name}@${p.version}`]);
    }
  }
  s += section("Licence texts of the npm packages");
  for (const [key, names] of texts) {
    const [kind, ...body] = key.split("\n");
    s += `${"-".repeat(78)}\n${kind === "NOTICE" ? "NOTICE file of" : "Licence of"}: ${names.join(", ")}\n${"-".repeat(78)}\n\n${body.join("\n")}\n\n`;
  }
  if (without.length) s += `These packages ship no licence file; their package.json names the licence: ${without.join(", ")}.\n`;

  s += section("Rust crates in the media core (uncut-media)");
  for (const c of rust) s += `${c.name}@${c.version}: ${c.license}${c.buildOnly ? " (used while compiling only)" : ""}\n  https://crates.io/crates/${c.name}\n`;
  // The crates compiled into the binary: their licence texts (from the local cargo registry), each identical text once.
  const crateTexts = new Map<string, Array<string>>();
  for (const c of rust) {
    if (c.buildOnly || !c.dir) continue;
    for (const [file, text] of licenceFiles(c.dir)) {
      const key = `${/^notice/i.test(file) ? "NOTICE" : "LICENSE"}\n${text}`;
      crateTexts.set(key, [...(crateTexts.get(key) ?? []), `${c.name}@${c.version} (${file})`]);
    }
  }
  if (crateTexts.size) {
    s += section("Licence texts of the Rust crates");
    for (const [key, names] of crateTexts) {
      const [kind, ...body] = key.split("\n");
      s += `${"-".repeat(78)}\n${kind === "NOTICE" ? "NOTICE file of" : "Licence of"}: ${names.join(", ")}\n${"-".repeat(78)}\n\n${body.join("\n")}\n\n`;
    }
  }
  return s;
}

if (import.meta.main) {
  const text = await render();
  const concerning = (await npmPackages()).filter((p) => isConcerning(p.license));
  for (const p of concerning) console.error(`Check the licence of ${p.name}@${p.version}: ${p.license}`);
  if (process.argv.includes("--check")) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== text) console.error("THIRD_PARTY_NOTICES is out of date: run node scripts/notices.ts");
    process.exit(current !== text || concerning.length ? 1 : 0);
  }
  writeFileSync(OUT, text);
  console.log(`Wrote THIRD_PARTY_NOTICES (${text.split("\n").length} lines).`);
}
