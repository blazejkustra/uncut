// Runs one shard of the whole test suite for CI (#89, D254): the fast tests (test/*, but test/app)
// and the packaged-app tests (test/app), split over `--of` shards by their recorded durations
// (test/durations.json; a file not in it counts as the median of its kind), longest first onto the
// lightest shard. The fast files run two at a time (node --test's default on a 3-core runner) and
// count half their time; then the app files run one after another (the Electron tests take turns on
// one machine anyway, test/helpers/app.ts). Each file is its own `node --test`, so every file's time
// and result is known. Writes test-output/shard-<n>.json (durations for the next update of
// test/durations.json) and a table to $GITHUB_STEP_SUMMARY.
//
//   node scripts/test-shard.ts --shard 0 --of 5 [--retries 1] [--list]
//
// `--retries N`: an app file that fails is run again up to N times. Every retry is printed, annotated
// (::warning::) and listed in the summary as a flake, so a retry never hides a failure silently. Fast
// files are never retried.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const shard = Number(arg("shard", "0"));
const of = Number(arg("of", "1"));
const retries = Number(arg("retries", "0"));
const listOnly = process.argv.includes("--list");
if (!Number.isInteger(shard) || !Number.isInteger(of) || of < 1 || shard < 0 || shard >= of) throw new Error(`bad --shard ${shard} --of ${of}`);

/** Fast files run this many at a time. */
const FAST_AT_ONCE = 2;
/** An app launch can take longer than on a laptop on a 3-core runner; only the app files get it. */
const APP_ENV = { UNCUT_TEST_LAUNCH_MS: process.env.UNCUT_TEST_LAUNCH_MS ?? "120000" };

const testFiles = (dir: string): Array<string> =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? testFiles(join(dir, e.name)) : e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []))
    .sort();
const all = testFiles("test");
const isApp = (f: string) => f.startsWith("test/app/");

let known: Record<string, number> = {};
try {
  known = JSON.parse(readFileSync("test/durations.json", "utf8"));
} catch {}
const medianOf = (files: ReadonlyArray<string>, fallback: number) => {
  const v = files.flatMap((f) => (known[f] === undefined ? [] : [known[f]!])).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)]! : fallback;
};
const appMedian = medianOf(all.filter(isApp), 60);
const fastMedian = medianOf(
  all.filter((f) => !isApp(f)),
  10,
);
/** A file's share of its shard's wall time. */
const weight = (f: string) => (isApp(f) ? (known[f] ?? appMedian) : (known[f] ?? fastMedian) / FAST_AT_ONCE);

const shards = Array.from({ length: of }, () => ({ total: 0, files: [] as Array<string> }));
for (const f of [...all].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
  const lightest = shards.reduce((best, s) => (s.total < best.total ? s : best));
  lightest.files.push(f);
  lightest.total += weight(f);
}
const mine = shards[shard]!;
const fast = mine.files.filter((f) => !isApp(f)).sort();
const app = mine.files.filter(isApp).sort();
console.log(`# shard ${shard + 1}/${of}: ${fast.length} fast and ${app.length} app files of ${all.length}, ~${Math.round(mine.total / 60)} min recorded`);
if (listOnly) {
  for (const f of mine.files) console.log(f);
  process.exit(0);
}

// Skipped tests (the spec reporter's "﹣ name # reason" lines), for the summary.
const skippedTests: Array<string> = [];
/** Runs one file; its output is printed as it comes (`live`) or all at once at the end, in a group. */
const runFile = (file: string, title: string, live: boolean, env: NodeJS.ProcessEnv = {}) =>
  new Promise<number>((done) => {
    if (live) console.log(`::group::${title}`);
    const child = spawn(process.execPath, ["--test", "--test-reporter=spec", file], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    const kept: Array<Buffer> = [];
    let rest = "";
    const out = (chunk: Buffer) => (live ? process.stdout.write(chunk) : kept.push(chunk));
    child.stderr.on("data", out);
    child.stdout.on("data", (chunk: Buffer) => {
      out(chunk);
      const lines = (rest + chunk.toString()).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) if (/^\s*﹣ /.test(line)) skippedTests.push(`${file}: ${line.trim().slice(2)}`);
    });
    child.once("close", (code, signal) => {
      if (!live) {
        console.log(`::group::${title}`);
        process.stdout.write(Buffer.concat(kept));
      }
      console.log("::endgroup::");
      done(code ?? (signal ? 1 : 0));
    });
  });

interface Result {
  file: string;
  seconds: number;
  ok: boolean;
  tries: number;
}
const results: Array<Result> = [];
const report = (r: Result) => {
  results.push(r);
  if (!r.ok) console.log(`::error file=${r.file}::${r.file} failed${r.tries > 1 ? ` (${r.tries} tries)` : ""}`);
  console.log(`# ${r.ok ? "ok" : "FAILED"} ${r.file} in ${r.seconds} s${r.tries > 1 ? ` after ${r.tries} tries` : ""}`);
};

// The fast files, FAST_AT_ONCE at a time (longest first, so the last ones to finish are short).
const queue = [...fast].sort((a, b) => weight(b) - weight(a));
await Promise.all(
  Array.from({ length: FAST_AT_ONCE }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const started = Date.now();
      const ok = (await runFile(file, file, false)) === 0;
      report({ file, seconds: Math.round((Date.now() - started) / 1000), ok, tries: 1 });
    }
  }),
);

// The app files, one at a time.
for (const file of app) {
  const started = Date.now();
  let tries = 0;
  let ok = false;
  while (!ok && tries <= retries) {
    if (tries > 0) {
      console.log(`::warning file=${file}::${file} failed; running it again (retry ${tries} of ${retries})`);
      console.log(`# RETRY ${tries}/${retries}: ${file}`);
    }
    tries++;
    ok = (await runFile(file, `${file}${tries > 1 ? ` (try ${tries})` : ""}`, true, APP_ENV)) === 0;
  }
  report({ file, seconds: Math.round((Date.now() - started) / 1000), ok, tries });
}

mkdirSync("test-output", { recursive: true });
// test/helpers/capabilities.ts's check() lists what it didn't check here.
const skippedChecks = () => {
  try {
    return [...new Set(readFileSync("test-output/skipped-checks.txt", "utf8").trim().split("\n").filter(Boolean))];
  } catch {
    return [];
  }
};
writeFileSync(`test-output/shard-${shard}.json`, `${JSON.stringify(Object.fromEntries(results.map((r) => [r.file, r.seconds])), null, 1)}\n`);
const failed = results.filter((r) => !r.ok);
const flaky = results.filter((r) => r.ok && r.tries > 1);
const minutes = (rs: ReadonlyArray<Result>) => Math.round(rs.reduce((s, r) => s + r.seconds, 0) / 60);
const summary = [
  `### Tests, shard ${shard + 1}/${of}`,
  "",
  `${results.length - failed.length} of ${results.length} files passed (fast: ${minutes(results.filter((r) => !isApp(r.file)))} min over ${FAST_AT_ONCE} at a time, app: ${minutes(results.filter((r) => isApp(r.file)))} min).${flaky.length ? ` **${flaky.length} passed only on a retry** (flaky): ${flaky.map((r) => `\`${r.file}\``).join(", ")}.` : ""}`,
  "",
  "| file | result | s |",
  "|---|---|---|",
  ...results.map((r) => `| ${r.file} | ${r.ok ? (r.tries > 1 ? `flaky (${r.tries} tries)` : "ok") : "**failed**"} | ${r.seconds} |`),
  "",
  ...(skippedTests.length ? ["<details><summary>Skipped tests</summary>", "", ...skippedTests.map((l) => `- ${l}`), "", "</details>", ""] : []),
  ...(skippedChecks().length
    ? ["<details><summary>Checks not run on this machine</summary>", "", ...skippedChecks().map((l) => `- ${l}`), "", "</details>", ""]
    : []),
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
process.exit(failed.length ? 1 : 0);
