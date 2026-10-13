// Generator API keys (D99). The user stores a provider's key in Settings › Keys; Uncut keeps it
// encrypted with Electron's safeStorage (the macOS Keychain holds safeStorage's own key), in
// <dataDir>/keys.json (0600, ciphertext only). The server runs as a plain Node child of the desktop,
// where safeStorage doesn't exist, so the desktop does the encrypting and decrypting for it over a
// private pipe (--keys-fd N: JSON lines { id, op: "encrypt", text } → { id, ok, data } and
// { id, op: "decrypt", data } → { id, ok, text }). Without that pipe (the server run by hand or by
// the tests) keys live in memory only and are gone when it stops.
//
// A key is read only by the provider that sends it (providers.ts), right before the request. It
// never goes into a child's environment (agentEnv / pluginEnv strip provider keys anyway), a log,
// an error message, a project file or a WebSocket reply: keys.list says only whether one is set.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { dirname, join } from "node:path";
import * as readline from "node:readline";

import { GenerateError, type KeyInfo, type KeyProvider } from "@uncut/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../app/config.ts";

export const PROVIDERS: ReadonlyArray<{ readonly id: KeyProvider; readonly name: string; readonly usedBy: ReadonlyArray<string> }> = [
  { id: "openai", name: "OpenAI", usedBy: ["GPT Image"] },
  { id: "google", name: "Google", usedBy: ["Veo"] },
  { id: "elevenlabs", name: "ElevenLabs", usedBy: ["Sound effects"] },
];
export const providerName = (id: KeyProvider) => PROVIDERS.find((p) => p.id === id)?.name ?? id;

/** Encrypts and decrypts with the desktop's safeStorage. */
export interface Crypter {
  readonly encrypt: (text: string) => Promise<string>;
  readonly decrypt: (data: string) => Promise<string>;
}

/** The desktop's side of the keys pipe on `fd`. A reply that doesn't come in 30 s fails (a Keychain prompt waits on the user). */
export function pipeCrypter(fd: number): Crypter {
  const socket = new Socket({ fd, readable: true, writable: true });
  socket.on("error", () => {});
  socket.unref();
  const pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let next = 0;
  let closed = false;
  readline.createInterface({ input: socket }).on("line", (line) => {
    let msg: { id?: unknown; ok?: unknown; data?: unknown; text?: unknown; error?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const p = pending.get(Number(msg.id));
    if (!p) return;
    pending.delete(Number(msg.id));
    clearTimeout(p.timer);
    const value = typeof msg.data === "string" ? msg.data : typeof msg.text === "string" ? msg.text : undefined;
    if (msg.ok === true && value !== undefined) p.resolve(value);
    else p.reject(new Error(typeof msg.error === "string" ? msg.error.slice(0, 200) : "The Keychain didn't answer."));
  });
  socket.once("close", () => {
    closed = true;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("The app's Keychain access is gone."));
      pending.delete(id);
    }
  });
  const ask = (msg: Record<string, string>) =>
    new Promise<string>((resolve, reject) => {
      if (closed) return reject(new Error("The app's Keychain access is gone."));
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("The Keychain didn't answer in time."));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ id, ...msg })}\n`);
    });
  return { encrypt: (text) => ask({ op: "encrypt", text }), decrypt: (data) => ask({ op: "decrypt", data }) };
}

/** keys.json: ciphertext by provider, nothing else. */
interface KeyFile {
  readonly version: 1;
  readonly keys: Partial<Record<KeyProvider, string>>;
}

const isProvider = (x: string): x is KeyProvider => PROVIDERS.some((p) => p.id === x);

/** Writes `data` to `path` atomically, readable by the user only. */
async function writePrivate(path: string, data: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.keys.json.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
    await chmod(path, 0o600);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** A key as typed: trimmed; one line, no spaces, at most 512 characters. */
export function cleanKey(raw: string): string | { problem: string } {
  const key = raw.trim();
  if (!key) return { problem: "Paste the key first." };
  if (key.length > 512 || /\s/.test(key)) return { problem: "That doesn't look like an API key (one line, no spaces)." };
  return key;
}

/** The store, as plain promises (the service wraps it). `crypter` undefined: memory only. */
export function keyStore(options: { readonly file: string; readonly crypter: Crypter | undefined }) {
  const memory = new Map<KeyProvider, string>();
  let chain: Promise<unknown> = Promise.resolve();
  // One writer at a time: set and remove read-modify-write the file.
  const serial = <A>(fn: () => Promise<A>) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const readFileKeys = async (): Promise<KeyFile> => {
    try {
      const parsed = JSON.parse(await readFile(options.file, "utf8")) as { keys?: unknown };
      const keys: Partial<Record<KeyProvider, string>> = {};
      if (parsed.keys && typeof parsed.keys === "object") for (const [k, v] of Object.entries(parsed.keys)) if (isProvider(k) && typeof v === "string" && v) keys[k] = v;
      return { version: 1, keys };
    } catch {
      return { version: 1, keys: {} };
    }
  };
  const storage = options.crypter ? ("keychain" as const) : ("memory" as const);
  const list = async (): Promise<Array<KeyInfo>> => {
    const stored = options.crypter ? (await readFileKeys()).keys : undefined;
    return PROVIDERS.map((p) => ({ provider: p.id, name: p.name, set: stored ? Boolean(stored[p.id]) : memory.has(p.id), storage, usedBy: [...p.usedBy] }));
  };
  return {
    storage,
    list,
    has: async (provider: KeyProvider) => (await list()).some((k) => k.provider === provider && k.set),
    set: (provider: KeyProvider, key: string) =>
      serial(async () => {
        if (!options.crypter) return void memory.set(provider, key);
        const data = await options.crypter.encrypt(key);
        const file = await readFileKeys();
        await writePrivate(options.file, JSON.stringify({ version: 1, keys: { ...file.keys, [provider]: data } } satisfies KeyFile, null, 1));
      }),
    remove: (provider: KeyProvider) =>
      serial(async () => {
        memory.delete(provider);
        if (!options.crypter) return;
        const file = await readFileKeys();
        if (!file.keys[provider]) return;
        const { [provider]: _gone, ...rest } = file.keys;
        await writePrivate(options.file, JSON.stringify({ version: 1, keys: rest } satisfies KeyFile, null, 1));
      }),
    /** The key, decrypted now (never cached), or undefined when none is stored. */
    get: async (provider: KeyProvider): Promise<string | undefined> => {
      if (!options.crypter) return memory.get(provider);
      const data = (await readFileKeys()).keys[provider];
      return data ? options.crypter.decrypt(data) : undefined;
    },
  };
}

export interface KeysShape {
  readonly list: Effect.Effect<ReadonlyArray<KeyInfo>>;
  readonly has: (provider: KeyProvider) => Effect.Effect<boolean>;
  readonly set: (provider: KeyProvider, key: string) => Effect.Effect<ReadonlyArray<KeyInfo>, GenerateError>;
  readonly remove: (provider: KeyProvider) => Effect.Effect<ReadonlyArray<KeyInfo>, GenerateError>;
  /** For the provider making a request; never sent anywhere else. */
  readonly get: (provider: KeyProvider) => Effect.Effect<string | undefined, GenerateError>;
}

export class Keys extends Context.Service<Keys, KeysShape>()("uncut/Keys") {}

const failed = (what: string) => (error: unknown) => new GenerateError({ reason: "keys-unavailable", message: `${what}: ${error instanceof Error ? error.message : "the Keychain refused"}` });

export const layer = Layer.effect(
  Keys,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const store = keyStore({ file: join(config.dataDir, "keys.json"), crypter: config.keysFd !== undefined ? pipeCrypter(config.keysFd) : undefined });
    const list = Effect.promise(() => store.list().catch(() => [] as Array<KeyInfo>));
    return Keys.of({
      list,
      has: (provider) => Effect.promise(() => store.has(provider).catch(() => false)),
      set: (provider, raw) =>
        Effect.gen(function* () {
          const key = cleanKey(raw);
          if (typeof key !== "string") return yield* new GenerateError({ reason: "bad-request", message: key.problem });
          yield* Effect.tryPromise({ try: () => store.set(provider, key), catch: failed(`Couldn't save the ${providerName(provider)} key`) });
          return yield* list;
        }),
      remove: (provider) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({ try: () => store.remove(provider), catch: failed(`Couldn't remove the ${providerName(provider)} key`) });
          return yield* list;
        }),
      get: (provider) => Effect.tryPromise({ try: () => store.get(provider), catch: failed(`Couldn't read the ${providerName(provider)} key`) }),
    });
  }),
);
