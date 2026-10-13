// Phase 3: the bundled server starts on a random port, guards /ws with a token and answers
// server.hello over Effect RPC (JSON frames), asking the media core for its version.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import { connect, killAll, openSocket, startServer as start, type Ready, type StartOptions } from "../helpers/server.ts";

const BUNDLE = "apps/server/dist/server.mjs";
const MEDIA = resolve("native/media/target/release/uncut-media");
const skip = existsSync(BUNDLE) && existsSync(MEDIA) ? false : "server bundle or media core not built (run pnpm build)";
const T = { skip, timeout: 20000 };

let dir: string, server: ChildProcess, ready: Ready;

// The bundle runs from a temp dir with no node_modules around it, as in the packaged app.
const startServer = (env: NodeJS.ProcessEnv, opts: StartOptions = {}) => start({ entry: join(dir, "server.mjs"), env: { UNCUT_DATA_DIR: join(dir, "data"), ...env }, ...opts });

async function rpc(url: string, request: { tag: string; payload?: unknown }) {
  const { port, searchParams } = new URL(url);
  const client = await connect(Number(port), searchParams.get("token")!);
  try {
    return await client.call(request.tag, request.payload);
  } finally {
    client.close();
  }
}

const fakeMedia = (name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nread line\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

const hello = async (r: Ready, token = r.token) => rpc(`ws://127.0.0.1:${r.port}/ws?token=${token}`, { tag: "server.hello" });

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "uncut-server-"));
  cpSync(BUNDLE, join(dir, "server.mjs"));
  ({ proc: server, ready } = await startServer({ UNCUT_MEDIA_BIN: MEDIA }));
});
after(() => {
  killAll();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("prints one ready line with the port and the token it generated", T, () => {
  assert.equal(ready.ready, true);
  assert.ok(ready.port > 0);
  assert.match(ready.token, /^[\w-]{20,}$/);
});

test("server.hello reports server, node, pid and media core versions", T, async () => {
  const exit = await hello(ready);
  assert.equal(exit._tag, "Success");
  const { graphicToken, ...rest } = exit.value;
  assert.deepEqual(rest, { version: "0.0.1", node: process.versions.node, pid: server.pid, mediaCore: { version: "0.0.1" } });
  // The graphic documents' secret (D78): derived from the token, never the token itself.
  assert.match(graphicToken, /^[\w-]{43}$/);
  assert.notEqual(graphicToken, ready.token);
});

test("a wrong or missing token is refused before the upgrade", T, async () => {
  for (const query of ["?token=wrong", ""]) {
    const res = await fetch(`http://127.0.0.1:${ready.port}/ws${query}`);
    assert.equal(res.status, 401);
    await assert.rejects(openSocket(`ws://127.0.0.1:${ready.port}/ws${query}`));
  }
});

test("UNCUT_TOKEN from the environment is used and not echoed", T, async () => {
  const { ready: r } = await startServer({ UNCUT_MEDIA_BIN: MEDIA, UNCUT_TOKEN: "given-token-123" });
  assert.equal(r.token, undefined);
  assert.equal((await hello(r, "given-token-123"))._tag, "Success");
});

test("--bootstrap-fd delivers the token over a pipe, not the environment", T, async () => {
  const { ready: r } = await startServer({ UNCUT_MEDIA_BIN: MEDIA }, { args: ["--bootstrap-fd", "3"], bootstrap: '{"token":"piped-token"}\n' });
  assert.equal(r.token, undefined);
  assert.equal((await hello(r, "piped-token"))._tag, "Success");
  assert.equal((await fetch(`http://127.0.0.1:${r.port}/ws?token=wrong`)).status, 401);
});

test("children don't inherit ELECTRON_RUN_AS_NODE or the token", T, async () => {
  const bin = fakeMedia("env-media", 'echo "{\\"id\\":1,\\"result\\":{\\"version\\":\\"${ELECTRON_RUN_AS_NODE:-unset}/${UNCUT_TOKEN:-unset}\\"}}"');
  const { ready: r } = await startServer({ UNCUT_MEDIA_BIN: bin, UNCUT_TOKEN: "secret", ELECTRON_RUN_AS_NODE: "1" });
  const exit = await hello(r, "secret");
  assert.equal(exit._tag, "Success");
  assert.equal(exit.value.mediaCore.version, "unset/unset");
});

test("a missing or misbehaving media core is a typed failure, not a crash", { ...T, timeout: 60000 }, async () => {
  const cases = {
    missing: join(dir, "nope"),
    null: fakeMedia("null-media", "echo null"),
    garbage: fakeMedia("garbage-media", "echo 'not json at all'"),
    array: fakeMedia("array-media", "echo '[1,2]'"),
    "null error": fakeMedia("nullerr-media", 'echo \'{"id":1,"error":null}\''),
    "no version": fakeMedia("nover-media", 'echo \'{"id":1,"result":null}\''),
    silent: fakeMedia("silent-media", "exit 3"),
  };
  for (const [name, bin] of Object.entries(cases)) {
    const { proc, ready: r } = await startServer({ UNCUT_MEDIA_BIN: bin, UNCUT_TOKEN: "t" });
    const exit = await hello(r, "t");
    assert.equal(exit._tag, "Failure", name);
    assert.equal(exit.cause.length, 1, name);
    assert.equal(exit.cause[0]._tag, "Fail", `${name}: ${JSON.stringify(exit.cause)}`);
    assert.equal(exit.cause[0].error._tag, "MediaCoreError", name);
    assert.equal(proc.exitCode, null, name);
    proc.kill();
  }
});

test("SIGTERM exits within a second even with a client connected", T, async () => {
  const { proc, ready: r, exited } = await startServer({ UNCUT_MEDIA_BIN: MEDIA });
  const ws = await openSocket(`ws://127.0.0.1:${r.port}/ws?token=${r.token}`);
  const closed = new Promise((res) => (ws.onclose = res));
  const sent = Date.now();
  proc.kill("SIGTERM");
  const { at } = await exited;
  assert.ok(at - sent <= 1200, `took ${at - sent} ms`);
  await closed;
});

test("--exit-with-stdin exits when the parent's pipe closes", T, async () => {
  const { proc, exited } = await startServer({ UNCUT_MEDIA_BIN: MEDIA }, { args: ["--exit-with-stdin"] });
  const sent = Date.now();
  proc.stdin!.end();
  const { at } = await exited;
  assert.ok(at - sent <= 1200, `took ${at - sent} ms`);
});
