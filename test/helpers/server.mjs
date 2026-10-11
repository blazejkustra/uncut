// Starts the bundled server (apps/server/dist/server.mjs) and talks Effect RPC to it over
// WebSocket with plain JSON frames.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

export const BUNDLE = resolve("apps/server/dist/server.mjs");
export const MEDIA = resolve("native/media/target/release/uncut-media");
export const MODULES = resolve("spec/modules/builtin");

const running = new Set();
/** Kill every server this helper started that is still running. */
export const killAll = () => {
  for (const proc of running) proc.kill("SIGKILL");
};

export async function startServer({ entry = BUNDLE, env = {}, args = [], bootstrap } = {}) {
  const proc = spawn(process.execPath, [entry, ...args], {
    env: { ...process.env, UNCUT_TOKEN: "", UNCUT_PORT: "", UNCUT_MEDIA_BIN: MEDIA, UNCUT_MODULES_DIR: MODULES, ...env },
    stdio: ["pipe", "pipe", "inherit", "pipe"],
  });
  running.add(proc);
  proc.once("exit", () => running.delete(proc));
  proc.stdio[3].on("error", () => {});
  if (bootstrap !== undefined) proc.stdio[3].end(bootstrap);
  const exited = new Promise((r) => proc.once("exit", (code, signal) => r({ code, signal, at: Date.now() })));
  const line = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("no ready line within 10s")), 10000);
    createInterface({ input: proc.stdout }).once("line", (l) => (clearTimeout(timer), res(l)));
    exited.then(({ code }) => (clearTimeout(timer), rej(new Error(`server exited (${code})`))));
  }).catch((error) => {
    proc.kill("SIGKILL");
    throw error;
  });
  const ready = JSON.parse(line);
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    await exited;
  };
  return { proc, ready, exited, stop };
}

export function openSocket(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error("socket error"));
  });
}

/** An RPC client: `call(tag, payload)` resolves to the encoded Exit ({ _tag: "Success", value } or a Failure). */
export async function connect(port, token) {
  const ws = await openSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  const pending = new Map();
  let id = 0;
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg._tag === "Exit") pending.get(String(msg.requestId))?.(msg.exit);
  };
  const call = (tag, payload = {}) =>
    new Promise((res, rej) => {
      const requestId = String(++id);
      const timer = setTimeout(() => rej(new Error(`${tag}: no reply within 10s`)), 10000);
      pending.set(requestId, (exit) => (clearTimeout(timer), pending.delete(requestId), res(exit)));
      ws.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
    });
  /** Like call, but returns the value and throws on a failure. */
  const ok = async (tag, payload) => {
    const exit = await call(tag, payload);
    if (exit._tag !== "Success") throw new Error(`${tag} failed: ${JSON.stringify(exit.cause)}`);
    return exit.value;
  };
  /** The typed error of a failed call. */
  const fail = async (tag, payload) => {
    const exit = await call(tag, payload);
    if (exit._tag !== "Failure" || exit.cause[0]?._tag !== "Fail") throw new Error(`${tag}: expected a typed failure, got ${JSON.stringify(exit)}`);
    return exit.cause[0].error;
  };
  return { call, ok, fail, close: () => ws.close() };
}
