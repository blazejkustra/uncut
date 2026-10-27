// Several projects at once: every window has its own server, all on one data dir. recents.json
// and settings.json are read again and written holding a lock file, so two servers writing at
// once never drop each other's changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.equal(readFileSync(`${file}.lock`, "utf8"), String(process.pid));

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
