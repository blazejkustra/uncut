// Starts the bundled server (apps/server/dist/server.mjs) and talks Effect RPC to it over
// WebSocket with plain JSON frames.
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

export const BUNDLE = resolve("apps/server/dist/server.mjs");
export const MEDIA = resolve("native/media/target/release/uncut-media");
export const MODULES = resolve("spec/modules/builtin");

const running = new Set<ChildProcess>();
/** Kill every server this helper started that is still running. */
export const killAll = () => {
  for (const proc of running) proc.kill("SIGKILL");
};

/** `command` replaces `node <entry>` entirely (e.g. to start the server through `env -i`). */
export interface StartOptions {
  entry?: string;
  env?: NodeJS.ProcessEnv;
  args?: ReadonlyArray<string>;
  /** Written to fd 3 (the bootstrap pipe), then closed. */
  bootstrap?: string;
  command?: string;
  /** Keep stderr (readable with stderr()) instead of passing it through. */
  captureStderr?: boolean;
}

export interface Exited {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: number;
}

/** What the server prints on stdout when it is listening. */
export interface Ready {
  port: number;
  token: string;
  [key: string]: any;
}

export async function startServer({ entry = BUNDLE, env = {}, args = [], bootstrap, command, captureStderr = false }: StartOptions = {}) {
  const proc = spawn(command ?? process.execPath, command ? args : [entry, ...args], {
    // UNCUT_SHELL_ENV=off: keep the PATH the test gives (the login-shell probe has its own tests).
    env: {
      ...process.env,
      UNCUT_TOKEN: "",
      UNCUT_PORT: "",
      UNCUT_MEDIA_BIN: MEDIA,
      UNCUT_MODULES_DIR: MODULES,
      UNCUT_SHELL_ENV: "off",
      UNCUT_PROXIES: "off",
      UNCUT_TELEMETRY: "off",
      ...env,
    },
    // fd 4: the keys pipe the desktop gives the server (--keys-fd 4, D99); unused unless asked for.
    stdio: ["pipe", "pipe", captureStderr ? "pipe" : "inherit", "pipe", "pipe"],
  });
  let stderrText = "";
  if (captureStderr) proc.stderr!.on("data", (d) => (stderrText += d));
  running.add(proc);
  proc.once("exit", () => running.delete(proc));
  const fd3 = proc.stdio[3] as Writable;
  fd3.on("error", () => {});
  if (bootstrap !== undefined) fd3.end(bootstrap);
  const exited = new Promise<Exited>((r) => proc.once("exit", (code, signal) => r({ code, signal, at: Date.now() })));
  const line = await new Promise<string>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("no ready line within 10s")), 10000);
    createInterface({ input: proc.stdout as Readable }).once("line", (l) => (clearTimeout(timer), res(l)));
    exited.then(({ code }) => (clearTimeout(timer), rej(new Error(`server exited (${code})`))));
  }).catch((error) => {
    proc.kill("SIGKILL");
    throw error;
  });
  const ready = JSON.parse(line) as Ready;
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    await exited;
  };
  return { proc, ready, exited, stop, stderr: () => stderrText };
}

export function openSocket(url: string) {
  return new Promise<WebSocket>((res, rej) => {
    const ws = new WebSocket(url);
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error("socket error"));
  });
}

/** An encoded Exit as it comes over the wire: { _tag: "Success", value } or a Failure with its cause. */
export type WireExit = { _tag: "Success"; value: any } | { _tag: "Failure"; cause: Array<{ _tag: string; error?: any; [key: string]: any }> };

/** An RPC client: `call(tag, payload)` resolves to the encoded Exit ({ _tag: "Success", value } or a Failure). */
export async function connect(port: number, token: string) {
  const ws = await openSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  const pending = new Map<string, (exit: WireExit) => void>();
  let id = 0;
  const streams = new Map<string, (values: Array<any>) => void>();
  ws.onmessage = (m: { data: string }) => {
    const msg = JSON.parse(m.data);
    if (msg._tag === "Exit") pending.get(String(msg.requestId))?.(msg.exit);
    if (msg._tag === "Chunk") {
      streams.get(String(msg.requestId))?.(msg.values);
      // Streams are acknowledged chunk by chunk, or the server stops sending.
      ws.send(JSON.stringify({ _tag: "Ack", requestId: msg.requestId }));
    }
  };
  const call = (tag: string, payload: unknown = {}) =>
    new Promise<WireExit>((res, rej) => {
      const requestId = String(++id);
      const timer = setTimeout(() => rej(new Error(`${tag}: no reply within 10s`)), 10000);
      pending.set(requestId, (exit) => (clearTimeout(timer), pending.delete(requestId), res(exit)));
      ws.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
    });
  /** Like call, but returns the value and throws on a failure. */
  // Wire values are JSON: tests read the fields they assert on.
  const ok = async (tag: string, payload?: unknown): Promise<any> => {
    const exit = await call(tag, payload);
    if (exit._tag !== "Success") throw new Error(`${tag} failed: ${JSON.stringify(exit.cause)}`);
    return exit.value;
  };
  /** The typed error of a failed call. */
  const fail = async (tag: string, payload?: unknown): Promise<any> => {
    const exit = await call(tag, payload);
    if (exit._tag !== "Failure" || exit.cause[0]?._tag !== "Fail") throw new Error(`${tag}: expected a typed failure, got ${JSON.stringify(exit)}`);
    return exit.cause[0].error;
  };
  /** Subscribe to a streaming RPC; returns { values, next(predicate) } over everything received. */
  const subscribe = (tag: string, payload: unknown = {}) => {
    const requestId = String(++id);
    const values: Array<any> = [];
    type Predicate = (value: any, index: number, all: Array<any>) => boolean;
    const waiters: Array<{ predicate: Predicate; resolve: () => void }> = [];
    streams.set(requestId, (chunk) => {
      values.push(...chunk);
      for (const w of [...waiters]) if (values.some(w.predicate)) (waiters.splice(waiters.indexOf(w), 1), w.resolve());
    });
    ws.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
    const until = (predicate: Predicate, timeout = 10000) =>
      values.some(predicate)
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`${tag}: no matching value within ${timeout / 1000}s; got ${JSON.stringify(values).slice(-300)}`)),
              timeout,
            );
            waiters.push({ predicate, resolve: () => (clearTimeout(timer), resolve()) });
          });
    return { values, until };
  };
  return { call, ok, fail, subscribe, close: () => ws.close() };
}
