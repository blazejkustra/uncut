// Issue #13 (D223), opt-in since #103 (D278): telemetry's allowlist, its inert mode without a token,
// nothing at all until the user says yes, DO_NOT_TRACK and the Settings answer, the random install
// id, crash fingerprints and spool, and the OTLP/HTTP JSON payload.
// Every send goes to a local HTTP server; nothing here can reach the real endpoint.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentFailCode, sanitize, EVENTS } from "../../apps/server/src/telemetry/events.ts";
import { crashFingerprint, frameOf } from "../../apps/server/src/telemetry/fingerprint.ts";
import { ID_FILE, INSTALL_ID, loadOrCreateId, OLD_ID_FILE } from "../../apps/server/src/telemetry/identity.ts";
import { SPOOL_FILE, crashOf, spoolCrash, takeSpooledCrashes } from "../../apps/server/src/telemetry/spool.ts";
import { withoutOtelEnv } from "../../apps/server/src/telemetry/client.ts";
import { consentOf, ENDPOINT, initTelemetry, resetTelemetry, setTelemetryChoice, targetOf, telemetryStatus, track, trackCrash, trackRendererCrash, shutdownTelemetry } from "../../apps/server/src/telemetry/telemetry.ts";

type Received = { path: string; headers: IncomingHttpHeaders; body: string };
let collector: Server;
let received: Array<Received>;
let endpoint: string;
let dataDir: string;

beforeEach(async () => {
  received = [];
  collector = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  const port = (collector.address() as { port: number }).port;
  endpoint = `http://127.0.0.1:${port}/v1/logs`;
  dataDir = mkdtempSync(join(tmpdir(), "uncut-telemetry-"));
});

afterEach(async () => {
  await resetTelemetry();
  collector.closeAllConnections();
  await new Promise<void>((resolve) => collector.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

const localEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ UNCUT_TELEMETRY_ENDPOINT: endpoint, UNCUT_TELEMETRY_TOKEN: "test-app-token-0123456789", ...extra });
const start = (env: NodeJS.ProcessEnv, token = "") => initTelemetry({ dataDir, version: "1.2.3", env, token, sink: { scheduledDelayMillis: 50 } });
/** The user said yes (the wizard's checkbox or Settings), before this run. */
const saidYes = () => writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ telemetry: { enabled: true } }));
/** Lets the id load and a batch go out (the sink sends every 50 ms here). */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 150));
  await shutdownTelemetry();
};

type KV = { key: string; value: Record<string, unknown> };
const records = () =>
  received.flatMap((r) => {
    const json = JSON.parse(r.body) as { resourceLogs: Array<{ resource: { attributes: Array<KV> }; scopeLogs: Array<{ logRecords: Array<{ body: { stringValue: string }; attributes: Array<KV>; severityText: string }> }> }> };
    return json.resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords.map((lr) => ({ resource: rl.resource, ...lr }))));
  });
const attrs = (list: Array<KV>) => Object.fromEntries(list.map((a) => [a.key, Object.values(a.value)[0]]));

// ---- the allowlist ----

test("sanitize keeps only catalogued events and allowlisted, valid attributes", () => {
  assert.equal(sanitize("file:open", { path: "/Users/me/x.mp4" }), undefined);
  assert.deepEqual(sanitize("export:complete", { duration_ms: 1234.4, codec: "h264", path: "/Users/me/out.mp4", name: "My launch video" }), { duration_ms: 1234, codec: "h264" });
  // Values outside their enum, range or pattern are dropped.
  assert.deepEqual(sanitize("export:complete", { codec: "prores", width: -1, fps: 10_000, quality: "/Users/me" }), {});
  assert.deepEqual(sanitize("export:fail", { code: "ffmpeg couldn't make the video: /Users/me/a.mov" }), {});
  assert.deepEqual(sanitize("agent:fail", { code: "rate-limit", error: "429 from api" }), { code: "rate-limit" });
  // A crash: class name and fingerprint, never a message.
  assert.deepEqual(sanitize("app:crash", { process: "server", error_name: "TypeError", crash_fingerprint: "0123456789abcdef", message: "x is undefined", stack: "at /Users/me" }), { process: "server", error_name: "TypeError", crash_fingerprint: "0123456789abcdef" });
  assert.deepEqual(sanitize("app:crash", { error_name: "Cannot read properties of undefined", crash_fingerprint: "/Users/me/x.js" }), {});
  // Base attributes are checked too.
  assert.deepEqual(sanitize("app:start", {}, { distinct_id: "me@example.com", os: "darwin", arch: "arm64", app_version: "1.0.0 (/Users/me)" }), { os: "darwin", arch: "arm64" });
  // Nothing in the catalog takes free text.
  for (const [name, validators] of Object.entries(EVENTS)) {
    for (const key of Object.keys(validators)) assert.equal(sanitize(name, { [key]: "/Users/me/Movies/secret launch.mov" })?.[key], undefined, `${name}.${key}`);
  }
});

test("agent failures become fixed codes", () => {
  assert.equal(agentFailCode("Claude usage limit reached. Send the message again once the limit resets (in 2h 5m)."), "usage-limit");
  assert.equal(agentFailCode("Claude API is overloaded (529). Try again shortly."), "overloaded");
  assert.equal(agentFailCode("Claude API rate limit reached. Try again later."), "rate-limit");
  assert.equal(agentFailCode("Claude Code isn't signed in. Run `claude auth login` in Terminal"), "signed-out");
  assert.equal(agentFailCode("Couldn't start Claude Code (/opt/bin/claude): ENOENT"), "start");
  assert.equal(agentFailCode("something about /Users/me"), "other");
  assert.equal(agentFailCode(undefined), "other");
});

// ---- crash fingerprints and the spool ----

test("crash fingerprints ignore folders, the message and the home path", () => {
  const stack = (home: string, msg: string) => `TypeError: ${msg}\n    at render (${home}/Uncut.app/Contents/Resources/server/server.mjs:120:7)\n    at async run (file://${home}/x/server.mjs:5:1)\n    at node:internal/process/task_queues:95:5`;
  const a = crashFingerprint("TypeError", stack("/Users/me", "can't read /Users/me/clip.mov"));
  const b = crashFingerprint("TypeError", stack("/Users/you", "something else"));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, b);
  assert.notEqual(a, crashFingerprint("RangeError", stack("/Users/me", "x")));
  assert.notEqual(a, crashFingerprint("TypeError", stack("/Users/me", "x").replace(":120:7", ":121:7")));
  assert.equal(frameOf("    at Object.<anonymous> (/Users/me/a/b.js:1:2)"), "Object.<anonymous>@b.js:1:2");
  // (Joined so the repo's e-mail scan doesn't take the frame for an address.)
  assert.equal(frameOf("onClick@http://127.0.0.1:5173/assets/index-abc.js?v=1:10:20"), ["onClick", "index-abc.js:10:20"].join("@"));
  // A Safari-style stack ("fn@url:line:col") is stable across hosts and folders too.
  assert.equal(crashFingerprint("Error", "f@https://a.example/x.js:1:2"), crashFingerprint("Error", "f@file:///Users/me/x.js:1:2"));
});

test("the spool keeps only crash fields and is emptied when read", () => {
  const error = Object.assign(new Error("ENOENT: no such file /Users/me/clip.mov"), { code: "ENOENT" });
  spoolCrash(dataDir, crashOf("main", error, true));
  spoolCrash(dataDir, { process: "renderer", error_name: "crashed", code: "11" });
  const text = readFileSync(join(dataDir, SPOOL_FILE), "utf8");
  assert.doesNotMatch(text, /Users|clip|no such file/);
  const taken = takeSpooledCrashes(dataDir);
  assert.equal(taken.length, 2);
  assert.deepEqual(Object.keys(taken[0]!).sort(), ["code", "crash_fingerprint", "error_name", "fatal", "process"]);
  assert.equal(existsSync(join(dataDir, SPOOL_FILE)), false);
  assert.deepEqual(takeSpooledCrashes(dataDir), []);
});

// ---- consent, the token and the id ----

test("consent: DO_NOT_TRACK, then UNCUT_TELEMETRY, then the user's answer; never answered is no", () => {
  assert.deepEqual(consentOf({}, undefined), { enabled: false, source: "default" });
  assert.deepEqual(consentOf({ UNCUT_TELEMETRY: "on" }, undefined), { enabled: false, source: "default" }, "the environment can't say yes for the user");
  assert.deepEqual(consentOf({ DO_NOT_TRACK: "1" }, true), { enabled: false, source: "do-not-track" });
  assert.deepEqual(consentOf({ DO_NOT_TRACK: "true" }, undefined), { enabled: false, source: "do-not-track" });
  assert.deepEqual(consentOf({ DO_NOT_TRACK: "0" }, true), { enabled: true, source: "settings" });
  assert.deepEqual(consentOf({ UNCUT_TELEMETRY: "off" }, true), { enabled: false, source: "env" });
  assert.deepEqual(consentOf({}, false), { enabled: false, source: "settings" });
  assert.deepEqual(consentOf({}, true), { enabled: true, source: "settings" });
});

test("the target: none without a token; an override only to loopback with its own token", () => {
  assert.equal(targetOf({}, ""), undefined);
  assert.deepEqual(targetOf({}, "built-in"), { endpoint: ENDPOINT, token: "built-in" });
  assert.equal(targetOf({ UNCUT_TELEMETRY_ENDPOINT: "https://evil.example/v1/logs", UNCUT_TELEMETRY_TOKEN: "t" }, "built-in"), undefined);
  // The built-in token never goes to an overridden endpoint.
  assert.equal(targetOf({ UNCUT_TELEMETRY_ENDPOINT: endpoint }, "built-in"), undefined);
  assert.deepEqual(targetOf({ UNCUT_TELEMETRY_ENDPOINT: endpoint, UNCUT_TELEMETRY_TOKEN: "t" }, ""), { endpoint, token: "t" });
});

test("the install id is a random UUID, kept 0600 and reused; the old hardware-derived id is deleted", async () => {
  writeFileSync(join(dataDir, OLD_ID_FILE), `${"a".repeat(64)}\n`);
  const id = await loadOrCreateId(dataDir);
  assert.match(id, INSTALL_ID);
  assert.equal(existsSync(join(dataDir, OLD_ID_FILE)), false, "D223's IOPlatformUUID HMAC is gone");
  assert.equal(statSync(join(dataDir, ID_FILE)).mode & 0o777, 0o600);
  assert.equal(await loadOrCreateId(dataDir), id);
  const other = mkdtempSync(join(tmpdir(), "uncut-telemetry-"));
  try {
    assert.notEqual(await loadOrCreateId(other), id, "not derived from the machine");
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("never answered: nothing sent (not even app:start) and no id, even with a token", async () => {
  spoolCrash(dataDir, { process: "main", error_name: "TypeError" });
  start(localEnv({ UNCUT_TELEMETRY: "on" }));
  track("agent:turn", { outcome: "done" });
  trackCrash("server", new Error("boom"));
  await settle();
  assert.equal(received.length, 0);
  assert.equal(existsSync(join(dataDir, ID_FILE)), false);
  assert.equal(existsSync(join(dataDir, SPOOL_FILE)), false, "the spooled crash is dropped, not kept for later");
  assert.deepEqual(telemetryStatus(), { enabled: false, source: "default", configured: true });
});

test("saying yes mid-run (the setup wizard) sends this run's app:start, then events", async () => {
  start(localEnv());
  track("agent:turn", { outcome: "done" });
  setTelemetryChoice(true);
  track("agent:turn", { outcome: "cancelled" });
  await settle();
  assert.deepEqual(records().map((r) => r.body.stringValue), ["app:start", "agent:turn"]);
  assert.equal(attrs(records()[1]!.attributes).outcome, "cancelled");
  assert.match(String(attrs(records()[0]!.attributes).distinct_id), INSTALL_ID);
});

// ---- end to end against a local collector ----

test("without a token telemetry is inert: nothing sent, no id, the crash spool dropped", async () => {
  spoolCrash(dataDir, { process: "main", error_name: "TypeError" });
  start({});
  track("export:complete", { duration_ms: 10 });
  trackCrash("server", new Error("boom"));
  await settle();
  assert.equal(received.length, 0);
  assert.equal(existsSync(join(dataDir, ID_FILE)), false);
  assert.equal(existsSync(join(dataDir, SPOOL_FILE)), false);
  assert.deepEqual(telemetryStatus(), { enabled: false, source: "default", configured: false });
});

test("DO_NOT_TRACK sends nothing and makes no id, even with a token", async () => {
  start(localEnv({ DO_NOT_TRACK: "1" }), "built-in-token");
  track("agent:turn", { outcome: "done" });
  await settle();
  assert.equal(received.length, 0);
  assert.equal(existsSync(join(dataDir, ID_FILE)), false);
  assert.equal(telemetryStatus().source, "do-not-track");
});

test("a no in Settings holds until turned to yes", async () => {
  writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ telemetry: { enabled: false } }));
  start(localEnv());
  track("agent:turn", { outcome: "done" });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(received.length, 0);
  assert.deepEqual(telemetryStatus(), { enabled: false, source: "settings", configured: true });
  setTelemetryChoice(true);
  track("agent:turn", { outcome: "cancelled" });
  await settle();
  const names = records().map((r) => r.body.stringValue);
  assert.deepEqual(names, ["app:start", "agent:turn"]);
  assert.equal(attrs(records()[1]!.attributes).outcome, "cancelled");
});

test("payload: OTLP/HTTP JSON logs, Bearer token, sanitized attributes, the user's OTEL headers kept out", async () => {
  const saved = { headers: process.env.OTEL_EXPORTER_OTLP_HEADERS, logs: process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS };
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-leak=developer-secret";
  process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = "x-leak-logs=developer-secret";
  try {
    spoolCrash(dataDir, crashOf("main", new TypeError("x of /Users/me/y")));
    saidYes();
    start(localEnv());
    track("export:complete", { duration_ms: 4200, codec: "hevc", quality: "high", path: "/Users/me/out.mp4" } as never);
    track("export:fail", { code: "encode", duration_ms: 12 });
    trackRendererCrash("RangeError", "RangeError: bad /Users/me\n    at f (http://127.0.0.1:1/assets/index.js:1:2)");
    trackRendererCrash("RangeError", "RangeError: bad /Users/me\n    at f (http://127.0.0.1:1/assets/index.js:1:2)");
    await settle();
    // Restored for the tools the server starts.
    assert.equal(process.env.OTEL_EXPORTER_OTLP_HEADERS, "x-leak=developer-secret");
  } finally {
    if (saved.headers === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = saved.headers;
    if (saved.logs === undefined) delete process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS = saved.logs;
  }
  assert.ok(received.length >= 1);
  for (const r of received) {
    assert.equal(r.path, "/v1/logs");
    assert.equal(r.headers.authorization, "Bearer test-app-token-0123456789");
    assert.match(String(r.headers["content-type"]), /^application\/json/);
    assert.equal(r.headers["x-leak"], undefined);
    assert.equal(r.headers["x-leak-logs"], undefined);
    assert.doesNotMatch(r.body, /Users|out\.mp4|developer-secret|bad /);
  }
  const all = records();
  assert.deepEqual(all.map((r) => r.body.stringValue).sort(), ["app:crash", "app:crash", "app:start", "export:complete", "export:fail"]);
  assert.equal(attrs(all[0]!.resource.attributes)["service.name"], "uncut");
  const id = readFileSync(join(dataDir, ID_FILE), "utf8").trim();
  assert.match(id, INSTALL_ID);
  const sessions = new Set<unknown>();
  for (const r of all) {
    const a = attrs(r.attributes);
    assert.equal(a["event.name"], r.body.stringValue);
    assert.equal(a.distinct_id, id);
    assert.equal(a.app_version, "1.2.3");
    assert.match(String(a.session_id), /^[0-9a-f-]{36}$/);
    assert.ok(["darwin", "linux", "win32", "other"].includes(String(a.os)));
    assert.ok(["arm64", "x64", "other"].includes(String(a.arch)));
    assert.equal(r.severityText, "INFO");
    sessions.add(a.session_id);
  }
  assert.equal(sessions.size, 1);
  const complete = attrs(all.find((r) => r.body.stringValue === "export:complete")!.attributes);
  assert.equal(complete.codec, "hevc");
  assert.equal(Number(complete.duration_ms), 4200);
  assert.equal(complete.path, undefined);
  assert.equal(attrs(all.find((r) => r.body.stringValue === "export:fail")!.attributes).code, "encode");
  const crashes = all.filter((r) => r.body.stringValue === "app:crash").map((r) => attrs(r.attributes));
  // The renderer's repeat is sent once; the spooled main crash arrives with its fingerprint.
  assert.deepEqual(crashes.map((c) => c.process).sort(), ["main", "renderer"]);
  for (const c of crashes) assert.match(String(c.crash_fingerprint), /^[0-9a-f]{16}$/);
  assert.deepEqual(crashes.map((c) => c.error_name).sort(), ["RangeError", "TypeError"]);
});

test("an unreachable endpoint never throws and shutdown stays bounded", async () => {
  const port = (collector.address() as { port: number }).port;
  collector.closeAllConnections();
  await new Promise<void>((resolve) => collector.close(() => resolve()));
  collector = createServer().listen(0); // something for afterEach to close
  saidYes();
  start({ UNCUT_TELEMETRY_ENDPOINT: `http://127.0.0.1:${port}/v1/logs`, UNCUT_TELEMETRY_TOKEN: "t" });
  for (let i = 0; i < 200; i++) track("agent:turn", { outcome: "done", duration_ms: i });
  const t0 = Date.now();
  await settle();
  assert.ok(Date.now() - t0 < 2500, `shutdown took ${Date.now() - t0} ms`);
});

test("withoutOtelEnv hides every OTEL_ variable only while the SDK reads its config", () => {
  const env: NodeJS.ProcessEnv = { OTEL_EXPORTER_OTLP_HEADERS: "a=b", OTEL_EXPORTER_OTLP_CLIENT_KEY: "/k", PATH: "/bin" };
  const seen = withoutOtelEnv(() => Object.keys(env).sort(), env);
  assert.deepEqual(seen, ["PATH"]);
  assert.deepEqual(env, { OTEL_EXPORTER_OTLP_HEADERS: "a=b", OTEL_EXPORTER_OTLP_CLIENT_KEY: "/k", PATH: "/bin" });
});
