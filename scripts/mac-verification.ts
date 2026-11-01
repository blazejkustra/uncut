// Says when a PR touches what CI's virtual Macs can't judge (test/helpers/capabilities.ts): export,
// preview, audio or project data, listed in scripts/mac-verification-paths.json ("dir/" or a file).
// Only warns: `::warning::` and a job summary line. Compares HEAD with its first parent, which on a
// pull_request checkout (the merge commit) is the base branch.
//
//   node scripts/mac-verification.ts
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Areas = Record<string, ReadonlyArray<string>>;

const areas: Areas = JSON.parse(readFileSync(resolve(import.meta.dirname, "mac-verification-paths.json"), "utf8"));

const changedFiles = () =>
  execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", "HEAD^1", "HEAD"], { encoding: "utf8" }).split("\0").filter(Boolean);

const isUnder = (file: string, path: string) => (path.endsWith("/") ? file.startsWith(path) : file === path);

const filesIn = (paths: ReadonlyArray<string>, files: ReadonlyArray<string>) => files.filter((file) => paths.some((path) => isUnder(file, path)));

const changed = changedFiles();
const touched = Object.entries(areas).flatMap(([area, paths]) => {
  const files = filesIn(paths, changed);
  return files.length ? [{ area, files }] : [];
});

if (touched.length) {
  const names = touched.map((t) => t.area).join(", ");
  console.log(`::warning::needs Mac verification: this PR touches ${names}`);
  const lines = [`**needs Mac verification**: this PR touches ${names}.`, "", ...touched.flatMap((t) => t.files.map((f) => `- ${t.area}: \`${f}\``)), ""];
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
} else {
  console.log("No export, preview, audio or project data paths touched.");
}
