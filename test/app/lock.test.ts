// The lock that makes Electron test files take turns: atomic, stale-aware, and never a hang.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectLock, lockApps, unlockApps } from "../helpers/app.ts";

let dir: string, path: string;
const startOf = (pid: number) => execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
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
    writeFileSync(path, JSON.stringify({ pid: holder.pid, start: startOf(holder.pid!) }));
    await assert.rejects(
      lockApps({ path, timeoutMs: 800 }),
      (error: Error) => error.message.includes(`pid ${holder.pid}`) && error.message.includes("Waited 1 s"),
    );
    unlockApps({ path });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, holder.pid);
  } finally {
    holder.kill("SIGKILL");
    rmSync(path, { force: true });
  }
});

const tickets = () => (existsSync(`${path}.queue`) ? readdirSync(`${path}.queue`) : []);

test("first come, first served: a free lock waits for an older live ticket, and our ticket is gone after", async () => {
  const earlier = spawn("sleep", ["30"]);
  try {
    await new Promise((r) => setTimeout(r, 100));
    mkdirSync(`${path}.queue`, { recursive: true });
    writeFileSync(join(`${path}.queue`, "000000000000001-0000001-0.ticket"), JSON.stringify({ pid: earlier.pid, start: startOf(earlier.pid!) }));
    // The lock is free, but someone queued first and hasn't taken it: we wait, then give up naming it.
    await assert.rejects(lockApps({ path, timeoutMs: 600 }), (error: Error) => error.message.includes("never took it"));
    assert.equal(existsSync(path), false);
    assert.deepEqual(tickets(), ["000000000000001-0000001-0.ticket"], "our ticket is withdrawn when we give up");
    // Once the earlier waiter is gone, its ticket is dropped and the lock is ours.
    const waiting = lockApps({ path, timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(existsSync(path), false, "still waiting its turn");
    earlier.kill("SIGKILL");
    await waiting;
    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
    assert.deepEqual(tickets(), []);
    unlockApps({ path });
  } finally {
    earlier.kill("SIGKILL");
  }
});

test("waiters in other processes get the lock in the order they arrived, however long each holds it", { timeout: 60000 }, async () => {
  const helper = resolve("test/helpers/app.ts");
  const script = `import { lockApps, unlockApps } from ${JSON.stringify(helper)};
    await lockApps({ path: process.env.LOCK, timeoutMs: 30000 });
    process.stdout.write(process.env.NAME + " " + Date.now() + "\\n");
    await new Promise((r) => setTimeout(r, Number(process.env.HOLD)));
    unlockApps({ path: process.env.LOCK });`;
  await lockApps({ path, timeoutMs: 5000 }); // everyone queues behind us
  const names = ["a", "b", "c", "d", "e"];
  const runs: Array<Promise<string>> = [];
  for (const name of names) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, LOCK: path, NAME: name, HOLD: "150" } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    runs.push(new Promise((r) => child.once("exit", () => r(out))));
    // Wait until its ticket is in the queue so the arrival order is known.
    for (let i = 0; i < 100 && tickets().length < names.indexOf(name) + 1; i++) await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(tickets().length, names.length);
  unlockApps({ path });
  const got = (await Promise.all(runs))
    .map((o) => o.trim())
    .sort((x, y) => Number(x.split(" ")[1]) - Number(y.split(" ")[1]))
    .map((l) => l.split(" ")[0]);
  assert.deepEqual(got, names);
  assert.deepEqual(tickets(), []);
});
