// Uncut telemetry proxy (issue #13): a Cloudflare Worker in front of Grafana Cloud's OTLP gateway.
//
// The shipped app only knows a revocable app token and this Worker's URL. The Worker checks the
// token, rate-limits per IP, caps and lightly validates the payload, and forwards it to Grafana with
// the real logs:write credential, which never leaves Cloudflare. Bodies are never logged, client
// headers (IP, user agent, cookies) are not forwarded, and upstream responses are never echoed.
//
// Daily unique users (D283), Plausible-style, with nothing stored on the user's Mac: for each JSON
// request the Worker computes visitor_day = the first 16 hex of SHA-256(salt + client IP + "uncut"),
// where salt is 32 random bytes made for the current UTC day and kept only in Workers KV
// (VISITOR_SALTS, key salt:<YYYY-MM-DD>, expirationTtl 26 h), and adds it to every log record.
// The IP itself is then dropped (never forwarded or stored). Once a day's salt has expired, that
// day's values can't be recomputed or linked to the next day's or to anyone. Never derived from a
// long-lived secret (an HMAC of the date would keep past days linkable). Without the KV binding, or
// if KV fails, no visitor_day is added. Protobuf bodies pass through without it. Two isolates that
// both find no salt in the first seconds of a day can each make one (KV is eventually consistent);
// that can count a user twice on that day, never link anything.
//
// Deploy (from the repo root):
//   pnpm --dir infra/telemetry-proxy install --ignore-workspace
//   pnpm --dir infra/telemetry-proxy exec wrangler login
//   pnpm --dir infra/telemetry-proxy exec wrangler secret put GRAFANA_INSTANCE_ID  # the Grafana Cloud instance (user) id, digits only
//   pnpm --dir infra/telemetry-proxy exec wrangler secret put GRAFANA_TOKEN        # the Grafana logs:write token
//   TOKEN=$(openssl rand -hex 32); echo "$TOKEN"                                # keep it for the app build
//   printf '%s' "$TOKEN" | pnpm --dir infra/telemetry-proxy exec wrangler secret put APP_TOKEN
//   pnpm --dir infra/telemetry-proxy exec wrangler kv namespace create VISITOR_SALTS  # put the printed id in wrangler.toml's [[kv_namespaces]]
//   pnpm --dir infra/telemetry-proxy run deploy
// The URL is https://uncut-telemetry.<your-subdomain>.workers.dev; the app posts to /v1/logs with
// `Authorization: Bearer <APP_TOKEN>`. App tokens shorter than 16 characters are always refused.
// Smoke test once after deploying (expect 204, then the event shows in the dashboard's Recent events):
//   curl -i -X POST https://uncut-telemetry.<your-subdomain>.workers.dev/v1/logs \
//     -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
//     --data '{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"uncut"}}]},"scopeLogs":[{"logRecords":[{"body":{"stringValue":"proxy:smoke"},"attributes":[{"key":"event.name","value":{"stringValue":"proxy:smoke"}}]}]}]}]}'
//
// Local runs (wrangler dev) read the same names from infra/telemetry-proxy/.dev.vars (gitignored).
// GRAFANA_INSTANCE_ID moved from wrangler.toml's [vars] to a secret: on a Worker deployed before
// that, put the secret first, then deploy (a deploy without it answers 503 until it's set).
//
// Rotating the app token: put the new one in APP_TOKEN_NEXT, ship a build that uses it, then once
// old builds have faded, move it to APP_TOKEN and `wrangler secret delete APP_TOKEN_NEXT`.
// Revoking: `wrangler secret put APP_TOKEN` with a fresh value (old builds then get 401).
//
// Limits: body <= 256 KB; JSON payloads must come from service.name "uncut" and carry <= 100 log
// records (protobuf is passed through unvalidated); 60 requests per minute per client IP via the
// Workers rate limiting binding (per Cloudflare location, see wrangler.toml), or, if the binding is
// missing, a best-effort in-memory limit of the same size per Worker isolate.
//
// This file uses only web-standard APIs so the unit tests (test/infra/telemetry-proxy.test.ts) run
// its handler under Node with a fake env and a stubbed upstream fetch.

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The slice of a Workers KV namespace the daily salt needs. */
export interface SaltStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
}

export interface Env {
  GRAFANA_OTLP_URL: string;
  GRAFANA_INSTANCE_ID: string;
  GRAFANA_TOKEN: string;
  APP_TOKEN: string;
  APP_TOKEN_NEXT?: string;
  RATE_LIMITER?: RateLimiter;
  /** Workers KV for the daily salt (D283); without it no visitor_day is added. */
  VISITOR_SALTS?: SaltStore;
}

export interface Deps {
  upstreamFetch?: (input: string, init: RequestInit) => Promise<Response>;
  fallbackLimiter?: RateLimiter;
  /** Tests: the clock that picks the UTC day. */
  now?: () => Date;
}

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_RECORDS = 100;
export const RATE_LIMIT = 60;
export const RATE_PERIOD_MS = 60_000;
export const SERVICE_NAME = "uncut";
const UPSTREAM_TIMEOUT_MS = 5_000;
const MIN_TOKEN_LENGTH = 16;
const CONTENT_TYPES = ["application/json", "application/x-protobuf"] as const;

const encoder = new TextEncoder();

/** A day's salt lives a little longer than the day (time zones of the edge don't matter: the key is the UTC date). */
export const SALT_TTL_S = 26 * 3600;
export const VISITOR_ATTRIBUTE = "visitor_day";

const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** Today's random salt from KV, made (and stored with a TTL) if there is none yet; undefined when KV is missing or fails. */
export async function dailySalt(store: SaltStore | undefined, now: Date): Promise<string | undefined> {
  if (!store) return undefined;
  const key = `salt:${utcDay(now)}`;
  try {
    const stored = await store.get(key);
    if (stored) return stored;
    const salt = hex(crypto.getRandomValues(new Uint8Array(32)));
    await store.put(key, salt, { expirationTtl: SALT_TTL_S });
    return salt;
  } catch {
    return undefined;
  }
}

/** The day's one-way value for a client IP: 16 hex of SHA-256(salt + ip + "uncut"). */
export async function visitorOf(salt: string, ip: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(`${salt}${ip}uncut`))).slice(0, 16);
}

/** The JSON payload with visitor_day added to every log record (any client-sent visitor_day replaced). */
export function withVisitor(bytes: Uint8Array<ArrayBuffer>, visitor: string): Uint8Array<ArrayBuffer> {
  const data = JSON.parse(new TextDecoder().decode(bytes)) as {
    resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ attributes?: Array<KeyValue> }> }> }>;
  };
  for (const rl of data.resourceLogs)
    for (const sl of rl.scopeLogs)
      for (const lr of sl.logRecords) {
        const attrs = Array.isArray(lr.attributes) ? lr.attributes.filter((a) => a?.key !== VISITOR_ATTRIBUTE) : [];
        attrs.push({ key: VISITOR_ATTRIBUTE, value: { stringValue: visitor } });
        lr.attributes = attrs;
      }
  return encoder.encode(JSON.stringify(data)) as Uint8Array<ArrayBuffer>;
}

const empty = (status: number, headers?: Record<string, string>) => new Response(null, { status, headers });

/** A fixed-window counter per key, for when the rate limiting binding isn't configured. */
export function memoryLimiter(limit = RATE_LIMIT, periodMs = RATE_PERIOD_MS, now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    async limit({ key }) {
      const t = now();
      if (windows.size > 10_000) for (const [k, w] of windows) if (t - w.start >= periodMs) windows.delete(k);
      const w = windows.get(key);
      if (!w || t - w.start >= periodMs) {
        windows.set(key, { start: t, count: 1 });
        return { success: true };
      }
      w.count++;
      return { success: w.count <= limit };
    },
  };
}

const isolateLimiter = memoryLimiter();

/** Compares in time that depends only on the candidate's length, not on where the bytes differ. */
function tokenMatches(candidate: string, expected: string | undefined): boolean {
  if (!expected || expected.length < MIN_TOKEN_LENGTH) return false;
  const a = encoder.encode(candidate);
  const b = encoder.encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i % b.length] ?? 0);
  return diff === 0;
}

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match) return false;
  // Evaluate both so the time doesn't reveal which slot matched.
  const current = tokenMatches(match[1], env.APP_TOKEN);
  const next = tokenMatches(match[1], env.APP_TOKEN_NEXT);
  return current || next;
}

/** Reads the body, giving up as soon as it passes the cap (chunked uploads have no Content-Length). */
async function readCapped(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

type AnyValue = { stringValue?: unknown };
type KeyValue = { key?: unknown; value?: AnyValue };

/** Light checks on an OTLP/JSON ExportLogsServiceRequest; returns false for anything off-shape. */
export function validJsonPayload(bytes: Uint8Array<ArrayBuffer>): boolean {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return false;
  }
  const resourceLogs = (data as { resourceLogs?: unknown })?.resourceLogs;
  if (!Array.isArray(resourceLogs) || resourceLogs.length === 0) return false;
  let records = 0;
  for (const rl of resourceLogs) {
    const attrs = (rl as { resource?: { attributes?: unknown } })?.resource?.attributes;
    if (!Array.isArray(attrs)) return false;
    const service = (attrs as Array<KeyValue>).find((a) => a?.key === "service.name");
    if (service?.value?.stringValue !== SERVICE_NAME) return false;
    const scopeLogs = (rl as { scopeLogs?: unknown }).scopeLogs;
    if (!Array.isArray(scopeLogs)) return false;
    for (const sl of scopeLogs) {
      const logRecords = (sl as { logRecords?: unknown })?.logRecords;
      if (!Array.isArray(logRecords)) return false;
      records += logRecords.length;
      if (records > MAX_RECORDS) return false;
    }
  }
  return records > 0;
}

export async function handleRequest(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/logs") return empty(404);
  if (request.method !== "POST") return empty(405, { allow: "POST" });

  if (!authorized(request, env)) return empty(401);

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const limiter = env.RATE_LIMITER ?? deps.fallbackLimiter ?? isolateLimiter;
  const { success } = await limiter.limit({ key: ip });
  if (!success) return empty(429, { "retry-after": "60" });

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!(CONTENT_TYPES as ReadonlyArray<string>).includes(contentType)) return empty(415);

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return empty(413);
  const body = await readCapped(request);
  if (body === null) return empty(413);
  if (body.byteLength === 0) return empty(400);
  if (contentType === "application/json" && !validJsonPayload(body)) return empty(400);

  // Daily unique users (D283): the IP goes in a one-way hash with today's random salt, then is dropped.
  let forwarded = body;
  if (contentType === "application/json" && ip !== "unknown") {
    const salt = await dailySalt(env.VISITOR_SALTS, (deps.now ?? (() => new Date()))());
    if (salt) forwarded = withVisitor(body, await visitorOf(salt, ip));
  }

  if (!env.GRAFANA_OTLP_URL || !env.GRAFANA_INSTANCE_ID || !env.GRAFANA_TOKEN) return empty(503);
  const upstreamFetch = deps.upstreamFetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  try {
    const upstream = await upstreamFetch(`${env.GRAFANA_OTLP_URL.replace(/\/+$/, "")}/v1/logs`, {
      method: "POST",
      headers: {
        "content-type": contentType,
        authorization: `Basic ${btoa(`${env.GRAFANA_INSTANCE_ID}:${env.GRAFANA_TOKEN}`)}`,
      },
      body: forwarded,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    // Drain without reading it into anything the client sees.
    await upstream.body?.cancel().catch(() => {});
    if (upstream.ok) return empty(204);
    if (upstream.status === 429) return empty(429, { "retry-after": "60" });
    return empty(502);
  } catch {
    return empty(502);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
