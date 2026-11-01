// The door outside agents (Claude Code in a terminal, Cursor, ...) come through: MCP's Streamable
// HTTP on loopback, off until the user turns it on in Settings. Requests carry the install's bearer
// token; a Host or Origin that isn't this listener's own is refused first, so a web page can't reach
// it through DNS rebinding. One listener for the app, forwarding to the window's server that
// `forward` picks. No Electron imports, so tests drive it.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

export const MCP_ROUTE = "/mcp";
export const DEFAULT_MCP_PORT = 47821;
/** Contracts' values (the desktop doesn't bundle them; a test keeps them equal). */
export const EXTERNAL_MCP_PATH = "/external-mcp";
export const PROJECT_OPEN_NAME = "project_open";
const MAX_BODY = 32 * 1024 * 1024;

export const TOKEN_FILE = "external-mcp-token";
const SETTINGS_FILE = "external-mcp.json";

/** A message in, its answer out; undefined for a notification (nothing to answer). */
export type Forward = (message: Record<string, unknown>) => Promise<unknown>;

export interface GatewayOptions {
  readonly port: number;
  readonly token: () => string;
  readonly forward: Forward;
}

export interface Gateway {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

const tokensMatch = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return expected !== "" && a.length === b.length && timingSafeEqual(a, b);
};

const bearerOf = (header: string | undefined) => /^Bearer\s+(\S+)\s*$/i.exec(header ?? "")?.[1] ?? "";

/** Why a request is refused, or undefined. Host first: a rebound page must learn nothing. */
export function refusal(req: Pick<IncomingMessage, "headers" | "method" | "url">, port: number, token: string): { status: number; text: string } | undefined {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.host ?? "")) return { status: 403, text: "Forbidden host" };
  if (req.headers.origin !== undefined) return { status: 403, text: "Forbidden origin" };
  if (!tokensMatch(bearerOf(req.headers.authorization), token)) return { status: 401, text: "Unauthorized" };
  if (req.url !== MCP_ROUTE) return { status: 404, text: "Not found" };
  if (req.method !== "POST") return { status: 405, text: "Method not allowed" };
  return undefined;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) return reject(new Error("too large"));
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

const answerPlain = (res: ServerResponse, status: number, text: string) => {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
    ...(status === 405 ? { allow: "POST" } : {}),
  });
  res.end(text);
};

const parseMessage = (body: string) => {
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

async function serve(req: IncomingMessage, res: ServerResponse, options: GatewayOptions) {
  const refused = refusal(req, options.port, options.token());
  if (refused) return answerPlain(res, refused.status, refused.text);
  const body = await readBody(req);
  const message = parseMessage(body);
  if (!message) return answerPlain(res, 400, "Send one JSON-RPC message");
  const answer = await options.forward(message);
  if (answer === undefined) {
    res.writeHead(202);
    return res.end();
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(answer));
}

const listen = (server: Server, port: number) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });

/** Listens on 127.0.0.1 only. Rejects when the port is taken. */
export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  let bound = { ...options };
  const server = createServer((req, res) => {
    serve(req, res, bound).catch((error: Error) => {
      if (!res.headersSent) answerPlain(res, 500, error.message);
      else res.end();
    });
  });
  const port = await listen(server, options.port);
  bound = { ...options, port };
  return {
    port,
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

// ---- what's kept: on or off, and the token (its own file, readable by this user alone) ----

const tokenPath = (dataDir: string) => join(dataDir, TOKEN_FILE);

const writeToken = (dataDir: string) => {
  const token = randomBytes(32).toString("base64url");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(tokenPath(dataDir), `${token}\n`, { mode: 0o600 });
  chmodSync(tokenPath(dataDir), 0o600);
  return token;
};

export const readToken = (dataDir: string) => (existsSync(tokenPath(dataDir)) ? readFileSync(tokenPath(dataDir), "utf8").trim() : writeToken(dataDir));
export const newToken = writeToken;

export function readEnabled(dataDir: string) {
  try {
    return (JSON.parse(readFileSync(join(dataDir, SETTINGS_FILE), "utf8")) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

export function writeEnabled(dataDir: string, enabled: boolean) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, SETTINGS_FILE), `${JSON.stringify({ enabled })}\n`);
}

/** Which window answers: the focused one with a project, any with a project, the focused one, any. */
export function pickWindow<W extends { readonly id: number; readonly projectDir: string | undefined }>(
  windows: ReadonlyArray<W>,
  focusedId: number | undefined,
) {
  const withProject = windows.filter((w) => w.projectDir !== undefined);
  const pool = withProject.length ? withProject : windows;
  return pool.find((w) => w.id === focusedId) ?? pool[0];
}

/** project_open's path is a project (else a footage folder). */
export const UNCUT_PROJECT = /\.uncut\/?$/i;
