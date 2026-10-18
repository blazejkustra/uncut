// The local server's own log (<dataDir>/server.log): a packaged app's stdout and stderr go nowhere,
// so the desktop keeps the server's output, when it started and how it ended there; the server
// adds event-loop stalls and a heartbeat with memory, so a server that froze without dying shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SERVER_LOG, serverLog, startServer } from "../../apps/desktop/src/server.ts";
import { watchLiveness } from "../../apps/server/src/app/liveness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tempDir = () => mkdtempSync(join(tmpdir(), "uncut-server-log-"));
const keys = { encrypt: (t: string) => t, decrypt: (d: string) => d };
const fakeServer = (dir: string, body: string) => {
  const entry = join(dir, "fake-server.mjs");
  writeFileSync(entry, body);
  return entry;
};
const start = (dir: string, entry: string, onExit: (reason: string) => void) =>
  startServer({ serverEntry: entry, mediaBin: "", modulesDir: "", sfxDir: "", graphicLibsDir: "", fontsDir: "", bundledPluginsDir: "", pluginSdkDir: "", dataDir: dir, renderEntry: undefined, onExit, keys });

test("a server that dies leaves its stderr and its exit in server.log", async () => {
  const dir = tempDir();
  try {
    const entry = fakeServer(
      dir,
      `process.stdout.write("starting up\\n");
process.stdout.write(JSON.stringify({ ready: true, port: 4567 }) + "\\n");
setTimeout(() => {
  process.stdout.write("after ready\\n");
  process.stderr.write("TypeError: boom\\n    at somewhere (x.ts:1:1)\\n", () => process.exit(3));
}, 50);
setInterval(() => {}, 1000);
`,
    );
    const reasons: Array<string> = [];
    const server = start(dir, entry, (reason) => reasons.push(reason));
    assert.equal((await server.connection).url, "ws://127.0.0.1:4567/ws");
    for (let i = 0; i < 100 && !reasons.length; i++) await sleep(20);
    assert.deepEqual(reasons, ["server exited unexpectedly (code 3)"]);
    for (let i = 0; i < 100 && !readFileSync(join(dir, SERVER_LOG), "utf8").includes("exited unexpectedly"); i++) await sleep(20);
    const log = readFileSync(join(dir, SERVER_LOG), "utf8");
    for (const want of ["[desktop] server started (pid", "starting up", "[desktop] server ready on port 4567", "after ready", "TypeError: boom", "    at somewhere (x.ts:1:1)", "[desktop] server exited unexpectedly (code 3)"]) assert.ok(log.includes(want), `missing ${want}:\n${log}`);
    // Every line is timestamped.
    for (const line of log.trimEnd().split("\n")) assert.match(line, /^\d{4}-\d\d-\d\dT[\d:.]+Z /);
    // The crash's stack comes before the verdict.
    assert.ok(log.indexOf("TypeError: boom") < log.indexOf("exited unexpectedly"), log);
    // The ready line (the port handshake) isn't output worth keeping.
    assert.ok(!log.includes('"ready"'), log);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a server that won't take SIGTERM is logged as killed", async () => {
  const dir = tempDir();
  try {
    const entry = fakeServer(
      dir,
      `process.on("SIGTERM", () => {});
process.stdout.write(JSON.stringify({ ready: true, port: 4568 }) + "\\n");
setInterval(() => {}, 1000);
`,
    );
    const reasons: Array<string> = [];
    const server = start(dir, entry, (reason) => reasons.push(reason));
    await server.connection;
    await server.stop();
    await sleep(50);
    assert.deepEqual(reasons, []);
    const log = readFileSync(join(dir, SERVER_LOG), "utf8");
    assert.ok(log.includes("[desktop] stopping the server (SIGTERM)"), log);
    assert.ok(log.includes("after SIGTERM (its event loop is blocked?); killing it"), log);
    assert.ok(log.includes("[desktop] server stopped (SIGKILL)"), log);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a server that exits before it's ready says so in server.log", async () => {
  const dir = tempDir();
  try {
    const entry = fakeServer(dir, `process.stderr.write("can't listen\\n", () => process.exit(1));\n`);
    const server = start(dir, entry, () => {});
    await assert.rejects(server.connection, /exited before it was ready \(code 1\)/);
    await sleep(50);
    const log = readFileSync(join(dir, SERVER_LOG), "utf8");
    assert.ok(log.includes("can't listen"), log);
    assert.ok(log.includes("[desktop] server exited before it was ready (code 1)"), log);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server.log moves to server.log.1 past its size cap", () => {
  const dir = tempDir();
  try {
    const log = serverLog(dir, 100);
    for (let i = 0; i < 6; i++) log(`line ${i} ${"x".repeat(30)}`);
    const now = readFileSync(join(dir, SERVER_LOG), "utf8");
    assert.ok(existsSync(join(dir, `${SERVER_LOG}.1`)));
    assert.ok(now.includes("line 5"), now);
    assert.ok(!now.includes("line 0"), now);
    // A missing data dir isn't an error.
    serverLog(join(dir, "missing", "deeper"))("nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the server notes event-loop stalls and a heartbeat with memory", async () => {
  const lines: Array<string> = [];
  const stop = watchLiveness({ write: (l) => lines.push(l), tickMs: 20, stallMs: 150, heartbeatMs: 40 });
  try {
    await sleep(120);
    assert.ok(lines.some((l) => /^\[uncut\] alive \(rss \d+ MB, heap \d+\/\d+ MB\)$/.test(l)), lines.join("\n"));
    assert.ok(!lines.some((l) => l.includes("stalled")), lines.join("\n"));
    const until = Date.now() + 400;
    while (Date.now() < until) {} // synchronous work holding the event loop
    await sleep(60);
    assert.ok(lines.some((l) => /^\[uncut\] event loop stalled for 0\.[3-9] s \(rss \d+ MB/.test(l)), lines.join("\n"));
  } finally {
    stop();
  }
});
