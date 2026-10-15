// Issue #13: the Cloudflare Worker in front of Grafana Cloud. Its fetch handler runs here with a
// fake env, a fake rate limiter and a stubbed upstream fetch; nothing reaches the network.
import { test } from "node:test";
import assert from "node:assert/strict";

import worker, { handleRequest, memoryLimiter, MAX_BODY_BYTES, MAX_RECORDS, type Deps, type Env, type RateLimiter } from "../../infra/telemetry-proxy/src/index.ts";

const APP_TOKEN = "a".repeat(64);
const NEXT_TOKEN = "b".repeat(64);
const allow: RateLimiter = { limit: async () => ({ success: true }) };
const env = (over: Partial<Env> = {}): Env => ({
  GRAFANA_OTLP_URL: "https://otlp.example.test/otlp",
  GRAFANA_INSTANCE_ID: "1876240",
  GRAFANA_TOKEN: "glc_secret",
  APP_TOKEN,
  RATE_LIMITER: allow,
  ...over,
});

type Call = { url: string; init: RequestInit };
function upstream(status = 204, body = "upstream secret details") {
  const calls: Array<Call> = [];
  const fetch: NonNullable<Deps["upstreamFetch"]> = async (url, init) => {
    calls.push({ url, init });
    return new Response(status === 204 ? null : body, { status });
  };
  return { calls, fetch };
}

function payload(records = 1, service = "uncut") {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
        scopeLogs: [{ logRecords: Array.from({ length: records }, () => ({ body: { stringValue: "app:start" }, attributes: [] })) }],
      },
    ],
  });
}

function req(opts: { method?: string; path?: string; token?: string | null; body?: BodyInit | null; type?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": opts.type ?? "application/json", "cf-connecting-ip": "203.0.113.7", ...opts.headers };
  const token = opts.token === undefined ? APP_TOKEN : opts.token;
  if (token !== null && !opts.headers?.authorization) headers.authorization = `Bearer ${token}`;
  const method = opts.method ?? "POST";
  const body = method === "GET" || method === "HEAD" ? undefined : opts.body === undefined ? payload() : opts.body ?? undefined;
  return new Request(`https://uncut-telemetry.example.workers.dev${opts.path ?? "/v1/logs"}`, { method, headers, body });
}

async function run(r: Request, e: Env = env(), up = upstream()) {
  const res = await handleRequest(r, e, { upstreamFetch: up.fetch });
  return { res, up, text: await res.text() };
}

test("a valid request is forwarded to Grafana with Basic auth and answered 204", async () => {
  const { res, up, text } = await run(req());
  assert.equal(res.status, 204);
  assert.equal(text, "");
  assert.equal(up.calls.length, 1);
  const { url, init } = up.calls[0];
  assert.equal(url, "https://otlp.example.test/otlp/v1/logs");
  assert.equal(init.method, "POST");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), `Basic ${Buffer.from("1876240:glc_secret").toString("base64")}`);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(new TextDecoder().decode(init.body as Uint8Array), payload());
});

test("only content-type and authorization go upstream: no client IP, user agent or cookies", async () => {
  const { up } = await run(req({ headers: { "user-agent": "Uncut/1.0", cookie: "a=b", "x-forwarded-for": "203.0.113.7", "x-extra": "1" } }));
  const headers = new Headers(up.calls[0].init.headers);
  assert.deepEqual([...headers.keys()].sort(), ["authorization", "content-type"]);
});

test("a trailing slash on GRAFANA_OTLP_URL doesn't double up", async () => {
  const { up } = await run(req(), env({ GRAFANA_OTLP_URL: "https://otlp.example.test/otlp/" }));
  assert.equal(up.calls[0].url, "https://otlp.example.test/otlp/v1/logs");
});

test("protobuf bodies pass through unvalidated with their content type", async () => {
  const bytes = new Uint8Array([0x0a, 0x02, 0x08, 0x01]);
  const { res, up } = await run(req({ type: "application/x-protobuf", body: bytes }));
  assert.equal(res.status, 204);
  assert.equal(new Headers(up.calls[0].init.headers).get("content-type"), "application/x-protobuf");
  assert.deepEqual([...(up.calls[0].init.body as Uint8Array)], [...bytes]);
});

test("missing, malformed or wrong tokens get 401 and nothing goes upstream", async () => {
  for (const r of [req({ token: null }), req({ token: "wrong".repeat(13) }), req({ token: APP_TOKEN + "x" }), req({ token: APP_TOKEN.slice(1) }), req({ headers: { authorization: `Basic ${APP_TOKEN}` } }), req({ headers: { authorization: `Bearer  ${APP_TOKEN}` } })]) {
    const { res, up } = await run(r);
    assert.equal(res.status, 401);
    assert.equal(up.calls.length, 0);
  }
});

test("APP_TOKEN_NEXT is accepted for rotation; an unset or short slot never matches", async () => {
  assert.equal((await run(req({ token: NEXT_TOKEN }), env({ APP_TOKEN_NEXT: NEXT_TOKEN }))).res.status, 204);
  assert.equal((await run(req({ token: APP_TOKEN }), env({ APP_TOKEN_NEXT: NEXT_TOKEN }))).res.status, 204);
  assert.equal((await run(req({ token: NEXT_TOKEN }))).res.status, 401);
  assert.equal((await run(req({ token: "short" }), env({ APP_TOKEN: "short" }))).res.status, 401);
  assert.equal((await run(req({ token: "" }), env({ APP_TOKEN: "" }))).res.status, 401);
});

test("other paths are 404 and other methods are 405", async () => {
  assert.equal((await run(req({ path: "/" }))).res.status, 404);
  assert.equal((await run(req({ path: "/v1/traces" }))).res.status, 404);
  assert.equal((await run(req({ path: "/v1/logs/" }))).res.status, 404);
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const { res, up } = await run(req({ method }));
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "POST");
    assert.equal(up.calls.length, 0);
  }
});

test("unsupported content types get 415", async () => {
  for (const type of ["text/plain", "application/x-www-form-urlencoded", ""]) assert.equal((await run(req({ type, body: "x" }))).res.status, 415, type);
  assert.equal((await run(req({ type: "application/json; charset=utf-8" }))).res.status, 204);
});

test("bodies over 256 KB get 413, with or without Content-Length", async () => {
  const big = "x".repeat(MAX_BODY_BYTES + 1);
  assert.equal((await run(req({ body: big }))).res.status, 413);
  assert.equal((await run(req({ type: "application/x-protobuf", body: big, headers: { "content-length": String(MAX_BODY_BYTES + 1) } }))).res.status, 413);
  // A stream has no Content-Length, so the cap applies while reading.
  const chunk = new Uint8Array(64 * 1024);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent > MAX_BODY_BYTES * 4) return c.close();
      sent += chunk.byteLength;
      c.enqueue(chunk);
    },
  });
  const r = new Request("https://uncut-telemetry.example.workers.dev/v1/logs", { method: "POST", body: stream, headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/x-protobuf" }, duplex: "half" } as RequestInit);
  const { res, up } = await run(r);
  assert.equal(res.status, 413);
  assert.equal(up.calls.length, 0);
  assert.ok(sent < MAX_BODY_BYTES * 2, "stopped reading soon after the cap");
});

test("JSON validation: service.name must be uncut, records 1..100, OTLP shape", async () => {
  assert.equal((await run(req({ body: payload(MAX_RECORDS) }))).res.status, 204);
  const bad = [payload(MAX_RECORDS + 1), payload(1, "other"), payload(0), "{", "[]", "{}", JSON.stringify({ resourceLogs: [{ scopeLogs: [] }] }), ""];
  for (const body of bad) {
    const { res, up } = await run(req({ body }));
    assert.equal(res.status, 400, body.slice(0, 60));
    assert.equal(up.calls.length, 0);
  }
});

test("upstream errors become a bare 502 (or 429) and are never echoed", async () => {
  for (const [status, expected] of [[400, 502], [401, 502], [500, 502], [429, 429]] as const) {
    const { res, text } = await run(req(), env(), upstream(status));
    assert.equal(res.status, expected);
    assert.equal(text, "");
  }
  const failing: Deps["upstreamFetch"] = async () => {
    throw new Error("connect ECONNREFUSED upstream secret");
  };
  const res = await handleRequest(req(), env(), { upstreamFetch: failing });
  assert.equal(res.status, 502);
  assert.equal(await res.text(), "");
});

test("missing Grafana secrets give 503 without calling upstream", async () => {
  const { res, up } = await run(req(), env({ GRAFANA_TOKEN: "" }));
  assert.equal(res.status, 503);
  assert.equal(up.calls.length, 0);
});

test("the rate limiter is keyed by client IP and a refusal is 429 before reading the body", async () => {
  const keys: Array<string> = [];
  const deny: RateLimiter = {
    limit: async ({ key }) => {
      keys.push(key);
      return { success: false };
    },
  };
  const { res, up, text } = await run(req(), env({ RATE_LIMITER: deny }));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.equal(text, "");
  assert.deepEqual(keys, ["203.0.113.7"]);
  assert.equal(up.calls.length, 0);
});

test("without the binding, the in-memory limiter allows 60 a minute per IP", async () => {
  let now = 1_000_000;
  const limiter = memoryLimiter(60, 60_000, () => now);
  const e = env({ RATE_LIMITER: undefined });
  const up = upstream();
  const send = (ip: string) => handleRequest(req({ headers: { "cf-connecting-ip": ip } }), e, { upstreamFetch: up.fetch, fallbackLimiter: limiter });
  for (let i = 0; i < 60; i++) assert.equal((await send("198.51.100.1")).status, 204);
  assert.equal((await send("198.51.100.1")).status, 429);
  assert.equal((await send("198.51.100.2")).status, 204);
  now += 60_000;
  assert.equal((await send("198.51.100.1")).status, 204);
});

test("the default export is a Workers module with a fetch handler", async () => {
  const res = await worker.fetch(req({ method: "GET" }), env());
  assert.equal(res.status, 405);
});
