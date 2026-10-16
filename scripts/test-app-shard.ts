// Runs one shard of the packaged-app tests (test/app) for CI (#89, D254): the files are split over
// `--of` shards by their recorded durations (test/app/durations.json; a file not in it counts as the
// median), longest first onto the lightest shard. The files run one after another (the Electron
// tests take turns on one machine anyway, test/helpers/app.ts), each its own `node --test`, so every
// file's time and result is known. Writes test-output/shard-<n>.json (durations for the next
// update of durations.json) and a table to $GITHUB_STEP_SUMMARY.
//
//   node scripts/test-app-shard.ts --shard 0 --of 6 [--retries 1] [--list]
//
// `--retries N`: a failing file is run again up to N times. Every retry is printed, annotated
// (::warning::) and listed in the summary as a flake, so a retry never hides a failure silently.
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

const DIR = "test/app";
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `${DIR}/${f}`)
  .sort();
let known: Record<string, number> = {};
try {
  known = JSON.parse(readFileSync(join(DIR, "durations.json"), "utf8"));
} catch {}
const recorded = Object.values(known).sort((a, b) => a - b);
const median = recorded.length ? recorded[Math.floor(recorded.length / 2)]! : 60;
const weight = (f: string) => known[f] ?? median;

/** Longest first, each onto the shard with the least total so far (ties: the lower shard). */
function split(names: ReadonlyArray<string>, n: number, w: (f: string) => number) {
  const shards = Array.from({ length: n }, () => ({ total: 0, files: [] as Array<string> }));
  for (const f of [...names].sort((a, b) => w(b) - w(a) || a.localeCompare(b))) {
    const lightest = shards.reduce((best, s) => (s.total < best.total ? s : best));
    lightest.files.push(f);
    lightest.total += w(f);
  }
  return shards;
}

const mine = split(files, of, weight)[shard]!;
console.log(`# shard ${shard + 1}/${of}: ${mine.files.length} of ${files.length} files, ~${Math.round(mine.total / 60)} min recorded`);
if (listOnly) {
  for (const f of mine.files) console.log(f);
  process.exit(0);
}

// Skipped tests (the spec reporter's "﹣ name # reason" lines), for the summary.
const skippedTests: Array<string> = [];
const runFile = (file: string) =>
  new Promise<number>((done) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=spec", file], { stdio: ["ignore", "pipe", "inherit"] });
    let rest = "";
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      const lines = (rest + chunk.toString()).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) if (/^\s*﹣ /.test(line)) skippedTests.push(`${file}: ${line.trim().slice(2)}`);
    });
    child.once("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });

interface Result {
  file: string;
  seconds: number;
  ok: boolean;
  tries: number;
}
const results: Array<Result> = [];
for (const file of mine.files) {
  const started = Date.now();
  let tries = 0;
  let ok = false;
  while (!ok && tries <= retries) {
    if (tries > 0) {
      console.log(`::warning file=${file}::${file} failed; running it again (retry ${tries} of ${retries})`);
      console.log(`# RETRY ${tries}/${retries}: ${file}`);
    }
    tries++;
    console.log(`::group::${file}${tries > 1 ? ` (try ${tries})` : ""}`);
    ok = (await runFile(file)) === 0;
    console.log("::endgroup::");
    if (!ok) console.log(`::error file=${file}::${file} failed${tries > 1 ? ` (try ${tries})` : ""}`);
  }
  results.push({ file, seconds: Math.round((Date.now() - started) / 1000), ok, tries });
  console.log(`# ${ok ? "ok" : "FAILED"} ${file} in ${results.at(-1)!.seconds} s${tries > 1 ? ` after ${tries} tries` : ""}`);
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
const summary = [
  `### App tests, shard ${shard + 1}/${of}`,
  "",
  `${results.length - failed.length} of ${results.length} files passed in ${Math.round(results.reduce((s, r) => s + r.seconds, 0) / 60)} min.${flaky.length ? ` **${flaky.length} passed only on a retry** (flaky): ${flaky.map((r) => `\`${r.file}\``).join(", ")}.` : ""}`,
  "",
  "| file | result | s |",
  "|---|---|---|",
  ...results.map((r) => `| ${r.file} | ${r.ok ? (r.tries > 1 ? `flaky (${r.tries} tries)` : "ok") : "**failed**"} | ${r.seconds} |`),
  "",
  ...(skippedTests.length ? ["<details><summary>Skipped tests</summary>", "", ...skippedTests.map((l) => `- ${l}`), "", "</details>", ""] : []),
  ...(skippedChecks().length ? ["<details><summary>Checks not run on this machine</summary>", "", ...skippedChecks().map((l) => `- ${l}`), "", "</details>", ""] : []),
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
process.exit(failed.length ? 1 : 0);
