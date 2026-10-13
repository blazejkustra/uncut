// Environments (Phase 9, D106): where the server runs. Local is this Mac's own server, started
// by the app as always; a remote one is an uncut-server elsewhere, reached through the loopback
// relay (relay.ts). The list lives in <data dir>/environments.json; each remote's token is stored
// encrypted (safeStorage, or the test stand-in), never in plain text. Plain Node, no Electron.
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LOCAL_ID = "local";
export const LOCAL_NAME = "This Mac";
const MAX_NAME = 60;

export interface EnvironmentInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: "local" | "remote";
  readonly url?: string;
}

interface StoredRemote {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  /** The token, encrypted. */
  readonly token: string;
}
interface Stored {
  readonly active: string;
  readonly remotes: ReadonlyArray<StoredRemote>;
}

export interface Crypt {
  readonly encrypt: (text: string) => string;
  readonly decrypt: (data: string) => string;
}

/**
 * A server address as typed or pasted: "host:port", "http(s)://host:port", a ws:// URL, with or
 * without /ws. Only http and https; the result is the origin plus any base path, no query.
 */
export function normalizeServerUrl(raw: string): { readonly url: string } | { readonly problem: string } {
  let text = raw.trim();
  if (!text) return { problem: "Paste the server's address, like http://studio.local:8790." };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { problem: "That isn't a server address. It looks like http://studio.local:8790." };
  }
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol !== "http:" && url.protocol !== "https:") return { problem: "Use an http:// or https:// address." };
  if (url.username || url.password) return { problem: "Leave the user name out of the address; the token is the password." };
  const path = url.pathname.replace(/\/ws\/?$/, "").replace(/\/$/, "");
  return { url: `${url.protocol}//${url.host}${path}` };
}

/** The line a headless server prints (uncut://pair?url=…&token=…), split into its address and token. */
export function parsePairing(text: string): { readonly url: string; readonly token: string } | undefined {
  const trimmed = text.trim();
  if (!/^uncut:\/\/pair\?/i.test(trimmed)) return undefined;
  const params = new URLSearchParams(trimmed.slice(trimmed.indexOf("?") + 1));
  const url = params.get("url");
  const token = params.get("token");
  return url && token ? { url, token } : undefined;
}

export function makeEnvironmentStore(dataDir: string, crypt: Crypt) {
  const file = join(dataDir, "environments.json");
  const read = (): Stored => {
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as Partial<Stored>;
      const remotes = Array.isArray(value.remotes) ? value.remotes.filter((r): r is StoredRemote => typeof r?.id === "string" && typeof r.name === "string" && typeof r.url === "string" && typeof r.token === "string") : [];
      const active = typeof value.active === "string" && (value.active === LOCAL_ID || remotes.some((r) => r.id === value.active)) ? value.active : LOCAL_ID;
      return { active, remotes };
    } catch {
      return { active: LOCAL_ID, remotes: [] };
    }
  };
  const write = (stored: Stored) => {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  };
  const cleanName = (name: string) => name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);

  return {
    list(): { readonly active: string; readonly environments: ReadonlyArray<EnvironmentInfo> } {
      const stored = read();
      return { active: stored.active, environments: [{ id: LOCAL_ID, name: LOCAL_NAME, kind: "local" }, ...stored.remotes.map((r) => ({ id: r.id, name: r.name, kind: "remote" as const, url: r.url }))] };
    },
    active(): EnvironmentInfo {
      const { active, environments } = this.list();
      return environments.find((e) => e.id === active) ?? environments[0]!;
    },
    /** The remote's address and token, decrypted; undefined for Local or an unknown id. */
    secret(id: string): { readonly url: string; readonly token: string } | undefined {
      const remote = read().remotes.find((r) => r.id === id);
      return remote ? { url: remote.url, token: crypt.decrypt(remote.token) } : undefined;
    },
    add(input: { readonly name: string; readonly url: string; readonly token: string }): { readonly id: string } | { readonly problem: string } {
      const pairing = parsePairing(input.url);
      const normal = normalizeServerUrl(pairing?.url ?? input.url);
      if ("problem" in normal) return normal;
      const token = (pairing?.token ?? input.token).trim();
      if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) return { problem: "Paste the token the server printed when it started (letters, digits, - and _)." };
      const stored = read();
      const name = cleanName(input.name) || new URL(normal.url).hostname;
      const id = `env-${randomBytes(6).toString("hex")}`;
      write({ ...stored, remotes: [...stored.remotes, { id, name, url: normal.url, token: crypt.encrypt(token) }] });
      return { id };
    },
    rename(id: string, name: string): boolean {
      const stored = read();
      const clean = cleanName(name);
      if (!clean || !stored.remotes.some((r) => r.id === id)) return false;
      write({ ...stored, remotes: stored.remotes.map((r) => (r.id === id ? { ...r, name: clean } : r)) });
      return true;
    },
    remove(id: string): boolean {
      const stored = read();
      if (!stored.remotes.some((r) => r.id === id)) return false;
      write({ active: stored.active === id ? LOCAL_ID : stored.active, remotes: stored.remotes.filter((r) => r.id !== id) });
      return true;
    },
    setActive(id: string): boolean {
      const stored = read();
      if (id !== LOCAL_ID && !stored.remotes.some((r) => r.id === id)) return false;
      write({ ...stored, active: id });
      return true;
    },
  };
}

export type EnvironmentStore = ReturnType<typeof makeEnvironmentStore>;
