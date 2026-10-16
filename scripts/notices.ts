// Writes THIRD_PARTY_NOTICES (plain text, D112): what Uncut ships that others made, and what it
// relies on but doesn't ship.
//   node scripts/notices.ts           write THIRD_PARTY_NOTICES
//   node scripts/notices.ts --check   exit 1 if the file is out of date, or a shipped npm package
//                                     has a copyleft (GPL, AGPL, LGPL) or unknown licence
// npm: the production dependencies of the workspace packages whose code ships (bundled into
// server.mjs, the renderer or the plugin SDK), followed through node_modules the way Node resolves
// them; licences from each package.json. Rust: the crates in native/media/Cargo.lock, licences
// from the local cargo registry when it's there. Music from assets/music/library.json; fonts from
// assets/fonts/OFL.txt; three.js from assets/graphic-libs (D193). No author fields (they carry
// email addresses).
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "THIRD_PARTY_NOTICES");
/** Workspace packages whose production dependencies end up in the app. */
const SHIPPED = ["apps/server", "apps/web", "apps/desktop", "packages/core", "packages/contracts", "packages/plugin-sdk"];

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
  return url.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git:\/\//, "https://").replace(/^github:/, "https://github.com/");
};

/** Node's lookup: <dir>/node_modules/<name>, then each parent's. */
function findPackage(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    if (dirname(dir) === dir) return undefined;
  }
}

export function npmPackages(): Array<Pkg> {
  const seen = new Map<string, Pkg>();
  const walk = (dir: string, deps: Record<string, string>, optional: Record<string, string>) => {
    for (const name of [...Object.keys(deps), ...Object.keys(optional)]) {
      const found = findPackage(name, dir);
      if (!found) {
        if (name in optional) continue;
        throw new Error(`${name} (needed by ${dir}) isn't in node_modules: run pnpm install`);
      }
      const json = readJson(join(found, "package.json"));
      const key = `${String(json.name)}@${String(json.version)}`;
      if (seen.has(key)) continue;
      // Workspace packages are Uncut itself.
      if (String(json.name).startsWith("@uncut/")) {
        seen.set(key, { name: String(json.name), version: "", license: "", repository: "", dir: "" });
      } else {
        seen.set(key, { name: String(json.name), version: String(json.version), license: licenceOf(json), repository: repositoryOf(json), dir: found });
      }
      walk(found, (json.dependencies ?? {}) as Record<string, string>, (json.optionalDependencies ?? {}) as Record<string, string>);
    }
  };
  for (const ws of SHIPPED) {
    const json = readJson(join(ROOT, ws, "package.json"));
    walk(join(ROOT, ws), (json.dependencies ?? {}) as Record<string, string>, (json.optionalDependencies ?? {}) as Record<string, string>);
  }
  return [...seen.values()].filter((p) => p.version !== "").sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Licences that would put conditions on Uncut's own code or that nobody stated. */
export const isConcerning = (licence: string) => /GPL|UNKNOWN|UNLICENSED|SEE LICENSE/i.test(licence) && !/\bOR\b.*\b(MIT|Apache|BSD|ISC)\b|\b(MIT|Apache|BSD|ISC)\b.*\bOR\b/i.test(licence);

type Crate = { name: string; version: string; license: string; buildOnly: boolean };
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
    for (const index of indexes) {
      const toml = join(index, `${name}-${version}`, "Cargo.toml");
      if (!existsSync(toml)) continue;
      const m = /^license\s*=\s*"([^"]+)"/m.exec(readFileSync(toml, "utf8"));
      if (m) license = m[1]!.replace(/\//g, " OR ");
      break;
    }
    out.push({ name, version, license, buildOnly: BUILD_ONLY.has(name) });
  }
  return out;
}

const rule = "=".repeat(78);
const section = (title: string) => `\n${rule}\n${title}\n${rule}\n\n`;

export function render(): string {
  const library = readJson(join(ROOT, "assets/music/library.json")) as { tracks: Array<{ file: string; title: string; author: string; source: string; license: string; licenseChecked?: string; trimmed?: string }> };
  const electron = readJson(join(ROOT, "node_modules/electron/package.json"));
  const npm = npmPackages();
  const rust = crates();
  let s = "";
  s += "Uncut: third-party notices\n\n";
  s += "Uncut itself is MIT licensed (see LICENSE). This file lists what the Uncut app ships that\n";
  s += "others made, and the programs it uses but doesn't ship. Generated by scripts/notices.ts;\n";
  s += "don't edit it by hand.\n";

  s += section("Fonts: DM Sans and DM Mono (SIL Open Font License 1.1)");
  s += "Shipped in the app (inlined in the editor and the renderer, licence in Resources/fonts/OFL.txt).\n\n";
  s += readFileSync(join(ROOT, "assets/fonts/OFL.txt"), "utf8").trimEnd() + "\n";

  s += section("Music library (CC0 1.0, public domain)");
  s += "Shipped in Resources/music. Each track's licence was checked on its Freesound page.\n\n";
  for (const t of library.tracks) {
    s += `${t.file}: "${t.title}" by ${t.author}\n  ${t.source}\n  ${t.license}${t.licenseChecked ? `, checked ${t.licenseChecked}` : ""}${t.trimmed ? `; ${t.trimmed}` : ""}\n`;
  }

  const sfx = readJson(join(ROOT, "assets/sfx/library.json")) as { sounds: Array<{ file: string; title: string; author: string; provider?: string; source: string; sourceFile?: string; license: string; licenseChecked?: string; licenseProof?: string; trimmed?: string }> };
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

  // Issue #50: the providers' marks in the composer, embedded the way t3code does.
  s += section("Provider marks: from t3code (MIT)");
  s += "The Claude and OpenAI marks in the Agent tab's model picker (apps/web/src/panels/composer/\n";
  s += "providerMarks.tsx) are the SVGs t3code embeds (https://github.com/pingdotgg/t3code,\n";
  s += "apps/web/src/components/Icons.tsx). The marks are trademarks of Anthropic and OpenAI, shown only\n";
  s += "to name the agent a model runs on; Uncut isn't made by or affiliated with either. t3code's licence:\n\n";
  s += "MIT License\n\nCopyright (c) 2026 T3 Tools Inc.\n\n";
  s += "Permission is hereby granted, free of charge, to any person obtaining a copy\n";
  s += "of this software and associated documentation files (the \"Software\"), to deal\n";
  s += "in the Software without restriction, including without limitation the rights\n";
  s += "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n";
  s += "copies of the Software, and to permit persons to whom the Software is\n";
  s += "furnished to do so, subject to the following conditions:\n\n";
  s += "The above copyright notice and this permission notice shall be included in all\n";
  s += "copies or substantial portions of the Software.\n\n";
  s += "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n";
  s += "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n";
  s += "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n";
  s += "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n";
  s += "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n";
  s += "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\n";
  s += "SOFTWARE.\n";

  // Issue #63 (D234): the labs' marks in the Generate tab.
  s += section("Provider marks: Simple Icons (CC0 1.0) and lobe-icons (MIT)");
  s += "The Generate tab's model list (apps/web/src/panels/generate/marks.tsx) shows each lab's mark.\n";
  s += "Claude and OpenAI are t3code's (above). Google, ByteDance and ElevenLabs are the paths of\n";
  s += "Simple Icons 16.35.0 (https://simpleicons.org, icons google, bytedance and elevenlabs), released\n";
  s += "under CC0 1.0 Universal (https://creativecommons.org/publicdomain/zero/1.0/); no credit is\n";
  s += "required. xAI's is from lobe-icons (https://github.com/lobehub/lobe-icons, @lobehub/icons-static-svg\n";
  s += "1.95.1, icon xai). Higgsfield has no mark under a permissive licence and is shown as a monogram.\n";
  s += "The marks are trademarks of their owners (Google, ByteDance, ElevenLabs, xAI), shown only to say\n";
  s += "who makes a model; Uncut isn't made by or affiliated with any of them. lobe-icons' licence:\n\n";
  s += "MIT License\n\nCopyright (c) 2023 LobeHub\n\n";
  s += "Permission is hereby granted, free of charge, to any person obtaining a copy\n";
  s += "of this software and associated documentation files (the \"Software\"), to deal\n";
  s += "in the Software without restriction, including without limitation the rights\n";
  s += "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n";
  s += "copies of the Software, and to permit persons to whom the Software is\n";
  s += "furnished to do so, subject to the following conditions:\n\n";
  s += "The above copyright notice and this permission notice shall be included in all\n";
  s += "copies or substantial portions of the Software.\n\n";
  s += "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n";
  s += "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n";
  s += "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n";
  s += "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n";
  s += "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n";
  s += "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\n";
  s += "SOFTWARE.\n";

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
  s += "Claude Code (the agent): not bundled. Uncut runs the user's own claude command, signed in with\n";
  s += "their own subscription; its terms are Anthropic's.\n";

  s += section("npm packages shipped in the app");
  s += "Production dependencies of Uncut's server, editor, core, contracts and plugin SDK, bundled into\n";
  s += "the app. Each package's licence text is in its source repository and npm tarball.\n\n";
  for (const p of npm) s += `${p.name}@${p.version}: ${p.license}${p.repository ? `\n  ${p.repository}` : ""}\n`;

  s += section("Rust crates in the media core (uncut-media)");
  for (const c of rust) s += `${c.name}@${c.version}: ${c.license}${c.buildOnly ? " (used while compiling only)" : ""}\n  https://crates.io/crates/${c.name}\n`;
  return s;
}

if (import.meta.main) {
  const text = render();
  const concerning = npmPackages().filter((p) => isConcerning(p.license));
  for (const p of concerning) console.error(`Check the licence of ${p.name}@${p.version}: ${p.license}`);
  if (process.argv.includes("--check")) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== text) console.error("THIRD_PARTY_NOTICES is out of date: run node scripts/notices.ts");
    process.exit(current !== text || concerning.length ? 1 : 0);
  }
  writeFileSync(OUT, text);
  console.log(`Wrote THIRD_PARTY_NOTICES (${text.split("\n").length} lines).`);
}
