// scripts/test-shard.ts: a file that hangs where no test timeout can reach it fails at the file
// limit, and neither it nor a finished file leaves a process behind or keeps the shard waiting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("scripts/test-shard.ts");
const hungSeconds = 90000 + process.pid;
const leftoverSeconds = hungSeconds + 1;
const running = (seconds: number) => spawnSync("pgrep", ["-f", `sleep ${seconds}`], { encoding: "utf8" }).stdout.trim();

test("a hung file fails at the file limit with its output, and nothing is left running", { timeout: 60000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-shard-limit-"));
  try {
    mkdirSync(join(dir, "test"));
    writeFileSync(
      join(dir, "test", "hung.test.ts"),
      `import { execFileSync } from "node:child_process";
console.log("before the hang");
execFileSync("sleep", ["${hungSeconds}"]);
`,
    );
    writeFileSync(
      join(dir, "test", "leaves-a-child.test.ts"),
      `import { spawn } from "node:child_process";
spawn("sleep", ["${leftoverSeconds}"], { stdio: "ignore" }).unref();
`,
    );
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const shard = spawnSync(process.execPath, [SCRIPT, "--file-limit-s", "5"], { cwd: dir, env, encoding: "utf8", timeout: 45000 });
    assert.equal(shard.error, undefined, "the shard ends by itself");
    assert.equal(shard.status, 1);
    assert.match(shard.stdout, /FAILED test\/hung\.test\.ts in \d+ s/);
    assert.match(shard.stdout, /before the hang/);
    assert.match(shard.stdout, /still running after 5 s/);
    assert.match(shard.stdout, /# ok test\/leaves-a-child\.test\.ts in [0-4] s/);
    assert.equal(running(hungSeconds), "");
    assert.equal(running(leftoverSeconds), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
