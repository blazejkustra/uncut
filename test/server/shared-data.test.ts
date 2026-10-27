// Several projects at once: every window has its own server, all on one data dir. recents.json
// and settings.json are read again and written holding a lock file, so two servers writing at
// once never drop each other's changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { downloadFile } from "../../apps/server/src/analysis/whisperModels.ts";
import { acquireFileLock, tryFileLock } from "../../apps/server/src/project/fileLock.ts";

const WRITER = join(import.meta.dirname, "../helpers/sharedDataWriter.ts");
const WRITES = 50;

const runWriter = (dataDir: string, label: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER, dataDir, label, String(WRITES)], { stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited ${code}: ${stderr}`))));
  });

/** Which of `label`'s writes are in the list, by index. */
const indicesOf = (names: ReadonlyArray<string>, label: string) =>
  names
    .filter((n) => n.startsWith(`${label}-`))
    .map((n) => Number(n.slice(label.length + 1)))
    .sort((a, b) => a - b);

test("two servers on one data dir write recents and settings 50 times each: nothing is lost", { timeout: 120000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "uncut-shared-data-"));
  try {
    await Promise.all([runWriter(dataDir, "a"), runWriter(dataDir, "b")]);

    const settings = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")) as { pluginApprovals: Record<string, unknown> };
    assert.equal(Object.keys(settings.pluginApprovals).length, 2 * WRITES, "every approval from both servers is kept");

    // Recents keeps the newest 20; serialised writes leave each server's newest ones, none missing between.
    const recents = (JSON.parse(readFileSync(join(dataDir, "recents.json"), "utf8")) as Array<{ name: string }>).map((r) => r.name);
    assert.equal(recents.length, 20);
    for (const label of ["a", "b"]) {
      const kept = indicesOf(recents, label);
      const newest = Array.from({ length: kept.length }, (_, i) => WRITES - kept.length + i);
      assert.deepEqual(kept, newest, `${label}'s newest entries, none dropped by the other's write`);
    }
    assert.deepEqual(
      readdirSync(dataDir).filter((n) => n.endsWith(".lock") || n.includes(".tmp")),
      [],
      "no lock or temp file left",
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a lock whose process is gone is taken over; a live one is waited for", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-file-lock-"));
  try {
    const file = join(dir, "recents.json");
    writeFileSync(`${file}.lock`, "999999");
    const release = await acquireFileLock(file);
    assert.equal(JSON.parse(readFileSync(`${file}.lock`, "utf8")).pid, process.pid);

    let second = false;
    const waiting = acquireFileLock(file).then((r) => {
      second = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(second, false, "waits while this process holds it");
    await release();
    await (
      await waiting
    )();
    assert.equal(existsSync(`${file}.lock`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a download lock is never taken from a live holder, however long it has held it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-file-lock-"));
  try {
    const part = join(dir, "ggml-base.bin.part");
    writeFileSync(`${part}.lock`, String(process.ppid));
    assert.equal(await tryFileLock(part), undefined);
    writeFileSync(`${part}.lock`, "999999");
    const release = await tryFileLock(part);
    assert.ok(release, "a dead holder's lock is taken");
    await release();

    // A speech model another window's server is downloading: this one says so and leaves its .part alone.
    writeFileSync(`${part}.lock`, String(process.ppid));
    writeFileSync(part, "half a model");
    const dest = join(dir, "ggml-base.bin");
    await assert.rejects(downloadFile({ url: "http://127.0.0.1:9/never", dest, signal: new AbortController().signal }), /Another Uncut window is downloading/);
    assert.equal(readFileSync(part, "utf8"), "half a model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const dead = () => JSON.stringify({ pid: 999999, start: 0, token: "gone" });

test("many waiters on a dead owner's lock: one holder at a time, every trial", { timeout: 120000 }, async () => {
  let worst = 0;
  for (let trial = 0; trial < 150; trial++) {
    const dir = mkdtempSync(join(tmpdir(), "uncut-lock-race-"));
    const file = join(dir, "settings.json");
    writeFileSync(`${file}.lock`, dead());
    let holders = 0;
    let most = 0;
    const holdOnce = async () => {
      const release = await acquireFileLock(file);
      holders++;
      most = Math.max(most, holders);
      await new Promise((r) => setTimeout(r, 5));
      holders--;
      await release();
    };
    await Promise.all(Array.from({ length: 4 }, holdOnce));
    worst = Math.max(worst, most);
    assert.equal(most, 1, `trial ${trial}: ${most} holders at once`);
    assert.deepEqual(readdirSync(dir), [], `trial ${trial}: nothing left behind`);
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(worst, 1);
});

test("a release never removes a lock it no longer owns; a reused pid's long-held lock is stale, a live owner's is not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-file-lock-"));
  try {
    const file = join(dir, "recents.json");
    const release = await acquireFileLock(file);
    const someoneElse = JSON.stringify({ pid: process.ppid, start: 0, token: "other" });
    writeFileSync(`${file}.lock`, someoneElse);
    await release();
    assert.equal(readFileSync(`${file}.lock`, "utf8"), someoneElse, "the other owner's lock stays");

    // Held for a long time by a pid that is alive but started at another time: the owner is gone.
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    const taken = await tryFileLock(file);
    assert.ok(taken, "a reused pid's lock is taken over");
    await taken();

    // This process, held for a long time: still its own.
    const mine = await acquireFileLock(file);
    utimesSync(`${file}.lock`, old, old);
    assert.equal(await tryFileLock(file), undefined, "a live owner's lock is never taken, however old");
    await mine();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
