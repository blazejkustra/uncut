import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGatedFile } from "../../scripts/factory/app-tests.ts";
import { GB, parsePs, roomProblems, treeBytes, treeOf, waitForRoom, watchTree, type GuardLimits, type Room } from "../../scripts/factory/memory-guard.ts";

const MB = 2 ** 20;
const limits: GuardLimits = { capBytes: 4 * GB, minFreePercent: 30, minDiskBytes: 5 * GB, waitMs: 0 };
const roomy: Room = { freePercent: 70, diskFreeBytes: 100 * GB, otherFfmpeg: [] };

test("roomProblems lets a roomy Mac start", () => {
  assert.deepEqual(roomProblems(roomy, limits), []);
});

test("roomProblems refuses low memory, an unreadable reading, a full disk and another ffmpeg", () => {
  assert.match(roomProblems({ ...roomy, freePercent: 12 }, limits)[0]!, /^blocked: memory, 12% free/);
  assert.match(roomProblems({ ...roomy, freePercent: undefined }, limits)[0]!, /^blocked: memory/);
  assert.match(roomProblems({ ...roomy, diskFreeBytes: 3 * GB }, limits)[0]!, /^blocked: disk, 3.0 GB free/);
  assert.match(roomProblems({ ...roomy, otherFfmpeg: [42] }, limits)[0]!, /another ffmpeg is running \(pid 42\)/);
});

test("waitForRoom waits while another export runs, then starts", async () => {
  const readings = [{ ...roomy, otherFfmpeg: [42] }, { ...roomy, freePercent: 10 }, roomy];
  const problems = await waitForRoom({ ...limits, waitMs: 5000 }, () => readings.shift() ?? roomy, 1);
  assert.deepEqual(problems, []);
  assert.equal(readings.length, 0);
});

test("waitForRoom gives up with the reason once its wait is over", async () => {
  const problems = await waitForRoom({ ...limits, waitMs: 20 }, () => ({ ...roomy, freePercent: 5 }), 5);
  assert.match(problems[0]!, /^blocked: memory/);
});

const PS = `  1     0   1000 /sbin/launchd
 10     1   2048 node
 11    10   4096 /opt/homebrew/bin/ffmpeg
 12    11   1024 helper
 13     1   8192 node
 20     1 102400 /System/Library/Frameworks/VideoToolbox.framework/Versions/A/XPCServices/VTDecoderXPCService.xpc/Contents/MacOS/VTDecoderXPCService
`;

test("the tree's memory is every descendant plus what the video services grew by", () => {
  const rows = parsePs(PS);
  assert.deepEqual(
    treeOf(rows, 10).map((r) => r.pid),
    [10, 11, 12],
  );
  assert.equal(treeBytes(rows, 10, 102400 * 1024), (2048 + 4096 + 1024) * 1024);
  assert.equal(treeBytes(rows, 10, 2400 * 1024), (2048 + 4096 + 1024 + 100000) * 1024);
});

const HOG = `const keep = Buffer.alloc(${300 * MB}, 1);
setInterval(() => keep.length, 1000);
`;

const exitOf = (child: ReturnType<typeof spawn>) => new Promise<NodeJS.Signals | null>((done) => child.once("exit", (_code, signal) => done(signal)));

test("a process tree over its cap is killed, all of it, and the breach is kept", { timeout: 30000 }, async () => {
  const child = spawn(
    process.execPath,
    ["-e", `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(HOG)}], { stdio: "inherit" }); setInterval(() => {}, 1000);`],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  const watch = watchTree(child.pid!, 100 * MB);
  const signal = await exitOf(child);
  watch.stop();
  assert.equal(signal, "SIGKILL");
  const breach = watch.breach();
  assert.ok(breach && breach.peakBytes > 100 * MB, `breach ${JSON.stringify(breach)}`);
  assert.equal(breach.capBytes, 100 * MB);
});

/** Without it the inner node --test would report to this run instead of printing TAP. */
const outsideThisTestRun = () => {
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  return env;
};

test("a test file over its cap fails as blocked: memory on its first attempt, never retried or excused", { timeout: 60000 }, async () => {
  const worktree = mkdtempSync(join(tmpdir(), "uncut-guard-"));
  try {
    const file = "test/app/issue55-app.test.ts";
    mkdirSync(join(worktree, "test/app"), { recursive: true });
    writeFileSync(join(worktree, file), `import { test } from "node:test";\ntest("hog", () => new Promise(() => { ${HOG} }));\n`);
    const check = await runGatedFile(file, {
      worktree,
      env: outsideThisTestRun(),
      timeoutMs: 30000,
      attempts: 3,
      quarantined: new Map([[file, "fails on main"]]),
      capBytes: 100 * MB,
    });
    assert.equal(check.status, "fail");
    assert.equal(check.required, true);
    assert.match(check.reason ?? "", /^blocked: memory/);
    assert.equal(check.values?.attempts, 1);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});
