// Open-source launch hygiene (D112): what `git ls-files` would publish (tracked files plus untracked,
// not ignored ones, so a new file is checked before it's committed). No one's home folder or temp
// paths, no email addresses, no Software Mansion domain (the repo is the author's own until it moves), no big
// files beyond the bundled music and fonts, no footage, nothing that looks like a secret, no .md
// but README.md and CONTRIBUTING.md at the root and GitHub's pull request template (D253) (the user's
// rule: other prose stays private), and an MIT LICENSE that every package names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter((f) => f && existsSync(f));
/** The only Markdown that's published; the scans below cover them like any other text file. */
const PUBLIC_MD = ["README.md", "CONTRIBUTING.md", ".github/PULL_REQUEST_TEMPLATE.md"];
const BINARY = /\.(m4a|mp3|wav|woff2?|ttf|otf|png|jpe?g|gif|icns|ico|webp)$/i;
const texts = files.filter((f) => !BINARY.test(f)).map((f) => ({ file: f, text: readFileSync(f, "utf8") }));

/** Every match of `re` in tracked text files, as "file:line: match", minus what `allowed` keeps. */
function scan(re: RegExp, allowed: (match: string, file: string) => boolean = () => false): Array<string> {
  const hits: Array<string> = [];
  for (const { file, text } of texts) {
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) {
        if (!allowed(m[0], file)) hits.push(`${file}:${i + 1}: ${m[0]}`);
      }
    });
  }
  return hits;
}

test("git ls-files sees the repo", () => {
  assert.ok(files.includes("package.json") && files.length > 100, `${files.length} files`);
});

test("README.md, CONTRIBUTING.md and the PR template are published and go through every check below", () => {
  for (const f of PUBLIC_MD) {
    assert.ok(files.includes(f), `${f} is ignored or missing`);
    assert.ok(texts.some((t) => t.file === f), `${f} is not scanned`);
  }
});

test("no real home folder or temp paths", () => {
  // Placeholders in examples and comments are fine: /Users/me, /Users/you, /Users/x, /Users/<name>.
  const PLACEHOLDER = /^\/Users\/((me|you|x|Shared)\b|<name>)/;
  assert.deepEqual(scan(/\/Users\/[^\s"'`/)]+/, (m) => PLACEHOLDER.test(m)), []);
  assert.deepEqual(scan(/\/private\/var\/folders\/\S+|\/var\/folders\/[a-z0-9_]{2}\/\S+/), []);
});

test("no email addresses", () => {
  // Reserved example domains and .local hosts are placeholders; the lockfile carries upstream metadata.
  const placeholder = (m: string) => /@(example\.(com|org|net|invalid)|[\w.-]+\.(invalid|local|test))$/i.test(m) || /^git@/.test(m);
  const hits = scan(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/, (m, file) => file === "pnpm-lock.yaml" || placeholder(m))
    // npm scopes (@uncut/core) and versions (react@19.2.6) aren't addresses.
    .filter((h) => !/: @?[\w.-]+@\d/.test(h));
  assert.deepEqual(hits, []);
});

test("no Software Mansion domain", () => {
  const domain = ["swmansion", "com"].join(".");
  assert.deepEqual(scan(new RegExp(domain.replace(".", "\\."), "i")), []);
});

test("no file over 5 MB but the bundled music and fonts", () => {
  const big = files.filter((f) => !/^assets\/(music|fonts)\//.test(f)).filter((f) => statSync(f).size > 5 * 1024 * 1024);
  assert.deepEqual(big, []);
});

test("no footage, no .md, no fixtures", () => {
  assert.deepEqual(files.filter((f) => /\.(mp4|mov|m4v|mkv|avi|webm|mxf|braw|r3d|insv|lrf|dng)$/i.test(f)), [], "footage");
  assert.deepEqual(files.filter((f) => /\.md$/i.test(f) && !PUBLIC_MD.includes(f)), [], ".md files stay private but README.md, CONTRIBUTING.md and the PR template (the user's rule)");
  assert.deepEqual(files.filter((f) => f.startsWith("fixtures/") || f.startsWith("planning/")), [], "fixtures and planning");
});

test("nothing that looks like a secret", () => {
  // Real keys are long; the tests' stand-ins (sk-test-…, sk-ant-api03-SECRETVALUE123) are short on purpose.
  const patterns = [/\bsk-(ant-|proj-)?[A-Za-z0-9_-]{40,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{30,}/, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/];
  for (const re of patterns) assert.deepEqual(scan(re), [], re.source);
});

test("LICENSE is MIT and every package says so", () => {
  const licence = readFileSync("LICENSE", "utf8");
  assert.match(licence, /^MIT License/);
  assert.match(licence, /Copyright \(c\) 2026 Błażej Kustra and Uncut contributors/);
  const manifests = files.filter((f) => /(^|\/)package\.json$/.test(f) && !f.startsWith("plugins/") && !f.startsWith("spec/"));
  assert.ok(manifests.length >= 7, manifests.join(", "));
  for (const m of manifests) {
    const pkg = JSON.parse(readFileSync(m, "utf8")) as { license?: string; repository?: { url?: string } | string };
    assert.equal(pkg.license, "MIT", m);
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    assert.match(repo ?? "", /github\.com\/blazejkustra\/uncut/, m);
  }
  assert.match(readFileSync("native/media/Cargo.toml", "utf8"), /^license = "MIT"$/m);
});

test("THIRD_PARTY_NOTICES names the fonts, every music track and the programs Uncut doesn't ship", () => {
  const notices = readFileSync("THIRD_PARTY_NOTICES", "utf8");
  assert.match(notices, /SIL OPEN FONT LICENSE Version 1\.1/);
  const library = JSON.parse(readFileSync("assets/music/library.json", "utf8")) as { tracks: Array<{ file: string; title: string; source: string }> };
  for (const t of library.tracks) assert.ok(notices.includes(t.file) && notices.includes(t.title) && notices.includes(t.source), t.file);
  for (const name of ["ffmpeg", "whisper.cpp", "Electron", "LICENSES.chromium.html", "effect@", "react@", "serde@"]) assert.ok(notices.includes(name), name);
});
