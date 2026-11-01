// The CI gates: the PR warning for what only a real Mac can verify (scripts/mac-verification.ts), the
// flaky test quarantine (scripts/test-shard.ts, test/quarantine.json) and CI's concurrency on main.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MAC_SCRIPT = resolve("scripts/mac-verification.ts");
const SHARD_SCRIPT = resolve("scripts/test-shard.ts");

const withTempDir = (run: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-ci-gates-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const write = (dir: string, file: string, content: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
};

const git = (cwd: string, ...args: ReadonlyArray<string>) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};

/** The script's run on a repo whose last commit changed `file`. */
const macVerification = (dir: string, file: string) => {
  git(dir, "init", "-q");
  write(dir, "README", "base");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  write(dir, file, "changed");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "change");
  const summary = join(dir, "summary.txt");
  const r = spawnSync(process.execPath, [MAC_SCRIPT], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  return { status: r.status, stdout: r.stdout, summary: existsSync(summary) ? readFileSync(summary, "utf8") : "" };
};

test("a PR touching audio gets a warning and a summary line, and still passes", () =>
  withTempDir((dir) => {
    const r = macVerification(dir, "apps/web/src/audio/audio.ts");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^::warning::needs Mac verification: this PR touches audio$/m);
    assert.match(r.summary, /needs Mac verification/);
    assert.match(r.summary, /audio: `apps\/web\/src\/audio\/audio\.ts`/);
  }));

test("a file shared by export and preview names both areas", () =>
  withTempDir((dir) => {
    assert.match(macVerification(dir, "packages/core/src/visual/render.ts").stdout, /touches export, preview$/m);
  }));

test("a PR elsewhere gets no warning", () =>
  withTempDir((dir) => {
    const r = macVerification(dir, "apps/web/src/audioless.ts");
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /::warning::/);
    assert.equal(r.summary, "");
  }));

test("every path on the Mac verification list exists", () => {
  const areas: Record<string, Array<string>> = JSON.parse(readFileSync("scripts/mac-verification-paths.json", "utf8"));
  assert.deepEqual(Object.keys(areas), ["export", "preview", "audio", "project data"]);
  for (const path of Object.values(areas).flat()) assert.ok(existsSync(path), path);
});

/** One shard over a passing and a failing test file, with `quarantine` as test/quarantine.json. */
const runShard = (dir: string, quarantine: unknown) => {
  write(dir, "test/core/good.test.ts", `import { test } from "node:test";\ntest("good", () => {});\n`);
  write(dir, "test/core/bad.test.ts", `import { test } from "node:test";\ntest("bad", () => { throw new Error("no"); });\n`);
  write(dir, "test/quarantine.json", JSON.stringify(quarantine));
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_STEP_SUMMARY: join(dir, "summary.txt") };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [SHARD_SCRIPT, "--shard", "0", "--of", "1"], { cwd: dir, encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout, summary: readFileSync(join(dir, "summary.txt"), "utf8") };
};

test("a failing file off the quarantine list fails the run", () =>
  withTempDir((dir) => {
    const r = runShard(dir, []);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^::error file=test\/core\/bad\.test\.ts::/m);
  }));

test("a quarantined file reports in the summary but can't fail the run", () =>
  withTempDir((dir) => {
    const r = runShard(dir, [{ path: "test/core/bad.test.ts", reason: "stalls on the VM", date: "2026-11-01" }]);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /^::error/m);
    assert.match(r.stdout, /^::warning file=test\/core\/bad\.test\.ts::.*quarantined since 2026-11-01: stalls on the VM$/m);
    assert.match(r.summary, /1 of 2 files passed/);
    assert.match(r.summary, /\*\*1 quarantined\*\*.*`test\/core\/bad\.test\.ts` \(failed, stalls on the VM\)/);
    assert.match(r.summary, /\| test\/core\/bad\.test\.ts \| \*\*failed\*\*, quarantined \|/);
  }));

test("the quarantine list names real test files, each with a reason and a date", () => {
  const entries: Array<{ path: string; reason: string; date: string }> = JSON.parse(readFileSync("test/quarantine.json", "utf8"));
  for (const { path, reason, date } of entries) {
    assert.ok(existsSync(path), path);
    assert.ok(reason.trim(), `${path}: a reason`);
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `${path}: a date`);
  }
});

test("waiting CI runs on main are queued, and only a PR's are cancelled", () => {
  const yml = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(
    yml,
    /\nconcurrency:\n  group: ci-\$\{\{ github\.ref \}\}\n  queue: max\n  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\n/,
  );
});
