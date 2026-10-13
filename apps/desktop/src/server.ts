// Runs the Node server as a child process, like t3code's DesktopBackendManager: the Electron
// binary itself in Node mode (ELECTRON_RUN_AS_NODE), so the packaged app needs no separate
// Node install and the backend doesn't become a second GUI app instance.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Duplex, Writable } from "node:stream";
import * as readline from "node:readline";

import type { ServerConnection } from "@uncut/contracts";

const READY_TIMEOUT_MS = 15_000;
const KILL_AFTER_MS = 1_500;

export interface ServerProcess {
  readonly pid: number | undefined;
  readonly connection: Promise<ServerConnection>;
  readonly running: () => boolean;
  // Resolves once the process is gone: SIGTERM first, SIGKILL if it lingers.
  readonly stop: () => Promise<void>;
}

const parseReadyLine = (line: string): { port: number } | "not-json" | "bad" => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return "not-json";
  }
  if (typeof value !== "object" || value === null || !("ready" in value)) return "not-json";
  const port = (value as { port?: unknown }).port;
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536 ? { port } : "bad";
};

export function startServer(options: {
  serverEntry: string;
  mediaBin: string;
  modulesDir: string;
  // The bundled music library (D91).
  musicDir: string;
  // Plugins shipped with the app (D97).
  bundledPluginsDir: string;
  dataDir: string;
  // How the server starts the export rasteriser (this binary with --uncut-render): the entry to
  // run, or undefined when packaged (the binary always runs its bundled main).
  renderEntry: string | undefined;
  onExit: (reason: string) => void;
  // Encrypts and decrypts generator keys for the server (D99: Electron safeStorage, which the
  // server, a plain Node process, can't use). Called only when a key is stored or used.
  keys: { readonly encrypt: (text: string) => string; readonly decrypt: (data: string) => string };
}): ServerProcess {
  const token = randomBytes(24).toString("base64url");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    UNCUT_PORT: "0",
    UNCUT_MEDIA_BIN: options.mediaBin,
    UNCUT_MODULES_DIR: options.modulesDir,
    UNCUT_MUSIC_DIR: options.musicDir,
    UNCUT_BUNDLED_PLUGINS_DIR: options.bundledPluginsDir,
    UNCUT_DATA_DIR: options.dataDir,
    UNCUT_RENDER_BIN: process.execPath,
    UNCUT_RENDER_ENTRY: options.renderEntry ?? "",
  };
  delete env.UNCUT_TOKEN;
  const child = spawn(process.execPath, [options.serverEntry, "--bootstrap-fd", "3", "--exit-with-stdin", "--keys-fd", "4"], {
    env,
    // stdin stays open and unused: the server exits when it closes, so it can't outlive us.
    // fd 3 carries the token, which would be visible to `ps eww` in the environment.
    // fd 4 is the keys pipe (D99): { id, op, text | data } in, { id, ok, data | text | error } out.
    stdio: ["pipe", "pipe", "inherit", "pipe", "pipe"],
  });
  const keysPipe = child.stdio[4] as Duplex;
  keysPipe.on("error", () => {});
  readline.createInterface({ input: keysPipe }).on("line", (line) => {
    let msg: { id?: unknown; op?: unknown; text?: unknown; data?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const answer = (reply: Record<string, unknown>) => keysPipe.write(`${JSON.stringify({ id: msg.id, ...reply })}\n`);
    try {
      if (msg.op === "encrypt" && typeof msg.text === "string") answer({ ok: true, data: options.keys.encrypt(msg.text) });
      else if (msg.op === "decrypt" && typeof msg.data === "string") answer({ ok: true, text: options.keys.decrypt(msg.data) });
      else answer({ ok: false, error: "unknown request" });
    } catch (error) {
      // Never the key: only why the Keychain refused.
      answer({ ok: false, error: (error as Error).message.slice(0, 200) });
    }
  });
  const bootstrap = child.stdio[3] as Writable;
  bootstrap.on("error", () => {}); // the child may die before reading it; "exit" reports that
  bootstrap.end(`${JSON.stringify({ token })}\n`);
  child.stdin!.on("error", () => {});

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let ready = false;
  let stopping = false;

  const connection = new Promise<ServerConnection>((resolve, reject) => {
    const fail = (message: string) => {
      clearTimeout(timer);
      reject(new Error(message));
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const timer = setTimeout(() => fail(`server didn't start within ${READY_TIMEOUT_MS / 1000}s`), READY_TIMEOUT_MS);
    readline.createInterface({ input: child.stdout! }).on("line", (line) => {
      if (ready) return void process.stdout.write(`[server] ${line}\n`);
      const parsed = parseReadyLine(line);
      if (parsed === "not-json") return void process.stdout.write(`[server] ${line}\n`);
      if (parsed === "bad") return fail(`server sent a ready line without a valid port: ${line}`);
      ready = true;
      clearTimeout(timer);
      resolve({ url: `ws://127.0.0.1:${parsed.port}/ws`, token });
    });
    child.once("error", (error) => fail(`can't start server: ${error.message}`));
    child.once("exit", (code, signal) => {
      const how = signal ?? `code ${code}`;
      if (!ready) return fail(`server exited before it was ready (${how})`);
      if (!stopping) options.onExit(`server exited unexpectedly (${how})`);
    });
  });
  // The renderer reports failures; don't crash main on an unobserved rejection.
  connection.catch((error: Error) => console.error(`[uncut] ${error.message}`));

  return {
    pid: child.pid,
    connection,
    running: () => child.exitCode === null && child.signalCode === null,
    stop: async () => {
      stopping = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        console.error(`[uncut] server still running ${KILL_AFTER_MS} ms after SIGTERM; killing it`);
        child.kill("SIGKILL");
      }, KILL_AFTER_MS);
      await exited;
      clearTimeout(timer);
    },
  };
}
