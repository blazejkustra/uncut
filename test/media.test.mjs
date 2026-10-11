// Phase 3: the Rust media core helper answers newline-delimited JSON over stdio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const BIN = "native/media/target/release/uncut-media";
const skip = existsSync(BIN) ? false : `${BIN} not built (run pnpm build)`;

test("replies to version and unknown methods, one line per request", { skip }, async () => {
  const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  const ask = async (req) => {
    proc.stdin.write(`${JSON.stringify(req)}\n`);
    return JSON.parse((await lines.next()).value);
  };
  assert.deepEqual(await ask({ id: 1, method: "version" }), { id: 1, result: { version: "0.0.1" } });
  const unknown = await ask({ id: 2, method: "decode" });
  assert.equal(unknown.id, 2);
  assert.equal(unknown.error.code, "unknown_method");
  assert.equal(unknown.result, undefined);
  proc.stdin.end();
  assert.equal(await new Promise((r) => proc.once("exit", r)), 0);
});

test("--version prints the version", { skip }, async () => {
  const { stdout } = await promisify(execFile)(BIN, ["--version"]);
  assert.equal(stdout.trim(), "uncut-media 0.0.1");
});
