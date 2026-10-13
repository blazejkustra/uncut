// The headless server's pairing token (D106): made once, kept in <data dir>/server-token (0600,
// the folder 0700), and printed when the server starts so it can be pasted into Uncut's
// Settings, Environments. The desktop's own server never uses this: it hands its server a fresh
// token over the bootstrap fd every launch.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

export const TOKEN_FILE = "server-token";
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,256}$/;

/** The token stored in `dataDir`, made (and stored 0600) the first time. */
export function loadOrCreateToken(dataDir: string): { readonly token: string; readonly file: string; readonly created: boolean } {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, TOKEN_FILE);
  try {
    const token = readFileSync(file, "utf8").trim();
    if (!TOKEN_SHAPE.test(token)) throw new Error(`${file} doesn't hold a token Uncut made; delete it to make a new one`);
    // Someone may have loosened it; a token others can read pairs them too.
    chmodSync(file, 0o600);
    return { token, file, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("base64url");
  // "wx": never over a file (or a symlink) that appeared meanwhile.
  writeFileSync(file, `${token}\n`, { mode: 0o600, flag: "wx" });
  return { token, file, created: true };
}

/** An address others can use to reach a server bound to `host` (a wildcard bind: this machine's first LAN address). */
export function reachableHost(host: string): string {
  if (host !== "0.0.0.0" && host !== "::" && host !== "") return host;
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return "127.0.0.1";
}

export const urlHost = (host: string) => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);

/** What a headless server prints (on stderr) once it listens: where it is and how to pair with it. */
export function pairingText(host: string, port: number, token: string, file: string | undefined): string {
  const url = `http://${urlHost(reachableHost(host))}:${port}`;
  const link = `uncut://pair?url=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}`;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost" || /^127\./.test(host);
  return [
    `Uncut server listening on ${url}`,
    ...(loopback ? [] : ["Warning: plain http, not encrypted. The token and your footage travel in clear on this network: use an SSH tunnel, Tailscale or an https proxy."]),
    `Token: ${token}${file ? ` (kept in ${file})` : ""}`,
    "Pair from Uncut: Settings, Environments, Add environment, then paste this line:",
    link,
    "",
  ].join("\n");
}
