// Fetching a URL that came from a library reply (a file or preview, and each redirect hop) without
// letting a reply point Uncut at this Mac or its network (D134 review): outside tests only https,
// and the host is resolved and every address checked (loopback, private, link-local, ULA, CGNAT,
// multicast refused); the connection then goes to the address that was checked (the request's own
// lookup), so a second DNS answer can't swap it (rebinding). In a test context only loopback hosts
// (the stubs) are allowed, like guardedFetch. A response that doesn't start within HEADERS_MS fails.
import { lookup, type LookupAddress } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

import { inTestContext } from "../generate/providers.ts";

export const HEADERS_MS = 30_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  // D219: ::/96 (IPv4-compatible, also covers :: and ::1), 6to4 (2002::/16 wraps any IPv4 address),
  // the old site-local fec0::/10 and the local-use NAT64 prefix. (IPv4-mapped addresses are unwrapped
  // in isPublicAddress: a ::ffff:0:0/96 entry here would also match every IPv4 check.)
  ["::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const)
  blocked.addSubnet(net, bits, "ipv6");

/** Whether an address is on the public internet (not this Mac, a private network, link-local, ...). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]!);
    // D219: the same, written in hex (::ffff:7f00:1 is 127.0.0.1).
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
    if (hex) {
      const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
      return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return !blocked.check(address, "ipv6");
  }
  return !blocked.check(address, "ipv4");
}

/** dns.lookup that only ever hands back public addresses (all of them must be, or it fails). */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 0);
    const list = addresses as unknown as Array<LookupAddress>;
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) return callback(Object.assign(new Error(`${hostname} points at a private or local address`), { code: "EPRIVATE" }), "", 0);
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: Array<LookupAddress>) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

/** Why this URL can't be fetched now, or undefined. */
export function urlProblem(url: URL, test = inTestContext()): string | undefined {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (test) return LOOPBACK.has(url.hostname) || LOOPBACK.has(host) ? undefined : `Refused in a test run: ${url.host} isn't this machine (tests never call a real provider).`;
  if (url.protocol !== "https:") return "the file's address isn't https";
  if (isIP(host) && !isPublicAddress(host)) return `${url.host} is a private or local address`;
  return undefined;
}

/** One GET (no redirects followed) as a web Response; checked as above. */
export function getOnce(url: URL, headers: Record<string, string>, signal: AbortSignal, test = inTestContext(), headersMs = HEADERS_MS): Promise<Response> {
  const problem = urlProblem(url, test);
  if (problem) return Promise.reject(new Error(problem));
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, { method: "GET", headers, signal, ...(test ? {} : { lookup: publicLookup }) }, (res) => {
      clearTimeout(timer);
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(", ") : v);
      const status = res.statusCode ?? 502;
      const empty = status === 204 || status === 304 || (status >= 300 && status < 400);
      if (empty) res.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream), { status: status < 200 || status > 599 ? 502 : status, headers: out }));
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`no answer in ${headersMs / 1000} s`), { code: "ETIMEDOUT" })), headersMs);
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}

/** A dropped keep-alive socket (worth one more try for a GET). */
export const isReset = (error: unknown) => {
  const e = error as { code?: string; cause?: { code?: string } } | undefined;
  const code = e?.code ?? e?.cause?.code;
  return code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE";
};

/** `run`, once more if it failed on a reset socket and wasn't aborted. */
export async function retryOnReset<A>(run: () => Promise<A>, signal?: AbortSignal): Promise<A> {
  try {
    return await run();
  } catch (error) {
    if (signal?.aborted || !isReset(error)) throw error;
    return run();
  }
}
