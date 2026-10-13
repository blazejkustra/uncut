// Who may talk to the server (D106, D110). Every request and WebSocket upgrade passes one gate
// before the router sees it:
// - Origin: none (Node, the desktop's relay, <video> loads), "null" or "file://" (the packaged
//   renderer), and on a loopback bind the dev page's http://127.0.0.1 / localhost origins. A web
//   page anywhere else is refused before its token is even read (a WebSocket has no CORS).
// - The token, from `Authorization: Bearer` (the desktop's relay to a remote) or ?token= (the
//   renderer's own URLs, as before), compared in constant time. Not for the agent bridge (its own
//   per-turn token, D40) or a graphic's document (its own secret, D78).
// - Wrong tokens are counted per address: AUTH_MAX_FAILURES in AUTH_WINDOW_MS blocks that address's
//   wrong tokens for AUTH_BLOCK_MS (429), so guessing doesn't scale. The right token always gets in;
//   a missing token isn't counted; a cross-site request (Sec-Fetch-Site) without the right token is
//   refused (403) uncounted, so a web page can't lock the owner out.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { AGENT_BRIDGE_PATH, GRAPHIC_PATH, TOKEN_QUERY_PARAM } from "@uncut/contracts";

export const AUTH_MAX_FAILURES = 10;
export const AUTH_WINDOW_MS = 60_000;
export const AUTH_BLOCK_MS = 60_000;

export const tokensMatch = (given: string | null | undefined, expected: string) => {
  if (given === null || given === undefined || expected === "") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The token a request carries: `Authorization: Bearer …` first, else the ?token= query parameter. */
export function presentedToken(headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>, url: URL | undefined): string | null {
  const auth = headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    if (m) return m[1]!;
  }
  return url?.searchParams.get(TOKEN_QUERY_PARAM) ?? null;
}

export const isLoopbackHost = (host: string) => host === "127.0.0.1" || host === "::1" || host === "localhost" || /^127\./.test(host);

/** Whether a request's Origin may talk to this server (see the header). */
export function originAllowed(origin: string | undefined, loopbackBind: boolean, extra: ReadonlyArray<string> = []): boolean {
  if (origin === undefined || origin === "" || origin === "null" || origin === "file://") return true;
  if (extra.includes(origin)) return true;
  if (!loopbackBind) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

/** Failed-token bookkeeping per remote address. */
export function makeRateLimiter(now: () => number = Date.now) {
  const seen = new Map<string, { failures: Array<number>; blockedUntil: number }>();
  return {
    blocked(address: string): boolean {
      const entry = seen.get(address);
      return entry !== undefined && entry.blockedUntil > now();
    },
    fail(address: string) {
      const t = now();
      const entry = seen.get(address) ?? { failures: [], blockedUntil: 0 };
      entry.failures = entry.failures.filter((f) => t - f < AUTH_WINDOW_MS);
      entry.failures.push(t);
      if (entry.failures.length >= AUTH_MAX_FAILURES) {
        entry.blockedUntil = t + AUTH_BLOCK_MS;
        entry.failures = [];
      }
      seen.set(address, entry);
      // Never grows without bound: forget addresses that are quiet and unblocked.
      if (seen.size > 1000) for (const [k, v] of seen) if (v.blockedUntil < t && !v.failures.some((f) => t - f < AUTH_WINDOW_MS)) seen.delete(k);
    },
  };
}

export interface GateOptions {
  readonly token: string;
  readonly host: string;
  readonly allowedOrigins?: ReadonlyArray<string>;
}

/** Paths that check a secret of their own instead of the server token. */
const ownSecret = (pathname: string) => pathname === AGENT_BRIDGE_PATH || pathname.startsWith(`${AGENT_BRIDGE_PATH}/`) || pathname.startsWith(`${GRAPHIC_PATH}/`);

/**
 * Installs the gate on a Node HTTP server: requests and upgrades it refuses never reach the
 * listeners added later (the Effect router). Returns the limiter (tests read nothing from it).
 */
export function installGate(server: import("node:http").Server, options: GateOptions) {
  const limiter = makeRateLimiter();
  const loopback = isLoopbackHost(options.host);
  const verdict = (req: IncomingMessage): { status: number; text: string } | undefined => {
    const origin = req.headers.origin;
    if (!originAllowed(origin, loopback, options.allowedOrigins)) return { status: 403, text: "Forbidden origin" };
    let url: URL | undefined;
    try {
      url = new URL(req.url ?? "/", "http://server");
    } catch {
      return { status: 400, text: "Bad request" };
    }
    if (ownSecret(url.pathname)) return undefined;
    const given = presentedToken(req.headers, url);
    // The right token is never rate-limited: nobody can lock the owner out by failing on purpose.
    if (tokensMatch(given, options.token)) return undefined;
    // A web page's request (an <img> or form from another site) is refused without counting, so a
    // page can't spend this address's budget; the app's own pages carry the right token.
    if (req.headers["sec-fetch-site"] === "cross-site") return { status: 403, text: "Forbidden" };
    // No token at all says nothing about guessing: refused, not counted.
    if (given === null || given === "") return { status: 401, text: "Unauthorized" };
    const address = req.socket.remoteAddress ?? "?";
    if (limiter.blocked(address)) return { status: 429, text: "Too many failed attempts; try again in a minute" };
    limiter.fail(address);
    return { status: 401, text: "Unauthorized" };
  };
  const emit = server.emit.bind(server) as (event: string | symbol, ...args: Array<unknown>) => boolean;
  server.emit = ((event: string | symbol, ...args: Array<unknown>) => {
    if (event === "request") {
      const [req, res] = args as [IncomingMessage, ServerResponse];
      const refused = verdict(req);
      if (refused) {
        res.writeHead(refused.status, { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" });
        res.end(refused.text);
        return true;
      }
    } else if (event === "upgrade") {
      const [req, socket] = args as [IncomingMessage, Duplex];
      const refused = verdict(req);
      if (refused) {
        socket.on("error", () => {});
        socket.end(`HTTP/1.1 ${refused.status} ${refused.text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
        return true;
      }
    }
    return emit(event, ...args);
  }) as typeof server.emit;
  return limiter;
}
