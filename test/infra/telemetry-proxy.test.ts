// Issue #13: the Cloudflare Worker in front of Grafana Cloud. Its fetch handler runs here with a
// fake env, a fake rate limiter and a stubbed upstream fetch; nothing reaches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker, { dailySalt, handleRequest, memoryLimiter, MAX_BODY_BYTES, MAX_RECORDS, SALT_TTL_S, visitorOf, type Deps, type Env, type RateLimiter, type SaltStore } from "../../infra/telemetry-proxy/src/index.ts";

const APP_TOKEN = "a".repeat(64);
const NEXT_TOKEN = "b".repeat(64);
const allow: RateLimiter = { limit: async () => ({ success: true }) };
const env = (over: Partial<Env> = {}): Env => ({
  GRAFANA_OTLP_URL: "https://otlp.example.test/otlp",
  GRAFANA_INSTANCE_ID: "100001",
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
  assert.equal(headers.get("authorization"), `Basic ${Buffer.from("100001:glc_secret").toString("base64")}`);
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
  for (const over of [{ GRAFANA_TOKEN: "" }, { GRAFANA_INSTANCE_ID: "" }]) {
    const { res, up } = await run(req(), env(over));
    assert.equal(res.status, 503);
    assert.equal(up.calls.length, 0);
  }
});

test("the Grafana instance id is a Worker secret, not a var in wrangler.toml", () => {
  const toml = readFileSync(new URL("../../infra/telemetry-proxy/wrangler.toml", import.meta.url), "utf8");
  assert.doesNotMatch(toml, /^\s*GRAFANA_INSTANCE_ID\s*=/m);
  assert.match(toml, /Secrets \(wrangler secret put\): GRAFANA_INSTANCE_ID/);
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

// ---- daily unique users (D283) ----

/** An in-memory KV that records what was put and with which TTL. */
function kv() {
  const data = new Map<string, string>();
  const puts: Array<{ key: string; ttl: number }> = [];
  const store: SaltStore = {
    get: async (key) => data.get(key) ?? null,
    put: async (key, value, { expirationTtl }) => {
      data.set(key, value);
      puts.push({ key, ttl: expirationTtl });
    },
  };
  return { store, data, puts };
}
const day1 = new Date("2026-10-16T08:00:00Z");
const day1Late = new Date("2026-10-16T23:59:59Z");
const day2 = new Date("2026-10-17T00:00:01Z");
const forwarded = (up: ReturnType<typeof upstream>, i = 0) => JSON.parse(new TextDecoder().decode(up.calls[i]!.init.body as Uint8Array)) as { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }> }> }> };
const visitors = (up: ReturnType<typeof upstream>, i = 0) => forwarded(up, i).resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords.map((lr) => lr.attributes.find((a) => a.key === "visitor_day")?.value.stringValue)));
async function send(e: Env, now: Date, ip = "203.0.113.7", records = 2) {
  const up = upstream();
  const res = await handleRequest(req({ body: payload(records), headers: { "cf-connecting-ip": ip } }), e, { upstreamFetch: up.fetch, now: () => now });
  assert.equal(res.status, 204);
  return up;
}

test("the daily salt is random, one per UTC day, stored with a ~1-day TTL", async () => {
  const k = kv();
  const a = await dailySalt(k.store, day1);
  assert.match(a!, /^[0-9a-f]{64}$/);
  assert.equal(await dailySalt(k.store, day1Late), a, "the same all day");
  const b = await dailySalt(k.store, day2);
  assert.notEqual(b, a, "a new one the next day");
  assert.deepEqual(k.puts, [{ key: "salt:2026-10-16", ttl: SALT_TTL_S }, { key: "salt:2026-10-17", ttl: SALT_TTL_S }]);
  assert.ok(SALT_TTL_S <= 26 * 3600 && SALT_TTL_S >= 24 * 3600);
  // Not derived from the date: two stores make different salts for the same day.
  assert.notEqual(await dailySalt(kv().store, day1), a);
  assert.equal(await dailySalt(undefined, day1), undefined);
  assert.equal(await dailySalt({ get: async () => { throw new Error("kv down"); }, put: async () => {} }, day1), undefined);
});

test("visitor_day: same IP same day the same value, another day or IP another; the IP never goes upstream", async () => {
  const k = kv();
  const e = env({ VISITOR_SALTS: k.store });
  const a = await send(e, day1);
  const [v1, v2] = visitors(a);
  assert.match(v1!, /^[0-9a-f]{16}$/);
  assert.equal(v2, v1, "every record of the request");
  assert.deepEqual(visitors(await send(e, day1Late)), [v1, v1], "same IP, same day");
  assert.notEqual(visitors(await send(e, day1, "198.51.100.9"))[0], v1, "another IP");
  assert.notEqual(visitors(await send(e, day2))[0], v1, "the next day");
  assert.equal(v1, await visitorOf(k.data.get("salt:2026-10-16")!, "203.0.113.7"));
  const body = new TextDecoder().decode(a.calls[0]!.init.body as Uint8Array);
  assert.doesNotMatch(body, /203\.0\.113\.7/);
  assert.equal(new Headers(a.calls[0]!.init.headers).get("cf-connecting-ip"), null);
});

test("without KV (or with KV failing) no visitor_day is added and the body passes as sent", async () => {
  const up = await send(env(), day1);
  assert.deepEqual(visitors(up), [undefined, undefined]);
  assert.equal(new TextDecoder().decode(up.calls[0]!.init.body as Uint8Array), payload(2));
  const broken: SaltStore = { get: async () => null, put: async () => { throw new Error("kv down"); } };
  assert.deepEqual(visitors(await send(env({ VISITOR_SALTS: broken }), day1)), [undefined, undefined]);
});

test("a visitor_day sent by the client is replaced, never forwarded as is", async () => {
  const k = kv();
  const body = JSON.stringify({ resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "uncut" } }] }, scopeLogs: [{ logRecords: [{ body: { stringValue: "app:start" }, attributes: [{ key: "visitor_day", value: { stringValue: "forged" } }] }] }] }] });
  const up = upstream();
  await handleRequest(req({ body }), env({ VISITOR_SALTS: k.store }), { upstreamFetch: up.fetch, now: () => day1 });
  const attrs = forwarded(up).resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes.filter((a) => a.key === "visitor_day");
  assert.equal(attrs.length, 1);
  assert.notEqual(attrs[0]!.value.stringValue, "forged");
});

