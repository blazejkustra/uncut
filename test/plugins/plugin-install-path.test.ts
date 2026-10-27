// The repo's process plugins start from an install path with a space (/Applications/Uncut Nightly.app,
// a renamed app, a home folder with a space): each answers initialize, as the host starts it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const PLUGINS = ["whisper-transcribe", "argent-capture", "catalog/uncut-link-import"];
const REGISTER = pathToFileURL(resolve("packages/plugin-sdk/src/register.ts")).href;
const root = realpathSync(mkdtempSync(join(tmpdir(), "uncut-plugin-path-")));
after(() => rmSync(root, { recursive: true, force: true }));

type InitResult = { serverInfo: { name: string } };

function initialize(dir: string): Promise<InitResult> {
  const child = spawn(process.execPath, ["--import", REGISTER, "server.ts"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise<InitResult>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`no answer to initialize; stderr ${stderr}`)), 10000);
    child.once("exit", (code) => fail(new Error(`exited (${code}) without answering initialize; stderr ${stderr}`)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      clearTimeout(timer);
      done(JSON.parse(line).result);
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } })}\n`,
    );
  }).finally(() => child.kill());
}

for (const plugin of PLUGINS) {
  test(`${plugin} starts from a folder with a space in its path`, { timeout: 20000 }, async () => {
    const dir = join(root, "Uncut Nightly.app", "Contents", "Resources", "plugins", plugin);
    cpSync(resolve("plugins", plugin), dir, { recursive: true });
    const id = (JSON.parse(readFileSync(join(dir, "uncut.module.json"), "utf8")) as { id: string }).id;
    assert.equal((await initialize(dir)).serverInfo.name, id);
  });
}
