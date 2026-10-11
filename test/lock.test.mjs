// The lock that makes Electron test files take turns: atomic, stale-aware, and never a hang.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectLock, lockApps, unlockApps } from "./helpers/app.mjs";

let dir, path;
const startOf = (pid) => execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
before(() => {
  dir = mkdtempSync(join(tmpdir(), "uncut-lock-"));
  path = join(dir, "lock");
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("a free lock is taken with our pid and start time, and released", async () => {
  await lockApps({ path, timeoutMs: 2000 });
  const holder = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(holder.pid, process.pid);
  assert.equal(holder.start, startOf(process.pid));
  unlockApps({ path });
  assert.equal(existsSync(path), false);
});

test("a lock left by a dead process, or a reused pid, is taken over", async () => {
  const dead = spawnSync("true").pid;
  writeFileSync(path, JSON.stringify({ pid: dead, start: "whenever" }));
  await lockApps({ path, timeoutMs: 2000 });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
  unlockApps({ path });

  // Alive pid, but not the process that wrote the lock (different start time).
  writeFileSync(path, JSON.stringify({ pid: process.ppid, start: "Mon Jan  1 00:00:00 2001" }));
  await lockApps({ path, timeoutMs: 2000 });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
  unlockApps({ path });
});

test("an unreadable lock is stale only after a grace period", async () => {
  writeFileSync(path, "{ half writ");
  assert.equal(inspectLock(path).stale, false, "fresh garbage may be a writer mid-write");
  const old = new Date(Date.now() - 60_000);
  utimesSync(path, old, old);
  assert.equal(inspectLock(path).stale, true);
  await lockApps({ path, timeoutMs: 2000 });
  unlockApps({ path });
});

test("a live holder makes the wait give up with a message naming it, and our unlock leaves its lock alone", async () => {
  const holder = spawn("sleep", ["30"]);
  try {
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(path, JSON.stringify({ pid: holder.pid, start: startOf(holder.pid) }));
    await assert.rejects(lockApps({ path, timeoutMs: 800 }), (error) => error.message.includes(`pid ${holder.pid}`) && error.message.includes("Waited 1 s"));
    unlockApps({ path });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, holder.pid);
  } finally {
    holder.kill("SIGKILL");
    rmSync(path, { force: true });
  }
});
