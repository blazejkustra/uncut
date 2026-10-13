// The loopback relay to a remote environment (D106). The renderer only ever talks to 127.0.0.1
// (its CSP stays as it is), with a token of its own; the relay forwards each request and
// WebSocket to the remote server with the remote's token in an Authorization header, so the
// remote token never sits in a renderer URL, a <video> src or a remote's request line.
// - A request with the relay's token: the token is taken out of the URL, the remote's goes in the
//   header. Without it, the request goes on unchanged and the remote decides (a graphic's
//   document carries its own secret, D78). Nothing else on this Mac gets the remote token added.
// - Origin, Cookie and Referer never travel; a request from a web page origin is refused here.
// - Preflights (the renderer's upload is a CORS POST) are answered here.
// Plain Node, no Electron: tests run it on its own.
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

const TOKEN_PARAM = "token";
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "origin", "referer", "cookie", "authorization"]);

export interface Relay {
  readonly port: number;
  /** The token the renderer uses with the relay (never the remote's). */
  readonly token: string;
  /** ws://127.0.0.1:<port>/ws */
  readonly wsUrl: string;
  readonly httpBase: string;
  /** Why the last attempt to reach the remote failed, or undefined once one got through. */
  readonly problem: () => string | undefined;
  readonly close: () => Promise<void>;
}

const same = (a: string | null, b: string) => a !== null && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A sentence for a refused or failed attempt to reach the remote. */
export function problemFor(status: number | undefined, error?: NodeJS.ErrnoException, target?: string): string {
  if (status === 401) return "The server refused the token. Check it in Settings, Environments.";
  if (status === 429) return "The server is refusing this Mac for a minute after too many wrong tokens.";
  if (status === 403) return "The server refused the connection.";
  if (status !== undefined) return `The server answered ${status}.`;
  const where = target ? ` at ${target}` : "";
  if (error?.code === "ECONNREFUSED") return `Nothing is listening${where}. Is uncut-server running there?`;
  if (error?.code === "ENOTFOUND" || error?.code === "EAI_AGAIN") return `Can't find that server${where}.`;
  if (error?.code === "ETIMEDOUT" || error?.code === "ECONNRESET") return `No answer from the server${where}.`;
  return `Can't reach the server${where}${error?.message ? `: ${error.message}` : ""}.`;
}

const originOk = (origin: string | undefined, extra: ReadonlyArray<string>) => origin === undefined || origin === "" || origin === "null" || origin === "file://" || extra.includes(origin);

export function startRelay(options: { readonly target: string; readonly token: string; readonly allowedOrigins?: ReadonlyArray<string> }): Promise<Relay> {
  const target = new URL(options.target);
  const client = target.protocol === "https:" ? https : http;
  const localToken = randomBytes(24).toString("base64url");
  const extra = options.allowedOrigins ?? [];
  let problem: string | undefined;

  /** The upstream path and headers for an incoming request. */
  const outgoing = (req: http.IncomingMessage) => {
    const url = new URL(req.url ?? "/", "http://relay");
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = v;
    headers.host = target.host;
    const authorised = same(url.searchParams.get(TOKEN_PARAM), localToken);
    if (authorised) {
      url.searchParams.delete(TOKEN_PARAM);
      headers.authorization = `Bearer ${options.token}`;
    }
    const base = target.pathname.replace(/\/$/, "");
    return { path: `${base}${url.pathname}${url.search}`, headers, authorised };
  };
  const requestOptions = (path: string, headers: http.OutgoingHttpHeaders, method: string): https.RequestOptions => ({
    protocol: target.protocol,
    hostname: target.hostname.replace(/^\[|\]$/g, ""),
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path,
    method,
    headers,
  });

  const server = http.createServer((req, res) => {
    if (!originOk(req.headers.origin, extra)) {
      res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden origin");
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type, range", "access-control-max-age": "600" }).end();
      return;
    }
    const { path, headers, authorised } = outgoing(req);
    // Only the renderer (with the relay token) and a graphic's document (its own secret) go through:
    // nothing else on this Mac can use the relay, or spend the remote's failed-token budget for it.
    if (!authorised && !path.startsWith(`${target.pathname.replace(/\/$/, "")}/media/graphic/`)) {
      res.writeHead(401, { "content-type": "text/plain", "access-control-allow-origin": "*" }).end("Unauthorized");
      return;
    }
    const upstream = client.request(requestOptions(path, headers, req.method ?? "GET"), (answer) => {
      if (answer.statusCode === 401 || answer.statusCode === 429 || answer.statusCode === 403) problem = problemFor(answer.statusCode);
      const out: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(answer.headers)) if (!HOP.has(k) && k !== "set-cookie" && v !== undefined) out[k] = v;
      res.writeHead(answer.statusCode ?? 502, out);
      answer.pipe(res);
    });
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      problem = problemFor(undefined, error, target.host);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain", "access-control-allow-origin": "*" });
      res.end(problem);
    });
    // The client hanging up (a <video> seeking) ends the upstream request too.
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => {});
    if (!originOk(req.headers.origin, extra)) return void socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
    const { path, headers, authorised } = outgoing(req);
    if (!authorised) return void socket.end("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
    headers.connection = "Upgrade";
    headers.upgrade = req.headers.upgrade ?? "websocket";
    const upstream = client.request(requestOptions(path, headers, "GET"));
    upstream.on("upgrade", (answer, remote, remoteHead) => {
      problem = undefined;
      remote.on("error", () => socket.destroy());
      const lines = [`HTTP/1.1 ${answer.statusCode ?? 101} ${answer.statusMessage ?? "Switching Protocols"}`];
      for (let i = 0; i < answer.rawHeaders.length; i += 2) lines.push(`${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.pipe(socket);
      socket.pipe(remote);
      socket.on("close", () => remote.destroy());
      remote.on("close", () => socket.destroy());
    });
    upstream.on("response", (answer) => {
      problem = problemFor(answer.statusCode);
      answer.resume();
      socket.end(`HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? "Bad Gateway"}\r\ncontent-length: 0\r\n\r\n`);
    });
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      problem = problemFor(undefined, error, target.host);
      socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
    });
    upstream.end();
  });

  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        token: localToken,
        wsUrl: `ws://127.0.0.1:${port}/ws`,
        httpBase: `http://127.0.0.1:${port}`,
        problem: () => problem,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** GET <url>/api/ping with the token (Settings' Test connection): the server's version and name, or why not. */
export function pingServer(base: string, token: string, timeoutMs = 5000): Promise<{ readonly ok: true; readonly version: string; readonly hostname: string } | { readonly ok: false; readonly message: string }> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL("/api/ping", base);
    } catch {
      return resolve({ ok: false, message: "That isn't a server address." });
    }
    const client = url.protocol === "https:" ? https : http;
    const req = client.get(url, { headers: { authorization: `Bearer ${token}` }, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => (body += d.slice(0, 4096)));
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve({ ok: false, message: problemFor(res.statusCode) });
        try {
          const value = JSON.parse(body) as { version?: unknown; hostname?: unknown };
          resolve({ ok: true, version: String(value.version ?? "?"), hostname: String(value.hostname ?? url.hostname) });
        } catch {
          resolve({ ok: false, message: "That address answered, but it isn't an Uncut server." });
        }
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", (error: NodeJS.ErrnoException) => resolve({ ok: false, message: problemFor(undefined, error, url.host) }));
  });
}
